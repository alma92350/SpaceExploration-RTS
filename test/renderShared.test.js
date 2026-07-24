import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashStr, seededRng, shade, hexA, polygonPoints, toWorld, inView,
  facing, snapshotPositions, lerpXY, updateFacing, pruneFacing, resetFacing,
} from "../renderShared.js";

const closeTo = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} to be within ${eps} of ${expected}`);

/* ---------- hashStr ---------- */

test("hashStr is deterministic — same string, same hash", () => {
  assert.equal(hashStr("relic-node-7"), hashStr("relic-node-7"));
});

test("hashStr returns an unsigned 32-bit integer", () => {
  const h = hashStr("some-entity-id");
  assert.ok(Number.isInteger(h));
  assert.ok(h >= 0 && h <= 0xffffffff);
});

test("hashStr gives different strings different hashes (no trivial collision)", () => {
  const values = ["a", "b", "u1", "u2", "relic-node-7", "relic-node-8"].map(hashStr);
  assert.equal(new Set(values).size, values.length, "no two distinct inputs hashed the same");
});

/* ---------- seededRng ---------- */

test("seededRng is deterministic — same seed replays the same sequence", () => {
  const seed = hashStr("unit-1");
  const draw = () => { const r = seededRng(seed); return Array.from({ length: 10 }, () => r()); };
  assert.deepEqual(draw(), draw());
});

test("seededRng values land in the documented [0, 1) range", () => {
  const r = seededRng(hashStr("irregular-rock-silhouette"));
  for (let i = 0; i < 500; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `sample ${i} = ${v} out of [0,1) range`);
  }
});

test("seededRng gives different seeds different sequences", () => {
  const ra = seededRng(hashStr("a"));
  const rb = seededRng(hashStr("b"));
  assert.notEqual(ra(), rb());
});

/* ---------- shade ---------- */

test("shade returns a well-formed #rrggbb string for any legal percent", () => {
  for (const [hex, pct] of [["#808080", 50], ["#808080", -50], ["#000000", 10], ["#ffffff", -10], ["#4fd1ff", 0]]) {
    const out = shade(hex, pct);
    assert.match(out, /^#[0-9a-f]{6}$/, `shade(${hex}, ${pct}) => ${out}`);
  }
});

test("shade lightens/darkens against known values (clamped at the 0/255 rails)", () => {
  // 50% lighten of mid-gray overshoots white and clamps rather than wrapping.
  assert.equal(shade("#808080", 50), "#ffffff");
  // 50% darken of the same mid-gray clamps near (but not at) black — 128 + round(-127.5) = 1.
  assert.equal(shade("#808080", -50), "#010101");
  // Lightening pure black by 10% is a plain, unclamped shift.
  assert.equal(shade("#000000", 10), "#1a1a1a");
  // Darkening pure white by 10% is the mirror image.
  assert.equal(shade("#ffffff", -10), "#e6e6e6");
  // percent 0 is a no-op.
  assert.equal(shade("#4fd1ff", 0), "#4fd1ff");
});

/* ---------- hexA ---------- */

test("hexA produces an rgba(r, g, b, a) string from a #rrggbb color", () => {
  assert.equal(hexA("#ffffff", 0.5), "rgba(255, 255, 255, 0.5)");
  assert.equal(hexA("#ff8000", 1), "rgba(255, 128, 0, 1)");
  assert.equal(hexA("#000000", 0), "rgba(0, 0, 0, 0)");
});

/* ---------- polygonPoints / toWorld ---------- */

test("polygonPoints(0,0,r,4,0) places a 4-gon's vertices on the axes", () => {
  const pts = polygonPoints(0, 0, 10, 4, 0);
  assert.equal(pts.length, 4);
  const [p0, p1, p2, p3] = pts;
  closeTo(p0[0], 10); closeTo(p0[1], 0);     // 0deg  -> (r, 0)
  closeTo(p1[0], 0);  closeTo(p1[1], 10);    // 90deg -> (0, r)
  closeTo(p2[0], -10); closeTo(p2[1], 0);    // 180deg -> (-r, 0)
  closeTo(p3[0], 0);  closeTo(p3[1], -10);   // 270deg -> (0, -r)
});

test("toWorld at angle 0 leaves a local point untouched, just translated", () => {
  const [x, y] = toWorld(100, 200, 0, 5, 3);
  closeTo(x, 105); closeTo(y, 203);
});

test("toWorld at 90deg rotates the local +x axis onto world +y", () => {
  const [x, y] = toWorld(0, 0, Math.PI / 2, 5, 0);
  closeTo(x, 0); closeTo(y, 5);
});

test("toWorld at 180deg flips the local +x axis onto world -x", () => {
  const [x, y] = toWorld(0, 0, Math.PI, 5, 0);
  closeTo(x, -5); closeTo(y, 0);
});

/* ---------- inView ---------- */

test("inView: a point inside the rect is in view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 50, 50), true);
});

test("inView: a point outside the rect, no radius, is not in view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 150, 50), false);
});

test("inView: radius padding pulls an otherwise-outside point back into view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 110, 50, 20), true, "radius 20 reaches back to x=90 <= maxX 100");
  assert.equal(inView(view, 110, 50, 5), false, "radius 5 only reaches x=105, still outside");
});

test("inView: a point exactly on the boundary counts as in view", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, 100, 100), true);
});

test("inView: radius padding on the low side works the same way", () => {
  const view = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  assert.equal(inView(view, -5, 50, 10), true, "x+r = 5 >= minX 0");
  assert.equal(inView(view, -15, 50, 10), false, "x+r = -5 < minX 0");
});

/* ---------- facing / position interpolation bookkeeping ---------- */
// A small hand-built fake `state`: just the Maps these helpers actually read
// (`state.units`, `state.buildings`) — no engine, no canvas.

function fakeState(units = []) {
  return {
    units: new Map(units.map(u => [u.id, u])),
    buildings: new Map(),
  };
}

test("snapshotPositions + lerpXY: interpolates between the pre-tick snapshot and the live position", () => {
  resetFacing();
  const u = { id: "u1", x: 0, y: 0 };
  const state = fakeState([u]);

  snapshotPositions(state);   // baseline: {x:0, y:0}
  u.x = 10; u.y = 0;          // the tick moved it

  const start = lerpXY(u, 0);
  closeTo(start.x, 0); closeTo(start.y, 0);

  const mid = lerpXY(u, 0.5);
  closeTo(mid.x, 5); closeTo(mid.y, 0);

  const end = lerpXY(u, 1);   // alpha >= 1 -> the live position, no interpolation
  assert.equal(end, u);
});

test("lerpXY returns the live unit directly when there's no baseline yet (just-spawned)", () => {
  resetFacing();
  const state = fakeState([]);   // u2 was never snapshotted
  const u = { id: "u2", x: 42, y: 7 };
  const pos = lerpXY(u, 0.3);
  assert.equal(pos, u, "no prevPos entry -> the live unit is returned as-is");
});

test("lerpXY snaps (doesn't interpolate) across a teleport-sized jump", () => {
  resetFacing();
  const u = { id: "u3", x: 0, y: 0 };
  const state = fakeState([u]);
  snapshotPositions(state);
  u.x = 1000; u.y = 0;   // far past the 60-unit teleport threshold in one tick
  const pos = lerpXY(u, 0.5);
  assert.equal(pos, u, "a teleport-sized move is snapped to the live position, not lerped");
});

test("updateFacing: a fresh unit defaults to facing up, then turns toward real movement", () => {
  resetFacing();
  const u = { id: "u4", x: 0, y: 0 };

  const firstAngle = updateFacing(u);
  closeTo(firstAngle, -Math.PI / 2, 1e-12);

  u.x = 10; u.y = 0;   // moved right
  const secondAngle = updateFacing(u);
  closeTo(secondAngle, 0, 1e-12);   // atan2(0, 10) === 0 -> facing +x
});

test("updateFacing: a near-stationary unit keeps its previous angle (no jitter)", () => {
  resetFacing();
  const u = { id: "u5", x: 0, y: 0 };
  updateFacing(u);
  u.x = 10; u.y = 0;
  const moved = updateFacing(u);
  u.x += 0.1;   // well under the 0.5 movement threshold
  const stillFacing = updateFacing(u);
  closeTo(stillFacing, moved, 1e-12);
});

test("pruneFacing drops entries for entities no longer in state.units/buildings", () => {
  resetFacing();
  const u = { id: "u6", x: 0, y: 0 };
  const state = fakeState([u]);
  snapshotPositions(state);
  updateFacing(u);
  assert.ok(facing.has("u6"));

  state.units.delete("u6");   // u6 "died"
  pruneFacing(state);

  assert.equal(facing.has("u6"), false, "facing entry for a dead unit is pruned");
  // Its interpolation baseline is pruned too, observable via lerpXY falling back to the live unit.
  assert.equal(lerpXY(u, 0.5), u);
});

test("pruneFacing keeps entries for entities that are still alive", () => {
  resetFacing();
  const u = { id: "u7", x: 0, y: 0 };
  const state = fakeState([u]);
  updateFacing(u);
  pruneFacing(state);
  assert.ok(facing.has("u7"), "a still-live unit's facing entry survives pruning");
});

test("resetFacing clears both the facing map and the interpolation baselines", () => {
  const u = { id: "u8", x: 0, y: 0 };
  const state = fakeState([u]);
  snapshotPositions(state);
  updateFacing(u);
  assert.ok(facing.has("u8"));

  resetFacing();

  assert.equal(facing.size, 0);
  assert.equal(lerpXY(u, 0.5), u, "no interpolation baseline survives resetFacing");
});

// --- explicitly out of scope for this fix (see scopeNotes in the task report) -----------------
// pathPoints / pathOriented / drawHealthBar all draw directly onto a CanvasRenderingContext2D
// (beginPath/moveTo/lineTo/fillRect/fillStyle) with no return value to assert on — testing them
// meaningfully needs a ctx stub recording calls, which is more "mock a canvas" than "open a
// crack" in this pure-helpers file. Skipped by design; the geometry they're built on
// (toWorld/polygonPoints) is covered above.
