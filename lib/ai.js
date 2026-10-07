/**
 * dsh-go-game AI — a pure playout/heuristic Go opponent plus a dead-stone
 * estimator. No DOM, no DSH imports.
 *
 * Honest framing (keep this in the UI too): this is a practice partner, not
 * an engine. Levels:
 *   easy   — random legal moves that avoid filling own eyes.
 *   medium — greedy tactical heuristics (capture, save, atari, extend, shape).
 *   hard   — the medium candidate set, each scored by a series of light random
 *            playouts, within a wall-clock budget.
 * On 19x19 even `hard` is far below a human amateur. On 9x9 it plays a
 * recognisable game.
 */

import {
  BLACK,
  EMPTY,
  WHITE,
  cloneGame,
  play,
  isEyeLike,
  other,
  score,
} from './engine.js'

/** Deterministic PRNG so tests and repeat requests are reproducible. */
export function rngFrom(seed) {
  let a = (Number(seed) || 1) >>> 0
  return function rng() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function lightClone(game) {
  return {
    size: game.size,
    komi: game.komi,
    rules: game.rules,
    handicap: game.handicap,
    board: game.board.slice(),
    turn: game.turn,
    captures: { 1: game.captures[1], 2: game.captures[2] },
    moves: [],
    passes: game.passes,
    ko: game.ko,
    lastMove: game.lastMove,
    over: game.over,
    winner: null,
    endReason: null,
    past: [],
  }
}

function randomLegalNonEye(game, color, rng, avoidEye = true) {
  const size = game.size
  const n = game.board.length
  const start = Math.floor(rng() * n)
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (game.board[i] !== EMPTY) continue
    if (avoidEye && isEyeLike(game, i, color)) continue
    const probe = play(lightClone(game), i, color)
    if (probe.ok) return i
  }
  return -1
}

// --------------------------------------------------------------- heuristics

const EDGE_WORDS = { 19: [3, 9, 15], 13: [3, 9], 9: [2, 6] }

function neighbourStoneBonus(game, i) {
  const size = game.size
  const x = i % size
  const y = Math.floor(i / size)
  let best = 99
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      if (game.board[yy * size + xx] === EMPTY) continue
      const d = Math.max(Math.abs(xx - x), Math.abs(yy - y))
      if (d < best) best = d
    }
  }
  return best
}

/** Heuristic score for placing at `i`. Higher is better. */
export function evaluateMove(game, i, color, rng = Math.random) {
  const size = game.size
  if (game.board[i] !== EMPTY) return null
  const eye = isEyeLike(game, i, color)
  const after = lightClone(game)
  const probe = play(after, i, color)
  if (!probe.ok) return null
  if (eye && probe.captured.length === 0) return { score: -30, eye: true, captured: 0 }

  const own = after.board
  const { x, y } = { x: i % size, y: Math.floor(i / size) }

  // liberties of the group we just created / joined
  let ownLibs = 0
  {
    const seen = new Set([i])
    const stack = [i]
    ownLibs = 0
    const libSet = new Set()
    while (stack.length) {
      const p = stack.pop()
      const px = p % size
      const py = Math.floor(p / size)
      const adj = []
      if (px > 0) adj.push(p - 1)
      if (px < size - 1) adj.push(p + 1)
      if (py > 0) adj.push(p - size)
      if (py < size - 1) adj.push(p + size)
      for (const q of adj) {
        if (own[q] === EMPTY) libSet.add(q)
        else if (own[q] === color && !seen.has(q)) {
          seen.add(q)
          stack.push(q)
        }
      }
    }
    ownLibs = libSet.size
  }

  let sc = 0
  sc += probe.captured.length * 14

  // rescuing a friendly group that was in atari
  const dirs = []
  if (x > 0) dirs.push(i - 1)
  if (x < size - 1) dirs.push(i + 1)
  if (y > 0) dirs.push(i - size)
  if (y < size - 1) dirs.push(i + size)
  for (const q of dirs) {
    if (game.board[q] !== color) continue
    const libsBefore = libertiesOf(game, q)
    if (libsBefore === 1 && ownLibs >= 2) sc += 16
    if (libsBefore === 1 && ownLibs === 1) sc += 2
  }
  // pushing an enemy group into atari
  for (const q of dirs) {
    if (own[q] !== other(color)) continue
    if (libertiesOf(after, q) === 1) sc += 6
  }
  if (ownLibs === 1 && probe.captured.length === 0) sc -= 18
  else if (ownLibs === 2) sc -= 2
  else if (ownLibs >= 4) sc += 2

  // shape / influence: stay near the action, prefer the third and fourth lines
  const near = neighbourStoneBonus(game, i)
  if (near === 1) sc += 1.5
  else if (near === 2) sc += 1.0
  else if (near > 4) sc -= 2.5
  if (size >= 13) {
    const line = Math.min(x, y, size - 1 - x, size - 1 - y)
    if (line === 0) sc -= 3
    else if (line === 1) sc -= 1.2
    else if (line === 2) sc += 0.6
    else if (line === 3) sc += 0.9
    const words = EDGE_WORDS[size] || []
    if (words.includes(x) && words.includes(y) && line === 3) sc += 1.2
  }
  sc += rng() * 1.4
  return { score: sc, eye: false, captured: probe.captured.length, liberties: ownLibs }
}

