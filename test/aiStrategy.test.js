/* ============================================================
   AI STRATEGY (engine/aiStrategy.js): a player-picked overlay, orthogonal to the
   archetype, that sets aggression rather than flavor — see the module header for
   the full design. These tests cover: the table/resolution itself, the skirmish
   offense-timing multipliers, the Odyssey diplomacy compose, the standing-army
   throttle (Economic's fixed cap + war-footing surge, Force Parity's dynamic
   mirror), and Economic's push into the deep industry chain regardless of
   archetype. engine/aiSuperweapon.js (the Helium Bomb) has its own file.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { tick } from "../engine/sim.js";
import { mulberry32 } from "../engine/rng.js";
import { STRATEGIES, strategyFor } from "../engine/aiStrategy.js";
import { createDiplomacy, updateDiplomacy } from "../engine/diplomacy.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

function stockedBarracks(state, dy = -100) {
  const b = makeBuilding("barracks", "ai", state.map.bases.ai.x, state.map.bases.ai.y + dy);
  state.buildings.set(b.id, b);
  return b;
}
function fundAll(state) {
  Object.assign(state.players.ai.resources, { ore: 100000, crystals: 100000, radioactives: 100000 });
}
function homeSkiffs(state, n) {
  const units = [];
  for (let i = 0; i < n; i++) {
    const u = makeUnit("skiff", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
    state.units.set(u.id, u);
    units.push(u);
  }
  return units;
}

/* ---------- the table + resolution ---------- */

test("STRATEGIES.default carries no overriding fields — a genuine no-op overlay", () => {
  const d = STRATEGIES.default;
  for (const field of ["attackTimeoutMult", "armyAttackSizeMult", "garrisonMult", "graceMult", "grievanceMult",
                        "neverInitiates", "standingArmyCap", "matchEnemyForce", "wantsIndustryAlways", "useBombOffensively"]) {
    assert.equal(d[field], undefined, `default.${field} should be unset`);
  }
});

test("every strategy names itself, and only Economic/Force Parity opt out of ever initiating", () => {
  for (const [key, st] of Object.entries(STRATEGIES)) {
    assert.ok(st.name, `${key} should have a display name`);
    assert.ok(st.desc, `${key} should have a setup-screen description`);
  }
  assert.equal(STRATEGIES.economic.neverInitiates, true);
  assert.equal(STRATEGIES.matching.neverInitiates, true);
  assert.ok(!STRATEGIES.aggressive.neverInitiates);
  assert.ok(!STRATEGIES.default.neverInitiates);
});

test("strategyFor falls back to default for an unset or unrecognised state.ai.strategy", () => {
  const s = createGameState({ planetId: "ferros" });
  assert.equal(strategyFor(s), STRATEGIES.default, "unset ⇒ default");
  s.ai.strategy = "not-a-real-strategy";
  assert.equal(strategyFor(s), STRATEGIES.default, "unrecognised ⇒ default, never throws");
});

test("createGameState wires opts.aiStrategy onto state.ai.strategy", () => {
  const s = createGameState({ planetId: "ferros", aiStrategy: "aggressive" });
  assert.equal(s.ai.strategy, "aggressive");
  assert.equal(strategyFor(s), STRATEGIES.aggressive);
});

