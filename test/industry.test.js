import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { storeTotal, storeCapOf } from "../engine/entities.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, activeState, stepGalaxy } from "../engine/galaxy.js";
import { sell } from "../engine/market.js";
import { powerCap, powerDraw, powerThrottle, cachedPowerThrottle, updateProduction, recipeOf, planetIndustryScale, powerEfficiency, POWER_TIERS, hasIceCoolant, iceCoolantMult, chargeIceUpkeep, buildingConcern, ELECTRIFY_POWER } from "../engine/industry.js";
import { BUILDINGS } from "../engine/entities.js";

import { deployColonyShip } from "../engine/colony.js";

// The industry helpers read only state.buildings and state.players[owner].resources,
// so a tiny stub exercises them without a whole map/economy.
function stub(buildings = [], resources = {}) {
  return {
    buildings: new Map(buildings.map((b, i) => {
      const id = b.id || `b${i}`;
      return [id, { id, owner: "player", constructing: false, ...b }];
    })),
    players: { player: { resources } },
  };
}
// This file is about the PRODUCTION chain, not the power/fuel mechanic (that's combustor.test.js's
// job) — so the stub reactor defaults to already-fuelled (`powered: true`) unless a test overrides
// it, matching how these fixtures already treat Power as a given.
const reactor = (o = {}) => ({ type: "reactor", powered: true, ...o });
const smelter = (o = {}) => ({ type: "smelter", ...o });
const assembler = (o = {}) => ({ type: "assembler", ...o });
const chipfab = (o = {}) => ({ type: "chipfab", ...o });
const plasmarig = (o = {}) => ({ type: "plasmarig", ...o });
const substation = (o = {}) => ({ type: "substation", ...o });
const chemplant = (o = {}) => ({ type: "chemplant", ...o });
const fabricator = (o = {}) => ({ type: "fabricator", ...o });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("powerCap sums Reactors' grants; a constructing Reactor grants nothing", () => {
  assert.equal(powerCap(stub([reactor()]), "player"), BUILDINGS.reactor.energyGrants);
  assert.equal(powerCap(stub([reactor(), reactor()]), "player"), BUILDINGS.reactor.energyGrants * 2);
  assert.equal(powerCap(stub([reactor({ constructing: true })]), "player"), 0, "still going up → grants nothing yet");
  assert.equal(powerCap(stub([smelter()]), "player"), 0, "a factory grants no power");
});

test("powerDraw sums each factory's recipe energy × prodRate", () => {
  assert.equal(powerDraw(stub([smelter()]), "player"), 4, "smelt energy 2 × prodRate 2");
  assert.equal(powerDraw(stub([assembler()]), "player"), 3, "alloy energy 2 × prodRate 1.5");
  assert.equal(powerDraw(stub([smelter(), assembler()]), "player"), 7);
  assert.equal(powerDraw(stub([reactor()]), "player"), 0, "a Reactor draws nothing");
  assert.equal(powerDraw(stub([smelter({ constructing: true })]), "player"), 0, "a constructing factory draws nothing yet");
});

test("powerDraw: a Plasma Rig draws its rig.power, paused or not — paused idles at a 5% trickle", () => {
  assert.equal(powerDraw(stub([plasmarig()]), "player"), BUILDINGS.plasmarig.rig.power, "an active Rig draws its full plasma-arc Power");
  assert.ok(near(powerDraw(stub([plasmarig({ paused: true })]), "player"), BUILDINGS.plasmarig.rig.power * 0.05),
    "a paused Rig frees 95% of its reserved Power, not all of it");
  assert.equal(powerDraw(stub([plasmarig({ constructing: true })]), "player"), 0, "a constructing Rig draws nothing yet");
});

test("ice coolant: banked ice halves a factory's/Rig's Power draw (hasIceCoolant/iceCoolantMult)", () => {
  const noIce = stub([smelter(), plasmarig()], {});
  const withIce = stub([smelter(), plasmarig()], { ice: 5 });
  assert.equal(hasIceCoolant(noIce, "player"), false, "no ice banked → coolant inactive");
  assert.equal(hasIceCoolant(withIce, "player"), true, "any ice banked → coolant active");
  assert.equal(iceCoolantMult(noIce, "player"), 1);
  assert.equal(iceCoolantMult(withIce, "player"), 0.5);

  assert.ok(near(powerDraw(withIce, "player"), powerDraw(noIce, "player") * 0.5), "ice halves the whole owner's Power draw");
  // A dry stockpile (present but zero) still reads as "no coolant" — it's presence, not the key existing.
  assert.equal(hasIceCoolant(stub([], { ice: 0 }), "player"), false);
});

