import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { rigVein, locationRichness, rollTier, PLASMA_VEINS, rigInfo } from "../engine/rig.js";
import { storeTotal, storeCapOf } from "../engine/entities.js";
import { mulberry32 } from "./_helpers.js";

// A minimal endless world with a Reactor (Power for the plasma arc) and a Plasma Rig, fuelled with
// radioactives for the "nuclear to exploit" per-dig cost.
function rigWorld(seed = 1, xy = { x: 700, y: 500 }) {
  const s = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), endless: true });
  s.buildings.set(...entry(makeBuilding("reactor", "player", 600, 500)));   // energyGrants 20 > rig draw 16 → full speed
  const rig = makeBuilding("plasmarig", "player", xy.x, xy.y);
  s.buildings.set(rig.id, rig);
  s.players.player.resources.radioactives = 2000;
  return { s, rig };
}
const entry = b => [b.id, b];

// Find a rig position (scanning a row) whose vein is `want`, so a test can pin the mined commodity.
function posForVein(want) {
  for (let x = 360; x < 1500; x += 6) if (rigVein({ x, y: 500 }) === want) return { x, y: 500 };
  return { x: 700, y: 500 };
}

test("a Plasma Rig digs its vein into a FINITE output buffer, then stalls when it's full", () => {
  const { s, rig } = rigWorld(1);
  const vein = rigVein(rig);
  assert.ok(PLASMA_VEINS.includes(vein), "the rig strikes a raw vein");
  const cap = storeCapOf("plasmarig");
  assert.ok(cap > 0, "the rig has a finite output buffer");
  for (let i = 0; i < 2000; i++) tick(s, 0.1);   // plenty of time to fill with no hauler present
  assert.ok(rig.digCount > 0, "it completed dig cycles");
  assert.equal((s.players.player.resources[vein] || 0), 0, "…but nothing reaches the treasury without a hauler");
  assert.ok(storeTotal(rig) > 0, "the dug ore piles up in the rig's own buffer");
  assert.ok(storeTotal(rig) >= cap - 1e-6, "the buffer tops off to exactly capacity");
  assert.ok(rigInfo(s, rig).storeFull, "and once full the rig reports itself stalled");
  const dug = rig.digCount;
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  assert.equal(rig.digCount, dug, "a full buffer stops further digging until it's hauled off");
});

test("rig yields are deterministic: two same-seed runs fill identical buffers", () => {
  const run = () => {
    const { s, rig } = rigWorld(7);
    for (let i = 0; i < 300; i++) tick(s, 0.1);
    return { store: { ...rig.store }, digCount: rig.digCount };
  };
  const a = run(), b = run();
  assert.deepEqual(a.store, b.store, "same seed → byte-identical output buffer");
  assert.equal(a.digCount, b.digCount, "…and the same number of digs");
});

test("digging burns radioactives (nuclear to exploit) and stalls when they run out", () => {
  const { s, rig } = rigWorld(3, posForVein("ore"));   // an ORE vein, so it doesn't refill its own fuel
  assert.equal(rigVein(rig), "ore");
  s.players.player.resources.radioactives = 5;          // only a few digs' worth of nuclear
  for (let i = 0; i < 600; i++) tick(s, 0.1);
  assert.ok((s.players.player.resources.radioactives || 0) < 1.4, "radioactives are consumed down below one dig's cost");
  assert.ok((rig.store.ore || 0) > 0, "…having dug some ore into its buffer first");
  const stalledCount = rig.digCount;
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  assert.equal(rig.digCount, stalledCount, "with no radioactives left, the rig stalls — no further digs");
});

test("richness (and so the yield odds) depends on both location and planet", () => {
  assert.notEqual(locationRichness("ferros", 150, 150), locationRichness("ferros", 1250, 850),
    "different spots on one world differ in richness");
  assert.notEqual(locationRichness("ferros", 200, 200), locationRichness("forge", 200, 200),
    "the same spot differs between worlds (the planet core)");
  let poor = 0, rich = 0;
  for (let i = 0; i < 800; i++) {
    poor += rollTier({ id: "rig", digCount: i }, 0.05).mult;
    rich += rollTier({ id: "rig", digCount: i }, 0.95).mult;
  }
  assert.ok(rich > poor * 1.6, `a rich seam markedly out-yields a poor one over many digs (${rich.toFixed(0)} vs ${poor.toFixed(0)})`);
});

test("a rig's dig state + output buffer survive a save/load, and tampered values are clamped", () => {
  const { s, rig } = rigWorld(5);
  for (let i = 0; i < 80; i++) tick(s, 0.1);
  assert.ok(rig.digCount > 0);
  assert.ok(storeTotal(rig) > 0, "some ore has piled up in the buffer");
  const restored = deserializeGame(serializeGame(s));
  const rr = [...restored.buildings.values()].find(b => b.type === "plasmarig");
  assert.equal(rr.digCount, rig.digCount, "the dig counter round-trips (drives the deterministic roll)");
  assert.deepEqual(rr.store, rig.store, "the output buffer round-trips intact");

  const save = serializeGame(s);
  const saved = save.buildings.find(b => b.type === "plasmarig");
  saved.digProgress = 1e9;                           // tamper: a huge value would mint resources
  saved.store = { ore: 1e9, notacommodity: 50 };     // tamper: over-capacity + a bogus good
  const rb = [...deserializeGame(save).buildings.values()].find(b => b.type === "plasmarig");
  assert.ok(rb.digProgress <= 2, "a tampered digProgress is clamped on load");
  assert.ok(storeTotal(rb) <= storeCapOf("plasmarig"), "a tampered buffer is clamped to capacity");
  assert.equal(rb.store.notacommodity, undefined, "a bogus commodity is stripped from the buffer");
});
