/**
 * dsh-go-game host half.
 *
 * Owns the rules: one in-memory Go session per client id, the AI opponent, the
 * dead-stone estimator, SGF save/load and the optional LLM review. The browser
 * halves (the DSH panel and the standalone page) are thin views over these
 * routes — no rules live in the browser.
 *
 * Routes (all under the /dsh-go-game prefix):
 *   GET  /dsh-go-game/            full-page game (standalone browser fallback)
 *   GET  /dsh-go-game/page.js     that page's script
 *   GET  /dsh-go-game/status      health + capabilities (used by check-plugin)
 *   POST /dsh-go-game/new         {id?, size, komi, handicap, level, aiSide}
 *   POST /dsh-go-game/move        {id, point, autoAi?}
 *   POST /dsh-go-game/pass        {id, autoAi?}
 *   POST /dsh-go-game/undo        {id, steps?}
 *   POST /dsh-go-game/resign      {id, color?}
 *   POST /dsh-go-game/ai          {id, level?, budgetMs?}
 *   POST /dsh-go-game/dead        {id, point?}      toggle / clear dead markers
 *   POST /dsh-go-game/estimate    {id, playouts?, budgetMs?}
 *   GET  /dsh-go-game/review      {id, provider?, model?}  (LLM, optional)
 *   GET  /dsh-go-game/models      providers and models the harness offers
 *   GET  /dsh-go-game/games       saved SGF names
 *   POST /dsh-go-game/save        {id, name}
 *   POST /dsh-go-game/load        {id, name}
 */

import { readFileSync } from 'node:fs'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BLACK,
  EMPTY,
  WHITE,
  createGame,
  fromSGF,
  pass as enginePass,
  play,
  resign as engineResign,
  result,
  sgf,
  starPoints,
  summarise,
  undo as engineUndo,
  vertex,
} from './engine.js'
import { evaluatePosition, localSummary, pickMove } from './ai.js'
import { createEngine, findEngine, ENGINE_DEFAULT_THREADS, ENGINE_DEFAULT_VISITS, ENGINE_DEFAULT_TIME_SEC } from './gtp.js'

export const name = 'dsh-go-game'

const HERE = dirname(fileURLToPath(import.meta.url))
const SAVE_DIR = join(process.cwd(), '.dsh-go-game', 'games')
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * External neural-network engine (KataGo) layout. It lives beside the plugin so
 * a `link:` install finds it with no configuration; override with
 * DSH_GO_GAME_KATAGO_ROOT / _THREADS / _VISITS.
 */
const ENGINE_ROOT = process.env.DSH_GO_GAME_KATAGO_ROOT || join(HERE, '..', '..', 'katago')
const ENGINE = { instance: null, model: null, lastError: '' }

const SESSIONS = new Map()

function now() {
  return Date.now()
}

function sweep() {
  const cutoff = now() - SESSION_TTL_MS
  for (const [id, s] of SESSIONS) {
    if (s.updatedAt < cutoff) SESSIONS.delete(id)
  }
}

function getSession(id) {
  const s = SESSIONS.get(id)
  if (s) s.updatedAt = now()
  return s
}

function createSession(opts = {}) {
  const size = [9, 13, 19].includes(Number(opts.size)) ? Number(opts.size) : 19
  const level = ['easy', 'medium', 'hard'].includes(opts.level) ? opts.level : 'medium'
  const aiSide = opts.aiSide === 'black' ? BLACK : opts.aiSide === 'white' ? WHITE : null
  const engineName = opts.engine === 'katago' ? 'katago' : 'builtin'
  const game = createGame({ size, komi: opts.komi, handicap: opts.handicap })
  const session = {
    game,
    dead: new Set(),
    level,
    engine: engineName,
    aiSide,
    estimate: null,
    review: '',
    reviewAt: 0,
    updatedAt: now(),
  }
  return session
}

function stars(size) {
  return starPoints(size).map((p) => ({ x: p.x, y: p.y }))
}

