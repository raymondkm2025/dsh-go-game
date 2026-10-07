// Shared helpers for the live test (kept out of the test body for readability).
import { play as enginePlay, pass as enginePass } from '../lib/engine.js'

/** Apply a move to the game; returns true when the engine accepted it. */
export function applyPlay(game, point, color) {
  if (point < 0) {
    const r = enginePass(game, color)
    return Boolean(r && r.ok !== false)
  }
  const r = enginePlay(game, point, color)
  return Boolean(r && r.ok)
}

export function validate() {
  return true
}
