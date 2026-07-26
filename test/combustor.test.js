import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { powerCap, powerEfficiency, onPowerGrid, updateCombustors, hasIceCoolant } from "../engine/industry.js";
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
const biomassreactor = (o = {}) => ({ type: "biomassreactor", ...o });
const reactor = (o = {}) => ({ type: "reactor", ...o });

test("a Combustion Generator grants Power only while its OWN fuel larder is fed — not the treasury directly", () => {
  // Fuel now lives in the building's own `input` larder (engine/haul.js — a worker hauls it in,
  // same as a factory's input), not drawn straight from state.players.resources. A full treasury
  // with an EMPTY larder still grants nothing.
  const untouched = stub([combustor()], { gas: 100 });
  updateCombustors(untouched, 0.1);
  assert.equal(powerCap(untouched, "player"), 0, "a full treasury doesn't power it — the larder is what matters, and it's empty");

  const s = stub([combustor({ input: { gas: 100 } })], {});
  assert.equal(powerCap(s, "player"), 0, "before a tick it hasn't burned fuel → grants nothing");
  updateCombustors(s, 0.1);
  assert.equal(powerCap(s, "player"), BUILDINGS.combustor.energyGrants, "fuelled → grants its Power");
  const gen = [...s.buildings.values()][0];
  assert.ok(gen.powered && gen.input.gas < 100, "…having burned some gas from its OWN larder to do it");
});

test("ice coolant: banked ice halves every power station's fuel burn, same Power granted", () => {
  for (const [type, fuel] of [["combustor", "gas"], ["reactor", "radioactives"], ["biomassreactor", "biomass"]]) {
    const plain = stub([{ type, input: { [fuel]: 100 } }], {});
    const iced = stub([{ type, input: { [fuel]: 100 } }], { ice: 4 });
    assert.equal(hasIceCoolant(plain, "player"), false);
    assert.equal(hasIceCoolant(iced, "player"), true);
    updateCombustors(plain, 0.1);
    updateCombustors(iced, 0.1);
    const genPlain = [...plain.buildings.values()][0];
    const genIced = [...iced.buildings.values()][0];
    assert.ok(genPlain.powered && genIced.powered, `${type}: both stay fuelled and powered`);
    const burnedPlain = 100 - genPlain.input[fuel];
    const burnedIced = 100 - genIced.input[fuel];
    assert.ok(Math.abs(burnedPlain - burnedIced * 2) < 1e-9, `${type}: iced burns half the ${fuel} for the same tick`);
    assert.equal(powerCap(iced, "player"), BUILDINGS[type].energyGrants, `${type}: still grants its full Power despite burning less fuel`);
  }
});

test("out of fuel (or paused), a Generator grants no Power", () => {
  const dry = stub([combustor()], {});                 // empty larder — no gas
  updateCombustors(dry, 0.1);
  assert.equal(powerCap(dry, "player"), 0, "no fuel → dead");

  const paused = stub([combustor({ paused: true, input: { gas: 100 } })], {});
  updateCombustors(paused, 0.1);
  assert.equal(powerCap(paused, "player"), 0, "paused → dead, and no fuel burned");
  assert.equal([...paused.buildings.values()][0].input.gas, 100, "…the larder is untouched");
});

test("the Combustion Generator is gas-only", () => {
  assert.deepEqual(BUILDINGS.combustor.combust.fuels, ["gas"]);
});

test("the Biomass Reactor is the Combustion Generator's sibling — same deal, but biomass-only", () => {
  assert.deepEqual(BUILDINGS.biomassreactor.combust.fuels, ["biomass"]);
  assert.equal(BUILDINGS.biomassreactor.energyGrants, BUILDINGS.combustor.energyGrants);
  assert.equal(BUILDINGS.biomassreactor.powerRange, BUILDINGS.combustor.powerRange);

  const dry = stub([biomassreactor()], { biomass: 100 });   // a full treasury still doesn't power it
  updateCombustors(dry, 0.1);
  assert.equal(powerCap(dry, "player"), 0, "empty larder → dead, regardless of the treasury");

  const s = stub([biomassreactor({ input: { biomass: 40 } })], {});
  updateCombustors(s, 0.1);
  const gen = [...s.buildings.values()][0];
  assert.equal(powerCap(s, "player"), BUILDINGS.biomassreactor.energyGrants, "fuelled from its own larder → grants its Power");
  assert.equal(gen.fuel, "biomass");
  assert.ok(gen.input.biomass < 40, "…having burned biomass from its larder");
});

