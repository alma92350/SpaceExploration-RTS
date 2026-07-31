import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { tick } from "../engine/sim.js";
import { UNITS, UPGRADES } from "../engine/entities.js";
import { updateResearch, researchTimeScale } from "../engine/techtree.js";
import { isNodeDiscovered, isExploredAt, isVisibleAt, updateFog } from "../engine/fog.js";
import { aiDoctrine, effectiveMix, assignIdlePlayerGather } from "../engine/aiWorkers.js";
import { pickBuilder, accrueActionBudget } from "../engine/aiCommon.js";
import { pickNextUnitType } from "../engine/aiMilitary.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

test("the AI cycles through its archetype's exact unit mix instead of pure Skiff spam", () => {
  const state = createGameState({ planetId: "ferros" });
  const mix = state.ai.archetype.unitMix;
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  stockedFoundry(state); stockedArsenal(state);   // Tier-2 + Tier-3 unlocked so the full mix cycles (drives the mix directly, not the AI's tech-up)
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
  state.time = state.ai.archetype.attackTimeout + 50;   // well past the timeout, so it commits regardless of army size

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

test("a throttled AI still commits its attack — the wave is exempt from the APM budget", () => {
  const state = createGameState({ planetId: "ferros" });
  state.ai.apm = 1;            // slowed to a crawl...
  state.ai.actionBudget = 0;   // ...with no action credits banked
  state.time = state.ai.archetype.attackTimeout + 50;
  const skiff = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(skiff.id, skiff);

  runAI(state, THINK_INTERVAL);

  assert.equal(skiff.order?.type, "attack-move", "the wave commits despite zero action budget, so the game still resolves");
});

// ---- P2 review gap: accrueActionBudget's burst-cap ceiling (engine/aiCommon.js) ----
//
// The test above only exercises the ZERO-budget floor (canAct needs >= 1, and a starved AI
// still throws its attack wave regardless). Nothing yet asserts the OTHER end: `cap =
// Math.max(2, state.ai.apm * APM_BURST_FRAC)` caps how much a busy AI can bank, so a long
// stretch of un-thought-about sim time can't hand it one giant burst of actions to spend at once.
test("accrueActionBudget clamps the banked budget at its burst cap, no matter how long the AI sits un-thought-about", () => {
  const state = createGameState({ planetId: "ferros" });
  state.ai.apm = 300;   // -> cap = Math.max(2, 300/15) = 20, mirroring aiCommon.js's APM_BURST_FRAC (1/15)
  const cap = 20;

  // Below the cap, accrual is the plain (apm/60)*dt rate -- a sanity check that what follows
  // is a genuine ceiling on top of real accrual, not a stub that always just returns the cap.
  state.ai.actionBudget = 0;
  accrueActionBudget(state, 1);
  assert.equal(state.ai.actionBudget, 5, "one second at 300 apm banks 5 credits, comfortably under the cap");

  // A single huge dt, as if the AI went un-thought-about for a very long stretch of sim
  // time -- without the Math.min ceiling this would bank ~5,000,000 credits.
  accrueActionBudget(state, 1_000_000);
  assert.equal(state.ai.actionBudget, cap, "an enormous dt still clamps at the documented burst cap, not an unbounded burst");

  // The ceiling keeps holding on the NEXT accrual too, once already at the cap -- not just a
  // one-off coincidence of the first Math.min call landing on the cap by chance.
  accrueActionBudget(state, 1_000_000);
  assert.equal(state.ai.actionBudget, cap, "the cap keeps holding on later accruals once already at the ceiling");
});

test("the AI launches repeated attack waves, not just one", () => {
  const state = createGameState({ planetId: "ferros" });
  const archetype = state.ai.archetype;
  state.time = archetype.attackTimeout + 1;

  const waveOne = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(waveOne.id, waveOne);
  runAI(state, THINK_INTERVAL);
  assert.equal(waveOne.order?.type, "attack-move", "the first wave should commit past the timeout");
  const firstNextAttackAt = state.ai.nextAttackAt;
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

  assert.equal(builtTypes[0], state.ai.archetype.unitMix[0], "the very first build should still follow the archetype's mix");
  assert.equal(builtTypes[3], "bastion", "the 4th unit built (the first counter-pick slot) should directly counter the seen Skiff-heavy army");
  assert.equal(builtTypes[6], "bastion", "the counter-pick recurs every 3rd unit thereafter");
});

test("the AI does NOT counter a player army it hasn't seen — no free intel", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  stockedFoundry(state);   // Tier-2 units unlocked, so the plain mix is what remains to be checked (fog gating, not tech gating)
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

  const mix = state.ai.archetype.unitMix;
  assert.deepEqual(built, Array.from({ length: 7 }, (_, i) => mix[i % mix.length]),
    "with the player army unseen, every slot follows the plain mix — no reactive counter");
});

// A completed Barracks the tests can drive without waiting on construction.
function stockedBarracks(state, dy = -100) {
  const b = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y + dy);
  state.buildings.set(b.id, b);
  return b;
}
// A completed Foundry, so the Tier-2 units (Lancer/Breacher) are unlocked in a
// fixture that drives the mix directly without waiting for the AI to tech up.
function stockedFoundry(state) {
  const f = makeBuilding("foundry", "ai", state.map.bases.ai.x, state.map.bases.ai.y + 140);
  state.buildings.set(f.id, f);
  return f;
}
// A completed Arsenal too, so the Tier-3 Dreadnought is unlocked when a fixture
// drives the full mix directly.
function stockedArsenal(state) {
  const a = makeBuilding("arsenal", "ai", state.map.bases.ai.x, state.map.bases.ai.y + 180);
  state.buildings.set(a.id, a);
  return a;
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
  const mix = state.ai.archetype.unitMix;   // ferros has every commodity, so the full economist mix survives
  const b1 = stockedBarracks(state, -100);
  const b2 = stockedBarracks(state, 100);
  stockedFoundry(state); stockedArsenal(state);   // unlock Tier-2 + Tier-3 so the full shared cycle is what's under test

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

test("with radioactives guaranteed on every world, the Breacher is buildable even on vesper", () => {
  // Vesper's surface deposits no radioactives, but the build-critical minimum
  // seams the map with a little, so the Breacher cycles without stalling. The
  // balanced mix also lists the specialty Wraith/Aegis, but here both drop out —
  // Wraith needs the (un-built) Arsenal and Aegis needs ice Vesper lacks — so the
  // effective cycle is the four non-specialty units.
  const state = createGameState({ planetId: "vesper", rng: () => 0.5 });
  fundAll(state);
  const barracks = stockedBarracks(state);
  stockedFoundry(state);   // Tier-2 unlocked, isolating the resource guarantee (not the tech gate) as what's under test
  const cycle = ["skiff", "bastion", "lancer", "breacher"];

  const built = [];
  for (let i = 0; i < cycle.length * 2; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) { built.push(barracks.queue[barracks.queue.length - 1].unitType); barracks.queue.length = 0; }
  }

  assert.deepEqual(built, Array.from({ length: cycle.length * 2 }, (_, i) => cycle[i % cycle.length]));
  assert.ok(built.includes("breacher"), "the Breacher enters the cycle now that radioactives are guaranteed");
});

