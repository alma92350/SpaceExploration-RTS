/* ============================================================
   COMPETITION WORKER — the batch simulator behind the in-game Quick Duel screen
   (docs/competitions-and-elo.md Phase 1, D5: "AI matches batch-simulate in a module Web Worker").
   Runs off the main thread so a multi-match duel doesn't freeze the tab; posts progress after
   EVERY match so competition.js can show a live "X of Y" bar and a Cancel that actually cancels —
   Worker#terminate() from the main thread kills this thread outright, so this file needs no
   cooperative cancellation of its own; it can just run its loop straight through.

   Imports ONLY tools/duelCore.js (plus whatever IT needs — engine/aiDifficulty.js, engine/rng.js,
   tools/selfplay.js's pure core, engine/victory.js's playerScore) — never tools/ailab.js, whose
   ~1600 lines of CLI/printing/search/leaderboard code exist for a Node bench, not a browser
   bundle. That means runDuel/runSwappedDuel/flipDuelResult (ailab.js-only, and unexported even
   there) aren't available here: the side-swapped world x seed loop below is a small, FRESH
   re-implementation of runSwappedDuel's own SHAPE (mirrored deliberately — see its header comment
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
   logic (runCompetitionJob) stays a plain, DOM/self-free export any test can call directly with no
   real Worker involved — mirrors observer.js's own split of pure data (observerStats) from its
   DOM-facing consumer (observerPanel.js).
   ============================================================ */

"use strict";

import { pinnedDuelDials, duelSeed, runDuelMatch } from "./tools/duelCore.js";

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
 * @param {{ entrantA: {name: string, strategy?: string}, entrantB: {name: string, strategy?: string},
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
      // fixed mapping, no relabelling needed.
      post({
        ...runDuelMatch({
          world, seed, dials, minutes, swapAsym,
          aName: entrantA.name, aStrategy, bName: entrantB.name, bStrategy,
        }),
        direction: "bAsAi",
      });

      // Direction 2 ("aAsAi"): entrantB owns "player", entrantA owns "ai" — then flipped back so
      // the row still reads aName=entrantA/bName=entrantB, exactly like runSwappedDuel's aAsAi.
      post({
        ...flipRow(runDuelMatch({
          world, seed, dials, minutes, swapAsym,
          aName: entrantB.name, aStrategy: bStrategy, bName: entrantA.name, bStrategy: aStrategy,
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

// Message-handler wiring: guarded the dom.js way (see header) so this file bare-imports cleanly
// under Node. Checking `self.postMessage` (not just `self`) is the part that actually matters —
// some Node builds define a bare `self` global with none of the real Worker surface, and it's
// postMessage's own presence that proves this is a genuine Worker context.
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = async e => {
    try {
      const result = runCompetitionJob(e.data, p => self.postMessage({ type: "progress", ...p }));
      self.postMessage({ type: "done", ...result });
    } catch (err) {
      self.postMessage({ type: "error", message: String((err && err.message) || err) });
    }
  };
}
