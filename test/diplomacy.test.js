import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiplomacy, updateDiplomacy, atPeace, hostility, stanceLabel, PEACE_THRESHOLD } from "../engine/diplomacy.js";
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
  scarce.time = 1000;                               // past the opening grace window (war can't start during grace)
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

// Seat a home army of `n` idle skiffs at the AI base, on a `ferros` world with a
// given neighbour stance, so we can watch the offense ramp.
function armyWorld(stance, n = 12) {
  const s = createGameState({ planetId: "ferros" });
  const army = [];
  for (let i = 0; i < n; i++) {
    const u = makeUnit("skiff", "ai", s.map.bases.ai.x, s.map.bases.ai.y);
    s.units.set(u.id, u); army.push(u);
  }
  s.diplomacy = { stance, depletion: 0 };
  return { s, army };
}
const attacking = army => army.filter(u => u.order?.type === "attack-move").length;

test("hostility() maps stance to 0..1 (and is full without diplomacy)", () => {
  assert.equal(hostility({}), 1, "no diplomacy ⇒ full intensity (a skirmish)");
  assert.equal(hostility({ diplomacy: { stance: 0.4 } }), 0, "at peace ⇒ 0");
  assert.equal(hostility({ diplomacy: { stance: PEACE_THRESHOLD } }), 0, "exactly the peace line ⇒ 0");
  assert.equal(hostility({ diplomacy: { stance: -1 } }), 1, "fully hostile ⇒ 1");
  const mid = hostility({ diplomacy: { stance: -0.5 } });
  assert.ok(mid > 0.35 && mid < 0.5, `mid stance ⇒ ~0.41 (got ${mid.toFixed(3)})`);
});

test("a neighbour at peace launches no offensive wave", () => {
  const { s, army } = armyWorld(0.4);   // cordial
  runAI(s, THINK);
  assert.equal(attacking(army), 0, "a peaceful neighbour holds its whole army home");
});

test("a barely-wary neighbour sends a small probe, not its banked army", () => {
  const { s, army } = armyWorld(-0.2);   // just past the peace line, h≈0.06
  runAI(s, THINK);
  const n = attacking(army);
  assert.ok(n >= 1 && n <= 4, `a probe, not a doomstack (got ${n})`);
  assert.ok(n < army.length, "most of the banked army stays home");
});

test("a deeply-hostile neighbour commits a large fraction of its army", () => {
  const { s, army } = armyWorld(-0.95);   // h≈0.94
  runAI(s, THINK);
  assert.ok(attacking(army) >= 6, "near-full commitment when deeply hostile");
});

test("odyssey probes are spaced by a cadence, not launched every tick", () => {
  const { s, army } = armyWorld(-0.2);
  s.time = 0;
  runAI(s, THINK);
  const first = attacking(army);
  assert.ok(first >= 1, "the first probe launches");
  assert.ok(s.aiNextWaveAt > 0, "the next wave is scheduled ahead");
  runAI(s, THINK);   // same tick — the reserve must wait
  assert.equal(attacking(army), first, "no second probe before the cadence elapses");
  s.time = s.aiNextWaveAt + 1;
  runAI(s, THINK);
  assert.ok(attacking(army) > first, "a fresh probe launches once the cadence elapses");
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

test("destroying the neighbour's ships sours the stance at once", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  updateDiplomacy(s, 0.1);                    // establish the baseline unit count
  const before = s.diplomacy.stance;
  const ai = [...s.units.values()].filter(u => u.owner === "ai");
  let removed = 0;
  for (const u of ai) { if (removed >= 5) break; s.units.delete(u.id); removed++; }
  updateDiplomacy(s, 0.1);
  assert.ok(removed > 0);
  assert.ok(s.diplomacy.stance < before, "each ship you destroy drops the stance");
});

test("a held colony sends home passive income each tick", () => {
  const g = createGalaxy({ seed: 9 });
  const from = activeState(g);
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  from.buildings.set(sp.id, sp);
  g.credits = 1000;
  const dest = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, dest);                       // `from` is now a colony with buildings
  const before = g.credits;
  sweepColonies(g, 10);                        // 10 seconds of passive income
  assert.ok(g.credits > before, "the colony banks income while you're away");
  // and a razed colony stops paying
  for (const b of [...from.buildings.values()]) if (b.owner === "player") from.buildings.delete(b.id);
  const afterRazed = g.credits;
  sweepColonies(g, 10);
  assert.equal(g.credits, afterRazed, "a colony with no buildings pays nothing");
});

test("addPlanet gives every world a neighbour stance", () => {
  const g = createGalaxy({ seed: 8 });
  const other = g.worlds.find(w => w !== g.activeId);
  const s = addPlanet(g, other);
  assert.ok(s.diplomacy && typeof s.diplomacy.stance === "number", "the world has a diplomacy stance");
});
