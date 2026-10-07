/**
 * dsh-go-game GTP bridge — drives an external neural-network engine (KataGo)
 * over stdin/stdout, in the standard Go Text Protocol.
 *
 * The engine keeps its own board, so every query starts from a clean slate:
 * `syncGame` clears the engine board, re-applies size/komi/handicap and replays
 * the whole move list. That is cheap (a few hundred lines) and immune to the
 * panel's undo / SGF-load / multi-session behaviour.
 *
 * No rules live here: this module only translates between our board indices and
 * GTP vertices, using engine.js as the single source of truth for the mapping.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { BLACK, WHITE, vertex, fromVertex } from './engine.js'

export const ENGINE_DEFAULT_THREADS = 4
export const ENGINE_DEFAULT_VISITS = 250
/** Seconds per move for a CPU-only engine; keeps play responsive. */
export const ENGINE_DEFAULT_TIME_SEC = 8

/** GTP colour letter for one of our colour constants. */
function gtpColor(color) {
  return color === BLACK ? 'B' : color === WHITE ? 'W' : null
}

/**
 * Resolve the engine layout under `root`:
 *   <root>/engine/katago.exe            (or katago on non-Windows)
 *   <root>/engine/default_gtp.cfg       (optional)
 *   <root>/weights/*.bin.gz             (model)
 * Returns { ok, exePath, modelPath, configPath, models, reason }.
 */
export function findEngine(root, opts = {}) {
  const exe = process.platform === 'win32' ? 'katago.exe' : 'katago'
  const exePath = join(root, 'engine', exe)
  const configPath = join(root, 'engine', 'default_gtp.cfg')
  const weightsDir = join(root, 'weights')
  let models = []
  try {
    models = readdirSync(weightsDir).filter((f) => f.endsWith('.bin.gz')).sort()
  } catch (err) {
    models = []
  }
  const want = opts.model || null
  const modelPath = want ? join(weightsDir, want) : models.length ? join(weightsDir, models[0]) : null
  if (!existsSync(exePath)) return { ok: false, reason: 'engine-missing', exePath, modelPath: null, models: [] }
  if (!modelPath || !existsSync(modelPath)) {
    return { ok: false, reason: 'model-missing', exePath, modelPath: null, models }
  }
  return {
    ok: true,
    reason: 'ok',
    exePath,
    modelPath,
    configPath: existsSync(configPath) ? configPath : null,
    models,
  }
}

/** Split a chunk stream into whole lines. */
function lineSplitter(onLine) {
  let rest = ''
  return (chunk) => {
    rest += chunk
    let at
    while ((at = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, at).replace(/\r$/, '')
      rest = rest.slice(at + 1)
      onLine(line)
    }
  }
}

/**
 * A single engine process. Commands are serialised: GTP allows one query at a
 * time, and KataGo answers in order.
 */
