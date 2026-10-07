/**
 * Engine tests. Run directly:  node test/engine.test.mjs
 * (Not `node --test`: the test runner pipes through a child process and the
 * sandbox rejects the spawn on this machine.)
 */
import {
  BLACK,
  EMPTY,
  WHITE,
  createGame,
  play,
  pass,
  resign,
  undo,
  score,
  result,
  sgf,
  fromSGF,
  point,
  coords,
  vertex,
  fromVertex,
  isEyeLike,
  groupAt,
  cloneGame,
  legalMoves,
  defaultKomi,
} from '../lib/engine.js'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(name + ' — ' + (err && err.message ? err.message : String(err)))
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed')
}

function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': ' + String(a) + ' !== ' + String(b))
}

const P = (size, x, y) => point(size, x, y)

// ------------------------------------------------------------ coordinates

check('vertex round-trips on 19x19', () => {
  const g = createGame({ size: 19 })
  eq(vertex(19, P(19, 3, 3)), 'D16')
  eq(fromVertex(19, 'D16'), P(19, 3, 3))
  eq(fromVertex(19, 'pass'), -1)
  eq(fromVertex(19, 'ZZ'), -1)
  eq(vertex(9, P(9, 0, 8)), 'A1')
})

check('coords mirrors point', () => {
  const i = P(13, 5, 7)
  const c = coords(13, i)
  eq(c.x, 5)
  eq(c.y, 7)
})

// ---------------------------------------------------------------- capture

check('a single stone with no liberties is captured', () => {
  const g = createGame({ size: 9 })
  const w = P(9, 1, 1)
  play(g, w, WHITE)
  play(g, P(9, 1, 0), BLACK)
  play(g, P(9, 0, 1), BLACK)
  play(g, P(9, 1, 2), BLACK)
  const r = play(g, P(9, 2, 1), BLACK)
  assert(r.ok, 'capture move should be legal')
  eq(g.board[w], EMPTY, 'white stone removed')
  eq(g.captures[BLACK], 1)
  eq(r.captured.length, 1)
})

check('a two-stone group is captured together', () => {
  const g = createGame({ size: 9 })
  const w1 = P(9, 1, 1)
  const w2 = P(9, 2, 1)
  play(g, w1, WHITE)
  play(g, w2, WHITE)
  const ring = [P(9, 0, 1), P(9, 1, 0), P(9, 2, 0), P(9, 3, 1), P(9, 2, 2), P(9, 1, 2)]
  for (const p of ring) {
    const r = play(g, p, BLACK)
    assert(r.ok, 'ring stone legal at ' + p)
  }
  eq(g.board[w1], EMPTY)
  eq(g.board[w2], EMPTY)
  eq(g.captures[BLACK], 2)
})

check('suicide is rejected and mutates nothing', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 1, 0), WHITE)
  play(g, P(9, 0, 1), WHITE)
  const before = Array.from(g.board)
  const r = play(g, P(9, 0, 0), BLACK)
  assert(!r.ok, 'suicide must fail')
  eq(r.error, 'suicide')
  eq(Array.from(g.board).join(','), before.join(','), 'board unchanged')
})

check('playing on an occupied point fails', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 4, 4), BLACK)
  const r = play(g, P(9, 4, 4), WHITE)
  assert(!r.ok)
  eq(r.error, 'occupied')
})

check('capturing the last liberty of a big group counts every stone', () => {
  const g = createGame({ size: 9 })
  const stones = [P(9, 2, 2), P(9, 3, 2), P(9, 2, 3), P(9, 3, 3)]
  for (const s of stones) play(g, s, WHITE)
  const ring = []
  for (let x = 1; x <= 4; x++) {
    ring.push(P(9, x, 1))
    ring.push(P(9, x, 4))
  }
  ring.push(P(9, 1, 2), P(9, 1, 3), P(9, 4, 2), P(9, 4, 3))
  for (const p of ring) play(g, p, BLACK)
  eq(g.board[P(9, 4, 3)], BLACK, 'last liberty filled by black')
  eq(g.captures[BLACK], 4)
})

// --------------------------------------------------------------------- ko

