import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiplomacy, updateDiplomacy, atPeace, stanceLabel, PEACE_THRESHOLD } from "../engine/diplomacy.js";
import { createGalaxy, activeState, addPlanet, jumpCapital, sweepColonies } from "../engine/galaxy.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";

const THINK = 1.5;   // matches ai.js THINK_INTERVAL — forces a fresh think each call

function drainNodes(state, frac) {   // leave `frac` of every deposit — frac 0.1 = nearly mined out
  for (const n of state.map.nodes) n.amount = n.max * frac;
}

test("a new neighbour starts cordial and at peace", () => {
  const dip = createDiplomacy();
  assert.ok(dip.stance > PEACE_THRESHOLD, "starts above the peace line");
  assert.ok(["Cordial", "Neutral", "Allied"].includes(stanceLabel(dip.stance)));
});

test("scarcity turns the neighbour hostile; abundance keeps the peace", () => {
  const scarce = createGameState({ planetId: "ferros", seed: 3, endless: true });
  scarce.diplomacy = createDiplomacy();
  drainNodes(scarce, 0.05);                         // world almost mined out
  for (let i = 0; i < 4000; i++) updateDiplomacy(scarce, 0.1);
  assert.equal(atPeace(scarce), false, "a mined-out world's neighbour turns on you");
  assert.equal(stanceLabel(scarce.diplomacy.stance), "Hostile");

  const rich = createGameState({ planetId: "ferros", seed: 3, endless: true });
  rich.diplomacy = createDiplomacy();               // deposits untouched
  for (let i = 0; i < 4000; i++) updateDiplomacy(rich, 0.1);
  assert.equal(atPeace(rich), true, "a rich world stays peaceful");
});

test("stanceLabel bands run hostile → allied", () => {
  assert.equal(stanceLabel(-0.8), "Hostile");
  assert.equal(stanceLabel(-0.3), "Wary");
  assert.equal(stanceLabel(0.1), "Neutral");
  assert.equal(stanceLabel(0.4), "Cordial");
  assert.equal(stanceLabel(0.8), "Allied");
});

test("a neighbour at peace launches no offensive wave; one turned hostile does", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = state.aiArchetype.attackTimeout + 1;     // past the desperation timeout
  const unit = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(unit.id, unit);

  state.diplomacy = { stance: 0.4, depletion: 0 };       // at peace
  runAI(state, THINK);
  assert.notEqual(unit.order?.type, "attack-move", "a peaceful neighbour holds its army home");

  state.diplomacy.stance = -0.6;                          // turned hostile
  runAI(state, THINK);
  assert.equal(unit.order?.type, "attack-move", "a hostile neighbour commits the wave");
});

test("the AI still attacks when there is no diplomacy (a plain skirmish)", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = state.aiArchetype.attackTimeout + 1;
  const unit = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(unit.id, unit);
  runAI(state, THINK);
  assert.equal(unit.order?.type, "attack-move", "no diplomacy ⇒ the gate is a no-op, AI attacks as before");
});

test("sweepColonies reports a colony under attack, then lost, and drains its events", () => {
  const g = createGalaxy({ seed: 5 });
  const from = activeState(g);
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  from.buildings.set(...(() => { const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y); return [sp.id, sp]; })());
  g.credits = 1000;
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);                        // `from` is now a background colony (keeps its Spaceport)

  from.events.push({ type: "entityKilled", x: 0, y: 0, owner: "player" });   // a raid on the colony
  let notes = sweepColonies(g);
  assert.ok(notes.some(n => n.type === "attacked" && n.planetId === from.planetId), "reports the attack");
  assert.equal(from.events.length, 0, "the colony's events are drained");

  for (const b of [...from.buildings.values()]) if (b.owner === "player") from.buildings.delete(b.id);   // razed
  notes = sweepColonies(g);
  assert.ok(notes.some(n => n.type === "lost" && n.planetId === from.planetId), "reports the loss");
  notes = sweepColonies(g);
  assert.ok(!notes.some(n => n.type === "lost"), "the loss is reported only once");
});

test("addPlanet gives every world a neighbour stance", () => {
  const g = createGalaxy({ seed: 8 });
  const other = g.worlds.find(w => w !== g.activeId);
  const s = addPlanet(g, other);
  assert.ok(s.diplomacy && typeof s.diplomacy.stance === "number", "the world has a diplomacy stance");
});