test("a Generator's grid is SMALLER than a Reactor's (its powerRange shrinks the tiers)", () => {
  // 250px out: on a Reactor's grid that's the 'near' tier; on a Generator's tighter grid it's already 'isolated'.
  const nearReactor = stub([reactor({ x: 0, y: 0, powered: true })]);   // pre-mark fuelled so it counts as a source
  const nearGen = stub([combustor({ x: 0, y: 0, powered: true })]);     // …same for the Generator
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
    gen.input = { gas: 100 };
    s.buildings.set(gen.id, gen);
    for (let i = 0; i < 50; i++) tick(s, 0.1);
    return gen.input.gas;
  };
  assert.equal(run(), run(), "same seed → identical fuel burn");

  // `powered`/`fuel` are transient — they must not ride along in a save. `input` (the real fuel
  // larder, same field a factory's input is) is NOT transient — it must survive the round-trip.
  const s = createGameState({ planetId: "ferros", endless: true });
  const gen = makeBuilding("combustor", "player", 600, 500);
  gen.input = { gas: 100 };
  s.buildings.set(gen.id, gen);
  tick(s, 0.1);
  const saved = serializeGame(s).buildings.find(b => b.type === "combustor");
  assert.equal(saved.powered, undefined, "the transient power flag is stripped from the save");
  assert.equal(saved.fuel, undefined, "…and so is the transient fuel tag");
  assert.ok(saved.input.gas > 0, "…but the real fuel larder survives");
  assert.ok(deserializeGame(serializeGame(s)), "and the save round-trips");
});

// ---- the Reactor: the original power station, now burning radioactives too --------------------
// The Reactor is no longer free once built — it burns radioactives from its own larder, same
// mechanism as its smaller combust siblings above, just at double their rate (0.12/s vs 0.06/s),
// matching its double energyGrants/reach. `paused` (the HUD's Pause/Resume toggle, same idiom as a
// factory/Plasma Rig/Generator) takes it off the grid by hand without demolishing it — same as before.

test("a Reactor grants Power once fed — burns radioactives from its own larder, not free anymore", () => {
  const untouched = stub([reactor()], { radioactives: 100 });   // a full treasury, but an empty larder
  updateCombustors(untouched, 0.1);
  assert.equal(powerCap(untouched, "player"), 0, "no larder fuel → dead, regardless of the treasury");

  const s = stub([reactor({ input: { radioactives: 100 } })], {});
  updateCombustors(s, 0.1);
  assert.equal(powerCap(s, "player"), BUILDINGS.reactor.energyGrants, "fuelled from its own larder → grants its Power");
  const r = [...s.buildings.values()][0];
  assert.ok(r.powered && r.input.radioactives < 100, "…having burned some radioactives to do it");
});

test("a Reactor grants Power until it's paused, then grants none — and resumes cleanly", () => {
  const s = stub([reactor({ input: { radioactives: 100 } })], {});
  updateCombustors(s, 0.1);
  assert.equal(powerCap(s, "player"), BUILDINGS.reactor.energyGrants, "an unpaused, fuelled Reactor grants its Power");

  const r = [...s.buildings.values()][0];
  r.paused = true;
  updateCombustors(s, 0.1);
  assert.equal(powerCap(s, "player"), 0, "paused → off the grid, same as a dry Generator");

  r.paused = false;
  updateCombustors(s, 0.1);
  assert.equal(powerCap(s, "player"), BUILDINGS.reactor.energyGrants, "resumed → back on the grid, still fuelled");
});

test("a paused Reactor isn't a grid source at all (no false on-grid reading, matching a dead Generator)", () => {
  const s = stub([reactor({ x: 0, y: 0, paused: true, input: { radioactives: 100 } })]);
  assert.equal(powerEfficiency(s, "player", 30, 0).name, "linked",
    "with no ACTIVE source, a spot reads the neutral tier — not 'on-grid' off a paused Reactor, even a fuelled one");
  assert.equal(onPowerGrid(s, "player", 30, 0), false);
});

test("pausing one of two Reactors leaves the other's Power on the grid", () => {
  const s = stub([reactor({ id: "r1", powered: true }), reactor({ id: "r2", paused: true })]);
  assert.equal(powerCap(s, "player"), BUILDINGS.reactor.energyGrants, "only the un-paused, fuelled one counts");
});

test("a Reactor's pause is a real, persisted decision — it survives a save/load round-trip", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const r = makeBuilding("reactor", "player", 600, 500);
  r.paused = true;
  r.input = { radioactives: 100 };
  s.buildings.set(r.id, r);

  const b = deserializeGame(serializeGame(s));
  const loaded = [...b.buildings.values()].find(x => x.type === "reactor");
  assert.equal(loaded.paused, true, "unlike `powered`/`fuel`, a Reactor's pause isn't transient — it's a player choice");
  assert.equal(powerCap(b, "player"), 0, "…and the loaded game still honours it — paused overrides even a full larder");
});

test("the Reactor burns radioactives at double the Combustion Generator's rate, matching its double Power", () => {
  assert.deepEqual(BUILDINGS.reactor.combust.fuels, ["radioactives"]);
  assert.equal(BUILDINGS.reactor.combust.rate, BUILDINGS.combustor.combust.rate * 2);
  assert.equal(BUILDINGS.reactor.energyGrants, BUILDINGS.combustor.energyGrants * 2);
  assert.ok(BUILDINGS.reactor.powerRange > BUILDINGS.combustor.powerRange, "and it still reaches further");
});
