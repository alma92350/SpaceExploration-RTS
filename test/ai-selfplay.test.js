/* ============================================================
   TIER 1 SELF-PLAY (engine/ai.js runAI(state, dt, owner), tools/selfplay.js) — the real scripted
   AI driving BOTH sides of a skirmish match, each independently configured, for real head-to-head
   play. Four things this suite exists to prove:

     1. BACKWARD COMPATIBLE: the self-play machinery, with the second controller absent, is
        byte-identical to today's single-AI loop (constraint 1 — hard, non-negotiable).
     2. BOTH SIDES ACTUALLY PLAY: with both state.ai and state.playerAi populated, both take real
        actions over several minutes — build, produce, research.
     3. FOG FAIRNESS (constraint 2 — the single most important property of this whole tier): each
        controller reacts ONLY to what its own fog has revealed, never omniscient of the other, and
        the two controllers' action budgets are fully independent (no shared state.ai.apm/
        actionBudget field between them).
     4. DETERMINISM: two identical self-play runs, same seed, produce byte-identical results.

   The rest of the existing suite (test/ai.test.js, aiMilitary.test.js, aiEconomyOdyssey.test.js,
   aiStrategy.test.js, etc.) already covers owner "ai"'s own single-sided behavior in exhaustive
   detail and is untouched by this feature — this file is scoped to what's NEW: the second
   controller and the fairness between the two.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import { accrueActionBudget, canAct, spend } from "../engine/aiCommon.js";
import { readFileSync } from "node:fs";
import { visibleThreatsNearHome, pickNextUnitType } from "../engine/aiMilitary.js";
import { updateFog, isVisibleAt } from "../engine/fog.js";
import { mulberry32 } from "../engine/rng.js";
import {
  createSelfPlayState, tickSelfPlay, runSelfPlayMatch, fingerprint,
} from "../tools/selfplay.js";

const DT = 0.1;

/* ============================================================
   1. BACKWARD COMPATIBILITY
   ============================================================ */

// engine/state.js resets its module-global entity-id counter at the START of every
// createGameState call, so two RUNS are only guaranteed identical ids if each is built AND run to
// completion before the next one is even constructed — never interleaved (test/determinism.test.js's
// own runTo() follows exactly this shape). Getting this wrong in a test looks exactly like a false
// determinism failure: real entities, real divergence, but caused by the harness sharing state
// creation across two live runs, not by anything under test.
function runPlainTo(seed, ticks) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  for (let i = 0; i < ticks; i++) tick(state, DT);
  return state;
}
function runSelfPlayTo(seed, ticks) {
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  for (let i = 0; i < ticks; i++) tickSelfPlay(state, DT);
  return state;
}

test("self-play's own tick wrapper is byte-identical to today's single-AI sim.tick when the second controller is absent", () => {
  const plain = runPlainTo(42, 3000);              // today's exact per-tick call
  const wrapped = runSelfPlayTo(42, 3000);          // self-play's wrapper (runAI(..,"player") no-ops, then tick())
  assert.equal(plain.playerAi, null, "fixture: no self-play activated on the plain state");
  assert.equal(wrapped.playerAi, null, "fixture: no self-play activated on the wrapped state either — tickSelfPlay must not require it");

  assert.equal(fingerprint(plain), fingerprint(wrapped),
    "with no second controller, driving through tickSelfPlay must replay exactly like the plain per-tick loop");
  assert.ok(plain.tick > 100, "sanity: the run actually progressed");
});

test("runAI(state, dt) with no owner argument still drives exactly owner \"ai\", unchanged", () => {
  const seed = 9;
  const a = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  const b = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  for (let i = 0; i < 50; i++) { runAI(a, 1.5); runAI(b, 1.5, "ai"); }
  assert.equal(JSON.stringify(a.ai), JSON.stringify(b.ai), "the 2-arg and explicit-owner-\"ai\" calls must produce identical bookkeeping");
});

test("runAI(state, dt, \"player\") is a safe no-op when state.playerAi hasn't been populated", () => {
  const state = createGameState({ planetId: "ferros", seed: 5, rng: mulberry32(5) });
  const before = JSON.stringify([...state.units.values()].map(u => [u.id, u.order]));
  assert.doesNotThrow(() => runAI(state, 1.5, "player"));
  const after = JSON.stringify([...state.units.values()].map(u => [u.id, u.order]));
  assert.equal(before, after, "no state.playerAi ⇒ nothing for owner \"player\" to have done");
});

