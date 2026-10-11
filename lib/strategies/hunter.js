'use strict';
/*
 * STRATEGY TILE — Hunter
 * Same tile format as explorer.js. decide() receives ONLY the model's
 * structured perception (plus this tile's own memory) and returns one action:
 *   { action, ms, note }
 * The tile never sees game state — it hunts what the vision model reports,
 * at the grid coordinates the model reports, Battleship-style.
 *
 * Note: this engine has no fire button. "Engage" = close to contact range
 * (the engine blocks forward movement at contact and creatures turn away),
 * so a successful hunt ends in a pursuit at arm's length — see README.
 */
module.exports = {
  id: 'hunter',
  name: 'Hunter',
  description: 'Hunts whatever the vision model reports. Centers any perceived creature on the grid, closes the distance, and engages at contact range. When nothing is visible it sweeps and patrols toward the last sighting.',

  createMemory() {
    return { ticks: 0, lastSeenTick: -99, lastSeenCol: null, sweep: 0 };
  },

  decide(p, mem) {
    mem.ticks++;
    const center = Math.floor(p.gridCols / 2);
    const sizeRank = { small: 1, medium: 2, large: 3 };
    const creatures = p.elements.filter(e => e.kind === 'creature');

    if (creatures.length) {
      // Target: the biggest (closest) creature; ties broken by nearest center.
      const target = creatures.slice().sort((a, b) =>
        (sizeRank[b.size] - sizeRank[a.size]) ||
        (Math.abs(a.col - center) - Math.abs(b.col - center)))[0];
      mem.lastSeenTick = mem.ticks;
      mem.lastSeenCol = target.col;
      const dx = target.col - center;

      if (Math.abs(dx) > 8) {
        const ms = Math.max(150, Math.min(600, 120 + Math.abs(dx) * 4));
        return {
          action: dx < 0 ? 'turnLeft' : 'turnRight', ms,
          note: `target at col ${target.col}, grid center is ${center} — turning ${dx < 0 ? 'left' : 'right'} to center it`
        };
      }
      if (target.size !== 'large') {
        return { action: 'forward', ms: 650, note: `target centered at col ${target.col} but reads ${target.size} — closing distance` };
      }
      return { action: 'engage', ms: 800, note: `target centered and large at col ${target.col} — ENGAGING to contact range` };
    }

    // Nothing visible: if we saw something recently, turn back toward it.
    if (mem.lastSeenCol !== null && mem.ticks - mem.lastSeenTick <= 3) {
      const dx = mem.lastSeenCol - center;
      mem.lastSeenCol = null;
      return {
        action: dx < 0 ? 'turnLeft' : 'turnRight', ms: 300,
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
