import { test } from "node:test";
import assert from "node:assert/strict";
import { createFog, updateFog } from "../engine/fog.js";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { drawBuildings, drawBuildingShape, drawBuildingBars } from "../renderBuildings.js";

// A stub 2D context that no-ops any method the drawing code happens to call, instead of
// hand-enumerating the canvas API — keeps this test robust to unrelated rendering changes.
function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
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
test("drawBuildingBars does not throw for a fresh, a paused, or an unpowered factory/Rig/power station", () => {
  const fog = createFog({ width: 800, height: 600 });
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
      assert.doesNotThrow(() => drawBuildingBars(fakeCtx(), state, null, new Set()),
        `withReactor=${withReactor} paused=${paused}`);
    }
  }
});