test("on a gas world the balanced AI folds its specialty Wraith into the cycle", () => {
  const state = createGameState({ planetId: "vesper", rng: () => 0.5 });   // vesper: balanced archetype, deposits gas
  Object.assign(state.players.ai.resources, { ore: 1e5, crystals: 1e5, radioactives: 1e5, gas: 1e5 });
  const barracks = stockedBarracks(state);
  stockedFoundry(state); stockedArsenal(state);   // Tier-3 unlocked so the specialty unit can cycle

  const built = [];
  for (let i = 0; i < 12; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) { built.push(barracks.queue[barracks.queue.length - 1].unitType); barracks.queue.length = 0; }
  }
  assert.ok(built.includes("wraith"), "Vesper's gas funds the Wraith once the Arsenal is up");
  assert.ok(!built.includes("aegis"), "but not the Aegis — Vesper deposits no ice");
  assert.ok(!built.includes("colossus"), "nor the Colossus — no relics, and it isn't in the balanced mix");
});

test("the AI only teches to the Arsenal where a buildable Arsenal unit exists", () => {
  // Balanced on Pyralis (crystals + radioactives, no gas/ice): its mix's only
  // Arsenal units are the Wraith (gas) and Aegis (ice), both unpayable here, so
  // affordableOnSurface keeps wantsArsenal false and it never wastes the build.
  const state = createGameState({ planetId: "pyralis", rng: () => 0.5 });
  fundAll(state);
  stockedBarracks(state); stockedFoundry(state);
  for (let i = 0; i < 20; i++) runAI(state, THINK_INTERVAL);
  assert.equal(aiBuildings(state, "arsenal").length, 0, "no Arsenal on a world whose deposits can't pay for any Arsenal unit");
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

// docs/improvement-proposals.md's static-defense ladder: past the first fortification slot, the
// AI upgrades to the heavier Bastille once a completed Foundry actually unlocks it — but the two
// still fill the SAME turretCount budget (2 for the Economist), not an extra on top.
test("with a Foundry already up, the Economist's second fortification slot upgrades to a Bastille — the first stays a plain turret", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  Object.assign(state.players.ai.resources, { ore: 100000, crystals: 10000, radioactives: 10000 });
  stockedBarracks(state);
  stockedFoundry(state);   // completed (not constructing) — prereqsMet(bastille) is true from the start

  for (let i = 0; i < 20; i++) runAI(state, THINK_INTERVAL);

  const turrets = aiBuildings(state, "turret");
  const bastilles = aiBuildings(state, "bastille");
  assert.equal(turrets.length, 1, "the first fortification slot stays a plain Sentinel Turret");
  assert.equal(bastilles.length, 1, "the second slot upgrades to the heavier Bastille once the Foundry allows it");
  assert.equal(turrets.length + bastilles.length, 2, "still exactly turretCount total, not an extra on top");
});

// Without a Foundry, fortifying must never stall waiting on a tech gate the archetype's own build
// order hasn't reached — every slot falls back to the plain turret instead.
test("without a Foundry, every fortification slot stays a plain turret — the Bastille never blocks fortifying on a tech gate", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  Object.assign(state.players.ai.resources, { ore: 100000, crystals: 10000, radioactives: 10000 });
  stockedBarracks(state);

  for (let i = 0; i < 20; i++) runAI(state, THINK_INTERVAL);

  assert.equal(aiBuildings(state, "turret").length, 2, "both fortification slots fall back to the plain turret");
  assert.equal(aiBuildings(state, "bastille").length, 0, "no Foundry means no Bastille, ever");
});

test("the AI recalls its army to defend when it SEES an attack on its base", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const aiBase = state.map.bases.ai;
  // An AI army already committed forward (mid attack-move toward the player).
  const forward = [];
  for (let i = 0; i < 4; i++) {
    const u = makeUnit("skiff", "ai", aiBase.x - 40 - i * 8, aiBase.y);
    u.order = { type: "attack-move", x: state.map.bases.player.x, y: state.map.bases.player.y };
    state.units.set(u.id, u);
    forward.push(u);
  }
  // A player raid parked right on the AI's doorstep, inside its Command Center's
  // vision (the initial fog pass marks these cells seen).
  const raiders = [];
  for (let i = 0; i < 3; i++) {
    const r = makeUnit("lancer", "player", aiBase.x - 120, aiBase.y + i * 8);
    state.units.set(r.id, r);
    raiders.push(r);
  }

  runAI(state, THINK_INTERVAL);

  const cx = raiders.reduce((s, r) => s + r.x, 0) / raiders.length;
  const cy = raiders.reduce((s, r) => s + r.y, 0) / raiders.length;
  for (const u of forward) {
    assert.equal(u.order?.type, "attack-move", "the recalled units still attack-move...");
    assert.ok(Math.hypot(u.order.x - cx, u.order.y - cy) < 30, "...but now toward the raid at home, not the far player base");
  }
});

test("the AI retreats a ground-down attack that still faces opposition, saving the survivors", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const cc = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  // A wave that launched 10 strong is down to 3 survivors, out at midfield (far
  // enough from the AI base that it's an OFFENSE situation, not a home defense).
  state.ai.attackForce = 10;
  state.ai.attackDesperate = false;
  const survivors = [];
  for (let i = 0; i < 3; i++) {
    const u = makeUnit("skiff", "ai", 800, 480 + i * 8);
    u.order = { type: "attack-move", x: state.map.bases.player.x, y: state.map.bases.player.y };
    state.units.set(u.id, u);
    survivors.push(u);
  }
  // A larger defending force right on them; reveal those cells to the AI's fog
  // so the retreat's "still facing opposition" check can see them.
  const revealAI = (x, y) => { state.fogAI.visible[Math.floor(y / 40) * state.fogAI.cols + Math.floor(x / 40)] = 1; };
  for (let i = 0; i < 5; i++) {
    const d = makeUnit("bastion", "player", 810, 470 + i * 8);
    state.units.set(d.id, d);
    revealAI(d.x, d.y);
  }

  runAI(state, THINK_INTERVAL);

  for (const u of survivors) {
    assert.equal(u.order?.type, "move", "the survivors disengage (plain move, so they don't stop to fight)...");
    assert.ok(Math.hypot(u.order.x - cc.x, u.order.y - cc.y) < 40, "...and head home to the Command Center (within formation spread)");
  }
});

test("the AI does NOT retreat a ground-down attack once its opposition is gone (it finishes the job)", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.ai.attackForce = 10;
  state.ai.attackDesperate = false;
  const survivors = [];
  for (let i = 0; i < 3; i++) {
    const u = makeUnit("skiff", "ai", 800, 480 + i * 8);
    u.order = { type: "attack-move", x: state.map.bases.player.x, y: state.map.bases.player.y };
    state.units.set(u.id, u);
    survivors.push(u);
  }
  // No visible enemy combat nearby — the attack broke through, so it presses on.
  runAI(state, THINK_INTERVAL);
  for (const u of survivors) {
    assert.equal(u.order?.type, "attack-move", "with no opposition in sight it keeps attacking, doesn't retreat");
  }
});