check('simple ko: immediate recapture is illegal', () => {
  const g = createGame({ size: 9 })
  // Black Q=(1,1) has one liberty at P=(1,2); P is held to a single liberty by
  // black stones at (0,2), (2,2) and (1,3) — the classic ko shape.
  play(g, P(9, 1, 1), BLACK) // Q
  play(g, P(9, 0, 2), BLACK)
  play(g, P(9, 2, 2), BLACK)
  play(g, P(9, 1, 3), BLACK)
  play(g, P(9, 0, 1), WHITE)
  play(g, P(9, 2, 1), WHITE)
  play(g, P(9, 1, 0), WHITE)
  play(g, P(9, 1, 2), WHITE) // P — captures Q
  eq(g.board[P(9, 1, 1)], EMPTY, 'black ko stone captured')
  eq(g.captures[WHITE], 1)
  eq(g.ko, P(9, 1, 1), 'ko point recorded')
  const bad = play(g, P(9, 1, 1), BLACK)
  assert(!bad.ok, 'immediate recapture must fail')
  eq(bad.error, 'ko')

  // a move elsewhere clears the ko ban
  const elsewhere = play(g, P(9, 8, 8), BLACK)
  assert(elsewhere.ok)
  const recapture = play(g, P(9, 1, 1), BLACK)
  assert(recapture.ok, 'recapture legal after a ko threat interlude')
  eq(g.board[P(9, 1, 2)], EMPTY, 'white ko stone captured')
})

check('ko is not declared when the capturing stone keeps two liberties', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 1, 1), WHITE)
  play(g, P(9, 0, 1), BLACK)
  play(g, P(9, 1, 0), BLACK)
  play(g, P(9, 1, 2), BLACK)
  const r = play(g, P(9, 2, 1), BLACK)
  assert(r.ok && r.captured.length === 1)
  eq(g.ko, -1, 'no ko point')
})

// --------------------------------------------------------------- pass/undo

check('two passes end the game', () => {
  const g = createGame({ size: 9 })
  pass(g, BLACK)
  assert(!g.over, 'one pass does not end the game')
  pass(g, WHITE)
  assert(g.over, 'two passes end the game')
  eq(g.endReason, 'two-passes')
})

check('resignation hands the win to the opponent', () => {
  const g = createGame({ size: 9 })
  resign(g, BLACK)
  eq(g.winner, WHITE)
  eq(result(g).reason, 'resign')
})

check('undo restores the previous position exactly', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 4, 4), BLACK)
  const snapshot = Array.from(g.board).join(',')
  const snapshotTurn = g.turn
  play(g, P(9, 3, 3), WHITE)
  undo(g, 1)
  eq(Array.from(g.board).join(','), snapshot)
  eq(g.turn, snapshotTurn)
  eq(g.moves.length, 1)
  undo(g, 5)
  eq(g.moves.length, 0)
  assert(g.board.every((v) => v === EMPTY), 'board cleared by full undo')
})

// ------------------------------------------------------------------ scoring

check('an empty board is all dame', () => {
  const g = createGame({ size: 9, komi: 5.5 })
  const s = score(g)
  eq(s.blackArea, 0)
  eq(s.whiteArea, 0)
  eq(s.dame, 81)
  eq(s.winner, WHITE, 'komi alone puts white ahead')
  const even = createGame({ size: 9, komi: 0 })
  eq(score(even).winner, EMPTY, 'with no komi an empty board is a draw')
})

check('a lone stone takes the whole board under area scoring', () => {
  const g = createGame({ size: 9, komi: 5.5 })
  play(g, P(9, 4, 4), BLACK)
  const s = score(g)
  eq(s.blackArea, 81)
  eq(s.whiteArea, 0)
  eq(s.dame, 0)
  eq(s.winner, BLACK)
})

check('a split board scores each side', () => {
  const g = createGame({ size: 9, komi: 5.5 })
  for (let y = 0; y < 9; y++) play(g, P(9, 4, y), BLACK)
  for (let y = 0; y < 9; y++) play(g, P(9, 5, y), WHITE)
  const s = score(g)
  eq(s.dame, 0)
  eq(s.blackArea, 45, '4 columns + 9 stones')
  eq(s.whiteArea, 36, '3 columns + 9 stones')
  eq(s.whiteScore, 41.5)
  eq(s.winner, BLACK)
  eq(s.margin, 3.5)
})

