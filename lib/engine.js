/**
 * dsh-go-game engine — a pure Go (圍棋/weiqi/baduk) rules engine.
 *
 * No DOM, no DSH imports, no I/O: this file is importable from a browser page,
 * from the DSH host half, and from plain Node tests.
 *
 * Rules implemented
 *   - 19x19 / 13x13 / 9x9 boards, configurable komi and handicap.
 *   - Alternating play, capture by liberty exhaustion, no suicide.
 *   - Simple ko (immediate recapture forbidden).
 *   - Pass / two-pass end of game / resignation.
 *   - Chinese area scoring (stones + surrounded empty points), with
 *     caller-supplied dead stones removed first.
 *   - Undo to any previous position, handicap placement, SGF export.
 *
 * Deliberately out of scope: superko, seki-aware life & death adjudication,
 * time limits. Dead stones must be marked before scoring; see `estimateDead`.
 */

export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2

export const STONE_NAME = { 1: 'black', 2: 'white' }

export function other(color) {
  return color === BLACK ? WHITE : BLACK
}

const GONU_COLUMNS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ' // human display: no I (Go convention)
const SGF_COLUMNS = 'abcdefghijklmnopqrs' // SGF wire format: straight a..s

const STARS = {
  9: [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]],
  13: [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]],
  19: [[3, 3], [9, 3], [15, 3], [3, 9], [9, 9], [15, 9], [3, 15], [9, 15], [15, 15]],
}

/** Corner/side offsets used for handicap placement, by board size. */
const HANDICAP_RINGS = {
  9: { corner: 2, side: 4, center: 4 },
  13: { corner: 3, side: 6, center: 6 },
  19: { corner: 3, side: 9, center: 9 },
}

export function starPoints(size) {
  return (STARS[size] || []).map((p) => ({ x: p[0], y: p[1] }))
}

export function isStar(size, x, y) {
  return (STARS[size] || []).some((p) => p[0] === x && p[1] === y)
}

// ---------------------------------------------------------------- geometry

const NEIGHBOUR_CACHE = new Map()

/** Neighbour index table for a board size: nbrs[i] = array of adjacent indices. */
export function neighbours(size) {
  let table = NEIGHBOUR_CACHE.get(size)
  if (table) return table
  table = new Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const out = []
      if (x > 0) out.push(i - 1)
      if (x < size - 1) out.push(i + 1)
      if (y > 0) out.push(i - size)
      if (y < size - 1) out.push(i + size)
      table[i] = out
    }
  }
  NEIGHBOUR_CACHE.set(size, table)
  return table
}

export function point(size, x, y) {
  return y * size + x
}

export function coords(size, i) {
  return { x: i % size, y: Math.floor(i / size) }
}

export function vertex(size, i) {
  if (i < 0) return 'pass'
  const { x, y } = coords(size, i)
  return GONU_COLUMNS[x] + String(size - y)
}

export function fromVertex(size, text) {
  const m = /^\s*([A-HJ-Ta-hj-t])\s*([0-9]{1,2})\s*$/.exec(String(text || ''))
  if (!m) return -1
  const x = GONU_COLUMNS.indexOf(m[1].toUpperCase())
  const num = Number(m[2])
  if (x < 0 || x >= size) return -1
  const y = size - num
  if (y < 0 || y >= size) return -1
  return point(size, x, y)
}

// ------------------------------------------------------------ group lookup

function groupOnBoard(board, nbrs, start) {
  const color = board[start]
  if (color === EMPTY) return null
  const stones = [start]
  const seen = new Set([start])
  const liberties = new Set()
  const stack = [start]
  while (stack.length) {
    const p = stack.pop()
    const adj = nbrs[p]
    for (let k = 0; k < adj.length; k++) {
      const q = adj[k]
      const v = board[q]
      if (v === EMPTY) liberties.add(q)
      else if (v === color && !seen.has(q)) {
        seen.add(q)
        stones.push(q)
        stack.push(q)
      }
    }
  }
  return { color, stones, liberties }
}

/** Group (stones + liberties) containing index `i`, or null when empty. */
export function groupAt(game, i) {
  return groupOnBoard(game.board, neighbours(game.size), i)
}

export function libertyCount(game, i) {
  const g = groupAt(game, i)
  return g ? g.liberties.size : 0
}

