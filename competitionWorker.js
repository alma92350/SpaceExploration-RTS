/* ============================================================
   COMPETITION WORKER — the batch simulator behind the in-game Quick Duel and Tournament screens
   (docs/competitions-and-elo.md Phase 1, D5: "AI matches batch-simulate in a module Web Worker").
   Runs off the main thread so a multi-match duel doesn't freeze the tab; posts progress after
   EVERY match so competition.js can show a live "X of Y" bar and a Cancel that actually cancels —
   Worker#terminate() from the main thread kills this thread outright, so this file needs no
   cooperative cancellation of its own; it can just run its loop straight through. That holds for a
   whole TOURNAMENT too (Phase 3, below): it's one synchronous run on this thread, so terminating
   the Worker mid-round leaves nothing running and nothing half-written — the ledger is only ever
   written by competition.js, from the "done" message, which a terminated Worker never sends.

   TWO JOB KINDS, dispatched at the bottom of this file:
     • the original single-duel job (no `kind` field) — runCompetitionJob, UNCHANGED by Phase 3;
     • `{ kind: "tournament", format, field, … }` — runTournamentJob, which builds its "run one
       pairing" function out of runCompetitionJob itself (so a tournament pairing is byte-for-byte
       the same side-swapped, difficulty-pinned work a Quick Duel already does) and hands it to
       pairing.js's schedules as their injected `runPair`.

   Imports ONLY tools/duelCore.js and pairing.js (plus whatever THEY need — engine/aiDifficulty.js,
   engine/rng.js, tools/selfplay.js's pure core, engine/victory.js's playerScore) — never
   tools/ailab.js, whose ~1600 lines of CLI/printing/search/leaderboard code exist for a Node bench,
   not a browser bundle. That means runDuel/runSwappedDuel/flipDuelResult (ailab.js-only, and
   unexported even there) aren't available here: the side-swapped world x seed loop below is a
   small, FRESH re-implementation of runSwappedDuel's own SHAPE (mirrored deliberately — see its header comment
   in tools/ailab.js), built only from duelCore's exported primitives (pinnedDuelDials/duelSeed/
   runDuelMatch) — never reimplementing what THOSE already do (the dial-pinning, the seed hash, or
   the match runner itself).

   FAIRNESS: difficulty is the ONE dial pinnedDuelDials resolves for BOTH sides of every match —
   never two separate difficulties for A and B (see tools/duelCore.js's own header and
   tools/ailab.js's runDuel FAIRNESS paragraph for why pinning matters). Every world x seed
   replicate runs BOTH ways — entrantA as owner "player"/entrantB as owner "ai", then the reverse,
   relabelled back onto A/B by flipRow below (a local copy of ailab.js's own private row-flip,
   since neither ailab.js nor duelCore.js exports it) — so neither entrant sits in a structurally
   different seat for the whole duel. swapAsym alternates by replicate parity, exactly like
   tools/ailab.js's runDuel already does for the CLI.

   Loaded from competition.js as `new Worker(new URL("./competitionWorker.js", import.meta.url),
   { type: "module" })` — a construction the static import-graph walker in
   test/static-integrity.test.js cannot see (its regex only recognises an `import ... from`
   statement, a dynamic `import()` call, or a bare side-effect import statement — none of which
   this Worker construction is), so this file is named in that test's own EXEMPT set with a
   comment explaining why, rather than tripping its "orphan" check.

   Message-handler wiring is guarded the way dom.js guards `document`/`window`: under plain Node
   (no `self`, or a `self` with no `postMessage`) the wiring below is simply skipped, so
   test/static-integrity.test.js's "every shipped UI module imports cleanly under Node with no
   DOM" check (which bare-imports this file in a child process) passes. The actual job-running
   logic (runCompetitionJob, and runTournamentJob below it) stays a plain, DOM/self-free export any
   test can call directly with no real Worker involved — mirrors observer.js's own split of pure
   data (observerStats) from its DOM-facing consumer (observerPanel.js).
   ============================================================ */

