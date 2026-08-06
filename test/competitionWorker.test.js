/* ============================================================
   Guards for competitionWorker.js's own runCompetitionJob — specifically the NEW plumbing point
   docs/competitions-and-elo.md Phase 2 (D3) adds: each entrant's own optional `archetype` field on
   the job, threaded through to tools/duelCore.js's runDuelMatch for BOTH match directions (a
   worker-level companion to test/duelCore.test.js's own runDuelMatch-level archetype tests, and
   test/competition.test.js's buildJob-level "the job carries archetype" tests — this is the middle
   layer: does the WORKER actually forward what buildJob hands it). Pure/DOM/self-free — see this
   module's own header on why runCompetitionJob is directly callable from Node with no real Worker.

   The second half of this file covers Phase 3's TOURNAMENT job kind (runTournamentJob), added
   alongside the single-duel one rather than in place of it — the tests above are also what pins
   "Quick Duel's own job still behaves exactly as before".
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompetitionJob, runTournamentJob } from "../competitionWorker.js";

const baseJob = () => ({
  entrantA: { name: "A", strategy: "default" },
  entrantB: { name: "B", strategy: "default" },
  difficulty: "medium",
  worlds: ["ferros"],
  seeds: 1,
  seedBase: 42,
});

test("runCompetitionJob threads each entrant's own archetype through to the simulated matches", () => {
  const plain = runCompetitionJob(baseJob());
  const archetyped = runCompetitionJob({
    ...baseJob(),
    entrantA: { ...baseJob().entrantA, archetype: "rusher" },
    entrantB: { ...baseJob().entrantB, archetype: "technologist" },
  });
  assert.notEqual(JSON.stringify(plain.rows), JSON.stringify(archetyped.rows),
    "giving each entrant a distinct archetype must change the simulated matches -- proof the job's " +
    "archetype fields actually reach the created self-play states, not just accepted and ignored");
});

test("runCompetitionJob's rows keep their existing exact field set even when archetype is supplied -- archetype is an input dial, never an output field", () => {
  const job = {
    ...baseJob(),
    entrantA: { name: "A", strategy: "default", archetype: "rusher" },
    entrantB: { name: "B", strategy: "default", archetype: "economist" },
  };
  const { rows } = runCompetitionJob(job);
  const expectedFields = [
    "world", "seed", "difficulty", "swapAsym", "aName", "aStrategy", "bName", "bStrategy",
    "aDifficulty", "bDifficulty", "aApm", "bApm", "aMicro", "bMicro",
    "winner", "winReason", "time", "aScore", "bScore", "margin", "direction",
  ];
  assert.ok(rows.length > 0, "fixture sanity: the job actually produced rows");
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [...expectedFields].sort(),
      "a row's field set must not change at all when the job carries archetype -- competitionLedger.js stores rows verbatim");
  }
});

test("runCompetitionJob treats a missing/null archetype as byte-identical to the option not existing at all", () => {
  const a = runCompetitionJob(baseJob());
  const b = runCompetitionJob({
    ...baseJob(),
    entrantA: { ...baseJob().entrantA, archetype: null },
    entrantB: { ...baseJob().entrantB, archetype: undefined },
  });
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows));
});

test("runCompetitionJob applies each entrant's archetype on BOTH sides of the side-swap, not just its 'first' seat", () => {
  // Two seeds so both directions (bAsAi and aAsAi) actually run at least once each — matchCount's
  // own "worlds x seeds x 2 directions" guarantee (competition.js) already means every job runs
  // both; this just asserts on the two rows that exist per (world, rep) pair rather than trusting
  // it blindly.
  const job = {
    entrantA: { name: "A", strategy: "default", archetype: "rusher" },
    entrantB: { name: "B", strategy: "default", archetype: "rusher" },
    difficulty: "medium", worlds: ["ferros"], seeds: 1, seedBase: 7,
  };
  const { rows } = runCompetitionJob(job);
  assert.equal(rows.length, 2, "one world x one seed x two directions = two rows");
  const directions = rows.map(r => r.direction).sort();
  assert.deepEqual(directions, ["aAsAi", "bAsAi"], "fixture sanity: both side-swap directions ran");
});

/* ============================================================
   PHASE 3: the TOURNAMENT job kind (docs/competitions-and-elo.md Phase 3). Same discipline as
   above -- runTournamentJob is a plain export any test can call with no real Worker. The
   validation cases are free; the one end-to-end case deliberately runs the smallest tournament
   that still exercises a bye, two rounds and a champion (3 entrants x 1 world x 1 seed = 4 real
   matches), because the point of this file is that the WORKER's own plumbing works, and pairing.js's
   own schedule combinatorics are already proven on synthetic results in test/pairing.test.js.
   ============================================================ */


const baseTournament = () => ({
  kind: "tournament",
  format: "round-robin",
  field: [{ name: "A", strategy: "default" }, { name: "B", strategy: "default" }, { name: "C", strategy: "default" }],
  difficulty: "medium",
  worlds: ["ferros"],
  seeds: 1,
  seedBase: 42,
});