export function createEngine(opts = {}) {
  const exePath = opts.exePath
  const modelPath = opts.modelPath
  const configPath = opts.configPath || null
  const threads = Math.max(1, Math.min(64, Number(opts.threads) || ENGINE_DEFAULT_THREADS))
  const visits = Math.max(1, Math.min(1e6, Number(opts.visits) || ENGINE_DEFAULT_VISITS))
  // Wall-clock ceiling per move. Visits alone make a CPU-only engine's response
  // time unpredictable; maxTime bounds it and lets strength follow the hardware.
  const maxTimeSec = Math.max(0, Math.min(600, Number(opts.maxTimeSec) || 0))
  const cwd = opts.cwd || (exePath ? join(exePath, '..') : process.cwd())
  const commandTimeoutMs = Math.max(2000, Number(opts.commandTimeoutMs) || 30000)
  const maxLogLines = 120
  // Seam for tests: a fake spawn keeps the protocol logic offline-testable.
  const spawnFn = opts.spawnFn || spawn

  let child = null
  let starting = null
  let stopping = false
  const pending = []
  const log = []
  const state = { running: false, ready: false, lastError: '', startedAt: 0, commands: 0 }

  function pushLog(line) {
    log.push(line)
    if (log.length > maxLogLines) log.shift()
  }

  function settle(err, text) {
    const p = pending.shift()
    if (!p) return
    clearTimeout(p.timer)
    if (err) p.reject(err)
    else p.resolve(text)
  }

  function failAll(err) {
    while (pending.length) {
      const p = pending.shift()
      clearTimeout(p.timer)
      p.reject(err)
    }
  }

  const onStdout = lineSplitter((line) => {
    if (!line) return
    if (line[0] === '=') return settle(null, line.slice(1).trim())
    if (line[0] === '?') return settle(new Error(line.slice(1).trim() || 'gtp-error'), null)
    pushLog('out: ' + line)
  })
  const onStderr = lineSplitter((line) => {
    if (line) pushLog('err: ' + line)
  })

  function attach(proc) {
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', onStdout)
    proc.stderr.on('data', onStderr)
    proc.on('error', (err) => {
      state.lastError = String(err && err.message ? err.message : err)
      state.running = false
      failAll(new Error(state.lastError))
    })
    proc.on('exit', (code, signal) => {
      state.running = false
      state.ready = false
      child = null
      const why = stopping ? 'engine-stopped' : 'engine-exited code=' + code + ' signal=' + signal
      if (!stopping) state.lastError = why
      pushLog(why)
      failAll(new Error(why))
    })
  }

  function request(cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!child) return reject(new Error('engine-not-running'))
      const timer = setTimeout(() => {
        const idx = pending.findIndex((p) => p.timer === timer)
        if (idx !== -1) pending.splice(idx, 1)
        reject(new Error('gtp-timeout: ' + cmd))
      }, timeoutMs || commandTimeoutMs)
      pending.push({ resolve, reject, timer, cmd })
      state.commands++
      try {
        child.stdin.write(cmd + '\n')
      } catch (err) {
        reject(err)
      }
    })
  }

  async function start() {
    if (state.running && state.ready) return { ok: true }
    if (starting) return starting
    if (!exePath || !existsSync(exePath)) return { ok: false, error: 'engine-missing' }
    if (!modelPath || !existsSync(modelPath)) return { ok: false, error: 'model-missing' }

    const args = ['gtp', '-model', modelPath]
    if (configPath) args.push('-config', configPath)
    args.push('-override-config', 'numSearchThreads=' + threads + ',maxVisits=' + visits + (maxTimeSec > 0 ? ',maxTime=' + maxTimeSec : ''))

    starting = (async () => {
      stopping = false
      pushLog('spawn ' + exePath + ' ' + args.join(' '))
      child = spawnFn(exePath, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      state.running = true
      state.startedAt = Date.now()
      attach(child)
      // A first round-trip proves the model loaded and the pipe works.
      const name = await request('name', Math.max(commandTimeoutMs, 60000))
      state.ready = true
      state.lastError = ''
      return { ok: true, name }
    })()
      .catch((err) => {
        state.lastError = String(err && err.message ? err.message : err)
        state.ready = false
        return { ok: false, error: state.lastError }
      })
      .finally(() => {
        starting = null
      })
    return starting
  }

  function stop() {
    stopping = true
    state.ready = false
    state.running = false
    const proc = child
    child = null
    if (proc) {
      try {
        proc.stdin.write('quit\n')
      } catch (err) {
        /* pipe already gone */
      }
      const killTimer = setTimeout(() => {
        try {
          proc.kill()
        } catch (err) {
          /* already dead */
        }
      }, 1500)
      if (typeof killTimer.unref === 'function') killTimer.unref()
    }
    failAll(new Error('engine-stopped'))
  }

  /** Rebuild the engine's board so it matches `game` exactly. */
  async function syncGame(game) {
    // KataGo requires an explicit clear_board: setting boardsize to the size it
    // already has does not wipe the stones, so replaying would hit "illegal
    // move" on the first repeated point.
    await request('clear_board')
    await request('boardsize ' + game.size)
    await request('komi ' + game.komi)
    if (game.handicap >= 2) {
      const stones = []
      for (let i = 0; i < game.board.length; i++) {
        if (game.board[i] === BLACK && !game.moves.some((m) => m.point === i)) stones.push(vertex(game.size, i))
      }
      if (stones.length) await request('set_free_handicap ' + stones.join(' '))
    }
    for (const m of game.moves) {
      await request('play ' + gtpColor(m.color) + ' ' + vertex(game.size, m.point))
    }
  }

  /**
   * Ask the engine for its move. Returns one of:
   *   { point, vertex, raw, ms }  — a legal vertex
   *   { point: -1, pass: true }   — the engine passed
   *   { resign: true }            — the engine resigned
   */
  async function genmove(game, color, budgetMs) {
    const t0 = Date.now()
    await syncGame(game)
    const raw = String(await request('genmove ' + gtpColor(color), budgetMs || commandTimeoutMs)).trim()
    const lower = raw.toLowerCase()
    if (lower === 'pass') return { point: -1, pass: true, raw, ms: Date.now() - t0 }
    if (lower === 'resign') return { resign: true, raw, ms: Date.now() - t0 }
    const point = fromVertex(game.size, raw)
    if (point < 0) throw new Error('engine-vertex-unparsed: ' + raw)
    return { point, vertex: vertex(game.size, point), raw, ms: Date.now() - t0 }
  }

  function status() {
    return {
      configured: Boolean(exePath && modelPath),
      running: state.running && state.ready,
      model: modelPath ? modelPath.replace(/^.*[\\/]/, '') : null,
      threads,
      visits,
      maxTimeSec,
      lastError: state.lastError,
      commands: state.commands,
      log: log.slice(-12),
    }
  }

  return { start, stop, genmove, syncGame, status, request }
}