"use strict";

import { pinnedDuelDials, duelSeed, runDuelMatch } from "./tools/duelCore.js";
import {
  roundRobinPairs, buildSwissBracket, buildKnockoutBracket,
  swissRoundCount, tournamentRoundPlan, tallyStandings,
} from "./pairing.js";

// Relabel a runDuelMatch() row from B's perspective to A's — "B played owner player, A played
// owner ai" becomes "what A did, reported as if A were the row's own aName". A plain copy of
// tools/ailab.js's own PRIVATE flipDuelResult inner helper (unexported there, and ailab.js itself
// is off-limits here — see the header above), kept byte-for-byte equivalent so a duel run through
// this worker tallies exactly the way tools/ailab.js's runSwappedDuel already does.
function flipRow(r) {
  return {
    ...r,
    aName: r.bName, bName: r.aName,
    aStrategy: r.bStrategy, bStrategy: r.aStrategy,
    aDifficulty: r.bDifficulty, bDifficulty: r.aDifficulty,
    aApm: r.bApm, bApm: r.aApm, aMicro: r.bMicro, bMicro: r.aMicro,
    winner: r.winner === "a" ? "b" : r.winner === "b" ? "a" : "draw",
    aScore: r.bScore, bScore: r.aScore, margin: -r.margin,
  };
}

/**
 * Run one Quick Duel job to completion: every world x seed replicate, both directions
 * (side-swapped — see the header FAIRNESS paragraph), reporting each finished match through
 * `onProgress` as it resolves. Pure/DOM-free/self-free — directly callable from Node (or a test)
 * with no Worker involved at all (see the header's observer.js comparison).
 * @param {{ entrantA: {name: string, strategy?: string, archetype?: string|null},
 *   entrantB: {name: string, strategy?: string, archetype?: string|null},
 *   difficulty: string, worlds: string[], seeds: number, seedBase: number, matchTimeLimit?: number }} job
 * @param {(p: {completed: number, total: number, row: object}) => void} [onProgress]
 * @returns {{ rows: object[], aWins: number, bWins: number, draws: number }}
 */
