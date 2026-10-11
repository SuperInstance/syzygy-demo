'use strict';
/*
 * downsample.js — reduces the engine's raw character buffer to the grid the
 * vision model actually reads. Derived ONLY from the buffer itself (never
 * from game state): each output cell takes the most "salient" glyph of its
 * source block — dense wall glyphs beat faint ones, and any non-shading
 * glyph (sprite/texture detail) beats shading, so creatures stay visible
 * instead of being averaged away.
 */
const SCORE = { ' ': 0, '.': 0, '░': 1, '▒': 2, '▓': 3, '█': 4 };
function score(ch) {
  if (ch in SCORE) return SCORE[ch];
  return 5; // letters, digits, symbols, '?' — sprite/texture detail
}

function downsample(rows, targetCols, targetRows) {
  const srcH = rows.length;
  const srcW = rows[0].length;
  const out = [];
  for (let r = 0; r < targetRows; r++) {
    const r0 = Math.floor((r * srcH) / targetRows);
    const r1 = Math.max(r0 + 1, Math.floor(((r + 1) * srcH) / targetRows));
    let line = '';
    for (let c = 0; c < targetCols; c++) {
      const c0 = Math.floor((c * srcW) / targetCols);
      const c1 = Math.max(c0 + 1, Math.floor(((c + 1) * srcW) / targetCols));
      let best = ' ', bestScore = -1;
      const counts = new Map();
      for (let y = r0; y < r1 && y < srcH; y++) {
        for (let x = c0; x < c1 && x < srcW; x++) {
          const ch = rows[y][x] || ' ';
          const s = score(ch);
          counts.set(ch, (counts.get(ch) || 0) + 1);
          if (s > bestScore || (s === bestScore && (counts.get(ch) || 0) > (counts.get(best) || 0))) {
            best = ch; bestScore = s;
          }
        }
      }
      line += best;
    }
    out.push(line);
  }
  return out;
}

module.exports = { downsample };