test("runTournamentJob rejects a job it can't schedule, before simulating anything", () => {
  assert.throws(() => runTournamentJob({ ...baseTournament(), format: "battle-royale" }), /format/i);
  assert.throws(() => runTournamentJob({ ...baseTournament(), field: [{ name: "Solo" }] }), /at least 2/i);
  assert.throws(() => runTournamentJob({ ...baseTournament(), field: [{ name: "A" }, { name: "A" }] }), /duplicate|same name/i);
  assert.throws(() => runTournamentJob({ ...baseTournament(), field: [{ name: "A" }, { name: "" }] }), /name/i);
  assert.throws(() => runTournamentJob({ ...baseTournament(), worlds: [] }), /world/i);
  assert.throws(() => runTournamentJob({ ...baseTournament(), seeds: 0 }), /seed/i);
});

test("runTournamentJob runs a knockout end to end: every pairing's rows, in completion order, plus one champion", () => {
  // 3 entrants -> nextPow2(3) - 3 = 1 first-round bye, 2 real pairings, 2 rounds, 4 matches total.
  const progress = [];
  const result = runTournamentJob(
    { ...baseTournament(), format: "knockout" },
    p => progress.push(p),
  );

  assert.equal(result.kind, "tournament");
  assert.equal(result.format, "knockout");
  assert.equal(result.bracket.champion.name, result.champion, "the done message names the champion the bracket actually produced");
  assert.equal(result.pairings.length, 2, "n-1 pairings for a 3-entrant knockout");
  assert.equal(result.totalMatches, 2 * 1 * 1 * 2, "pairings x worlds x seeds x 2 side-swapped directions");
  assert.equal(result.completedMatches, result.totalMatches);

  // Every pairing carries its own rows, in the order the worker really finished them -- this list
  // is exactly what competition.js folds into the ledger, one recordCompetition call per entry (D6).
  for (const p of result.pairings) {
    assert.equal(p.rows.length, 2, "one world x one seed x two directions");
    for (const row of p.rows) {
      assert.ok(row.aName === p.aName && row.bName === p.bName, "a pairing's rows must be labelled with that pairing's own entrants");
      assert.ok(["a", "b", "draw"].includes(row.winner));
    }
    assert.equal(p.aWins + p.bWins + p.draws, p.rows.length, "the aggregate must account for every match in the pairing");
  }
  assert.deepEqual(result.pairings.map(p => p.round), [1, 2], "round 1's pairing is folded in before round 2's");

  // The bracket travels back WITHOUT the rows (they ship once, in `pairings`), so the message stays
  // one copy of the match data rather than two.
  const slots = result.bracket.rounds.flatMap(r => r.matches);
  assert.equal(slots.filter(m => m.bye).length, 1, "a 3-entrant field gives the top seed a first-round bye");
  for (const m of slots.filter(m => !m.bye)) {
    assert.ok(m.result, "a played slot keeps its aggregate");
    assert.equal("rows" in m.result, false, "the bracket must not carry a second copy of the match rows");
  }
});

test("runTournamentJob posts real round/pairing progress, not one opaque tick", () => {
  const progress = [];
  runTournamentJob({ ...baseTournament(), format: "knockout" }, p => progress.push(p));

  const matchTicks = progress.filter(p => p.type === "progress");
  assert.equal(matchTicks.length, 4, "one progress message per finished MATCH, not per pairing");
  assert.deepEqual(matchTicks.map(p => p.completed), [1, 2, 3, 4], "the match counter climbs monotonically");
  for (const p of matchTicks) {
    assert.equal(p.total, 4);
    assert.equal(p.roundTotal, 2, "a 3-entrant knockout is two rounds");
    assert.ok(p.round >= 1 && p.round <= p.roundTotal, `round ${p.round} out of range`);
    assert.ok(p.pairing >= 1 && p.pairing <= p.pairingTotal, `pairing ${p.pairing} of ${p.pairingTotal} out of range`);
    assert.equal(typeof p.aName, "string");
    assert.equal(typeof p.bName, "string");
  }
  assert.deepEqual(matchTicks.map(p => p.round), [1, 1, 2, 2], "round 1's matches complete before round 2's");

  // A pairing-level message too, so the UI can fold a finished pairing into its live standings
  // without waiting for the whole tournament.
  const pairingTicks = progress.filter(p => p.type === "pairing");
  assert.equal(pairingTicks.length, 2);
  assert.deepEqual(pairingTicks.map(p => [p.round, p.pairing]), [[1, 1], [2, 1]]);
  for (const p of pairingTicks) {
    assert.equal(typeof p.aWins, "number");
    assert.equal(typeof p.bWins, "number");
    assert.equal(typeof p.draws, "number");
    assert.equal("rows" in p, false, "a pairing tick is a summary -- the rows ride the done message");
  }
});

test("runTournamentJob's Swiss round count defaults to pairing.js's own swissRoundCount, and honours an override", () => {
  // Schedule-only assertions: totalMatches is computed up front, before any match runs, so these
  // cost nothing. (The bad-format guard above already proved the validation runs first.)
  const three = runTournamentJob({ ...baseTournament(), format: "swiss", field: [{ name: "A" }, { name: "B" }], rounds: 1 });
  assert.equal(three.rounds, 1);
  assert.equal(three.pairings.length, 1, "1 round x floor(2/2) pairings");
  assert.equal(three.standings.length, 2, "a Swiss result carries its own ranked standings");
  assert.equal(three.totalMatches, 2);
});
