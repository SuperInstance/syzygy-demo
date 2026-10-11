# syzygy-demo — watch an AI play a game by reading it

## The short version

This is a small 3D maze game (an ASCII raycaster — the world is drawn
entirely in text characters) being **played live by an AI that never sees
the game**. The AI receives only the screen, as a grid of letters. A
language model reads that grid and reports what it sees ("corridor open
ahead, something at column 25"). Scripted *strategy tiles* — old-fashioned
game AI, no learning involved — decide what to do with those reports.
You watch the screen it reads, the reports, and the decisions, and you can
**click a different strategy tile mid-game** to change how it plays:
Explorer sweeps room to room; Hunter centres whatever it spots and closes
in. The only learned component in the whole system is the seeing.

That separation is the point of the Syzygy program: if seeing is text, and
deciding is a script you can read, then the whole loop is inspectable —
every mistake can be traced to a misread or a bad rule, never to a black
box.

**Run it:** `npm install` once, then `node server.js`, open
**http://127.0.0.1:8734/**. Honest warning: each read takes the model
~9–15 seconds, so the play is deliberate, not fast — that latency is
measured and shown on the page, not hidden. Full detail, invariants, and
limits below.

---

# Syzygy — playable ASCII demo (v1)

An open-source ASCII raycaster, played live by a system with exactly **one**
learned component: a vision model that reads the game's character grid the
way a normal vision system reads pixels. Everything that decides what to do
is a **scripted strategy tile** — the classic game-AI pattern. A spectator
watches the ASCII view, clicks tiles to change how the system plays mid-game,
and reads a decision feed that shows seeing become doing.

```
buffer ──(agent channel: text grid ONLY)──► MiniMax ──► structured perception
                                                              │
strategy tile (scripted JS) ◄─────────────────────────────────┘
        │ decide(perception) -> one action
        ▼
synthetic key events ──► the game
```

## Run it

```sh
cd ~/workspace/syzygy-demo
npm install        # once (jsdom)
node server.js     # or: npm start
```

Open **http://127.0.0.1:8734/** (default `PORT=8734`, `HOST=0.0.0.0`).
The server is currently left running in the background on this machine
(log: `/tmp/syz-server.log`); stop it with `pkill -f "node server.js"`.

Environment knobs: `SYZ_GRID_COLS` / `SYZ_GRID_ROWS` (agent grid, default
96×44), `SYZ_TICK_MS` (minimum tick spacing, default 2000 — rarely binding,
see Limits), `SYZ_PERCEIVE_TIMEOUT_MS`, `SYZ_PERCEIVE_MAX_TOKENS`.

## What you see on the page

- **The grid** — exactly the character grid the model reads (live, refreshed
  continuously; the tick uses the current frame).
- **Strategy tiles** — click to switch mid-game. The switch cuts the current
  key hold, logs a `[sys]` line, and the *same* vision model keeps reading;
  only the script changed.
- **Decision feed** — every tick appends `[see]` (what the model perceived,
  with grid coordinates for each element) and `[decide]` (what the tile chose
  and why).
- **God view** — a top-down map with the player arrow and creature positions.
  This is ground truth from the DISPLAY channel, shown to the audience/scorer
  only. The agent never sees it (see Invariants).

## The invariants (the honesty of the demo)

1. **The agent sees only text.** Perception input is the game's character
   buffer, downsampled (see Limits). Game state — pose, map, sprite
   positions — is never passed to the model or to any tile. The vendored
   engine exposes two channels via the hook: `__syzAgentView()` (buffer only)
   and `__syzDisplayState()` (state, display only). `lib/perceive.js` and
   `lib/strategies/*` import nothing that touches the display channel; only
   `server.js`'s `/api/state` handler reads it, to serve the god view.
2. **The model perceives; it never acts.** The frozen prompt
   (`lib/prompt.txt`) asks MiniMax for structured perception only (elements
   with grid coordinates, corridor openness). It has no action vocabulary.
3. **All decisions are scripted.** Tiles are plain JS with a documented
   format (below). No learned planner anywhere.

## Strategy tiles

Drop a file in `lib/strategies/` exporting:

```js
module.exports = {
  id: 'my-tile',                 // unique, used by the API
  name: 'My Tile',
  description: 'Shown on the page.',
  createMemory() { return {}; },  // per-tile memory, survives switches
  decide(perception, memory) {    // perception = the model's JSON, nothing else
    return { action: 'forward', ms: 600, note: 'why, shown in the feed' };
  }
};
```

Actions: `forward | back | turnLeft | turnRight | strafeLeft | strafeRight |
engage | wait`. `engage` holds forward (see Limits: no fire button exists).
Shipped tiles: **Explorer** (systematic sweep, prefers unvisited directions,
sidesteps creatures) and **Hunter** (centers any perceived creature on the
grid, closes distance, engages at contact; sweeps/patrols when blind).

## Files

```
server.js               tick loop + HTTP API + page host
lib/gamehost.js         jsdom host for the engine; the two channels; key input
lib/downsample.js       raw buffer (320×~85) -> agent grid, salience-based,
                        derived from the buffer only
lib/perceive.js         MiniMax caller (perception only)
lib/prompt.txt          the frozen perception prompt
lib/strategies/*.js     the tiles
public/index.html       the spectator page
vendor/                 justMoritz/3d-game-engine (MIT, LICENSE included),
                        with ONE marked modification: the SYZYGY HOOK
                        (frame capture + the two channel accessors)
evidence/demo-page.png  screenshot of the running demo (tick #32)
```

## Honest limits (observed, 2026-10-11)

- **Cadence is ~9–15 s per tick, not 1–2 s.** MiniMax-Text-01 took 8.4–14 s
  per perception call on the 96×44 grid in every measurement; grid size
  (80×40 vs 96×44) barely mattered. The design target was a decision every
  1.5–2 s; the real demo reads at the model's speed. Actions (0.3–0.9 s)
  play out, then the agent waits for its next read. Nothing is faked to hide
  this — the page header shows the last read's latency.
- **The agent grid is a downsample** of the raw 320×~85 buffer
  (salience-based: dense/symbol glyphs win over faint shading). It is
  derived only from the buffer, but fine texture detail is lost.
- **The model misreads, observably.** Recurrent errors in the live feed:
  floor-texture glyph rows along the bottom of the view reported as small
  "creatures" standing on the floor; wall texture clusters occasionally
  reported as creatures; element coordinates are approximate (±several
  columns). Corridor open/blocked judgments were consistently right in the
  observed runs; creature detection was right when a sprite was actually
  centered and wrong mostly at the floor line.
- **There is no fire button in this engine.** Sprites (Pogels/Oberts) wander,
  block forward movement at contact range, and turn away when approached —
  so Hunter's "engage" is a contact pursuit that often becomes a chase. The
  feed says "ENGAGING to contact range"; a kill mechanic does not exist in
  v1's engine and none was invented.
- **Levels/sprites are the engine's own.** Level 1 with `autogen` sprites
  (17 per load, random placement), engine physics quirks included (sprites
  can bunch up; the player spawns facing a corridor).
- The engine's raw height is fractional (85.12 rows) — the hook reads whole
  rows; the agent grid is unaffected.

## Verification (done by the builder, 2026-10-11)

Server started headless; over 32+ ticks the feed accumulated sensible
`[see]`/`[decide]` pairs, the player crossed the map (god view: spawn
(14.5, 1.5) → deep in the maze), and switching Explorer → Hunter mid-game
changed the decisions immediately (Explorer: repeated `forward` on open
centers; Hunter: sweep turns, `turnLeft` to center a target at col 25, then
`forward` to close). Screenshot: `evidence/demo-page.png` (taken via
Playwright + Chromium with request interception — this sandbox's Chromium
blocks direct loopback navigation; the page and API data in the shot are the
real server responses).

## Credit

Game engine: **justMoritz/3d-game-engine** (MIT) —
https://github.com/justMoritz/3d-game-engine — vendored under `vendor/` with
attribution and the upstream LICENSE; the only change is the marked
SYZYGY HOOK. Part of the Syzygy program (see
`~/workspace/syzygy-program/DIRECTION-2026-10-11-arena-demo.md`).