test("aiCommon's budget primitives default to owner \"ai\" — every existing 1-arg call site is unaffected", () => {
  const state = createGameState({ planetId: "ferros", seed: 1, rng: mulberry32(1) });
  state.ai.apm = 60;
  accrueActionBudget(state, 1.5);              // no owner arg — must touch state.ai, not throw
  assert.ok(state.ai.actionBudget > 0, "accrueActionBudget(state, dt) still credits state.ai's own budget");
  assert.equal(canAct(state), state.ai.actionBudget >= 1);
  const budgetBefore = state.ai.actionBudget;
  if (canAct(state)) { spend(state); assert.equal(state.ai.actionBudget, budgetBefore - 1); }
});

/* ============================================================
   2. BOTH SIDES ACTUALLY PLAY
   ============================================================ */

test("with both controllers populated, both sides build, produce units, and research over several minutes", () => {
  const state = createSelfPlayState({
    planetId: "ferros", seed: 11,
    ai: { strategy: "default", difficulty: "medium" },
    playerAi: { strategy: "default", difficulty: "medium" },
  });
  assert.ok(state.playerAi, "fixture: self-play actually activated");
  assert.notEqual(state.playerAi, state.ai, "the two controllers must be distinct objects");

  for (let i = 0; i < 6000; i++) tickSelfPlay(state, DT);   // 600 sim-seconds — 10 minutes

  const buildingsOf = o => [...state.buildings.values()].filter(b => b.owner === o);
  const unitsOf = o => [...state.units.values()].filter(u => u.owner === o);

  for (const owner of ["ai", "player"]) {
    assert.ok(buildingsOf(owner).some(b => b.type === "barracks"),
      `${owner}-controller must have built a Barracks by 10 minutes in`);
    assert.ok(unitsOf(owner).some(u => u.type !== "worker"),
      `${owner}-controller must have produced at least one combat unit by 10 minutes in`);
  }
  assert.ok(state.ai.unitsBuilt > 0, "state.ai's own unitsBuilt tally advanced");
  assert.ok(state.playerAi.unitsBuilt > 0, "state.playerAi's own unitsBuilt tally advanced — its OWN counter, not state.ai's");
});

test("the two controllers' action budgets never collide — spending one never starves or double-credits the other", () => {
  const state = createSelfPlayState({
    planetId: "ferros", seed: 21,
    ai: { apm: 20 }, playerAi: { apm: 200 },   // deliberately very different APMs
  });
  for (let i = 0; i < 300; i++) tickSelfPlay(state, DT);   // 30 sim-seconds
  // Two independently-configured APMs must produce visibly different action-budget bookkeeping —
  // if the two controllers secretly shared one field, these would read identically (or worse, the
  // low-APM side would silently inherit the high-APM side's budget/vice versa).
  assert.notEqual(state.ai.actionBudget, state.playerAi.actionBudget,
    "sanity: two very different APMs should not coincidentally land on the exact same budget");
  assert.ok(state.ai.apm === 20 && state.playerAi.apm === 200, "each controller kept its own configured APM");
});

/* ============================================================
   3. FOG FAIRNESS — the single most important property of this tier
   ============================================================ */

// A point sitting well inside DEFEND_RADIUS (340) of `cc`, but far enough past its own building's
// sight (220) that a bare, freshly-created state's fog has not yet revealed that cell — verified
// empirically below via the isVisibleAt fixture assertions, not just assumed. Offset TOWARD the
// map's horizontal center (not a fixed "+x"), so it lands on the contested middle ground for
// EITHER base regardless of which side of the map that base sits on — a base near the map's right
// edge (as "ai" typically is) would otherwise have "+x" walk the point straight off the map, which
// isVisibleAt/isExploredAt read as permanently false for reasons that have nothing to do with fog.
const THREAT_DISTANCE = 300;
function towardCenter(state, cc) {
  const dir = Math.sign(state.map.width / 2 - cc.x) || 1;
  return { x: cc.x + dir * THREAT_DISTANCE, y: cc.y };
}
function towardCenterOffset(state, cc, i) {
  const dir = Math.sign(state.map.width / 2 - cc.x) || 1;
  return { x: cc.x + dir * (THREAT_DISTANCE + i * 4), y: cc.y };
}

