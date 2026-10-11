'use strict';
/*
 * syzygy-rack — a multi-provider key-rack for the Syzygy demo.
 *
 * One small Cloudflare Worker holding the fleet's provider keys as Worker
 * SECRETS (never in code, never in git) and lending them to a public demo
 * page under strict economics: Workers are cheap when calls are occasional
 * little scripts, so every route is paced per caller and capped per day,
 * and when a cap is hit the route answers "resting" and the page falls
 * back to a recorded real session.
 *
 * Routes:
 *   GET  /health         -> which house providers are configured, caps,
 *                           today's admitted-call counts. No payloads logged.
 *   POST /perceive       -> MiniMax chat completion with the frozen Syzygy
 *                           perception prompt (promptId "frozen-v1").
 *                           Body: { promptId, grid: [rows...], session? }
 *                           Returns { raw, latencyMs, provider, mode } —
 *                           the client parses/validates the perception.
 *   POST /judge          -> Typesafe Jev SystemOne judgment.
 *                           Body: { session, state, question:{type,
 *                           instructions, criteria} } -> provider answers.
 *   POST /moth           -> Moth Quantum: submit a job, poll briefly.
 *                           Body: { session?, engine_id, params }
 *   GET  /moth/status    -> ?job=<id> -> job status/result.
 *   GET  /moth/engines   -> list engines.
 *
 * Bring-your-own key: a caller may send x-syz-byo-minimax /
 * x-syz-byo-typesafe / x-syz-byo-moth with their own provider key. The key
 * is used for that single provider call only — never stored, never logged,
 * and house daily caps do not apply (pacing still does).
 *
 * Secrets (set with `wrangler secret put` or the dashboard — see README):
 *   MINIMAX_API_KEY, TYPESAFE_API_KEY, MOTH_API_KEY
 * Bindings/vars (wrangler.toml / deploy metadata):
 *   RACK (KV namespace) — pacing + daily counters (counts only).
 *   ALLOWED_ORIGINS, PACE_MS, *_DAILY_CAP.
 */

// ---------------------------------------------------------------- frozen prompt
// Byte-identical to lib/prompt.txt in the syzygy-demo repo (promptId
// "frozen-v1"). The browser sends grid + promptId; the prompt text itself
// never travels and cannot be injected by callers.
const PROMPTS = {
  'frozen-v1': `You are the vision system of a game-playing agent. You cannot see the game itself — only the character grid below, which is a first-person view rendered as text. Read it the way a vision system reads pixels and report ONLY what is visible in the grid. Do not invent objects that are not drawn.

THE GRID: {{ROWS}} rows x {{COLS}} columns of characters. Columns are numbered 0 (left edge) to {{MAXCOL}} (right edge). Rows are numbered 0 (top) to {{MAXROW}} (bottom). The view is first-person: the middle rows are the horizon / far away, the bottom rows are the floor close to the viewer, the top rows are the ceiling / sky.

GLYPH LEGEND:
- "█", "▓", "▒", "░" are solid surfaces (walls). Denser glyph = nearer surface. A tall solid band of these glyphs filling the left, center or right of the view is a wall in that direction.
- Clusters of letters, digits or other symbols (including "?") that stand vertically on the lower-middle area are CREATURES or objects standing in the space.
- Blank spaces are open air, ceiling or distant floor.

Answer with EXACTLY ONE JSON object and nothing else — no prose before or after, no markdown fences:

{
  "summary": "one short sentence describing what is visible",
  "elements": [
    {"kind": "creature" | "wall" | "opening" | "item" | "unknown",
     "col": <center column of the thing, 0..{{MAXCOL}}>,
     "row": <center row of the thing, 0..{{MAXROW}}>,
     "size": "small" | "medium" | "large",
     "note": "a few words: what it looks like"}
  ],
  "corridors": {"left": "open" | "blocked" | "unclear",
                "center": "open" | "blocked" | "unclear",
                "right": "open" | "blocked" | "unclear"},
  "free_directions": [<any of "left", "center", "right" that appear open to walk into>]
}

Report walls as elements where a distinct wall face or corner stands out. Report each visible creature as one element. If nothing but wall fills the whole view, say so in the summary and mark all corridors "blocked".

THE GRID:
{{GRID}}`
};

const PROVIDERS = {
  minimax: { secret: 'MINIMAX_API_KEY', byoHeader: 'x-syz-byo-minimax', capVar: 'PERCEIVE_DAILY_CAP', capDefault: 600 },
  typesafe: { secret: 'TYPESAFE_API_KEY', byoHeader: 'x-syz-byo-typesafe', capVar: 'JUDGE_DAILY_CAP', capDefault: 250 },
  moth: { secret: 'MOTH_API_KEY', byoHeader: 'x-syz-byo-moth', capVar: 'MOTH_DAILY_CAP', capDefault: 50 }
};