check('dead stones are removed before counting', () => {
  const g = createGame({ size: 9, komi: 0 })
  const dead = P(9, 4, 4)
  // a sealed white ring two lines out from the centre (16 stones)
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) {
      if (Math.max(Math.abs(x - 4), Math.abs(y - 4)) === 2) play(g, P(9, x, y), WHITE)
    }
  }
  // the lone black stone cannot be played there legally, so it is placed
  // directly — this is the "both players passed, dead stones remain" position
  g.board[dead] = BLACK
  const alive = score(g)
  eq(alive.blackArea, 1, 'stone counted while it sits on the board')
  eq(alive.whiteArea, 72, 'the ring plus everything outside it')
  eq(alive.dame, 8, 'the contested interior')
  const s = score(g, [dead])
  eq(s.blackArea, 0, 'dead black stone not counted')
  eq(s.whiteArea, 81, 'the whole board falls to white')
  assert(s.owner[dead] === WHITE, 'dead point belongs to the surrounding colour')
  eq(s.winner, WHITE)
})

check('komi default follows board size', () => {
  eq(defaultKomi(19), 7.5)
  eq(defaultKomi(13), 7.5)
  eq(defaultKomi(9), 5.5)
})

// ---------------------------------------------------------------- handicap

check('handicap stones are pre-placed and white moves first', () => {
  const g = createGame({ size: 9, handicap: 4 })
  eq(g.turn, WHITE)
  let black = 0
  for (const v of g.board) if (v === BLACK) black++
  eq(black, 4)
  for (const [x, y] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
    eq(g.board[P(9, x, y)], BLACK, 'corner star at ' + x + ',' + y)
  }
})

check('handicap 2 also flips the turn but places 2 stones', () => {
  const g = createGame({ size: 19, handicap: 2 })
  eq(g.turn, WHITE)
  let black = 0
  for (const v of g.board) if (v === BLACK) black++
  eq(black, 2)
})

// ------------------------------------------------------------------- eyes

check('a surrounded point is an eye for its colour', () => {
  const g = createGame({ size: 9 })
  for (const p of [P(9, 0, 1), P(9, 1, 0), P(9, 2, 1), P(9, 1, 2), P(9, 0, 0), P(9, 2, 0), P(9, 0, 2), P(9, 2, 2)]) {
    play(g, p, BLACK)
  }
  assert(isEyeLike(g, P(9, 1, 1), BLACK), 'centre point is a black eye')
  assert(!isEyeLike(g, P(9, 1, 1), WHITE), 'not a white eye')
})

// --------------------------------------------------------------------- SGF

check('SGF round-trips a game', () => {
  const g = createGame({ size: 9, komi: 6.5 })
  play(g, P(9, 2, 2), BLACK)
  play(g, P(9, 6, 6), WHITE)
  play(g, P(9, 2, 6), BLACK)
  pass(g, WHITE)
  const text = sgf(g, { black: 'Black', white: 'White' })
  assert(text.startsWith('(;GM[1]'), 'SGF root')
  assert(text.includes('SZ[9]'))
  const back = fromSGF(text)
  eq(back.size, 9)
  eq(back.komi, 6.5)
  eq(back.moves.length, 4)
  eq(Array.from(back.board).join(','), Array.from(g.board).join(','))
  eq(back.board[P(9, 2, 2)], BLACK)
})

check('SGF escape and handicap root', () => {
  const g = createGame({ size: 9, handicap: 3 })
  const text = sgf(g)
  assert(text.includes('HA[3]'), 'handicap property')
  assert(text.includes('AB'), 'handicap stones in AB')
})

// -------------------------------------------------------------- clones etc.

check('cloneGame is independent', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 4, 4), BLACK)
  const c = cloneGame(g)
  play(c, P(9, 5, 5), WHITE)
  eq(g.moves.length, 1)
  eq(c.moves.length, 2)
  eq(g.board[P(9, 5, 5)], EMPTY)
})

check('legalMoves excludes occupied, suicide and ko points', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 1, 0), WHITE)
  play(g, P(9, 0, 1), WHITE)
  g.turn = BLACK
  const moves = legalMoves(g, BLACK)
  assert(!moves.includes(P(9, 0, 0)), 'suicide point excluded')
  assert(moves.includes(P(9, 4, 4)), 'normal point included')
  eq(moves.length, 81 - 2 - 1)
})

check('groupAt reports stones and liberties', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 1, 1), BLACK)
  play(g, P(9, 2, 1), BLACK)
  const grp = groupAt(g, P(9, 1, 1))
  eq(grp.stones.length, 2)
  eq(grp.liberties.size, 6)
})

check('board sizes are validated', () => {
  let threw = false
  try {
    createGame({ size: 11 })
  } catch (err) {
    threw = true
  }
  assert(threw, 'size 11 must be rejected')
})

// ------------------------------------------------------------------ report

console.log('engine tests: ' + passed + ' passed, ' + failures.length + ' failed')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
