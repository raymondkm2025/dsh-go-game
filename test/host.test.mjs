/**
 * Host-half tests: drive the real routes with a mock webserver, mock req/res and
 * a mock llm. Run directly:  node test/host.test.mjs
 */
import { rmSync } from 'node:fs'

import { apply } from '../lib/index.js'

let passed = 0
const failures = []
const QUEUE = []

/** Queue one test. They run strictly in order — later cases depend on earlier state. */
function check(name, fn) {
  QUEUE.push({ name, fn })
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': ' + String(a) + ' !== ' + String(b))
}

// ------------------------------------------------------------------ fixtures

function makeHarness(services = {}) {
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at !== -1) routes.splice(at, 1)
        }
      },
    },
    get(name) {
      return services[name] === undefined ? null : services[name]
    },
    effect(fn) {
      return fn()
    },
  }
  apply(ctx)
  const route = routes.find((r) => r.path === '/dsh-go-game')
  if (!route) throw new Error('go-game prefix route was not registered')
  return { route, routes }
}

function fakeReq(method, url, body, extraHeaders = {}) {
  const handlers = {}
  // Mirror the real client: the panel and the standalone page POST with a JSON
  // body, and browsers always attach Host. `extraHeaders` lets a test forge a
  // cross-site request.
  const headers = { host: '127.0.0.1:19387', ...extraHeaders }
  if (method === 'POST' && !('content-type' in extraHeaders)) headers['content-type'] = 'application/json'
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      handlers[event] = handlers[event] || []
      handlers[event].push(fn)
      return req
    },
    destroy() {},
  }
  setTimeout(() => {
    const payload = body === undefined || body === null ? '' : JSON.stringify(body)
    if (payload) for (const fn of handlers.data || []) fn(Buffer.from(payload, 'utf8'))
    for (const fn of handlers.end || []) fn()
  }, 0)
  return req
}

function call(route, method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = fakeReq(method, url, body, extraHeaders)
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
        resolve({ status: this.statusCode, headers: this.headers, text: String(text || ''), json })
      },
    }
    try {
      Promise.resolve(route.handler(req, res)).catch(reject)
    } catch (err) {
      reject(err)
    }
  })
}

function mockLlm() {
  function iterator(chunks) {
    let i = 0
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (i < chunks.length) return Promise.resolve({ value: chunks[i++], done: false })
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    }
  }
  return {
    async listProviders() {
      return ['fake-llm']
    },
    async listModels() {
      return ['fake-model']
    },
    stream(args) {
      void args
      return iterator([
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '黑棋實地稍優，白棋外勢可觀。' },
        { type: 'text-delta', index: 0, text: '\n建議: D4' },
        { type: 'finish', reason: { kind: 'stop' } },
      ])
    },
  }
}

const { route } = makeHarness({})

// --------------------------------------------------------------------- tests

const tests = []

tests.push(check('status reports the engine and capabilities', async () => {
  const r = await call(route, 'GET', '/dsh-go-game/status')
  eq(r.status, 200)
  eq(r.json.ok, true)
  eq(r.json.rules, 'chinese-area')
  assert(r.json.sizes.includes(19), 'sizes')
  eq(r.json.llm, false, 'no llm in the default harness')
}))

tests.push(check('unknown route answers 404 json', async () => {
  const r = await call(route, 'GET', '/dsh-go-game/nope')
  eq(r.status, 404)
  eq(r.json.error, 'no-route')
}))

let id = null

tests.push(check('new creates a session and returns the initial state', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/new', { id: 'test-a', size: 9, komi: 5.5, aiSide: 'white' })
  eq(r.json.ok, true)
  id = r.json.id
  eq(id, 'test-a')
  eq(r.json.board.length, 81)
  eq(r.json.turn, 1)
  eq(r.json.aiSide, 'white')
  eq(r.json.stars.length, 5, '9x9 star points')
}))