test("a size-triggered attack keeps a home guard back; a timeout commit throws everything", () => {
  // economist: armyAttackSize 9, garrison 3. Twelve idle units at home, well
  // before any timeout -> nine push, three stay to defend.
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.time = 0;   // nowhere near the 200s attackTimeout
  const cc = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  // A dedicated scout already out sweeping, so updateScout doesn't pull one of
  // the squad below and skew the counts — we're isolating the garrison split.
  const scout = makeUnit("skiff", "ai", cc.x, cc.y - 200);
  scout.order = { type: "move", x: 100, y: 100 };
  state.units.set(scout.id, scout);
  state.ai.scoutId = scout.id;
  const squad = [];
  for (let i = 0; i < 12; i++) {
    const u = makeUnit("skiff", "ai", cc.x - 30 - i * 4, cc.y);
    state.units.set(u.id, u);
    squad.push(u);
  }

  runAI(state, THINK_INTERVAL);

  const attacking = squad.filter(u => u.order?.type === "attack-move").length;
  const home = squad.filter(u => !u.order).length;
  assert.equal(home, 3, "the Economist holds its garrison of three back");
  assert.equal(attacking, 9, "and sends the surplus");
});

// An Odyssey wave that only PARTIALLY commits (the escalating probe) is
// supposed to send the forward-most units and hold the rest back as
// reinforcement — withoutHomeGuard sorts by distance from home for exactly
// that reason. That sort must hold even for an all-in archetype with
// garrison:0 (the Rusher), where the "held-back count" is zero, not just for
// a garrison > 0 archetype. Units are seeded in the REVERSE of distance order
// (farthest inserted first) so a naive unsorted pass — which would silently
// hand back whichever units happen to sit at the end of army/insertion order —
// is distinguishable from a genuine distance sort: it would send the wrong
// (nearest) half.
test("an Odyssey partial wave sends the forward-most Rusher units even with garrison:0 (all-in)", () => {
  const state = createGameState({ planetId: "korrath", rng: () => 0.5 });   // korrath -> Rusher, garrison 0
  state.diplomacy = { stance: -0.5, depletion: 0 };   // hostility ~0.41 -> a genuine partial commit, not all-or-nothing
  assert.equal(state.ai.archetype.garrison, 0, "sanity check: the Rusher is all-in by design");
  const cc = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  // A dedicated scout already out sweeping, so updateScout doesn't dip into the squad below.
  const scout = makeUnit("skiff", "ai", cc.x, cc.y - 200);
  scout.order = { type: "move", x: 100, y: 100 };
  state.units.set(scout.id, scout);
  state.ai.scoutId = scout.id;

  // Ten idle units at increasing distance from home, inserted FARTHEST first.
  const squad = [];
  for (let i = 0; i < 10; i++) {
    const dist = 1000 - i * 100;   // 1000, 900, ... 100 — decreasing as insertion proceeds
    const u = makeUnit("skiff", "ai", cc.x + dist, cc.y);
    state.units.set(u.id, u);
    squad.push(u);
  }
  const byDist = squad.slice().sort((a, b) =>
    Math.hypot(b.x - cc.x, b.y - cc.y) - Math.hypot(a.x - cc.x, a.y - cc.y));   // farthest first

  runAI(state, THINK_INTERVAL);

  const attacking = squad.filter(u => u.order?.type === "attack-move");
  const home = squad.filter(u => !u.order);
  assert.equal(attacking.length, 5, "roughly half the squad probes out this cycle");
  assert.equal(home.length, 5, "...the rest stays as reinforcement");
  const expectedForward = new Set(byDist.slice(0, 5).map(u => u.id));   // the 5 units farthest from home
  for (const u of attacking) {
    assert.ok(expectedForward.has(u.id),
      "the wave draws from the forward-most units by distance, not from insertion order");
  }
});

// Unlike the garrison test above — which sidesteps updateScout's fallback
// entirely by preloading a dedicated already-scouting unit — these two stage
// the actual hazard: the old scout is gone (state.ai.scoutId is stale, as it
// is right after the unit that held it dies) while the rest of the army is
// mid-attack, and exercise the "no Ranger, lend a fighter" fallback path.
test("a dead scout's replacement is never pulled off a unit mid-attack", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const aiBase = state.map.bases.ai;
  // The old scout died mid-wave: scoutId still points at it, but nothing in
  // state.units answers to that id any more (nothing clears it on death).
  state.ai.scoutId = "dead-scout";

  // Four units already committed to an active assault on the player's base —
  // inserted FIRST, so a naive "first non-scout army unit" fallback grabs one
  // of these instead of a real spare.
  const attackers = [];
  for (let i = 0; i < 4; i++) {
    const u = makeUnit("skiff", "ai", aiBase.x + 400 + i * 8, aiBase.y);
    u.order = { type: "attack-move", x: state.map.bases.player.x, y: state.map.bases.player.y };
    state.units.set(u.id, u);
    attackers.push(u);
  }
  // One genuinely idle spare sitting at home, inserted LAST.
  const spare = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  state.units.set(spare.id, spare);

  runAI(state, THINK_INTERVAL);

  assert.ok(!attackers.some(u => u.id === state.ai.scoutId),
    "the replacement scout must never be pulled from a unit mid-attack");
  for (const u of attackers) {
    assert.equal(u.order?.type, "attack-move",
      "units committed to the assault keep attacking — not kidnapped for scouting duty");
  }
  assert.equal(state.ai.scoutId, spare.id, "the genuinely idle spare is the one sent scouting instead");
});

test("with every AI unit mid-attack and no idle spare, a dead scout goes unreplaced rather than pulling a fighter off the assault", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const aiBase = state.map.bases.ai;
  state.ai.scoutId = "dead-scout";   // stale — the old scout is gone

  const attackers = [];
  for (let i = 0; i < 4; i++) {
    const u = makeUnit("skiff", "ai", aiBase.x + 400 + i * 8, aiBase.y);
    u.order = { type: "attack-move", x: state.map.bases.player.x, y: state.map.bases.player.y };
    state.units.set(u.id, u);
    attackers.push(u);
  }

  runAI(state, THINK_INTERVAL);

  assert.ok(!attackers.some(u => u.id === state.ai.scoutId),
    "no unit mid-attack is ever pulled as a replacement scout, even with no idle spare available");
  for (const u of attackers) {
    assert.equal(u.order?.type, "attack-move", "every attacking unit keeps attacking, untouched");
  }
});

test("the AI marches on a SEEN enemy building rather than the fixed start coordinate", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.time = state.ai.archetype.attackTimeout + 50;   // force a commit
  const aiBase = state.map.bases.ai;
  // A player expansion the AI has vision of, placed away from the player's
  // start. Sits just inside the AI CC's sight so it counts as "seen".
  const seenCC = makeBuilding("command", "player", aiBase.x - 180, aiBase.y);
  state.buildings.set(seenCC.id, seenCC);
  const u = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  state.units.set(u.id, u);

  runAI(state, THINK_INTERVAL);

  assert.equal(u.order?.type, "attack-move");
  assert.ok(Math.hypot(u.order.x - seenCC.x, u.order.y - seenCC.y) < 1,
    "it targets the enemy building it can see, not state.map.bases.player");
});