function stateOf(id, session, extra = {}) {
  const game = session.game
  const dead = [...session.dead].filter((i) => game.board[i] !== EMPTY)
  const last = game.lastMove
  const res = game.over ? result(game, dead) : null
  return {
    ok: true,
    id,
    size: game.size,
    komi: game.komi,
    handicap: game.handicap,
    stars: stars(game.size),
    board: Array.from(game.board),
    turn: game.turn,
    turnName: game.turn === BLACK ? 'black' : 'white',
    captures: { black: game.captures[BLACK], white: game.captures[WHITE] },
    moveCount: game.moves.length,
    passes: game.passes,
    lastMove: last,
    lastVertex: last >= 0 ? vertex(game.size, last) : null,
    ko: game.ko,
    over: game.over,
    winner: game.winner,
    endReason: game.endReason,
    canUndo: game.past.length > 0,
    aiSide: session.aiSide === BLACK ? 'black' : session.aiSide === WHITE ? 'white' : null,
    level: session.level,
    engine: session.engine,
    engineInfo: engineStatus(),
    aiFallback: session.engineFallback || '',
    dead,
    result: res ? serialiseResult(res) : null,
    summary: summarise(game, dead),
    review: session.review,
    ...extra,
  }
}

function serialiseResult(res) {
  return {
    rules: res.rules,
    winner: res.winner,
    winnerName: res.winnerName,
    margin: res.margin,
    reason: res.reason,
    blackScore: res.blackScore,
    whiteScore: res.whiteScore,
    dame: res.dame,
    komi: res.komi,
  }
}

// ----------------------------------------------------------------- plumbing

function sendJson(res, body, status = 200) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (err) {
        reject(new Error('bad-json'))
      }
    })
    req.on('error', reject)
  })
}

function sendText(res, text, type = 'text/plain; charset=utf-8') {
  res.statusCode = 200
  res.setHeader('content-type', type)
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

function file(path, type) {
  return (_req, res) => {
    try {
      sendText(res, readFileSync(path, 'utf8'), type)
    } catch (err) {
      sendJson(res, { ok: false, error: 'missing-file', path }, 500)
    }
  }
}

// --------------------------------------------------------------------- LLM

function llmService(ctx) {
  try {
    const llm = ctx.get ? ctx.get('llm') : undefined
    return llm && typeof llm.stream === 'function' ? llm : null
  } catch (err) {
    return null
  }
}

async function listModels(llm) {
  if (!llm) return []
  const out = []
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch (err) {
    return out
  }
  for (const p of providers || []) {
    const id = typeof p === 'string' ? p : p && (p.id || p.name)
    if (!id) continue
    let models = []
    try {
      models = await llm.listModels(id)
    } catch (err) {
      models = []
    }
    out.push({
      provider: id,
      models: (models || []).map((m) => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean),
    })
  }
  return out
}

async function defaultTarget(llm) {
  const all = await listModels(llm)
  for (const p of all) {
    if (p.models.length) return { provider: p.provider, model: p.models[0] }
  }
  return null
}

async function llmText(llm, { provider, model, prompt, maxTokens = 700 }) {
  let text = ''
  let failure = null
  const stream = llm.stream({
    provider,
    model,
    maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  })
  for await (const chunk of stream) {
    if (!chunk) continue
    if (chunk.type === 'text-delta') text += chunk.text || ''
    else if (chunk.type === 'finish') {
      const reason = chunk.reason || {}
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        failure = reason.failure ? reason.failure.code || reason.failure.message : reason.kind
      }
    }
  }
  if (failure && !text) throw new Error('llm-' + failure)
  return text
}

// ------------------------------------------------------------------ prompts

function boardDiagram(game, dead = new Set()) {
  const size = game.size
  const letters = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'
  const header = '   ' + letters.slice(0, size).split('').join(' ')
  const rows = []
  for (let y = 0; y < size; y++) {
    const cells = []
    for (let x = 0; x < size; x++) {
      const v = game.board[y * size + x]
      if (v === EMPTY) cells.push('.')
      else if (v === BLACK) cells.push(dead.has(y * size + x) ? 'x' : 'X')
      else cells.push(dead.has(y * size + x) ? 'o' : 'O')
    }
    rows.push(String(size - y).padStart(2, ' ') + ' ' + cells.join(' '))
  }
  return header + '\n' + rows.join('\n')
}