test("powerThrottle: full with power, zero without, fractional when factories out-draw the Reactors", () => {
  assert.equal(powerThrottle(stub([]), "player"), 1, "no factories → nothing to throttle");
  assert.equal(powerThrottle(stub([smelter()]), "player"), 0, "a factory with no Reactor is dead");
  assert.equal(powerThrottle(stub([reactor(), smelter()]), "player"), 1, "the Reactor's cap easily covers a single smelter's 4 draw");
  // Enough smelters (each drawing 4 — see the powerDraw test above) to out-draw one Reactor's
  // cap, whatever that cap is currently tuned to — reactor cap + N smelters' draw, throttled to cap/draw.
  const smelterDraw = 4, n = Math.ceil(BUILDINGS.reactor.energyGrants / smelterDraw) + 2;
  const many = stub([reactor(), ...Array.from({ length: n }, () => smelter())]);
  assert.ok(near(powerThrottle(many, "player"), BUILDINGS.reactor.energyGrants / (n * smelterDraw)),
    "over-draw throttles every factory by the same fraction");
});

test("a powered Smelter refines ore from its input larder into metals in its output buffer", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.1);
  // frac = prodRate 2 × throttle 1 × dt 0.1 = 0.2 batches; smelt is 2 ore → 2 metals
  assert.ok(near(sm.input.ore, 999.6), "0.2 batches × 2 ore = 0.4 ore drawn from the larder");
  assert.ok(near(sm.store.metals, 0.4), "0.2 batches × 2 = 0.4 metals banked to the output buffer");
  assert.equal(s.players.player.resources.ore || 0, 0, "the global treasury is untouched — inputs are local now");
});

test("ice coolant: banked ice halves the ore a Smelter burns per batch, same metals out", () => {
  const plain = stub([reactor(), smelter({ input: { ore: 1000 } })], {});
  const iced = stub([reactor(), smelter({ input: { ore: 1000 } })], { ice: 3 });
  const sm1 = [...plain.buildings.values()].find(b => b.type === "smelter");
  const sm2 = [...iced.buildings.values()].find(b => b.type === "smelter");
  updateProduction(plain, sm1, 0.1);
  updateProduction(iced, sm2, 0.1);
  assert.ok(near(sm1.store.metals, sm2.store.metals), "iced or not, the same batch runs at the same rate → same metals banked");
  assert.ok(near(1000 - sm1.input.ore, (1000 - sm2.input.ore) * 2), "…but the iced Smelter burned only half the ore for it");
});

test("chargeIceUpkeep drains a flat ice/sec from the treasury, clamped so it never goes negative", () => {
  const s = stub([], { ice: 1 });
  chargeIceUpkeep(s, "player", 1);   // 1 full second at 0.1/s
  assert.ok(near(s.players.player.resources.ice, 0.9), "1s of upkeep drains 0.1 ice");
  chargeIceUpkeep(s, "player", 100);   // wildly more than what's left
  assert.equal(s.players.player.resources.ice, 0, "clamped at zero — never negative");
});

test("ice coolant is a REAL cost: a running Smelter drains the treasury's ice, not just requires it", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 } })], { ice: 1 });
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.1);
  assert.ok(s.players.player.resources.ice < 1, "running the discount drains the banked ice");
  assert.ok(near(s.players.player.resources.ice, 1 - 0.1 * 0.1), "drains at the flat ICE_UPKEEP_PER_SEC rate × dt");
});

test("ice coolant: a factory that does nothing this tick (starved/stalled) is charged no ice upkeep", () => {
  const starved = stub([reactor(), smelter({ input: { ore: 0 } })], { ice: 1 });   // empty larder → frac stays 0
  const sm = [...starved.buildings.values()].find(b => b.type === "smelter");
  updateProduction(starved, sm, 0.1);
  assert.equal(starved.players.player.resources.ice, 1, "no batch ran → nothing to charge for, ice untouched");

  const unpowered = stub([smelter({ input: { ore: 1000 } })], { ice: 1 });   // no Reactor → throttle 0
  const sm2 = [...unpowered.buildings.values()].find(b => b.type === "smelter");
  updateProduction(unpowered, sm2, 0.1);
  assert.equal(unpowered.players.player.resources.ice, 1, "no Power → no production → no ice charged either");
});

