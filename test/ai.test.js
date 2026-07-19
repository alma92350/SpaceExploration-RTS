import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

test("the AI cycles through its archetype's exact unit mix instead of pure Skiff spam", () => {
  const state = createGameState({ planetId: "ferros" });
  const mix = state.aiArchetype.unitMix;
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  // Fund every commodity: ferros has radioactive nodes, so effectiveMix keeps
  // the economist's Breacher entry — funding only ore would stall the cycle on
  // it (queueProduction fails for lack of radioactives, and the AI retries the
  // same entry). The assertions below still expect the full, unfiltered mix.
  Object.assign(state.players.ai.resources, { ore: 100000, crystals: 100000, radioactives: 100000 });

  const builtTypes = [];
  const rounds = mix.length * 3;
  for (let i = 0; i < rounds; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) {
      builtTypes.push(barracks.queue[barracks.queue.length - 1].unitType);
      barracks.queue.length = 0;   // clear so the next think cycle queues again immediately
    }
  }

  const expected = Array.from({ length: rounds }, (_, i) => mix[i % mix.length]);
  assert.equal(builtTypes.length, rounds, "every think cycle should have queued something with ample ore");
  assert.deepEqual(builtTypes, expected);
  assert.ok(mix.includes("lancer"), "sanity check: the fixture archetype should actually include a Lancer");
});

test("the AI's attack wave includes all three combat types, not just Skiffs", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = state.aiArchetype.attackTimeout + 50;   // well past the timeout, so it commits regardless of army size

  const skiff = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  const bastion = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  const lancer = makeUnit("lancer", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(skiff.id, skiff);
  state.units.set(bastion.id, bastion);
  state.units.set(lancer.id, lancer);

  runAI(state, THINK_INTERVAL);

  assert.equal(skiff.order?.type, "attack-move");
  assert.equal(bastion.order?.type, "attack-move");
  assert.equal(lancer.order?.type, "attack-move");
});

test("the AI launches repeated attack waves, not just one", () => {
  const state = createGameState({ planetId: "ferros" });
  const archetype = state.aiArchetype;
  state.time = archetype.attackTimeout + 1;

  const waveOne = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(waveOne.id, waveOne);
  runAI(state, THINK_INTERVAL);
  assert.equal(waveOne.order?.type, "attack-move", "the first wave should commit past the timeout");
  const firstNextAttackAt = state.aiNextAttackAt;
  assert.ok(firstNextAttackAt > state.time, "committing a wave should schedule the next one instead of never attacking again");

  // Simulate that wave being wiped out, and a fresh batch produced at home
  // in the meantime -- this unit was never sent anywhere, so it's still
  // "home army" and should form the next wave once its own timeout passes.
  state.units.delete(waveOne.id);
  const waveTwo = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(waveTwo.id, waveTwo);

  state.time = firstNextAttackAt + 1;
  runAI(state, THINK_INTERVAL);

  assert.equal(waveTwo.order?.type, "attack-move", "a second, independent wave should commit once its own timeout passes");
});

test("the AI biases production toward the counter of a player army it can SEE", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  state.players.ai.resources.ore = 100000;

  // Flood a Skiff army right at the AI's doorstep, inside its Command Center's
  // sight -- so it's within the AI's fog (the initial createGameState fog pass
  // already marks these cells visible). Bastion is Skiff's hard counter (see
  // entities.js's bonusVs), so the AI, seeing them, should start reacting.
  for (let i = 0; i < 5; i++) {
    const s = makeUnit("skiff", "player", state.map.bases.ai.x - 150, state.map.bases.ai.y + i * 6);
    state.units.set(s.id, s);
  }

  const builtTypes = [];
  for (let i = 0; i < 7; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) {
      builtTypes.push(barracks.queue[barracks.queue.length - 1].unitType);
      barracks.queue.length = 0;   // clear so the next think cycle queues again immediately
    }
  }

  assert.equal(builtTypes[0], state.aiArchetype.unitMix[0], "the very first build should still follow the archetype's mix");
  assert.equal(builtTypes[3], "bastion", "the 4th unit built (the first counter-pick slot) should directly counter the seen Skiff-heavy army");
  assert.equal(builtTypes[6], "bastion", "the counter-pick recurs every 3rd unit thereafter");
});

test("the AI does NOT counter a player army it hasn't seen — no free intel", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  fundAll(state);   // fund every commodity so the plain mix (Breacher and all) completes

  // The same Skiff flood, but tucked in the player's own corner, far outside
  // any AI vision. With fog, the AI can't know the composition, so the
  // counter-pick slots must fall back to the archetype's own mix.
  for (let i = 0; i < 5; i++) {
    const s = makeUnit("skiff", "player", 100 + i, 100);
    state.units.set(s.id, s);
  }

  const built = [];
  for (let i = 0; i < 7; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) { built.push(barracks.queue[barracks.queue.length - 1].unitType); barracks.queue.length = 0; }
  }

  const mix = state.aiArchetype.unitMix;
  assert.deepEqual(built, Array.from({ length: 7 }, (_, i) => mix[i % mix.length]),
    "with the player army unseen, every slot follows the plain mix — no reactive counter");
});

// A completed Barracks the tests can drive without waiting on construction.
function stockedBarracks(state, dy = -100) {
  const b = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y + dy);
  state.buildings.set(b.id, b);
  return b;
}
function fundAll(state) {
  Object.assign(state.players.ai.resources, { ore: 100000, crystals: 100000, radioactives: 100000 });
}
function aiBuildings(state, type) {
  return [...state.buildings.values()].filter(b => b.owner === "ai" && b.type === type);
}

