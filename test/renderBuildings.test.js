import { test } from "node:test";
import assert from "node:assert/strict";
import { createFog, updateFog } from "../engine/fog.js";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { BUILDINGS } from "../engine/entities.js";
import { drawBuildings, drawBuildingShape, drawBuildingBars } from "../renderBuildings.js";

// A stub 2D context that no-ops any method the drawing code happens to call, instead of
// hand-enumerating the canvas API — keeps this test robust to unrelated rendering changes.
function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}

// Extends test/render-roster.test.js's own richer variant: RECORDS each ctx method call as a
// (name, rounded-args) tuple instead of swallowing it, so a test can tell two draws apart — e.g.
// "did this draw something extra" or "did a numeric argument actually change" — without
// hand-enumerating the canvas API either. Also traces plain property ASSIGNMENTS (ctx.fillStyle =
// "…"), which a get-only Proxy trap can't see at all (a `ctx.fillStyle = x` assignment never calls
// `get`) — needed here because several of the cues below (electrifiedLight's own on/off colour
// swap, and the new lit/dark power-building cores that match its idiom) are ONLY a fillStyle/
// strokeStyle colour change, no differing method-call argument. `round` keeps float noise from
// making two otherwise-identical calls/sets compare unequal.
function round(a) { return typeof a === "number" ? Math.round(a * 100) / 100 : a; }
function tracedCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : (...args) => { calls.push([p, args.map(round)]); }),
    set: (t, p, v) => { calls.push([`set:${String(p)}`, round(v)]); t[p] = v; return true; },
  });
  return { ctx, calls };
}

// A state solid enough for engine/industry.js's own reads (buildingConcern, powerThrottle, …) —
// same minimal-stub idiom as test/industry.test.js's and test/combustor.test.js's own `stub`,
// just with the `time`/`units`/`fog` fields renderBuildings.js additionally touches.
function economyState(buildingDefs, time = 0) {
  const buildings = new Map();
  buildingDefs.forEach((b, i) => {
    const id = b.id || `eco${i}`;
    buildings.set(id, { id, owner: "player", constructing: false, ...b });
  });
  return {
    time,
    buildings,
    units: new Map(),
    selection: [],
    fog: createFog({ width: 400, height: 400 }),
    players: { player: { color: "#5ec8ff", upgrades: {}, resources: {} } },
  };
}

// Regression test for the crash where renderBuildings.js called drawEnemyPip without
// importing it (drawEnemyPip was a private, non-exported function in renderUnits.js):
// drawing so much as one AI-owned, fog-visible building threw a ReferenceError and,
// because engine/loop.js had no try/catch around render(), permanently killed the loop.
test("drawBuildings does not throw on a fog-visible enemy building", () => {
  const map = { width: 800, height: 600 };
  const fog = createFog(map);
  // A player unit standing right on top of the enemy building's spot so the player's
  // fog actually reveals it (drawBuildings gates non-player buildings on state.fog).
  const scout = makeUnit("worker", "player", 400, 300);
  updateFog({ map, units: new Map([[scout.id, scout]]), buildings: new Map() }, fog, "player");

  const enemyBuilding = makeBuilding("command", "ai", 400, 300);
  const state = {
    buildings: new Map([[enemyBuilding.id, enemyBuilding]]),
    units: new Map(),
    selection: [],
    fog,
    players: { player: { color: "#5ec8ff" }, ai: { color: "#ff5e5e" } },
  };

  assert.doesNotThrow(() => drawBuildings(fakeCtx(), state, null));
});

// The four ELECTRIFIABLE building types (engine/entities.js isElectrifiable: Command Center,
// Barracks, Habitat, Star Dock) each read state.time and state.players[owner] — through
// electrifiedLight's powerThrottle call — the moment `electrified` is true. Regression coverage
// for that new dependency: a real base with a mix of electrified/un-electrified buildings, with
// and without a Reactor on the grid (throttle 1 vs 0 — both code paths through electrifiedLight),
// must never throw.
test("drawBuildings does not throw for electrified Command Center / Barracks / Habitat / Star Dock, powered or not", () => {
  const types = ["command", "barracks", "habitat", "stardock"];
  for (const withReactor of [true, false]) {
    const buildings = new Map();
    types.forEach((t, i) => {
      const b = makeBuilding(t, "player", 100 + i * 60, 100);
      b.electrified = true;
      buildings.set(b.id, b);
    });
    if (withReactor) {
      const r = makeBuilding("reactor", "player", 100, 100);
      buildings.set(r.id, r);
    }
    const state = {
      time: 12.34,
      buildings,
      units: new Map(),
      selection: [],
      fog: createFog({ width: 800, height: 600 }),
      players: { player: { color: "#5ec8ff", upgrades: {} } },
    };
    assert.doesNotThrow(() => drawBuildings(fakeCtx(), state, null),
      `withReactor=${withReactor}`);
  }
});

