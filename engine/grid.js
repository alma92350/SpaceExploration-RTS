// @ts-check
/* ============================================================
   Uniform spatial hash over units, rebuilt once per tick by sim.js. It's a
   BROAD PHASE only: a query returns candidate units whose cell is near a point,
   and the caller still does the exact live-distance test it did before. That
   turns the three per-tick O(n^2) neighbour scans — separation, movement
   avoidance, and combat target acquisition — into local lookups, which is what
   lets a Gigantic (4x) map with hundreds of units stay inside the frame budget.

   The grid is built from pre-movement positions and reused through the whole
   tick (units move, then separate, after the build), so every query box is
   padded by an extra ring of cells. One tick's displacement is far under a
   cell, so the padded candidate set is always a superset of the true
   neighbours — no interaction is ever missed, only a few extra candidates get
   the cheap distance check and fall out.

   When state.unitGrid is absent (the many unit tests that call movement /
   combat / separation directly without a full tick) every consumer falls back
   to the original full scan, so their behaviour is byte-for-byte unchanged.
   ============================================================ */

"use strict";

const CELL = 96;
// Integer cell key instead of a "cx,cy" string: the old key allocated + hashed a string for
// every unit inserted AND every cell queried, every tick — pure per-tick garbage on the hot
// path. Packing (cx,cy) into one int is a plain arithmetic Map key. KEY_PAD offsets the few
// negative cells the query pad reaches; KEY_STRIDE exceeds the max cells-per-axis of any map
// (Gigantic ≈ 67), so the packing is collision-free. This changes NOTHING observable: cells
// bucket the same units in the same order, and queryNeighbors visits cells in the same fixed
// loop, so candidate lists are byte-for-byte identical — the determinism test stays green.
const KEY_PAD = 16;      // headroom for the most negative cell any query pad reaches (radius up to ~1400px)
const KEY_STRIDE = 4096;  // > max cells per axis (a huge map is ~67), so (cx+PAD) and (cy+PAD) never overlap
function cellKey(cx, cy) { return (cx + KEY_PAD) * KEY_STRIDE + (cy + KEY_PAD); }

/** @param {State} state */
export function buildUnitGrid(state) {
  const buckets = new Map();
  let i = 0;
  for (const u of state.units.values()) {
    u._gi = i++;   // stable Map-order index: lets separation process each pair once, deterministically
    const k = cellKey(Math.floor(u.x / CELL), Math.floor(u.y / CELL));
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(u);
  }
  return { cell: CELL, buckets };
}

// Candidate units in every cell overlapping the (radius, +1 ring of padding)
// box around (x, y). A superset of the units within `radius` — callers filter
// by exact distance. Cells are visited in a fixed numeric order and bucket
// contents keep Map insertion order, so iteration is fully deterministic.
/** @param {*} grid @param {number} x @param {number} y @param {number} radius @returns {(Unit)[]} */
export function queryNeighbors(grid, x, y, radius) {
  const cell = grid.cell;
  const mincx = Math.floor((x - radius) / cell) - 1;
  const maxcx = Math.floor((x + radius) / cell) + 1;
  const mincy = Math.floor((y - radius) / cell) - 1;
  const maxcy = Math.floor((y + radius) / cell) + 1;
  const out = [];
  for (let cy = mincy; cy <= maxcy; cy++) {
    for (let cx = mincx; cx <= maxcx; cx++) {
      const arr = grid.buckets.get(cellKey(cx, cy));
      if (arr) for (const u of arr) out.push(u);
    }
  }
  return out;
}
