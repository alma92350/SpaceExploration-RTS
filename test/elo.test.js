/* ============================================================
   Guards for elo.js — the ONE rating implementation shared by the game and tools/ailab.js's CLI
   (docs/competitions-and-elo.md D1). Pure rating math over data the caller owns: no clock, no
   storage, no DOM. These tests pin the formulas (D7: plain Elo, K=40/20/10, no margin scaling) and
   the one property a competition actually needs to be testable at all — D6's canonical ordering,
   proven here as REPRODUCIBILITY (same rows, byte-identical result) and its flip side, ORDER
   MATTERS (the same matches in a different order settle on a different table), which is exactly
   why a reproducible competition needs one canonical order in the first place.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_RATING, expectedScore, kFactor, applyResult, applySeries } from "../elo.js";

/* ---------- expectedScore ---------- */

test("expectedScore(r, r) === 0.5 for any r (symmetry)", () => {
  for (const r of [0, 800, 1200, 1500, 2400, -300, 3000.5]) {
    assert.equal(expectedScore(r, r), 0.5, `equal ratings must split exactly 50/50 at r=${r}`);
  }
});

test("expectedScore(a, b) + expectedScore(b, a) === 1 (complementary)", () => {
  // Two floating-point-independent evaluations of the same formula (a fresh 10 ** (...) each
  // side) aren't guaranteed bit-exact — an epsilon is the honest way to state "these are the two
  // complementary outcomes of one pairing," not a claim that the sum is IEEE-754-exact.
  const pairs = [[1200, 1400], [1000, 2000], [2400, 1200], [1500, 1501], [800, 800], [100, 900], [1613, 1587]];
  for (const [a, b] of pairs) {
    const sum = expectedScore(a, b) + expectedScore(b, a);
    assert.ok(Math.abs(sum - 1) < 1e-9, `expectedScore(${a},${b}) + expectedScore(${b},${a}) = ${sum}, expected 1`);
  }
});

/* ---------- kFactor ---------- */

test("kFactor schedule: provisional (<10 games) beats the rating-based rule, then 20, then 10 above 2400", () => {
  assert.equal(kFactor(0, 1200), 40, "a brand-new player is provisional");
  assert.equal(kFactor(9, 1200), 40, "still provisional one game short of 10");
  assert.equal(kFactor(10, 1200), 20, "graduated at exactly 10 games, under 2400");
  assert.equal(kFactor(10, 2400), 10, "graduated AND at the top rating tier");
  assert.equal(kFactor(500, 2400), 10, "a long-established top-tier player stays at K=10");
  assert.equal(kFactor(3, 2400), 40,
    "provisional wins over the rating-based rule — a brand-new player is provisional even at a seeded high rating");
});

/* ---------- applyResult ---------- */

test("applyResult creates missing entrants at INITIAL_RATING with 0 games, rather than throwing", () => {
  const ratings = {};
  assert.doesNotThrow(() => applyResult(ratings, "Newcomer", "AlsoNew", 1));
  assert.ok(ratings.Newcomer, "the winner must be created, not left missing");
  assert.ok(ratings.AlsoNew, "the loser must be created, not left missing");
  assert.equal(ratings.Newcomer.games, 1, "the match that just ran must be counted");
  assert.equal(ratings.AlsoNew.games, 1);
  // Both entrants started this call at INITIAL_RATING/0 games -- provisional K=40 for both,
  // expectedScore(1200, 1200) = 0.5 -- so the exact post-match numbers pin the whole seam.
  assert.equal(ratings.Newcomer.rating, INITIAL_RATING + 40 * 0.5);
  assert.equal(ratings.AlsoNew.rating, INITIAL_RATING - 40 * 0.5);
});

test("a caller may pre-seed an entrant; applyResult only fills in the ones it doesn't find", () => {
  const ratings = { Veteran: { rating: 1800, games: 40 } };
  applyResult(ratings, "Veteran", "Newcomer", 0);
  assert.equal(ratings.Newcomer.games, 1, "the missing side is still created fresh");
  assert.notEqual(ratings.Veteran.rating, 1800, "the pre-seeded side's rating must still move from the match");
});

test("zero-sum AT EQUAL K: two entrants who already share one K-bucket get exact opposite deltas", () => {
  // Both at games >= 10 (graduated) and rating < 2400 -> both land on kFactor's K=20 bucket.
  const ratings = { Vet1: { rating: 1300, games: 12 }, Vet2: { rating: 1250, games: 40 } };
  assert.equal(kFactor(ratings.Vet1.games, ratings.Vet1.rating), 20, "fixture: Vet1 must be in the K=20 bucket");
  assert.equal(kFactor(ratings.Vet2.games, ratings.Vet2.rating), 20, "fixture: Vet2 must be in the SAME K=20 bucket");
  const before = { Vet1: ratings.Vet1.rating, Vet2: ratings.Vet2.rating };
  applyResult(ratings, "Vet1", "Vet2", 1);
  const deltaVet1 = ratings.Vet1.rating - before.Vet1;
  const deltaVet2 = ratings.Vet2.rating - before.Vet2;
  assert.notEqual(deltaVet1, 0, "fixture: the match actually moved a rating");
  assert.equal(deltaVet1, -deltaVet2, "equal K on both sides must make the two deltas exact negatives of each other");
});