test("ice coolant runs out: once the treasury's ice is drained to zero, the discount reverts to full-price", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 } })], { ice: 0.05 });   // enough for exactly one tick's upkeep
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.5);   // one tick, still iced (ice > 0 at the start of this call)
  assert.equal(s.players.player.resources.ice, 0, "that tick's upkeep drained it to exactly zero");
  const oreAfterFirstTick = sm.input.ore;

  updateProduction(s, sm, 0.5);   // a second, identical tick — now with NO ice banked
  const oreBurnedSecondTick = oreAfterFirstTick - sm.input.ore;
  const oreBurnedFirstTick = 1000 - oreAfterFirstTick;
  assert.ok(near(oreBurnedSecondTick, oreBurnedFirstTick * 2),
    `once ice hits zero, ore burn per identical tick doubles back to full price (${oreBurnedFirstTick} → ${oreBurnedSecondTick})`);
  assert.equal(s.players.player.resources.ice, 0, "still zero — no ice left to charge, and none to go negative");
});

test("production is clamped to the input larder — the buffer never goes negative", () => {
  const s = stub([reactor(), smelter({ input: { ore: 0.1 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 1.0);   // wants 2 batches (4 ore) but only 0.1 ore in the larder
  assert.ok(near(sm.input.ore, 0), "all available ore consumed, never below zero");
  assert.ok(sm.input.ore >= 0);
  assert.ok(near(sm.store.metals, 0.1), "0.05 batches × 2 = 0.1 metals from the scrap of ore");
});

test("a factory whose output buffer is full stalls until it's hauled off", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 }, store: { metals: 80 } })], {});  // 80 = default cap
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.5);
  assert.equal(sm.input.ore, 1000, "full output → no inputs drawn");
  assert.ok(near(storeTotal(sm), 80), "…and no more banked; it's stalled at capacity");
});

test("an unpowered factory produces nothing", () => {
  const s = stub([smelter({ input: { ore: 1000 } })], {});   // no Reactor
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.1);
  assert.equal((sm.store && sm.store.metals) || 0, 0, "no power → no production");
  assert.equal(sm.input.ore, 1000, "…and no inputs consumed");
});