function moveListText(game, lastN = 60) {
  const out = []
  const moves = game.moves.slice(-lastN)
  let n = game.moves.length - moves.length + 1
  for (const m of moves) {
    out.push(n + '.' + (m.color === BLACK ? 'B' : 'W') + (m.point < 0 ? 'pass' : vertex(game.size, m.point)))
    n++
  }
  return out.join(' ')
}

function reviewPrompt(game, dead) {
  const deadList = [...dead].map((i) => vertex(game.size, i)).join(' ') || '(none marked)'
  return [
    'You are a patient Go (weiqi) teacher reviewing a finished or paused game for a beginner.',
    'Board (' + game.size + 'x' + game.size + ', Chinese area scoring, komi ' + game.komi + '):',
    'X = black, O = white, . = empty, lowercase = marked dead.',
    boardDiagram(game, dead),
    'Moves: ' + (moveListText(game) || '(none)'),
    'Dead stones marked: ' + deadList,
    game.over ? 'The game is over.' : 'It is ' + (game.turn === BLACK ? 'black' : 'white') + "'s turn.",
    'Reply in Cantonese Chinese, at most 5 short sentences:',
    '1) who is ahead and by roughly how much, 2) the single biggest mistake or turning point,',
    '3) one concrete suggestion for the player to improve. Then on a new final line write',
    '"建議: <coordinate>" using the board letters and numbers above (for example 建議: D4), or 建議: pass.',
  ].join('\n')
}

function parseSuggestion(game, text) {
  const m = /建議\s*[:：]\s*([A-HJ-Ta-hj-t]\s?\d{1,2}|pass)/i.exec(String(text || ''))
  if (!m) return null
  if (/pass/i.test(m[1])) return { vertex: 'pass', point: -1 }
  const raw = m[1].replace(/\s+/g, '').toUpperCase()
  const letter = raw[0]
  const num = Number(raw.slice(1))
  const x = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'.indexOf(letter)
  const y = game.size - num
  if (x < 0 || x >= game.size || y < 0 || y >= game.size) return { vertex: raw, point: -1 }
  return { vertex: raw, point: y * game.size + x }
}

// ------------------------------------------------------------------- saving

function safeName(raw) {
  const base = String(raw || '').trim().replace(/[^0-9A-Za-z_\u4e00-\u9fff-]+/g, '-').slice(0, 48)
  return base || 'game-' + new Date().toISOString().replace(/[:.]/g, '-')
}

function listGames() {
  try {
    return readdirSync(SAVE_DIR).filter((f) => f.endsWith('.sgf')).map((f) => f.slice(0, -4)).sort()
  } catch (err) {
    return []
  }
}

// -------------------------------------------------------------------- apply

