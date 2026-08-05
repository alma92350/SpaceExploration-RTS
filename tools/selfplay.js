/* ============================================================
   SELF-PLAY — Tier 1 of the AI roadmap: a headless bench that drives BOTH
   sides of a skirmish match with the real scripted AI (engine/ai.js runAI),
   each side independently configured (archetype comes from the planet, plus
   its own strategy/difficulty/APM/micro), fighting each other for real. This
   is the ONLY place true AI-vs-AI self-play is exercised — never wired into
   the shipped game (setup.js/boot.js/main.js are untouched) and skirmish-only
   (no Odyssey, no diplomacy, no galaxy — engine/victory.js's ordinary
   elimination/score-at-clock resolution, unmodified).

   FAIRNESS, the whole point of this tier: owner "ai" is driven by
   runAI(state, dt, "ai") — today's controller, reading state.fogs.ai and
   spending from state.ai's own action budget, completely unchanged. owner
   "player" is driven by a SECOND controller, state.playerAi (engine/
   state.js's createAiController), reading state.fogs.player and spending
   from state.playerAi's own budget — never state.fogAI, never state.ai's
   budget. Neither side is omniscient of the other, and neither can starve
   or double-spend the other's actions. See engine/aiCommon.js's
   controllerFor/otherOwner and the fairness test in test/ai-selfplay.test.js.

   This file is the pure core ONLY — createSelfPlayState, tickSelfPlay, runSelfPlayMatch,
   fingerprint, plus the DT they share. It has no Node-only or DOM-only global anywhere in it, so
   it can be imported from a browser main thread or a Worker, not just Node (docs/
   competitions-and-elo.md, Phase 0). The CLI entry point lives in tools/selfplay-cli.js, which
   imports these exports — run `node tools/selfplay-cli.js run [--world ferros] [--seed 1] …`.

   Deterministic by construction: the map seeds from mulberry32, and the sim
   itself has zero Math.random/Date.now (engine/ is purity-guarded). Two runs
   from the same seed produce byte-identical results — see fingerprint()
   below and test/ai-selfplay.test.js.
   ============================================================ */

"use strict";

