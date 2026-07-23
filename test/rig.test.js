import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { rigVein, locationRichness, rollTier, rigSurvey, PLASMA_VEINS, rigInfo } from "../engine/rig.js";
import { storeTotal, storeCapOf } from "../engine/entities.js";
import { mulberry32 } from "./_helpers.js";

// A minimal endless world with a Reactor (Power for the plasma arc) and a Plasma Rig, fuelled with
// radioactives for the "nuclear to exploit" per-dig cost. `place` is a position, or a function of the
// built state (used to scan for a spot whose surface-biased vein is a specific commodity).
function rigWorld(seed = 1, place = { x: 700, y: 500 }) {
  const s = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), endless: true });
  s.buildings.set(...entry(makeBuilding("reactor", "player", 600, 500)));   // energyGrants 20 > rig draw 16 → full speed
  const xy = typeof place === "function" ? place(s) : place;
  const rig = makeBuilding("plasmarig", "player", xy.x, xy.y);
  s.buildings.set(rig.id, rig);
  s.players.player.resources.radioactives = 2000;
  return { s, rig };
}
const entry = b => [b.id, b];

// Find a rig position (scanning a grid) whose surface-biased vein is `want`, so a test can pin the
// mined commodity. The vein now depends on the map's nodes, so this scans within a real state.
function posForVein(s, want) {
  for (let y = 250; y < 950; y += 40)
    for (let x = 250; x < 1600; x += 20)
      if (rigVein(s, { x, y }) === want) return { x, y };
  return { x: 700, y: 500 };
}

test("a Plasma Rig digs its vein into a FINITE output buffer, then stalls when it's full", () => {
  const { s, rig } = rigWorld(1, st => posForVein(st, "ore"));   // an ore vein, distinct from the pre-loaded radioactives fuel
  const vein = rigVein(s, rig);
  assert.equal(vein, "ore", "the rig strikes a raw vein");
  assert.ok(PLASMA_VEINS.includes(vein));
  const cap = storeCapOf("plasmarig");
  assert.ok(cap > 0, "the rig has a finite output buffer");
  const treasuryBefore = s.players.player.resources[vein] || 0;   // the starting stockpile (no workers to gather)
  for (let i = 0; i < 2000; i++) tick(s, 0.1);   // plenty of time to fill with no hauler present
  assert.ok(rig.digCount > 0, "it completed dig cycles");
  assert.equal((s.players.player.resources[vein] || 0), treasuryBefore, "…but nothing the rig dug reaches the treasury without a hauler");
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
  const { s, rig } = rigWorld(3, st => posForVein(st, "ore"));   // an ORE vein, so it doesn't refill its own fuel
  assert.equal(rigVein(s, rig), "ore");
  s.players.player.resources.radioactives = 5;          // only a few digs' worth of nuclear
  for (let i = 0; i < 600; i++) tick(s, 0.1);
  assert.ok((s.players.player.resources.radioactives || 0) < 1.4, "radioactives are consumed down below one dig's cost");
  assert.ok((rig.store.ore || 0) > 0, "…having dug some ore into its buffer first");
  const stalledCount = rig.digCount;
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  assert.equal(rig.digCount, stalledCount, "with no radioactives left, the rig stalls — no further digs");
});

test("richness (and so the yield odds) depends on both location and planet", () => {
  const fer = createGameState({ planetId: "ferros", endless: true });
  const forge = createGameState({ planetId: "forge", endless: true });
  assert.notEqual(locationRichness(fer, 150, 150), locationRichness(fer, 1250, 850),
    "different spots on one world differ in richness");
  assert.notEqual(locationRichness(fer, 200, 200), locationRichness(forge, 200, 200),
    "the same spot differs between worlds (the planet core)");
  let poor = 0, rich = 0;
  for (let i = 0; i < 800; i++) {
    poor += rollTier({ id: "rig", digCount: i }, 0.05).mult;
    rich += rollTier({ id: "rig", digCount: i }, 0.95).mult;
  }
  assert.ok(rich > poor * 1.6, `a rich seam markedly out-yields a poor one over many digs (${rich.toFixed(0)} vs ${poor.toFixed(0)})`);
});

// ---- surface deposits are the cue: an educated guess, not a blind gamble --------------------
const stub = (nodes) => ({ map: { nodes }, planetId: "ferros" });
const oreField = [
  { com: "ore", max: 700, amount: 700, x: 700, y: 500 },
  { com: "ore", max: 700, amount: 700, x: 722, y: 512 },
  { com: "ore", max: 700, amount: 700, x: 686, y: 486 },
];

test("surface deposits bias the vein — a rig among ore fields usually strikes ore", () => {
  const st = stub(oreField);
  let ore = 0, total = 0;
  for (let dx = -48; dx <= 48; dx += 8)
    for (let dy = -48; dy <= 48; dy += 8) { total++; if (rigVein(st, { x: 700 + dx, y: 500 + dy }) === "ore") ore++; }
  assert.ok(ore / total > 0.7, `most spots amid an ore field strike ore (${ore}/${total})`);
  // …but not EVERY one — the hashed floor still leaves room for a surprise, so it's a guess.
  assert.ok(ore < total, "the read is a bias, not a certainty");
});

test("a rig's vein is stable as the surface deposit depletes (reads node.max, not current amount)", () => {
  const nodes = [{ com: "crystals", max: 700, amount: 700, x: 700, y: 500 }];
  const st = stub(nodes);
  const before = rigVein(st, { x: 705, y: 505 });
  nodes[0].amount = 0;   // fully mined out
  assert.equal(rigVein(st, { x: 705, y: 505 }), before, "the vein doesn't drift once the surface deposit is exhausted");
});

test("a resource-dense spot digs a richer seam than a barren one at the same tile", () => {
  const dense = locationRichness(stub(oreField), 700, 500);
  const barren = locationRichness(stub([]), 700, 500);
  assert.ok(dense > barren, `dense surface enriches the seam (${dense.toFixed(2)} > ${barren.toFixed(2)})`);
});

test("rigSurvey reads the visible surface: a best-guess vein + richness, or a blind spot when barren", () => {
  const survey = rigSurvey([{ com: "crystals", max: 600, amount: 600, x: 706, y: 500 }], "ferros", 700, 500);
  assert.equal(survey.likelyVein, "crystals", "the visible deposit sets the best guess");
  assert.ok(survey.confidence > 0.5, "and a lone nearby deposit reads as confident");
  assert.ok(["poor", "fair", "rich", "mother lode"].includes(survey.richLabel));

  const blind = rigSurvey([], "ferros", 700, 500);
  assert.equal(blind.likelyVein, null, "no visible surface → a blind gamble");
  assert.equal(blind.confidence, 0);
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