test("with no enemy in sight, the AI beelines to the player's start while it's still uncharted", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.time = state.ai.archetype.attackTimeout + 50;   // force a commit
  const aiBase = state.map.bases.ai;
  const u = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  state.units.set(u.id, u);
  // The AI can see no enemy and hasn't charted the player's corner yet.
  assert.equal(isExploredAt(state.fogAI, state.map.bases.player.x, state.map.bases.player.y), false, "fixture: start uncharted");

  runAI(state, THINK_INTERVAL);

  assert.equal(u.order?.type, "attack-move");
  assert.ok(Math.hypot(u.order.x - state.map.bases.player.x, u.order.y - state.map.bases.player.y) < 1,
    "unseen + uncharted start -> head straight for it (the fast beeline that keeps the game resolving)");
});

test("once the start is charted and empty, the AI searches unexplored ground for a hidden CC", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.time = state.ai.archetype.attackTimeout + 50;
  const aiBase = state.map.bases.ai;
  const u = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  state.units.set(u.id, u);
  // The AI has charted the whole map EXCEPT one dark patch (a hidden expansion
  // could be there). It sees no enemy right now, and the start is charted+empty.
  const fog = state.fogAI;
  fog.explored.fill(1);
  const cx0 = Math.floor(fog.cols * 0.5), cy0 = 3;
  for (let cy = cy0; cy < cy0 + 3; cy++) for (let cx = cx0; cx < cx0 + 3; cx++) fog.explored[cy * fog.cols + cx] = 0;
  assert.equal(isExploredAt(fog, state.map.bases.player.x, state.map.bases.player.y), true, "fixture: start charted");

  runAI(state, THINK_INTERVAL);

  assert.equal(u.order?.type, "attack-move");
  assert.equal(isExploredAt(fog, u.order.x, u.order.y), false,
    "start charted + nothing seen -> it sweeps the remaining dark ground hunting the hidden CC");
});

test("without a completed Foundry the AI trains only Tier-1 units and never stalls the cycle", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(barracks.id, barracks);
  fundAll(state);   // resources are ample; the ONLY thing gating Lancer/Breacher is the missing (completed) Foundry
  const built = [];
  for (let i = 0; i < 10; i++) {
    runAI(state, THINK_INTERVAL);
    if (barracks.queue.length) { built.push(barracks.queue[barracks.queue.length - 1].unitType); barracks.queue.length = 0; }
  }
  assert.equal(built.length, 10, "it queues a unit every cycle — never stalls re-picking a locked entry");
  assert.ok(built.every(t => t === "skiff" || t === "bastion"), "and only the Tier-1 units the tech allows");
  assert.ok(!built.includes("lancer") && !built.includes("breacher"),
    "the Foundry it starts is still constructing, so Tier-2 stays locked");
});

test("the AI teches up: over a match it builds a Foundry and then fields Tier-2 units", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  let sawFoundry = false, sawTier2 = false;
  for (let i = 0; i < 4000 && !state.over; i++) {
    tick(state, 0.1);
    if (!sawFoundry && [...state.buildings.values()].some(b => b.owner === "ai" && b.type === "foundry" && !b.constructing)) sawFoundry = true;
    if (!sawTier2 && [...state.units.values()].some(u => u.owner === "ai" && (u.type === "lancer" || u.type === "breacher"))) sawTier2 = true;
  }
  assert.ok(sawFoundry, "the AI builds and completes a Foundry");
  assert.ok(sawTier2, "and then fields the Tier-2 units it unlocks");
});

test("a macro AI teches its doctrine: it builds a Refinery and researches an upgrade", () => {
  // helix is a crystal-dense Economist world, so the adaptive doctrine picks
  // Bulwark and the AI banks for a Refinery and researches it over a match.
  const state = createGameState({ planetId: "helix", rng: () => 0.5 });
  let sawRefinery = false, sawUpgrade = false;
  for (let i = 0; i < 5000 && !state.over; i++) {
    tick(state, 0.1);
    if (!sawRefinery && [...state.buildings.values()].some(b => b.owner === "ai" && b.type === "refinery" && !b.constructing)) sawRefinery = true;
    if (!sawUpgrade && Object.keys(state.players.ai.upgrades).some(k => state.players.ai.upgrades[k])) sawUpgrade = true;
  }
  assert.ok(sawRefinery, "the macro AI banks for and builds a Refinery");
  assert.ok(sawUpgrade, "and researches its doctrine instead of leaving the Refinery idle");
});

// ---- P1 review gap: aiDoctrine's world-economy cross-over (engine/aiWorkers.js) ----
//
// aiDoctrine prefers the archetype's own stated doctrine, but overrides it when the world's
// SURFACE economy clearly favors the other commodity (Assault runs on radioactives, Bulwark on
// crystals): `rad >= cry * 0.6` for an Assault-leaning archetype, `cry >= rad * 0.6` for a
// Bulwark-leaning one. The test above (Helix) never forces this: Helix is crystal-dense AND its
// own archetype (Economist) already prefers Bulwark, so the cross-over is never what actually
// picks the doctrine there. These force a genuine disagreement between archetype and world.
test("aiDoctrine overrides the archetype's stated preference when the world's economy clearly favors the OTHER commodity", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const wipeSecondary = () => {
    for (const n of state.map.nodes) if (n.com === "crystals" || n.com === "radioactives") { n.max = 0; n.amount = 0; }
  };

  // Crystal-rich, radioactive-EMPTY world: rad(0) < cry(1000)*0.6, so an Assault-preferring
  // archetype (Rusher/Balanced's own stated doctrine) is overridden to Bulwark.
  wipeSecondary();
  const cry = { id: "test-cry", com: "crystals", amount: 1000, max: 1000, x: 100, y: 100 };
  state.map.nodes.push(cry); state.map.nodesById.set(cry.id, cry);
  assert.equal(aiDoctrine(state, { doctrine: "assault" }), "bulwark",
    "a crystal-rich, radioactive-empty world forces Bulwark despite the archetype wanting Assault");

  // Mirror image: a radioactive-rich, crystal-EMPTY world overrides a Bulwark-preferring
  // archetype (the Economist's own stated doctrine) to Assault instead.
  wipeSecondary();
  const rad = { id: "test-rad", com: "radioactives", amount: 1000, max: 1000, x: 100, y: 100 };
  state.map.nodes.push(rad); state.map.nodesById.set(rad.id, rad);
  assert.equal(aiDoctrine(state, { doctrine: "bulwark" }), "assault",
    "a radioactive-rich, crystal-empty world forces Assault despite the archetype wanting Bulwark");

  // The exact boundary, read straight from the source (`rad >= cry * 0.6`): AT the cutoff the
  // archetype's own Assault preference still wins (>=, not >).
  wipeSecondary();
  const cry2 = { id: "test-cry2", com: "crystals", amount: 100, max: 100, x: 100, y: 100 };
  const rad2 = { id: "test-rad2", com: "radioactives", amount: 60, max: 60, x: 100, y: 100 };   // exactly cry*0.6
  state.map.nodes.push(cry2, rad2); state.map.nodesById.set(cry2.id, cry2); state.map.nodesById.set(rad2.id, rad2);
  assert.equal(aiDoctrine(state, { doctrine: "assault" }), "assault",
    "at the exact 0.6 cutoff the archetype's own stated preference still holds");
});

