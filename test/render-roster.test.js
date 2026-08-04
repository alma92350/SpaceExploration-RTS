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

/* ---- C6: every roster type, through the REAL pipeline, in every render-visible state ----------
   The probes above call drawUnitShape/drawBuildingShape with a bare {id,type,x,y} — no owner, hp,
   constructing, recycling, electrified, paused, capital, tier, armed, freight or kills — so every
   state-dependent branch in the two biggest render files is unreached, and drawUnits itself is
   exercised with exactly one unit type (Skiff, 1 of 18) anywhere in the suite. render.js's
   no-image, all-vector design means every roster addition is new drawing code, and a crash on one
   type in one state kills the whole frame — and, before A7's fix, every frame after it.
   Roster-driven so a future type or state is covered automatically. */

const UNIT_VARIANTS = {
  plain: u => u,
  enemy: u => Object.assign(u, { owner: "ai" }),
  damaged: u => Object.assign(u, { hp: Math.max(1, Math.round(u.maxHp * 0.3)) }),
  veteran: u => Object.assign(u, { kills: 9 }),
  laden: u => Object.assign(u, { cargo: { com: "ore", qty: 10 }, freight: { ore: 10 } }),
  armed: u => Object.assign(u, { armed: true }),
  recycling: u => Object.assign(u, { recycling: { progress: 0.5, time: 4 } }),
};

const BUILDING_VARIANTS = {
  plain: b => b,
  enemy: b => Object.assign(b, { owner: "ai" }),
  constructing: b => Object.assign(b, { constructing: true, buildProgress: 0.4 }),
  recycling: b => Object.assign(b, { recycling: { progress: 0.5, time: 4 } }),
  damaged: b => Object.assign(b, { hp: Math.max(1, Math.round(b.maxHp * 0.3)) }),
  electrified: b => Object.assign(b, { electrified: true }),
  paused: b => Object.assign(b, { paused: true }),
  capital: b => Object.assign(b, { capital: true }),
  tiered: b => Object.assign(b, { tier: 3 }),
  charging: b => Object.assign(b, { charge: 0.5 }),
};

test("every UNITS type survives every render-visible state through the real drawUnits pass (C6)", async () => {
  const { createGameState, makeUnit } = await import("../engine/state.js");
  const { drawUnits } = await import("../renderUnits.js");
  const st = createGameState({ planetId: "ferros", seed: 31 });
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });

  for (const type of Object.keys(UNITS)) {
    for (const [variant, apply] of Object.entries(UNIT_VARIANTS)) {
      st.units.clear();
      const u = apply(makeUnit(type, "player", 700, 500));
      st.units.set(u.id, u);
      assert.doesNotThrow(() => drawUnits(ctx, st, null, 1, new Set([u.id]), true),
        `drawUnits threw for ${type} / ${variant}`);
    }
  }
});

test("every BUILDINGS type survives every render-visible state through the real bar/hull passes (C6)", async () => {
  const { createGameState, makeBuilding } = await import("../engine/state.js");
  const { drawBuildings, drawBuildingBars } = await import("../renderBuildings.js");
  const st = createGameState({ planetId: "ferros", seed: 32 });
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });

  for (const type of Object.keys(BUILDINGS)) {
    for (const [variant, apply] of Object.entries(BUILDING_VARIANTS)) {
      st.buildings.clear();
      const b = apply(makeBuilding(type, "player", 700, 500));
      st.buildings.set(b.id, b);
      const sel = new Set([b.id]);
      assert.doesNotThrow(() => drawBuildings(ctx, st, null, sel, true), `drawBuildings threw for ${type} / ${variant}`);
      assert.doesNotThrow(() => drawBuildingBars(ctx, st, null, sel, true), `drawBuildingBars threw for ${type} / ${variant}`);
    }
  }
});

test("no two building types share a silhouette at the same radius (T2)", async () => {
  // The existing roster guard compares each type against the GENERIC fallback only, so it catches
  // "drawn as a featureless blob" but not "drawn as another real type" — the same bug with a better
  // disguise, since the player sees a silhouette either way, just the wrong one. Traced pairwise at
  // a normalized radius (so size alone can't be the distinguisher), two pairs came out byte-
  // identical in hull, glyph and colour: antimatterforge/antimatter_gate — and the Gate is the
  // Odyssey WONDER, a victory condition, rendering as a slightly larger Forge — and
  // torpedoworks/torpedobattery, where the battery is a gun that shoots back.
  const { createGameState, makeBuilding } = await import("../engine/state.js");
  const { drawBuildingShape } = await import("../renderBuildings.js");
  const st = createGameState({ planetId: "ferros", seed: 1 });

  const trace = type => {
    const calls = [];
    const ctx = new Proxy({}, {
      get: (t, p) => (...a) => { calls.push(`${String(p)}:${a.map(round).join(",")}`); return p === "measureText" ? { width: 10 } : undefined; },
      set: (t, p, v) => { calls.push(`set:${String(p)}=${v}`); return true; },
    });
    const b = makeBuilding(type, "player", 0, 0);
    b.radius = 12;                       // normalize: two types must differ by more than their size
    b.constructing = false;
    drawBuildingShape(ctx, st, b, "#5ec8ff");
    return calls.join("|");
  };

  const groups = new Map();
  for (const type of Object.keys(BUILDINGS)) {
    const key = trace(type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(type);
  }
  const collisions = [...groups.values()].filter(g => g.length > 1).map(g => g.join(" ≡ "));
  assert.deepEqual(collisions, [],
    "building type(s) drawn identically to another real type:\n" + collisions.join("\n"));
});

test("the freighter family deliberately shares one hull, and that is the ONLY unit-art sharing (T2)", async () => {
  const { createGameState, makeUnit } = await import("../engine/state.js");
  const { drawUnitShape } = await import("../renderUnits.js");
  const st = createGameState({ planetId: "ferros", seed: 1 });
  const trace = type => {
    const calls = [];
    const ctx = new Proxy({}, {
      get: (t, p) => (...a) => { calls.push(`${String(p)}:${a.map(round).join(",")}`); return p === "measureText" ? { width: 10 } : undefined; },
      set: (t, p, v) => { calls.push(`set:${String(p)}=${v}`); return true; },
    });
    const u = makeUnit(type, "player", 0, 0);
    drawUnitShape(ctx, u, { ...UNITS[type], radius: 12 }, "#5ec8ff");
    return calls.join("|");
  };
  const groups = new Map();
  for (const type of Object.keys(UNITS)) {
    const key = trace(type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(type);
  }
  // Deliberate: the cargo family is one silhouette by design, distinguished by size in play.
  const SHARED_HULLS = [["bulkfreighter", "freighter", "hauler", "heavyhauler"]];
  const shared = [...groups.values()].filter(g => g.length > 1).map(g => g.slice().sort());
  assert.deepEqual(shared, SHARED_HULLS,
    "unit-art sharing other than the allow-listed freighter family:\n" + shared.map(g => g.join(" ≡ ")).join("\n"));
});