tests.push(check('handicap places stones and gives white the move', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/new', { id: 'test-h', size: 9, handicap: 4, komi: 0.5 })
  eq(r.json.turn, 2)
  const black = r.json.board.filter((v) => v === 1).length
  eq(black, 4)
}))

tests.push(check('move updates the board and hands over the turn', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/move', { id: id, point: 40 })
  eq(r.json.board[40], 1)
  eq(r.json.turn, 2)
  eq(r.json.moveCount, 1)
  eq(r.json.lastMove, 40)
  eq(r.json.lastVertex, 'E5', '9x9 centre vertex')
}))

tests.push(check('an illegal move is rejected without changing the state', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/move', { id: id, point: 40 })
  eq(r.json.ok, false)
  eq(r.json.error, 'occupied')
  eq(r.json.state.board[40], 1)
}))

tests.push(check('a bad point is a 400', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/move', { id: id, point: 'x' })
  eq(r.status, 400)
  eq(r.json.error, 'bad-point')
}))

tests.push(check('an unknown session is a 404', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/move', { id: 'nope', point: 1 })
  eq(r.status, 404)
  eq(r.json.error, 'no-session')
}))

tests.push(check('ai plays a legal reply', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/ai', { id: id, level: 'medium' })
  eq(r.json.ok, true)
  assert(r.json.aiPlay, 'aiPlay record present')
  const pt = r.json.aiPlay.point
  assert(pt >= 0, 'ai did not pass on move 2')
  eq(r.json.board[pt], 2, 'white stone placed')
  assert(typeof r.json.aiPlay.ms === 'number')
}))

tests.push(check('undo removes the last move', async () => {
  const before = await call(route, 'POST', '/dsh-go-game/ai', { id: id, level: 'medium' })
  const count = before.json.moveCount
  const r = await call(route, 'POST', '/dsh-go-game/undo', { id: id, steps: 1 })
  eq(r.json.moveCount, count - 1)
}))

tests.push(check('two passes end the game and produce a result', async () => {
  await call(route, 'POST', '/dsh-go-game/pass', { id: id })
  const r = await call(route, 'POST', '/dsh-go-game/pass', { id: id })
  eq(r.json.over, true)
  eq(r.json.endReason, 'two-passes')
  assert(r.json.result, 'result present')
  assert(typeof r.json.result.margin === 'number')
}))

tests.push(check('resignation names the winner', async () => {
  await call(route, 'POST', '/dsh-go-game/new', { id: 'test-r', size: 9 })
  const r = await call(route, 'POST', '/dsh-go-game/resign', { id: 'test-r' })
  eq(r.json.over, true)
  eq(r.json.result.reason, 'resign')
  eq(r.json.winner, 2)
}))

tests.push(check('dead-stone toggle and clear work', async () => {
  await call(route, 'POST', '/dsh-go-game/new', { id: 'test-d', size: 9 })
  await call(route, 'POST', '/dsh-go-game/move', { id: 'test-d', point: 40 })
  const on = await call(route, 'POST', '/dsh-go-game/dead', { id: 'test-d', point: 40 })
  eq(on.json.dead.length, 1)
  eq(on.json.dead[0], 40)
  const empty = await call(route, 'POST', '/dsh-go-game/dead', { id: 'test-d', point: 41 })
  eq(empty.json.dead.length, 1, 'an empty point is not markable')
  const off = await call(route, 'POST', '/dsh-go-game/dead', { id: 'test-d', point: 40 })
  eq(off.json.dead.length, 0)
  await call(route, 'POST', '/dsh-go-game/dead', { id: 'test-d', point: 40 })
  const cleared = await call(route, 'POST', '/dsh-go-game/dead', { id: 'test-d', clear: true })
  eq(cleared.json.dead.length, 0)
}))

tests.push(check('estimate returns ownership and a score', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/estimate', { id: id, playouts: 8, budgetMs: 600 })
  eq(r.json.ok, true)
  eq(r.json.estimate.owner.length, 81)
  eq(r.json.estimate.dead.length, r.json.estimate.dead.length)
  assert(r.json.estimate.playouts >= 1)
  assert(typeof r.json.estimate.margin === 'number')
}))

