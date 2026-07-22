/* ============================================================
   Load-path hardening (Tier 1 review fixes). sanitizeSave() proves a payload is plain,
   bounded JSON; these tests prove the NEXT layer — that a version-valid but hostile or
   merely corrupt save can't wedge or silently poison the sim. A hand-edited file (or a
   storage-corrupted autosave) can carry an unknown entity type, a string/NaN/out-of-range
   number, a low id counter, or a bogus world roster; each used to slip past load and only
   detonate on the first tick (inside the rAF loop, after load's try/catch returned), or
   inject markup into the starmap. The deserializers now defend the boundary.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, peekEntityId } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { createGalaxy, activeState, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { deployColonyShip } from "../engine/colony.js";

// A short, real skirmish save to tamper with. Run FIRST and fully (the id counter is
// module-global) before any assertion mints ids, so the counter reflects this state.
function freshSkirmishSave(seed = 1) {
  const a = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), aiMicro: true });
  for (let i = 0; i < 120; i++) tick(a, 0.1);
  return serializeGame(a);
}
const maxNumericId = state => {
  let m = 0;
  for (const id of [...state.units.keys(), ...state.buildings.keys()]) {
    const s = /^[ub](\d+)$/.exec(id); if (s && +s[1] > m) m = +s[1];
  }
  return m;
};

test("an unknown entity type is dropped on load instead of crashing the first tick", () => {
  const save = freshSkirmishSave(11);
  const goodUnitId = save.units[0].id;
  save.units.push({ id: "u999999", type: "notarealunit", owner: "player", x: 100, y: 100, hp: 50, maxHp: 50, order: null, orderQueue: [] });
  save.buildings.push({ id: "b999999", type: "notarealbuilding", owner: "player", x: 120, y: 120, hp: 50, maxHp: 50, queue: [], constructing: false, buildProgress: 1 });

  const st = deserializeGame(save);
  assert.ok(!st.units.has("u999999"), "unknown unit type is not loaded (UNITS[type] would be undefined and throw)");
  assert.ok(!st.buildings.has("b999999"), "unknown building type is not loaded");
  assert.ok(st.units.has(goodUnitId), "a real entity beside it still loads");
  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) tick(st, 0.1); }, "the sim ticks cleanly — no undefined-def throw");
});

test("string / non-finite / out-of-range numeric fields are coerced, not propagated", () => {
  const save = freshSkirmishSave(12);
  save.time = "100";                                   // a string where a number belongs
  const u = save.units[0];
  u.x = 1e12;                                          // far past the map — must clamp
  u.y = "NaN";                                         // non-numeric string → 0
  u.hp = -5;                                           // negative → clamped to 0

  const st = deserializeGame(save);
  assert.equal(typeof st.time, "number");
  assert.equal(st.time, 100, "time is a number, so state.time += dt adds instead of concatenating");
  const cu = st.units.get(u.id);
  assert.ok(Number.isFinite(cu.x) && cu.x >= 0 && cu.x <= st.map.width, "x clamped into the map, never NaN/huge");
  assert.ok(Number.isFinite(cu.y), "y coerced to a finite number (no NaN,NaN spatial-hash bucket)");
  assert.equal(cu.hp, 0, "hp clamped to >= 0");

  // Time keeps advancing as a number (the concrete bug: "100"+0.1 = "1000.1", then unbounded).
  const before = st.time;
  tick(st, 0.1);
  assert.ok(st.time > before && Number.isFinite(st.time), "time advances numerically after load");
});

test("a low or missing nextEntityId can't mint an id that collides with a loaded entity", () => {
  const save = freshSkirmishSave(13);
  const highest = maxNumericId(deserializeGame(freshSkirmishSave(13)));  // what the live state actually holds
  assert.ok(highest > 0, "the save has real u#/b# ids");

  save.nextEntityId = 1;                               // sabotage: counter far below live ids
  const st = deserializeGame(save);
  assert.ok(peekEntityId() > maxNumericId(st), "the restored counter mints beyond every loaded id");
  const minted = makeUnit("skiff", "player", 50, 50);
  assert.ok(!st.units.has(minted.id), "a freshly minted id doesn't collide with a restored entity");

  const save2 = freshSkirmishSave(13);
  delete save2.nextEntityId;                           // missing entirely
  const st2 = deserializeGame(save2);
  assert.ok(peekEntityId() > maxNumericId(st2), "a missing counter is recomputed from the loaded ids");
});

test("aiWaveCount round-trips (continue-identically for the economy-raid cadence)", () => {
  const a = createGameState({ planetId: "ferros", seed: 9, rng: mulberry32(9), aiMicro: true });
  for (let i = 0; i < 50; i++) tick(a, 0.1);
  a.aiWaveCount = 7;
  const st = deserializeGame(serializeGame(a));
  assert.equal(st.aiWaveCount, 7, "the committed-wave counter survives a save/reload");

  const save = serializeGame(a);
  delete save.ai.aiWaveCount;                          // an old save predating the field
  assert.equal(deserializeGame(save).aiWaveCount, 0, "an old save loads with the counter defaulted to 0");
});

/* ---------- galaxy structural + roster guards ---------- */

function settledGalaxy(seed = 3) {
  const g = createGalaxy({ seed });
  for (const u of [...activeState(g).units.values()]) if (u.type === "colonyship") deployColonyShip(activeState(g), u.id);
  return g;
}

test("deserializeGalaxy throws on structural nonsense BEFORE the caller tears down the live game", () => {
  assert.throws(() => deserializeGalaxy({ v: 1, worlds: [], planets: [{ planetId: "ferros" }] }), /no worlds/);
  assert.throws(() => deserializeGalaxy({ v: 1, worlds: ["ferros"], planets: [] }), /no planets/);

  const save = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(3))));
  const orphanWorld = ODYSSEY_WORLDS.find(w => !save.planets.some(p => p.planetId === w));
  save.activeId = orphanWorld;                          // a real world id, but no planet payload for it
  assert.throws(() => deserializeGalaxy(save), /no active planet/,
    "an activeId with no planet fails at load, not after boot has torn the session down");
});

test("the world roster is filtered to real worlds — an injected id never survives load", () => {
  const save = JSON.parse(JSON.stringify(serializeGalaxy(settledGalaxy(4))));
  save.worlds.push("<img src=x onerror=alert(1)>");     // XSS payload smuggled into the roster
  save.worlds.push("totally-made-up-world");
  const g = deserializeGalaxy(save);
  assert.ok(!g.worlds.includes("<img src=x onerror=alert(1)>"), "the markup id is dropped");
  assert.ok(g.worlds.every(w => ODYSSEY_WORLDS.includes(w)), "every surviving world id is a known world (nothing reaches the starmap)");
});

test("the galaxy clock and last-relief time round-trip", () => {
  const g = settledGalaxy(5);
  g.time = 55.5;
  g.lastReliefTime = 40;
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.equal(g2.time, 55.5, "galaxy.time persists (the relief cooldown keys on it)");
  assert.equal(g2.lastReliefTime, 40, "lastReliefTime persists so the cooldown survives a reload");
});
