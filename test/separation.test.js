import { test } from "node:test";
import assert from "node:assert/strict";
import { applySeparation } from "../engine/separation.js";
import { makeUnit } from "../engine/state.js";

test("overlapping same-owner units get pushed apart", () => {
  const state = { units: new Map() };
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 505, 500);   // well inside combined radius (7+7)
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  const startDist = Math.hypot(b.x - a.x, b.y - a.y);
  applySeparation(state, 0.1);
  const endDist = Math.hypot(b.x - a.x, b.y - a.y);

  assert.ok(endDist > startDist, "the pair should move apart");
});

test("repeated ticks fully resolve an overlap without overshooting into orbit", () => {
  const state = { units: new Map() };
  const a = makeUnit("worker", "ai", 300, 300);
  const b = makeUnit("worker", "ai", 302, 300);
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  for (let i = 0; i < 200; i++) applySeparation(state, 0.05);

  const finalDist = Math.hypot(b.x - a.x, b.y - a.y);
  const minDist = 6 + 6;   // both workers' radius
  assert.ok(finalDist >= minDist - 0.5, "should settle at (about) the non-overlapping distance");
  assert.ok(finalDist < minDist + 1, "should not keep pushing once clear");
});

test("opposing-owner units are left alone so they can actually engage in melee/weapon range", () => {
  const state = { units: new Map() };
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "ai", 505, 500);
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  applySeparation(state, 0.1);

  assert.equal(a.x, 500);
  assert.equal(a.y, 500);
  assert.equal(b.x, 505);
  assert.equal(b.y, 500);
});

test("units already clear of each other are untouched", () => {
  const state = { units: new Map() };
  const a = makeUnit("worker", "player", 100, 100);
  const b = makeUnit("worker", "player", 400, 400);
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  applySeparation(state, 0.1);

  assert.equal(a.x, 100);
  assert.equal(a.y, 100);
  assert.equal(b.x, 400);
  assert.equal(b.y, 400);
});

test("exactly coincident units still resolve apart instead of dividing by zero forever", () => {
  const state = { units: new Map() };
  const a = makeUnit("skiff", "ai", 700, 700);
  const b = makeUnit("skiff", "ai", 700, 700);
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  for (let i = 0; i < 50; i++) applySeparation(state, 0.05);

  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(Number.isFinite(dist) && dist > 5, "should have separated to a real distance");
});

test("a whole cluster spawned on one point spreads out over a few ticks", () => {
  const state = { units: new Map() };
  for (let i = 0; i < 6; i++) {
    const u = makeUnit("skiff", "ai", 800, 800);
    state.units.set(u.id, u);
  }

  for (let i = 0; i < 100; i++) applySeparation(state, 0.05);

  const units = [...state.units.values()];
  let minPairDist = Infinity;
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      minPairDist = Math.min(minPairDist, Math.hypot(units[i].x - units[j].x, units[i].y - units[j].y));
    }
  }
  assert.ok(minPairDist >= 13, "no two should still be sitting inside each other's radius (7+7=14)");
});