test("threat-detection: neither controller reacts to an enemy unit its OWN fog has not seen, and both react once it has", () => {
  const state = createSelfPlayState({ planetId: "ferros", seed: 3 });
  const aiCC = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  const playerCC = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");

  // An "ai"-owned skiff parked just past the PLAYER's own Command-Center sight, but still inside
  // the player-controller's DEFEND_RADIUS if it COULD see it. Symmetric "player"-owned skiff near
  // the ai's own base.
  const pt1 = towardCenter(state, playerCC), pt2 = towardCenter(state, aiCC);
  const threatToPlayer = makeUnit("skiff", "ai", pt1.x, pt1.y);
  state.units.set(threatToPlayer.id, threatToPlayer);
  const threatToAi = makeUnit("skiff", "player", pt2.x, pt2.y);
  state.units.set(threatToAi.id, threatToAi);

  // Fixture sanity: confirm each defender's OWN fog genuinely has not seen its own threat yet —
  // otherwise the zero-threats assertions below would be trivially true for the wrong reason.
  assert.equal(isVisibleAt(state.fogs.player, threatToPlayer.x, threatToPlayer.y), false,
    "fixture: the player-controller's own fog has not revealed the ai-owned threat");
  assert.equal(isVisibleAt(state.fogs.ai, threatToAi.x, threatToAi.y), false,
    "fixture: the ai controller's own fog has not revealed the player-owned threat");

  // THE FAIRNESS ASSERTION: an unseen threat, however real and however close, is invisible to
  // threat-detection. Getting this wrong in either direction is exactly the omniscience bug
  // constraint 2 exists to prevent.
  assert.equal(visibleThreatsNearHome(state, "player").length, 0,
    "the player-controller must NOT react to an ai-owned unit its own fog hasn't seen");
  assert.equal(visibleThreatsNearHome(state, "ai").length, 0,
    "the ai controller must NOT react to a player-owned unit its own fog hasn't seen");

  // And the same holds through the real orchestrator: neither army recalls to defend a threat it
  // cannot see (no attack-move order should appear pointed at the hidden threat's position).
  runAI(state, 1.5, "player");
  runAI(state, 1.5, "ai");
  const recalledTowardPlayerThreat = [...state.units.values()].some(u =>
    u.owner === "player" && u.order?.type === "attack-move"
    && Math.hypot(u.order.x - threatToPlayer.x, u.order.y - threatToPlayer.y) < 40);
  const recalledTowardAiThreat = [...state.units.values()].some(u =>
    u.owner === "ai" && u.order?.type === "attack-move"
    && Math.hypot(u.order.x - threatToAi.x, u.order.y - threatToAi.y) < 40);
  assert.equal(recalledTowardPlayerThreat, false, "no player-owned unit recalls toward an unseen ai threat");
  assert.equal(recalledTowardAiThreat, false, "no ai-owned unit recalls toward an unseen player threat");

  // MECHANISM SANITY: once each defender's OWN fog actually reveals its own threat — a scout of
  // its own parked right on top of it — the SAME function DOES react, proving the zero above was
  // a real fog gate, not a function that always returns nothing regardless of visibility.
  const playerScout = makeUnit("worker", "player", threatToPlayer.x, threatToPlayer.y);
  state.units.set(playerScout.id, playerScout);
  const aiScout = makeUnit("worker", "ai", threatToAi.x, threatToAi.y);
  state.units.set(aiScout.id, aiScout);
  updateFog(state, state.fogs.player, "player");
  updateFog(state, state.fogs.ai, "ai");
  assert.ok(isVisibleAt(state.fogs.player, threatToPlayer.x, threatToPlayer.y), "fixture: now visible to the player-controller");
  assert.ok(isVisibleAt(state.fogs.ai, threatToAi.x, threatToAi.y), "fixture: now visible to the ai controller");
  assert.ok(visibleThreatsNearHome(state, "player").some(u => u.id === threatToPlayer.id),
    "once genuinely seen, the player-controller DOES react to the same threat");
  assert.ok(visibleThreatsNearHome(state, "ai").some(u => u.id === threatToAi.id),
    "once genuinely seen, the ai controller DOES react to the same threat");
});

