/* ============================================================
   DUEL CORE — the fairness-critical "run one duel match" primitive, extracted out of
   tools/ailab.js (docs/competitions-and-elo.md Phase 1) so a browser Worker can import it in a
   later stage without pulling in ailab.js's ~1600 lines of CLI/printing/argv/search/leaderboard
   code. Everything below is pure: it reads engine/aiDifficulty.js's DIFFICULTY_OPTIONS table and
   drives tools/selfplay.js's createSelfPlayState/runSelfPlayMatch — both already DOM-free — and
   this file itself has no browser-global reference anywhere (test/duelCore.test.js pins that).

   tools/ailab.js re-imports these three names (pinnedDuelDials, duelSeed, and runDuelMatch under
   its own existing local name `duelRun`) so every one of its own call sites — runDuel,
   runRoundRobinSwapped, runSwissBracket, and (through those) runSwappedDuel/runDuelBrackets/the
   `search --tournament-against` integration/the duel+swiss CLI handlers — keeps working exactly
   as before, unmodified. runDuel's own header comment in tools/ailab.js is where the FAIRNESS
   argument for why difficulty/apm/micro must be pinned identical for both sides lives; the two
   comments below explain only what each function itself does.
   ============================================================ */

"use strict";

import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { hashStr } from "../engine/rng.js";
import { createSelfPlayState, runSelfPlayMatch } from "./selfplay.js";
import { playerScore } from "../engine/victory.js";

// difficulty -> the ONE dial object both sides read (apm/micro, derived from the same
// DIFFICULTY_OPTIONS row labWorld's own --apm real already reads for a single side) — see
// tools/ailab.js's DUEL header comment for the FAIRNESS argument this exists to satisfy. Exported
// so a test can read back exactly what a run should have used, rather than trusting the CLI flag
// was honoured.
/**
 * @param {string} difficulty
 * @returns {{ difficulty: string, apm: number|null, micro: boolean }}
 */
export function pinnedDuelDials(difficulty) {
  const opt = DIFFICULTY_OPTIONS.find(o => o.mult === difficulty) || DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  // Echo back opt.mult, NOT the raw input: apm/micro already fall back to medium's values when
  // `difficulty` doesn't match any DIFFICULTY_OPTIONS row, so the reported difficulty has to fall
  // back with them — otherwise a typo'd/unknown --difficulty would run medium's dials but LABEL
  // the result with the garbage string, misleading anyone reading a saved --json duel result about
  // which difficulty actually ran.
  return { difficulty: opt.mult, apm: opt.aiApm, micro: !!opt.aiMicro };
}

// Every duel match's seed is derived from (base seed, world, difficulty, BOTH candidate names,
// replicate) — reproducible on its own. The pair's names are SORTED into the hash, so
// duelSeed(base, w, d, a, b, rep) and duelSeed(base, w, d, b, a, rep) draw the identical map:
// runSwappedDuel (tools/ailab.js) exists to isolate seat asymmetry — its header says "a
// side-symmetry bug would show up as those two disagreeing" — and with an order-dependent seed the
// two halves would differ in seat AND map, so a disagreement would be confounded with ordinary
// seed variance and carry no information at all.
/**
 * @param {number} base
 * @param {string} world
 * @param {string} difficulty
 * @param {string} aName
 * @param {string} bName
 * @param {number} rep
 * @returns {number}
 */
export function duelSeed(base, world, difficulty, aName, bName, rep) {
  return hashStr(`${base}:duel:${world}:${difficulty}:${[aName, bName].sort().join("|")}:${rep}`);
}

// Run ONE match: candidate A as owner "player", candidate B as owner "ai", both spending from the
// SAME `dials` object (see pinnedDuelDials above / tools/ailab.js's FAIRNESS paragraph). `swapAsym`
// exchanges the map's own asym halves (engine/map.js) for THIS match only. Returns a plain result
// row — this exact shape is load-bearing: many functions in tools/ailab.js consume rows shaped
// exactly like this, so every field name here must stay byte-for-byte stable.
/**
 * @param {{ world: string, seed: number,
 *   dials: { difficulty: string, apm: number|null, micro: boolean },
 *   aName: string, aStrategy: string, bName: string, bStrategy: string,
 *   minutes?: number, swapAsym?: boolean }} cfg
 * @returns {{
 *   world: string, seed: number, difficulty: string, swapAsym: boolean,
 *   aName: string, aStrategy: string, bName: string, bStrategy: string,
 *   aDifficulty: string, bDifficulty: string,
 *   aApm: number|null, bApm: number|null, aMicro: boolean, bMicro: boolean,
 *   winner: "a"|"b"|"draw", winReason: string|null, time: number,
 *   aScore: number, bScore: number, margin: number,
 * }}
 */
export function runDuelMatch({ world, seed, dials, aName, aStrategy, bName, bStrategy, minutes, swapAsym }) {
  const state = createSelfPlayState({
    planetId: world, seed, swapAsym,
    matchTimeLimit: minutes ? minutes * 60 : undefined,
    ai: { ...dials, strategy: bStrategy },
    playerAi: { ...dials, strategy: aStrategy },
  });
  const result = runSelfPlayMatch(state, minutes ? { maxSeconds: minutes * 60 + 120 } : undefined);
  const aScore = playerScore(state, "player");
  const bScore = playerScore(state, "ai");
  const winner = !result.over ? "draw" : result.winner === "player" ? "a" : "b";
  return {
    world, seed, difficulty: dials.difficulty, swapAsym: !!swapAsym,
    aName, aStrategy, bName, bStrategy,
    // Read back off the actual controllers, not the input — the structural-fairness tests assert
    // on exactly these fields, so a bug that let the two dials diverge would show here.
    aDifficulty: state.playerAi.difficulty, bDifficulty: state.ai.difficulty,
    aApm: state.playerAi.apm, bApm: state.ai.apm, aMicro: state.playerAi.micro, bMicro: state.ai.micro,
    winner, winReason: result.winReason, time: +result.time.toFixed(1),
    aScore: +aScore.toFixed(1), bScore: +bScore.toFixed(1), margin: +(aScore - bScore).toFixed(1),
  };
}
