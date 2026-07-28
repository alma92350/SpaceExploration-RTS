import { test } from "node:test";
import assert from "node:assert/strict";
import { stepToward } from "../engine/movement.js";
import { makeUnit } from "../engine/state.js";
import { buildUnitGrid } from "../engine/grid.js";

function stateWith(...units) {
  const map = new Map(units.map(u => [u.id, u]));
  return { units: map };
}

test("with no neighbors, a unit walks straight at its target and reports arrival", () => {
  const unit = makeUnit("worker", "player", 0, 0);
  const state = stateWith(unit);

  let arrived = false;
  for (let i = 0; i < 200 && !arrived; i++) arrived = stepToward(state, unit, 100, 0, 60, 0.05);

  assert.equal(arrived, true);
  assert.ok(Math.abs(unit.x - 100) < 1 && Math.abs(unit.y) < 1);
});

test("a same-owner neighbor directly on the path gets steered around, not walked through", () => {
  const mover = makeUnit("worker", "player", 0, 0);
  const blocker = makeUnit("worker", "player", 50, 0);   // sitting right on the straight-line path
  const state = stateWith(mover, blocker);

  let closestApproach = Infinity;
  for (let i = 0; i < 400; i++) {
    stepToward(state, mover, 100, 0, 60, 0.05);
    closestApproach = Math.min(closestApproach, Math.hypot(mover.x - blocker.x, mover.y - blocker.y));
    if (Math.hypot(mover.x - 100, mover.y) < 1) break;
  }

  assert.ok(closestApproach >= 11, `should keep some distance from the blocker, got ${closestApproach.toFixed(2)}`);
});

test("an opposing-owner unit on the path is ignored — combat needs to close the distance, not dodge it", () => {
  const mover = makeUnit("skiff", "player", 0, 0);
  const enemy = makeUnit("skiff", "ai", 50, 0);
  const state = stateWith(mover, enemy);

  stepToward(state, mover, 100, 0, 60, 0.05);

  // straight-line step: no y deviation introduced by an enemy in the way
  assert.equal(mover.y, 0);
  assert.ok(mover.x > 0);
});

test("eventually still reaches the target despite steering around a neighbor along the way", () => {
  const mover = makeUnit("worker", "player", 0, 0);
  const blocker = makeUnit("worker", "player", 50, 0);
  const state = stateWith(mover, blocker);

  let arrived = false;
  for (let i = 0; i < 1000 && !arrived; i++) arrived = stepToward(state, mover, 100, 0, 60, 0.05);

  assert.equal(arrived, true);
});

test("a planet speed modifier scales how far a unit steps in a tick", () => {
  const unit = makeUnit("worker", "player", 0, 0);
  const state = stateWith(unit);
  state.map = { modifiers: { speedMult: 0.5 } };

  stepToward(state, unit, 1000, 0, 60, 1);   // distant target so arrival never clamps the step

  assert.ok(Math.abs(unit.x - 30) < 1e-6, `speed 60 x 0.5 x 1s should move 30, got ${unit.x}`);
});

// Every test above drives senseLateralAvoidance through its O(n) fallback (no
// state.unitGrid at all). Real gameplay never does that — sim.js builds
// state.unitGrid every tick before movement runs — so the grid branch
// (queryNeighbors, engine/grid.js) needs its own coverage too.
test("a same-owner neighbor in a NEIGHBORING grid cell is still sensed and steered around, via the populated broad-phase grid", () => {
  // engine/grid.js's CELL is 96: mover's query point and the blocker sit in
  // adjacent-but-different cells, straddling the 1056 boundary — the multi-cell
  // case the dead-ahead fallback test above (both units near 0,0, one cell)
  // never exercises. A broken or silently-skipped neighbor-cell query would
  // let the mover walk straight through instead of steering.
  const mover = makeUnit("worker", "player", 1020, 500);    // grid column 10
  const blocker = makeUnit("worker", "player", 1058, 500);  // grid column 11 — 38 away (inside sensing range), ahead on the path
  const state = stateWith(mover, blocker);
  state.unitGrid = buildUnitGrid(state);   // the real per-tick broad-phase index (engine/grid.js), same as sim.js builds every tick

  stepToward(state, mover, 2000, 500, 60, 0.05);

  assert.notEqual(mover.y, 500, "avoidance should have found the blocker through the grid and steered laterally, same as the fallback case above");
});
