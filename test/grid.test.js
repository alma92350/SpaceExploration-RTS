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