test("a paused factory consumes no inputs, banks no output, and idles at a 5% Power trickle", () => {
  const s = stub([reactor(), smelter({ paused: true, input: { ore: 1000 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  assert.ok(near(powerDraw(s, "player"), 4 * 0.05), "a paused factory frees 95% of its reserved Power, not all of it");
  updateProduction(s, sm, 0.1);
  assert.equal(sm.input.ore, 1000, "paused → no ore consumed");
  assert.equal((sm.store && sm.store.metals) || 0, 0, "paused → no metals banked");
  sm.paused = false;                       // resume
  assert.equal(powerDraw(s, "player"), 4, "resumed → it reserves its full draw again");
  updateProduction(s, sm, 0.1);
  assert.ok(sm.store.metals > 0, "resumed → it refines again");
});

test("updateProduction is a no-op for a building with no recipe (e.g. a Command Center)", () => {
  const s = stub([{ type: "command" }], { ore: 500 });
  const cc = [...s.buildings.values()][0];
  assert.equal(recipeOf(cc), null, "a Command Center runs no recipe");
  updateProduction(s, cc, 0.1);
  assert.deepEqual(s.players.player.resources, { ore: 500 }, "a non-factory touches nothing");
});

// buildingConcern — the map-level "is this producer actually doing its job" read (renderBuildings.js's
// concern badge). Priority mirrors updateProduction/updatePlasmaRig/updateCombustors exactly, so these
// double as a cross-check that the badge can never disagree with what the sim is actually doing.
test("buildingConcern: paused reads 'paused' before anything else, for a factory, a Rig, or a power station", () => {
  const s = stub([reactor(), smelter({ paused: true, input: { ore: 1000 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  assert.deepEqual(buildingConcern(s, sm), { level: "paused" });

  const rigState = stub([reactor(), plasmarig({ paused: true })], { radioactives: 100 });
  const rig = [...rigState.buildings.values()].find(b => b.type === "plasmarig");
  assert.deepEqual(buildingConcern(rigState, rig), { level: "paused" });

  const genState = stub([{ type: "combustor", paused: true, powered: true }]);
  assert.deepEqual(buildingConcern(genState, [...genState.buildings.values()][0]), { level: "paused" });
});

test("buildingConcern: a dead grid reads 'bad' (noPower) for a factory or a Rig", () => {
  const s = stub([smelter({ input: { ore: 1000 } })], {});   // no Reactor
  assert.deepEqual(buildingConcern(s, [...s.buildings.values()][0]), { level: "bad", code: "noPower" });

  const rigState = stub([plasmarig()], { radioactives: 100 });
  assert.deepEqual(buildingConcern(rigState, [...rigState.buildings.values()][0]), { level: "bad", code: "noPower" });
});

test("buildingConcern: a Power-fed factory missing its input reads 'bad' (starved)", () => {
  const s = stub([reactor(), smelter({ input: { ore: 0 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  assert.deepEqual(buildingConcern(s, sm), { level: "bad", code: "starved" });
});

test("buildingConcern: a Rig out of radioactives reads 'bad' (noFuel)", () => {
  const s = stub([reactor(), plasmarig()], { radioactives: 0 });
  const rig = [...s.buildings.values()].find(b => b.type === "plasmarig");
  assert.deepEqual(buildingConcern(s, rig), { level: "bad", code: "noFuel" });
});

test("buildingConcern: a brimming output buffer reads 'bad' (bufferFull) for a factory or a Rig", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 }, store: { metals: 80 } })], {});   // 80 = default cap
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  assert.deepEqual(buildingConcern(s, sm), { level: "bad", code: "bufferFull" });

  const rigState = stub([reactor(), plasmarig({ store: { ore: 120 } })], { radioactives: 100 });   // 120 = Rig's cap
  const rig = [...rigState.buildings.values()].find(b => b.type === "plasmarig");
  assert.deepEqual(buildingConcern(rigState, rig), { level: "bad", code: "bufferFull" });
});

test("buildingConcern: an under-supplied grid (short of dead) reads 'warn' (throttled) once fed and clear", () => {
  const smelterDraw = 4, n = Math.ceil(BUILDINGS.reactor.energyGrants / smelterDraw) + 2;
  const s = stub([reactor(), ...Array.from({ length: n }, () => smelter({ input: { ore: 1000 } }))]);
  for (const sm of s.buildings.values()) {
    if (sm.type !== "smelter") continue;
    assert.deepEqual(buildingConcern(s, sm), { level: "warn", code: "throttled" });
  }
});

test("buildingConcern: a fully healthy factory or Rig reads null — nothing to flag", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 } })], {});
  assert.equal(buildingConcern(s, [...s.buildings.values()].find(b => b.type === "smelter")), null);

  const rigState = stub([reactor(), plasmarig()], { radioactives: 100 });
  assert.equal(buildingConcern(rigState, [...rigState.buildings.values()].find(b => b.type === "plasmarig")), null);
});

test("buildingConcern: an unfuelled power station reads 'bad' (noFuel); a fuelled one reads null", () => {
  const dry = stub([{ type: "combustor", powered: false }]);
  assert.deepEqual(buildingConcern(dry, [...dry.buildings.values()][0]), { level: "bad", code: "noFuel" });
  const lit = stub([{ type: "combustor", powered: true }]);
  assert.equal(buildingConcern(lit, [...lit.buildings.values()][0]), null);
});

test("buildingConcern is a no-op while still constructing, and null for a non-producer building", () => {
  const s = stub([smelter({ constructing: true, input: { ore: 1000 } })], {});
  assert.equal(buildingConcern(s, [...s.buildings.values()][0]), null, "still going up → nothing to flag yet");
  const cc = stub([{ type: "command" }], {});
  assert.equal(buildingConcern(cc, [...cc.buildings.values()][0]), null, "not a producer at all");
});

test("each hop runs on its own larder: the Smelter banks metals, the Assembly Plant banks alloys", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 } }), assembler({ input: { metals: 40 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  const as = [...s.buildings.values()].find(b => b.type === "assembler");
  for (let i = 0; i < 100; i++) { updateProduction(s, sm, 0.1); updateProduction(s, as, 0.1); }
  assert.ok(sm.store.metals > 0, "the Smelter banked metals from its ore larder");
  assert.ok(as.store.alloys > 0, "the Assembly Plant banked alloys from its metals larder");
  assert.ok(as.input.metals < 40, "…consuming the metals workers carried into its larder");
});

// ---- Promote the legacy consumer-goods recipes into a trade-industry branch (docs/improvement-
// proposals.md lines 443-451): the SAME chain-production pattern as the Smelter -> Assembly Plant
// pair above, but for the new trade-industry branch — Chemical Plant (recipe 'chem': biomass+power
// -> chemicals) into Fabricator (recipe 'consumer': alloys+chemicals+power -> goods).

test("the trade-industry branch chains too: the Chemical Plant banks chemicals, the Fabricator banks goods", () => {
  const s = stub([reactor(), chemplant({ input: { biomass: 1000 } }), fabricator({ input: { alloys: 1000, chemicals: 1000 } })], {});
  const cp = [...s.buildings.values()].find(b => b.type === "chemplant");
  const fab = [...s.buildings.values()].find(b => b.type === "fabricator");
  for (let i = 0; i < 100; i++) { updateProduction(s, cp, 0.1); updateProduction(s, fab, 0.1); }
  assert.ok(cp.store.chemicals > 0, "the Chemical Plant banked chemicals from its biomass larder");
  assert.ok(fab.store.goods > 0, "the Fabricator banked consumer goods from its alloys+chemicals larder");
  assert.ok(fab.input.alloys < 1000, "…consuming the alloys workers carried into its larder");
  assert.ok(fab.input.chemicals < 1000, "…and the chemicals too — both real inputs of the merge recipe");
});

test("the Chemical Plant runs on biomass + power alone — no ore, no metals, no alloys chain needed", () => {
  const s = stub([reactor(), chemplant({ input: { biomass: 1000 } })], {});
  const cp = [...s.buildings.values()].find(b => b.type === "chemplant");
  updateProduction(s, cp, 0.1);
  assert.ok(cp.store.chemicals > 0, "chemicals banked from biomass + power alone");
  assert.equal(s.players.player.resources.ore || 0, 0, "no ore was ever touched — the off-spine root branch needs none");
});

test("production is deterministic — identical setups fill identical buffers", () => {
  const run = () => {
    const s = stub([reactor(), smelter({ input: { ore: 500 } }), assembler({ input: { metals: 200 } })], {});
    const bs = [...s.buildings.values()];
    for (let i = 0; i < 200; i++) for (const b of bs) updateProduction(s, b, 0.1);
    return bs.map(b => ({ store: { ...b.store }, input: { ...b.input } }));
  };
  assert.deepEqual(run(), run());
});

test("end-to-end: workers supply a built chain and haul its goods, and the alloys sell for credits", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  for (const u of [...s.units.values()]) if (u.type === "colonyship") deployColonyShip(s, u.id);   // deploy start ships → CCs
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  // Plant the whole chain, completed, next to the capital. The Reactor gets its own big,
  // self-sufficient fuel larder up front — this test is about the ore→metals→alloys chain, not
  // the Reactor's own fuel logistics (haul.test.js covers that), so its labour isn't split feeding both.
  for (const [type, dx] of [["reactor", 40], ["smelter", 74], ["assembler", 108]]) {
    const b = makeBuilding(type, "player", cc.x + dx, cc.y + 40);
    if (type === "reactor") b.input = { radioactives: 100000 };
    s.buildings.set(b.id, b);
  }
  s.players.player.resources.ore = 5000;                 // plenty of feedstock in the treasury for workers to supply
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "player", cc.x + 20, cc.y + 20); s.units.set(w.id, w); }  // hands to run the logistics
  // The chain now needs WORKERS: a round-trip service carries ore→smelter and metals back, then
  // metals→assembler and alloys back. Run until a sellable pile of alloys has flowed to the treasury.
  for (let i = 0; i < 5000 && (s.players.player.resources.alloys || 0) < 5; i++) stepGalaxy(g, 0.1);

  assert.ok((s.players.player.resources.alloys || 0) > 0, "workers fed the chain and hauled the alloys back to the treasury");
  const creditsBefore = g.credits;
  const proceeds = sell(g, s, "alloys", 1);              // offload some of what the chain made
  assert.ok(proceeds > 0, "refined alloys sell for real credits — the payoff");
  assert.equal(g.credits, creditsBefore + proceeds, "credits banked the sale");
});