test("NOT zero-sum at UNEQUAL K: a provisional entrant meeting a graduated one is correct Elo, not a bug", () => {
  // A is brand-new (provisional, K=40); B is long-established under 2400 (K=20) -- different
  // buckets on purpose, per docs/competitions-and-elo.md's own Phase 1 spec: "if A is provisional
  // and B is not, they can use different K -- that is correct Elo, not a bug."
  const ratings = { A: { rating: 1200, games: 0 }, B: { rating: 1200, games: 50 } };
  applyResult(ratings, "A", "B", 1);
  const deltaA = ratings.A.rating - 1200;
  const deltaB = ratings.B.rating - 1200;
  assert.equal(deltaA, 20, "A: K=40, expectedScore=0.5, S=1 -> +20");
  assert.equal(deltaB, -10, "B: K=20, expectedScore=0.5, S=0 -> -10");
  assert.notEqual(deltaA, -deltaB, "unequal K must NOT produce exact-negative deltas");
});

/* ---------- applyResult: same-name collision guard ----------
   RatingsTable is a plain object keyed by entrant name (see elo.js's own header). Two entrants
   sharing a name in the SAME match make `ratings[aName]` and `ratings[bName]` the identical slot:
   applyResult computes A's post-match entry, writes it, then unconditionally overwrites it with
   B's post-match entry (`ratings[bName] = ...` runs second and wins) -- A's half silently vanishes
   and the survivor doesn't represent either side faithfully. That must be rejected up front, not
   left to corrupt silently. */

test("applyResult throws when aName === bName instead of silently corrupting the shared entry", () => {
  const ratings = {};
  assert.throws(() => applyResult(ratings, "Aggressive", "Aggressive", 1), /same|different|distinct/i);
});

test("applyResult's same-name guard fires before any mutation -- a rejected call leaves ratings untouched", () => {
  const ratings = {};
  assert.throws(() => applyResult(ratings, "X", "X", 1));
  assert.deepEqual(ratings, {}, "the colliding entry must not even be half-created");
});

test("applyResult's same-name guard fires even when that name is already seeded, and leaves it untouched", () => {
  const ratings = { Solo: { rating: 1500, games: 12 } };
  assert.throws(() => applyResult(ratings, "Solo", "Solo", 0.5));
  assert.deepEqual(ratings, { Solo: { rating: 1500, games: 12 } }, "the pre-existing entry must survive intact");
});

test("applySeries propagates the same-name guard for whichever row triggers it", () => {
  const ratings = {};
  const rows = [
    { aName: "A", bName: "B", score: 1 },
    { aName: "C", bName: "C", score: 0.5 },   // the offending row
  ];
  assert.throws(() => applySeries(ratings, rows), /same|different|distinct/i);
  // The row before the offending one must still have gone through -- applyResult/applySeries never
  // retroactively undoes earlier, valid matches just because a later row in the same series is bad.
  assert.ok(ratings.A, "the earlier, valid row must still have been applied");
  assert.ok(ratings.B, "the earlier, valid row must still have been applied");
});

test("both sides' games increment by exactly 1, win or lose", () => {
  const ratings = {};
  applyResult(ratings, "A", "B", 0.5);
  assert.equal(ratings.A.games, 1);
  assert.equal(ratings.B.games, 1);
  applyResult(ratings, "A", "B", 1);
  assert.equal(ratings.A.games, 2);
  assert.equal(ratings.B.games, 2);
});

/* ---------- applySeries: D6's canonical-order seam ---------- */

test("REPRODUCIBILITY: applySeries on two separately-built, identical fresh ratings objects is byte-identical", () => {
  // Phrased as reproducibility, not "order doesn't matter" -- D6's actual promise is that a FIXED
  // rows array replays to the same table every time, not that shuffling it is safe (see the very
  // next test, which proves the opposite).
  const rows = [
    { aName: "A", bName: "B", score: 1 },
    { aName: "A", bName: "C", score: 0.5 },
    { aName: "B", bName: "C", score: 0 },
    { aName: "A", bName: "B", score: 0 },
  ];
  const freshRatings = () => ({});
  const result1 = applySeries(freshRatings(), rows);
  const result2 = applySeries(freshRatings(), rows);
  assert.deepEqual(result1, result2,
    "the same rows array, replayed from two independently-constructed fresh ratings objects, must produce byte-identical final ratings");
});

test("ORDER MATTERS: the same matches replayed in a different order settle on a different table", () => {
  // The flip side of reproducibility above, and the whole reason D6 mandates one canonical order
  // (round, then pairing index, then side): a small round-robin's results, reordered, are NOT the
  // same competition outcome, because Elo reads each side's CURRENT rating at the time a match is
  // scored, and that rating depends on what already happened to it earlier in the series.
  const matches = [
    { aName: "A", bName: "B", score: 1 },
    { aName: "A", bName: "C", score: 1 },
    { aName: "B", bName: "C", score: 1 },
  ];
  const forward = applySeries({}, matches);
  const reversed = applySeries({}, [...matches].reverse());
  assert.notDeepEqual(forward, reversed,
    "the same three match results, replayed in a different order, must NOT settle on the same final ratings -- " +
    "this is exactly why a reproducible competition needs one canonical order, not just A fixed order");
});

test("applySeries does not sort or reorder its input", () => {
  const rows = [
    { aName: "Z", bName: "Y", score: 1 },
    { aName: "A", bName: "B", score: 0 },
  ];
  const untouched = JSON.stringify(rows);
  applySeries({}, rows);
  assert.equal(JSON.stringify(rows), untouched, "applySeries must not mutate or reorder the rows array itself");
});

test("applySeries folds every row through applyResult and returns the same ratings object it was given", () => {
  const ratings = {};
  const rows = [{ aName: "A", bName: "B", score: 1 }, { aName: "B", bName: "C", score: 1 }];
  const returned = applySeries(ratings, rows);
  assert.equal(returned, ratings, "applySeries must return the SAME ratings reference it mutated");
  assert.equal(ratings.A.games, 1);
  assert.equal(ratings.B.games, 2, "B appears in both rows");
  assert.equal(ratings.C.games, 1);
});
