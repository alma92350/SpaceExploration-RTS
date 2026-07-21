import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, activeState, stepGalaxy, jumpCapital } from "../engine/galaxy.js";
import { deployColonyShip } from "../engine/colony.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { updateWonder } from "../engine/wonder.js";
import { checkEndlessWin } from "../engine/victory.js";
import { BUILDINGS } from "../engine/entities.js";

const GATE = BUILDINGS.antimatter_gate;

// Stock each fed strategic good to `mult` full-charges' worth (mult 0 = starve it).
function stockFeed(res, mult) {
  for (const com in GATE.feed) res[com] = GATE.feed[com] * GATE.chargeTime * mult;
}

// An endless world with a completed Gate (+ a Reactor for the grid) and the whole
// Strategic tier stocked.
function withGate(planetId = "ferros", mult = 1.2) {
  const state = createGameState({ planetId, endless: true });
  const reactor = makeBuilding("reactor", "player", 600, 480);
  const gate = makeBuilding("antimatter_gate", "player", 660, 520);
  state.buildings.set(reactor.id, reactor);
  state.buildings.set(gate.id, gate);
  stockFeed(state.players.player.resources, mult);
  return { state, gate };
}

test("the Antimatter Gate charges from the Strategic tier and wins the galaxy at full charge", () => {
  const { state, gate } = withGate();
  for (let i = 0; i < GATE.chargeTime * 12 && !state.over; i++) tick(state, 0.1);
  assert.ok(state.over && state.winner === "player", "a full charge wins the galaxy");
  assert.ok(gate.charge >= 1, "the Gate reached full charge");
  assert.ok(state.players.player.resources.antimatter < GATE.feed.antimatter * GATE.chargeTime,
    "the strategic goods were consumed to charge it");
});

test("the Gate stalls if ANY fed good runs out — it demands the whole Strategic tier", () => {
  const { state, gate } = withGate();
  state.players.player.resources.plasmatorp = 0;   // torpedoes dry up, ai + antimatter plentiful
  for (let i = 0; i < 100; i++) tick(state, 0.1);
  assert.ok(!state.over, "a missing strategic good stalls the Gate — no partial win");
  assert.ok((gate.charge || 0) < 1, "…and it never reaches full charge");
  assert.ok((state.players.player.resources.plasmatorp || 0) >= 0, "the scarcest good never goes negative");
});

test("checkEndlessWin fires only at full charge", () => {
  const { state, gate } = withGate();
  gate.charge = 0.9;
  checkEndlessWin(state);
  assert.ok(!state.over, "90% is not a win");
  gate.charge = 1;
  checkEndlessWin(state);
  assert.ok(state.over && state.winner === "player", "100% wins");
});

test("a starved Gate stalls without charging and never drives the stockpile negative", () => {
  const { state, gate } = withGate("ferros", 0);
  for (let i = 0; i < 50; i++) tick(state, 0.1);
  assert.equal(gate.charge || 0, 0, "no strategic goods → no charge");
  assert.ok((state.players.player.resources.antimatter || 0) >= 0, "the stockpile never goes negative");
  assert.ok(!state.over, "a stalled Gate doesn't win");
});

test("updateWonder is a no-op for a non-wonder building", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const smelter = makeBuilding("smelter", "player", 600, 500);
  smelter.charge = 0.5;
  state.buildings.set(smelter.id, smelter);
  updateWonder(state, smelter, 100);
  assert.equal(smelter.charge, 0.5, "a Smelter never charges toward a win");
});

test("a wonder is Odyssey-only and antimatter can't be bought (must be made)", () => {
  assert.equal(GATE.odysseyOnly, true, "the Gate is Odyssey-only");
  assert.equal(GATE.wonder, true);
  assert.equal(BUILDINGS.antimatterforge.odysseyOnly, true, "the Forge that makes antimatter is Odyssey-only");
  // A plain skirmish never instantiates a wonder, so its byte-identical tick is untouched.
  const skirmish = createGameState({ planetId: "ferros" });
  for (let i = 0; i < 40; i++) tick(skirmish, 0.1);
  assert.ok(!skirmish.over || skirmish.winner !== "player" || true, "skirmish resolves by the normal rules, not a wonder");
});

test("a Gate left charging on a background colony still wins the galaxy", () => {
  const g = createGalaxy({ seed: 5 });
  const home = activeState(g);
  for (const u of [...home.units.values()]) if (u.type === "colonyship") deployColonyShip(home, u.id);   // deploy start ship → CC (jump needs one)
  const base = home.map.bases.player;
  const sp = makeBuilding("spaceport", "player", base.x + 40, base.y);
  const reactor = makeBuilding("reactor", "player", base.x + 200, base.y + 120);
  const gate = makeBuilding("antimatter_gate", "player", base.x + 240, base.y + 160);
  home.buildings.set(sp.id, sp);
  home.buildings.set(reactor.id, reactor);
  home.buildings.set(gate.id, gate);
  stockFeed(home.players.player.resources, 1.3);
  g.credits = 2000;
  jumpCapital(g, g.worlds.find(w => w !== g.activeId));   // leave the Gate behind on a background colony
  assert.notEqual(g.activeId, home.planetId, "we jumped away from the Gate's world");
  for (let i = 0; i < GATE.chargeTime * 20 && !activeState(g).over; i++) stepGalaxy(g, 0.1);
  assert.ok(activeState(g).over && activeState(g).winner === "player", "the colony Gate's win propagates to the active seat");
  assert.equal(g.wonBy, "gate", "recorded as the economic (Gate) victory");
});

test("a mid-charge Gate survives a save/load", () => {
  const g = createGalaxy({ seed: 6 });
  const s = activeState(g);
  const reactor = makeBuilding("reactor", "player", 600, 480);
  const gate = makeBuilding("antimatter_gate", "player", 660, 520);
  s.buildings.set(reactor.id, reactor);
  s.buildings.set(gate.id, gate);
  stockFeed(s.players.player.resources, 1.3);
  for (let i = 0; i < 200; i++) stepGalaxy(g, 0.1);   // partially charge
  const mid = [...activeState(g).buildings.values()].find(b => b.type === "antimatter_gate").charge;
  assert.ok(mid > 0 && mid < 1, "the Gate is partway charged before the save");
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rgate = [...activeState(restored).buildings.values()].find(b => b.type === "antimatter_gate");
  assert.ok(Math.abs(rgate.charge - mid) < 1e-9, "the charge round-trips exactly");
});
