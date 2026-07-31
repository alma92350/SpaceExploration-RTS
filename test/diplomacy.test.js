import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiplomacy, updateDiplomacy, atPeace, hostility, stanceLabel, PEACE_THRESHOLD,
         offerTribute, tributeCost, TRIBUTE_BASE_COST, APPEASE_TIME } from "../engine/diplomacy.js";
import { createGalaxy, activeState, addPlanet, jumpCapital, sweepColonies } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";
import { runAI } from "../engine/ai.js";
import { GRACE_TIME, MIN_GRACE_FRAC, MAX_GRIEVANCE_MULT, effectiveDiplomacyMults } from "../engine/diplomacy.js";
import { offerGift, fulfillRequest, GOODWILL_CAP, FAVOR_INTERVAL } from "../engine/diplomacy.js";
import { createMarket } from "../engine/market.js";
import { COM } from "../data.js";

// Deploy the Odyssey start colony ships so a world has bases (the pre-colony-ship layout).
function settle(state) {
  for (const u of [...state.units.values()]) if (u.type === "colonyship") deployColonyShip(state, u.id);
  return state;
}

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
  assert.ok(s.ai.nextWaveAt > 0, "the next wave is scheduled ahead");
  runAI(s, THINK);   // same tick — the reserve must wait
  assert.equal(attacking(army), first, "no second probe before the cadence elapses");
  s.time = s.ai.nextWaveAt + 1;
  runAI(s, THINK);
  assert.ok(attacking(army) > first, "a fresh probe launches once the cadence elapses");
});

// ---- P1 review gap: the exact hostility-cadence formula (engine/aiMilitary.js) ----
//
// nextWaveAt = state.time + effAttackTimeout * WAVE_CADENCE_FRAC * (1 - 0.5 * hostility(state)) —
// the cadence ITSELF tightens with hostility (sparse when merely wary, tight when hostile), not
// just the muster/committed-fraction the tests around this one already cover. The cadence test
// just above only ever exercises a single stance (-0.2), so the tightening was never actually
// forced to differ between two readings. Pin the real formula (WAVE_CADENCE_FRAC mirrors
// aiMilitary.js's own unexported 0.3 constant, confirmed by reading the source) against two
// otherwise-identical armies that differ only in how hostile the neighbour is.
const WAVE_CADENCE_FRAC = 0.3;

function waveWorld(stance, time) {
  const s = createGameState({ planetId: "korrath" });   // Rusher: garrison 0, so nothing held back complicates the muster math
  s.ai.archetype = { ...s.ai.archetype, armyAttackSize: 10, attackTimeout: 100, garrison: 0, odyssey: undefined };
  s.diplomacy = { stance, depletion: 0 };
  s.time = time;
  const army = [];
  for (let i = 0; i < 14; i++) {
    const u = makeUnit("skiff", "ai", s.map.bases.ai.x, s.map.bases.ai.y);
    s.units.set(u.id, u); army.push(u);
  }
  return { s, army };
}