// Observer Mode (observer.js): a free-look spectator that reveals fog on whichever world it's
// pointed at. drawBuildings' trailing observerMode param (default false, so every test above is
// unaffected) bypasses the owner/fog gate entirely — a pure render-time flag, never a mutation
// of state.fog itself.
test("observerMode bypasses the fog gate — an unrevealed enemy building draws only when spectating", () => {
  const enemyBuilding = makeBuilding("command", "ai", 400, 300);
  const state = {
    buildings: new Map([[enemyBuilding.id, enemyBuilding]]),
    units: new Map(),
    selection: [],
    fog: createFog({ width: 800, height: 600 }),   // fresh — nothing revealed anywhere
    players: { player: { color: "#5ec8ff" }, ai: { color: "#ff5e5e" } },
  };

  const hidden = tracedCtx();
  drawBuildings(hidden.ctx, state, null);
  assert.equal(hidden.calls.length, 0, "a fogged enemy building draws nothing by default");

  const revealed = tracedCtx();
  drawBuildings(revealed.ctx, state, null, true);
  assert.ok(revealed.calls.length > 0, "the same building draws once observerMode bypasses the fog gate");
});

// drawBuildingShape is ALSO called by render.js's spriteIcon (the HUD button art) with a stub
// state that has no `players`/`time` at all — only safe because electrifiedLight bails out on
// `!b.electrified` before ever touching either. Pin that: the exact stub shape spriteIcon builds,
// for every electrifiable type, must not throw.
test("drawBuildingShape tolerates the icon stub state (no players/time) for every electrifiable type — the un-electrified icon path", () => {
  for (const t of ["command", "barracks", "habitat", "stardock"]) {
    const stub = { units: new Map(), buildings: new Map() };   // exactly what render.js spriteIcon passes
    const b = { id: "__icon__", type: t, x: 0, y: 0, radius: 16 };   // no `electrified` key, like the real icon stub
    assert.doesNotThrow(() => drawBuildingShape(fakeCtx(), stub, b, "#5ec8ff"), t);
  }
});

// drawBuildingBars now also stamps a paused/stalled/throttled concern badge (engine/industry.js
// buildingConcern) next to every own producer's health bar — regression coverage that the new call
// doesn't throw across the states buildingConcern actually branches on: paused, unpowered (no
// Reactor at all), and a freshly-built factory/Rig that hasn't received any input/fuel yet (no
// `input`/`store` keys set) — the most common real-game shape, and the one most likely to trip an
// unguarded property read.
test("drawBuildingBars draws real output, and a paused producer is drawn differently (C8)", () => {
  const fog = createFog({ width: 800, height: 600 });
  const pausedCalls = {};
  for (const withReactor of [true, false]) {
    for (const paused of [true, false]) {
      const buildings = new Map();
      const reactorB = makeBuilding("reactor", "player", 0, 0);
      if (withReactor) buildings.set(reactorB.id, reactorB);
      for (const t of ["smelter", "plasmarig", "combustor"]) {
        const b = makeBuilding(t, "player", 60, 0);
        b.paused = paused;
        buildings.set(b.id, b);
      }
      const state = {
        buildings,
        units: new Map(),
        selection: [],
        fog,
        players: { player: { color: "#5ec8ff", upgrades: {}, resources: { radioactives: 50 } } },
      };
      // Not just doesNotThrow: replacing drawBuildingBars' body with `return;` used to SURVIVE the
      // full suite, so every health bar, build-progress bar, output gauge and paused/stalled badge
      // in the game could vanish with CI green. This file's recording ctx already exists — use it.
      const { ctx, calls } = tracedCtx();
      assert.doesNotThrow(() => drawBuildingBars(ctx, state, null, new Set()),
        `withReactor=${withReactor} paused=${paused}`);
      assert.ok(calls.length > 0,
        `drawBuildingBars must actually draw something (withReactor=${withReactor} paused=${paused})`);
      if (withReactor) pausedCalls[String(paused)] = calls.length;
    }
  }
  // A paused producer must be drawn DIFFERENTLY from a running one — that badge is the player's
  // only signal that a factory has stalled. (Not "more calls": a running-but-throttled factory
  // draws the busier badge of the two.)
  assert.notEqual(pausedCalls["true"], pausedCalls["false"],
    `a paused producer must draw a different badge from a running one — got ${pausedCalls["true"]} ` +
    `calls paused vs ${pausedCalls["false"]} running`);
});

