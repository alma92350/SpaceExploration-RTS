import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { storeTotal } from "../engine/entities.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, activeState, stepGalaxy } from "../engine/galaxy.js";
import { sell } from "../engine/market.js";
import { powerCap, powerDraw, powerThrottle, updateProduction, recipeOf, planetIndustryScale, powerEfficiency, POWER_TIERS } from "../engine/industry.js";
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
const reactor = (o = {}) => ({ type: "reactor", ...o });
const smelter = (o = {}) => ({ type: "smelter", ...o });
const assembler = (o = {}) => ({ type: "assembler", ...o });
const near = (a, b) => Math.abs(a - b) < 1e-9;

test("powerCap sums Reactors' grants; a constructing Reactor grants nothing", () => {
  assert.equal(powerCap(stub([reactor()]), "player"), 20);
  assert.equal(powerCap(stub([reactor(), reactor()]), "player"), 40);
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

test("powerThrottle: full with power, zero without, fractional when factories out-draw the Reactors", () => {
  assert.equal(powerThrottle(stub([]), "player"), 1, "no factories → nothing to throttle");
  assert.equal(powerThrottle(stub([smelter()]), "player"), 0, "a factory with no Reactor is dead");
  assert.equal(powerThrottle(stub([reactor(), smelter()]), "player"), 1, "a 20 cap easily covers a 4 draw");
  // reactor (20 cap) + 6 smelters (24 draw) → throttled to 20/24
  const many = stub([reactor(), smelter(), smelter(), smelter(), smelter(), smelter(), smelter()]);
  assert.ok(near(powerThrottle(many, "player"), 20 / 24), "over-draw throttles every factory by the same fraction");
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

test("a paused factory consumes no inputs, banks no output, and frees its Power", () => {
  const s = stub([reactor(), smelter({ paused: true, input: { ore: 1000 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  assert.equal(powerDraw(s, "player"), 0, "a paused factory reserves no Power (frees the grid for others)");
  updateProduction(s, sm, 0.1);
  assert.equal(sm.input.ore, 1000, "paused → no ore consumed");
  assert.equal((sm.store && sm.store.metals) || 0, 0, "paused → no metals banked");
  sm.paused = false;                       // resume
  assert.equal(powerDraw(s, "player"), 4, "resumed → it reserves its draw again");
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

test("each hop runs on its own larder: the Smelter banks metals, the Assembly Plant banks alloys", () => {
  const s = stub([reactor(), smelter({ input: { ore: 1000 } }), assembler({ input: { metals: 40 } })], {});
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  const as = [...s.buildings.values()].find(b => b.type === "assembler");
  for (let i = 0; i < 100; i++) { updateProduction(s, sm, 0.1); updateProduction(s, as, 0.1); }
  assert.ok(sm.store.metals > 0, "the Smelter banked metals from its ore larder");
  assert.ok(as.store.alloys > 0, "the Assembly Plant banked alloys from its metals larder");
  assert.ok(as.input.metals < 40, "…consuming the metals workers carried into its larder");
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
  // Plant the whole chain, completed, next to the capital.
  for (const [type, dx] of [["reactor", 40], ["smelter", 74], ["assembler", 108]]) {
    const b = makeBuilding(type, "player", cc.x + dx, cc.y + 40);
    s.buildings.set(b.id, b);
  }
  s.players.player.resources.ore = 5000;                 // plenty of feedstock in the treasury for workers to supply
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "player", cc.x + 20, cc.y + 20); s.units.set(w.id, w); }  // hands to run the logistics
  // The chain now needs WORKERS: supply ore→smelter, haul metals→CC, supply metals→assembler, haul alloys→CC.
  for (let i = 0; i < 5000 && (s.players.player.resources.alloys || 0) <= 0; i++) stepGalaxy(g, 0.1);

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

  // On a tight grid (one Reactor's 20 cap, five Smelters) the same five factories run at
  // full speed when clustered on-grid (5×4 = 20) but throttle when isolated (5×9.2 = 46).
  const five = (spot) => stub([reactor({ x: 0, y: 0 }), ...Array.from({ length: 5 }, () => smelter(spot))]);
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