export function runCompetitionJob(job, onProgress) {
  const { entrantA, entrantB, difficulty, worlds, seeds, seedBase, matchTimeLimit } = job || {};
  if (!entrantA || !entrantA.name) throw new Error('entrantA needs a "name"');
  if (!entrantB || !entrantB.name) throw new Error('entrantB needs a "name"');
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("job needs at least one world");
  if (!(seeds > 0)) throw new Error("job needs at least one seed per world");

  const dials = pinnedDuelDials(difficulty);   // read ONCE — the whole fairness point, see header
  // runDuelMatch wants minutes; the job's own matchTimeLimit is SECONDS, matching setup.js's own
  // setup.matchTimeLimit convention (engine/victory.js's DEFAULT_MATCH_TIME_LIMIT is in seconds).
  const minutes = matchTimeLimit ? matchTimeLimit / 60 : undefined;
  // ailab.js's own runDuel defaults an unset strategy the same way, at the same layer (the match
  // runner itself never defaults it — see tools/duelCore.js's runDuelMatch, which echoes back
  // whatever aStrategy/bStrategy it's given verbatim).
  const aStrategy = entrantA.strategy || "default";
  const bStrategy = entrantB.strategy || "default";
  // docs/competitions-and-elo.md D3: each entrant's own optional per-entrant doctrine, defaulting
  // to null (no override — runDuelMatch/createSelfPlayState/createAiController all read a falsy
  // archetype as "use the world's own temperament", exactly as before this option existed).
  const aArchetype = entrantA.archetype || null;
  const bArchetype = entrantB.archetype || null;
  const total = worlds.length * seeds * 2;     // both directions, side-swapped
  const rows = [];
  let completed = 0;
  const post = row => {
    rows.push(row);
    completed++;
    if (onProgress) onProgress({ completed, total, row });
  };

  for (const world of worlds) {
    for (let rep = 0; rep < seeds; rep++) {
      // Sorted into the hash (tools/duelCore.js's own duelSeed), so both directions below draw
      // the SAME map for this (world, rep) — only the seat assignment differs between them.
      const seed = duelSeed(seedBase, world, difficulty, entrantA.name, entrantB.name, rep);
      const swapAsym = rep % 2 === 1;   // replicate parity — same rule tools/ailab.js's runDuel uses

      // Direction 1 ("bAsAi"): entrantA owns "player", entrantB owns "ai" — runDuelMatch's own
      // fixed mapping, no relabelling needed. Archetype rides along the SAME seat its own
      // strategy does (aArchetype with aStrategy, bArchetype with bStrategy) — an entrant's
      // doctrine follows the entrant, not the seat, exactly like strategy already does here.
      post({
        ...runDuelMatch({
          world, seed, dials, minutes, swapAsym,
          aName: entrantA.name, aStrategy, aArchetype, bName: entrantB.name, bStrategy, bArchetype,
        }),
        direction: "bAsAi",
      });

      // Direction 2 ("aAsAi"): entrantB owns "player", entrantA owns "ai" — then flipped back so
      // the row still reads aName=entrantA/bName=entrantB, exactly like runSwappedDuel's aAsAi.
      // Archetype swaps seats right alongside strategy, for the same reason.
      post({
        ...flipRow(runDuelMatch({
          world, seed, dials, minutes, swapAsym,
          aName: entrantB.name, aStrategy: bStrategy, aArchetype: bArchetype,
          bName: entrantA.name, bStrategy: aStrategy, bArchetype: aArchetype,
        })),
        direction: "aAsAi",
      });
    }
  }

  const aWins = rows.filter(r => r.winner === "a").length;
  const bWins = rows.filter(r => r.winner === "b").length;
  const draws = rows.filter(r => r.winner === "draw").length;
  return { rows, aWins, bWins, draws };
}

/* ============================================================
   TOURNAMENTS (docs/competitions-and-elo.md Phase 3) — round-robin, Swiss and knockout, scheduled
   by pairing.js and run one pairing at a time through runCompetitionJob above.

   THE ONE IDEA HERE: a tournament pairing is exactly a Quick Duel. runPairing below is a thin
   wrapper around runCompetitionJob — the same side-swap, the same replicate-parity swapAsym, the
   same pinned-difficulty fairness, the same row shape the ledger already stores — aggregated into
   the `{ aWins, bWins, draws, avgMargin }` shape pairing.js's schedules read off a `runPair`. So
   there is ONE per-pairing implementation in this file, already covered by this file's own tests
   and Phase 1/2's live verification, rather than a second one that could drift from it.

   PROGRESS, at real granularity. A 15-pairing round-robin at 4 worlds x 2 seeds is 240 matches and
   several minutes; one opaque spinner over that is not acceptable (the Phase 3 brief's own point
   about telling the player what a long run is doing). Two message kinds go out:
     • `{ type: "progress" }` after every MATCH, carrying the round/pairing coordinates that
       tournamentRoundPlan derives from a flat pairing counter (neither buildSwissBracket nor
       buildKnockoutBracket tells its runPair where in the schedule it is — see that function's own
       comment) plus the global match counter;
     • `{ type: "pairing" }` after every PAIRING, a summary (no rows) so the screen can fold the
       result into live standings immediately.

   THE DONE MESSAGE carries the format's own full result — standings for round-robin/Swiss, the
   whole bracket tree for knockout — PLUS `pairings`: every pairing's rows in true completion order
   (round 1 before round 2, in-round order preserved). That list is what competition.js folds into
   the ledger, one recordCompetition call per pairing, in that order — D6's canonical-ordering rule
   applied to a multi-pairing tournament exactly as Quick Duel already applies it to one duel. The
   rows travel ONCE: they ride `pairings`, and every other structure in the message (the bracket
   tree, the Swiss rounds log) carries the aggregate only.
   ============================================================ */