// ---------------------------------------------------------------- helpers
function intVar(env, name, dflt) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://superinstance.github.io')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || '';
  const list = allowedOrigins(env);
  const h = { 'Vary': 'Origin' };
  if (list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(env, req, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env, req) }
  });
}

function err(env, req, status, code, message) {
  return json(env, req, status, { ok: false, error: code, message });
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function today() { return new Date().toISOString().slice(0, 10); }

/*
 * Admit one house call for `route`, or explain why not.
 * - pacing: one admitted call per caller (IP+session hash) per PACE_MS.
 * - daily cap: admitted house calls per route per UTC day.
 * Counters live in KV (binding RACK). Counts only — never payloads.
 * BYO calls are paced but do not consume the house cap.
 * Fails CLOSED when KV is unavailable: the page's replay keeps it honest.
 */
// In-isolate pacing memory: KV is eventually consistent across colos, so
// this Map is the fast path for bursts hitting the same isolate; KV remains
// the cross-isolate backstop and the durable counter store.
const paceMemory = new Map();

async function admit(env, req, route, session, byo) {
  if (!env.RACK) return { ok: false, status: 503, code: 'rack_unavailable', message: 'the rack\'s counter store is unavailable — eyes resting' };
  const paceMs = intVar(env, 'PACE_MS', 2500);
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const caller = (await sha256hex(ip + '|' + (session || ''))).slice(0, 24);
  const paceKey = `pace:${route}:${caller}`;
  try {
    const now = Date.now();
    const memLast = paceMemory.get(paceKey) || 0;
    const kvLast = parseInt((await env.RACK.get(paceKey)) || '0', 10);
    const last = Math.max(memLast, kvLast);
    if (now - last < paceMs) {
      return { ok: false, status: 429, code: 'pacing', message: `paced: one call per ${(paceMs / 1000).toFixed(1)}s per caller — try again in ${((paceMs - (now - last)) / 1000).toFixed(1)}s` };
    }
    paceMemory.set(paceKey, now);
    if (paceMemory.size > 5000) paceMemory.clear();
    let count = null;
    const countKey = `count:${route}:${today()}`;
    if (!byo) {
      const cap = intVar(env, PROVIDERS[route].capVar, PROVIDERS[route].capDefault);
      count = parseInt((await env.RACK.get(countKey)) || '0', 10);
      if (count >= cap) {
        return { ok: false, status: 503, code: 'daily_cap', message: `the demo's ${route} eyes are resting — today's house budget (${cap} calls) is spent. Add your own key on the page, or come back tomorrow.` };
      }
    }
    await env.RACK.put(paceKey, String(now), { expirationTtl: 120 });
    if (!byo) await env.RACK.put(countKey, String(count + 1), { expirationTtl: 60 * 60 * 30 });
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 503, code: 'rack_unavailable', message: 'the rack\'s counter store errored — eyes resting' };
  }
}

async function todayCount(env, route) {
  if (!env.RACK) return null;
  try { return parseInt((await env.RACK.get(`count:${route}:${today()}`)) || '0', 10); }
  catch (e) { return null; }
}

function providerKey(env, req, route) {
  const byo = req.headers.get(PROVIDERS[route].byoHeader);
  if (byo) return { key: byo, mode: 'byo' };
  const house = env[PROVIDERS[route].secret];
  if (house) return { key: house, mode: 'house' };
  return { key: null, mode: null };
}

async function readJsonBody(req, maxBytes) {
  const len = parseInt(req.headers.get('Content-Length') || '0', 10);
  if (len > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'too_large', status: 413 });
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error('request body too large'), { code: 'too_large', status: 413 });
  try { return JSON.parse(text || '{}'); }
  catch (e) { throw Object.assign(new Error('body is not valid JSON'), { code: 'bad_json', status: 400 }); }
}

// ---------------------------------------------------------------- providers
async function callMiniMax(key, prompt) {
  const t0 = Date.now();
  const resp = await fetch('https://api.minimax.io/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'MiniMax-Text-01',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800
    })
  });
  if (!resp.ok) {
    const code = resp.status === 401 || resp.status === 403 ? 'provider_auth' : 'provider_error';
    throw Object.assign(new Error(`MiniMax answered HTTP ${resp.status}`), { code, status: 502 });
  }
  const data = await resp.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '';
  if (!content) throw Object.assign(new Error('MiniMax returned no content'), { code: 'provider_error', status: 502 });
  return { raw: content, latencyMs: Date.now() - t0 };
}

