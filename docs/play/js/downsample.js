'use strict';
/*
 * downsample.js (browser port of lib/downsample.js) — reduces the engine's
 * raw character buffer to the grid the vision model actually reads. Derived
 * ONLY from the buffer itself (never from game state): each output cell takes
 * the most "salient" glyph of its source block — dense wall glyphs beat faint
 * ones, and any non-shading glyph (sprite/texture detail) beats shading, so
 * creatures stay visible instead of being averaged away.
 */
(function () {
  var SCORE = { ' ': 0, '.': 0, '░': 1, '▒': 2, '▓': 3, '█': 4 };
  function score(ch) {
    if (ch in SCORE) return SCORE[ch];
    return 5; // letters, digits, symbols, '?' — sprite/texture detail
  }

  function downsample(rows, targetCols, targetRows) {
    var srcH = rows.length;
    var srcW = rows[0].length;
    var out = [];
    for (var r = 0; r < targetRows; r++) {
      var r0 = Math.floor((r * srcH) / targetRows);
      var r1 = Math.max(r0 + 1, Math.floor(((r + 1) * srcH) / targetRows));
      var line = '';
      for (var c = 0; c < targetCols; c++) {
        var c0 = Math.floor((c * srcW) / targetCols);
        var c1 = Math.max(c0 + 1, Math.floor(((c + 1) * srcW) / targetCols));
        var best = ' ', bestScore = -1;
        var counts = new Map();
        for (var y = r0; y < r1 && y < srcH; y++) {
          for (var x = c0; x < c1 && x < srcW; x++) {
            var ch = rows[y][x] || ' ';
            var s = score(ch);
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

  window.SyzDownsample = downsample;
})();
