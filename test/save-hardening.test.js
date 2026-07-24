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
import { createGameState, makeUnit, makeBuilding, peekEntityId } from "../engine/state.js";
import { UNITS } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { updateProductionQueue } from "../engine/production.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { createGalaxy, activeState, stepGalaxy, checkGalaxyRescue, ODYSSEY_WORLDS } from "../engine/galaxy.js";
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

test("a corrupt production queue is sanitised on load and never bricks the game (B2)", () => {
  const save = freshSkirmishSave(13);
  const cc = save.buildings.find(b => b.type === "command" && b.owner === "player");
  // A real job, a bogus-unitType job (would deref undefined.buildTime and throw on EVERY tick →
  // bricked autosave), and an out-of-range progress.
  cc.queue = [{ unitType: "worker", progress: 0.5 }, { unitType: "☠notaunit", progress: 999 }];
  // A producer building whose queue isn't even an array must load as an empty queue, not blow up.
  save.buildings.push({ id: "b888888", type: "barracks", owner: "player", x: 240, y: 240,
    hp: 500, maxHp: 500, constructing: false, buildProgress: 1, queue: "haxx",
    attackTimer: 0, targetId: null, rally: { x: 240, y: 240 } });

  const st = deserializeGame(save);
  const cc2 = [...st.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  assert.ok(cc2.queue.every(j => UNITS[j.unitType]), "no bogus unitType survived the load");
  assert.ok(cc2.queue.every(j => j.progress >= 0 && j.progress <= 1), "progress clamped to [0,1]");
  assert.ok(cc2.queue.some(j => j.unitType === "worker"), "the real job was kept");
  assert.deepEqual(st.buildings.get("b888888").queue, [], "a non-array queue became an empty array");
  assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) tick(st, 0.1); }, "the loaded game ticks cleanly — no undefined-def brick");
});

test("updateProductionQueue drops an unknown-unitType job instead of crashing (B2 runtime guard)", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, rng: mulberry32(3) });
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.queue = [{ unitType: "notaunit", progress: 0 }, { unitType: "worker", progress: 0 }];
  assert.doesNotThrow(() => updateProductionQueue(s, cc, 0.1));
  assert.equal(cc.queue[0]?.unitType, "worker", "the bogus job was shifted off; the real one advances");
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
  a.ai.waveCount = 7;
  const st = deserializeGame(serializeGame(a));
  assert.equal(st.ai.waveCount, 7, "the committed-wave counter survives a save/reload");

  const save = serializeGame(a);
  delete save.ai.aiWaveCount;                          // an old save predating the field (wire key stays aiWaveCount)
  assert.equal(deserializeGame(save).ai.waveCount, 0, "an old save loads with the counter defaulted to 0");
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
  // The living galaxy instantiates every world, so manufacture an orphan: drop one world's payload,
  // then point activeId at it — a real world id with no planet payload.
  const orphanWorld = save.planets[save.planets.length - 1].planetId;
  save.planets = save.planets.filter(p => p.planetId !== orphanWorld);
  save.activeId = orphanWorld;
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

/* ---------- Tier-1b hardening: wonder charge, order/cargo, g-id counter, research queue, transient strip ---------- */

test("a wonder's charge is clamped into [0,1] on load — a hand-edited charge can't slip in (B3)", () => {
  const save = freshSkirmishSave(21);
  // Smuggle a completed Antimatter Gate (the wonder) with an over-range charge — a hand-edit that,
  // left unchecked, reads as "already fully charged" (engine/victory.js checkEndlessWin fires at
  // charge >= 1). Alongside it, a Gate at a VALID mid-charge that must round-trip untouched (identity).
  save.buildings.push({ id: "b777777", kind: "building", type: "antimatter_gate", owner: "player",
    x: 300, y: 300, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: 5 });
  save.buildings.push({ id: "b777778", kind: "building", type: "antimatter_gate", owner: "player",
    x: 360, y: 360, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: 0.4 });

  const st = deserializeGame(save);
  assert.equal(st.buildings.get("b777777").charge, 1, "an over-range charge (5) clamps to the [0,1] ceiling");
  assert.equal(st.buildings.get("b777778").charge, 0.4, "a legitimately-saved charge is left exactly as-is (identity)");

  // A negative and a non-numeric charge are coerced too.
  const save2 = freshSkirmishSave(22);
  save2.buildings.push({ id: "b777779", kind: "building", type: "antimatter_gate", owner: "player",
    x: 300, y: 300, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: -3 });
  save2.buildings.push({ id: "b777780", kind: "building", type: "antimatter_gate", owner: "player",
    x: 340, y: 340, hp: 1200, maxHp: 1200, constructing: false, buildProgress: 1, queue: [], charge: "9" });
  const st2 = deserializeGame(save2);
  assert.equal(st2.buildings.get("b777779").charge, 0, "a negative charge clamps to 0");
  assert.equal(st2.buildings.get("b777780").charge, 1, "a non-numeric string charge coerces then clamps to 1");
});