// setup.js pulls in boot.js -> hud.js, which touches real DOM elements at module load time — it
// can never be `import`ed from a headless test (see static-integrity.test.js's own DIFFICULTY_OPTIONS
// guard for the same constraint). So this reads it as plain text instead, the same technique.
test("setup.js's STRATEGY_OPTIONS (the splash-screen picker) matches STRATEGIES exactly — no orphaned key either side", () => {
  const setupSrc = readFileSync(fileURLToPath(new URL("../setup.js", import.meta.url)), "utf8");
  const optionsBlock = setupSrc.match(/export const STRATEGY_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(optionsBlock, "setup.js must export STRATEGY_OPTIONS");
  const optionKeys = [...optionsBlock[1].matchAll(/mult:\s*"([a-z]+)"/g)].map(m => m[1]);
  assert.ok(optionKeys.length >= Object.keys(STRATEGIES).length, "expected at least one picker option per strategy");
  for (const key of optionKeys) assert.ok(STRATEGIES[key], `setup.js offers "${key}", which isn't a real strategy`);
  for (const key of Object.keys(STRATEGIES)) assert.ok(optionKeys.includes(key), `STRATEGIES.${key} has no picker option in setup.js`);
});

/* ---------- Aggressive: skirmish offense timing ---------- */

test("Aggressive commits an all-in wave on its (stretched-shorter) timeout well before Adaptive would", () => {
  // Economist (ferros): attackTimeout 200. Aggressive's attackTimeoutMult 0.55 ⇒ 110.
  // state.time=150 sits between the two — only Aggressive should have timed out.
  const mk = strategy => {
    const s = createGameState({ planetId: "ferros", aiStrategy: strategy });
    s.time = 150;
    homeSkiffs(s, 2);   // far below either archetype's own armyAttackSize (9) — timeout is the only lever in play
    return s;
  };
  const aggro = mk("aggressive"), base = mk("default");
  runAI(aggro, THINK_INTERVAL);
  runAI(base, THINK_INTERVAL);
  const attacking = s => [...s.units.values()].some(u => u.owner === "ai" && u.order?.type === "attack-move");
  assert.ok(attacking(aggro), "Aggressive's shortened desperation timeout has already elapsed at t=150");
  assert.ok(!attacking(base), "Adaptive's full 200s timeout has not, and the army is too small to threshold-commit");
});

test("Aggressive also commits with a smaller muster than Adaptive would accept, well before any timeout", () => {
  // effArmyAttackSize under Aggressive: 9 * 0.6 = 5.4. Seed 7: with >=4 in the army, updateScout
  // (ai.js) lends ONE of them out as a scout before aiOffense ever sees the rest, so only 6 count
  // toward the muster — still clears Aggressive's 5.4, but short of Adaptive's full 9.
  const mk = strategy => {
    const s = createGameState({ planetId: "ferros", aiStrategy: strategy });
    s.time = 0;   // nowhere near either timeout (110 / 200) — only the army-size threshold can fire
    homeSkiffs(s, 7);
    return s;
  };
  const aggro = mk("aggressive"), base = mk("default");
  runAI(aggro, THINK_INTERVAL);
  runAI(base, THINK_INTERVAL);
  const attacking = s => [...s.units.values()].some(u => u.owner === "ai" && u.order?.type === "attack-move");
  assert.ok(attacking(aggro), "6 non-scout skiffs clears Aggressive's scaled-down muster (5.4)");
  assert.ok(!attacking(base), "the same 6 non-scout skiffs falls short of Adaptive's full muster (9)");
});

/* ---------- Aggressive: Odyssey diplomacy ---------- */

test("Aggressive strategy sours an Odyssey neighbour faster than Adaptive, on the identical (Balanced) archetype", () => {
  // vesper -> Balanced, which carries no odyssey overlay of its own (ai-odyssey.test.js), isolating
  // the strategy's effect from any archetype-driven grace/grievance difference.
  const mk = strategy => {
    const s = createGameState({ planetId: "vesper", rng: () => 0.5, aiStrategy: strategy });
    s.diplomacy = createDiplomacy();
    s.endless = true;
    return s;
  };
  const aggro = mk("aggressive"), base = mk("default");
  for (const s of [aggro, base]) {
    s.time = 300;
    for (const n of s.map.nodes) n.amount = n.max * 0.5;   // identical scarcity on both worlds
    for (let i = 0; i < 60; i++) updateDiplomacy(s, 0.5);
  }
  assert.ok(aggro.diplomacy.stance < base.diplomacy.stance,
    `Aggressive is more hostile at identical time & scarcity (aggro ${aggro.diplomacy.stance.toFixed(3)} vs default ${base.diplomacy.stance.toFixed(3)})`);
});

/* ---------- Economic: the standing-army throttle + war footing ---------- */

test("Economic strategy stops training combat units once it reaches its small standing-army cap", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "economic" });
  const barracks = stockedBarracks(state);
  fundAll(state);
  homeSkiffs(state, 3);   // exactly STRATEGIES.economic.standingArmyCap
  runAI(state, THINK_INTERVAL);
  assert.equal(barracks.queue.length, 0, "at the cap, Economic banks its ore instead of training a 4th combat unit");
});

test("...but resumes production immediately once it's actually attacked (war footing), and still defends", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "economic" });
  const barracks = stockedBarracks(state);
  fundAll(state);
  const guards = homeSkiffs(state, 3);
  const raider = makeUnit("skiff", "player", state.map.bases.ai.x - 40, state.map.bases.ai.y);
  state.units.set(raider.id, raider);

  runAI(state, THINK_INTERVAL);

  assert.ok(guards.every(u => u.order?.type === "attack-move"), "the standing guard still rushes to defend — strategy never suppresses it");
  assert.ok(barracks.queue.length > 0, "war footing lifts the cap the same cycle the threat is seen");
});

test("Economic never volunteers an attack from army size alone, however large the standing army", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "economic" });
  state.time = 50;
  homeSkiffs(state, 20);   // far past the archetype's own armyAttackSize (9)
  runAI(state, THINK_INTERVAL);
  const attacking = [...state.units.values()].some(u => u.owner === "ai" && u.order?.type === "attack-move");
  assert.ok(!attacking, "a big standing army alone never triggers Economic's offense");
});