import { createGameState, createAiController, seedDifficultyEdge } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import { mulberry32 } from "../engine/rng.js";
import { DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";

const DT = 0.1;   // the sim's fixed step, same as the game loop (engine/loop.js)

/* ============================================================
   THE SELF-PLAY MATCH
   ============================================================ */

/**
 * A skirmish state with BOTH owners driven by the real AI: state.ai (owner "ai", today's exact
 * shape/meaning, untouched) plus a second, independently-configured state.playerAi (owner
 * "player"). `ai`/`playerAi` options are each `{ apm, micro, strategy, difficulty, archetype }` —
 * same shape setup.js's own dials use, all optional (defaults mirror createGameState's own:
 * unthrottled APM, no micro, "default" strategy, "medium" difficulty, the world's own archetype).
 * `archetype` (docs/competitions-and-elo.md D3) is a STRING KEY into engine/aiArchetypes.js's
 * ARCHETYPES, resolved independently for each seat — so a Quick Duel entrant carries its own
 * doctrine instead of both seats sharing whatever temperament the world hands out.
 * @param {{ planetId?: string, seed?: number, sizeMult?: number, resourceMult?: number,
 *   swapAsym?: boolean, matchTimeLimit?: number, popCap?: number,
 *   ai?: object, playerAi?: object }} [opts]
 */
export function createSelfPlayState({
  planetId = "ferros", seed = 1, sizeMult, resourceMult, swapAsym, matchTimeLimit, popCap,
  ai = {}, playerAi = {},
} = {}) {
  const state = createGameState({
    planetId, seed, rng: mulberry32(seed), sizeMult, resourceMult, swapAsym, matchTimeLimit, popCap,
    aiApm: ai.apm, aiMicro: ai.micro, aiStrategy: ai.strategy, difficulty: ai.difficulty,
    aiArchetype: ai.archetype,
  });
  // The second controller for owner "player" — same factory state.js uses to build state.ai
  // itself, so the two can never structurally drift. Assigning it directly (rather than any
  // setup.js/boot.js flow, which stay untouched) is the ONLY way self-play ever gets activated.
  state.playerAi = createAiController(planetId, {
    apm: playerAi.apm, micro: playerAi.micro, strategy: playerAi.strategy, difficulty: playerAi.difficulty,
    archetype: playerAi.archetype,
  });
  // Hard difficulty's economic edge (engine/aiDifficulty.js economicEdge, engine/state.js
  // seedDifficultyEdge): createGameState already seeded owner "ai"'s own edge off ITS difficulty;
  // state.playerAi didn't exist yet at that point, so its edge has to be applied here, the instant
  // it's configured — otherwise a self-play "player" controller picked Hard would fight at a
  // permanent, un-researchable economic disadvantage against a Hard "ai" no matter what difficulty
  // IT was given, exactly the asymmetry FAIRNESS (this file's header) rules out everywhere else.
  seedDifficultyEdge(state, "player");
  return state;
}

/**
 * Advance a self-play state by one fixed step: owner "player" is driven explicitly here, then
 * tick(state, dt) runs its own hardcoded runAI(state, dt) for owner "ai" (engine/sim.js).
 *
 * ORDERING, STATED HONESTLY. This comment used to claim both controllers think on the IDENTICAL
 * pre-tick snapshot. They do not. runAI(…, "player") is not a read: issueBuild inserts into
 * state.buildings immediately, queueProduction mutates queues, payCost mutates resources. Both
 * controllers share THINK_INTERVAL and start their countdowns together, so the "ai" seat reads
 * state the "player" seat has already changed that frame. Measured over 400 player think-cycles in
 * a 10-sim-minute korrath match: orders differed on 13% of cycles, queues and resources on 6%, and
 * buildings on 1%.
 *
 * The channel that actually feeds decisions is `buildings` — chooseAttackTarget's seenBuildings
 * scan and counterToPlayerArmy's static-defense scan both walk state.buildings.values() — so a
 * turret the player controller founded microseconds earlier is answerable one think cycle (1.5 s)
 * sooner than the mirror case ever could be. Small, but FIXED IN DIRECTION: it always favours the
 * "ai" seat, every cycle, in every duel and Swiss match.
 *
 * Why it isn't simply fixed here: making the claim true means either a genuinely frozen pre-tick
 * read, or moving the "ai" call out of sim.js's hardcoded pipeline so the two can alternate. Both
 * restructure engine/sim.js's tick contract, which is a larger change than this seam. The bound is
 * pinned by a characterisation test in test/ai-selfplay.test.js instead, so the edge cannot grow
 * unnoticed while the real fix is scheduled (docs/code-improvement-tiers.md, Tier 3).
 * @param {State} state @param {number} [dt]
 */
export function tickSelfPlay(state, dt = DT) {
  runAI(state, dt, "player");   // the second controller — a no-op once state.over, same as tick() below
  tick(state, dt);              // ...then the ordinary per-tick pipeline, which drives owner "ai" itself
}

/**
 * Run a self-play match to resolution (elimination or the score-at-clock timeout, engine/
 * victory.js — unmodified) or until `maxSeconds` of sim time, whichever comes first. Returns a
 * small summary; the state itself is mutated in place (same convention engine/sim.js's tick has).
 * @param {State} state @param {{ maxSeconds?: number, dt?: number }} [opts]
 */
export function runSelfPlayMatch(state, { maxSeconds = DEFAULT_MATCH_TIME_LIMIT + 120, dt = DT } = {}) {
  while (!state.over && state.time < maxSeconds) tickSelfPlay(state, dt);
  return {
    over: state.over, winner: state.winner, winReason: state.winReason, time: state.time, tick: state.tick,
  };
}

/**
 * Serialize the deterministic, sim-owned facts relevant to a self-play match — entity positions/
 * hp/order, both economies, both controllers' bookkeeping, and how much fog each side has
 * revealed. Sorted by id so Map iteration order can't matter. Mirrors the pattern
 * test/determinism.test.js's own snapshot() and test/ailab.test.js's own fingerprint() already
 * use elsewhere in this codebase, extended with state.playerAi so a self-play run's SECOND
 * controller is covered by the same determinism guarantee the first already has.
 * @param {State} state
 */
export function fingerprint(state) {
  const units = [...state.units.values()]
    .map(u => `${u.id}|${u.type}|${u.owner}|${u.x}|${u.y}|${u.hp}|${u.order ? u.order.type : "-"}`)
    .sort();
  const builds = [...state.buildings.values()]
    .map(b => `${b.id}|${b.type}|${b.owner}|${b.hp}|${b.buildProgress}|${b.queue.length}`)
    .sort();
  const res = state.owners.map(o => JSON.stringify(state.players[o].resources)).join("|");
  const fogs = state.owners.map(o => state.fogs[o].explored.reduce((a, v) => a + v, 0)).join("|");
  const ai = JSON.stringify(state.ai);
  const playerAi = JSON.stringify(state.playerAi);
  return JSON.stringify({ units, builds, res, fogs, ai, playerAi, tick: state.tick, time: state.time, over: state.over, winner: state.winner });
}
