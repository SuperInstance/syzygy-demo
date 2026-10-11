'use strict';
/*
 * perceive.js (browser) — the ONLY place a model is consulted, and it is
 * consulted about perception only. The browser never builds prompt text and
 * never holds a house credential: it POSTs the downsampled character grid
 * (and nothing else — no pose, no map, no sprite data) plus the frozen
 * prompt id to the key-rack Worker, which holds the provider keys as
 * secrets and assembles the frozen prompt server-side.
 *
 * A visitor may instead supply their OWN provider key (stored only in this
 * browser's localStorage). The key is sent to the Worker as a one-call
 * pass-through header: the Worker uses it for that single provider call,
 * never stores it, never logs it, and house caps do not apply.
 */
(function () {
  var PROMPT_ID = 'frozen-v1';

  /* Session id: lightweight, per-visit, no account. Kept in sessionStorage;
   * sent with Worker calls so a session's judgment battery is its own. */
  function sessionId() {
    var k = 'syz-session-id';
    var v = null;
    try { v = sessionStorage.getItem(k); } catch (e) { /* private mode */ }
    if (!v) {
      v = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }
    return v;
  }

  function byoKey(provider) {
    try { return localStorage.getItem('syz-byo-' + provider) || ''; } catch (e) { return ''; }
  }
  function setByoKey(provider, key) {
    try {
      if (key) localStorage.setItem('syz-byo-' + provider, key);
      else localStorage.removeItem('syz-byo-' + provider);
    } catch (e) { /* ignore */ }
  }

  /* parsePerception — identical validation to lib/perceive.js (server). */
  function parsePerception(raw, gridRows) {
    var rows = gridRows.length, cols = gridRows[0].length;
    var text = String(raw).trim();
    text = text.replace(/```(?:json)?/gi, '');
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object in model output');
    var obj = JSON.parse(text.slice(start, end + 1));

    function clamp(v, max) { return Math.max(0, Math.min(max, Math.round(Number(v) || 0))); }
    var kinds = ['creature', 'wall', 'opening', 'item', 'unknown'];
    var sizes = ['small', 'medium', 'large'];
    var elements = (Array.isArray(obj.elements) ? obj.elements : []).slice(0, 12).map(function (e) {
      return {
        kind: kinds.includes(e.kind) ? e.kind : 'unknown',
        col: clamp(e.col, cols - 1),
        row: clamp(e.row, rows - 1),
        size: sizes.includes(e.size) ? e.size : 'medium',
        note: String(e.note || '').slice(0, 80)
      };
    });
    function corr(v) { return (v === 'open' || v === 'blocked' || v === 'unclear') ? v : 'unclear'; }
    var corridors = {
      left: corr(obj.corridors && obj.corridors.left),
      center: corr(obj.corridors && obj.corridors.center),
      right: corr(obj.corridors && obj.corridors.right)
    };
    var free = (Array.isArray(obj.free_directions) ? obj.free_directions : [])
      .filter(function (d) { return d === 'left' || d === 'center' || d === 'right'; });
    return {
      summary: String(obj.summary || '').slice(0, 200),
      elements: elements,
      corridors: corridors,
      free_directions: Array.from(new Set(free)),
      gridCols: cols,
      gridRows: rows
    };
  }

  function describePerception(p) {
    var els = p.elements.map(function (e) {
      return e.kind + '@(' + e.col + ',' + e.row + ') ' + e.size + (e.note ? ' — ' + e.note : '');
    });
    var corr = 'corridors L:' + p.corridors.left + ' C:' + p.corridors.center + ' R:' + p.corridors.right;
    return [p.summary].concat(els, [corr]).filter(Boolean).join(' | ');
  }

  function workerBase() {
    var u = '';
    try { u = localStorage.getItem('syz-worker-url') || ''; } catch (e) { /* ignore */ }
    return (u || window.SYZ_WORKER_DEFAULT || '').replace(/\/+$/, '');
  }

  async function workerFetch(path, body, byoHeader) {
    var base = workerBase();
    if (!base) throw Object.assign(new Error('no worker url configured'), { code: 'no_worker' });
    var headers = { 'Content-Type': 'application/json' };
    if (byoHeader) headers[byoHeader.name] = byoHeader.value;
    var resp = await fetch(base + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });
    var data = null;
    try { data = await resp.json(); } catch (e) { /* non-JSON */ }
    if (!resp.ok) {
      var err = new Error((data && (data.message || data.error)) || ('worker HTTP ' + resp.status));
      err.code = (data && data.error) || 'worker_error';
      err.status = resp.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* Health probe: which house providers are configured, caps, today's use. */
  async function probe() {
    var base = workerBase();
    if (!base) return null;
    var resp = await fetch(base + '/health');
    if (!resp.ok) throw new Error('worker health HTTP ' + resp.status);
    return resp.json();
  }

  /* One perception round-trip through the Worker. Returns a perception
   * object (parsed + validated here, same parser as the local server). */
  async function perceive(gridRows) {
    var t0 = Date.now();
    var key = byoKey('minimax');
    var data = await workerFetch('/perceive',
      { promptId: PROMPT_ID, grid: gridRows, session: sessionId() },
      key ? { name: 'x-syz-byo-minimax', value: key } : null);
    var perception = parsePerception(data.raw, gridRows);
    perception.latencyMs = Date.now() - t0;
    perception.mode = data.mode || 'house';
    return perception;
  }

  /* Typesafe/Jev session judgment via the Worker (/judge). */
  async function judge(state, question) {
    var key = byoKey('typesafe');
    return workerFetch('/judge',
      { session: sessionId(), state: state, question: question },
      key ? { name: 'x-syz-byo-typesafe', value: key } : null);
  }

  /* Moth Quantum via the Worker (/moth). Submit (+short poll) and status. */
  async function mothSubmit(engineId, params) {
    var key = byoKey('moth');
    return workerFetch('/moth',
      { session: sessionId(), engine_id: engineId, params: params || {} },
      key ? { name: 'x-syz-byo-moth', value: key } : null);
  }
  async function mothStatus(jobId) {
    var base = workerBase();
    if (!base) throw Object.assign(new Error('no worker url configured'), { code: 'no_worker' });
    var key = byoKey('moth');
    var headers = {};
    if (key) headers['x-syz-byo-moth'] = key;
    var resp = await fetch(base + '/moth/status?job=' + encodeURIComponent(jobId), { headers: headers });
    var data = null;
    try { data = await resp.json(); } catch (e) { /* ignore */ }
    if (!resp.ok) {
      var err = new Error((data && (data.message || data.error)) || ('worker HTTP ' + resp.status));
      err.code = (data && data.error) || 'worker_error';
      err.status = resp.status;
      throw err;
    }
    return data;
  }
  async function mothEngines() {
    var base = workerBase();
    if (!base) throw Object.assign(new Error('no worker url configured'), { code: 'no_worker' });
    var key = byoKey('moth');
    var headers = {};
    if (key) headers['x-syz-byo-moth'] = key;
    var resp = await fetch(base + '/moth/engines', { headers: headers });
    var data = null;
    try { data = await resp.json(); } catch (e) { /* ignore */ }
    if (!resp.ok) {
      var err = new Error((data && (data.message || data.error)) || ('worker HTTP ' + resp.status));
      err.code = (data && data.error) || 'worker_error';
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  window.SyzPerceive = {
    PROMPT_ID: PROMPT_ID,
    sessionId: sessionId,
    byoKey: byoKey,
    setByoKey: setByoKey,
    parsePerception: parsePerception,
    describePerception: describePerception,
    probe: probe,
    perceive: perceive,
    judge: judge,
    mothSubmit: mothSubmit,
    mothStatus: mothStatus,
    mothEngines: mothEngines
  };
})();