test("a researched passive tech lifts production — Heavy Alloys yields ~40% more from the same ore", () => {
  const plain = stub([reactor(), smelter({ input: { ore: 1000 } })], {});
  const teched = stub([reactor(), smelter({ input: { ore: 1000 } })], {});
  teched.players.player.upgrades = { heavyalloys: true };
  const sm1 = [...plain.buildings.values()].find(b => b.type === "smelter");
  const sm2 = [...teched.buildings.values()].find(b => b.type === "smelter");
  updateProduction(plain, sm1, 0.1);
  updateProduction(teched, sm2, 0.1);
  assert.ok(near(sm2.store.metals, sm1.store.metals * 1.4), "Heavy Alloys yields 40% more metals per batch");
});

test("planetIndustryScale scales factory speed by a world's industry rating, clamped [0.5, 2]", () => {
  assert.equal(planetIndustryScale({ planetId: "forge" }), 2, "Forge (industry 10) runs at 2×");
  assert.equal(planetIndustryScale({ planetId: "vesper" }), 1, "Vesper (industry 5) is the neutral pivot");
  assert.ok(near(planetIndustryScale({ planetId: "ferros" }), 0.8), "Ferros (industry 4) → 0.8×");
  assert.equal(planetIndustryScale({ planetId: "oort" }), 0.5, "Oort (industry 2) → clamped to 0.5×, never zero");
  assert.equal(planetIndustryScale({ planetId: "nowhere" }), 1, "an unknown world falls to the neutral pivot");
});