/** Register every route on the webserver service. */
function register(ctx, webServer) {
  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    const path = url.pathname.replace(/\/+$/, '') || '/dsh-go-game'
    const method = (req.method || 'GET').toUpperCase()

    if (method === 'GET' && (path === '/dsh-go-game' || path === '/dsh-go-game/')) {
      return file(join(HERE, 'page.html'), 'text/html; charset=utf-8')(req, res)
    }
    if (method === 'GET' && path === '/dsh-go-game/page.js') {
      return file(join(HERE, 'page.js'), 'text/javascript; charset=utf-8')(req, res)
    }

    const body = method === 'POST' ? await readBody(req) : {}
    const query = Object.fromEntries(url.searchParams.entries())
    const input = { ...query, ...body }

    switch (path) {
      case '/dsh-go-game/status':
        return sendJson(res, {
          ok: true,
          plugin: name,
          version: '1.0.0',
          rules: 'chinese-area',
          sizes: [9, 13, 19],
          levels: ['easy', 'medium', 'hard'],
          llm: Boolean(llmService(ctx)),
          sessions: SESSIONS.size,
          saveDir: SAVE_DIR,
        })

      case '/dsh-go-game/models': {
        const llm = llmService(ctx)
        const targets = await listModels(llm)
        return sendJson(res, { ok: true, llm: Boolean(llm), targets })
      }

      case '/dsh-go-game/new': {
        sweep()
        const id = String(input.id || 's-' + Math.random().toString(36).slice(2, 10))
        const session = createSession(input)
        SESSIONS.set(id, session)
        return sendJson(res, stateOf(id, session))
      }

      case '/dsh-go-game/move': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const point = Number(input.point)
        if (!Number.isInteger(point)) return sendJson(res, { ok: false, error: 'bad-point' }, 400)
        const r = play(session.game, point)
        if (!r.ok) return sendJson(res, { ok: false, error: r.error, state: stateOf(input.id, session) })
        session.dead.clear()
        session.estimate = null
        session.review = ''
        let aiPlay = null
        if (input.autoAi && session.aiSide === session.game.turn && !session.game.over) {
          aiPlay = await playAi(session, input)
        }
        return sendJson(res, stateOf(String(input.id), session, { aiPlay, captured: r.captured }))
      }

      case '/dsh-go-game/pass': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const r = enginePass(session.game)
        if (!r.ok) return sendJson(res, { ok: false, error: r.error })
        session.review = ''
        let aiPlay = null
        if (input.autoAi && session.aiSide === session.game.turn && !session.game.over) {
          aiPlay = await playAi(session, input)
        }
        return sendJson(res, stateOf(String(input.id), session, { aiPlay }))
      }

      case '/dsh-go-game/undo': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const steps = Math.max(1, Math.min(40, Number(input.steps) || 1))
        engineUndo(session.game, steps)
        session.dead.clear()
        session.estimate = null
        session.review = ''
        return sendJson(res, stateOf(String(input.id), session))
      }

      case '/dsh-go-game/resign': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const color = input.color === 'white' ? WHITE : input.color === 'black' ? BLACK : session.game.turn
        engineResign(session.game, color)
        return sendJson(res, stateOf(String(input.id), session))
      }

      case '/dsh-go-game/ai': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        if (session.game.over) return sendJson(res, { ok: false, error: 'game-over' })
        const aiPlay = await playAi(session, input)
        return sendJson(res, stateOf(String(input.id), session, { aiPlay }))
      }

      case '/dsh-go-game/dead': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        if (input.clear) {
          session.dead.clear()
        } else {
          const p = Number(input.point)
          if (!Number.isInteger(p)) return sendJson(res, { ok: false, error: 'bad-point' }, 400)
          if (session.dead.has(p)) session.dead.delete(p)
          else if (session.game.board[p] !== EMPTY) session.dead.add(p)
        }
        session.estimate = null
        return sendJson(res, stateOf(String(input.id), session))
      }

      case '/dsh-go-game/estimate': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const t0 = now()
        const est =
          session.estimate ||
          evaluatePosition(session.game, {
            playouts: Math.max(8, Math.min(120, Number(input.playouts) || 40)),
            budgetMs: Math.max(200, Math.min(6000, Number(input.budgetMs) || 1500)),
            seed: Math.floor(Math.random() * 1e9),
          })
        session.estimate = est
        return sendJson(
          res,
          stateOf(String(input.id), session, {
            estimate: {
              dead: est.dead.map((i) => vertex(session.game.size, i)),
              owner: Array.from(est.owner),
              blackScore: est.blackScore,
              whiteScore: est.whiteScore,
              winner: est.winner,
              margin: est.margin,
              playouts: est.playouts,
              elapsedMs: est.elapsedMs,
            },
            ms: now() - t0,
          }),
        )
      }

      case '/dsh-go-game/local': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const s = localSummary(session.game, [...session.dead])
        return sendJson(res, { ok: true, text: s.text, blackScore: s.blackScore, whiteScore: s.whiteScore })
      }

      case '/dsh-go-game/review': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const llm = llmService(ctx)
        const dead = [...session.dead]
        if (!llm) {
          const s = localSummary(session.game, dead)
          return sendJson(res, {
            ok: true,
            llm: false,
            text: s.text + '（未配置模型，以下為本地形勢判斷。）',
            local: true,
          })
        }
        let target = null
        if (input.provider && input.model) target = { provider: String(input.provider), model: String(input.model) }
        else target = await defaultTarget(llm)
        if (!target) {
          const s = localSummary(session.game, dead)
          return sendJson(res, { ok: true, llm: false, text: s.text, local: true })
        }
        try {
          const text = await llmText(llm, {
            provider: target.provider,
            model: target.model,
            prompt: reviewPrompt(session.game, new Set(dead)),
          })
          const suggestion = parseSuggestion(session.game, text)
          session.review = text
          session.reviewAt = now()
          return sendJson(res, {
            ok: true,
            llm: true,
            provider: target.provider,
            model: target.model,
            text,
            suggestion,
          })
        } catch (err) {
          return sendJson(
            res,
            { ok: false, error: 'llm-failed', message: err && err.message ? err.message : String(err), llm: true },
            200,
          )
        }
      }

      case '/dsh-go-game/engine': {
        if (input.model !== undefined) {
          ENGINE.model = input.model ? String(input.model) : null
          if (ENGINE.instance) {
            ENGINE.instance.stop()
            ENGINE.instance = null
          }
        }
        return sendJson(res, { ok: true, engine: engineStatus() })
      }

      case '/dsh-go-game/games':
        return sendJson(res, { ok: true, games: listGames(), saveDir: SAVE_DIR })

      case '/dsh-go-game/save': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const label = safeName(input.name)
        try {
          mkdirSync(SAVE_DIR, { recursive: true })
          writeFileSync(join(SAVE_DIR, label + '.sgf'), sgf(session.game), 'utf8')
          return sendJson(res, { ok: true, name: label, games: listGames() })
        } catch (err) {
          return sendJson(res, { ok: false, error: 'save-failed', message: String(err && err.message) })
        }
      }

      case '/dsh-go-game/load': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        const label = safeName(input.name)
        try {
          const text = readFileSync(join(SAVE_DIR, label + '.sgf'), 'utf8')
          session.game = fromSGF(text)
          session.dead.clear()
          session.estimate = null
          session.review = ''
          return sendJson(res, stateOf(String(input.id), session))
        } catch (err) {
          return sendJson(res, { ok: false, error: 'load-failed', message: String(err && err.message) })
        }
      }

      case '/dsh-go-game/sgf': {
        const session = getSession(String(input.id || ''))
        if (!session) return sendJson(res, { ok: false, error: 'no-session' }, 404)
        return sendJson(res, { ok: true, sgf: sgf(session.game) })
      }

      default:
        return sendJson(res, { ok: false, error: 'no-route', path }, 404)
    }
  }

  return webServer.register({ kind: 'prefix', path: '/dsh-go-game', handler })
}

