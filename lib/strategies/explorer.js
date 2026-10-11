'use strict';
/*
 * STRATEGY TILE — Explorer
 * Tile format (see README): a plain JS module exporting
 *   { id, name, description, createMemory(), decide(perception, memory) }
 * decide() receives ONLY the model's structured perception (plus the tile's
 * own memory of past perceptions/decisions) and returns one action:
 *   { action, ms, note }
 * action ∈ forward | back | turnLeft | turnRight | strafeLeft | strafeRight
 *          | engage | wait
 * The tile never sees game state — no pose, no map, no sprite coordinates.
 */
module.exports = {
  id: 'explorer',
  name: 'Explorer',
  description: 'Systematic room-to-room sweep. Walks open corridors, prefers directions it has not just taken, scans when boxed in, sidesteps creatures instead of engaging them.',

  createMemory() {
    return { ticks: 0, recentDirs: [], boxedScans: 0, lastCreatureTick: -99 };
  },

  decide(p, mem) {
    mem.ticks++;
    const center = Math.floor(p.gridCols / 2);
    const creatures = p.elements.filter(e => e.kind === 'creature');
    if (creatures.length) mem.lastCreatureTick = mem.ticks;

    // Traffic rule: a big creature dead ahead is something to step around,
    // not through — Explorer is a surveyor, not a fighter.
    const ahead = creatures.find(c => Math.abs(c.col - center) <= p.gridCols * 0.15);
    if (ahead && ahead.size === 'large') {
      const side = p.corridors.left === 'open' && p.corridors.right !== 'open' ? 'strafeLeft'
        : p.corridors.right === 'open' ? 'strafeRight' : 'strafeLeft';
      return { action: side, ms: 450, note: `creature dead ahead at col ${ahead.col} — sidestepping ${side === 'strafeLeft' ? 'left' : 'right'} to keep surveying` };
    }

    if (p.free_directions.includes('center')) {
      mem.boxedScans = 0;
      mem.recentDirs.push('center');
      if (mem.recentDirs.length > 6) mem.recentDirs.shift();
      return { action: 'forward', ms: 900, note: 'center corridor reads open — pushing forward' };
    }

    const openSides = ['left', 'right'].filter(d => p.free_directions.includes(d));
    if (openSides.length) {
      // Seek unvisited space: prefer the side taken least recently.
      const pick = openSides.sort((a, b) =>
        mem.recentDirs.lastIndexOf(a) - mem.recentDirs.lastIndexOf(b))[0];
      mem.recentDirs.push(pick);
      if (mem.recentDirs.length > 6) mem.recentDirs.shift();
      return {
        action: pick === 'left' ? 'turnLeft' : 'turnRight', ms: 330,
        note: `center blocked; ${pick} side reads open${openSides.length === 2 ? ' (least recently taken)' : ''} — turning to survey it`
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
