/**
 * Offline tests for the GTP bridge — a fake engine process is injected through
 * createEngine's spawnFn seam, so no real KataGo is needed.
 *
 * Run: node test/gtp.test.mjs
 */
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

import { createEngine, findEngine, ENGINE_DEFAULT_THREADS } from '../lib/gtp.js'
import { createGame, play, BLACK, WHITE, point } from '../lib/engine.js'

// start() checks that the binary and model exist, so the fake engine points at
// a file that really is on disk (this test file itself).
const SELF = fileURLToPath(import.meta.url)

let passed = 0
let failed = 0
function eq(actual, expected, label) {
  if (actual === expected) {
    passed++
    return
  }
  failed++
  console.log('  FAIL ' + label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
}
function ok(value, label) {
  if (value) passed++
  else {
    failed++
    console.log('  FAIL ' + label)
  }
}
async function rejects(fn, needle, label) {
  try {
    await fn()
    failed++
    console.log('  FAIL ' + label + ': did not reject')
  } catch (err) {
    if (String(err.message).includes(needle)) passed++
    else {
      failed++
      console.log('  FAIL ' + label + ': wrong error ' + err.message)
    }
  }
}

/** A fake GTP process: answers from a script, with optional silence. */
function makeFakeEngine(opts = {}) {
  const stdin = new PassThrough()
  stdin.setEncoding('utf8')
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = new EventEmitter()
  proc.stdin = stdin
  proc.stdout = stdout
  proc.stderr = stderr
  proc.kill = () => { proc.killedFlag = true; proc.emit('exit', 0, 'SIGTERM') }
  const seen = []
  let buffer = ''

  stdin.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) !== -1) {
      const cmd = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (!cmd) continue
      seen.push(cmd)
      if (opts.silentOn && cmd.startsWith(opts.silentOn)) continue
      if (cmd === 'quit') {
        proc.emit('exit', 0, null)
        continue
      }
      const reply = opts.reply ? opts.reply(cmd) : defaultReply(cmd)
      if (reply === null) continue
      stdout.write(reply + '\n')
    }
  })
  return { proc, seen }
}

function defaultReply(cmd) {
  if (cmd === 'name') return '= KataGo (fake)'
  if (cmd === 'version') return '= 1.0-fake'
  if (cmd.startsWith('genmove')) return '= D4'
  if (cmd.startsWith('boardsize') || cmd.startsWith('komi') || cmd.startsWith('play') || cmd.startsWith('clear_board')) return '='
  if (cmd.startsWith('set_free_handicap')) return '='
  return '? unknown command'
}

function options(extra = {}) {
  return {
    exePath: SELF,
    modelPath: SELF,
    spawnFn: () => extra.fake.proc,
    commandTimeoutMs: 500,
    ...extra,
  }
}

// ---------------------------------------------------------------- the suites

const results = []
async function test(name, fn) {
  const before = failed
  await fn()
  results.push((failed === before ? 'ok   ' : 'FAIL ') + name)
}

await test('findEngine reports what is missing', () => {
  const missing = findEngine('C:/definitely/not/here')
  eq(missing.ok, false, 'no root -> not ok')
  eq(missing.reason, 'engine-missing', 'reason is engine-missing')
})

await test('start() handshakes and genmove maps GTP vertices to indices', async () => {
  const fake = makeFakeEngine()
  const engine = createEngine(options({ fake, commandTimeoutMs: 500 }))
  const started = await engine.start()
  eq(started.ok, true, 'started')
  eq(started.name, 'KataGo (fake)', 'name round-trip')

  const game = createGame({ size: 9, komi: 5.5 })
  const move = await engine.genmove(game, BLACK)
  eq(move.raw, 'D4', 'raw vertex')
  eq(move.point, point(9, 3, 5), 'D4 on 9x9 maps to x=3,y=5')
  eq(move.pass, undefined, 'not a pass')
  engine.stop()
})