/** Let the AI play one move in the session; returns a small record or null. */
async function playAi(session, input) {
  const game = session.game
  if (game.over) return null
  if ((input.engine || session.engine) === 'katago') {
    const nn = await engineMove(session, input)
    if (nn) return nn
    // engine unavailable or unusable — fall through to the built-in opponent
  }
  const level = ['easy', 'medium', 'hard'].includes(input.level) ? input.level : session.level
  const t0 = now()
  const point = pickMove(game, {
    level,
    budgetMs: Math.max(200, Math.min(8000, Number(input.budgetMs) || (level === 'hard' ? 1800 : 600))),
    seed: Math.floor(Math.random() * 1e9),
  })
  if (point < 0) {
    enginePass(game)
    return { point: -1, vertex: 'pass', level, ms: now() - t0 }
  }
  const r = play(game, point)
  session.dead.clear()
  session.estimate = null
  session.review = ''
  return {
    point,
    vertex: vertex(game.size, point),
    captured: r.ok ? r.captured.length : 0,
    level,
    ms: now() - t0,
  }
}

/** Report the external engine's availability without starting it. */
function engineStatus() {
  const info = findEngine(ENGINE_ROOT, { model: ENGINE.model || undefined })
  const running = Boolean(ENGINE.instance && ENGINE.instance.status().running)
  return {
    root: ENGINE_ROOT,
    available: info.ok,
    reason: info.ok ? 'ok' : info.reason,
    models: info.models,
    selected: info.modelPath ? info.modelPath.replace(/^.*[\\/]/, '') : null,
    running,
    lastError: ENGINE.lastError || (ENGINE.instance ? ENGINE.instance.status().lastError : ''),
  }
}

