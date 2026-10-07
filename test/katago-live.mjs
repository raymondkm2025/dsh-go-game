/**
 * Live integration test: drive a real KataGo install through lib/gtp.js.
 * Skipped (exit 0) unless the engine and a model are actually present.
 *
 * Run: node test/katago-live.mjs [--root=<katago dir>] [--model=<file>] [--size=9] [--moves=3]
 */
import { applyPlay, validate } from './.live-helpers.mjs'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a)
    return m ? [m[1], m[2]] : [a, '']
  }),
)

const ROOT = args.root || process.env.KATAGO_ROOT || ''
const MODEL = args.model || undefined
const SIZE = Number(args.size) || 9
const MOVES = Number(args.moves) || 3

if (!ROOT) {
  console.log('katago-live: skipped (pass --root=<katago dir> to run)')
  process.exit(0)
}

const { findEngine, createEngine, ENGINE_DEFAULT_TIME_SEC } = await import('../lib/gtp.js')
const { createGame, play, BLACK, WHITE, vertex } = await import('../lib/engine.js')

const found = findEngine(ROOT, { model: MODEL })
if (!found.ok) {
  console.log('katago-live: skipped (' + found.reason + ') in ' + ROOT)
  process.exit(0)
}

console.log('katago-live: engine  ' + found.exePath)
console.log('katago-live: model   ' + found.modelPath)
console.log('katago-live: models  ' + found.models.join(', '))

const engine = createEngine({
  exePath: found.exePath,
  modelPath: found.modelPath,
  configPath: found.configPath,
  threads: Number(args.threads) || 4,
  visits: Number(args.visits) || 120,
  maxTimeSec: Number(args.maxtime) || ENGINE_DEFAULT_TIME_SEC,
  commandTimeoutMs: 120000,
})

const started = await engine.start()
if (!started.ok) {
  console.log('katago-live: FAILED to start — ' + started.error)
  process.exit(1)
}
console.log('katago-live: handshake ok (' + started.name + ')')

const game = createGame({ size: SIZE, komi: 5.5 })
let failures = 0
for (let n = 0; n < MOVES && !game.over; n++) {
  const color = game.turn
  const t0 = Date.now()
  let move
  try {
    move = await engine.genmove(game, color)
  } catch (err) {
    console.log('katago-live: genmove error — ' + err.message)
    failures++
    break
  }
  const wall = Date.now() - t0
  if (move.resign) {
    console.log('  ' + (color === BLACK ? 'B' : 'W') + ' resign after ' + wall + 'ms')
    break
  }
  if (move.pass) {
    console.log('  ' + (color === BLACK ? 'B' : 'W') + ' pass after ' + wall + 'ms')
    const r = applyPlay(game, -1, color)
    if (!r) failures++
    continue
  }
  const legal = applyPlay(game, move.point, color)
  console.log(
    '  ' + (color === BLACK ? 'B' : 'W') + ' ' + vertex(SIZE, move.point) +
      '  raw=' + move.raw + '  engine=' + move.ms + 'ms  wall=' + wall + 'ms  legal=' + legal,
  )
  if (!legal) failures++
}

const status = engine.status()
console.log('katago-live: commands=' + status.commands + ' lastError=' + (status.lastError || '(none)'))
engine.stop()
await new Promise((r) => setTimeout(r, 300))

// ---- phase 2: through the plugin's own HTTP routes --------------------------
// The engine root is read when lib/index.js is first imported, so set it first.
process.env.DSH_GO_GAME_KATAGO_ROOT = ROOT
const { apply } = await import('../lib/index.js')

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

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const handlers = {}
    const req = {
      method,
      url,
      headers: {},
      on(e, fn) {
        handlers[e] = handlers[e] || []
        handlers[e].push(fn)
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
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const engineRoute = await call('GET', '/dsh-go-game/engine')
console.log('routes: /engine available=' + engineRoute.json.engine.available + ' model=' + engineRoute.json.engine.selected)

const created = await call('POST', '/dsh-go-game/new', {
  id: 'live-route',
  size: SIZE,
  komi: 5.5,
  level: 'medium',
  aiSide: 'white',
  engine: 'katago',
})
console.log('routes: /new engine=' + created.json.engine + ' available=' + created.json.engineInfo.available)

const t1 = Date.now()
const played = await call('POST', '/dsh-go-game/move', { id: 'live-route', point: 40, autoAi: true })
const wall = Date.now() - t1
if (played.json.aiPlay && played.json.aiPlay.engine === 'katago') {
  console.log('routes: engine replied ' + played.json.aiPlay.vertex + ' in ' + wall + 'ms (engine=' + played.json.aiPlay.engine + ')')
} else {
  failures++
  console.log('routes: FAILED — expected a katago aiPlay, got ' + JSON.stringify(played.json.aiPlay))
}

console.log('')
console.log(failures ? 'katago-live: ' + failures + ' problem(s)' : 'katago-live: all moves legal, engine OK (direct + via routes)')
process.exit(failures ? 1 : 0)