/* ============================================================
   Bespoke power-plant hulls + the deterministic "working" pulse
   (docs/improvement-proposals.md "Bespoke power-plant hulls and a deterministic 'working' pulse
   for running factories"): the Reactor / Combustion Generator / Biomass Reactor stop sharing the
   generic glyph-disc hex every recipe factory uses, and a genuinely running recipe factory gets a
   subtle work-pulse glow the way electrifiedLight already glows an electrified building.
   ============================================================ */

// Before this change, all three power buildings fell through to the shared drawFactory glyph-disc
// hex (BUILDING_GLYPH ⚡/🔥/🌿 stamped as emoji text). They're the grid, not a recipe factory, so
// they should now render bespoke vector art instead — no emoji text call at all.
test("Reactor, Combustion Generator, and Biomass Reactor get bespoke silhouettes, not the shared emoji-glyph disc", () => {
  const stub = { units: new Map(), buildings: new Map() };
  for (const type of ["reactor", "combustor", "biomassreactor"]) {
    const b = { id: `smoke-${type}`, type, x: 0, y: 0, radius: BUILDINGS[type].radius };
    const { ctx, calls } = tracedCtx();
    drawBuildingShape(ctx, stub, b, "#5ec8ff");
    assert.ok(!calls.some(([name]) => name === "fillText"),
      `${type} should render bespoke vector art, not the shared BUILDING_GLYPH emoji disc (fillText)`);
  }
});

// The three power buildings' own bespoke hulls should read their `powered` state directly (the
// same "is it actually fed" signal hudSelection.js's panel already shows as `!gen.paused &&
// gen.powered`) — a lit core/flame/vat glow, not a fixture that looks identical whether the grid
// is humming or stone dead.
test("Reactor, Combustion Generator, and Biomass Reactor hulls visibly differ between powered and unfed", () => {
  const stub = { units: new Map(), buildings: new Map() };
  for (const type of ["reactor", "combustor", "biomassreactor"]) {
    const lit = { id: `lit-${type}`, type, x: 0, y: 0, radius: BUILDINGS[type].radius, powered: true };
    const dark = { id: `dark-${type}`, type, x: 0, y: 0, radius: BUILDINGS[type].radius, powered: false };
    const a = tracedCtx(); drawBuildingShape(a.ctx, stub, lit, "#5ec8ff");
    const b = tracedCtx(); drawBuildingShape(b.ctx, stub, dark, "#5ec8ff");
    assert.notDeepEqual(a.calls, b.calls, `${type}'s hull should read powered vs unfed`);
  }
});

// A recipe factory (Smelter — completed, unpaused, fed, buffer clear, full power) should draw
// something extra a starved/paused/still-constructing one doesn't: the work-pulse glow. Note that
// buildingConcern ITSELF reads null both while genuinely running AND while constructing/recycling
// (nothing to flag yet either way) — so "running" has to gate on completion independently, not
// trust a bare `buildingConcern === null`.
test("a genuinely running recipe factory draws an extra work-pulse a starved/paused/constructing one doesn't", () => {
  const reactorDef = { id: "r1", type: "reactor", x: 0, y: 0, radius: BUILDINGS.reactor.radius, powered: true };
  const smelterDef = { id: "s1", type: "smelter", x: 40, y: 0, radius: BUILDINGS.smelter.radius, input: { ore: 100 } };

  const runningState = economyState([reactorDef, smelterDef]);
  const running = runningState.buildings.get("s1");
  const runningTrace = tracedCtx();
  drawBuildingShape(runningTrace.ctx, runningState, running, "#5ec8ff");

  const cases = {
    starved: { ...smelterDef, input: { ore: 0 } },
    paused: { ...smelterDef, paused: true },
    constructing: { ...smelterDef, constructing: true },
  };
  for (const [label, def] of Object.entries(cases)) {
    const state = economyState([reactorDef, def]);
    const b = state.buildings.get("s1");
    const trace = tracedCtx();
    drawBuildingShape(trace.ctx, state, b, "#5ec8ff");
    assert.notDeepEqual(runningTrace.calls, trace.calls,
      `a running factory should draw something a ${label} one doesn't (the work pulse)`);
  }
});

