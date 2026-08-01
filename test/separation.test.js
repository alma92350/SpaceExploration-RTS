import { test } from "node:test";
import assert from "node:assert/strict";
import { applySeparation, separationWindow, MAX_SEPARATION_NEIGHBORS } from "../engine/separation.js";
import { makeUnit } from "../engine/state.js";
import { buildUnitGrid } from "../engine/grid.js";

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

// SEPARATION_PAD_MULT (the +20% "idle or in formation" spacing) must never loosen how tightly a
// squad can mass fire on one target — that's a balance-tuned invariant (test/balance.test.js),
// not a spacing preference. A same-owner pair in COMBAT MODE (an attack/attack-move order, or
// already holding a live target) settles at the plain, unpadded combined radius; only a genuinely
// idle pair gets the wider berth.
test("two idle same-owner units settle at the padded (wider) distance", () => {
  const state = { units: new Map() };
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 507, 500);   // inside the padded 16.8 (7+7=14 * 1.2) but outside the bare 14
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  for (let i = 0; i < 50; i++) applySeparation(state, 0.05);

  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(dist >= 16.3, `idle units should settle at ~16.8 (padded), got ${dist.toFixed(1)}`);
});

test("two same-owner units on attack-move orders sit inside the padded gap (14-16.8) but outside the bare combined radius (14) — no push at all", () => {
  const state = { units: new Map() };
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 515, 500);   // 15 apart: outside the bare 7+7=14, inside the padded 16.8
  a.order = { type: "attack-move", x: 5000, y: 500 };
  b.order = { type: "attack-move", x: 5000, y: 500 };
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  applySeparation(state, 0.1);   // already past the bare combined radius — combat mode means no push at all here

  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  assert.equal(dist, 15, "combat-mode units use the plain unpadded radius — 15 apart is already clear, so no push happens");
});

test("a same-owner pair with a live acquired target (autoTarget) also settles at the plain unpadded distance", () => {
  const state = { units: new Map() };
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 505, 500);   // inside the bare 14 combined radius
  a.autoTarget = "some-enemy-id";
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  for (let i = 0; i < 50; i++) applySeparation(state, 0.05);

  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  assert.ok(dist >= 13.5 && dist < 15, `a pair with one side already engaged should settle at ~14 (unpadded), got ${dist.toFixed(1)}`);
});

test("repeated ticks fully resolve an overlap without overshooting into orbit", () => {
  const state = { units: new Map() };
  const a = makeUnit("worker", "ai", 300, 300);
  const b = makeUnit("worker", "ai", 302, 300);
  state.units.set(a.id, a);
  state.units.set(b.id, b);

  for (let i = 0; i < 200; i++) applySeparation(state, 0.05);

  const finalDist = Math.hypot(b.x - a.x, b.y - a.y);
  const minDist = (6 + 6) * 1.2;   // both workers' radius, padded by separation.js's own SEPARATION_PAD_MULT
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
  assert.ok(minPairDist >= 16.3, "no two should still be sitting inside each other's padded radius (7+7=14, *1.2 SEPARATION_PAD_MULT = 16.8)");
});

// Every test above drives applySeparation through its O(n) fallback (no
// state.unitGrid at all). Real gameplay never does that — sim.js builds
// state.unitGrid every tick before separation runs — so the grid branch
// (queryNeighbors + the _gi index it stamps for exactly-once pairing,
// engine/grid.js) needs its own coverage too.
test("overlapping same-owner units in different grid cells still get paired and pushed apart via the populated broad-phase grid", () => {
  // engine/grid.js's CELL is 96: a and b straddle the 1056 cell boundary while
  // still well inside the 7+7 combined hull radius — the multi-cell case the
  // very first test above (both units near 500,500, one cell) never exercises.
  // A broken or silently-skipped neighbor-cell query would leave this pair
  // overlapping instead of pushed apart.
  const state = { units: new Map() };
  const a = makeUnit("skiff", "player", 1052, 500);   // grid column 10
  const b = makeUnit("skiff", "player", 1060, 500);   // grid column 11 — 8 apart, well inside the 7+7 combined radius
  state.units.set(a.id, a);
  state.units.set(b.id, b);
  state.unitGrid = buildUnitGrid(state);   // the real per-tick broad-phase index + the _gi stamp the pairing loop relies on

  const startDist = Math.hypot(b.x - a.x, b.y - a.y);
  applySeparation(state, 0.1);
  const endDist = Math.hypot(b.x - a.x, b.y - a.y);

  assert.ok(endDist > startDist, "the pair should move apart even though they sit in neighboring grid cells");
});