tests.push(check('local summary works without a model', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/local', { id: id })
  eq(r.json.ok, true)
  assert(r.json.text.includes('黑'), 'mentions black')
}))

tests.push(check('review falls back to the local summary when no llm is wired', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/review', { id })
  eq(r.json.ok, true)
  eq(r.json.llm, false)
  eq(r.json.local, true)
  assert(r.json.text.length > 5)
}))

tests.push(check('sgf route exports the game', async () => {
  const r = await call(route, 'GET', '/dsh-go-game/sgf?id=' + id)
  assert(r.json.sgf.startsWith('(;GM[1]'))
  assert(r.json.sgf.includes('SZ[9]'))
}))

tests.push(check('save then load round-trips through disk', async () => {
  const saved = await call(route, 'POST', '/dsh-go-game/save', { id: id, name: 'host-test' })
  eq(saved.json.ok, true)
  assert(saved.json.games.includes('host-test'), 'listed in games')
  const listed = await call(route, 'GET', '/dsh-go-game/games')
  assert(listed.json.games.includes('host-test'))
  await call(route, 'POST', '/dsh-go-game/new', { id: 'test-l', size: 19 })
  const loaded = await call(route, 'POST', '/dsh-go-game/load', { id: 'test-l', name: 'host-test' })
  eq(loaded.json.ok, true)
  eq(loaded.json.size, 9)
  const before = await call(route, 'GET', '/dsh-go-game/sgf?id=' + id)
  const after = await call(route, 'GET', '/dsh-go-game/sgf?id=test-l')
  eq(after.json.sgf, before.json.sgf, 'same game after a round trip')
}))

tests.push(check('the full page and its script are served', async () => {
  const page = await call(route, 'GET', '/dsh-go-game/')
  eq(page.status, 200)
  assert(page.text.includes('<title>圍棋'), 'page title')
  assert(page.headers['content-type'].includes('text/html'), 'html content type')
  const js = await call(route, 'GET', '/dsh-go-game/page.js')
  eq(js.status, 200)
  assert(js.headers['content-type'].includes('javascript'), 'js content type')
  assert(js.text.includes('/dsh-go-game'), 'page script targets the api')
}))

// ------------------------------------------------------------------- with llm

const { route: llmRoute } = makeHarness({ llm: mockLlm() })

tests.push(check('models lists providers and models from the harness', async () => {
  const r = await call(llmRoute, 'GET', '/dsh-go-game/models')
  eq(r.json.ok, true)
  eq(r.json.llm, true)
  eq(r.json.targets[0].provider, 'fake-llm')
  eq(r.json.targets[0].models[0], 'fake-model')
}))

tests.push(check('review uses the llm and parses the suggested move', async () => {
  await call(llmRoute, 'POST', '/dsh-go-game/new', { id: 'llm-1', size: 9, aiSide: 'white' })
  const r = await call(llmRoute, 'POST', '/dsh-go-game/review', { id: 'llm-1' })
  eq(r.json.ok, true)
  eq(r.json.llm, true)
  eq(r.json.provider, 'fake-llm')
  assert(r.json.text.includes('建議'), 'text carried through')
  eq(r.json.suggestion.vertex, 'D4', 'coordinate parsed')
  assert(r.json.suggestion.point >= 0, 'point mapped onto the board')
}))

tests.push(check('status reports the llm as available', async () => {
  const r = await call(llmRoute, 'GET', '/dsh-go-game/status')
  eq(r.json.llm, true)
}))

// ------------------------------------------------------- cross-site gate

tests.push(check('a cross-site subresource request is refused', async () => {
  // A browser sends Sec-Fetch-Site (and no Origin) for an <img>/<script> load.
  const r = await call(route, 'POST', '/dsh-go-game/new', { size: 9 }, { 'sec-fetch-site': 'cross-site' })
  eq(r.status, 403)
  eq(r.json.error, 'cross-site-refused')
  const g = await call(route, 'GET', '/dsh-go-game/status', undefined, { 'sec-fetch-site': 'cross-site' })
  eq(g.status, 403, 'reads are refused too — the board must not leak either')
}))