// The pulse is a slow CYCLE, driven by state.time — not a one-shot "running = lit" flag — so the
// same genuinely-running factory must render differently at different points in time (else it's a
// static overlay, not a "pulse").
test("the work pulse animates with state.time, not a static overlay", () => {
  const reactorDef = { id: "r1", type: "reactor", x: 0, y: 0, radius: BUILDINGS.reactor.radius, powered: true };
  const smelterDef = { id: "s1", type: "smelter", x: 40, y: 0, radius: BUILDINGS.smelter.radius, input: { ore: 100 } };
  const traces = [0, 1, 2, 3].map(time => {
    const state = economyState([reactorDef, { ...smelterDef }], time);
    const { ctx, calls } = tracedCtx();
    drawBuildingShape(ctx, state, state.buildings.get("s1"), "#5ec8ff");
    return JSON.stringify(calls);
  });
  assert.ok(new Set(traces).size > 1, "the glow should read differently across different state.time values");
});

// The pulse is scoped to RECIPE factories specifically (buildingConcern reads null for a
// non-recipe, non-rig building unconditionally — e.g. the Datacenter — which would make a naive
// `buildingConcern === null` check pulse a building that never runs anything at all).
test("the work pulse never fires for a non-recipe building sharing the glyph-disc hex (Datacenter)", () => {
  const dcDef = { id: "d1", type: "datacenter", x: 0, y: 0, radius: BUILDINGS.datacenter.radius };
  const s0 = economyState([dcDef], 0);
  const s1 = economyState([{ ...dcDef }], 50);   // a very different state.time
  const a = tracedCtx(); drawBuildingShape(a.ctx, s0, s0.buildings.get("d1"), "#5ec8ff");
  const b = tracedCtx(); drawBuildingShape(b.ctx, s1, s1.buildings.get("d1"), "#5ec8ff");
  assert.deepEqual(a.calls, b.calls, "a Datacenter runs no recipe, so its render must be time-invariant — no stray pulse");
});

// render.js's spriteIcon (the HUD build-menu button art) draws EVERY building type, including
// recipe factories, through a stub state with no players/time/owner at all (render.js:76). The new
// running-pulse check reaches into buildingConcern, which reaches into state.players[owner] — this
// pins that the icon path still can't throw for a recipe factory now that that lookup exists.
test("drawBuildingShape tolerates the icon stub state (no players/time/owner) for every recipe factory type", () => {
  const stub = { units: new Map(), buildings: new Map() };
  for (const t of ["smelter", "assembler", "chipfab", "machineworks", "antimatterforge", "aifoundry", "torpedoworks"]) {
    const b = { id: "__icon__", type: t, x: 0, y: 0, radius: BUILDINGS[t].radius };
    assert.doesNotThrow(() => drawBuildingShape(fakeCtx(), stub, b, "#5ec8ff"), t);
  }
});

test("drawBuildingBars draws a health bar for a damaged building (C8)", () => {
  // The mutation that used to survive the whole suite: `return;` at the top of drawBuildingBars.
  // Nothing asserted that a bar is ever drawn, so every health bar, build-progress bar and output
  // gauge in the game could vanish with CI green on both Node versions.
  const fog = createFog({ width: 800, height: 600 });
  const b = makeBuilding("barracks", "player", 60, 0);
  b.hp = Math.round(b.maxHp * 0.4);
  const state = {
    buildings: new Map([[b.id, b]]),
    units: new Map(),
    selection: [],
    fog,
    players: { player: { color: "#5ec8ff", upgrades: {}, resources: {} } },
  };
  const { ctx, calls } = tracedCtx();
  drawBuildingBars(ctx, state, null, new Set());
  assert.ok(calls.some(c => c[0] === "fillRect"),
    "a damaged building must get a health bar — this is the assertion the doesNotThrow-only test lacked");
});