test("a high-industry world out-produces a low-industry one over identical ticks", () => {
  const mk = (planetId) => {
    const s = createGameState({ planetId, endless: true });
    const reactor = makeBuilding("reactor", "player", 600, 480);
    reactor.powered = true;   // this loop only ever calls updateProduction directly, never updateCombustors/tick()
    const smelter = makeBuilding("smelter", "player", 660, 520);
    smelter.input = { ore: 100000 };
    s.buildings.set(reactor.id, reactor); s.buildings.set(smelter.id, smelter);
    for (let i = 0; i < 50; i++) updateProduction(s, smelter, 0.1);
    return storeTotal(smelter);
  };
  assert.ok(near(mk("forge"), mk("vesper") * 2), "Forge's factories (industry 10) run twice as fast as Vesper's (industry 5)");
});

test("powerEfficiency: the further a spot sits from a Reactor, the worse its grid tier", () => {
  const at = (x, y, reactorAt = { x: 0, y: 0 }) =>
    powerEfficiency(stub([reactor(reactorAt)]), "player", x, y);
  assert.equal(at(0, 100).name, "linked", "100px out → on-grid");
  assert.equal(at(250, 0).name, "near", "250px out → near-grid");
  assert.equal(at(400, 0).name, "far", "400px out → far");
  assert.equal(at(600, 0).name, "isolated", "600px out → isolated");
  // Each tier's multiplier is monotonically ≥ the last, and the on-grid tier is exactly 1×.
  assert.equal(POWER_TIERS[0].mult, 1, "on-grid draws no penalty");
  for (let i = 1; i < POWER_TIERS.length; i++)
    assert.ok(POWER_TIERS[i].mult > POWER_TIERS[i - 1].mult, "further bands cost strictly more");
});

test("powerEfficiency: no Reactor (or a non-positional stub) is the neutral on-grid tier", () => {
  assert.equal(powerEfficiency(stub([]), "player", 999, 999).name, "linked", "no grid to lose against → ×1");
  // The industry unit-test stubs omit x/y; a NaN distance must read as on-grid, not poison the scan.
  assert.equal(powerEfficiency(stub([reactor()]), "player", undefined, undefined).name, "linked");
});

test("a factory far from its Reactor draws MORE grid capacity for the same job", () => {
  const onGrid = stub([reactor({ x: 0, y: 0 }), smelter({ x: 0, y: 100 })]);   // linked
  const isolated = stub([reactor({ x: 0, y: 0 }), smelter({ x: 600, y: 0 })]); // isolated
  assert.ok(near(powerDraw(onGrid, "player"), 4), "on-grid Smelter draws its base 4");
  assert.ok(near(powerDraw(isolated, "player"), 4 * 2.3), "an isolated Smelter draws 2.3× — transmission loss");

  // On a tight grid (one Reactor's cap, N Smelters chosen to just fit it clustered) the same N
  // factories run at full speed clustered on-grid but throttle when isolated (transmission loss
  // inflates their draw 2.3×) — whatever the Reactor's cap is currently tuned to.
  const n = Math.max(1, Math.floor(BUILDINGS.reactor.energyGrants / 4));
  const five = (spot) => stub([reactor({ x: 0, y: 0 }), ...Array.from({ length: n }, () => smelter(spot))]);
  assert.equal(powerThrottle(five({ x: 0, y: 100 }), "player"), 1, "clustered on-grid → the grid just covers them");
  assert.ok(powerThrottle(five({ x: 600, y: 0 }), "player") < 0.5, "isolated → their inflated draw starves the grid");
});

