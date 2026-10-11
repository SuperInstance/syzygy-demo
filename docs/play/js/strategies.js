'use strict';
/*
 * strategies.js (browser port of lib/strategies/*.js) — the strategy tiles.
 *
 * Tile format: { id, name, description, createMemory(), decide(perception,
 * memory) } where decide() receives ONLY the model's structured perception
 * (plus the tile's own memory) and returns one action:
 *   { action, ms, note }
 * action ∈ forward | back | turnLeft | turnRight | strafeLeft | strafeRight
 *          | engage | wait
 * A tile never sees game state — no pose, no map, no sprite coordinates.
 */
(function () {

  /* ---------------- Explorer (port of lib/strategies/explorer.js) -------- */
  var explorer = {
    id: 'explorer',
    name: 'Explorer',
    description: 'Systematic room-to-room sweep. Walks open corridors, prefers directions it has not just taken, scans when boxed in, sidesteps creatures instead of engaging them.',

    createMemory: function () {
      return { ticks: 0, recentDirs: [], boxedScans: 0, lastCreatureTick: -99 };
    },

    decide: function (p, mem) {
      mem.ticks++;
      var center = Math.floor(p.gridCols / 2);
      var creatures = p.elements.filter(function (e) { return e.kind === 'creature'; });
      if (creatures.length) mem.lastCreatureTick = mem.ticks;

      // Traffic rule: a big creature dead ahead is something to step around,
      // not through — Explorer is a surveyor, not a fighter.
      var ahead = creatures.find(function (c) { return Math.abs(c.col - center) <= p.gridCols * 0.15; });
      if (ahead && ahead.size === 'large') {
        var side = p.corridors.left === 'open' && p.corridors.right !== 'open' ? 'strafeLeft'
          : p.corridors.right === 'open' ? 'strafeRight' : 'strafeLeft';
        return { action: side, ms: 450, note: 'creature dead ahead at col ' + ahead.col + ' — sidestepping ' + (side === 'strafeLeft' ? 'left' : 'right') + ' to keep surveying' };
      }

      if (p.free_directions.includes('center')) {
        mem.boxedScans = 0;
        mem.recentDirs.push('center');
        if (mem.recentDirs.length > 6) mem.recentDirs.shift();
        return { action: 'forward', ms: 900, note: 'center corridor reads open — pushing forward' };
      }

      var openSides = ['left', 'right'].filter(function (d) { return p.free_directions.includes(d); });
      if (openSides.length) {
        // Seek unvisited space: prefer the side taken least recently.
        var pick = openSides.sort(function (a, b) {
          return mem.recentDirs.lastIndexOf(a) - mem.recentDirs.lastIndexOf(b);
        })[0];
        mem.recentDirs.push(pick);
        if (mem.recentDirs.length > 6) mem.recentDirs.shift();
        return {
          action: pick === 'left' ? 'turnLeft' : 'turnRight', ms: 330,
          note: 'center blocked; ' + pick + ' side reads open' + (openSides.length === 2 ? ' (least recently taken)' : '') + ' — turning to survey it'
        };
      }

      // Boxed in: scan. After three scans without an opening, back up and re-scan.
      mem.boxedScans++;
      if (mem.boxedScans >= 3) {
        mem.boxedScans = 0;
        return { action: 'back', ms: 420, note: 'boxed in after repeated scans — backing up to change the picture' };
      }
      return { action: 'turnRight', ms: 520, note: 'no open direction in view — scanning right for an opening' };
    }
  };

  /* ---------------- Hunter (port of lib/strategies/hunter.js) ----------- */
  var hunter = {
    id: 'hunter',
    name: 'Hunter',
    description: 'Hunts whatever the vision model reports. Centers any perceived creature on the grid, closes the distance, and engages at contact range. When nothing is visible it sweeps and patrols toward the last sighting.',

    createMemory: function () {
      return { ticks: 0, lastSeenTick: -99, lastSeenCol: null, sweep: 0 };
    },

    decide: function (p, mem) {
      mem.ticks++;
      var center = Math.floor(p.gridCols / 2);
      var sizeRank = { small: 1, medium: 2, large: 3 };
      var creatures = p.elements.filter(function (e) { return e.kind === 'creature'; });

      if (creatures.length) {
        // Target: the biggest (closest) creature; ties broken by nearest center.
        var target = creatures.slice().sort(function (a, b) {
          return (sizeRank[b.size] - sizeRank[a.size]) ||
            (Math.abs(a.col - center) - Math.abs(b.col - center));
        })[0];
        mem.lastSeenTick = mem.ticks;
        mem.lastSeenCol = target.col;
        var dx = target.col - center;

        if (Math.abs(dx) > 8) {
          var ms = Math.max(150, Math.min(600, 120 + Math.abs(dx) * 4));
          return {
            action: dx < 0 ? 'turnLeft' : 'turnRight', ms: ms,
            note: 'target at col ' + target.col + ', grid center is ' + center + ' — turning ' + (dx < 0 ? 'left' : 'right') + ' to center it'
          };
        }
        if (target.size !== 'large') {
          return { action: 'forward', ms: 650, note: 'target centered at col ' + target.col + ' but reads ' + target.size + ' — closing distance' };
        }
        return { action: 'engage', ms: 800, note: 'target centered and large at col ' + target.col + ' — ENGAGING to contact range' };
      }

      // Nothing visible: if we saw something recently, turn back toward it.
      if (mem.lastSeenCol !== null && mem.ticks - mem.lastSeenTick <= 3) {
        var dx2 = mem.lastSeenCol - center;
        mem.lastSeenCol = null;
        return {
          action: dx2 < 0 ? 'turnLeft' : 'turnRight', ms: 300,
          note: 'lost the target — turning back toward its last reported column'
        };
      }

      // Sweep patrol: scan, then step forward between scans when the way is open.
      mem.sweep++;
      if (mem.sweep % 3 === 0 && p.free_directions.includes('center')) {
        return { action: 'forward', ms: 550, note: 'no contact — patrolling forward between sweeps' };
      }
      return {
        action: mem.sweep % 2 ? 'turnRight' : 'turnLeft', ms: 300,
        note: 'no contact — sweeping for a creature signature'
      };
    }
  };

  window.SyzTiles = { explorer: explorer, hunter: hunter };
})();
