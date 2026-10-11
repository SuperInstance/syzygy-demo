'use strict';
/*
 * main.js — the playable Syzygy demo, entirely in the browser.
 *
 *   engine (vendored justMoritz, in this page)
 *     └─ __syzAgentView() ── AGENT CHANNEL: the character buffer ONLY
 *          → downsample → key-rack Worker (or BYO key) → MiniMax perception
 *          → strategy tile (scripted, in this page) → synthetic key events
 *     └─ __syzDisplayState() ── DISPLAY CHANNEL: page/scorer only (god view)
 *
 * Perception and tile code never touch the display channel. The display
 * channel is read in renderGod() only.
 *
 * Modes:
 *   live   — house MiniMax key on the Worker perceives each tick.
 *   byo    — visitor's own key (localStorage) passed through the Worker.
 *   replay — Worker eyes unavailable/resting: a recorded REAL session
 *            (live server, real MiniMax reads) plays back, clearly labeled.
 */
(function () {
  var GRID_COLS = 96, GRID_ROWS = 44;
  var MIN_TICK_MS = 2000;

  var KEYS = {
    forward: 87, back: 83, strafeLeft: 65, strafeRight: 68,
    turnLeft: 81, turnRight: 69, run: 16, jump: 32
  };
  var KEY_FOR_ACTION = {
    forward: 'forward', back: 'back', turnLeft: 'turnLeft', turnRight: 'turnRight',
    strafeLeft: 'strafeLeft', strafeRight: 'strafeRight', engage: 'forward', wait: null
  };

  /* ---------------- state ---------------- */
  var mode = 'boot';           // boot | live | byo | replay
  var engineStarted = false;
  var tickNo = 0;
  var feedSeq = 0;
  var cancelAction = false;
  var lastLatencyMs = null;
  var activeTileId = 'explorer';
  var tiles = {};
  Object.keys(window.SyzTiles).forEach(function (id) {
    var t = window.SyzTiles[id];
    tiles[id] = { id: t.id, name: t.name, description: t.description, decide: t.decide, memory: t.createMemory() };
  });
  var stats = { ticks: 0, perTile: {}, creaturesSeen: 0, switches: 0, summaries: [] };
  var judged = false;

  /* ---------------- dom ---------------- */
  function $(id) { return document.getElementById(id); }
  var viewEl, feedEl, tilesEl, statusEl, godEl, modeEl;

  function logFeed(kind, text) {
    var div = document.createElement('div');
    div.className = 'line';
    var tag = { see: '[see]', decide: '[decide]', system: '[sys]', judge: '[judge]' }[kind] || '[sys]';
    var span = document.createElement('span');
    span.className = 'tick';
    span.textContent = '#' + tickNo + ' ';
    var tagSpan = document.createElement('span');
    tagSpan.className = kind;
    tagSpan.textContent = tag + ' ';
    div.appendChild(span);
    div.appendChild(tagSpan);
    div.appendChild(document.createTextNode(text));
    feedEl.appendChild(div);
    while (feedEl.children.length > 300) feedEl.removeChild(feedEl.firstChild);
    feedEl.scrollTop = feedEl.scrollHeight;
    feedSeq++;
  }

  /* ---------------- engine keys ---------------- */
  function dispatchKey(type, code) {
    var ev = new KeyboardEvent(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'which', { value: code });
    Object.defineProperty(ev, 'keyCode', { value: code });
    window.dispatchEvent(ev);
  }
  function keyDown(name) { dispatchKey('keydown', KEYS[name]); }
  function keyUp(name) { dispatchKey('keyup', KEYS[name]); }
  function releaseAll() { Object.keys(KEYS).forEach(function (n) { try { keyUp(n); } catch (e) {} }); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function executeAction(action, ms) {
    var key = KEY_FOR_ACTION[action];
    if (!key) { await sleep(ms); return; }
    var STEP = 50, waited = 0;
    keyDown(key);
    try {
      while (waited < ms && !cancelAction) {
        await sleep(Math.min(STEP, ms - waited));
        waited += STEP;
      }
    } finally {
      keyUp(key);
    }
  }

  /* ---------------- engine ---------------- */
  function agentGridRows() {
    var view = window.gameEngineJS && window.gameEngineJS.__syzAgentView();
    if (!view || !view.rows || !view.rows.length) return null;
    return window.SyzDownsample(view.rows, GRID_COLS, GRID_ROWS);
  }

  function startEngine() {
    if (engineStarted) return;
    engineStarted = true;
    window.gameEngineJS.init();
  }

  async function waitForFirstFrame() {
    for (var i = 0; i < 150; i++) {
      try { if (agentGridRows()) return true; } catch (e) { /* not up */ }
      await sleep(100);
    }
    return false;
  }

  /* ---------------- god view (DISPLAY channel — page only) ---------------- */
  function arrowFor(a) {
    var arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
    var idx = Math.round(Math.atan2(Math.sin(a), Math.cos(a)) / (Math.PI / 4));
    return arrows[((idx % 8) + 8) % 8];
  }
  function renderGod() {
    if (mode === 'replay') { godEl.textContent = '— replay: god view was not recorded; the recording carries the agent view + feed only —'; return; }
    var god = null;
    try { god = window.gameEngineJS.__syzDisplayState(); } catch (e) { /* not up */ }
    if (!god || !god.map) { godEl.textContent = '…'; return; }
    var W = god.mapWidth, H = god.mapHeight;
    var cells = [];
    for (var y = 0; y < H; y++) cells.push(god.map.slice(y * W, (y + 1) * W).split(''));
    god.sprites.forEach(function (s) {
      var x = Math.floor(s.x), yy = Math.floor(s.y);
      if (yy >= 0 && yy < H && x >= 0 && x < W) cells[yy][x] = s.name || 'S';
    });
    var px = Math.floor(god.player.x), py = Math.floor(god.player.y);
    if (py >= 0 && py < H && px >= 0 && px < W) cells[py][px] = arrowFor(god.player.angle);
    godEl.textContent = 'level: ' + god.level + '   player ' + arrowFor(god.player.angle) +
      ' facing   P/O = creatures\n' + cells.map(function (r) { return r.join(''); }).join('\n');
  }

  function renderLoop() {
    if (mode !== 'replay' && engineStarted) {
      var rows = null;
      try { rows = agentGridRows(); } catch (e) { /* ignore */ }
      if (rows) viewEl.textContent = rows.join('\n');
    }
    renderGod();
    // the engine restyles <body> from level config; keep our theme
    if (document.body.style.background || document.body.style.color) {
      document.body.style.background = '';
      document.body.style.color = '';
    }
    statusEl.innerHTML = 'mode <b>' + mode.toUpperCase() + '</b> · tick <b>#' + tickNo + '</b> · last model read: <b>' +
      (lastLatencyMs ? (lastLatencyMs / 1000).toFixed(1) + 's' : '—') +
      '</b> · active tile: <b>' + activeTileId + '</b> · session <b>' + window.SyzPerceive.sessionId().slice(0, 8) + '…</b>';
  }

  /* ---------------- tiles UI ---------------- */
  function buildTiles() {
    tilesEl.innerHTML = '';
    Object.keys(tiles).forEach(function (id) {
      var t = tiles[id];
      var b = document.createElement('button');
      b.className = 'tile' + (id === activeTileId ? ' active' : '');
      b.innerHTML = '<div class="name"></div><div class="desc"></div>';
      b.querySelector('.name').textContent = t.name;
      b.querySelector('.desc').textContent = t.description;
      b.onclick = function () {
        if (mode === 'replay') {
          logFeed('system', 'tiles steer LIVE play. This is a recorded session — add your own MiniMax key in Settings (or wait for the house eyes) to play live.');
          return;
        }
        if (id !== activeTileId) {
          activeTileId = id;
          cancelAction = true;
          releaseAll();
          stats.switches++;
          logFeed('system', 'strategy switched -> ' + t.name + ' (vision model unchanged; only the script changed)');
          buildTiles();
        }
      };
      tilesEl.appendChild(b);
    });
  }

  /* ---------------- judge garnish (Typesafe/Jev via /judge) ---------------- */
  async function sessionVerdict(manual) {
    var per = Object.keys(stats.perTile).map(function (k) { return k + ' ' + stats.perTile[k] + ' ticks'; }).join(', ') || 'no ticks yet';
    var state = [
      'A visitor session of the Syzygy ASCII-game demo. Session id ' + window.SyzPerceive.sessionId() + '.',
      'Ticks played: ' + stats.ticks + ' (' + per + '). Strategy switches: ' + stats.switches + '.',
      'Creature sightings reported by the vision model: ' + stats.creaturesSeen + '.',
      'Recent perception summaries: ' + (stats.summaries.slice(-3).join(' / ') || 'none')
    ].join(' ');
    var question = {
      type: 'noul',
      instructions: 'Did this session\'s play show bold, exploratory behaviour?',
      criteria: {
        'true': 'the agent kept moving into new areas, approached what it perceived, and changed direction or strategy with purpose',
        'false': 'the agent stalled, scanned in place repeatedly, avoided everything it saw, or made no progress'
      }
    };
    try {
      var data = await window.SyzPerceive.judge(state, question);
      var ans = (data.answers && (data.answers.q || data.answers)) || {};
      var p = (typeof ans.probability === 'number') ? ans.probability
        : (typeof ans.confidence === 'number' ? ans.confidence : null);
      var verdict = (ans.answer === true || ans.value === true || (p !== null && p >= 0.5)) ? 'bold' : 'cautious';
      logFeed('judge', 'Jev on session ' + window.SyzPerceive.sessionId().slice(0, 8) + '…: reads this run as ' + verdict +
        (p !== null ? ' (p=' + p.toFixed(2) + ')' : '') + ' — judgment is a garnish here; the playing is done by tiles + text vision.');
      return true;
    } catch (e) {
      if (manual) {
        logFeed('judge', 'session verdict unavailable: ' + e.message + (e.code === 'provider_not_configured' ? ' (the judge\'s house key is not on the rack yet — a Typesafe key in Settings enables it)' : ''));
      }
      return false;
    }
  }

  /* ---------------- moth proof ---------------- */
  async function mothProbe() {
    try {
      var data = await window.SyzPerceive.mothEngines();
      var engines = (data && data.engines) || data || [];
      var list = Array.isArray(engines) ? engines : (engines.engines || []);
      var names = list.slice(0, 4).map(function (e) { return e.id || e.name || '?'; }).join(', ');
      logFeed('system', 'Moth Quantum /moth route is live: ' + list.length + ' engines reachable' + (names ? ' (' + names + (list.length > 4 ? ', …' : '') + ')' : '') + '.');
    } catch (e) {
      logFeed('system', 'Moth probe: ' + e.message + (e.code === 'provider_not_configured' ? ' (house Moth key not on the rack yet — a Moth key in Settings enables it)' : ''));
    }
  }

  /* ---------------- live tick loop ---------------- */
  async function tickLoop() {
    logFeed('system', 'engine live in your browser. Agent view ' + GRID_COLS + 'x' + GRID_ROWS +
      ' (downsampled from the raw buffer). Active tile: ' + tiles[activeTileId].name + '. Eyes: ' +
      (mode === 'byo' ? 'your own MiniMax key, passed through the rack' : 'the rack\'s house MiniMax key') + '.');
    for (;;) {
      var tickStart = Date.now();
      tickNo++;
      cancelAction = false;
      try {
        var grid = agentGridRows();              // AGENT CHANNEL ONLY
        if (!grid) { await sleep(500); continue; }

        var perception;
        try {
          perception = await window.SyzPerceive.perceive(grid);
          lastLatencyMs = perception.latencyMs;
        } catch (e) {
          if (e.code === 'provider_not_configured' || e.code === 'daily_cap') {
            logFeed('system', 'the demo\'s eyes are resting (' + e.message + ') — switching to a recorded real session.');
            enterReplay('eyes resting');
            return;
          }
          if (e.code === 'pacing') {
            await sleep(1500);
            continue;
          }
          logFeed('see', 'perception FAILED (' + e.message + ') — strategy holds position this tick');
          await sleep(800);
          continue;
        }

        stats.ticks++;
        stats.perTile[activeTileId] = (stats.perTile[activeTileId] || 0) + 1;
        stats.creaturesSeen += perception.elements.filter(function (x) { return x.kind === 'creature'; }).length;
        if (perception.summary) { stats.summaries.push(perception.summary); if (stats.summaries.length > 6) stats.summaries.shift(); }
        logFeed('see', window.SyzPerceive.describePerception(perception));

        var tile = tiles[activeTileId];
        var decision;
        try {
          decision = tile.decide(perception, tile.memory);
        } catch (e2) {
          logFeed('decide', tile.name + ': decide() threw (' + e2.message + ') — waiting');
          decision = { action: 'wait', ms: 400, note: 'tile error fallback' };
        }
        logFeed('decide', tile.name + ': ' + decision.action + ' ' + decision.ms + 'ms — ' + decision.note);
        await executeAction(decision.action, decision.ms);

        if (!judged && stats.ticks >= 5) { judged = true; sessionVerdict(false); }
      } catch (e) {
        logFeed('system', 'tick error: ' + e.message);
        await sleep(1000);
      }
      var elapsed = Date.now() - tickStart;
      if (elapsed < MIN_TICK_MS) await sleep(MIN_TICK_MS - elapsed);
    }
  }

  /* ---------------- replay ---------------- */
  var replayData = null;
  async function enterReplay(why) {
    if (mode === 'replay') return;
    mode = 'replay';
    modeEl.textContent = 'REPLAY — recorded real session (live eyes unavailable: ' + why + ')';
    modeEl.className = 'modebadge replay';
    releaseAll();
    if (!replayData) {
      try {
        var resp = await fetch('replay-session.json');
        replayData = await resp.json();
      } catch (e) {
        logFeed('system', 'replay recording failed to load: ' + e.message);
        return;
      }
    }
    logFeed('system', 'REPLAY of a real session recorded ' + (replayData.recordedAt || '') +
      ' from the live demo (real MiniMax reads, scripted tiles). Nothing here is simulated — it is a recording. Add your own MiniMax key in Settings to play live.');
    playReplay();
  }

  async function playReplay() {
    var samples = replayData.samples || [];
    var feed = replayData.feed || [];
    var shownSeq = 0;
    for (var round = 0; mode === 'replay'; round++) {
      for (var i = 0; i < samples.length && mode === 'replay'; i++) {
        var s = samples[i];
        tickNo = s.tick || tickNo;
        if (s.grid) viewEl.textContent = s.grid;
        feed.forEach(function (line) {
          if (line.seq > shownSeq && line.seq <= s.feedUpto) {
            tickNo = line.tick;
            logFeed(line.kind === 'see' ? 'see' : line.kind === 'decide' ? 'decide' : 'system', line.text);
          }
        });
        if (s.feedUpto > shownSeq) shownSeq = s.feedUpto;
        var next = samples[i + 1];
        var dt = next ? Math.min(4000, Math.max(400, (next.t - s.t) * 1000)) : 1500;
        await sleep(dt);
      }
      // loop the recording; reset the feed window marker but keep lines flowing
      shownSeq = 0;
      if (mode === 'replay') logFeed('system', '— recording loops —');
    }
  }

  /* ---------------- boot ---------------- */
  async function boot() {
    viewEl = $('view'); feedEl = $('feed'); tilesEl = $('tiles');
    statusEl = $('status'); godEl = $('god'); modeEl = $('modebadge');
    buildTiles();
    setInterval(renderLoop, 250);

    var byo = window.SyzPerceive.byoKey('minimax');
    var health = null;
    try { health = await window.SyzPerceive.probe(); } catch (e) { /* worker unreachable */ }

    if (byo) {
      mode = 'byo';
    } else if (health && health.providers && health.providers.minimax && health.providers.minimax.configured) {
      mode = 'live';
    }

    if (mode === 'live' || mode === 'byo') {
      modeEl.textContent = mode === 'byo' ? 'LIVE — your key' : 'LIVE — house eyes';
      modeEl.className = 'modebadge live';
      startEngine();
      var ok = await waitForFirstFrame();
      if (!ok) { logFeed('system', 'engine did not produce a frame in this browser.'); return; }
      tickLoop();
    } else {
      var why = !health ? 'the key-rack did not answer' : 'house MiniMax key not on the rack yet';
      await enterReplay(why);
      // still start the engine so the raw buffer box is alive for the curious
      try { startEngine(); } catch (e) { /* replay does not need it */ }
    }

    $('verdictBtn').addEventListener('click', function () { sessionVerdict(true); });
    $('mothBtn').addEventListener('click', mothProbe);
    $('goLiveBtn').addEventListener('click', async function () {
      if (mode !== 'replay') { logFeed('system', 'already live.'); return; }
      if (!window.SyzPerceive.byoKey('minimax')) {
        logFeed('system', 'add your MiniMax key in Settings first — it stays in this browser and is passed through the rack per call.');
        return;
      }
      mode = 'byo';
      modeEl.textContent = 'LIVE — your key';
      modeEl.className = 'modebadge live';
      startEngine();
      var ok = await waitForFirstFrame();
      if (!ok) { logFeed('system', 'engine did not produce a frame.'); return; }
      tickLoop();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