test("grid efficiency is deterministic — identical layouts give identical draw", () => {
  const build = () => stub([reactor({ x: 0, y: 0 }), smelter({ x: 300, y: 120 }), smelter({ x: 500, y: 0 })]);
  assert.equal(powerDraw(build(), "player"), powerDraw(build(), "player"));
});

test("industry is Odyssey-only: the buildings are flagged, and a skirmish makes no refined goods", () => {
  for (const t of ["reactor", "smelter", "assembler"]) assert.equal(BUILDINGS[t].odysseyOnly, true, `${t} is Odyssey-only`);
  const state = createGameState({ planetId: "ferros" });   // a plain skirmish (not endless)
  for (let i = 0; i < 60; i++) tick(state, 0.1);
  for (const owner of ["player", "ai"]) {
    assert.equal(state.players[owner].resources.metals || 0, 0, "no factories in a skirmish → no metals");
    assert.equal(state.players[owner].resources.alloys || 0, 0, "…and no alloys");
  }
});

test("Heavy Alloys is scoped to the Smelter/Assembly Plant it names — a Chip Fab batch is unaffected", () => {
  const plain = stub([reactor(), chipfab({ input: { crystals: 1000, metals: 1000 } })], {});
  const teched = stub([reactor(), chipfab({ input: { crystals: 1000, metals: 1000 } })], {});
  teched.players.player.upgrades = { heavyalloys: true };
  const cf1 = [...plain.buildings.values()].find(b => b.type === "chipfab");
  const cf2 = [...teched.buildings.values()].find(b => b.type === "chipfab");
  updateProduction(plain, cf1, 0.1);
  updateProduction(teched, cf2, 0.1);
  assert.ok(near(cf1.store.electronics, cf2.store.electronics),
    "Heavy Alloys' tooltip names only the Smelter/Assembly Plant — a Chip Fab batch must come out identical either way");
});

/* ---------- Grid Substation: a passive one-hop relay that extends power-grid reach ----------
   A cheap odysseyOnly relay (BUILDINGS.substation: no energyGrants, no fuel) that, while it stands
   within an active source's own 'linked' band, counts as a second, shorter-range virtual source
   point for grid-TIER purposes only — power CAPACITY still only ever comes from a fuelled station
   (powerCap sums energyGrants alone, untouched by a relay). One hop only: a relay never chains
   through another relay (bestGridDist's relay pass qualifies each one against REAL sources alone). */

test("a Substation relay, linked to an active source, improves a far consumer's grid tier", () => {
  // Reactor at the origin (powerRange 1: linked <=190, near <=320). A relay 160px out is
  // comfortably inside the Reactor's own linked band, so it qualifies as a virtual source. A spot
  // 260px from the Reactor (comfortably "near", not "linked", on its own) sits only 100px from the
  // relay — comfortably inside the relay's OWN (shorter, ~0.8×) linked reach.
  const withoutRelay = stub([reactor({ x: 0, y: 0 })]);
  const withRelay = stub([reactor({ x: 0, y: 0 }), substation({ x: 160, y: 0 })]);

  const bare = powerEfficiency(withoutRelay, "player", 260, 0);
  const relayed = powerEfficiency(withRelay, "player", 260, 0);

  assert.equal(bare.name, "near", "sanity: 260px direct from the Reactor is only 'near'");
  assert.equal(relayed.name, "linked", "…but a linked relay 100px away pulls the same spot onto 'linked'");
  assert.ok(relayed.mult < bare.mult, "the relay strictly improves the draw multiplier, never worsens it");
});

test("a Substation relay with no active source in reach relays nothing", () => {
  // The relay sits 1000px from the Reactor — nowhere near the 190px 'linked' band — so it never
  // qualifies as a virtual source. A consumer parked right next to the unlinked relay gets no help
  // from it at all: the exact same tier as if the relay didn't exist.
  const noRelay = stub([reactor({ x: 0, y: 0 })]);
  const unlinkedRelay = stub([reactor({ x: 0, y: 0 }), substation({ x: 1000, y: 0 })]);
  const spot = { x: 1050, y: 0 };   // right beside the unlinked relay

  assert.equal(powerEfficiency(unlinkedRelay, "player", spot.x, spot.y).name,
    powerEfficiency(noRelay, "player", spot.x, spot.y).name,
    "an unlinked relay contributes nothing — same tier with or without it");
  assert.equal(powerEfficiency(noRelay, "player", spot.x, spot.y).name, "isolated",
    "sanity: this spot really is isolated without a linked relay's help");
});

