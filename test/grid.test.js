import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUnitGrid, queryNeighbors } from "../engine/grid.js";

function gridOf(pts) {
  const units = new Map();
  pts.forEach((p, i) => units.set(p.id ?? `u${i}`, { id: p.id ?? `u${i}`, x: p.x, y: p.y }));
  return { units, grid: buildUnitGrid({ units }), list: [...units.values()] };
}

test("buildUnitGrid assigns stable Map-order indices for deterministic pair processing", () => {
  const { list } = gridOf([{ x: 10, y: 10 }, { x: 20, y: 20 }, { x: 300, y: 300 }]);
  assert.deepEqual(list.map(u => u._gi), [0, 1, 2], "each unit gets its Map-order index");
});

test("queryNeighbors is a SUPERSET: it never misses a unit within the radius", () => {
  // A scatter dense enough to span many cells (CELL is 96 internally).
  const pts = Array.from({ length: 300 }, (_, i) => ({ id: `u${i}`, x: (i * 37) % 800, y: (i * 53) % 600 }));
  const { grid, list } = gridOf(pts);
  const cx = 400, cy = 300, r = 120;

  const candidates = new Set(queryNeighbors(grid, cx, cy, r).map(u => u.id));
  const truth = list.filter(u => Math.hypot(u.x - cx, u.y - cy) <= r);

  assert.ok(truth.length > 0, "fixture sanity: some units really are in range");
  for (const u of truth) {
    assert.ok(candidates.has(u.id), `${u.id} is within ${r} of the query point but was not returned`);
  }
});

test("queryNeighbors excludes far cells — it's a local lookup, not a full scan", () => {
  const { grid } = gridOf([{ id: "near", x: 100, y: 100 }, { id: "far", x: 5000, y: 5000 }]);
  const ids = queryNeighbors(grid, 100, 100, 50).map(u => u.id);
  assert.ok(ids.includes("near"));
  assert.ok(!ids.includes("far"), "a unit cells away is not a candidate");
});

test("queryNeighbors is deterministic — same grid and query give the same order", () => {
  const pts = Array.from({ length: 60 }, (_, i) => ({ id: `u${i}`, x: (i * 13) % 400, y: (i * 29) % 400 }));
  const { grid } = gridOf(pts);
  assert.deepEqual(
    queryNeighbors(grid, 150, 150, 180).map(u => u.id),
    queryNeighbors(grid, 150, 150, 180).map(u => u.id),
  );
});

test("queryNeighbors returns a REUSED buffer — a second call invalidates the first result (C15)", () => {
  // Turns an implicit comment into an executable contract. engine/grid.js's _scratch is a
  // module-global array cleared on every call, and its comment states the invariant callers rely on:
  // "none makes a second queryNeighbors call while a prior result is still being iterated". Two
  // call sites hold the buffer ACROSS a loop body (separation.js's applySeparation iterates up to 40
  // entries calling separatePair; movement.js's senseLateralAvoidance walks the whole candidate
  // list), so adding one grid-based helper inside either would silently corrupt the outer iteration.
  // The failure mode — "some pairs randomly skip separation" — is DETERMINISTICALLY wrong in both
  // runs, so no determinism test can see it.
  const state = { units: new Map() };
  for (let i = 0; i < 6; i++) {
    const u = { id: `u${i}`, x: 100 + i * 5, y: 100, hp: 10, owner: "player" };
    state.units.set(u.id, u);
  }
  const g = buildUnitGrid(state);
  const first = queryNeighbors(g, 100, 100, 50);
  const firstContents = [...first];
  const second = queryNeighbors(g, 5000, 5000, 50);
  assert.equal(first, second,
    "same array identity — this reuse IS the documented contract, which is why a caller must not " +
    "hold a result across another query");
  assert.notDeepEqual(firstContents, [...second],
    "fixture sanity: the two queries really do have different answers, so the aliasing is observable");
});