test("the Odyssey wave cadence tightens with hostility: nextWaveAt lands sooner the more hostile the neighbour, per the exact formula", () => {
  const TIME = 500;
  const { s: less, army: armyLess } = waveWorld(-0.5, TIME);   // h ≈ 0.412 — the same mid stance as the hostility() test above
  const { s: more, army: armyMore } = waveWorld(-1, TIME);     // h = 1 — fully hostile

  runAI(less, THINK);
  runAI(more, THINK);
  assert.ok(attacking(armyLess) > 0 && attacking(armyMore) > 0, "sanity: both neighbours actually commit a wave this think cycle");

  const hLess = hostility(less), hMore = hostility(more);
  assert.ok(hLess > 0 && hLess < 1 && hMore === 1, "sanity: a genuine partial reading vs. fully hostile");
  const effAttackTimeout = 100;   // this fixture's attackTimeout; strategy "default" multiplier is 1 (a no-op)
  const expectedLess = TIME + effAttackTimeout * WAVE_CADENCE_FRAC * (1 - 0.5 * hLess);
  const expectedMore = TIME + effAttackTimeout * WAVE_CADENCE_FRAC * (1 - 0.5 * hMore);

  assert.ok(Math.abs(less.ai.nextWaveAt - expectedLess) < 1e-9,
    `nextWaveAt matches the exact cadence formula at the less-hostile stance (got ${less.ai.nextWaveAt}, expected ${expectedLess})`);
  assert.ok(Math.abs(more.ai.nextWaveAt - expectedMore) < 1e-9,
    `nextWaveAt matches the exact cadence formula at the fully-hostile stance (got ${more.ai.nextWaveAt}, expected ${expectedMore})`);
  assert.ok(more.ai.nextWaveAt < less.ai.nextWaveAt,
    "the fully-hostile neighbour's next wave is scheduled SOONER than the merely-wary one's");
});

test("the AI still attacks when there is no diplomacy (a plain skirmish)", () => {
  const state = createGameState({ planetId: "ferros" });
  state.time = state.ai.archetype.attackTimeout + 1;
  const unit = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.units.set(unit.id, unit);
  runAI(state, THINK);
  assert.equal(unit.order?.type, "attack-move", "no diplomacy ⇒ the gate is a no-op, AI attacks as before");
});

test("sweepColonies reports a colony under attack, then lost, and drains its events", () => {
  const g = createGalaxy({ seed: 5 });
  const from = settle(activeState(g));
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  from.buildings.set(...(() => { const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y); return [sp.id, sp]; })());
  from.units.set(...(() => { const sh = makeUnit("colonyship", "player", cc.x + 40, cc.y); return [sh.id, sh]; })());   // vessel on the pad
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
  // Real ships, not the seeded colony ship: that one is SPENT founding a base rather than killed,
  // so it's excluded from the count the grievance reads (CONSUMED_ROLES — see the deploy test below).
  for (let i = 0; i < 5; i++) { const u = makeUnit("skiff", "ai", 500 + i * 10, 500); s.units.set(u.id, u); }
  updateDiplomacy(s, 0.1);                    // establish the baseline unit count
  const before = s.diplomacy.stance;
  const ai = [...s.units.values()].filter(u => u.owner === "ai" && u.type === "skiff");
  let removed = 0;
  for (const u of ai) { if (removed >= 5) break; s.units.delete(u.id); removed++; }
  updateDiplomacy(s, 0.1);
  assert.equal(removed, 5);
  assert.ok(s.diplomacy.stance < before, "each ship you destroy drops the stance");
});

test("a held colony sends home passive income each tick", () => {
  const g = createGalaxy({ seed: 9 });
  const from = settle(activeState(g));
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  from.buildings.set(sp.id, sp);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y); from.units.set(ship.id, ship);   // vessel on the pad
  g.credits = 1000;
  const dest = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, dest);                       // `from` keeps its base and is now a colony
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

/* ---------- provocation: what a never-initiating neighbour is allowed to answer ---------- */

// engine/aiMilitary.js reads this flag to decide whether a `neverInitiates` strategy may commit a
// wave in Odyssey (docs/odyssey-ai-review.md §2.1). It must latch on a real player action — the
// same unit-count delta the grievance already reads — and never on elapsed time, which is the bug
// neverInitiates was introduced to fix in the first place.