tests.push(check('an Origin for another host is refused, same-origin is allowed', async () => {
  const bad = await call(route, 'POST', '/dsh-go-game/new', { size: 9 }, { origin: 'http://evil.example' })
  eq(bad.status, 403)
  eq(bad.json.error, 'cross-site-refused')

  const good = await call(route, 'POST', '/dsh-go-game/new', { id: 'same-origin-1', size: 9 }, { origin: 'http://127.0.0.1:19387' })
  eq(good.status, 200, 'the plugin own page is same-origin')
  eq(good.json.ok, true)
}))

tests.push(check('a non-browser caller (no Origin, no Sec-Fetch-Site) is allowed', async () => {
  // curl and the install verifier send neither header; they must keep working.
  const r = await call(route, 'GET', '/dsh-go-game/status', undefined, { host: '' })
  eq(r.status, 200)
  eq(r.json.ok, true)
}))

tests.push(check('state-changing routes require POST', async () => {
  for (const path of ['/move', '/pass', '/undo', '/resign', '/ai', '/dead', '/estimate', '/review', '/save', '/load', '/new']) {
    const r = await call(route, 'GET', '/dsh-go-game' + path + '?id=whatever')
    eq(r.status, 405, path + ' must reject GET')
    eq(r.json.error, 'method-not-allowed', path)
  }
}))

tests.push(check('read-only routes still answer GET', async () => {
  for (const path of ['/status', '/models', '/games']) {
    const r = await call(route, 'GET', '/dsh-go-game' + path)
    eq(r.status, 200, path + ' must keep working with GET')
  }
}))

tests.push(check('a POST body must be application/json', async () => {
  const r = await call(route, 'POST', '/dsh-go-game/new', { size: 9 }, { 'content-type': 'text/plain' })
  eq(r.status, 415)
  eq(r.json.error, 'content-type-must-be-application-json')
}))

tests.push(check('selecting a weights file is POST-only and path-traversal safe', async () => {
  // A bare GET is a status read and stays allowed.
  const read = await call(route, 'GET', '/dsh-go-game/engine')
  eq(read.status, 200)
  eq(read.json.ok, true)

  // Selecting a model via GET is refused.
  const viaGet = await call(route, 'GET', '/dsh-go-game/engine?model=default.bin.gz')
  eq(viaGet.status, 405)

  // Traversal and absolute paths are rejected, and never reach the engine.
  for (const hostile of ['../../../etc/passwd', '/etc/passwd', 'a/../../b.bin.gz', '..', '.', 'weights.bin.gz/../../x']) {
    const r = await call(route, 'POST', '/dsh-go-game/engine', { model: hostile })
    eq(r.status, 400, JSON.stringify(hostile) + ' must be rejected')
    eq(r.json.error, 'bad-model-name')
  }

  // A well-formed name is accepted (the engine itself is simply absent here).
  const ok = await call(route, 'POST', '/dsh-go-game/engine', { model: 'kata1-9x9.bin.gz' })
  eq(ok.status, 200)
  eq(ok.json.ok, true)
  eq(ok.json.engine.available, false)
}))

// -------------------------------------------------------------------- report

;(async () => {
  for (const t of QUEUE) {
    try {
      await t.fn()
      passed++
    } catch (err) {
      failures.push(t.name + ' — ' + (err && err.message ? err.message : String(err)))
    }
  }
  try {
    rmSync(process.cwd() + '/.dsh-go-game', { recursive: true, force: true })
  } catch (err) {
    /* best effort cleanup */
  }
  console.log('host tests: ' + passed + ' passed, ' + failures.length + ' failed')
  for (const f of failures) console.log('  FAIL ' + f)
  process.exit(failures.length ? 1 : 0)
})()