test("a macro AI whose archetype prefers Assault researches Bulwark instead, once the world's economy overrides it", () => {
  // Same cross-over as above, but proven end-to-end through the real AI: force a genuine
  // disagreement (an Assault-preferring archetype on a crystal-rich, radioactive-starved world)
  // and confirm aiResearch actually queues, then (once it develops) banks, the WORLD-favored
  // doctrine's upgrade, not the archetype's own stated one. Doctrine research now develops over
  // time (engine/techtree.js updateResearch) instead of landing instantly the moment aiResearch
  // enqueues it.
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.ai.archetype = { ...state.ai.archetype, doctrine: "assault" };   // stated preference: Assault
  for (const n of state.map.nodes) if (n.com === "crystals" || n.com === "radioactives") { n.max = 0; n.amount = 0; }
  const cry = { id: "test-cry", com: "crystals", amount: 1000, max: 1000, x: state.map.bases.ai.x + 200, y: state.map.bases.ai.y };
  state.map.nodes.push(cry); state.map.nodesById.set(cry.id, cry);

  const refinery = makeBuilding("refinery", "ai", state.map.bases.ai.x, state.map.bases.ai.y - 100);
  state.buildings.set(refinery.id, refinery);
  fundAll(state);

  for (let i = 0; i < 5; i++) runAI(state, THINK_INTERVAL);

  assert.equal(refinery.researchQueue?.[0]?.techId, "reinforcedPlating",
    "the AI queued Bulwark's Tier-1 upgrade — the world-favored doctrine, not the archetype's own stated Assault preference");
  assert.ok(!state.players.ai.upgrades.reinforcedPlating, "…not researched yet — it still has to develop");

  // Further think cycles while it's still developing must not re-queue a duplicate or waver
  // between doctrines (engine/aiEconomy.js aiResearch's re-entry guard) — still exactly one job.
  for (let i = 0; i < 20; i++) runAI(state, THINK_INTERVAL);
  assert.equal(refinery.researchQueue.length, 1, "still just the one queued job — no duplicate re-enqueue while it's already in flight");

  // Let it actually finish developing (the same tick-driven loop engine/sim.js runs for real).
  const need = UPGRADES.reinforcedPlating.time * researchTimeScale(state);
  for (let t = 0; t < need + 1; t += 0.5) updateResearch(state, refinery, 0.5);

  assert.equal(state.players.ai.upgrades.reinforcedPlating, true,
    "the AI researched Bulwark's Tier-1 upgrade once it finished developing — the world-favored doctrine");
  assert.ok(!state.players.ai.upgrades.overchargedWeapons,
    "…not Assault's, despite that being the archetype's own stated preference");
});

test("even on a big map with ore worked far from home, the AI never plants a second Refinery", () => {
  // Forward-Refinery placement (decentralized collection) was removed along with the
  // Refinery's drop-off capability — the AI now only ever builds its one home research
  // Refinery, regardless of map size or how far its workers are mining from it. This
  // used to be exactly the scenario (a Gigantic map, ore worked far from the base) that
  // triggered a second, forward-planted Refinery.
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, sizeMult: 3 });
  fundAll(state);
  stockedBarracks(state);          // completed Barracks at the AI base
  const cc = aiBuildings(state, "command")[0];
  const home = makeBuilding("refinery", "ai", cc.x - 90, cc.y - 90);
  state.buildings.set(home.id, home);
  // A far AI-side ore seam — well beyond the old FORWARD_DROP_MIN threshold — that workers mine.
  const farOre = state.map.nodes
    .filter(n => n.com === "ore" && n.amount > 0 && n.x >= state.map.width / 2)
    .filter(n => Math.hypot(n.x - cc.x, n.y - cc.y) > 500)
    .sort((a, b) => Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y))[0];
  assert.ok(farOre, "fixture: the 3x map has an AI-side ore seam far from the base");
  for (let i = 0; i < 3; i++) {
    const w = makeUnit("worker", "ai", farOre.x, farOre.y);
    w.order = { type: "gather", nodeId: farOre.id, phase: "mining" };
    state.units.set(w.id, w);
  }

  for (let i = 0; i < 4; i++) runAI(state, THINK_INTERVAL);

  const refineries = aiBuildings(state, "refinery");
  assert.equal(refineries.length, 1, "no forward Refinery — the AI only ever builds its one home Refinery");
  assert.equal(refineries[0].id, home.id);
});

test("on a small map the AI likewise keeps just its single home Refinery", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  fundAll(state);
  stockedBarracks(state);
  const cc = aiBuildings(state, "command")[0];
  const home = makeBuilding("refinery", "ai", cc.x - 90, cc.y - 90);
  state.buildings.set(home.id, home);
  // Put workers on the AI's own home ore (as they would be) — all within reach.
  const oreSeams = state.map.nodes.filter(n => n.com === "ore" && n.amount > 0 &&
    Math.hypot(n.x - cc.x, n.y - cc.y) < 360);
  assert.ok(oreSeams.length > 0, "fixture: home ore is within reach on a small map");
  for (const seam of oreSeams) {
    const w = makeUnit("worker", "ai", seam.x, seam.y);
    w.order = { type: "gather", nodeId: seam.id, phase: "mining" };
    state.units.set(w.id, w);
  }

  for (let i = 0; i < 4; i++) runAI(state, THINK_INTERVAL);

  assert.equal(aiBuildings(state, "refinery").length, 1, "still just the one home Refinery");
});

test("the AI spreads workers across ore nodes instead of over-piling one under saturation", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const cap = UNITS.worker.minerSoftCap;
  // Only the seams the AI can actually assign to — the ones in its own fog. The
  // mirrored player-side ore is undiscovered and would sit at zero, which isn't
  // over-piling, it's just out of reach.
  const oreNodes = state.map.nodes.filter(n => n.com === "ore" && !n.hidden && isNodeDiscovered(state.fogAI, n));
  assert.ok(oreNodes.length >= 2, "fixture sanity: the AI sees multiple ore seams at home");
  // Replace the AI's economy with a controlled pool of idle workers — enough
  // that piling them all on the nearest seam would blow well past the cap.
  [...state.units.values()].filter(u => u.owner === "ai").forEach(u => state.units.delete(u.id));
  for (let i = 0; i < oreNodes.length * cap + oreNodes.length; i++) {
    const w = makeUnit("worker", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
    state.units.set(w.id, w);
  }

  runAI(state, THINK_INTERVAL);

  const counts = new Map();
  for (const u of state.units.values()) {
    if (u.owner === "ai" && u.order?.type === "gather") counts.set(u.order.nodeId, (counts.get(u.order.nodeId) || 0) + 1);
  }
  // Spreading is about the seams at comparable distance (the home cluster) — the
  // AI rightly won't march workers across the map to the enemy's ore just to
  // dodge mild saturation, so we only judge even-ness among the near seams.
  const aiBase = state.map.bases.ai;
  const near = oreNodes.filter(n => Math.hypot(n.x - aiBase.x, n.y - aiBase.y) < 500);
  assert.ok(near.length >= 2, "sanity: the AI has several ore seams at home");
  const nearCounts = near.map(n => counts.get(n.id) || 0);
  assert.ok(nearCounts.filter(c => c >= cap).length >= 2,
    "it fills more than one home seam to the cap instead of dumping every worker on the nearest");
  assert.ok(Math.max(...nearCounts) - Math.min(...nearCounts) <= 2,
    "and fills the home seams roughly evenly rather than piling one high");
});

