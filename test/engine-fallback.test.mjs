/**
 * Engine integration tests for the host half:
 *   - engine=katago with no engine installed must degrade to the built-in AI
 *     instead of breaking the game
 *   - /engine must report why the engine is unavailable
 *
 * The engine root is redirected to a non-existent directory BEFORE importing the
 * host module, so a real KataGo install on this machine cannot influence it.
 *
 * Run: node test/engine-fallback.test.mjs
 */
process.env.DSH_GO_GAME_KATAGO_ROOT = 'C:/definitely/not/a/katago/install'

const { apply } = await import('../lib/index.js')

let passed = 0
const failures = []

function assert(cond, msg) {
  if (cond) passed++
  else failures.push(msg || 'assertion failed')
}
function eq(a, b, msg) {
  if (a === b) passed++
  else failures.push((msg || 'not equal') + ': ' + String(a) + ' !== ' + String(b))
}

// ------------------------------------------------------------------ fixtures

function makeHarness() {
  const routes = []
  apply({
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    get() {
      return null
    },
    effect(fn) {
      return fn()
    },
  })
  const route = routes.find((r) => r.path === '/dsh-go-game')
  if (!route) throw new Error('route not registered')
  return route
}

function call(route, method, url, body) {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = {
      method,
      url,
      // Mirror the real client: actions POST a JSON body, reads use a bare GET.
      headers: method === 'POST'
        ? { host: '127.0.0.1:19387', 'content-type': 'application/json' }
        : { host: '127.0.0.1:19387' },
      on(event, fn) {
        handlers[event] = handlers[event] || []
        handlers[event].push(fn)
        return req
      },
      destroy() {},
    }
    setTimeout(() => {
      const payload = body === undefined ? '' : JSON.stringify(body)
      if (payload) for (const fn of handlers.data || []) fn(Buffer.from(payload, 'utf8'))
      for (const fn of handlers.end || []) fn()
    }, 0)
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[String(k).toLowerCase()] = v
      },
      end(text) {
        let json = null
        try {
          json = JSON.parse(text)
        } catch (err) {
          json = null
        }
        resolve({ status: this.statusCode, json, text: String(text || '') })
      },
    }
    try {
      Promise.resolve(route.handler(req, res)).catch(reject)
    } catch (err) {
      reject(err)
    }
  })
}

// -------------------------------------------------------------------- checks

const route = makeHarness()

const engineRoute = await call(route, 'GET', '/dsh-go-game/engine')
eq(engineRoute.status, 200, '/engine answers')
eq(engineRoute.json.ok, true, '/engine ok')
eq(engineRoute.json.engine.available, false, 'engine reported unavailable for a bogus root')
eq(engineRoute.json.engine.reason, 'engine-missing', 'reason is engine-missing')

const created = await call(route, 'POST', '/dsh-go-game/new', {
  id: 'fallback-1',
  size: 9,
  komi: 5.5,
  level: 'medium',
  aiSide: 'white',
  engine: 'katago',
})
eq(created.json.engine, 'katago', 'session remembers the requested engine')
eq(created.json.engineInfo.available, false, 'state carries the engine verdict')

// Playing a stone with the engine selected must still get an AI reply, produced
// by the built-in opponent.
const moved = await call(route, 'POST', '/dsh-go-game/move', {
  id: 'fallback-1',
  point: 40,
  autoAi: true,
  level: 'medium',
})
eq(moved.json.ok, true, 'move accepted')
eq(moved.json.moveCount, 2, 'human move + built-in AI reply')
assert(moved.json.aiPlay, 'aiPlay recorded')
eq(moved.json.aiPlay.engine, undefined, 'fallback reply comes from the built-in AI, not the engine')
eq(moved.json.aiFallback, 'engine-missing', 'the fallback reason is surfaced to the UI')
assert(moved.json.aiPlay.vertex && moved.json.aiPlay.vertex !== 'pass', 'fallback produced a real move: ' + (moved.json.aiPlay && moved.json.aiPlay.vertex))

// An explicit engine switch to builtin must also work.
const switched = await call(route, 'POST', '/dsh-go-game/new', { id: 'fallback-2', size: 9, engine: 'builtin' })
eq(switched.json.engine, 'builtin', 'builtin selected explicitly')

console.log('')
if (failures.length) {
  for (const f of failures) console.log('  FAIL ' + f)
  console.log('')
  console.log('engine-fallback tests: ' + passed + ' passed, ' + failures.length + ' failed')
  process.exit(1)
}
console.log('engine-fallback tests: ' + passed + ' passed, 0 failed')
