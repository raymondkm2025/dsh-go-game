# dsh-go-game

圍棋 for the DeepSeek Harness. A full rules engine, a three-level AI partner,
a playout dead-stone estimator, optional LLM review, SGF save/load — surfaced
both as a DSH panel (`shell.overlay`) and as a standalone page at
`/dsh-go-game/`.

## What it does

**Rules (host half, pure JS).** 19×19 / 13×13 / 9×9, Chinese area scoring
(stones + surrounded empty points), configurable komi and handicap, capture by
liberty exhaustion, no suicide, simple ko (immediate recapture forbidden),
pass / two-pass end, resignation, unlimited undo, SGF import and export.
Dead-stone adjudication is explicit: both sides pass, dead stones are marked
(manually or by the estimator), then the area is counted.

**The AI.** Three levels, all run in the host process:

| level | how it plays |
| --- | --- |
| `easy` 入門 | random legal moves that avoid filling its own eyes |
| `medium` 中級 | greedy tactics: capture, rescue from atari, atari the opponent, shape/line preference |
| `hard` 進階 | the medium candidate list, each scored by light random playouts inside a wall-clock budget |

**Honest limit:** this is a practice partner, not an engine. On 19×19 even
`hard` is far below a human amateur; on 9×9 it plays a recognisable game.

**Dead-stone estimator.** `形勢判斷` runs random playouts (avoiding own-eye
fills) from the current position and reports which stones rarely survive, plus a
per-point ownership map the board renders as a translucent overlay. It is an
estimate, not an adjudication — correct anything it gets wrong with `標記死子`.

**LLM review (optional).** `覆盤` asks the harness `llm` service (no API keys in
this plugin) for a short Cantonese commentary plus a suggested move, which the
panel offers as a one-click play. Without a configured model it degrades to the
local scoring summary.

## Layout

| file | face | role |
| --- | --- | --- |
| `lib/engine.js` | shared | rules: board, capture, ko, score, SGF — no DOM, no DSH imports |
| `lib/ai.js` | host | heuristics, playout opponent, dead-stone estimator |
| `lib/gtp.js` | host | GTP bridge to an external neural-network engine (KataGo) |
| `lib/index.js` | host | sessions + every `/dsh-go-game/*` route, LLM review, SGF files |
| `lib/client.js` | web | the React panel registered in `shell.overlay` |
| `lib/page.html`, `lib/page.js` | web | the standalone page (a thin view over the same routes) |
| `cordis.patch.yml` | — | inserts the plugin row into the web profile roster |
| `test/*.test.mjs` | — | 98 cases: 26 engine, 11 AI, 22 host routes, 26 GTP, 13 engine fallback |
| `check-plugin.ps1` / `.cmd` | — | read-only install check |

No rules live in the browser: both views post intent and re-render the state the
host returns.

## Tests

```
node test/engine.test.mjs
node test/ai.test.mjs
node test/host.test.mjs
node test/gtp.test.mjs             # GTP bridge, driven by an injected fake engine
node test/engine-fallback.test.mjs # engine selected but absent -> built-in AI
node test/katago-live.mjs --root=<katago dir>   # real engine, skipped without --root
```

Run each file directly; `node --test` fails on this machine (the runner spawns a
piped child process and the sandbox rejects it). The host suite drives the real
routes through a mock webserver, mock `req`/`res` and a mock `llm`, so the whole
non-UI chain is covered offline.

## KataGo (optional neural-network opponent)

`lib/ai.js` is a heuristic/playout practice partner. For real strength,
`lib/gtp.js` drives an external KataGo process over GTP, **side by side** with the
built-in AI: the panel's `引擎` selector picks one per game, and a missing or
broken engine falls back to the built-in opponent automatically (the reason is
shown in the panel, not swallowed).

Layout it looks for (relative to the workspace, i.e. one level above the plugin):

```
katago/engine/katago.exe        Eigen (CPU) build, or any other backend
katago/engine/default_gtp.cfg   optional, ships with the release
katago/weights/*.bin.gz         one or more networks
```

Environment overrides:

| variable | default | meaning |
| --- | --- | --- |
| `DSH_GO_GAME_KATAGO_ROOT` | `<plugin>/../../katago` | engine + weights root |
| `DSH_GO_GAME_KATAGO_THREADS` | 4 | search threads (stay below the core count) |
| `DSH_GO_GAME_KATAGO_VISITS` | 250 | hard visit ceiling per move |
| `DSH_GO_GAME_KATAGO_TIME` | 8 | **seconds per move** — bounds CPU latency |
| `DSH_GO_GAME_KATAGO_TIMEOUT` | 90000 | GTP command timeout (ms) |

`GET /dsh-go-game/engine` reports availability, the network list and live status;
`POST /dsh-go-game/engine {model:"<file>"}` switches network, restarting the
process (KataGo loads exactly one network at startup).

Measured on this machine — i5-8250U, 4 threads, no GPU, b18c384 on the AVX2 Eigen
build: first move ≈ 11 s (it loads the 93 MB network), later moves ≈ 8 s with
`maxTime=8`. Because the search is time-bounded, slower hardware loses strength
rather than latency. Every query replays the game onto a clean engine board after
an explicit `clear_board`: KataGo does *not* wipe the stones on a same-size
`boardsize`, which otherwise surfaces as a spurious "illegal move".

## Install (three steps, outside DSH)

The agent sandbox cannot write outside the workspace, so profile registration is
a manual step — run these in a normal terminal:

1. In the active profile `package.json` (`%APPDATA%\dsh-desktop\harness\profiles\web`):
   add `"dsh-go-game": "link:C:/AppDev/DSH_WORKSPACE/dsh-go-game"` to
   `dependencies`, and append `"dsh-go-game"` to `dsh.profile.bundles`.
2. Point node_modules at the source directory (DSH does not run `pnpm install`
   on boot, and a missing link fails silently):

   ```
   mklink /J "%APPDATA%\dsh-desktop\harness\profiles\web\node_modules\dsh-go-game" "C:\AppDev\DSH_WORKSPACE\dsh-go-game"
   ```

3. Restart DSH.

`check-plugin.cmd` verifies all four links of the chain (package → registration →
node_modules → live route) at any point.

Routes are unauthenticated on loopback, matching the other local plugins:
`GET /dsh-go-game/status` answering JSON is the fastest proof of life.

## Notes and unverified parts

- Sessions live in host memory (12-hour idle sweep) and are keyed by a client id
  the panel/page generates; restarting DSH clears them. SGF files persist under
  `<workspace>/.dsh-go-game/games/`.
- The playout estimator is CPU-bound by design and budget-limited (default
  1500 ms, 40 playouts). It runs on the host so the panel never blocks.
- **Not yet verified on a live GUI**: the panel's rendering inside
  `shell.overlay`, its pointer-event behaviour, and the LLM review path against a
  real provider. The engine, AI and every route are covered by the offline
  suites.
