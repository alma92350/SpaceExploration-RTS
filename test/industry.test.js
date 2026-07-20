import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, activeState, stepGalaxy } from "../engine/galaxy.js";
import { sell } from "../engine/market.js";
import { powerCap, powerDraw, powerThrottle, updateProduction, recipeOf, planetIndustryScale } from "../engine/industry.js";
import { BUILDINGS } from "../engine/entities.js";

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

test("a powered Smelter refines ore into metals, fractionally", () => {
  const s = stub([reactor(), smelter()], { ore: 1000 });
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.1);
  // frac = prodRate 2 × throttle 1 × dt 0.1 = 0.2 batches; smelt is 2 ore → 2 metals
  assert.ok(near(s.players.player.resources.ore, 999.6), "0.2 batches × 2 ore = 0.4 ore consumed");
  assert.ok(near(s.players.player.resources.metals, 0.4), "0.2 batches × 2 = 0.4 metals produced");
});

test("production is clamped to inputs in stock — the stockpile never goes negative", () => {
  const s = stub([reactor(), smelter()], { ore: 0.1 });
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 1.0);   // wants 2 batches (4 ore) but only 0.1 ore exists
  assert.ok(near(s.players.player.resources.ore, 0), "all available ore consumed, never below zero");
  assert.ok(s.players.player.resources.ore >= 0);
  assert.ok(near(s.players.player.resources.metals, 0.1), "0.05 batches × 2 = 0.1 metals from the scrap of ore");
});

test("an unpowered factory produces nothing", () => {
  const s = stub([smelter()], { ore: 1000 });   // no Reactor
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  updateProduction(s, sm, 0.1);
  assert.equal(s.players.player.resources.metals || 0, 0, "no power → no production");
  assert.equal(s.players.player.resources.ore, 1000, "…and no inputs consumed");
});

test("updateProduction is a no-op for a building with no recipe (e.g. a Command Center)", () => {
  const s = stub([{ type: "command" }], { ore: 500 });
  const cc = [...s.buildings.values()][0];
  assert.equal(recipeOf(cc), null, "a Command Center runs no recipe");
  updateProduction(s, cc, 0.1);
  assert.deepEqual(s.players.player.resources, { ore: 500 }, "a non-factory touches nothing");
});

test("the chain runs two hops: the Smelter's metals feed the Assembly Plant, which banks alloys", () => {
  const s = stub([reactor(), smelter(), assembler()], { ore: 1000 });
  const sm = [...s.buildings.values()].find(b => b.type === "smelter");
  const as = [...s.buildings.values()].find(b => b.type === "assembler");
  for (let i = 0; i < 100; i++) { updateProduction(s, sm, 0.1); updateProduction(s, as, 0.1); }
  const res = s.players.player.resources;
  assert.ok(res.alloys > 0, "alloys manufactured from ore, two hops down the chain");
  assert.ok(res.ore < 1000, "raw ore consumed to make them");
  assert.ok(res.metals >= 0, "metals is a real intermediate, never negative");
});

test("production is deterministic — identical setups produce identical stockpiles", () => {
  const run = () => {
    const s = stub([reactor(), smelter(), assembler()], { ore: 500 });
    const bs = [...s.buildings.values()];
    for (let i = 0; i < 200; i++) for (const b of bs) updateProduction(s, b, 0.1);
    return s.players.player.resources;
  };
  assert.deepEqual(run(), run());
});

test("end-to-end: a built chain refines through the real Odyssey tick, and the alloys sell for credits", () => {
  const g = createGalaxy({ seed: 3 });
  const s = activeState(g);
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  // Plant the whole chain, completed, next to the capital (added last, so the
  // Smelter ticks before the Assembly Plant → metals are there to alloy same tick).
  for (const [type, dx] of [["reactor", 40], ["smelter", 74], ["assembler", 108]]) {
    const b = makeBuilding(type, "player", cc.x + dx, cc.y + 40);
    s.buildings.set(b.id, b);
  }
  s.players.player.resources.ore = 5000;                 // plenty of feedstock
  for (let i = 0; i < 80; i++) stepGalaxy(g, 0.1);        // ~8s of the REAL sim (updateProduction is wired in sim.js)

  assert.ok((s.players.player.resources.alloys || 0) > 0, "the Assembly Plant manufactured alloys through the live tick");
  const creditsBefore = g.credits;
  const proceeds = sell(g, s, "alloys", 1000);           // offload everything the chain made
  assert.ok(proceeds > 0, "refined alloys sell for real credits — the payoff");
  assert.equal(g.credits, creditsBefore + proceeds, "credits banked the sale");
});

test("a researched passive tech lifts production — Heavy Alloys yields ~40% more from the same ore", () => {
  const plain = stub([reactor(), smelter()], { ore: 1000 });
  const teched = stub([reactor(), smelter()], { ore: 1000 });
  teched.players.player.upgrades = { heavyalloys: true };
  const sm1 = [...plain.buildings.values()].find(b => b.type === "smelter");
  const sm2 = [...teched.buildings.values()].find(b => b.type === "smelter");
  updateProduction(plain, sm1, 0.1);
  updateProduction(teched, sm2, 0.1);
  const m1 = plain.players.player.resources.metals, m2 = teched.players.player.resources.metals;
  assert.ok(near(m2, m1 * 1.4), "Heavy Alloys yields 40% more metals per batch");
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
    s.buildings.set(reactor.id, reactor); s.buildings.set(smelter.id, smelter);
    s.players.player.resources.ore = 100000;
    for (let i = 0; i < 50; i++) updateProduction(s, smelter, 0.1);
    return s.players.player.resources.metals;
  };
  assert.ok(near(mk("forge"), mk("vesper") * 2), "Forge's factories (industry 10) run twice as fast as Vesper's (industry 5)");
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
