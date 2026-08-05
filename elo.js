// @ts-check
"use strict";

/* ============================================================
   ELO — one rating implementation, shared by the in-game competition screen AND tools/ailab.js's
   duel/swiss CLI output (docs/competitions-and-elo.md D1: "if the bench and the game each grow
   their own rating math, a number the player sees in-game and a number a tuning session reports
   stop meaning the same thing"). Root-level, not under engine/ — a rating is not sim state, it's
   a fact about a series of matches the caller already resolved some other way (see D1).

   Pure rating math over data the CALLER owns: no clock, no storage, no DOM, no Math.random. A
   `ratings` table is a plain object keyed by entrant name — the caller decides what "entrant name"
   means for a given pool (D2: ratings are bracketed by difficulty and never blended, so a caller
   that wants "Aggressive @ Hard" and "Aggressive @ Medium" kept apart uses two separate `ratings`
   objects, one per bracket — this module has no notion of "bracket" itself).

   D7 is the whole formula set implemented here: plain Elo (E = 1/(1+10^((Rb-Ra)/400)),
   R' = R + K(S-E)), starting rating 1200, K = 40 while provisional (<10 games) then 20 then 10
   above 2400, no margin-of-victory scaling (a match's score margin is a separate, non-rating
   field elsewhere — see tools/duelCore.js's row shape — never folded in here).
   ============================================================ */

/**
 * @typedef {{ rating: number, games: number }} RatingEntry
 *   One entrant's rating and how many rated games it has played so far, in whichever pool the
 *   caller's `ratings` object represents (D2: typically one (entrant, difficulty bracket) pair).
 */
/** @typedef {Object.<string, RatingEntry>} RatingsTable  Plain object, keyed by entrant name. */
/**
 * @typedef {{ aName: string, bName: string, score: number }} MatchRow
 *   One match's result for applySeries, `score` from A's point of view: 1 (A won), 0.5 (draw),
 *   0 (A lost) — the same three values applyResult's own `score` parameter takes.
 */

// Every new entrant starts here (D7). Exported so a caller never hardcodes the number twice.
export const INITIAL_RATING = 1200;

/**
 * The standard Elo expectation: A's probability of "winning" this pairing (1 = certain win,
 * 0.5 = a coin flip, 0 = certain loss), purely a function of the ratings gap — D7's formula,
 * verbatim. Symmetric by construction: expectedScore(r, r) is always exactly 0.5, and
 * expectedScore(a, b) + expectedScore(b, a) is 1 to within floating-point noise (see
 * test/elo.test.js — two independently-rounded `10 ** x` evaluations aren't bit-exact
 * complements of one another, which is why applyResult below derives B's expectation as
 * `1 - expectedScore(a, b)` rather than by calling this a second time with the arguments
 * swapped).
 * @param {number} ratingA
 * @param {number} ratingB
 * @returns {number} A's expected score, in [0, 1].
 */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * How much one match can move a rating, decided by the PLAYER'S OWN games/rating going into that
 * match (D7). Provisional (fewer than 10 games played so far) always uses the wide K, even for a
 * seeded-high rating — a brand-new entrant is provisional however it started, so this check comes
 * before the rating-based tier. Only once there's a track record does the 2400 rating tier apply.
 * @param {number} games   games this player had played BEFORE this match (i.e. going INTO it).
 * @param {number} rating  this player's rating going INTO this match.
 * @returns {number} the K-factor: 40, 20, or 10.
 */
export function kFactor(games, rating) {
  if (games < 10) return 40;
  return rating >= 2400 ? 10 : 20;
}

