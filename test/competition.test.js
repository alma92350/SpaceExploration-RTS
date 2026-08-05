/* ============================================================
   Guards for competition.js's PURE exports only — job construction, per-match seed derivation,
   worker-row -> display-table shaping, and Elo folding. No DOM, no real Worker: the same
   discipline test/duelCore.test.js and test/elo.test.js already hold themselves to for their own
   pure modules (docs/competitions-and-elo.md Phase 1). competition.js's DOM-rendering half (the
   actual Quick Duel screen) is exercised by this stage's live browser verification instead — see
   CONTRIBUTING.md's C10 note on why the two halves are split in the first place.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJob, matchCount, matchSeedFor, shapeResultsTable, eloFromRows } from "../competition.js";
import { duelSeed } from "../tools/duelCore.js";
import { INITIAL_RATING } from "../elo.js";

/* ---------- buildJob: deterministic job construction from a fixed entrant config ---------- */

const fixedCfg = () => ({
  entrantA: { name: "Alpha", strategy: "aggressive" },
  entrantB: { name: "Beta", strategy: "economic" },
  difficulty: "hard",
  worlds: ["ferros", "korrath"],
  seeds: 3,
  seedBase: 42,
});

test("buildJob is deterministic: the same fixed entrant config produces a byte-identical job", () => {
  const a = buildJob(fixedCfg());
  const b = buildJob(fixedCfg());
  assert.deepEqual(a, b);
});

test("buildJob produces exactly the job message shape competitionWorker.js expects", () => {
  const job = buildJob(fixedCfg());
  assert.deepEqual(job, {
    entrantA: { name: "Alpha", strategy: "aggressive" },
    entrantB: { name: "Beta", strategy: "economic" },
    difficulty: "hard",
    worlds: ["ferros", "korrath"],
    seeds: 3,
    seedBase: 42,
  });
});

test("buildJob carries matchTimeLimit through only when given (optional field)", () => {
  assert.equal("matchTimeLimit" in buildJob(fixedCfg()), false);
  assert.equal(buildJob({ ...fixedCfg(), matchTimeLimit: 900 }).matchTimeLimit, 900);
});

test("buildJob trims entrant names and rejects an empty or blank one", () => {
  assert.equal(buildJob({ ...fixedCfg(), entrantA: { name: "  Alpha  ", strategy: "default" } }).entrantA.name, "Alpha");
  assert.throws(() => buildJob({ ...fixedCfg(), entrantA: { name: "", strategy: "default" } }), /name/i);
  assert.throws(() => buildJob({ ...fixedCfg(), entrantB: { name: "   ", strategy: "default" } }), /name/i);
  assert.throws(() => buildJob({ ...fixedCfg(), entrantA: null }), /name/i);
});

test("buildJob rejects identical entrant names -- they'd collide into one elo.js RatingsTable entry", () => {
  assert.throws(
    () => buildJob({ ...fixedCfg(), entrantA: { name: "Bob", strategy: "default" }, entrantB: { name: "Bob", strategy: "aggressive" } }),
    /same|different|distinct/i,
  );
  // Compared post-trim, same as the existing blank-name check -- "Bob" and " Bob " are one collision,
  // not two distinct entrants that merely LOOK different in the raw input.
  assert.throws(
    () => buildJob({ ...fixedCfg(), entrantA: { name: " Bob ", strategy: "default" }, entrantB: { name: "Bob", strategy: "aggressive" } }),
    /same|different|distinct/i,
  );
});

test("buildJob throws when no world is selected", () => {
  assert.throws(() => buildJob({ ...fixedCfg(), worlds: [] }), /world/i);
});

test("buildJob floors/clamps a non-integer or sub-1 seeds count to a valid positive integer", () => {
  assert.equal(buildJob({ ...fixedCfg(), seeds: 2.9 }).seeds, 2);
  assert.equal(buildJob({ ...fixedCfg(), seeds: 0 }).seeds, 1);
  assert.equal(buildJob({ ...fixedCfg(), seeds: -5 }).seeds, 1);
});

test('buildJob defaults a missing strategy to "default", the same fallback tools/ailab.js\'s own runDuel uses', () => {
  const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha" }, entrantB: { name: "Beta" } });
  assert.equal(job.entrantA.strategy, "default");
  assert.equal(job.entrantB.strategy, "default");
});

test("buildJob does not mutate the worlds array it was given", () => {
  const worlds = ["ferros", "korrath"];
  const job = buildJob({ ...fixedCfg(), worlds });
  job.worlds.push("vesper");
  assert.deepEqual(worlds, ["ferros", "korrath"], "buildJob must copy the worlds array, not alias it");
});

/* ---------- matchCount ---------- */

test("matchCount is worlds x seeds x 2 directions (side-swapped)", () => {
  const job = buildJob(fixedCfg());
  assert.equal(matchCount(job), 2 /* worlds */ * 3 /* seeds */ * 2 /* directions */);
});