// Regression test for a real player report: an Economic AI "raided" a player who had built
// nothing but a scout, purely because enough real time had passed — the OLD design still threw
// an all-in wave off a stretched-but-finite desperation timeout even under neverInitiates. There
// is no timeout any more for this strategy: it must mean "never attacks unprovoked" literally, on
// any elapsed time, not just "not for a good while".
test("Economic still never attacks even long past where the old desperation timeout used to fire", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "economic" });
  state.time = state.ai.archetype.attackTimeout * 20;   // comfortably past the old 7x-stretched clock
  homeSkiffs(state, 1);
  runAI(state, THINK_INTERVAL);
  const attacking = [...state.units.values()].some(u => u.owner === "ai" && u.order?.type === "attack-move");
  assert.ok(!attacking, "no amount of elapsed time alone triggers Economic's offense");
});

// The safety net a never-initiates strategy actually relies on: not a forced combat commit, but
// victory.js's pre-existing score-based match time limit — a mutual-turtle skirmish (an Economic
// AI facing a genuinely passive player, matching sim.test.js's own convention) still terminates.
test("an all-turtle mirror match (Economic AI, fully passive player) resolves by score at the match time limit, not combat", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "economic" });
  const dt = 1;
  for (let i = 0; i < 2401 && !state.over; i++) tick(state, dt);
  assert.ok(state.over, "the match still terminates without either side ever fighting");
  assert.ok(["player", "ai"].includes(state.winner));
  // Neither Command Center fell to combat — this was decided by score, not conquest.
  const hasCC = owner => [...state.buildings.values()].some(b => b.owner === owner && b.type === "command");
  assert.ok(hasCC("player") && hasCC("ai"), "both bases are still standing — the finish was the score tiebreak, not a raze");
});

test("Economic never launches an Odyssey offensive wave off hostility alone, even fully hostile", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5, aiStrategy: "economic" });
  state.diplomacy = createDiplomacy();
  state.diplomacy.stance = -1;   // fully hostile
  state.endless = true;
  homeSkiffs(state, 20);
  runAI(state, THINK_INTERVAL);
  const attacking = [...state.units.values()].some(u => u.owner === "ai" && u.order?.type === "attack-move");
  assert.ok(!attacking, "hostility alone never triggers a wave under a never-initiates strategy — Odyssey has no desperation clock to fall back on");
});

/* ---------- Force Parity: the dynamic mirror ---------- */

test("Force Parity throttles production once its army matches the enemy force it's actually seen", () => {
  // 4 visible enemy skiffs -> target = max(matchFloor 3, round(4 * matchBuffer 1.15)) = max(3, 5) = 5.
  const state = createGameState({ planetId: "ferros", aiStrategy: "matching" });
  const barracks = stockedBarracks(state);
  fundAll(state);
  homeSkiffs(state, 5);   // at the computed target
  for (let i = 0; i < 4; i++) {
    // Tucked right at the AI's own doorstep, inside the seeded Command Center's sight, so the
    // initial fog pass (createGameState) already marks it visible — no live updateFog needed.
    const s = makeUnit("skiff", "player", state.map.bases.ai.x - 150, state.map.bases.ai.y + i * 6);
    state.units.set(s.id, s);
  }
  runAI(state, THINK_INTERVAL);
  assert.equal(barracks.queue.length, 0, "5 skiffs already matches (with buffer) the 4 seen enemy skiffs");
});

test("...and resumes once it's short of that same target", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "matching" });
  const barracks = stockedBarracks(state);
  fundAll(state);
  homeSkiffs(state, 4);   // one short of the target of 5
  for (let i = 0; i < 4; i++) {
    const s = makeUnit("skiff", "player", state.map.bases.ai.x - 150, state.map.bases.ai.y + i * 6);
    state.units.set(s.id, s);
  }
  runAI(state, THINK_INTERVAL);
  assert.ok(barracks.queue.length > 0, "short of the mirrored target, Force Parity keeps training");
});

test("Force Parity keeps a minimal floor even with no enemy in sight yet", () => {
  const state = createGameState({ planetId: "ferros", aiStrategy: "matching" });
  const barracks = stockedBarracks(state);
  fundAll(state);
  homeSkiffs(state, 3);   // exactly matchFloor, no enemy scouted at all
  runAI(state, THINK_INTERVAL);
  assert.equal(barracks.queue.length, 0, "an unscouted enemy still leaves the floor in force");
});

/* ---------- Economic: leans into every economic capability, regardless of archetype ---------- */

function aiBase(planetId, opts = {}) {
  const seed = 4242;
  const s = createGameState({ planetId, endless: true, seed, rng: mulberry32(seed), ...opts });
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 3000;
  return s;
}
const aiTypes = s => new Set([...s.buildings.values()].filter(b => b.owner === "ai").map(b => b.type));