/**
 * Apply one match's result to `ratings`, MUTATING AND RETURNING it (this module never clones —
 * a caller that needs the pre-match table preserved must copy it first, e.g.
 * `structuredClone(ratings)`). Either side's entry is created at
 * `{ rating: INITIAL_RATING, games: 0 }` the first time that name is seen, so a caller never has
 * to pre-seed every entrant before a competition can run.
 *
 * K for each side comes from THAT side's own games/rating going into this call (kFactor above) —
 * so a provisional A meeting an established B is ordinary, correct Elo (each side's rating moves
 * by its own K), not a bug. The two deltas are exact negatives of each other ONLY when both sides
 * land in the same K-bucket (equal games-bucket and rating-bucket) — see test/elo.test.js for both
 * the equal-K and unequal-K cases. This is guaranteed by construction: both deltas are derived from
 * ONE shared `diff` (A's actual-minus-expected score this match), not from two independently
 * rounded `expectedScore` calls, so at equal K the negation is exact, not merely close.
 *
 * REJECTS aName === bName, before touching `ratings` at all. RatingsTable is keyed by name (see
 * the module header), so a same-name pairing would make `a`/`b` above alias the SAME object:
 * this function would compute A's post-match entry, write it to `ratings[aName]`, then
 * unconditionally overwrite that exact slot with B's post-match entry (`ratings[bName] = ...` runs
 * second and always wins, since aName and bName are one key) — A's half silently vanishes and the
 * survivor represents neither side faithfully. Two entrants that are conceptually different (say,
 * different strategies) but happen to share one display string collide exactly the same way, since
 * this module has no notion of identity beyond the name string. That's not a match anyone can
 * actually referee — an entrant can't play itself — so it's refused up front rather than silently
 * producing a garbage rating; every shipped caller (competition.js's buildJob, tools/ailab.js's
 * runDuel) already rejects this earlier, with a user/CLI-facing message, but this check is the
 * shared backstop any caller gets for free, present or future, per D1's "one implementation" point.
 * @param {RatingsTable} ratings
 * @param {string} aName
 * @param {string} bName
 * @param {number} score   A's result: 1 (A won), 0.5 (draw), 0 (A lost).
 * @returns {RatingsTable} the same `ratings` object, mutated in place.
 * @throws {Error} if aName === bName.
 */
export function applyResult(ratings, aName, bName, score) {
  if (aName === bName) {
    throw new Error(
      `applyResult: A and B must be different entrants, both were "${aName}" — RatingsTable is ` +
      `keyed by name, so a same-name pairing would collide both sides into one entry instead of two`
    );
  }
  const a = ratings[aName] || (ratings[aName] = { rating: INITIAL_RATING, games: 0 });
  const b = ratings[bName] || (ratings[bName] = { rating: INITIAL_RATING, games: 0 });
  const kA = kFactor(a.games, a.rating);
  const kB = kFactor(b.games, b.rating);
  // One match, one shared "surprise" (actual minus expected) from A's side; B's is its exact
  // negation by construction (a single game has exactly two complementary outcomes) — see the
  // header comment above for why this beats computing B's own expectedScore(b, a) independently.
  const diff = score - expectedScore(a.rating, b.rating);
  const ratingA = a.rating + kA * diff;
  const ratingB = b.rating - kB * diff;
  ratings[aName] = { rating: ratingA, games: a.games + 1 };
  ratings[bName] = { rating: ratingB, games: b.games + 1 };
  return ratings;
}

/**
 * Fold a series of match rows through applyResult, ONE AT A TIME, in the array's OWN order.
 * Deliberately does NOT sort or reorder `rows` itself — Elo is order-dependent (each match reads
 * whatever rating the previous ones left behind), so a fixed rows array always replays to the same
 * final table (reproducibility), but the SAME matches in a DIFFERENT order settle on a DIFFERENT
 * one (see test/elo.test.js's ORDER MATTERS case). Establishing the canonical order — round, then
 * pairing index, then side (D6) — is the CALLER's responsibility; this is the seam where that
 * discipline is actually enforced, by staying silent about ordering rather than imposing one of
 * its own.
 * @param {RatingsTable} ratings
 * @param {MatchRow[]} rows
 * @returns {RatingsTable} the same `ratings` object, mutated in place.
 */
export function applySeries(ratings, rows) {
  for (const { aName, bName, score } of rows) applyResult(ratings, aName, bName, score);
  return ratings;
}