function libertiesOf(game, i) {
  const size = game.size
  const color = game.board[i]
  if (color === EMPTY) return 0
  const seen = new Set([i])
  const stack = [i]
  const libSet = new Set()
  while (stack.length) {
    const p = stack.pop()
    const px = p % size
    const py = Math.floor(p / size)
    const adj = []
    if (px > 0) adj.push(p - 1)
    if (px < size - 1) adj.push(p + 1)
    if (py > 0) adj.push(p - size)
    if (py < size - 1) adj.push(p + size)
    for (const q of adj) {
      const v = game.board[q]
      if (v === EMPTY) libSet.add(q)
      else if (v === color && !seen.has(q)) {
        seen.add(q)
        stack.push(q)
      }
    }
  }
  return libSet.size
}

// ----------------------------------------------------------------- playouts

/** One random game from the current position; returns the black-minus-white area margin. */
function playout(game, rng, maxMoves) {
  const g = lightClone(game)
  g.past = []
  let played = 0
  const limit = maxMoves || game.size * game.size * 2
  while (!g.over && played < limit) {
    const move = randomLegalNonEye(g, g.turn, rng, true)
    if (move < 0) {
      g.passes += 1
      g.turn = other(g.turn)
      if (g.passes >= 2) g.over = true
    } else {
      if (!play(g, move, g.turn).ok) break
    }
    played++
  }
  const s = score(g)
  return s.blackScore - s.whiteScore
}

// ------------------------------------------------------------------- public

/**
 * Estimate the score of the finished position and which stones are dead.
 * Returns { dead, owner, blackScore, whiteScore, winner, margin, playouts }.
 */
export function evaluatePosition(game, opts = {}) {
  const rng = rngFrom(opts.seed || 1)
  const budgetMs = opts.budgetMs || 1200
  const started = Date.now()
  const board = game.board
  const survival = new Int32Array(board.length)
  const blackOwn = new Int32Array(board.length)
  const whiteOwn = new Int32Array(board.length)
  let runs = 0
  let marginSum = 0

  while (runs < (opts.playouts || 40) && Date.now() - started < budgetMs) {
    const g = lightClone(game)
    let passes = 0
    let played = 0
    const limit = game.size * game.size * 2
    while (!g.over && played < limit) {
      const move = randomLegalNonEye(g, g.turn, rng, true)
      if (move < 0) {
        g.passes += 1
        g.turn = other(g.turn)
        if (g.passes >= 2) g.over = true
      } else {
        if (!play(g, move, g.turn).ok) break
      }
      played++
    }
    const s = score(g)
    marginSum += s.blackScore - s.whiteScore
    for (let i = 0; i < board.length; i++) {
      if (s.owner[i] === BLACK) blackOwn[i]++
      else if (s.owner[i] === WHITE) whiteOwn[i]++
    }
    for (let i = 0; i < board.length; i++) {
      if (board[i] !== EMPTY && g.board[i] === board[i]) survival[i]++
    }
    runs++
  }

  const dead = []
  const owner = new Int8Array(board.length)
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== EMPTY) {
      const alive = runs > 0 && survival[i] / runs >= 0.3
      if (!alive) {
        dead.push(i)
        owner[i] = other(board[i])
      } else {
        owner[i] = board[i]
      }
    } else if (runs > 0) {
      if (blackOwn[i] > whiteOwn[i] * 1.6) owner[i] = BLACK
      else if (whiteOwn[i] > blackOwn[i] * 1.6) owner[i] = WHITE
    }
  }

  const s = score(game, dead)
  return {
    ...s,
    dead,
    owner,
    playouts: runs,
    blackMargin: marginSum / Math.max(1, runs),
    elapsedMs: Date.now() - started,
  }
}