// ---- P1 review gap: the secondary-commodity worker cap (engine/aiWorkers.js) ----
//
// secondaryCap = Math.min(2, Math.floor(workers.length / 3)) caps how many AI workers a think
// cycle will EVER divert onto a secondary commodity (crystals/radioactives) instead of ore — "a
// small trickle funds them... keeps ore primary everywhere while still reaching the extras". No
// existing test asserts this cap directly.
test("assignIdleWorkers caps AI workers on secondary (crystal/radioactive) nodes, however many are on offer", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const base = state.map.bases.ai;
  // Starve the treasury so no OTHER AI phase (aiBaseAndTech's Barracks/Habitat, which grab
  // workers[0] directly rather than through pickBuilder) can reassign one of our gatherers to a
  // build order this cycle — isolating assignIdleWorkers's own cap logic from the rest of runAI.
  Object.assign(state.players.ai.resources, { ore: 0, crystals: 0, radioactives: 0 });
  // Plenty of secondary-commodity nodes right at home — uncapped, a purely nearest-first
  // assignment would happily send far more than the cap onto them.
  const secondary = [
    { id: "test-cry-1", com: "crystals", amount: 1000, max: 1000, x: base.x + 60, y: base.y + 40 },
    { id: "test-cry-2", com: "crystals", amount: 1000, max: 1000, x: base.x - 60, y: base.y + 40 },
    { id: "test-cry-3", com: "crystals", amount: 1000, max: 1000, x: base.x + 40, y: base.y - 60 },
    { id: "test-rad-1", com: "radioactives", amount: 1000, max: 1000, x: base.x - 40, y: base.y - 60 },
    { id: "test-rad-2", com: "radioactives", amount: 1000, max: 1000, x: base.x, y: base.y + 90 },
  ];
  for (const n of secondary) { state.map.nodes.push(n); state.map.nodesById.set(n.id, n); }

  // Replace the AI's starting workers with a controlled pool of 12 idle ones. At 12 workers the
  // bare Math.floor(workers.length / 3) term alone is 4 — past the hard ceiling of 2 — so this
  // fixture actually exercises the Math.min(2, ...) ceiling, not just the /3 scaling.
  [...state.units.values()].filter(u => u.owner === "ai").forEach(u => state.units.delete(u.id));
  const WORKER_COUNT = 12;
  for (let i = 0; i < WORKER_COUNT; i++) {
    const w = makeUnit("worker", "ai", base.x, base.y);
    state.units.set(w.id, w);
  }
  const expectedCap = Math.min(2, Math.floor(WORKER_COUNT / 3));
  assert.equal(expectedCap, 2, "sanity: this fixture's /3 term (4) exceeds the hard ceiling (2)");

  for (let i = 0; i < 4; i++) runAI(state, THINK_INTERVAL);   // several think-cycles, per the review's ask

  const nodeById = state.map.nodesById;
  const secondaryMiners = [...state.units.values()].filter(u =>
    u.owner === "ai" && u.type === "worker" && u.order?.type === "gather"
    && ["crystals", "radioactives"].includes(nodeById.get(u.order.nodeId)?.com)).length;

  assert.equal(secondaryMiners, expectedCap,
    `exactly the computed cap (${expectedCap}) of workers gather crystals/radioactives — never more, however many nodes/workers are on offer`);
});

// ---- P2 review gap: pickBuilder's idle-over-busy preference (engine/aiCommon.js) ----
//
// pickBuilder skips any worker already mid-build/mid-service/mid-haul so a new job never steals
// an in-progress site's founder or thrashes an industry logistics run (see the doc comment above
// it in aiCommon.js). No existing test drives pickBuilder directly: every current call site is
// only reached transitively through runAI, where a lone idle worker is typically the only
// candidate anyway. This pits a busy worker planted much closer to the build spot against a
// distant idle one, so a naive nearest-first pick (ignoring order state) is distinguishable from
// the real skip-busy-workers logic.
test("pickBuilder prefers a genuinely idle worker over one mid-build/mid-service/mid-haul, even when the busy one is much closer", () => {
  const spot = { x: 500, y: 500 };   // stand-in for the new building's chosen foundation spot
  for (const busyType of ["build", "service", "haul"]) {
    const busy = makeUnit("worker", "ai", spot.x + 5, spot.y);      // right on top of the spot...
    busy.order = { type: busyType };
    const idle = makeUnit("worker", "ai", spot.x + 500, spot.y);    // ...while idle sits far away
    const picked = pickBuilder([busy, idle], spot.x, spot.y);
    assert.equal(picked.id, idle.id,
      `a worker mid-${busyType} is skipped for the distant idle one, despite being by far the nearest candidate`);
  }
});

test("a legacy archetype without the Tier 4 fields still runs without throwing", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.ai.archetype = { name: "Legacy", workerTarget: 4, armyAttackSize: 4, attackTimeout: 90, unitMix: ["skiff"] };
  const barracks = stockedBarracks(state);
  state.players.ai.resources.ore = 100000;

  assert.doesNotThrow(() => { for (let i = 0; i < 5; i++) runAI(state, THINK_INTERVAL); });
  assert.ok(barracks.queue.length > 0 || state.ai.unitsBuilt > 0, "it still queues Skiffs from the bare mix");
});

test("the Tactical AI focus-fires: it points its army at the lowest-HP visible enemy", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiMicro: true });
  const aiBase = state.map.bases.ai;
  const a1 = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  const a2 = makeUnit("skiff", "ai", aiBase.x + 12, aiBase.y);
  state.units.set(a1.id, a1); state.units.set(a2.id, a2);
  // Two player combat units near the AI base (inside the CC's sight) — one nearly dead.
  const healthy = makeUnit("bastion", "player", aiBase.x + 40, aiBase.y);
  const wounded = makeUnit("skiff", "player", aiBase.x + 55, aiBase.y);
  wounded.hp = 5;
  state.units.set(healthy.id, healthy); state.units.set(wounded.id, wounded);
  updateFog(state, state.fogAI, "ai");   // runAI doesn't reveal fog; make the enemies visible first

  runAI(state, THINK_INTERVAL);

  assert.equal(a1.focusId, wounded.id, "both attackers concentrate on the lowest-HP enemy");
  assert.equal(a2.focusId, wounded.id);
});

test("focus-fire is inert with no enemy combat in sight — a stale focus is cleared", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiMicro: true });
  const aiBase = state.map.bases.ai;
  const a1 = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  a1.focusId = "stale-target";
  state.units.set(a1.id, a1);
  updateFog(state, state.fogAI, "ai");

  runAI(state, THINK_INTERVAL);

  assert.equal(a1.focusId, null, "no visible enemy combat -> focus cleared, ordinary targeting resumes (razing path untouched)");
});

test("the Standard AI never sets a focus (micro is opt-in)", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // aiMicro defaults false
  const aiBase = state.map.bases.ai;
  const a1 = makeUnit("skiff", "ai", aiBase.x, aiBase.y);
  state.units.set(a1.id, a1);
  const enemy = makeUnit("skiff", "player", aiBase.x + 40, aiBase.y);
  state.units.set(enemy.id, enemy);
  updateFog(state, state.fogAI, "ai");

  runAI(state, THINK_INTERVAL);

  assert.ok(!a1.focusId, "with tactics off, the AI leaves targeting to the dispersed auto-acquire");
});