test("Economic strategy pushes even a Rusher archetype into the deep industry chain (Smelter + Datacenter)", () => {
  const s = aiBase("korrath", { aiStrategy: "economic" });   // Rusher -> archetype.wantsRefinery is false
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  Object.assign(s.players.ai.resources, { crystals: 3000, radioactives: 3000, ore: 3000 });
  for (let i = 0; i < 10; i++) runAI(s, THINK_INTERVAL);
  assert.ok(aiTypes(s).has("smelter"), "Economic strategy opens the industrial chain even on a Rusher world");
  assert.ok(aiTypes(s).has("datacenter"), "…and researches, same as any other patient developer");
});

test("...while the default (Adaptive) strategy still leaves that same Rusher world's chain alone", () => {
  const s = aiBase("korrath");   // no aiStrategy -> "default"
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  Object.assign(s.players.ai.resources, { crystals: 3000, radioactives: 3000, ore: 3000 });
  for (let i = 0; i < 10; i++) runAI(s, THINK_INTERVAL);
  assert.ok(!aiTypes(s).has("smelter"), "regression guard: Adaptive Rusher keeps its lean, no-chain temperament");
});

/* ---------- Odyssey PROVOCATION: neverInitiates means "unprovoked", not "never" ---------- */

// neverInitiates was made absolute to fix a real player report (see the regression test above), and
// in a SKIRMISH that's exactly right — the match resolves on score, so a passive player never needs
// to be attacked. But Odyssey has no clock and no score: a neighbour whose stance had been dragged
// all the way to fully Hostile still sat there forever, so half a galaxy's worlds (neighbourAiProfile
// samples strategies uniformly, and two of four never initiate) read "Hostile" in the HUD and never
// sent anything — 0 waves in all 22 such runs of a full-roster soak, docs/odyssey-ai-review.md §2.1.
// The flag now means what it says: this AI does not START fights, but it does answer one. Provocation
// is strictly things the PLAYER did — destroyed its ships, or is charging a galaxy-winning Gate —
// never mere elapsed time, which is what the original bug was.

// A fully hostile Odyssey world with a real home army for a never-initiating AI to commit.
function hostileOdyssey(strategy) {
  const state = createGameState({ planetId: "ferros", endless: true, aiStrategy: strategy,
                                  seed: 4242, rng: mulberry32(4242) });
  const cc = makeBuilding("command", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
  state.buildings.set(cc.id, cc);
  state.diplomacy = createDiplomacy();
  state.diplomacy.stance = -1;         // fully hostile: hostility() === 1
  homeSkiffs(state, 14);               // comfortably past the Economist's 9-unit muster
  fundAll(state);
  return state;
}
const aiAttacking = state =>
  [...state.units.values()].some(u => u.owner === "ai" && u.order?.type === "attack-move");

for (const strategy of ["economic", "matching"]) {
  test(`an unprovoked ${strategy} neighbour still never attacks, however hostile the world has become`, () => {
    const state = hostileOdyssey(strategy);
    for (let i = 0; i < 5; i++) { state.ai.think = 0; runAI(state, THINK_INTERVAL); }
    assert.ok(!aiAttacking(state), "a player who has done nothing to it is still left alone — the original fix holds");
  });

  test(`a ${strategy} neighbour DOES answer once the player has destroyed its ships`, () => {
    const state = hostileOdyssey(strategy);
    state.diplomacy.provokedAt = state.time;   // stamped by updateDiplomacy on a grievance — see diplomacy.test.js
    for (let i = 0; i < 5; i++) { state.ai.think = 0; runAI(state, THINK_INTERVAL); }
    assert.ok(aiAttacking(state), "a fully hostile neighbour that has been bled must eventually answer");
  });
}

test("a charging player Gate provokes a never-initiating neighbour — the finale can't be waited out", () => {
  const state = hostileOdyssey("economic");
  const gate = makeBuilding("antimatter_gate", "player", state.map.bases.player.x, state.map.bases.player.y - 80);
  gate.charge = 0.5;
  state.buildings.set(gate.id, gate);
  for (let i = 0; i < 5; i++) { state.ai.think = 0; runAI(state, THINK_INTERVAL); }
  assert.ok(aiAttacking(state), "a bid to win the whole galaxy is provocation on its own");
});

test("provocation is ODYSSEY-only — a skirmish Economic AI stays absolutely non-initiating", () => {
  // No state.diplomacy at all in a skirmish, so there is nothing to be provoked BY: the flag keeps
  // its original, literal meaning on the path where the player report came from.
  const state = createGameState({ planetId: "ferros", aiStrategy: "economic" });
  state.time = state.ai.archetype.attackTimeout * 20;
  homeSkiffs(state, 14);
  fundAll(state);
  for (let i = 0; i < 5; i++) { state.ai.think = 0; runAI(state, THINK_INTERVAL); }
  assert.ok(!aiAttacking(state), "the skirmish desperation-timeout escape hatch stays closed");
});