/**
 * Choose a move. Returns a board index, or -1 to pass.
 * opts: { level: 'easy'|'medium'|'hard', budgetMs, seed, maxCandidates }
 */
export function pickMove(game, opts = {}) {
  const level = opts.level || 'medium'
  const rng = rngFrom(opts.seed || (Date.now() & 0xffff))
  const color = game.turn
  if (game.over) return -1

  const empty = []
  for (let i = 0; i < game.board.length; i++) {
    if (game.board[i] === EMPTY && !isEyeLike(game, i, color)) empty.push(i)
  }
  if (empty.length === 0) return -1

  if (level === 'easy') {
    if (rng() < 0.15) {
      const scored = scoreAll(game, color, rng)
      if (scored.length) return scored[0].index
    }
    const move = randomLegalNonEye(game, color, rng, true)
    return move
  }

  const scored = scoreAll(game, color, rng)
  if (scored.length === 0) {
    const fallback = randomLegalNonEye(game, color, rng, true)
    return fallback
  }

  if (level !== 'hard') {
    // pass only when we are out of ideas and the position is settled
    if (scored[0].score < -8 && isSettled(game)) return -1
    return scored[0].index
  }

  const budgetMs = opts.budgetMs || 1500
  const started = Date.now()
  const candidates = scored.slice(0, opts.maxCandidates || 8)
  const perCandidate = Math.max(6, Math.floor((opts.playouts || 60) / candidates.length))
  let best = candidates[0]
  let bestRate = -Infinity

  for (const cand of candidates) {
    if (Date.now() - started > budgetMs && bestRate > -Infinity) break
    const g = lightClone(game)
    const r = play(g, cand.index, color)
    if (!r.ok) continue
    let wins = 0
    let runs = 0
    while (runs < perCandidate) {
      const margin = playout(g, rng, game.size * game.size * 2)
      const perspective = color === BLACK ? margin : -margin
      if (perspective > 0) wins += 1
      runs++
    }
    const rate = wins / runs + cand.score / 500
    if (rate > bestRate) {
      bestRate = rate
      best = cand
    }
  }
  if (bestRate === -Infinity) return scored[0].index
  return best.index
}

function scoreAll(game, color, rng) {
  const out = []
  for (let i = 0; i < game.board.length; i++) {
    if (game.board[i] !== EMPTY) continue
    const ev = evaluateMove(game, i, color, rng)
    if (ev) out.push({ index: i, score: ev.score, captured: ev.captured })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/** True when there is no plausible non-eye move left — a safe time to pass. */
function isSettled(game) {
  const color = game.turn
  let count = 0
  for (let i = 0; i < game.board.length; i++) {
    if (game.board[i] !== EMPTY) continue
    if (isEyeLike(game, i, color)) continue
    count++
    if (count > 12) return false
  }
  return true
}

/**
 * A short Chinese-language read of the position, built without a model. Used as
 * the local fallback when no LLM is configured, and as the prompt skeleton for
 * the LLM review.
 */
export function localSummary(game, dead = []) {
  const s = score(game, dead)
  const lead = s.winner === EMPTY ? '形勢接近' : s.winner === BLACK ? '黑方領先' : '白方領先'
  return {
    text:
      lead +
      '：黑 ' + s.blackScore + ' 目（含子），白 ' + s.whiteScore + ' 目（含 ' + s.komi + ' 貼目），' +
      '單官 ' + s.dame + ' 點，差距約 ' + s.margin + ' 目。',
    ...s,
  }
}