test("the Tactical AI builds a Ranger and scouts with it instead of lending a fighter", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiMicro: true });
  let sawRanger = false, rangerScouted = false;
  for (let i = 0; i < 2000 && !state.over; i++) {
    tick(state, 0.1);
    const ranger = [...state.units.values()].find(u => u.owner === "ai" && u.type === "ranger");
    if (ranger) { sawRanger = true; if (state.ai.scoutId === ranger.id) rangerScouted = true; }
  }
  assert.ok(sawRanger, "the Tactical AI builds a Ranger");
  assert.ok(rangerScouted, "and hands it the scouting job");
});

test("the Standard AI builds no Ranger — the scout unit is a Tactical-only extra", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // aiMicro off
  let sawRanger = false;
  for (let i = 0; i < 2000 && !state.over; i++) {
    tick(state, 0.1);
    if ([...state.units.values()].some(u => u.owner === "ai" && u.type === "ranger")) { sawRanger = true; break; }
  }
  assert.ok(!sawRanger, "the Standard AI never trains a Ranger — its opening is unchanged");
});

test("Tactical AI resists a feint: a lone attacker pulls only a proportionate defence", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiMicro: true });
  const aiBase = state.map.bases.ai;
  const squad = [];
  for (let i = 0; i < 12; i++) { const u = makeUnit("skiff", "ai", aiBase.x - 20 - i * 4, aiBase.y); state.units.set(u.id, u); squad.push(u); }
  const feint = makeUnit("skiff", "player", aiBase.x + 30, aiBase.y);   // one attacker pokes the base
  state.units.set(feint.id, feint);
  updateFog(state, state.fogAI, "ai");

  runAI(state, THINK_INTERVAL);

  const responding = squad.filter(u => u.order?.type === "attack-move").length;
  assert.ok(responding > 0, "it still defends");
  assert.ok(responding <= 3, `a 1-unit feint draws only ~2x its size (${responding}), not the whole army of 12`);
});

test("the Standard AI recalls the whole army to a threat — feint-resistance is Tactical-only", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // aiMicro off
  const aiBase = state.map.bases.ai;
  const squad = [];
  for (let i = 0; i < 12; i++) { const u = makeUnit("skiff", "ai", aiBase.x - 20 - i * 4, aiBase.y); state.units.set(u.id, u); squad.push(u); }
  const feint = makeUnit("skiff", "player", aiBase.x + 30, aiBase.y);
  state.units.set(feint.id, feint);
  updateFog(state, state.fogAI, "ai");

  runAI(state, THINK_INTERVAL);

  assert.equal(squad.filter(u => u.order?.type === "attack-move").length, 12, "Standard AI brings everyone home");
});

test("Tactical AI raids the economy: a raid wave targets a visible player worker, not the base", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiMicro: true });
  state.time = 0;              // not a desperation timeout commit
  state.ai.waveCount = 2;       // so this commit is the 3rd wave -> a raid
  const aiBase = state.map.bases.ai;
  const squad = [];
  for (let i = 0; i < 12; i++) { const u = makeUnit("skiff", "ai", aiBase.x - 20 - i * 4, aiBase.y); state.units.set(u.id, u); squad.push(u); }
  const worker = makeUnit("worker", "player", aiBase.x - 200, aiBase.y);   // a worker the AI can see
  state.units.set(worker.id, worker);
  updateFog(state, state.fogAI, "ai");

  runAI(state, THINK_INTERVAL);

  const attacker = squad.find(u => u.order?.type === "attack-move");
  assert.ok(attacker, "the wave committed");
  assert.ok(Math.hypot(attacker.order.x - worker.x, attacker.order.y - worker.y) < 60,
    "the raid wave is aimed at the worker line, not the main base");
});

test("Tactical AI builds exactly one home Mender once its Foundry is up", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiMicro: true });
  fundAll(state);
  const barracks = stockedBarracks(state);
  stockedFoundry(state);   // the Mender's prereq — a completed Foundry

  runAI(state, THINK_INTERVAL);

  const queuedMenders = () => aiBuildings(state, "barracks")
    .reduce((n, b) => n + b.queue.filter(j => j.unitType === "mender").length, 0);
  assert.equal(queuedMenders(), 1, "a Tactical AI with a Foundry queues a Mender for army-sustain");

  // Capped at one: further think cycles don't stack a second while the first is
  // still in the queue (so it never crowds out the combat mix).
  for (let i = 0; i < 6; i++) runAI(state, THINK_INTERVAL);
  const menderUnits = [...state.units.values()].filter(u => u.owner === "ai" && u.type === "mender").length;
  assert.equal(queuedMenders() + menderUnits, 1, "never more than one Mender in flight at a time");
});

test("Standard (non-Tactical) AI never builds a Mender, even with a Foundry", () => {
  // The Mender is gated on aiMicro, so a plain resolve-test AI (aiMicro false)
  // spends its Barracks time on the combat mix — keeping the resolves-to-a-winner
  // guarantee, and its economy, exactly as before the support unit existed.
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // aiMicro defaults false
  fundAll(state);
  const barracks = stockedBarracks(state);
  stockedFoundry(state);

  for (let i = 0; i < 6; i++) runAI(state, THINK_INTERVAL);

  const anyMender = aiBuildings(state, "barracks").some(b => b.queue.some(j => j.unitType === "mender"))
    || [...state.units.values()].some(u => u.owner === "ai" && u.type === "mender");
  assert.equal(anyMender, false, "a Standard AI builds no Mender");
  assert.ok(barracks.queue.length > 0, "...it's still producing combat units from the mix");
});

// ---- P2 counter-intelligence: engine/aiMilitary.js's counterToPlayerArmy /
// pickNextUnitType — out-of-triangle counters (COUNTER_OF's counteredBy fold),
// the soft-answer fallback (SOFT_ANSWER), reading a turret wall, and the
// difficulty-shaped counter-pick cadence (engine/aiDifficulty.js counterEvery).
// Each declared counteredBy value's OWN duel-proof lives in test/balance.test.js
// beside the Dreadnought's; these tests instead pin that the AI actually reaches
// for the right answer once it can see the threat.

// Places `n` player-owned `type` units close enough to the AI's own base to be
// swept into its starting Command Center's sight, then makes them actually
// visible (creation-time fog is a one-off snapshot — new units after that need
// a fresh updateFog, same idiom as the rest of this file's fog-gated tests).
function revealPlayerArmy(state, type, n) {
  const aiBase = state.map.bases.ai;
  for (let i = 0; i < n; i++) {
    const u = makeUnit(type, "player", aiBase.x + 40 + i * 14, aiBase.y);
    state.units.set(u.id, u);
  }
  updateFog(state, state.fogAI, "ai");
}

