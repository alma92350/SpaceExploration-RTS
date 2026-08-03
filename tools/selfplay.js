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

   Usage
     node tools/selfplay.js run [--world ferros] [--seed 1] [--minutes 40]
                                [--ai-strategy default] [--ai-difficulty medium]
                                [--player-strategy default] [--player-difficulty medium]

   Deterministic by construction: the map seeds from mulberry32, and the sim
   itself has zero Math.random/Date.now (engine/ is purity-guarded). Two runs
   of the same command produce byte-identical results — see fingerprint()
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
 * "player"). `ai`/`playerAi` options are each `{ apm, micro, strategy, difficulty }` — same shape
 * setup.js's own dials use, all optional (defaults mirror createGameState's own: unthrottled APM,
 * no micro, "default" strategy, "medium" difficulty).
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
  });
  // The second controller for owner "player" — same factory state.js uses to build state.ai
  // itself, so the two can never structurally drift. Assigning it directly (rather than any
  // setup.js/boot.js flow, which stay untouched) is the ONLY way self-play ever gets activated.
  state.playerAi = createAiController(planetId, {
    apm: playerAi.apm, micro: playerAi.micro, strategy: playerAi.strategy, difficulty: playerAi.difficulty,
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
 * Advance a self-play state by one fixed step. Both controllers think on the IDENTICAL pre-tick
 * snapshot — owner "player" is driven explicitly, right here, BEFORE tick(state, dt) runs its own
 * hardcoded runAI(state, dt) call for owner "ai" (engine/sim.js) — so neither side ever gets to
 * react to information the other's think cycle already changed this frame (a hidden one-tick
 * information edge would itself be a fairness bug, the same class constraint 2 exists to prevent).
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

/* ============================================================
   CLI
   ============================================================ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
    else out._.push(a);
  }
  return out;
}

function runCmd(args) {
  const state = createSelfPlayState({
    planetId: args.world || "ferros",
    seed: args.seed !== undefined ? Number(args.seed) : 1,
    matchTimeLimit: args.minutes !== undefined ? Number(args.minutes) * 60 : undefined,
    ai: { strategy: args["ai-strategy"], difficulty: args["ai-difficulty"] },
    playerAi: { strategy: args["player-strategy"], difficulty: args["player-difficulty"] },
  });
  const result = runSelfPlayMatch(state);
  const unitsOf = o => [...state.units.values()].filter(u => u.owner === o).length;
  const buildingsOf = o => [...state.buildings.values()].filter(b => b.owner === o).length;
  console.log(`world=${state.planetId} seed=${state.seed}`);
  console.log(`ai:     strategy=${state.ai.strategy} difficulty=${state.ai.difficulty}`);
  console.log(`player: strategy=${state.playerAi.strategy} difficulty=${state.playerAi.difficulty}`);
  console.log(`--`);
  console.log(`over=${result.over} winner=${result.winner} reason=${result.winReason} `
    + `time=${result.time.toFixed(1)}s tick=${result.tick}`);
  console.log(`ai:     units=${unitsOf("ai")} buildings=${buildingsOf("ai")} `
    + `resources=${JSON.stringify(state.players.ai.resources)}`);
  console.log(`player: units=${unitsOf("player")} buildings=${buildingsOf("player")} `
    + `resources=${JSON.stringify(state.players.player.resources)}`);
}

const USAGE = `SELF-PLAY — drive BOTH sides of a skirmish with the real AI (Tier 1).

  node tools/selfplay.js run [--world ferros] [--seed 1] [--minutes 40]
                             [--ai-strategy default] [--ai-difficulty medium]
                             [--player-strategy default] [--player-difficulty medium]`;

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (cmd === "run") { runCmd(args); return; }
  console.log(USAGE);
}

// Only run the CLI when invoked directly, so a test can import the functions above.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main(process.argv.slice(2));