test("a still-constructing Substation doesn't relay power yet", () => {
  const going = stub([reactor({ x: 0, y: 0 }), substation({ x: 160, y: 0, constructing: true })]);
  assert.equal(powerEfficiency(going, "player", 260, 0).name, "near",
    "a relay that hasn't finished building doesn't count as a virtual source yet");
});

test("powerCap: a Substation relay grants no Power capacity of its own — only fuelled stations do", () => {
  assert.equal(BUILDINGS.substation.energyGrants, undefined, "no energyGrants — capacity still only comes from fuelled stations");
  assert.equal(powerCap(stub([substation({ x: 0, y: 0 })]), "player"), 0, "a relay alone grants zero Power capacity");
  assert.equal(powerCap(stub([reactor({ x: 0, y: 0 }), substation({ x: 10, y: 0 })]), "player"), BUILDINGS.reactor.energyGrants,
    "a relay alongside a Reactor adds nothing to capacity — only extends reach");
});

test("powerDraw: a linked Substation relay adds its own small flat grid draw (the ELECTRIFY_POWER idiom)", () => {
  const s = stub([reactor({ x: 0, y: 0 }), substation({ x: 50, y: 0 })]);   // well within the linked band → full efficiency
  assert.ok(near(powerDraw(s, "player"), ELECTRIFY_POWER), "a well-linked relay draws the flat relay amount at full (×1.0) efficiency");
});

test("cachedPowerThrottle re-computes when the grid changes, even on a state with no tick counter (A11)", () => {
  // The cache invalidates on state.tick. A state with no tick field — the hand-built stub idiom used
  // throughout this file, and anything else that doesn't come from tick() — stored
  // _powerCacheTick = undefined, and `undefined !== undefined` is false FOREVER, so the very first
  // result was frozen for the life of the state.
  const s = stub([{ id: "f1", type: "smelter" }]);
  assert.equal(s.tick, undefined, "fixture sanity: this stub has no tick counter");

  const first = cachedPowerThrottle(s, "player");
  s.buildings.set("r1", { id: "r1", owner: "player", constructing: false, type: "reactor", powered: true });
  const fresh = powerThrottle(s, "player");
  assert.notEqual(fresh, first, "fixture sanity: the grid really did change");
  assert.equal(cachedPowerThrottle(s, "player"), fresh,
    "the cache must not hand back a stale throttle on a state it cannot key");
});

test("buildingConcern's bufferFull threshold agrees with updateProduction's own gate (A11)", () => {
  // buildingConcern claims to mirror updateProduction's gating "exactly, so the badge never
  // disagrees with what's actually happening in the sim". It didn't: the factory branch called it
  // full at storeRoom <= 1e-6 while updateProduction produces for ANY positive room (`frac > 0`).
  const s = createGameState({ planetId: "ferros", seed: 3 });
  const sm = makeBuilding("smelter", "player", 700, 500);
  sm.constructing = false;
  sm.buildProgress = 1;
  s.buildings.set(sm.id, sm);
  const reactor = makeBuilding("reactor", "player", 660, 500);
  reactor.constructing = false;
  reactor.powered = true;
  s.buildings.set(reactor.id, reactor);

  const recipe = recipeOf(sm);
  sm.input = sm.input || {};
  sm.store = sm.store || {};
  for (const com in recipe.in) if (com !== "energy") sm.input[com] = 1000;
  sm.store[recipe.out] = storeCapOf("smelter") - 5e-7;       // a sliver of room: tiny, but positive

  // Read the badge FIRST, while the sliver is still open — production itself closes it.
  const concern = buildingConcern(s, sm);
  const before = sm.store[recipe.out];
  updateProduction(s, sm, 0.1);
  assert.ok(sm.store[recipe.out] > before, "fixture sanity: the sim really does still produce into that sliver");
  assert.notEqual(concern && concern.code, "bufferFull",
    "the badge must not read bufferFull while updateProduction is still banking output");
});