// A background world left to idle can accumulate a same-owner army numbering in the
// hundreds, all piled on roughly the same rally point. queryNeighbors' candidate list
// for a query planted inside that pile scales with local density, not army size — so
// without a bound, a single applySeparation call over such a pile does a number of
// separatePair evaluations quadratic in the pile's local density, which is exactly the
// multi-millisecond per-tick cost profiled against a real save (see CHANGELOG). These
// tests drive separationWindow, the pure helper that bounds and rotates the candidate
// scan, directly — the arithmetic is easy to pin down exactly here instead of inferring
// it from emergent multi-body motion.
test("separationWindow is a no-op under the cap: identical [0, n] scan as the old unbounded for-of", () => {
  assert.deepEqual(separationWindow(0, 0, 0), [0, 0]);
  assert.deepEqual(separationWindow(5, 0, 0), [0, 5]);
  assert.deepEqual(separationWindow(MAX_SEPARATION_NEIGHBORS, 17, 999), [0, MAX_SEPARATION_NEIGHBORS]);
});

test("separationWindow bounds the scan to MAX_SEPARATION_NEIGHBORS once candidates exceed it", () => {
  const [, take] = separationWindow(200, 150, 0);
  assert.equal(take, MAX_SEPARATION_NEIGHBORS);
});

test("separationWindow rotates its start by the querying unit's own _gi, so a big pile isn't split into an always-resolved low-index group and a never-resolved high-index remainder within one tick", () => {
  const n = 200;
  const [startLow] = separationWindow(n, 0, 0);
  const [startMid] = separationWindow(n, 150, 0);
  const [startHigh] = separationWindow(n, 199, 0);
  assert.equal(startLow, 0);
  assert.equal(startMid, 150);
  assert.equal(startHigh, 199);
  assert.notEqual(startLow, startHigh, "different queriers should scan different windows of the same candidate list");
});

test("separationWindow also slides its start with the simulation tick, so a unit sitting at a stable local density doesn't scan the same window forever", () => {
  const n = 200, gi = 5;
  const [startNow] = separationWindow(n, gi, 0);
  const [startLater] = separationWindow(n, gi, 37);
  assert.equal(startNow, 5);
  assert.equal(startLater, 42);
  assert.notEqual(startNow, startLater, "the same unit's window should move on as ticks pass, eventually covering every candidate");
});

test("a pathological same-owner pile-up (hundreds of units on one point) still converges to essentially the same spread as the uncapped pass, given enough ticks, via the grid broad-phase path", () => {
  const state = { units: new Map(), tick: 0 };
  for (let i = 0; i < 150; i++) {
    const u = makeUnit("skiff", "ai", 900, 900);
    state.units.set(u.id, u);
  }

  for (let i = 0; i < 2000; i++) {
    state.unitGrid = buildUnitGrid(state);
    applySeparation(state, 0.05);
    state.tick++;
  }

  const units = [...state.units.values()];
  let cx = 0, cy = 0;
  for (const u of units) { cx += u.x; cy += u.y; }
  cx /= units.length; cy /= units.length;
  let maxDist = 0;
  for (const u of units) maxDist = Math.max(maxDist, Math.hypot(u.x - cx, u.y - cy));

  // An uncapped pass on the same fixture plateaus proportionally higher now that minDist carries
  // SEPARATION_PAD_MULT (a packed circle of 150 skiffs) — well below the floor here would mean
  // the bound is leaving pairs permanently stuck rather than merely rate-limiting how fast they resolve.
  assert.ok(maxDist > 70, "a 150-unit pile-up should reach a substantially resolved spread, not settle for a permanently tighter-than-necessary packing");
});