/** True when `i` is an eye-like point for `color` (safe to leave unfilled). */
export function isEyeLike(game, i, color) {
  const { size, board } = game
  if (board[i] !== EMPTY) return false
  const { x, y } = coords(size, i)
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dy] of dirs) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue // off-board is friendly
    if (board[point(size, nx, ny)] !== color) return false
  }
  let friendlyDiagonals = 0
  let hostileDiagonals = 0
  for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) {
      friendlyDiagonals++
      continue
    }
    const v = board[point(size, nx, ny)]
    if (v === color) friendlyDiagonals++
    else if (v === other(color)) hostileDiagonals++
  }
  return friendlyDiagonals >= 3 && hostileDiagonals === 0
}

// --------------------------------------------------------------- lifecycle

export function defaultKomi(size) {
  return size >= 13 ? 7.5 : 5.5
}

function handicapStones(size, count) {
  const ring = HANDICAP_RINGS[size] || HANDICAP_RINGS[19]
  const c = ring.corner
  const s = ring.side
  const m = ring.center
  const far = size - 1
  const last = size - 1 - ring.corner
  const corners = [
    [c, last],      // upper left
    [last, c],      // lower right
    [last, last],   // upper right
    [c, c],         // lower left
  ]
  const sides = [
    [c, s],         // left
    [last, s],      // right
    [s, c],         // bottom
    [s, last],      // top
  ]
  const centre = [[m, m]]
  const order = count >= 9
    ? [...corners, ...sides, ...centre]
    : count >= 8
      ? [...corners, ...sides]
      : count >= 6
        ? [...corners, sides[0], sides[1], ...(count >= 7 ? centre : [])]
        : count === 5
          ? [...corners, ...centre]
          : corners
  return order.slice(0, count).map(([x, y]) => point(size, x, y))
}

/**
 * Create a new game. Handicap stones are pre-placed for black; white moves
 * first when the handicap is 2 or more (Chinese handicap convention).
 */
export function createGame(opts = {}) {
  const size = Number(opts.size) || 19
  if (!STARS[size]) throw new Error('unsupported board size: ' + size)
  const handicap = Number(opts.handicap) || 0
  const game = {
    size,
    komi: opts.komi === undefined || opts.komi === null ? defaultKomi(size) : Number(opts.komi),
    rules: opts.rules || 'chinese',
    handicap,
    board: new Uint8Array(size * size),
    turn: BLACK,
    captures: { 1: 0, 2: 0 },
    moves: [],
    passes: 0,
    ko: -1,
    lastMove: -1,
    over: false,
    winner: null,
    endReason: null,
    past: [],
  }
  if (handicap >= 2) {
    for (const p of handicapStones(size, handicap)) game.board[p] = BLACK
    game.turn = WHITE
  }
  return game
}

export function cloneGame(game) {
  return {
    ...game,
    board: game.board.slice(),
    captures: { ...game.captures },
    moves: game.moves.map((m) => ({ ...m })),
    past: game.past.slice(),
  }
}

function snapshot(game) {
  return {
    board: game.board,
    turn: game.turn,
    captures: { ...game.captures },
    movesLength: game.moves.length,
    passes: game.passes,
    ko: game.ko,
    lastMove: game.lastMove,
    over: game.over,
    winner: game.winner,
    endReason: game.endReason,
  }
}

function restore(game, snap) {
  game.board = snap.board
  game.turn = snap.turn
  game.captures = snap.captures
  game.moves.length = snap.movesLength
  game.passes = snap.passes
  game.ko = snap.ko
  game.lastMove = snap.lastMove
  game.over = snap.over
  game.winner = snap.winner
  game.endReason = snap.endReason
}

// ------------------------------------------------------------------ moves

export function moveError(game, i, color = game.turn) {
  if (game.over) return 'game-over'
  if (!Number.isInteger(i) || i < 0 || i >= game.board.length) return 'off-board'
  if (game.board[i] !== EMPTY) return 'occupied'
  return null
}

/**
 * Play a stone. Returns { ok:true, captured, ko } or { ok:false, error }.
 * The engine is strict: nothing is mutated on a rejected move.
 */
