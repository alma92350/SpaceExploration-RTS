import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiplomacy, updateDiplomacy, atPeace, hostility, stanceLabel, PEACE_THRESHOLD,
         offerTribute, tributeCost, TRIBUTE_BASE_COST, APPEASE_TIME } from "../engine/diplomacy.js";
import { createGalaxy, activeState, addPlanet, jumpCapital, sweepColonies } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
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

test("the neighbour announces its turn to war exactly once", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  s.time = 1000;                 // past grace — war can actually start
  drainNodes(s, 0.05);           // mined out → the stance will cross into war
  s.events.length = 0;
  for (let i = 0; i < 4000; i++) updateDiplomacy(s, 0.1);
  const alerts = s.events.filter(e => e.type === "neighbourHostile" && e.owner === "player");
  assert.equal(alerts.length, 1, "the peace→war crossing fires the alert once");
  assert.equal(s.diplomacy.warAnnounced, true, "and the world is marked announced");
  assert.equal(atPeace(s), false, "the neighbour is indeed at war");
});

test("a world that stays peaceful never fires the war alert", () => {
  const rich = createGameState({ planetId: "ferros", seed: 3, endless: true });
  rich.diplomacy = createDiplomacy();   // deposits untouched → stays cordial
  rich.events.length = 0;
  for (let i = 0; i < 4000; i++) updateDiplomacy(rich, 0.1);
  assert.ok(!rich.events.some(e => e.type === "neighbourHostile"), "peace stays quiet");
});

// ---- Tier 4: the Gate finale provokes war ----

test("a charging Gate provokes war even on a rich, untouched world — harder as it nears firing", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  s.time = 500;                                        // past grace, so the finale clause is live
  const gate = makeBuilding("antimatter_gate", "player", 600, 500);
  gate.charge = 0.6;
  s.buildings.set(gate.id, gate);                      // nodes untouched → scarcity alone would keep the peace
  for (let i = 0; i < 2000; i++) updateDiplomacy(s, 0.1);
  assert.equal(atPeace(s), false, "the Gate dragged a rich world into war");
  const hMid = hostility(s);

  const s2 = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s2.diplomacy = createDiplomacy();
  s2.time = 500;
  const gate2 = makeBuilding("antimatter_gate", "player", 600, 500);
  gate2.charge = 0.95;
  s2.buildings.set(gate2.id, gate2);
  for (let i = 0; i < 2000; i++) updateDiplomacy(s2, 0.1);
  assert.ok(hostility(s2) > hMid, "a near-complete Gate is angrier than a half-charged one");
});

test("the Gate finale is unappeasable — a tribute can't buy out of the endgame", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  s.time = 500;
  const gate = makeBuilding("antimatter_gate", "player", 600, 500);
  gate.charge = 0.8;
  s.buildings.set(gate.id, gate);
  offerTribute({ credits: 9999 }, s);                  // pay to appease…
  for (let i = 0; i < 600; i++) updateDiplomacy(s, 0.1);   // ~60s, well inside APPEASE_TIME
  assert.equal(atPeace(s), false, "the finale clause overrides the paid truce");
});

// ---- Tier 4: tribute (diplomacy agency) ----

test("tribute snaps the neighbour to a truce and spends galaxy credits", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.diplomacy.stance = -0.4;                           // hostile
  g.credits = 1000;
  assert.equal(offerTribute(g, s), true);
  assert.equal(g.credits, 1000 - TRIBUTE_BASE_COST, "the first tribute costs the base price");
  assert.equal(atPeace(s), true, "the neighbour stands down at once");
  assert.ok(s.diplomacy.appeaseUntil > s.time, "a decaying truce window opens");
  assert.ok(tributeCost(s.diplomacy) > TRIBUTE_BASE_COST, "the next tribute costs more");
});

test("you can't tribute without the credits", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  g.credits = 10;                                      // below the base cost
  assert.equal(offerTribute(g, s), false, "no funds ⇒ no-op");
  assert.equal(g.credits, 10, "and nothing is spent");
});

test("a paid truce holds the peace inside its window, then decays back to war", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  s.time = 1000; drainNodes(s, 0.05);                  // past grace, mined out → deeply hostile target
  offerTribute({ credits: 5000 }, s);                  // galaxy stand-in — offerTribute only reads .credits
  assert.equal(atPeace(s), true, "the tribute buys instant peace");
  for (let i = 0; i < 500; i++) { updateDiplomacy(s, 0.1); s.time += 0.1; }    // ~50s < APPEASE_TIME(120)
  assert.equal(atPeace(s), true, "peace holds inside the window");
  for (let i = 0; i < 1200; i++) { updateDiplomacy(s, 0.1); s.time += 0.1; }   // +120s, past the window
  assert.equal(atPeace(s), false, "the truce decays — bought peace is temporary, never permanent");
});

test("tribute state (tributes, appeaseUntil) round-trips a galaxy save/load", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  g.credits = 1000;
  offerTribute(g, s);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rd = activeState(restored).diplomacy;
  assert.equal(rd.tributes, 1, "the tribute count survives the round-trip");
  assert.ok(Math.abs(rd.appeaseUntil - s.diplomacy.appeaseUntil) < 1e-9, "the truce deadline survives too");
});

// ---- Tier 4: late-game creep (no hostility plateau) ----

test("late-game creep turns a rich-ish world hostile over a long game, without annihilation", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  drainNodes(s, 0.7);                                  // only ~30% mined — still productive
  s.time = 421;                                        // just past grace
  updateDiplomacy(s, 0.1);
  assert.equal(atPeace(s), true, "no cliff right after grace");
  for (let i = 0; i < 14000; i++) { updateDiplomacy(s, 0.1); s.time += 0.1; }   // advance to ~30 min
  assert.equal(atPeace(s), false, "given a long game, even a rich-ish world turns — no plateau");
  const h = hostility(s);
  assert.ok(h > 0.15 && h < 0.7, `a rising, survivable threat, not instant annihilation (h=${h.toFixed(2)})`);
});

test("addPlanet gives every world a neighbour stance", () => {
  const g = createGalaxy({ seed: 8 });
  const other = g.worlds.find(w => w !== g.activeId);
  const s = addPlanet(g, other);
  assert.ok(s.diplomacy && typeof s.diplomacy.stance === "number", "the world has a diplomacy stance");
});