test("a tampered order coord and a bad cargo are coerced; the loaded game ticks with no NaN positions (B5)", () => {
  const save = freshSkirmishSave(23);
  const workers = save.units.filter(u => u.type === "worker" && u.owner === "player");
  assert.ok(workers.length >= 2, "the fixture has player workers to tamper with");
  const w1 = workers[0], w2 = workers[1];
  // A move order aimed far off the map, plus a queued waypoint at NaN — both must clamp to a finite
  // in-map coord so stepToward can't drive the unit's position to NaN and poison the spatial hash.
  w1.order = { type: "move", x: 1e12, y: -500 };
  w1.orderQueue = [{ type: "move", x: NaN, y: 9e9 }];
  w1.cargo = { com: "ore", qty: NaN };                  // a NaN haul → coerced to a finite >= 0
  w2.cargo = { com: "☠notacommodity", qty: 5 };    // a bogus commodity → the whole cargo is dropped

  const st = deserializeGame(save);
  const cu1 = st.units.get(w1.id), cu2 = st.units.get(w2.id);
  assert.ok(Number.isFinite(cu1.order.x) && cu1.order.x >= 0 && cu1.order.x <= st.map.width, "order.x clamped into the map");
  assert.ok(Number.isFinite(cu1.order.y) && cu1.order.y >= 0 && cu1.order.y <= st.map.height, "order.y clamped into the map");
  assert.ok(Number.isFinite(cu1.orderQueue[0].x) && Number.isFinite(cu1.orderQueue[0].y), "a queued waypoint's coords are clamped too");
  assert.ok(Number.isFinite(cu1.cargo.qty) && cu1.cargo.qty >= 0, "cargo qty coerced to a finite >= 0");
  assert.equal(cu2.cargo, null, "a cargo naming a commodity that doesn't exist is dropped entirely");

  // The loaded game ticks cleanly, and no unit position ever becomes NaN (the concrete failure a NaN
  // order coord causes: stepToward drives x/y to NaN, wedging the sim on the first frame).
  assert.doesNotThrow(() => { for (let i = 0; i < 40; i++) tick(st, 0.1); }, "the loaded game ticks with no throw");
  for (const u of st.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y), `unit ${u.id} has finite coords after ticking`);
});

test("a galaxy save with a low/missing entitySeq but a live 'g' entity mints no colliding id (B4)", () => {
  const g = createGalaxy({ seed: 31 });
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  // Simulate an in-flight g-scheme entity already live in the save (a prior jump's rider, or a relief
  // ship), with a g-id ABOVE the saved entitySeq — the exact shape a hand-edited or pre-fix save carries.
  const activePayload = save.planets.find(p => p.planetId === save.activeId);
  activePayload.units.push({ id: "g1", kind: "unit", type: "skiff", owner: "ai",
    x: 300, y: 300, hp: 80, maxHp: 80, order: null, orderQueue: [], cargo: null });
  delete save.entitySeq;   // missing entirely — the pre-fix path restored it to 0, so the NEXT mint was "g1"

  const g2 = deserializeGalaxy(save);
  const active = activeState(g2);
  assert.ok(active.units.has("g1"), "the live g-entity survived the load");
  const ghost = active.units.get("g1");

  // Strip every player foothold so checkGalaxyRescue dispatches a fresh relief colony ship, minted as
  // 'g'+(++entitySeq). With entitySeq recomputed past g1 it lands on "g2" — never overwriting "g1".
  for (const st of g2.planets.values()) {
    for (const [id, u] of [...st.units]) if (u.owner === "player") st.units.delete(id);
    for (const [id, b] of [...st.buildings]) if (b.owner === "player") st.buildings.delete(id);
  }
  g2.lastReliefTime = null;   // clear any cooldown so relief fires now
  checkGalaxyRescue(g2);

  assert.strictEqual(active.units.get("g1"), ghost, "the existing g-entity was NOT clobbered by the mint");
  const relief = [...active.units.values()].find(u => u.owner === "player" && u.type === "colonyship");
  assert.ok(relief, "a relief colony ship really was dispatched");
  assert.notEqual(relief.id, "g1", "…under a fresh, non-colliding g-id");
});