export function play(game, i, color = game.turn) {
  const early = moveError(game, i, color)
  if (early) return { ok: false, error: early }

  const size = game.size
  const nbrs = neighbours(size)
  const board = game.board.slice()
  board[i] = color

  const captured = []
  const adj = nbrs[i]
  for (let k = 0; k < adj.length; k++) {
    const q = adj[k]
    if (board[q] !== other(color)) continue
    const grp = groupOnBoard(board, nbrs, q)
    if (grp && grp.liberties.size === 0) {
      for (const s of grp.stones) {
        board[s] = EMPTY
        captured.push(s)
      }
    }
  }

  const own = groupOnBoard(board, nbrs, i)
  if (!own || own.liberties.size === 0) return { ok: false, error: 'suicide' }

  const koCandidate =
    captured.length === 1 && own.stones.length === 1 && own.liberties.size === 1
      ? captured[0]
      : -1
  // Simple ko: after a ko-taking capture the opponent may not immediately
  // replay on the point that was just vacated.
  if (game.ko === i) return { ok: false, error: 'ko' }

  game.past.push(snapshot(game))
  game.board = board
  if (captured.length) game.captures[color] += captured.length
  game.moves.push({ color, point: i, captured: captured.slice() })
  game.lastMove = i
  game.ko = koCandidate
  game.passes = 0
  game.turn = other(color)
  return { ok: true, captured, ko: koCandidate }
}

export function pass(game, color = game.turn) {
  if (game.over) return { ok: false, error: 'game-over' }
  game.past.push(snapshot(game))
  game.moves.push({ color, point: -1, captured: [] })
  game.lastMove = -1
  game.ko = -1
  game.passes += 1
  game.turn = other(color)
  if (game.passes >= 2) {
    game.over = true
    game.endReason = 'two-passes'
  }
  return { ok: true, ended: game.over }
}

export function resign(game, color = game.turn) {
  if (game.over) return { ok: false, error: 'game-over' }
  game.past.push(snapshot(game))
  game.over = true
  game.winner = other(color)
  game.endReason = 'resign'
  return { ok: true, winner: game.winner }
}

export function undo(game, steps = 1) {
  let n = 0
  while (n < steps && game.past.length) {
    restore(game, game.past.pop())
    n++
  }
  return n
}

export function legalMoves(game, color = game.turn) {
  const out = []
  for (let i = 0; i < game.board.length; i++) {
    if (moveError(game, i, color)) continue
    const probe = play(cloneGame(game), i, color)
    if (probe.ok) out.push(i)
  }
  return out
}

// ----------------------------------------------------------------- scoring

/**
 * Chinese area scoring. `dead` is a list of indices whose stones are treated as
 * captured before counting (the normal end-of-game flow: both players pass,
 * dead stones are marked, then this is called).
 */
export function score(game, dead = []) {
  const size = game.size
  const board = game.board.slice()
  const deadSet = new Set(dead.map(Number).filter((i) => Number.isInteger(i) && i >= 0))
  for (const i of deadSet) {
    if (board[i] !== EMPTY) board[i] = EMPTY
  }

  const nbrs = neighbours(size)
  const seen = new Uint8Array(board.length)
  let black = 0
  let white = 0
  let dame = 0
  const owner = new Int8Array(board.length)

  for (let i = 0; i < board.length; i++) {
    if (board[i] === BLACK) {
      black++
      owner[i] = BLACK
      continue
    }
    if (board[i] === WHITE) {
      white++
      owner[i] = WHITE
      continue
    }
    if (seen[i]) continue
    const region = []
    const borders = new Set()
    const stack = [i]
    seen[i] = 1
    while (stack.length) {
      const p = stack.pop()
      region.push(p)
      for (const q of nbrs[p]) {
        const v = board[q]
        if (v === EMPTY) {
          if (!seen[q]) {
            seen[q] = 1
            stack.push(q)
          }
        } else {
          borders.add(v)
        }
      }
    }
    if (borders.size === 1) {
      const who = borders.has(BLACK) ? BLACK : WHITE
      if (who === BLACK) black += region.length
      else white += region.length
      for (const p of region) owner[p] = who
    } else {
      dame += region.length
    }
  }

  const blackScore = black
  const whiteScore = white + game.komi
  const diff = blackScore - whiteScore
  return {
    rules: 'chinese',
    blackArea: black,
    whiteArea: white,
    komi: game.komi,
    dame,
    blackScore,
    whiteScore,
    winner: diff > 0 ? BLACK : diff < 0 ? WHITE : EMPTY,
    winnerName: diff > 0 ? 'black' : diff < 0 ? 'white' : 'draw',
    margin: Math.abs(diff),
    dead: [...deadSet],
    owner,
  }
}