const TOURNAMENT_FORMATS = new Set(["round-robin", "swiss", "knockout"]);

// Drop the (large) per-match rows off a pairing result, keeping the aggregate — see the DONE
// MESSAGE paragraph above on why the rows only ever travel once.
const withoutRows = ({ rows, ...rest }) => rest;

// Validate the field ONCE, before anything is simulated: a nameless entrant, or two entrants
// sharing a name, is the same identity hazard elo.js's RatingsTable and buildKnockoutBracket both
// already reject — catching it here means a 200-match tournament can't get halfway before failing.
function validateField(field) {
  const entrants = Array.isArray(field) ? field : [];
  if (entrants.length < 2) throw new Error(`a tournament needs at least 2 entrants, got ${entrants.length}`);
  const seen = new Set();
  for (const e of entrants) {
    if (!e || typeof e.name !== "string" || !e.name.trim()) throw new Error('every tournament entrant needs a "name"');
    if (seen.has(e.name)) throw new Error(`duplicate entrant name "${e.name}" — a tournament is scored by name`);
    seen.add(e.name);
  }
  return entrants;
}

/**
 * Run one tournament job to completion. Pure/DOM-free/self-free, exactly like runCompetitionJob
 * above and for the same reason (directly callable from Node or a test with no Worker at all).
 * @param {{ kind?: string, format: "round-robin"|"swiss"|"knockout",
 *   field: {name: string, strategy?: string, archetype?: string|null}[],
 *   difficulty: string, worlds: string[], seeds: number, seedBase?: number,
 *   rounds?: number, matchTimeLimit?: number }} job
 * @param {(msg: object) => void} [onProgress]   receives every "progress"/"pairing" message.
 * @returns {object} the "done" payload (minus its `type`) — see the DONE MESSAGE comment above.
 */