test("a visible massed Dreadnought, Breacher, Wraith, Colossus, or Leviathan army yields a Skiff counter-pick", () => {
  for (const type of ["dreadnought", "breacher", "wraith", "colossus", "leviathan"]) {
    const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
    revealPlayerArmy(state, type, 5);
    // built=9 (not the more obvious 3): with no Foundry up, this world's plain
    // 5-entry cycle ["skiff","skiff","bastion","skiff","bastion"] would ALSO land
    // on built=3/6's "skiff" on its own — a vacuous pass that wouldn't tell the
    // counter-pick apart from a coincidence. built=9 (still a Medium-cadence
    // trigger, 9 % 3 === 0) lands the plain cycle on "bastion" instead, so a
    // "skiff" result here only happens if the counter-pick actually fired.
    state.ai.unitsBuilt = 9;
    assert.equal(pickNextUnitType(state, state.ai.archetype), "skiff", `a massed ${type} army should draw a Skiff counter-pick`);
  }
});

test("a visible massed Aegis army yields a Lancer counter-pick", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  stockedFoundry(state);   // unlocks the Lancer so the counter-pick has somewhere to land
  revealPlayerArmy(state, "aegis", 5);
  state.ai.unitsBuilt = 3;
  assert.equal(pickNextUnitType(state, state.ai.archetype), "lancer");
});

test("a visible turret wall (fog-revealed) triggers a Breacher counter-pick", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  stockedFoundry(state);   // unlocks the Breacher so the counter-pick has somewhere to land
  const aiBase = state.map.bases.ai;
  for (let i = 0; i < 4; i++) {
    const t = makeBuilding("turret", "player", aiBase.x + 40 + i * 30, aiBase.y);
    state.buildings.set(t.id, t);
  }
  updateFog(state, state.fogAI, "ai");
  state.ai.unitsBuilt = 3;
  assert.equal(pickNextUnitType(state, state.ai.archetype), "breacher", "a 4-turret wall in plain sight draws the siege answer");
});

test("an unseen turret wall triggers nothing — the AI can't counter what it hasn't scouted", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  stockedFoundry(state);
  const playerBase = state.map.bases.player;   // far from the AI's own vision, and never revealed to it
  assert.equal(isVisibleAt(state.fogAI, playerBase.x, playerBase.y), false, "fixture: the player's base starts unseen by the AI's fog");
  for (let i = 0; i < 4; i++) {
    const t = makeBuilding("turret", "player", playerBase.x + 40 + i * 30, playerBase.y);
    state.buildings.set(t.id, t);
  }
  const mix = effectiveMix(state, state.ai.archetype);
  state.ai.unitsBuilt = 3;
  assert.equal(pickNextUnitType(state, state.ai.archetype), mix[3 % mix.length],
    "no vision of the wall -> the plain mix cycle, not Breacher");
});

test("a turret wall is suppressed when the Breacher isn't in the archetype's affordable mix", () => {
  const state = createGameState({ planetId: "korrath", rng: () => 0.5 });   // Rusher: unitMix never includes Breacher
  const aiBase = state.map.bases.ai;
  for (let i = 0; i < 4; i++) {
    const t = makeBuilding("turret", "player", aiBase.x + 40 + i * 30, aiBase.y);
    state.buildings.set(t.id, t);
  }
  updateFog(state, state.fogAI, "ai");
  const mix = effectiveMix(state, state.ai.archetype);
  assert.ok(!mix.includes("breacher"), "fixture sanity: the Rusher's mix never includes the Breacher");
  state.ai.unitsBuilt = 3;
  assert.equal(pickNextUnitType(state, state.ai.archetype), mix[3 % mix.length],
    "the wall is seen, but Breacher isn't reachable, so the counter-pick guard drops it and the plain cycle continues");
});

test("Medium's counter-pick cadence is unchanged at every 3rd unit, exactly as before the difficulty dial existed", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });   // difficulty defaults to "medium"
  stockedFoundry(state);
  revealPlayerArmy(state, "bastion", 5);
  const mix = effectiveMix(state, state.ai.archetype);
  state.ai.unitsBuilt = 2;
  assert.equal(pickNextUnitType(state, state.ai.archetype), mix[2], "built=2: not yet the 3rd unit — the plain cycle");
  state.ai.unitsBuilt = 3;
  assert.equal(pickNextUnitType(state, state.ai.archetype), "lancer", "built=3: the 3rd unit counter-picks the massed Bastion's hard counter");
});

test("Hard's counter-pick cadence is 2 — it reacts to a massed threat a full cadence ahead of Medium", () => {
  const mk = difficulty => {
    const state = createGameState({ planetId: "ferros", rng: () => 0.5, difficulty });
    stockedFoundry(state);
    revealPlayerArmy(state, "bastion", 5);
    return state;
  };
  const hard = mk("hard"), medium = mk("medium");
  const mix = effectiveMix(hard, hard.ai.archetype);   // archetype/world-derived, identical regardless of difficulty
  hard.ai.unitsBuilt = 2;
  medium.ai.unitsBuilt = 2;
  assert.equal(pickNextUnitType(hard, hard.ai.archetype), "lancer",
    "Hard's every-2 cadence counter-picks the massed Bastion's hard counter at built=2");
  assert.equal(pickNextUnitType(medium, medium.ai.archetype), mix[2],
    "Medium's every-3 cadence hasn't hit yet at built=2 — still the plain cycle entry");
});

test("Easy never counter-picks — its army stays its learnable, exploitable archetype mix", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, difficulty: "easy" });
  stockedFoundry(state);
  revealPlayerArmy(state, "bastion", 5);
  const mix = effectiveMix(state, state.ai.archetype);
  for (let built = 0; built < mix.length * 2; built++) {
    state.ai.unitsBuilt = built;
    assert.equal(pickNextUnitType(state, state.ai.archetype), mix[built % mix.length],
      `built=${built}: Easy follows the plain cycle even with a massed Bastion army in plain sight (would be a Lancer counter-pick on Medium/Hard)`);
  }
});

// ---- P6 colony-economy rework: an owner-generic idle-gather assignment for the PLAYER side
// (engine/colonyPolicy.js's worker-sustain policy re-tasks a background colony's idle workers to
// gather, reusing this instead of duplicating assignIdleWorkers' node-picking logic) ----
test("assignIdlePlayerGather sends an idle PLAYER worker to the nearest live node, reading the PLAYER's own fog (not the AI's)", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const base = state.map.bases.player;
  const node = { id: "test-player-ore", com: "ore", amount: 500, max: 500, x: base.x + 80, y: base.y };
  state.map.nodes.push(node);
  state.map.nodesById.set(node.id, node);
  const w = makeUnit("worker", "player", base.x, base.y);
  state.units.set(w.id, w);

  assignIdlePlayerGather(state, [w]);
  assert.equal(w.order?.type, "gather", "the idle player worker is assigned a gather order");
  assert.equal(w.order.nodeId, node.id, "…on the node it can actually reach");
});

test("assignIdlePlayerGather never touches a worker that already has an order", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const base = state.map.bases.player;
  const node = { id: "test-player-ore-2", com: "ore", amount: 500, max: 500, x: base.x + 80, y: base.y };
  state.map.nodes.push(node);
  state.map.nodesById.set(node.id, node);
  const w = makeUnit("worker", "player", base.x, base.y);
  w.order = { type: "move", x: base.x + 500, y: base.y };
  state.units.set(w.id, w);

  assignIdlePlayerGather(state, [w]);
  assert.equal(w.order.type, "move", "a busy worker keeps its existing order");
});
