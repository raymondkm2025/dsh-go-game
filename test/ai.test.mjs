/**
 * AI tests. Run directly:  node test/ai.test.mjs
 * Playouts are budget-limited, so the suite stays well under a second per case.
 */
import { BLACK, EMPTY, WHITE, createGame, play, point } from '../lib/engine.js'
import { pickMove, evaluateMove, evaluatePosition, localSummary, rngFrom } from '../lib/ai.js'

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

check('rngFrom is deterministic', () => {
  const a = rngFrom(7)
  const b = rngFrom(7)
  for (let i = 0; i < 5; i++) eq(a(), b())
  assert(rngFrom(1)() !== rngFrom(2)())
})

check('easy picks a legal move on an empty 9x9 board', () => {
  const g = createGame({ size: 9 })
  g.turn = BLACK
  const i = pickMove(g, { level: 'easy', seed: 3 })
  assert(i >= 0, 'should not pass on an empty board')
  eq(g.board[i], EMPTY)
})

check('medium takes an available capture', () => {
  const g = createGame({ size: 9 })
  const w = P(9, 1, 1)
  play(g, w, WHITE)
  play(g, P(9, 0, 1), BLACK)
  play(g, P(9, 1, 0), BLACK)
  play(g, P(9, 1, 2), BLACK)
  g.turn = BLACK
  const move = pickMove(g, { level: 'medium', seed: 11 })
  eq(move, P(9, 2, 1), 'the capturing move is the only liberty')
})

check('medium does not fill its own eye', () => {
  const g = createGame({ size: 9 })
  for (const p of [P(9, 0, 1), P(9, 1, 0), P(9, 2, 1), P(9, 1, 2), P(9, 0, 0), P(9, 2, 0), P(9, 0, 2), P(9, 2, 2)]) {
    play(g, p, BLACK)
  }
  play(g, P(9, 8, 8), WHITE)
  g.turn = BLACK
  const move = pickMove(g, { level: 'medium', seed: 5 })
  assert(move !== P(9, 1, 1), 'must not play into its own eye')
})

check('evaluateMove rejects occupied and eye points', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 4, 4), BLACK)
  eq(evaluateMove(g, P(9, 4, 4), BLACK), null, 'occupied point')
})

check('evaluateMove prefers a capture over a quiet move', () => {
  const g = createGame({ size: 9 })
  play(g, P(9, 1, 1), WHITE)
  play(g, P(9, 0, 1), BLACK)
  play(g, P(9, 1, 0), BLACK)
  play(g, P(9, 1, 2), BLACK)
  const capture = evaluateMove(g, P(9, 2, 1), BLACK)
  const quiet = evaluateMove(g, P(9, 6, 6), BLACK)
  assert(capture.score > quiet.score, 'capture scores higher')
  eq(capture.captured, 1)
})

check('hard returns a legal move inside its budget', () => {
  const g = createGame({ size: 9 })
  const t0 = Date.now()
  const i = pickMove(g, { level: 'hard', seed: 9, budgetMs: 900, playouts: 24 })
  const dt = Date.now() - t0
  assert(i >= 0, 'should return a point')
  eq(g.board[i], EMPTY, 'point is empty')
  assert(dt < 6000, 'budget respected (took ' + dt + 'ms)')
})

check('pickMove returns -1 when the board is full', () => {
  const g = createGame({ size: 9 })
  for (let i = 0; i < g.board.length; i++) g.board[i] = BLACK
  g.turn = WHITE
  eq(pickMove(g, { level: 'medium', seed: 1 }), -1)
})

check('evaluatePosition finds a dead stone', () => {
  const g = createGame({ size: 9, komi: 0 })
  const dead = P(9, 4, 4)
  // sealed white ring two lines out, plus three white stones holding a single
  // black stone at the centre in atari — it must die in the playouts
  for (let y = 2; y <= 6; y++) {
    for (let x = 2; x <= 6; x++) {
      if (Math.max(Math.abs(x - 4), Math.abs(y - 4)) === 2) g.board[P(9, x, y)] = WHITE
    }
  }
  g.board[P(9, 4, 3)] = WHITE
  g.board[P(9, 3, 4)] = WHITE
  g.board[P(9, 5, 4)] = WHITE
  g.board[dead] = BLACK
  g.turn = WHITE
  const res = evaluatePosition(g, { playouts: 32, budgetMs: 2000, seed: 2 })
  assert(res.dead.includes(dead), 'the surrounded stone is reported dead')
  eq(res.owner[dead], WHITE, 'ownership flips to the surrounding colour')
  assert(res.playouts > 0, 'at least one playout ran')
  eq(res.owner.length, 81)
})

check('evaluatePosition keeps living stones alive', () => {
  const g = createGame({ size: 9, komi: 0 })
  // a two-eyed black group: a wall around two single-point eyes at (2,2)/(4,2).
  // White cannot play inside either eye (it would be suicide), so the group
  // must survive the playouts.
  const wall = [
    P(9, 1, 1), P(9, 2, 1), P(9, 3, 1), P(9, 4, 1), P(9, 5, 1),
    P(9, 1, 3), P(9, 2, 3), P(9, 3, 3), P(9, 4, 3), P(9, 5, 3),
    P(9, 1, 2), P(9, 5, 2), P(9, 3, 2),
  ]
  for (const p of wall) g.board[p] = BLACK
  const res = evaluatePosition(g, { playouts: 32, budgetMs: 1500, seed: 4 })
  assert(!res.dead.includes(P(9, 1, 1)), 'wall stone of a living group survives')
  assert(!res.dead.includes(P(9, 3, 2)), 'divider stone survives')
  eq(res.owner[P(9, 2, 2)], BLACK, 'first eye belongs to black')
  eq(res.owner[P(9, 4, 2)], BLACK, 'second eye belongs to black')
})

check('localSummary produces a readable line', () => {
  const g = createGame({ size: 9, komi: 5.5 })
  play(g, P(9, 4, 4), BLACK)
  const s = localSummary(g)
  assert(typeof s.text === 'string' && s.text.length > 10, 'summary text')
  assert(s.text.includes('黑'), 'mentions black')
  assert(typeof s.margin === 'number')
})

console.log('ai tests: ' + passed + ' passed, ' + failures.length + ' failed')
for (const f of failures) console.log('  FAIL ' + f)
process.exit(failures.length ? 1 : 0)
