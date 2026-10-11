'use strict';
/*
 * perceive.js — the ONLY place a model is consulted, and it is consulted
 * about perception only. Sends the downsampled character grid (and nothing
 * else — no pose, no map, no sprite data) to MiniMax with the frozen prompt
 * in prompt.txt, and returns the parsed structured perception.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CHAT_PY = path.join(process.env.HOME, 'workspace/skills/minimax/bin/chat.py');
const PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompt.txt'), 'utf8');
const CALL_TIMEOUT_MS = parseInt(process.env.SYZ_PERCEIVE_TIMEOUT_MS || '120000', 10);
const MAX_TOKENS = process.env.SYZ_PERCEIVE_MAX_TOKENS || '800';

function buildPrompt(gridRows) {
  const rows = gridRows.length;
  const cols = gridRows[0].length;
  return PROMPT_TEMPLATE
    .replaceAll('{{ROWS}}', String(rows))
    .replaceAll('{{COLS}}', String(cols))
    .replaceAll('{{MAXCOL}}', String(cols - 1))
    .replaceAll('{{MAXROW}}', String(rows - 1))
    .replaceAll('{{GRID}}', gridRows.join('\n'));
}

function callMiniMax(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHAT_PY, [prompt, '--max-tokens', MAX_TOKENS], {
      cwd: path.dirname(CHAT_PY),
      env: process.env
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('MiniMax call timed out after ' + CALL_TIMEOUT_MS + ' ms'));
    }, CALL_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('chat.py exit ' + code + ': ' + err.slice(0, 400)));
      else resolve(out);
    });
  });
}

function parsePerception(raw, gridRows) {
  const rows = gridRows.length, cols = gridRows[0].length;
  let text = String(raw).trim();
  text = text.replace(/```(?:json)?/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  const obj = JSON.parse(text.slice(start, end + 1));

  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  const kinds = ['creature', 'wall', 'opening', 'item', 'unknown'];
  const sizes = ['small', 'medium', 'large'];
  const elements = (Array.isArray(obj.elements) ? obj.elements : []).slice(0, 12).map(e => ({
    kind: kinds.includes(e.kind) ? e.kind : 'unknown',
    col: clamp(e.col, cols - 1),
    row: clamp(e.row, rows - 1),
    size: sizes.includes(e.size) ? e.size : 'medium',
    note: String(e.note || '').slice(0, 80)
  }));
  const corr = v => (v === 'open' || v === 'blocked' || v === 'unclear') ? v : 'unclear';
  const corridors = {
    left: corr(obj.corridors && obj.corridors.left),
    center: corr(obj.corridors && obj.corridors.center),
    right: corr(obj.corridors && obj.corridors.right)
  };
  const free = (Array.isArray(obj.free_directions) ? obj.free_directions : [])
    .filter(d => d === 'left' || d === 'center' || d === 'right');
  return {
    summary: String(obj.summary || '').slice(0, 200),
    elements,
    corridors,
    free_directions: [...new Set(free)],
    gridCols: cols,
    gridRows: rows
  };
}

async function perceive(gridRows) {
  const t0 = Date.now();
  const raw = await callMiniMax(buildPrompt(gridRows));
  const perception = parsePerception(raw, gridRows);
  perception.latencyMs = Date.now() - t0;
  return perception;
}

module.exports = { perceive, buildPrompt, parsePerception };
