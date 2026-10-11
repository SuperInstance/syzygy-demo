'use strict';
/*
 * server.js — Syzygy playable ASCII demo.
 *
 * One Node process:
 *   1. hosts the vendored justMoritz engine headless (lib/gamehost.js),
 *   2. runs the perception->decision tick loop:
 *        buffer --(agent channel only)--> downsample --> MiniMax (perception)
 *        perception --> active strategy tile (scripted) --> key events,
 *   3. serves the spectator page + a small JSON API.
 *
 * The perception and strategy code paths import ONLY the agent channel.
 * The display channel (pose/map/sprites) is read here, solely to serve the
 * page's clearly-labeled god view.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GameHost } = require('./lib/gamehost');
const { downsample } = require('./lib/downsample');
const { perceive } = require('./lib/perceive');

const PORT = parseInt(process.env.PORT || '8734', 10);
const HOST = process.env.HOST || '0.0.0.0';
const GRID_COLS = parseInt(process.env.SYZ_GRID_COLS || '96', 10);
const GRID_ROWS = parseInt(process.env.SYZ_GRID_ROWS || '44', 10);
const TICK_MS = parseInt(process.env.SYZ_TICK_MS || '2000', 10);

// ---- strategy tiles ---------------------------------------------------------
const tileDir = path.join(__dirname, 'lib', 'strategies');
const tiles = new Map();
for (const f of fs.readdirSync(tileDir).filter(f => f.endsWith('.js'))) {
  const tile = require(path.join(tileDir, f));
  tiles.set(tile.id, { ...tile, memory: tile.createMemory() });
}
if (!tiles.size) throw new Error('no strategy tiles found');
let activeTileId = tiles.has('explorer') ? 'explorer' : [...tiles.keys()][0];

// ---- runtime state ----------------------------------------------------------
const host = new GameHost();
const feed = [];           // {seq, t, tick, kind: 'see'|'decide'|'system', text}
let feedSeq = 0;
let tickNo = 0;
let lastPerception = null;
let lastLatencyMs = null;
let lastGridAt = null;     // grid snapshot used by the most recent tick
let cancelAction = false;  // set on tile switch to cut the current key hold

function logFeed(kind, text) {
  feed.push({ seq: ++feedSeq, t: new Date().toISOString(), tick: tickNo, kind, text });
  if (feed.length > 400) feed.splice(0, feed.length - 400);
  console.log(`[#${tickNo} ${kind}] ${text}`);
}

const KEY_FOR_ACTION = {
  forward: 'forward', back: 'back', turnLeft: 'turnLeft', turnRight: 'turnRight',
  strafeLeft: 'strafeLeft', strafeRight: 'strafeRight', engage: 'forward', wait: null
};

async function executeAction(action, ms) {
  const key = KEY_FOR_ACTION[action];
  if (!key) { await sleep(ms); return; }
  const STEP = 50;
  let waited = 0;
  host.keyDown(key);
  try {
    while (waited < ms && !cancelAction) {
      await sleep(Math.min(STEP, ms - waited));
      waited += STEP;
    }
  } finally {
    host.keyUp(key);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function describePerception(p) {
  const els = p.elements.map(e => `${e.kind}@(${e.col},${e.row}) ${e.size}${e.note ? ' — ' + e.note : ''}`);
  const corr = `corridors L:${p.corridors.left} C:${p.corridors.center} R:${p.corridors.right}`;
  return [p.summary, ...els, corr].filter(Boolean).join(' | ');
}

async function tickLoop() {
  await host.ready();
  logFeed('system', `engine live. Agent view ${GRID_COLS}x${GRID_ROWS} (downsampled from the raw buffer). Active tile: ${tiles.get(activeTileId).name}.`);
  for (;;) {
    const tickStart = Date.now();
    tickNo++;
    cancelAction = false;
    try {
      const rawRows = host.getAgentGrid();               // AGENT CHANNEL ONLY
      const grid = downsample(rawRows, GRID_COLS, GRID_ROWS);
      lastGridAt = grid;

      let perception;
      try {
        perception = await perceive(grid);
        lastLatencyMs = perception.latencyMs;
        lastPerception = perception;
        logFeed('see', describePerception(perception));
      } catch (e) {
        logFeed('see', `perception FAILED (${e.message}) — strategy holds position this tick`);
        await sleep(500);
        continue;
      }

      const tile = tiles.get(activeTileId);
      let decision;
      try {
        decision = tile.decide(perception, tile.memory);
      } catch (e) {
        logFeed('decide', `${tile.name}: decide() threw (${e.message}) — waiting`);
        decision = { action: 'wait', ms: 400, note: 'tile error fallback' };
      }
      logFeed('decide', `${tile.name}: ${decision.action} ${decision.ms}ms — ${decision.note}`);
      await executeAction(decision.action, decision.ms);
    } catch (e) {
      logFeed('system', 'tick error: ' + e.message);
      await sleep(1000);
    }
    const elapsed = Date.now() - tickStart;
    if (elapsed < TICK_MS) await sleep(TICK_MS - elapsed);
  }
}

// ---- HTTP -------------------------------------------------------------------
const pageHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function currentAgentGrid() {
  const raw = host.getAgentGrid();
  if (!raw) return null;
  return downsample(raw, GRID_COLS, GRID_ROWS).join('\n');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }
  if (url.pathname === '/api/state') {
    const display = host.getDisplayState(); // DISPLAY CHANNEL — page/scorer only
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      grid: currentAgentGrid(),
      gridAtTick: lastGridAt ? lastGridAt.join('\n') : null,
      tick: tickNo,
      lastLatencyMs,
      activeTile: activeTileId,
      tiles: [...tiles.values()].map(t => ({ id: t.id, name: t.name, description: t.description })),
      feed,
      god: display ? {
        level: display.level,
        map: display.map, mapWidth: display.mapWidth, mapHeight: display.mapHeight,
        player: display.player, sprites: display.sprites
      } : null
    }));
    return;
  }
  if (url.pathname === '/api/strategy' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body || '{}');
        if (!tiles.has(id)) throw new Error('unknown tile: ' + id);
        if (id !== activeTileId) {
          activeTileId = id;
          cancelAction = true;   // cut the current key hold: switch is LIVE
          host.releaseAll();
          logFeed('system', `strategy switched -> ${tiles.get(id).name} (vision model unchanged; only the script changed)`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, activeTile: activeTileId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`syzygy-demo listening on http://${HOST}:${PORT}`);
});
tickLoop().catch(e => { console.error('tick loop died:', e); process.exit(1); });