async function callTypesafe(key, state, questions) {
  const t0 = Date.now();
  const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ state, questions, model: 'jev-latest' })
  });
  if (!resp.ok) {
    const code = resp.status === 401 || resp.status === 403 ? 'provider_auth' : 'provider_error';
    throw Object.assign(new Error(`Typesafe answered HTTP ${resp.status}`), { code, status: 502 });
  }
  const data = await resp.json();
  return { answers: data.answers || data, latencyMs: Date.now() - t0 };
}

const MOTH_BASE = 'https://api.mothquantum.com/api/v1';
async function mothFetch(key, method, path, body) {
  const resp = await fetch(MOTH_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key,
      'User-Agent': 'SuperInstance-syzygy-rack/1.0'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) {
    const code = resp.status === 401 || resp.status === 403 ? 'provider_auth' : 'provider_error';
    throw Object.assign(new Error(`Moth answered HTTP ${resp.status}`), { code, status: 502 });
  }
  return resp.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- routes
async function handlePerceive(env, req) {
  const body = await readJsonBody(req, 48 * 1024);
  const promptId = body.promptId || 'frozen-v1';
  if (!PROMPTS[promptId]) return err(env, req, 400, 'unknown_prompt', 'unknown promptId: ' + promptId);
  const grid = body.grid;
  if (!Array.isArray(grid) || !grid.length || grid.length > 64 ||
      grid.some(r => typeof r !== 'string' || r.length > 128)) {
    return err(env, req, 400, 'bad_grid', 'grid must be 1..64 rows of strings, each at most 128 chars');
  }
  const { key, mode } = providerKey(env, req, 'minimax');
  if (!key) return err(env, req, 503, 'provider_not_configured', 'the rack has no MiniMax key yet — the demo\'s house eyes are not configured. Add your own MiniMax key on the page to play live.');
  const gate = await admit(env, req, 'minimax', body.session, mode === 'byo');
  if (!gate.ok) return err(env, req, gate.status, gate.code, gate.message);

  const rows = grid.length, cols = grid[0].length;
  const prompt = PROMPTS[promptId]
    .replaceAll('{{ROWS}}', String(rows))
    .replaceAll('{{COLS}}', String(cols))
    .replaceAll('{{MAXCOL}}', String(cols - 1))
    .replaceAll('{{MAXROW}}', String(rows - 1))
    .replaceAll('{{GRID}}', grid.join('\n'));
  try {
    const out = await callMiniMax(key, prompt);
    return json(env, req, 200, { ok: true, provider: 'minimax', mode, raw: out.raw, latencyMs: out.latencyMs });
  } catch (e) {
    return err(env, req, e.status || 502, e.code || 'provider_error', e.message);
  }
}

async function handleJudge(env, req) {
  const body = await readJsonBody(req, 16 * 1024);
  const session = body.session;
  if (!session || typeof session !== 'string' || session.length > 80) {
    return err(env, req, 400, 'bad_session', 'a session id is required (each visitor session gets its own judgment battery)');
  }
  const state = body.state;
  const q = body.question || {};
  if (typeof state !== 'string' || !state || state.length > 6000) {
    return err(env, req, 400, 'bad_state', 'state must be a non-empty string of at most 6000 chars');
  }
  if (!q || typeof q.instructions !== 'string' || !q.instructions) {
    return err(env, req, 400, 'bad_question', 'question.instructions is required');
  }
  const type = q.type === 'choice' ? 'choice' : 'noul';
  const question = { instructions: q.instructions.slice(0, 500), type };
  if (q.criteria && typeof q.criteria === 'object') {
    const crit = {};
    for (const [k, v] of Object.entries(q.criteria).slice(0, 8)) {
      crit[String(k).slice(0, 60)] = String(v).slice(0, 300);
    }
    question.criteria = crit;
  }
  const { key, mode } = providerKey(env, req, 'typesafe');
  if (!key) return err(env, req, 503, 'provider_not_configured', 'the rack has no Typesafe key yet — the judge is not seated. Add your own Typesafe key on the page to enable session verdicts.');
  const gate = await admit(env, req, 'typesafe', session, mode === 'byo');
  if (!gate.ok) return err(env, req, gate.status, gate.code, gate.message);
  try {
    // The session id rides inside the judged state, so every session's
    // battery is unique to its own time in the demo — no accounts needed.
    const out = await callTypesafe(key, `[session ${session}] ` + state, { q: question });
    return json(env, req, 200, { ok: true, provider: 'typesafe', mode, session, answers: out.answers, latencyMs: out.latencyMs });
  } catch (e) {
    return err(env, req, e.status || 502, e.code || 'provider_error', e.message);
  }
}

async function handleMothSubmit(env, req) {
  const body = await readJsonBody(req, 16 * 1024);
  const engineId = body.engine_id;
  if (!engineId || typeof engineId !== 'string' || engineId.length > 80) {
    return err(env, req, 400, 'bad_engine', 'engine_id is required');
  }
  const params = (body.params && typeof body.params === 'object') ? body.params : {};
  const { key, mode } = providerKey(env, req, 'moth');
  if (!key) return err(env, req, 503, 'provider_not_configured', 'the rack has no Moth Quantum key yet. Add your own Moth key on the page to submit jobs.');
  const gate = await admit(env, req, 'moth', body.session, mode === 'byo');
  if (!gate.ok) return err(env, req, gate.status, gate.code, gate.message);
  try {
    const job = await mothFetch(key, 'POST', '/jobs', { engine_id: engineId, params });
    const jobId = job.job_id || job.id;
    let current = job;
    // Poll briefly; quantum jobs are usually slower than a demo tick, so a
    // still-running job returns as pending with its id for /moth/status.
    for (let i = 0; i < 4 && jobId && current.status !== 'completed' && current.status !== 'failed' && current.status !== 'cancelled'; i++) {
      await sleep(4000);
      current = await mothFetch(key, 'GET', '/jobs/' + encodeURIComponent(jobId));
    }
    return json(env, req, 200, { ok: true, provider: 'moth', mode, job_id: jobId, status: current.status, job: current });
  } catch (e) {
    return err(env, req, e.status || 502, e.code || 'provider_error', e.message);
  }
}

async function handleMothStatus(env, req, url) {
  const jobId = url.searchParams.get('job');
  if (!jobId || jobId.length > 120) return err(env, req, 400, 'bad_job', 'job query param required');
  const { key, mode } = providerKey(env, req, 'moth');
  if (!key) return err(env, req, 503, 'provider_not_configured', 'the rack has no Moth Quantum key yet.');
  try {
    const job = await mothFetch(key, 'GET', '/jobs/' + encodeURIComponent(jobId));
    return json(env, req, 200, { ok: true, provider: 'moth', mode, job_id: jobId, status: job.status, job });
  } catch (e) {
    return err(env, req, e.status || 502, e.code || 'provider_error', e.message);
  }
}

async function handleMothEngines(env, req) {
  const { key, mode } = providerKey(env, req, 'moth');
  if (!key) return err(env, req, 503, 'provider_not_configured', 'the rack has no Moth Quantum key yet. Add your own Moth key on the page to reach the engines.');
  try {
    const data = await mothFetch(key, 'GET', '/engines');
    const engines = Array.isArray(data) ? data : (data.engines || data);
    return json(env, req, 200, { ok: true, provider: 'moth', mode, engines });
  } catch (e) {
    return err(env, req, e.status || 502, e.code || 'provider_error', e.message);
  }
}

async function handleHealth(env, req) {
  const providers = {};
  for (const [name, p] of Object.entries(PROVIDERS)) {
    providers[name] = {
      configured: !!env[p.secret],
      capPerDay: intVar(env, p.capVar, p.capDefault),
      usedToday: await todayCount(env, name)
    };
  }
  return json(env, req, 200, {
    ok: true, rack: 'syzygy-rack', providers,
    paceMs: intVar(env, 'PACE_MS', 2500)
  });
}

// ---------------------------------------------------------------- entry
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(env, req),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-syz-byo-minimax, x-syz-byo-typesafe, x-syz-byo-moth',
          'Access-Control-Max-Age': '86400'
        }
      });
    }
    try {
      if (url.pathname === '/health' && req.method === 'GET') return await handleHealth(env, req);
      if (url.pathname === '/perceive' && req.method === 'POST') return await handlePerceive(env, req);
      if (url.pathname === '/judge' && req.method === 'POST') return await handleJudge(env, req);
      if (url.pathname === '/moth' && req.method === 'POST') return await handleMothSubmit(env, req);
      if (url.pathname === '/moth/status' && req.method === 'GET') return await handleMothStatus(env, req, url);
      if (url.pathname === '/moth/engines' && req.method === 'GET') return await handleMothEngines(env, req);
      return err(env, req, 404, 'not_found', 'routes: GET /health, POST /perceive, POST /judge, POST /moth, GET /moth/status, GET /moth/engines');
    } catch (e) {
      return err(env, req, e.status || 500, e.code || 'rack_error', e.message || 'rack error');
    }
  }
};
