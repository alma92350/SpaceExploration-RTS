import { test } from "node:test";
import assert from "node:assert/strict";
import { stepToward } from "../engine/movement.js";
import { makeUnit } from "../engine/state.js";

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