test("the Economist adds a second Barracks once it can afford one, and never a third", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  fundAll(state);
  stockedBarracks(state);

  for (let i = 0; i < 15; i++) runAI(state, THINK_INTERVAL);

  // economist maxBarracks is 2: the seeded one plus exactly one more, which
  // stays constructing (no tick here) so a third is never founded behind it.
  const barracks = aiBuildings(state, "barracks");
  assert.equal(barracks.length, 2);
  assert.equal(barracks.filter(b => b.constructing).length, 1);
});

test("two completed Barracks drain a single shared mix cycle", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  fundAll(state);
  const mix = state.aiArchetype.unitMix;   // ferros has every commodity, so the full economist mix survives
  const b1 = stockedBarracks(state, -100);
  const b2 = stockedBarracks(state, 100);

  const built = [];
  const rounds = mix.length * 2;
  for (let i = 0; i < rounds; i++) {
    runAI(state, THINK_INTERVAL);
    for (const b of [b1, b2]) {   // read in insertion order — the same order the shared cycle advances
      if (b.queue.length) { built.push(b.queue[b.queue.length - 1].unitType); b.queue.length = 0; }
    }
  }

  assert.equal(built.length, rounds * 2, "both barracks should have queued every round");
  const expected = Array.from({ length: built.length }, (_, i) => mix[i % mix.length]);
  assert.deepEqual(built, expected, "consecutive barracks pick up consecutive mix entries, one sequence");
});

test("a mix entry this map can't pay for is skipped, not stalled", () => {
  const state = createGameState({ planetId: "vesper", rng: () => 0.5 });   // vesper deposits no radioactives
  fundAll(state);   // even fully funded, there's simply no radioactive node to draw a Breacher's cost from
  const barracks = stockedBarracks(state);

  const built = [];
  for (let i = 0; i < 9; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) { built.push(barracks.queue[barracks.queue.length - 1].unitType); barracks.queue.length = 0; }
  }

  // balanced mix is [skiff, bastion, lancer, breacher]; vesper drops the
  // Breacher, leaving a clean three-unit cycle that never stalls on it.
  assert.deepEqual(built.slice(0, 6), ["skiff", "bastion", "lancer", "skiff", "bastion", "lancer"]);
  assert.ok(!built.includes("breacher"), "the unbuildable Breacher never enters the cycle");
});

// Zeros every ore node within HOME_RADIUS of the AI base, dropping the
// Economist's home-ore fraction under its expansion threshold.
function drainHomeOre(state) {
  for (const n of state.map.nodes) {
    if (n.com === "ore" && Math.hypot(n.x - state.map.bases.ai.x, n.y - state.map.bases.ai.y) <= 420) n.amount = 0;
  }
}

test("home-ore depletion sends the Economist to expand onto an unclaimed cluster", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.players.ai.resources.ore = 100000;
  drainHomeOre(state);

  runAI(state, THINK_INTERVAL);

  const expansions = aiBuildings(state, "command").filter(b => b.constructing);
  assert.equal(expansions.length, 1, "one expansion Command Center is now going up");
});

test("the AI banks for an expansion without starving unit production", () => {
  function drainedFerros(ore) {
    const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
    state.players.ai.resources.ore = ore;
    drainHomeOre(state);
    const barracks = stockedBarracks(state);
    return { state, barracks };
  }

  const ccCost = 400;
  const short = drainedFerros(ccCost - 50);
  runAI(short.state, THINK_INTERVAL);
  assert.equal(aiBuildings(short.state, "command").filter(b => b.constructing).length, 0,
    "with the CC unaffordable it hasn't placed the expansion it can't yet pay for");
  assert.equal(short.barracks.queue.length, 1,
    "but the army keeps flowing — the reserve pauses infrastructure, never unit production");

  const flush = drainedFerros(100000);
  runAI(flush.state, THINK_INTERVAL);
  assert.equal(aiBuildings(flush.state, "command").filter(b => b.constructing).length, 1,
    "once it can afford the CC, it plants the expansion");
});

test("the Economist fortifies with turrets on the approach vector, up to its turretCount", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  Object.assign(state.players.ai.resources, { ore: 100000, crystals: 10000 });
  stockedBarracks(state);
  const cc = aiBuildings(state, "command")[0];

  for (let i = 0; i < 12; i++) runAI(state, THINK_INTERVAL);

  const turrets = aiBuildings(state, "turret");
  assert.equal(turrets.length, 2, "economist turretCount is 2");
  for (const t of turrets) {
    assert.ok(t.x < cc.x, "turrets sit between the CC (on the right edge) and mid-map");
    assert.ok(Math.abs(t.y - cc.y) <= 120, "and hug the approach lane rather than scattering");
  }
});

test("a legacy archetype without the Tier 4 fields still runs without throwing", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.aiArchetype = { name: "Legacy", workerTarget: 4, armyAttackSize: 4, attackTimeout: 90, unitMix: ["skiff"] };
  const barracks = stockedBarracks(state);
  state.players.ai.resources.ore = 100000;

  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) runAI(state, THINK_INTERVAL); });
  assert.ok(barracks.queue.length > 0 || state.aiUnitsBuilt > 0, "it still queues Skiffs from the bare mix");
});