/* ---------- matchSeedFor: per-match seed derivation reuses duelCore's own duelSeed ---------- */

test("matchSeedFor matches tools/duelCore.js's own duelSeed for identical inputs", () => {
  const job = buildJob(fixedCfg());
  for (const world of job.worlds) {
    for (let rep = 0; rep < job.seeds; rep++) {
      const expected = duelSeed(job.seedBase, world, job.difficulty, job.entrantA.name, job.entrantB.name, rep);
      assert.equal(matchSeedFor(job, world, rep), expected);
    }
  }
});

test("matchSeedFor genuinely varies with world and replicate, matching duelSeed's own sensitivity", () => {
  const job = buildJob(fixedCfg());
  assert.notEqual(matchSeedFor(job, "ferros", 0), matchSeedFor(job, "korrath", 0), "world must vary the seed");
  assert.notEqual(matchSeedFor(job, "ferros", 0), matchSeedFor(job, "ferros", 1), "replicate must vary the seed");
});

test("matchSeedFor is independent of entrant order, same as duelSeed's own name-sorting", () => {
  const jobAB = buildJob(fixedCfg());
  const jobBA = buildJob({ ...fixedCfg(), entrantA: { name: "Beta", strategy: "economic" }, entrantB: { name: "Alpha", strategy: "aggressive" } });
  assert.equal(matchSeedFor(jobAB, "ferros", 0), matchSeedFor(jobBA, "ferros", 0));
});

/* ---------- shapeResultsTable: worker-shaped {type:"done"} rows -> display table ---------- */

const fixedRows = () => [
  {
    world: "ferros", seed: 111, difficulty: "medium", swapAsym: false,
    aName: "Alpha", aStrategy: "aggressive", bName: "Beta", bStrategy: "economic",
    aDifficulty: "medium", bDifficulty: "medium", aApm: 65, bApm: 65, aMicro: false, bMicro: false,
    winner: "a", winReason: "elimination", time: 812.3, aScore: 40, bScore: 12, margin: 28,
    direction: "bAsAi",
  },
  {
    world: "ferros", seed: 111, difficulty: "medium", swapAsym: true,
    aName: "Alpha", aStrategy: "aggressive", bName: "Beta", bStrategy: "economic",
    aDifficulty: "medium", bDifficulty: "medium", aApm: 65, bApm: 65, aMicro: false, bMicro: false,
    winner: "draw", winReason: null, time: 2520, aScore: 20, bScore: 20, margin: 0,
    direction: "aAsAi",
  },
];

test("shapeResultsTable shapes worker rows into the expected display-table structure", () => {
  const shaped = shapeResultsTable(fixedRows());
  assert.deepEqual(shaped, [
    { world: "ferros", seed: 111, side: "Beta as AI", swap: false, winner: "Alpha", reason: "elimination", time: 812.3, aScore: 40, bScore: 12, margin: 28 },
    { world: "ferros", seed: 111, side: "Alpha as AI", swap: true, winner: "Draw", reason: "-", time: 2520, aScore: 20, bScore: 20, margin: 0 },
  ]);
});

test("shapeResultsTable's winner column names the losing side's name when B wins", () => {
  const rows = [{ ...fixedRows()[0], winner: "b" }];
  assert.equal(shapeResultsTable(rows)[0].winner, "Beta");
});

test("shapeResultsTable does not mutate its input rows", () => {
  const rows = fixedRows();
  const untouched = JSON.stringify(rows);
  shapeResultsTable(rows);
  assert.equal(JSON.stringify(rows), untouched);
});

/* ---------- eloFromRows: feeds worker rows through elo.js's applySeries, in received order ---------- */

test("eloFromRows starts both entrants at INITIAL_RATING and moves them by the match results", () => {
  const ratings = eloFromRows(fixedRows());
  assert.ok(ratings.Alpha, "the winner must appear in the returned ratings table");
  assert.ok(ratings.Beta, "the loser must appear in the returned ratings table");
  assert.equal(ratings.Alpha.games, 2);
  assert.equal(ratings.Beta.games, 2);
  assert.notEqual(ratings.Alpha.rating, INITIAL_RATING, "a match was won -- the rating must have moved");
  assert.notEqual(ratings.Beta.rating, INITIAL_RATING);
});

test("eloFromRows is order-sensitive (D6): reversing the rows settles on a different table", () => {
  const forward = eloFromRows(fixedRows());
  const reversed = eloFromRows([...fixedRows()].reverse());
  assert.notDeepEqual(forward, reversed,
    "Elo is order-dependent -- the same rows in a different order must not settle on the same table");
});

test("eloFromRows is reproducible: the same rows replayed twice give byte-identical ratings", () => {
  assert.deepEqual(eloFromRows(fixedRows()), eloFromRows(fixedRows()));
});