/**
 * One KataGo move. Returns a play record, or null when the engine cannot be
 * used — the caller then falls back to the built-in opponent, so a missing or
 * crashed engine degrades instead of breaking the game.
 */
async function engineMove(session, input) {
  const info = findEngine(ENGINE_ROOT, { model: ENGINE.model || undefined })
  if (!info.ok) {
    ENGINE.lastError = info.reason
    session.engineFallback = info.reason
    return null
  }
  if (!ENGINE.instance) {
    ENGINE.instance = createEngine({
      exePath: info.exePath,
      modelPath: info.modelPath,
      configPath: info.configPath,
      threads: Number(process.env.DSH_GO_GAME_KATAGO_THREADS) || ENGINE_DEFAULT_THREADS,
      visits: Number(process.env.DSH_GO_GAME_KATAGO_VISITS) || ENGINE_DEFAULT_VISITS,
      maxTimeSec: Number(process.env.DSH_GO_GAME_KATAGO_TIME) || ENGINE_DEFAULT_TIME_SEC,
      commandTimeoutMs: Math.max(30000, Number(process.env.DSH_GO_GAME_KATAGO_TIMEOUT) || 90000),
    })
  }
  const started = await ENGINE.instance.start()
  if (!started.ok) {
    ENGINE.lastError = String(started.error || 'engine-start-failed')
    session.engineFallback = ENGINE.lastError
    return null
  }
  const t0 = now()
  const color = session.game.turn
  // CPU-only engines are slow: give the search a wide budget by default so a
  // normal move is never cut short (the panel shows "thinking" meanwhile).
  const budgetMs = Math.max(3000, Math.min(180000, Number(input.budgetMs) || 60000))
  let res
  try {
    res = await ENGINE.instance.genmove(session.game, color, budgetMs)
  } catch (err) {
    ENGINE.lastError = String((err && err.message) || err)
    // A timed-out query leaves the engine's reply in flight, which would be
    // mis-attributed to the next command — drop the process and start fresh.
    try {
      ENGINE.instance.stop()
    } catch (stopErr) {
      /* already gone */
    }
    ENGINE.instance = null
    session.engineFallback = ENGINE.lastError
    return null
  }
  if (res.resign) {
    engineResign(session.game, color)
    return { point: -2, vertex: 'resign', engine: 'katago', ms: now() - t0 }
  }
  if (res.pass) {
    enginePass(session.game)
    session.dead.clear()
    session.estimate = null
    session.review = ''
    return { point: -1, vertex: 'pass', engine: 'katago', ms: now() - t0 }
  }
  const r = play(session.game, res.point)
  if (!r.ok) {
    ENGINE.lastError = 'engine-illegal:' + res.raw
    session.engineFallback = ENGINE.lastError
    return null
  }
  session.engineFallback = ''
  session.dead.clear()
  session.estimate = null
  session.review = ''
  return {
    point: res.point,
    vertex: vertex(session.game.size, res.point),
    captured: r.captured.length,
    engine: 'katago',
    ms: now() - t0,
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer || (ctx.get ? ctx.get('webServer') : null)
  if (!webServer || typeof webServer.register !== 'function') return

  const dispose = register(ctx, webServer)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (err) {
        /* the webserver owns the table; nothing to do if it is already gone */
      }
      try {
        if (ENGINE.instance) ENGINE.instance.stop()
      } catch (err) {
        /* engine already gone */
      }
      ENGINE.instance = null
      SESSIONS.clear()
    })
  }
}

export const inject = ['webServer']