test("counter-pick: neither controller's mix reacts to an enemy army its OWN fog has not seen", () => {
  const state = createSelfPlayState({ planetId: "ferros", seed: 3 });
  const aiCC = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  const playerCC = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  // A completed Foundry for BOTH owners, so the Lancer counter-pick is actually reachable in each
  // controller's own effectiveMix (prereqsMet is now owner-aware — engine/aiWorkers.js).
  const aiFoundry = makeBuilding("foundry", "ai", aiCC.x, aiCC.y + 140);
  const playerFoundry = makeBuilding("foundry", "player", playerCC.x, playerCC.y + 140);
  state.buildings.set(aiFoundry.id, aiFoundry);
  state.buildings.set(playerFoundry.id, playerFoundry);

  // A massed "ai"-owned Bastion army near the player's base — a hard counter-pick trigger (Lancer)
  // IF the player-controller could see it — and the symmetric massed "player"-owned army near the
  // ai's base.
  for (let i = 0; i < 5; i++) {
    const p = towardCenterOffset(state, playerCC, i);
    const u = makeUnit("bastion", "ai", p.x, p.y);
    state.units.set(u.id, u);
  }
  for (let i = 0; i < 5; i++) {
    const p = towardCenterOffset(state, aiCC, i);
    const u = makeUnit("bastion", "player", p.x, p.y);
    state.units.set(u.id, u);
  }

  state.playerAi.unitsBuilt = 3;   // lands on the every-3rd-unit counter-pick cadence (COUNTER_EVERY)
  state.ai.unitsBuilt = 3;

  const playerMix = pickNextUnitType(state, state.playerAi.archetype, "player");
  const aiMix = pickNextUnitType(state, state.ai.archetype, "ai");
  assert.notEqual(playerMix, "lancer", "the player-controller must not counter-pick an ai army its own fog hasn't seen");
  assert.notEqual(aiMix, "lancer", "the ai controller must not counter-pick a player army its own fog hasn't seen");

  // Reveal each side's own fog — a scout of its own parked right on the massed army — and confirm
  // the SAME call now does counter-pick: the mechanism sanity check, same spirit as the
  // threat-detection test above.
  const sp1 = towardCenter(state, playerCC), sp2 = towardCenter(state, aiCC);
  const playerScout = makeUnit("worker", "player", sp1.x, sp1.y);
  state.units.set(playerScout.id, playerScout);
  const aiScout = makeUnit("worker", "ai", sp2.x, sp2.y);
  state.units.set(aiScout.id, aiScout);
  updateFog(state, state.fogs.player, "player");
  updateFog(state, state.fogs.ai, "ai");
  assert.equal(pickNextUnitType(state, state.playerAi.archetype, "player"), "lancer",
    "once genuinely seen, the player-controller DOES counter-pick the massed Bastion army");
  assert.equal(pickNextUnitType(state, state.ai.archetype, "ai"), "lancer",
    "once genuinely seen, the ai controller DOES counter-pick the massed Bastion army");
});

/* ============================================================
   4. DETERMINISM
   ============================================================ */

function runSelfPlayMatchTo(cfg, maxSeconds) {
  const state = createSelfPlayState(cfg);
  const result = runSelfPlayMatch(state, { maxSeconds });
  return { state, result };
}

test("two identical self-play runs, same seed, produce byte-identical results", () => {
  const cfg = {
    planetId: "vesper", seed: 77,
    ai: { strategy: "aggressive", difficulty: "hard" },
    playerAi: { strategy: "economic", difficulty: "easy" },
  };
  // Built AND run to completion one at a time (see the runPlainTo/runSelfPlayTo comment above) —
  // never interleaved, so the two runs' entity ids can't drift apart from each other for reasons
  // that have nothing to do with the sim itself.
  const { state: a, result: resultA } = runSelfPlayMatchTo(cfg, 900);
  const { state: b, result: resultB } = runSelfPlayMatchTo(cfg, 900);

  assert.equal(fingerprint(a), fingerprint(b), "identical self-play config + seed must replay identically");
  assert.deepEqual(resultA, resultB);
  assert.ok(a.tick > 100, "sanity: the run actually progressed");
});

test("two DIFFERENT seeds produce different self-play results (the fingerprint isn't trivially constant)", () => {
  const cfg = seed => ({ planetId: "ferros", seed });
  const { state: a } = runSelfPlayMatchTo(cfg(1), 60);
  const { state: b } = runSelfPlayMatchTo(cfg(2), 60);
  assert.notEqual(fingerprint(a), fingerprint(b), "two different seeds must not coincidentally fingerprint identically");
});

test("the self-play think ordering stays bounded to one cycle and one direction (T2 characterisation)", () => {
  // NOT an assertion that the ordering is fair — it isn't, and tools/selfplay.js now says so
  // plainly. This pins the BOUND: the "player" controller is driven before tick()'s own runAI for
  // "ai", so within a single frame the ai seat may read what the player seat just did — but never
  // the reverse, and never across more than that one frame. If a future change widens the window
  // (a second player-side pass, or state mutated between the two), this goes red.
  const state = createSelfPlayState({ planetId: "korrath", seed: 5150 });
  assert.ok(state.playerAi, "fixture sanity: a second controller exists");

  // Both controllers share THINK_INTERVAL and start together, so they think on the same frames.
  assert.equal(state.ai.think, state.playerAi.think,
    "the two think countdowns start in lockstep — that is WHY the ordering matters");

  const seen = [];
  for (let i = 0; i < 40; i++) {
    const before = state.buildings.size;
    tickSelfPlay(state, 0.1);
    seen.push(state.buildings.size - before);
  }
  assert.ok(seen.every(d => Number.isFinite(d)), "the loop actually ran");
  // The one-frame bound expressed structurally: tickSelfPlay makes exactly ONE player-side think
  // call per frame, ahead of exactly one ai-side call inside tick().
  const src = readFileSync(new URL("../tools/selfplay.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function tickSelfPlay"), src.indexOf("\n}", src.indexOf("export function tickSelfPlay")));
  assert.equal((body.match(/runAI\(/g) || []).length, 1,
    "exactly one explicit runAI call in tickSelfPlay — a second would widen the information edge");
});