test("a fresh neighbour starts unprovoked", () => {
  const s = createGameState({ planetId: "ferros", rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  assert.equal(s.diplomacy.provokedAt, null, "createDiplomacy states the field, so the shape is complete for save/load");
  updateDiplomacy(s, 1);
  assert.ok(!provoked(s), "merely running the world doesn't provoke it");
});

test("destroying one of the neighbour's ships provokes it, and it stays provoked while the fight is live", () => {
  const s = createGameState({ planetId: "ferros", rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  const doomed = makeUnit("skiff", "ai", 500, 500);
  s.units.set(doomed.id, doomed);
  updateDiplomacy(s, 1);                       // seeds lastAiUnits
  assert.ok(!provoked(s), "still unprovoked while its ships are alive");
  s.units.delete(doomed.id);                   // the player killed it
  updateDiplomacy(s, 1);
  assert.ok(provoked(s), "a destroyed ship is provocation");
  assert.equal(s.diplomacy.provokedAt, s.time, "…stamped with when, so the memory can fade on its own clock");
  for (let i = 0; i < 50; i++) updateDiplomacy(s, 1);
  assert.ok(provoked(s), "…and it holds while the fight is still recent — see the cooldown tests below for the fade");
});

test("the neighbour REBUILDING its fleet is not provocation", () => {
  const s = createGameState({ planetId: "ferros", rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  updateDiplomacy(s, 1);
  for (let i = 0; i < 4; i++) { const u = makeUnit("skiff", "ai", 500, 500); s.units.set(u.id, u); }
  updateDiplomacy(s, 1);
  assert.ok(!provoked(s), "a rising unit count is the AI's own production, not an attack on it");
});

/* ---------- the three multiplier layers compose, but they don't compound without limit ---------- */

// graceMult and grievanceMult each get a factor from the archetype's Odyssey overlay, the
// player-picked strategy AND the difficulty, and they all MULTIPLY. On a reachable setup-screen
// combination (Aggressive + Hard on a Rusher world) that took the documented 7-minute opening
// grace — the window that exists so a player can establish before a world can turn — down to
// 0.5 x 0.2 x 0.9 = 0.09, i.e. 37.8 seconds, and pushed grievance to 3.68x. Neither number was
// designed; both are accidents of composition (docs/odyssey-ai-review.md §2.6). The layers still
// compose — that's the whole design — they just can't compound past a floor/ceiling.

test("the composed grace multiplier is floored, so the opening window can never collapse", () => {
  const s = createGameState({ planetId: "korrath", endless: true, aiStrategy: "aggressive",
                              difficulty: "hard", rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  const raw = 0.5 * 0.2 * 0.9;   // Rusher overlay x Aggressive x Hard
  assert.ok(raw < MIN_GRACE_FRAC, "fixture really is the worst-case stack");
  const { graceMult } = effectiveDiplomacyMults(s);
  assert.equal(graceMult, MIN_GRACE_FRAC, "the stack is floored rather than multiplied out");
  assert.ok(GRACE_TIME * graceMult >= 150,
    `an established-by-then window survives (got ${(GRACE_TIME * graceMult).toFixed(0)}s)`);
});

test("the composed grievance multiplier is capped", () => {
  const s = createGameState({ planetId: "korrath", endless: true, aiStrategy: "aggressive",
                              difficulty: "hard", rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  assert.ok(2 * 1.6 * 1.15 > MAX_GRIEVANCE_MULT, "fixture really is the worst-case stack");
  assert.equal(effectiveDiplomacyMults(s).grievanceMult, MAX_GRIEVANCE_MULT);
});

test("a stack that stays inside the bounds is passed through untouched — the layers still compose", () => {
  const s = createGameState({ planetId: "korrath", endless: true, rng: () => 0.5 });   // Rusher overlay alone
  s.diplomacy = createDiplomacy();
  const m = effectiveDiplomacyMults(s);
  assert.equal(m.graceMult, 0.5, "a Rusher world still turns hostile in half the grace window");
  assert.equal(m.grievanceMult, 2, "…and still sours twice as fast — clamping only bites at the extremes");
});

test("a clamped Aggressive+Hard Rusher is still markedly more hostile than a patient world", () => {
  // The point of the clamp is to bound an accident, not to flatten the difference the layers exist
  // to express — so the extreme stack must still lose grace and gain grievance against a default one.
  const worst = createGameState({ planetId: "korrath", endless: true, aiStrategy: "aggressive",
                                  difficulty: "hard", rng: () => 0.5 });
  const calm = createGameState({ planetId: "ferros", endless: true, rng: () => 0.5 });
  for (const s of [worst, calm]) s.diplomacy = createDiplomacy();
  const w = effectiveDiplomacyMults(worst), c = effectiveDiplomacyMults(calm);
  assert.ok(w.graceMult < c.graceMult, "still a much shorter fuse");
  assert.ok(w.grievanceMult > c.grievanceMult, "…and still far less forgiving");
});

// A colony ship and a Helium Bomb leave the world by being USED, not by dying — deployColonyShip
// consumes the ship into a Command Center, and a triggered bomb consumes itself. The grievance
// (and the provocation flag that now rides on it) reads a DROP in the neighbour's unit count, so
// counting those two made the AI's own successful expansion read as the player having destroyed
// something: it soured its own stance for founding a colony, and — once provocation latched on the
// same signal — handed itself standing to attack a player who had done nothing at all.

test("the neighbour deploying its own colony ship is neither a grievance nor a provocation", () => {
  const s = createGameState({ planetId: "ferros", endless: true, rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  const ship = [...s.units.values()].find(u => u.owner === "ai" && u.type === "colonyship");
  assert.ok(ship, "an Odyssey world seeds the AI a colony ship");
  updateDiplomacy(s, 1);
  const before = s.diplomacy.stance;
  assert.ok(deployColonyShip(s, ship.id), "the ship deploys into a Command Center");
  updateDiplomacy(s, 1);
  assert.ok(s.diplomacy.stance >= before - 1e-9, "founding its own colony must not sour the neighbour against you");
  assert.ok(!provoked(s), "…nor hand it standing to attack a player who has done nothing");
});

test("a destroyed WORKER is still a grievance — only self-consuming roles are exempt", () => {
  const s = createGameState({ planetId: "ferros", rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  const w = makeUnit("worker", "ai", 500, 500);
  s.units.set(w.id, w);
  updateDiplomacy(s, 1);
  const before = s.diplomacy.stance;
  s.units.delete(w.id);
  updateDiplomacy(s, 1);
  assert.ok(s.diplomacy.stance < before, "killing its workers still sours it");
  assert.ok(provoked(s), "…and still provokes it");
});

/* ---------- FORGIVENESS: how long a grudge lasts is part of the personality ---------- */

// Souring was already flavoured by personality (grievanceMult — a Rusher world sours twice as fast
// as a patient one). COOLING OFF was not: every neighbour recovered from being bled at exactly the
// same rate, and once provoked, every neighbour stayed provoked for ever. So a Warlord world and a
// research capital held a grudge identically, which is the one place the temperaments read the same.
//
// One dial, `forgiveness`, now drives both halves of the cooldown — the drift back up toward the
// scarcity target, and how long the neighbour keeps treating you as an active aggressor. It
// composes across archetype x strategy x difficulty and is bounded, exactly like graceMult.

import { MIN_FORGIVENESS, MAX_FORGIVENESS, PROVOKE_MEMORY, provoked } from "../engine/diplomacy.js";

const odyssey = (planetId, opts = {}) => {
  const s = createGameState({ planetId, endless: true, rng: () => 0.5, ...opts });
  s.diplomacy = createDiplomacy();
  return s;
};

test("a Warlord world holds its grudge; a patient one gets back to business", () => {
  const rusher = odyssey("korrath"), econ = odyssey("ferros");
  for (const s of [rusher, econ]) {
    for (const n of s.map.nodes) n.amount = n.max;   // full deposits ⇒ a cordial target to recover TOWARD
    s.diplomacy.stance = -0.9;                        // …both freshly bled to the same depth
    for (let i = 0; i < 200; i++) updateDiplomacy(s, 0.5);
  }
  assert.ok(econ.diplomacy.stance > rusher.diplomacy.stance,
    `the Economist cools off faster (econ ${econ.diplomacy.stance.toFixed(3)} vs rusher ${rusher.diplomacy.stance.toFixed(3)})`);
});

test("forgiveness changes the cooling, NOT the souring — those are separate dials", () => {
  // Drive both worlds DOWNWARD from a cordial stance on an identical, heavily-mined map, with the
  // grievance multiplier equalised, so the only thing that could differ is the drift rate.
  const mk = planetId => {
    const s = odyssey(planetId);
    for (const n of s.map.nodes) n.amount = 0;   // fully mined ⇒ a hostile target to sink TOWARD
    s.diplomacy.stance = 0.5;
    return s;
  };
  const rusher = mk("korrath"), econ = mk("ferros");
  for (const s of [rusher, econ]) for (let i = 0; i < 60; i++) updateDiplomacy(s, 0.5);
  assert.ok(Math.abs(rusher.diplomacy.stance - econ.diplomacy.stance) < 1e-9,
    "a personality that forgives faster must not also turn hostile slower — souring is grievanceMult's job");
});

test("the composed forgiveness multiplier is bounded like the others", () => {
  const s = odyssey("korrath", { aiStrategy: "aggressive", difficulty: "hard" });
  const f = effectiveDiplomacyMults(s).forgiveness;
  assert.ok(f >= MIN_FORGIVENESS && f <= MAX_FORGIVENESS, `composed forgiveness ${f} out of bounds`);
  assert.ok(f < effectiveDiplomacyMults(odyssey("ferros", { aiStrategy: "economic" })).forgiveness,
    "…and the extremes still order correctly: the vengeful stack forgives least");
});

/* ---------- the aggression cooldown: provocation is remembered, not latched for ever ---------- */

function bleed(s) {                      // destroy one of the neighbour's ships
  const u = makeUnit("skiff", "ai", 500, 500);
  s.units.set(u.id, u);
  updateDiplomacy(s, 0.1);
  s.units.delete(u.id);
  updateDiplomacy(s, 0.1);
}

test("a neighbour stops treating you as an aggressor after a long enough quiet spell", () => {
  const s = odyssey("ferros");
  bleed(s);
  assert.ok(provoked(s), "freshly bled ⇒ provoked");
  s.time += PROVOKE_MEMORY * 5;          // …then a long peace, comfortably past any personality's memory
  assert.ok(!provoked(s), "it eventually stands down — provocation is a memory, not a permanent brand");
});

test("that memory is longer for a world that holds grudges than for one that doesn't", () => {
  const rusher = odyssey("korrath"), econ = odyssey("ferros");
  for (const s of [rusher, econ]) bleed(s);
  // A quiet spell that the patient world has forgotten but the Warlord world has not.
  for (const s of [rusher, econ]) s.time += PROVOKE_MEMORY;
  assert.ok(provoked(rusher), "the Warlord world still remembers");
  assert.ok(!provoked(econ), "…while the patient one has moved on");
});

test("fresh blood resets the clock — a running war never quietly cools off", () => {
  const s = odyssey("vesper");   // Balanced: no forgiveness overlay, so its memory IS PROVOKE_MEMORY
  bleed(s);
  s.time += PROVOKE_MEMORY * 0.9;
  bleed(s);                               // hit it again just before it would have forgotten
  s.time += PROVOKE_MEMORY * 0.9;
  assert.ok(provoked(s), "each new loss re-arms the memory");
});

test("a charging Gate provokes for as long as it charges, whatever the memory says", () => {
  const s = odyssey("ferros");
  s.time = PROVOKE_MEMORY * 10;           // nothing remembered
  assert.ok(!provoked(s));
  const gate = makeBuilding("antimatter_gate", "player", 400, 400);
  gate.charge = 0.5;
  s.buildings.set(gate.id, gate);
  assert.ok(provoked(s), "a live bid to win the galaxy is a standing provocation, not a memory");
});

/* =================================================================================================
   Gifts and favor requests: an actual road to Allied. Two additions, both goods-funded: offerGift
   (hand the neighbour local stockpile, lifting a decaying goodwill pool with diminishing returns)
   and deterministic favor requests (updateDiplomacy occasionally asks for this world's scarcest
   commodity; fulfillRequest pays a premium + a goodwill bump before the deadline). Unlike tribute's
   hard APPEASE_FLOOR ceiling, goodwill has no ceiling short of Allied (stanceLabel's >= 0.6 band).
   ================================================================================================= */

/* ---------- offerGift ---------- */

test("offerGift deducts the gifted commodity from local stock and lifts the goodwill pool", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.metals = 500;
  const before = s.diplomacy.goodwill || 0;

  assert.equal(offerGift(s, "metals", 100), true);
  assert.equal(s.players.player.resources.metals, 400, "the gift leaves the local stockpile");
  assert.ok((s.diplomacy.goodwill || 0) > before, "the gift lifts the goodwill pool");
});

test("offerGift gifts only what's actually held, like sell() — never a negative stockpile", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.metals = 10;
  assert.equal(offerGift(s, "metals", 100), true, "still happens, just capped");
  assert.equal(s.players.player.resources.metals, 0, "gifted only the 10 actually held");
});

test("offerGift is a no-op with nothing to gift", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.metals = 0;
  const before = s.diplomacy.goodwill || 0;
  assert.equal(offerGift(s, "metals", 100), false);
  assert.equal(s.diplomacy.goodwill || 0, before, "no goodwill from an empty gift");
});

test("offerGift is a no-op without diplomacy (a skirmish) or without a market to price the gift against", () => {
  const bare = createGameState({ planetId: "ferros" });   // no diplomacy, no market — a plain skirmish
  bare.players.player.resources.metals = 500;
  assert.equal(offerGift(bare, "metals", 100), false, "no diplomacy ⇒ no-op");
  assert.equal(bare.players.player.resources.metals, 500, "…and nothing spent");

  const noMarket = createGameState({ planetId: "ferros", endless: true });
  noMarket.diplomacy = createDiplomacy();
  noMarket.players.player.resources.metals = 500;
  assert.equal(offerGift(noMarket, "metals", 100), false, "diplomacy but no market ⇒ no-op");
});

test("a single huge gift saturates the goodwill pool at its cap — it can't buy +1.0 in one dump", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.metals = 1e6;
  offerGift(s, "metals", 1e6);   // an absurdly large single dump
  assert.equal(s.diplomacy.goodwill, GOODWILL_CAP, "clamped at the cap, not proportional to the dump's size");
});

test("goodwill decays back toward 0 over time absent further gifts, same relaxation idiom as the market's own pressure/glut", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.metals = 500;
  offerGift(s, "metals", 300);
  const peak = s.diplomacy.goodwill;
  assert.ok(peak > 0, "sanity: the gift actually raised the pool");
  for (let i = 0; i < 600; i++) updateDiplomacy(s, 1);   // 600 sim-seconds, no further gifts
  assert.ok(s.diplomacy.goodwill < peak, "goodwill relaxes back down without maintenance");
});

test("sustained gifting can push a world's stance all the way to Allied that scarcity alone would hold well short of", () => {
  const control = createGalaxy({ seed: 11 });
  const cs = activeState(control);
  for (const n of cs.map.nodes) n.amount = n.max * 0.55;   // moderately depleted — scarcity target well under Allied
  cs.time = 500;                                            // past grace
  for (let i = 0; i < 1500; i++) updateDiplomacy(cs, 1);
  assert.ok(cs.diplomacy.stance < 0.6, `sanity: scarcity ALONE keeps this world short of Allied (${cs.diplomacy.stance.toFixed(3)})`);

  const g = createGalaxy({ seed: 11 });
  const s = activeState(g);
  for (const n of s.map.nodes) n.amount = n.max * 0.55;
  s.time = 500;
  s.players.player.resources.metals = 1e6;
  // Gift on a cadence tight enough that the decaying pool never drains far below its cap between
  // gifts (GOODWILL_DECAY's ~4min time constant vs a gift every 20 sim-seconds here) — a much
  // wider gap (tried: every 100s) still keeps goodwill's TIME-AVERAGE well above zero, but the
  // resulting sawtooth swings low enough between gifts that the stance's own (slower) drift only
  // ever tracks the average, not the peaks, and that average alone isn't always enough to clear
  // the Allied line — so this pins the cadence a sustained gifting habit actually needs, not just
  // "gift occasionally forever".
  for (let i = 0; i < 1500; i++) {
    if (i % 20 === 0) offerGift(s, "metals", 500);
    updateDiplomacy(s, 1);
  }
  assert.ok(s.diplomacy.stance >= 0.6, `sustained gifting must be able to reach Allied (got ${s.diplomacy.stance.toFixed(3)})`);
  assert.equal(stanceLabel(s.diplomacy.stance), "Allied");
});

/* ---------- fulfillRequest ---------- */

test("fulfillRequest pays the reward, deducts the exact requested qty, bumps goodwill, and clears the request", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.ore = 200;
  s.diplomacy.request = { com: "ore", qty: 50, until: s.time + 60, reward: 321 };
  const creditsBefore = g.credits, goodwillBefore = s.diplomacy.goodwill || 0;

  assert.equal(fulfillRequest(g, s), true);
  assert.equal(s.players.player.resources.ore, 150, "the exact requested qty is deducted");
  assert.equal(g.credits, creditsBefore + 321, "the reward is paid in universal credits");
  assert.ok((s.diplomacy.goodwill || 0) > goodwillBefore, "fulfilling bumps goodwill too");
  assert.equal(s.diplomacy.request, null, "the request is cleared once fulfilled");
});

test("fulfillRequest fails, and changes nothing, without enough stock to cover the exact ask", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.ore = 10;   // short of the 50 asked — no partial credit, this is a favor, not a trade
  s.diplomacy.request = { com: "ore", qty: 50, until: s.time + 60, reward: 321 };
  const creditsBefore = g.credits;

  assert.equal(fulfillRequest(g, s), false);
  assert.equal(s.players.player.resources.ore, 10, "nothing spent on a failed fulfillment");
  assert.equal(g.credits, creditsBefore, "no reward paid");
  assert.ok(s.diplomacy.request, "the request stays pending, not silently cleared");
});

test("fulfillRequest fails once the request has expired", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.ore = 200;
  s.time = 1000;
  s.diplomacy.request = { com: "ore", qty: 50, until: 999, reward: 321 };   // deadline already passed
  assert.equal(fulfillRequest(g, s), false, "an expired request can no longer be fulfilled");
});

test("fulfillRequest fails cleanly with no pending request, or with no galaxy", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  assert.equal(s.diplomacy.request, null, "sanity: nothing pending yet");
  assert.equal(fulfillRequest(g, s), false, "no request ⇒ no-op");

  s.diplomacy.request = { com: "ore", qty: 50, until: s.time + 60, reward: 321 };
  assert.equal(fulfillRequest(null, s), false, "no galaxy ⇒ no-op, mirrors offerTribute's own gate");
});

/* ---------- deterministic favor-request generation (updateDiplomacy) ---------- */

test("a peaceful world eventually rolls a favor request with a sane shape", () => {
  const g = createGalaxy({ seed: 21 });
  const s = activeState(g);   // a fresh, undisturbed world stays comfortably peaceful throughout
  let seen = null;
  for (let i = 0; i < 3000 && !seen; i++) { updateDiplomacy(s, 1); if (s.diplomacy.request) seen = s.diplomacy.request; }
  assert.ok(seen, "expected a favor request to roll within a reasonable simulated span");
  assert.ok(COM[seen.com], "names a real, tradeable commodity");
  assert.ok(Number.isInteger(seen.qty) && seen.qty > 0, "a whole, positive quantity");
  assert.ok(seen.reward > 0, "a positive credit reward");
  assert.ok(seen.until > s.time - 1e-9, "the deadline lies ahead of (or at) the moment it rolled");
});

test("no favor request rolls on a hostile world", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.diplomacy = createDiplomacy();
  s.market = createMarket(s);
  s.time = 1000;
  drainNodes(s, 0.02);   // nearly mined out -> hostile, mirrors the existing scarcity test above
  for (let i = 0; i < 4000; i++) updateDiplomacy(s, 0.1);
  assert.equal(atPeace(s), false, "sanity: this world is indeed at war");
  assert.equal(s.diplomacy.request, null, "a hostile neighbour doesn't ask favors");
});

test("a pending request is never overwritten while still live, even across a favor-bucket boundary", () => {
  const g = createGalaxy({ seed: 21 });
  const s = activeState(g);
  s.diplomacy.stance = 0.5;                          // comfortably peaceful
  s.time = FAVOR_INTERVAL - 5;                        // 5s from a bucket boundary
  const planted = { com: "ore", qty: 50, until: s.time + 500, reward: 999 };
  s.diplomacy.request = { ...planted };
  s.diplomacy.lastFavorBucket = Math.floor(s.time / FAVOR_INTERVAL);   // as if it had just rolled THIS bucket

  for (let i = 0; i < 100; i++) updateDiplomacy(s, 1);   // crosses at least one bucket boundary, well inside `until`
  assert.deepEqual(s.diplomacy.request, planted, "a still-pending request must never be replaced while unexpired");
});

test("an expired, unfulfilled request clears itself on the next tick, freeing the slot", () => {
  const g = createGalaxy({ seed: 21 });
  const s = activeState(g);
  s.diplomacy.stance = -0.9;   // hostile, so a fresh roll can't land in the very same tick and mask the clear
  s.time = 1000;
  s.diplomacy.request = { com: "ore", qty: 50, until: 999, reward: 10 };   // already past its deadline
  updateDiplomacy(s, 0.1);
  assert.equal(s.diplomacy.request, null, "an expired request is withdrawn, unfulfilled");
});

test("the favor-request schedule is deterministic — two identical runs from the same seed stay in lockstep", () => {
  const g1 = createGalaxy({ seed: 33 });
  const s1 = activeState(g1);
  const g2 = createGalaxy({ seed: 33 });
  const s2 = activeState(g2);
  for (let i = 0; i < 3000; i++) { updateDiplomacy(s1, 1); updateDiplomacy(s2, 1); }
  assert.deepEqual(s1.diplomacy, s2.diplomacy,
    "same seed ⇒ byte-identical diplomacy state, including whatever favor request happened to roll and when");
});

/* ---------- persistence: dip fields (goodwill, a pending request) persist for free ---------- */
// persist.js's serializeGalaxy spreads the WHOLE state.diplomacy object (`{ ...state.diplomacy }`),
// and deserializeGalaxy rehydrates via `{ ...createDiplomacy(), ...P.diplomacy }` — so any field
// createDiplomacy() states is covered without persist.js needing to name it. Verified end-to-end
// here rather than just trusted from reading the source.

test("gift/favor diplomacy fields (goodwill, a pending request) round-trip a galaxy save/load", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  s.players.player.resources.metals = 500;
  offerGift(s, "metals", 200);
  s.diplomacy.request = { com: "ore", qty: 50, until: s.time + 60, reward: 321 };

  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rd = activeState(restored).diplomacy;
  assert.ok(Math.abs(rd.goodwill - s.diplomacy.goodwill) < 1e-9, "goodwill survives the round-trip");
  assert.deepEqual(rd.request, s.diplomacy.request, "a pending favor request survives the round-trip");
});
