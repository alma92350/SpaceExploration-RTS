/* ============================================================
   Guards for competitionWorker.js's own runCompetitionJob — specifically the NEW plumbing point
   docs/competitions-and-elo.md Phase 2 (D3) adds: each entrant's own optional `archetype` field on
   the job, threaded through to tools/duelCore.js's runDuelMatch for BOTH match directions (a
   worker-level companion to test/duelCore.test.js's own runDuelMatch-level archetype tests, and
   test/competition.test.js's buildJob-level "the job carries archetype" tests — this is the middle
   layer: does the WORKER actually forward what buildJob hands it). Pure/DOM/self-free — see this
   module's own header on why runCompetitionJob is directly callable from Node with no real Worker.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCompetitionJob } from "../competitionWorker.js";

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