export function runTournamentJob(job, onProgress) {
  const { format, field, difficulty, worlds, seeds, seedBase, rounds, matchTimeLimit } = job || {};
  if (!TOURNAMENT_FORMATS.has(format)) throw new Error(`unknown tournament format "${format}"`);
  const entrants = validateField(field);
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("a tournament job needs at least one world");
  if (!(seeds > 0)) throw new Error("a tournament job needs at least one seed per world");

  const names = entrants.map(e => e.name);
  const roundCount = format === "swiss"
    ? (rounds > 0 ? Math.floor(rounds) : swissRoundCount(entrants.length))
    : undefined;
  const plan = tournamentRoundPlan(format, entrants.length, roundCount);
  const matchesPerPairing = worlds.length * seeds * 2;   // both side-swapped directions, same as matchCount
  const totalPairings = plan.reduce((sum, r) => sum + r.pairings, 0);
  const totalMatches = totalPairings * matchesPerPairing;

  /** @type {object[]} every finished pairing, WITH its rows, in true completion order (D6). */
  const pairings = [];
  let completedMatches = 0;
  const post = msg => { if (onProgress) onProgress(msg); };

  // Where the k-th pairing of the whole tournament sits in the schedule. Derived from the plan
  // rather than from the schedule functions themselves, which don't report it — see this section's
  // PROGRESS paragraph.
  const coordsFor = index => {
    let seen = 0;
    for (const r of plan) {
      if (index < seen + r.pairings)
        return { round: r.round, roundTotal: plan.length, pairing: index - seen + 1, pairingTotal: r.pairings };
      seen += r.pairings;
    }
    // Unreachable while the plan prices the whole schedule (test/pairing.test.js pins that for
    // every format and every field size) — but a progress readout must never be the thing that
    // throws mid-tournament, so pin to the last round instead.
    const last = plan[plan.length - 1];
    return { round: last.round, roundTotal: plan.length, pairing: last.pairings, pairingTotal: last.pairings };
  };

  // The injected `runPair` every pairing.js schedule takes: ONE Quick Duel's worth of work.
  const runPairing = (a, b, opts) => {
    const coords = coordsFor(pairings.length);
    const { rows, aWins, bWins, draws } = runCompetitionJob({
      entrantA: a, entrantB: b, difficulty, worlds, seeds,
      // buildSwissBracket/buildKnockoutBracket fold the round into the seed base they forward
      // (D6 — a replayed tournament is byte-identical); round-robin has no rounds and passes the
      // job's own base straight through.
      seedBase: (opts && opts.seedBase != null) ? opts.seedBase : seedBase,
      matchTimeLimit,
    }, () => {
      completedMatches++;
      post({
        type: "progress", kind: "tournament", format, ...coords,
        completed: completedMatches, total: totalMatches, aName: a.name, bName: b.name,
      });
    });
    const avgMargin = rows.length ? rows.reduce((sum, r) => sum + r.margin, 0) / rows.length : 0;
    const result = { round: coords.round, pairing: coords.pairing, aName: a.name, bName: b.name, aWins, bWins, draws, avgMargin, rows };
    pairings.push(result);
    post({ type: "pairing", kind: "tournament", format, ...coords, ...withoutRows(result), completed: completedMatches, total: totalMatches });
    return result;
  };

  const done = { kind: "tournament", format, field: names, difficulty, worlds: [...worlds], seeds, totalMatches };

  if (format === "round-robin") {
    // roundRobinPairs IS the schedule (every unordered pair once, in the caller's own order); the
    // loop around it is all a round-robin needs — no rounds, no byes, no rematch avoidance.
    for (const [a, b] of roundRobinPairs(entrants)) runPairing(a, b, { seedBase });
    done.standings = tallyStandings(names, pairings);
  } else if (format === "swiss") {
    const bracket = buildSwissBracket(entrants, roundCount, { worlds, seeds, seedBase }, runPairing);
    done.rounds = bracket.rounds;
    done.byeMatchCount = bracket.byeMatchCount;
    done.standings = bracket.standings;   // pairing.js's own ranked table, byes included
    done.roundsLog = bracket.roundsLog.map(r => ({ ...r, matches: r.matches.map(withoutRows) }));
    done.byeNames = bracket.roundsLog.map(r => r.byeName).filter(Boolean);
  } else {
    // The field arrives ALREADY SEEDED (strongest first) — competition.js seeds it off the
    // bracket's own ladder before posting the job, exactly as pairing.js's header requires
    // ("this function consumes an order, it does not invent one").
    const bracket = buildKnockoutBracket(entrants, { seedBase }, runPairing);
    done.bracket = {
      entrants: bracket.entrants,
      matchCount: bracket.matchCount,
      champion: bracket.champion,
      rounds: bracket.rounds.map(r => ({
        round: r.round,
        matches: r.matches.map(m => ({ ...m, result: m.result ? withoutRows(m.result) : null })),
      })),
    };
    done.champion = bracket.champion.name;
  }

  done.pairings = pairings;
  done.completedMatches = completedMatches;
  return done;
}

// Message-handler wiring: guarded the dom.js way (see header) so this file bare-imports cleanly
// under Node. Checking `self.postMessage` (not just `self`) is the part that actually matters —
// some Node builds define a bare `self` global with none of the real Worker surface, and it's
// postMessage's own presence that proves this is a genuine Worker context.
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async e => {
    try {
      // A tournament job says so; ANY other job is the original single-duel kind, handled exactly
      // as it always was (Quick Duel's own message contract is untouched by Phase 3).
      if (e.data && e.data.kind === "tournament") {
        const result = runTournamentJob(e.data, msg => self.postMessage(msg));
        self.postMessage({ type: "done", ...result });
      } else {
        const result = runCompetitionJob(e.data, p => self.postMessage({ type: "progress", ...p }));
        self.postMessage({ type: "done", ...result });
      }
    } catch (err) {
      self.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
  };
}
