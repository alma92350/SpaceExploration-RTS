import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { powerCap, powerEfficiency, updateCombustors } from "../engine/industry.js";
import { BUILDINGS } from "../engine/entities.js";

// A tiny stub, like industry.test.js: the power helpers read only buildings + resources.
function stub(buildings = [], resources = {}) {
  return {
    buildings: new Map(buildings.map((b, i) => {
      const id = b.id || `b${i}`;
      return [id, { id, owner: "player", constructing: false, ...b }];
    })),
    players: { player: { resources } },
  };
}
const combustor = (o = {}) => ({ type: "combustor", ...o });
const reactor = (o = {}) => ({ type: "reactor", ...o });

test("a Combustion Generator grants Power only while it's fuelled", () => {
  const s = stub([combustor()], { gas: 100 });
  assert.equal(powerCap(s, "player"), 0, "before a tick it hasn't burned fuel → grants nothing");
  updateCombustors(s, 0.1);
  assert.equal(powerCap(s, "player"), BUILDINGS.combustor.energyGrants, "fuelled → grants its Power");
  const gen = [...s.buildings.values()][0];
  assert.ok(gen.powered && s.players.player.resources.gas < 100, "…having burned some gas to do it");
});

test("out of fuel (or paused), a Generator grants no Power", () => {
  const dry = stub([combustor()], {});                 // no gas, no biomass
  updateCombustors(dry, 0.1);
  assert.equal(powerCap(dry, "player"), 0, "no fuel → dead");

  const paused = stub([combustor({ paused: true })], { biomass: 100 });
  updateCombustors(paused, 0.1);
  assert.equal(powerCap(paused, "player"), 0, "paused → dead, and no fuel burned");
  assert.equal(paused.players.player.resources.biomass, 100, "…the stockpile is untouched");
});

test("it burns gas OR biomass — whichever the stockpile has more of", () => {
  const s = stub([combustor()], { biomass: 50 });      // only biomass on hand
  updateCombustors(s, 0.1);
  const gen = [...s.buildings.values()][0];
  assert.equal(gen.fuel, "biomass", "falls back to biomass when there's no gas");
  assert.ok(s.players.player.resources.biomass < 50, "…and consumes it");
});

test("a Generator's grid is SMALLER than a Reactor's (its powerRange shrinks the tiers)", () => {
  // 250px out: on a Reactor's grid that's the 'near' tier; on a Generator's tighter grid it's already 'isolated'.
  const nearReactor = stub([reactor({ x: 0, y: 0 })]);
  const nearGen = stub([combustor({ x: 0, y: 0, powered: true })]);   // pre-mark fuelled so it counts as a source
  const rTier = powerEfficiency(nearReactor, "player", 250, 0).name;
  const gTier = powerEfficiency(nearGen, "player", 250, 0).name;
  assert.equal(rTier, "near", "a Reactor still reaches 250px at the 'near' tier");
  assert.ok(BUILDINGS.combustor.powerRange < 1, "the Generator has a shorter reach");
  assert.notEqual(gTier, "linked", "the same 250px spot is off the Generator's tight on-grid zone");
  assert.ok(["far", "isolated"].includes(gTier), `…it's a worse tier on the smaller grid (${gTier})`);
});

test("an unfuelled Generator isn't a grid source at all (no false on-grid reading)", () => {
  const s = stub([combustor({ x: 0, y: 0 })]);   // not powered
  assert.equal(powerEfficiency(s, "player", 30, 0).name, "linked",
    "with no active source, a spot reads the neutral tier — not 'on-grid' off a dead Generator");
});

test("the Generator is Odyssey-only and its fuel state is deterministic + save-clean", () => {
  assert.equal(BUILDINGS.combustor.odysseyOnly, true);
  const run = () => {
    const s = createGameState({ planetId: "ferros", endless: true });
    const gen = makeBuilding("combustor", "player", 600, 500);
    s.buildings.set(gen.id, gen);
    s.players.player.resources.gas = 100;
    for (let i = 0; i < 50; i++) tick(s, 0.1);
    return s.players.player.resources.gas;
  };
  assert.equal(run(), run(), "same seed → identical fuel burn");

  // `powered`/`fuel` are transient — they must not ride along in a save.
  const s = createGameState({ planetId: "ferros", endless: true });
  const gen = makeBuilding("combustor", "player", 600, 500);
  s.buildings.set(gen.id, gen);
  s.players.player.resources.gas = 100;
  tick(s, 0.1);
  const saved = serializeGame(s).buildings.find(b => b.type === "combustor");
  assert.equal(saved.powered, undefined, "the transient power flag is stripped from the save");
  assert.equal(saved.fuel, undefined, "…and so is the transient fuel tag");
  assert.ok(deserializeGame(serializeGame(s)), "and the save round-trips");
});
