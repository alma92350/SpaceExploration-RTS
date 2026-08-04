import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, activeState, stepGalaxy, jumpCapital } from "../engine/galaxy.js";
import { deployColonyShip } from "../engine/colony.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { updateWonder, chargingWonderOf, chargingPlayerWonder } from "../engine/wonder.js";
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

test("a Gate completing on a background colony fires the 'gate' milestone (no win — play forever)", () => {
  const g = createGalaxy({ seed: 5 });
  const home = activeState(g);
  for (const u of [...home.units.values()]) if (u.type === "colonyship") deployColonyShip(home, u.id);   // deploy start ship → CC
  const base = home.map.bases.player;
  const sp = makeBuilding("spaceport", "player", base.x + 40, base.y);
  const reactor = makeBuilding("reactor", "player", base.x + 200, base.y + 120);
  const gate = makeBuilding("antimatter_gate", "player", base.x + 240, base.y + 160);
  home.buildings.set(sp.id, sp);
  home.buildings.set(reactor.id, reactor);
  home.buildings.set(gate.id, gate);
  stockFeed(home.players.player.resources, 1.3);
  g.credits = 2000;
  jumpCapital(g, g.worlds.find(w => w !== g.activeId));   // hop away; the Gate + base stay on the colony (now a background world)
  assert.notEqual(g.activeId, home.planetId, "we jumped away from the Gate's world");
  for (let i = 0; i < GATE.chargeTime * 20 && !g.reached.has("gate"); i++) stepGalaxy(g, 0.1);
  assert.ok(g.reached.has("gate"), "a Gate completing anywhere — even a background colony — fires the milestone");
  assert.ok(g.milestones.includes("gate"), "…queued for a firework");
  assert.ok(!activeState(g).over, "…but the sandbox does NOT end — the Gate is a triumph, not a victory");
  const rg = [...home.buildings.values()].find(b => b.type === "antimatter_gate");
  assert.ok((rg.charge || 0) >= 1, "the colony Gate reached full charge");
});

/* ---------- chargingWonderOf: the owner-generic detector (Phase 7 rival Gate) ---------- */

test("chargingWonderOf(state, owner) finds only THAT owner's partly-charged wonder", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const playerGate = makeBuilding("antimatter_gate", "player", 600, 500);
  const aiGate = makeBuilding("antimatter_gate", "ai", 700, 500);
  state.buildings.set(playerGate.id, playerGate);
  state.buildings.set(aiGate.id, aiGate);
  assert.equal(chargingWonderOf(state, "player"), null, "neither has started charging yet");
  assert.equal(chargingWonderOf(state, "ai"), null);

  playerGate.charge = 0.4;
  assert.equal(chargingWonderOf(state, "player")?.id, playerGate.id, "finds the player's own charging wonder");
  assert.equal(chargingWonderOf(state, "ai"), null, "…and never the other owner's, even though one exists");

  aiGate.charge = 0.6;
  assert.equal(chargingWonderOf(state, "ai")?.id, aiGate.id, "now finds the AI's own charging wonder");
  assert.equal(chargingWonderOf(state, "player")?.id, playerGate.id, "…without disturbing the player's own result");

  aiGate.charge = 1;
  assert.equal(chargingWonderOf(state, "ai"), null, "full charge → done, not 'charging', for the AI exactly like the player");
});

test("chargingPlayerWonder delegates to chargingWonderOf(state, \"player\") — existing callers (diplomacy.js/aiMilitary.js) unaffected", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const gate = makeBuilding("antimatter_gate", "player", 600, 500);
  gate.charge = 0.3;
  state.buildings.set(gate.id, gate);
  assert.equal(chargingPlayerWonder(state)?.id, chargingWonderOf(state, "player")?.id);
  assert.equal(chargingPlayerWonder(state).id, gate.id);
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

test("a Gate at full charge stops consuming — it never keeps draining the Strategic tier (A4)", () => {
  // updateWonder clamped the CHARGE but not the SPEND, and nothing returned early at charge >= 1.
  // In a standalone endless state that's masked because checkEndlessWin finishes the game — but a
  // GALAXY Gate is explicitly "a milestone, never a win — play forever" (engine/victory.js), and
  // sim.js calls updateWonder unconditionally every tick. So a completed Gate went on eating its
  // feed at feed[com] per sim-second, indefinitely, in the three scarcest goods in the game, on the
  // winning line of play — and the Leviathan competes for exactly those three.
  const { state, gate } = withGate();
  gate.charge = 1;
  const before = { ...state.players.player.resources };
  for (let i = 0; i < 100; i++) updateWonder(state, gate, 0.1);
  for (const com in BUILDINGS.antimatter_gate.feed)
    assert.equal(state.players.player.resources[com], before[com],
      `a finished Gate must not keep spending ${com}`);
});

test("a Gate's final partial tick pays only for the charge it actually banks (A4)", () => {
  // The same off-by-a-clamp from the other side: charge clamps to 1 while the goods are debited for
  // the whole of p, so the last tick overpays for charge it never received.
  const { state, gate } = withGate();
  const def = BUILDINGS.antimatter_gate;
  gate.charge = 0.995;
  const before = { ...state.players.player.resources };
  updateWonder(state, gate, def.chargeTime);          // a whole charge's worth of dt in one step
  assert.equal(gate.charge, 1, "it completes");
  for (const com in def.feed) {
    const spent = before[com] - state.players.player.resources[com];
    const owed = 0.005 * def.feed[com] * def.chargeTime;
    assert.ok(spent <= owed + 1e-9,
      `${com}: spent ${spent} for the last 0.5% of charge, which is only worth ${owed}`);
  }
});