await test('pass and resign are recognised', async () => {
  const fake = makeFakeEngine({ reply: (cmd) => (cmd.startsWith('genmove') ? '= pass' : defaultReply(cmd)) })
  const engine = createEngine(options({ fake }))
  await engine.start()
  const passed = await engine.genmove(createGame({ size: 9 }), BLACK)
  eq(passed.point, -1, 'pass point is -1')
  eq(passed.pass, true, 'pass flag')
  engine.stop()

  const fake2 = makeFakeEngine({ reply: (cmd) => (cmd.startsWith('genmove') ? '= resign' : defaultReply(cmd)) })
  const engine2 = createEngine(options({ fake: fake2 }))
  await engine2.start()
  const resigned = await engine2.genmove(createGame({ size: 9 }), WHITE)
  eq(resigned.resign, true, 'resign flag')
  engine2.stop()
})

await test('syncGame replays size, komi, handicap and every move', async () => {
  const fake = makeFakeEngine()
  const engine = createEngine(options({ fake }))
  await engine.start()
  const game = createGame({ size: 9, komi: 6.5 })
  play(game, point(9, 2, 2), BLACK)
  play(game, point(9, 6, 6), WHITE)
  await engine.genmove(game, BLACK)
  ok(fake.seen.includes('clear_board'), 'clear_board sent (KataGo will not clear on a same-size boardsize)')
  ok(fake.seen.indexOf('clear_board') < fake.seen.indexOf('boardsize 9'), 'clear_board precedes boardsize')
  ok(fake.seen.includes('boardsize 9'), 'boardsize sent')
  ok(fake.seen.includes('komi 6.5'), 'komi sent')
  ok(fake.seen.includes('play B C7'), 'black move replayed as C7')
  ok(fake.seen.includes('play W G3'), 'white move replayed as G3')
  engine.stop()
})

await test('handicap games use set_free_handicap', async () => {
  const fake = makeFakeEngine()
  const engine = createEngine(options({ fake }))
  await engine.start()
  const game = createGame({ size: 9, handicap: 3 })
  await engine.genmove(game, WHITE)
  const handicapCmd = fake.seen.find((c) => c.startsWith('set_free_handicap'))
  ok(handicapCmd, 'set_free_handicap sent')
  eq((handicapCmd || '').split(' ').length - 1, 3, 'three handicap stones')
  engine.stop()
})

await test('a silent engine times out instead of hanging', async () => {
  const fake = makeFakeEngine({ silentOn: 'genmove' })
  const engine = createEngine(options({ fake, commandTimeoutMs: 300 }))
  await engine.start()
  await rejects(() => engine.genmove(createGame({ size: 9 }), BLACK), 'gtp-timeout', 'genmove timed out')
  engine.stop()
})

await test('an engine crash rejects the in-flight command', async () => {
  const fake = makeFakeEngine({ silentOn: 'genmove' })
  const engine = createEngine(options({ fake, commandTimeoutMs: 5000 }))
  await engine.start()
  const inflight = engine.genmove(createGame({ size: 9 }), BLACK)
  setTimeout(() => fake.proc.emit('exit', 1, null), 30)
  await rejects(() => inflight, 'engine-exited', 'crash surfaces to the caller')
  engine.stop()
})

await test('start() fails cleanly when the binary is absent', async () => {
  const engine = createEngine({ exePath: 'C:/nope/katago.exe', modelPath: 'C:/nope/model.bin.gz', spawnFn: () => { throw new Error('should not spawn') } })
  const r = await engine.start()
  eq(r.ok, false, 'not ok')
  eq(r.error, 'engine-missing', 'reports engine-missing')
  eq(engine.status().running, false, 'status says not running')
})

await test('defaults are sane', () => {
  eq(ENGINE_DEFAULT_THREADS, 4, 'default threads')
  const engine = createEngine({ exePath: 'x', modelPath: 'y', spawnFn: () => ({}) })
  eq(engine.status().configured, true, 'configured when paths are given')
  eq(engine.status().running, false, 'not running before start')
})

console.log('')
for (const r of results) console.log('  ' + r)
console.log('')
console.log('gtp tests: ' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
