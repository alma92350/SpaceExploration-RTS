import { test } from "node:test";
import assert from "node:assert/strict";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { drawUnitShape } from "../renderUnits.js";
import { drawBuildingShape } from "../renderBuildings.js";

/* ============================================================
   Full-roster render smoke test with a "no silent fallback" guard (docs/improvement-
   proposals.md): iterates every UNITS/BUILDINGS key and calls the real shape dispatcher for it,
   asserting (a) the draw never throws for any type, and (b) its canvas call trace differs from
   what the SAME def would produce through the generic fallback (drawGenericUnit/
   drawGenericBuilding) — an identical trace means the type silently fell through to the generic
   diamond/hexagon instead of getting its own silhouette. Catches exactly the class of bug the
   Leviathan shipped with: a roster entry with no case in the shape dispatch, discovered only by
   noticing (or not noticing) a featureless generic shape in play. Roster-driven iteration means
   every future unit/building is covered automatically.

   fakeCtx below is test/renderBuildings.test.js's own no-op Proxy idiom —
   `new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) })` — extended to RECORD each method
   call as a (name, rounded-args) tuple instead of silently swallowing it. Everything else about
   the idiom (any ctx method/property tolerated, no hand-enumerated canvas API, robust to unrelated
   rendering changes) is unchanged.
   ============================================================ */

function round(a) { return typeof a === "number" ? Math.round(a * 100) / 100 : a; }

function fakeCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : (...args) => { calls.push([p, args.map(round)]); }),
  });
  return { ctx, calls };
}

// A type string that can never collide with a real UNITS/BUILDINGS key. Passing it as the probe
// entity's own `type` — while keeping the REAL def, so radius-driven numbers still match — forces
// drawUnitShape/drawBuildingShape's dispatch past every explicit `if (u.type === …)`/
// `if (b.type === …)` case straight to its trailing `else drawGeneric*(...)` branch, without
// needing drawGenericUnit/drawGenericBuilding themselves exported (they stay module-private).
const FALLBACK_PROBE = "__render_roster_smoke_test_fallback_probe__";

// render.js spriteIcon's own stub state for a state-reading building — electrifiedLight bails out
// on `!b.electrified` before touching either Map, so this empty-Maps stub is safe for every
// building type, exactly as spriteIcon already proves in production (render.js:76).
const STUB_STATE = { units: new Map(), buildings: new Map() };

test("every UNITS type draws without throwing, and has its own silhouette (not the generic fallback)", () => {
  for (const type of Object.keys(UNITS)) {
    const def = UNITS[type];
    const u = { id: `smoke-${type}`, type, x: 120, y: 80 };

    const real = fakeCtx();
    assert.doesNotThrow(() => drawUnitShape(real.ctx, u, def, "#4fd1ff"), `drawUnitShape threw for unit "${type}"`);

    const generic = fakeCtx();
    drawUnitShape(generic.ctx, { ...u, id: `smoke-generic-${type}`, type: FALLBACK_PROBE }, def, "#4fd1ff");

    assert.notDeepEqual(real.calls, generic.calls,
      `unit "${type}" has no bespoke silhouette — its draw trace is IDENTICAL to drawGenericUnit's for the same def, meaning it silently fell through to the generic diamond`);
  }
});

test("every BUILDINGS type draws without throwing, and has its own silhouette (not the generic fallback)", () => {
  for (const type of Object.keys(BUILDINGS)) {
    const def = BUILDINGS[type];
    const b = { id: `smoke-${type}`, type, x: 120, y: 80, radius: def.radius };

    const real = fakeCtx();
    assert.doesNotThrow(() => drawBuildingShape(real.ctx, STUB_STATE, b, "#4fd1ff"), `drawBuildingShape threw for building "${type}"`);

    const generic = fakeCtx();
    drawBuildingShape(generic.ctx, STUB_STATE, { ...b, id: `smoke-generic-${type}`, type: FALLBACK_PROBE }, "#4fd1ff");

    assert.notDeepEqual(real.calls, generic.calls,
      `building "${type}" has no bespoke silhouette — its draw trace is IDENTICAL to drawGenericBuilding's for the same def, meaning it silently fell through to the generic hex`);
  }
});