test("a non-array researchQueue coerces to [] and a bogus techId job is dropped on load (#4)", () => {
  // researchQueue:5 → updateResearch does .length/.shift on a number and bricks the game on load.
  const g = createGalaxy({ seed: 41 });
  const dc = makeBuilding("datacenter", "player", 600, 500);
  activeState(g).buildings.set(dc.id, dc);
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  save.planets.find(p => p.planetId === save.activeId).buildings.find(b => b.id === dc.id).researchQueue = 5;
  const restored = deserializeGalaxy(save);
  const rdc = [...activeState(restored).buildings.values()].find(b => b.id === dc.id);
  assert.deepEqual(rdc.researchQueue, [], "researchQueue:5 became an empty array, not a first-tick crash");
  assert.doesNotThrow(() => { for (let i = 0; i < 20; i++) stepGalaxy(restored, 0.1); }, "the loaded galaxy ticks — updateResearch doesn't deref a number");

  // A real array carrying a bogus-techId job (and out-of-range progress) drops the bad job, keeps the good.
  const g2 = createGalaxy({ seed: 42 });
  const dc2 = makeBuilding("datacenter", "player", 600, 500);
  dc2.researchQueue = [{ techId: "metallurgy", progress: 0.5 }, { techId: "notatech", progress: 999 }];
  activeState(g2).buildings.set(dc2.id, dc2);
  const restored2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g2))));
  const rdc2 = [...activeState(restored2).buildings.values()].find(b => b.id === dc2.id);
  assert.ok(rdc2.researchQueue.every(j => TECHS[j.techId]), "no bogus techId survived the load");
  assert.ok(rdc2.researchQueue.some(j => j.techId === "metallurgy"), "the real research job was kept");
  assert.ok(rdc2.researchQueue.every(j => j.progress >= 0 && j.progress <= 1), "progress clamped to [0,1]");
});

test("a serialized building strips the rig's transient lastYield/lastTier but keeps real dig state (#5)", () => {
  const g = createGalaxy({ seed: 51 });
  const rig = makeBuilding("plasmarig", "player", 600, 500);
  rig.lastYield = 42; rig.lastTier = "overwhelming";   // transient HUD readout, stamped by the last dig
  rig.digProgress = 0.5; rig.digCount = 7;             // REAL persisted dig state
  activeState(g).buildings.set(rig.id, rig);

  const save = serializeGalaxy(g);
  const rigPayload = save.planets.find(p => p.planetId === save.activeId).buildings.find(b => b.id === rig.id);
  assert.ok(!("lastYield" in rigPayload), "lastYield is stripped from the save (transient)");
  assert.ok(!("lastTier" in rigPayload), "lastTier is stripped from the save (transient)");
  assert.equal(rigPayload.digProgress, 0.5, "digProgress is the rig's real dig state — persisted");
  assert.equal(rigPayload.digCount, 7, "…and so is digCount");
});

test("NET: a whole game state survives serialize→deserialize→serialize byte-for-byte", () => {
  // The catch-all round-trip net: any field that silently fails to persist (a forgotten strip, a
  // forgotten restore, a reshape that isn't the identity for valid data) makes the two serializations
  // diverge here — even one this suite doesn't yet name. Build a rich, real state first.
  const state = createGameState({ planetId: "ferros", seed: 7777, rng: mulberry32(7777), aiMicro: true });
  for (let i = 0; i < 300; i++) tick(state, 0.1);       // build, gather, fight, deplete nodes, reveal fog
  const once = serializeGame(state);                     // detached snapshot #1
  const twice = serializeGame(deserializeGame(once));    // load it back, then re-serialize
  assert.deepEqual(twice, once, "every persisted field round-trips — a forgotten strip/persist would diverge here");
});

test("NET (galaxy): a whole galaxy survives serialize→deserialize→serialize byte-for-byte", () => {
  const g = settledGalaxy(61);
  for (let i = 0; i < 40; i++) stepGalaxy(g, 0.1);       // let the background worlds and markets evolve
  const once = serializeGalaxy(g);
  const twice = serializeGalaxy(deserializeGalaxy(once));
  assert.deepEqual(twice, once, "the whole galaxy payload round-trips — any non-round-tripping field diverges here");
});