/** Score authority: engine result, or a resignation already recorded. */
export function result(game, dead = []) {
  if (game.endReason === 'resign') {
    return {
      rules: 'chinese',
      winner: game.winner,
      winnerName: game.winner === BLACK ? 'black' : game.winner === WHITE ? 'white' : 'draw',
      margin: null,
      reason: 'resign',
      dead: [],
      komi: game.komi,
      owner: new Int8Array(game.board.length),
    }
  }
  return { ...score(game, dead), reason: 'score' }
}

// -------------------------------------------------------------------- SGF

export function sgf(game, opts = {}) {
  const size = game.size
  const root = [
    'GM[1]',
    'FF[4]',
    'CA[UTF-8]',
    'AP[dsh-go-game:1.0]',
    'SZ[' + size + ']',
    'KM[' + game.komi + ']',
    'RU[Chinese]',
  ]
  if (game.handicap >= 2) {
    root.push('HA[' + game.handicap + ']')
    const stones = []
    for (let i = 0; i < game.board.length; i++) {
      if (game.board[i] === BLACK && game.moves.length === 0) {
        const { x, y } = coords(size, i)
        stones.push('[' + SGF_COLUMNS[x] + SGF_COLUMNS[y] + ']')
      }
    }
    if (stones.length) root.push('AB' + stones.join(''))
  }
  if (opts.black) root.push('PB[' + String(opts.black).replace(/[\]\\]/g, '') + ']')
  if (opts.white) root.push('PW[' + String(opts.white).replace(/[\]\\]/g, '') + ']')

  const body = game.moves.map((m) => {
    const tag = m.color === BLACK ? 'B' : 'W'
    if (m.point < 0) return ';' + tag + '[]'
    const { x, y } = coords(size, m.point)
    return ';' + tag + '[' + SGF_COLUMNS[x] + SGF_COLUMNS[y] + ']'
  })

  return '(;' + root.join('') + body.join('') + ')'
}

export function fromSGF(text) {
  const src = String(text || '')
  const sizeMatch = /SZ\[(\d+)\]/.exec(src)
  const komiMatch = /KM\[([-0-9.]+)\]/.exec(src)
  const haMatch = /HA\[(\d+)\]/.exec(src)
  const game = createGame({
    size: sizeMatch ? Number(sizeMatch[1]) : 19,
    komi: komiMatch ? Number(komiMatch[1]) : undefined,
    handicap: haMatch ? Number(haMatch[1]) : 0,
  })
  const ab = /AB((?:\[[a-s]{2}\])+)/.exec(src)
  if (ab) {
    const re = /\[([a-s])([a-s])\]/g
    let m
    while ((m = re.exec(ab[1]))) {
      const x = SGF_COLUMNS.indexOf(m[1].toLowerCase())
      const y = SGF_COLUMNS.indexOf(m[2].toLowerCase())
      if (x >= 0 && y >= 0) game.board[point(game.size, x, y)] = BLACK
    }
  }
  const moveRe = /;\s*([BW])\[([a-s]{0,2})\]/g
  let mm
  while ((mm = moveRe.exec(src))) {
    const color = mm[1] === 'B' ? BLACK : WHITE
    const body = mm[2]
    if (!body) {
      pass(game, color)
      continue
    }
    const x = SGF_COLUMNS.indexOf(body[0].toLowerCase())
    const y = SGF_COLUMNS.indexOf(body[1].toLowerCase())
    if (x < 0 || y < 0) continue
    play(game, point(game.size, x, y), color)
  }
  return game
}

// ------------------------------------------------------------ plain summary

/** Compact, serialisable position summary — the shape the UI and routes use. */
export function summarise(game, dead = []) {
  return {
    size: game.size,
    komi: game.komi,
    handicap: game.handicap,
    turn: game.turn,
    turnName: game.turn === BLACK ? 'black' : 'white',
    captures: { black: game.captures[BLACK], white: game.captures[WHITE] },
    moveCount: game.moves.length,
    passes: game.passes,
    ko: game.ko,
    lastMove: game.lastMove,
    over: game.over,
    winner: game.winner,
    endReason: game.endReason,
    canUndo: game.past.length > 0,
    board: Array.from(game.board),
    result: game.over ? result(game, dead) : null,
  }
}
