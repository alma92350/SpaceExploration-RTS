// @ts-check
"use strict";

/* ============================================================
   PAIRING — the pure "who plays whom" logic every competition FORMAT is built on: Swiss (rounds
   paired by closest standing, with backtracking matching and proper bye assignment), round-robin
   (every unordered pair once) and knockout (single elimination). Extracted out of tools/ailab.js
   (docs/competitions-and-elo.md Phase 3) so the in-game competition screen — a browser Worker, in
   the stage after this one — and the CLI bench schedule tournaments through ONE implementation:
   "the Swiss matcher's backtracking, its bye rule, and its already-played-pair avoidance are
   exactly the sort of code that must not be reimplemented", per that phase's own brief.

   Root-level and pure, exactly like elo.js and for the same reason (D1): a schedule is not sim
   state, and both the game and the bench need the identical one. No clock, no storage, no DOM, no
   engine state — the single import is hashStr (engine/rng.js), used to derive each round's seed
   base the way every other seed in this repo is derived.

   NOTHING HERE DECIDES WHO WON A MATCH. Every schedule below takes its match runner as a PARAMETER
   (`runPair(a, b, opts)`, returning tools/ailab.js's runSwappedDuel aggregate shape:
   `{ aWins, bWins, draws, avgMargin, … }`). The fairness machinery — side-swap, identical pinned
   APM/micro for both seats, difficulty brackets, per-match seed derivation — stays in
   tools/duelCore.js and tools/ailab.js where it already lives and has already had bugs found in it.
   This module only decides the SCHEDULE. That separation is also what makes every function here
   testable on synthetic results in milliseconds instead of by simulating real matches.

   tools/ailab.js re-exports rankStandings/pairRound/buildSwissBracket straight through under their
   original names, so runSwissBracket, runSwissTournament and every other existing caller — plus
   test/ailab.test.js's own import line — keep working completely unchanged. The paragraphs below
   moved here verbatim from tools/ailab.js's TIER 5 header, because they are the record of WHY this
   code has the shape it does; the parts about the CLI's own round count and --difficulties handling
   stayed there, with runSwissTournament.

   PAIRING RULE (findMatching/pairRound below): sort the field by current wins (ties keep the
   stable order they arrive in), then find a matching that avoids every already-played pair IF
   ONE EXISTS. The first cut of this shipped as pure greedy — walk the sorted list, pair each
   candidate with the first not-yet-played opponent remaining — and independent review caught
   that it does NOT deliver the "avoids a repeat unless truly forced" guarantee it claimed:
   fuzz-testing against a brute-force ground-truth checker measured avoidable repeats in roughly
   a quarter to half of realistic tournaments (n=6..50), because a greedy walk can strand two
   candidates with each other even when a full zero-repeat matching exists elsewhere in the same
   round (classic "first fit with no lookahead" failure). findMatching now backtracks: for each
   candidate (closest-standing first) it tries an unplayed opponent before ever trying a repeat,
   and if that choice can't be extended into a complete matching for the rest of the pool, it
   backtracks and tries the next one. Bounded by MATCH_ATTEMPT_CAP (small Swiss pools — this
   tool's whole use case — resolve in a handful of attempts; the cap exists so a pathological
   input can never hang) with a plain greedy pass as the last-resort fallback if the cap is hit,
   so this always terminates and always returns a complete pairing.

   BYES: odd `candidates.length` leaves one candidate unpaired each round. It's awarded to the
   LOWEST-standing candidate who hasn't had one yet, falling back to lowest-standing overall once
   everyone has — standard Swiss practice. That fallback CAN eventually reach the field's current
   leader in a long-enough Swiss on a small pool (this tool's own default rounds formula keeps
   real runs far short of that, but nothing prevents it if `--rounds` is pushed high). A bye is
   NOT a win: it's the schedule's own bookkeeping for "this candidate wasn't paired," and the
   first cut of this got that wrong too — it credited a bye as a full pairing's worth of wins
   (`worlds.length * seeds * 2`, i.e. a maximum-margin sweep) with zero matching losses, which an
   independent review caught letting a candidate that never fights at all tie or outrank one that
   won a genuine match (reproduced live: a neverInitiates/zero-standing-army candidate that drew
   a bye matched a real winner's standing). A bye now adds to nobody's `wins`/`losses` — only its
   own `byes` counter — so standings reflect actual fighting, never schedule luck. `byeMatchCount`
   is kept as an informational field only (how big a real pairing this round would have been),
   never applied to anyone's tally.
   ============================================================ */

import { hashStr } from "./engine/rng.js";

/**
 * @typedef {{ name: string }} Entrant
 *   Any candidate-like object — tools/ailab.js's `{ name, strategy, overrides }` candidates and
 *   competitionLedger.js's roster rows both qualify. This module only ever reads `.name`;
 *   everything else is passed through to the injected `runPair` untouched.
 */
/**
 * @typedef {{ name: string, wins?: number, losses?: number, draws?: number, byes?: number }} StandingsRow
 *   One entrant's running tally within a bracket. `byes` is bookkeeping only — never scored.
 */
/**
 * @typedef {{ aWins?: number, bWins?: number, draws?: number, avgMargin?: number }} PairResult
 *   The aggregate a `runPair(a, b, opts)` returns for one PAIRING (not one match): tools/ailab.js's
 *   runSwappedDuel shape. Only these four fields are ever read here; everything else it carries is
 *   stored verbatim for the caller/UI.
 */

const pairKey = (a, b) => [a, b].sort().join("::");

// Total (candidate, opponent) trial attempts findMatching will spend across an ENTIRE call
// (shared across all its recursive branches via the mutable `budget` object) before giving up
// and falling back to a plain greedy pass. Small Swiss pools — this tool's whole use case —
// resolve in well under this; it exists purely so a pathological input can never hang.
const MATCH_ATTEMPT_CAP = 20000;

// Backtracking search for a COMPLETE ZERO-REPEAT matching over `pool` (already sorted by
// standing, closest-first) — every pair it considers must be absent from `played`; it never
// accepts a repeat itself. For the pool's first member, tries each unplayed opponent in
// closest-standing order, recursing on what's left; if a choice can't be extended into a
// complete zero-repeat matching for the REST of the pool, it backtracks and tries the next
// opponent — the step a plain greedy walk skips, which is exactly how it can strand two
// candidates with each other (see the header comment above). Returns null — not a
// repeat-containing matching — when no zero-repeat completion exists from here, so a caller
// can tell "impossible" apart from "found one" and only then fall back to greedyMatching, which
// is the one place a repeat is ever chosen. `budget.n` is decremented on every attempt and
// shared across the whole recursion (mutated in place), so total work is bounded regardless of
// tree depth; running out returns null the same as genuine impossibility, and the caller's
// greedy fallback still always completes since repeats are unconditionally allowed there.
function findMatching(pool, played, budget) {
  if (!pool.length) return [];
  const [a, ...rest] = pool;
  for (const b of rest) {
    if (played.has(pairKey(a.name, b.name))) continue;   // this search only ever considers UNPLAYED pairs
    if (budget.n <= 0) return null;
    budget.n--;
    const remaining = rest.filter(c => c !== b);
    const sub = findMatching(remaining, played, budget);
    if (sub) return [[a, b], ...sub];
  }
  return null;   // no zero-repeat completion from here (or the budget ran out) — caller falls back
}

// The original greedy pass (closest-standing first, first not-yet-played opponent, forced repeat
// if none remain) — kept only as findMatching's fallback if MATCH_ATTEMPT_CAP is ever exhausted,
// so pairRound always terminates and always returns a complete pairing either way.
function greedyMatching(pool, played) {
  const rest = [...pool];
  const pairs = [];
  while (rest.length) {
    const a = rest.shift();
    let idx = rest.findIndex(b => !played.has(pairKey(a.name, b.name)));
    if (idx === -1) idx = 0;
    const b = rest.splice(idx, 1)[0];
    pairs.push([a, b]);
  }
  return pairs;
}

// One round's pairings off the current standings, sorted highest-first. `played` is the set of
// pairKey()s already run in ANY earlier round of this bracket; `hadBye` is the set of names
// already given a bye. Returns { pairs: [[aRow, bRow], ...], byeName } — `pairs` holds the
// standings rows (not the candidate objects; the caller looks the candidate up by name), so
// this function stays pure and easy to test on plain data. Exported for direct, fast unit tests
// against synthetic standings/played-sets — the pairing algorithm's own correctness doesn't
// depend on running real matches.
// Rank a Swiss field. Win RATE, with raw wins as the tie-break — not absolute wins, which is what
// this used to sort on. A bye is scorable-neutral (nothing added to wins or losses), but its
// recipient simply plays one fewer pairing, i.e. worlds x seeds x 2 fewer chances to earn a win —
// 16 under the swiss CLI defaults. Sorting on totals therefore ranked "everyone who avoided a bye,
// then everyone who didn't": a 2W-2L candidate at 50% finished below a 3W-3L candidate at 50%
// purely for having played more. That is the mirror image of the bug e9ad1d0 fixed, in the one
// place the tool is meant to be trustworthy. Ties fall back to name so the order is total.
/**
 * @param {StandingsRow[]} rows
 * @returns {StandingsRow[]} a new array, best-first; the input is left untouched.
 */
export function rankStandings(rows) {
  const rate = r => {
    const n = (r.wins || 0) + (r.losses || 0) + (r.draws || 0);
    return n > 0 ? (r.wins || 0) / n : 0;
  };
  return [...rows].sort((x, y) =>
    rate(y) - rate(x) || (y.wins || 0) - (x.wins || 0) || (x.losses || 0) - (y.losses || 0)
    || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/**
 * Tally a list of FINISHED pairings into standings rows, ranked by rankStandings above. The same
 * arithmetic buildSwissBracket does incrementally as it runs (a pairing's `aWins` are A's wins and
 * B's losses; a bye touches only its own counter, never wins/losses — see the BYES paragraph in
 * this file's header), but computed from a flat list after the fact, which is what a caller holding
 * only "the pairings finished so far" has: competitionWorker.js's round-robin result, and the
 * in-game tournament screen's LIVE standings as each pairing lands. Every name in `names` gets a
 * row even if it hasn't played yet, so a field never appears to shrink mid-tournament.
 * @param {string[]} names        the whole field, so an unplayed entrant still gets a 0-0-0 row.
 * @param {{ aName: string, bName: string, aWins?: number, bWins?: number, draws?: number }[]} pairings
 * @param {string[]} [byeNames]   one entry per bye awarded (the same name may appear more than once).
 * @returns {StandingsRow[]} ranked best-first; the inputs are left untouched.
 */
export function tallyStandings(names, pairings, byeNames = []) {
  const rows = new Map(names.map(name => [name, { name, wins: 0, losses: 0, draws: 0, byes: 0 }]));
  const rowFor = name => rows.get(name) || (rows.set(name, { name, wins: 0, losses: 0, draws: 0, byes: 0 }), rows.get(name));
  for (const p of pairings || []) {
    const a = rowFor(p.aName), b = rowFor(p.bName);
    const aWins = p.aWins || 0, bWins = p.bWins || 0, draws = p.draws || 0;
    a.wins += aWins; a.losses += bWins; a.draws += draws;
    b.wins += bWins; b.losses += aWins; b.draws += draws;
  }
  for (const name of byeNames || []) rowFor(name).byes += 1;   // NOT a win — see header
  return rankStandings([...rows.values()]);
}

/**
 * @param {StandingsRow[]} standingsRows
 * @param {Set<string>} played   pairKey()s already run in an earlier round of this bracket.
 * @param {Set<string>} hadBye   names already given a bye in this bracket.
 * @returns {{ pairs: StandingsRow[][], byeName: string|null }}
 */
export function pairRound(standingsRows, played, hadBye) {
  // Tie-break the pairing order by NAME, not by list position. Every standing is 0-0 in round 1, and
  // a stable sort preserved input order, so the loop below always took the last-LISTED candidate:
  // `--candidates a.json,…,e.json` structurally penalised e.json for nothing but its position.
  const order = [...standingsRows].sort((a, b) =>
    b.wins - a.wins || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let byeName = null;
  if (order.length % 2 === 1) {
    let idx = -1;
    for (let i = order.length - 1; i >= 0; i--) if (!hadBye.has(order[i].name)) { idx = i; break; }
    if (idx === -1) idx = order.length - 1;   // everyone's already had one — lowest standing again
    byeName = order.splice(idx, 1)[0].name;
  }
  const pairs = findMatching(order, played, { n: MATCH_ATTEMPT_CAP }) || greedyMatching(order, played);
  return { pairs, byeName };
}

/**
 * How many rounds a Swiss bracket over `n` entrants runs by default: `max(3, ceil(log2 n))` — the
 * textbook rule of thumb for how many rounds separate a field of that size, and the exact default
 * tools/ailab.js's runSwissTournament has always applied to `--rounds` (it calls this now, so the
 * CLI and the in-game screen can never drift apart on it). Exported because BOTH the in-game
 * tournament screen (which prices a run before starting it, and shows the number it will use) and
 * competitionWorker.js (which defaults the job's own optional `rounds`) need the identical answer.
 * @param {number} n
 * @returns {number}
 * @throws {Error} if n < 2, the same floor buildSwissBracket's own callers enforce.
 */
export function swissRoundCount(n) {
  if (!(n >= 2)) throw new Error(`a Swiss bracket needs at least 2 entrants, got ${n}`);
  return Math.max(3, Math.ceil(Math.log2(n)));
}

// One difficulty bracket's whole Swiss schedule: `numRounds` rounds of pairRound, each pairing
// run through runSwappedDuel exactly like round-robin's own pairs — same opts shape, same
// fairness. Standings accumulate match wins/losses/draws round over round, same tallying
// runRoundRobinSwapped already does per pairing; a bye adds only to `byes`, never `wins`/
// `losses` — see the header comment above.
// The Swiss SCHEDULE, with the match runner injected. Extracted so the combinatorics — round count,
// pairings per round, bye rotation, rematch avoidance, standings order — can be tested on synthetic
// results in milliseconds instead of by simulating real 15-40 sim-minute matches. Those schedule
// tests were roughly 50 s of the suite's wall clock, all of it spent proving arithmetic. (The file
// already demonstrated the fast idiom once, in pairRound's own test, and said why it was better.)
// tools/ailab.js's runSwissBracket is a thin wrapper that injects the real runSwappedDuel.
/**
 * @param {Entrant[]} candidates
 * @param {number} numRounds
 * @param {{ worlds?: string[], seeds?: number, seedBase?: number }} opts   forwarded to `runPair` verbatim, seedBase per round.
 * @param {(a: Entrant, b: Entrant, opts: Object) => PairResult} runPair
 * @returns {{ rounds: number, byeMatchCount: number,
 *   roundsLog: { round: number, byeName: string|null, byeMatchCount: number|null, matches: PairResult[] }[],
 *   standings: StandingsRow[] }}
 */
export function buildSwissBracket(candidates, numRounds, opts, runPair) {
  const worlds = opts.worlds || ["korrath", "ferros", "vesper", "kybernet"];
  const seeds = opts.seeds ?? 2;
  const byeMatchCount = worlds.length * seeds * 2;   // informational only — == a real pairing's runSwappedDuel `n`
  const standings = new Map(candidates.map(c => [c.name, { name: c.name, wins: 0, losses: 0, draws: 0, byes: 0 }]));
  const played = new Set(), hadBye = new Set();
  const rounds = [];
  for (let round = 1; round <= numRounds; round++) {
    const { pairs, byeName } = pairRound([...standings.values()], played, hadBye);
    if (byeName) {
      standings.get(byeName).byes += 1;   // NOT a win — see header comment
      hadBye.add(byeName);
    }
    const matches = [];
    // Fold the round number into the seed so a forced rematch in a later round isn't a byte-for-byte
    // copy of the earlier one, while staying fully deterministic (hashStr, no clock, no unseeded
    // pick) — the same discipline duelSeed() already applies to world/difficulty/names/rep.
    const roundSeedBase = hashStr(`${opts.seedBase ?? 1}:swiss:round${round}`);
    for (const [aRow, bRow] of pairs) {
      const a = candidates.find(c => c.name === aRow.name);
      const b = candidates.find(c => c.name === bRow.name);
      played.add(pairKey(a.name, b.name));
      const res = runPair(a, b, { ...opts, seedBase: roundSeedBase });
      const A = standings.get(a.name), B = standings.get(b.name);
      A.wins += res.aWins; A.losses += res.bWins; A.draws += res.draws;
      B.wins += res.bWins; B.losses += res.aWins; B.draws += res.draws;
      matches.push(res);
    }
    rounds.push({ round, byeName, byeMatchCount: byeName ? byeMatchCount : null, matches });
  }
  return {
    rounds: numRounds, byeMatchCount, roundsLog: rounds,
    standings: rankStandings([...standings.values()]),
  };
}

/* ============================================================
   ROUND-ROBIN — every unordered pair, once, in a fixed order
   ============================================================ */

// The schedule tools/ailab.js's runRoundRobin and runRoundRobinSwapped have always written inline
// as a nested `for (i) for (j = i + 1)` loop, named and shared so the in-game formats schedule a
// round-robin through the same code the bench does rather than growing a second copy of it.
// Deliberately NOT circle-method round scheduling (which would group the pairs into rounds where
// everyone plays at most once): a round-robin here is a flat list of pairings run back to back, and
// that is all the callers want. The order is `i x j over the caller's own input order`, so it is
// fully determined by the field it was handed — this helper never sorts a field of its own, because
// the caller's order is meaningful (it is a seeding, or a roster order, or a CLI argument order).
/**
 * @template T
 * @param {T[]} entrants   entrant objects, or plain names — the elements are passed through as-is.
 * @returns {T[][]} every unordered pair exactly once: [[e0,e1], [e0,e2], …, [e(n-2),e(n-1)]].
 */
export function roundRobinPairs(entrants) {
  const pairs = [];
  for (let i = 0; i < entrants.length; i++)
    for (let j = i + 1; j < entrants.length; j++)
      pairs.push([entrants[i], entrants[j]]);
  return pairs;
}

/* ============================================================
   KNOCKOUT — single elimination (docs/competitions-and-elo.md Phase 3: "the most legible tournament
   PICTURE; a real final")

   SEEDING IS THE CALLER'S. `seededEntrants` arrives already in seed order, strongest first — the
   competition screen builds it (off Standings rating, falling back to name for anyone unrated).
   This function never re-sorts by rating, so it stays pure and completely decoupled from the
   ledger; it consumes an order, it does not invent one.

   THE BRACKET. Round 1 reduces the field to a power of two, which is what makes every later round a
   clean halving with no byes left to hand out: with `target` = the smallest power of two >= n, the
   top `target - n` seeds get a first-round bye and advance without playing, and the remaining
   entrants pair up CONSECUTIVELY in seed order (the first non-bye seed plays the next one, and so
   on). That leaves `target / 2` entrants — byes first, in seed order, then each match's winner in
   bracket order — and every round after it pairs consecutively again, winner-of-slot-1 against
   winner-of-slot-2. Deliberately NOT standard tournament reseeding (1-vs-16, 2-vs-15, …): simple
   consecutive pairing after the byes are peeled off is a completely legitimate single-elimination
   bracket, and the reseeding math is complexity this feature does not need.

   (A note for anyone diffing this against the Phase 3 brief, which says "let p = the LARGEST power
   of 2 <= n; the top (n - p) seeds get a bye": that formula and the invariant the brief states in
   the very next clause — "this is now always a power of 2, so no more byes after round 1" — only
   agree when n is p or 1.5p. They coincide on the brief's own worked example (n = 6: two byes
   either way) and diverge at, say, n = 11, where n - p = 3 byes would leave a 7-entrant round 2 and
   the bye-peeling would have to repeat every round — handing the top seed four byes and a walkover
   into the final. `target - n` byes is the standard reduction, keeps the stated invariant for every
   n, and preserves the quantity the brief actually names: `n - p` is exactly the number of
   FIRST-ROUND MATCHES here.)

   A loss eliminates; the last entrant standing is the champion. Total non-bye matches is therefore
   always exactly n - 1 whatever n is and however many byes round 1 handed out — every match
   eliminates exactly one entrant, and a bye eliminates nobody. knockoutMatchCount() below is that
   fact on its own, for a cost estimate shown BEFORE a bracket runs.

   DRAWS. A pairing's aggregate can tie on wins even though this codebase near-eliminates real
   draws (engine/victory.js's own score tiebreak — see docs/competitions-and-elo.md D7). Somebody
   still has to advance, so: higher aggregate score margin first (`avgMargin`, the same field the
   pairing result already carries and the same tiebreak the standings use), then the higher seed
   (earlier in `seededEntrants`). Deterministic either way — never a coin flip, which would make a
   bracket unreproducible and D6 unenforceable.
   ============================================================ */

// The smallest power of two >= n (n >= 1). Loop rather than bit math: the fields here are tiny, and
// this reads as its own definition.
const nextPowerOfTwo = n => { let p = 1; while (p < n) p *= 2; return p; };

/**
 * How many matches a knockout bracket over `n` entrants will actually play — always n - 1, since
 * every match eliminates exactly one entrant and a bye eliminates nobody. Exported so the UI can
 * price a bracket ("≈ 15 matches, ≈ 1 min") before committing to run one.
 * @param {number} n
 * @returns {number}
 * @throws {Error} if n < 2, the same floor buildKnockoutBracket itself enforces.
 */
export function knockoutMatchCount(n) {
  if (!(n >= 2)) throw new Error(`a knockout bracket needs at least 2 entrants, got ${n}`);
  return n - 1;
}

// Who advances out of one played pairing. Wins first, then aggregate score margin, then seed —
// see the DRAWS paragraph in the header above for why each step exists and why none of them is
// random. `seedOf` maps name -> index in the original seeded field, so "higher seed" means exactly
// "the caller listed it earlier".
function advanceFrom(a, b, result, seedOf) {
  if (!result || typeof result !== "object")
    throw new Error(`runPair returned no result for "${a.name}" vs "${b.name}" — a knockout can't advance anyone from that`);
  const aWins = result.aWins || 0, bWins = result.bWins || 0;
  if (aWins !== bWins) return aWins > bWins ? a : b;
  const margin = Number.isFinite(result.avgMargin) ? result.avgMargin : 0;
  if (margin !== 0) return margin > 0 ? a : b;
  return seedOf.get(a.name) <= seedOf.get(b.name) ? a : b;
}

/**
 * @typedef {Object} KnockoutSlot   One position in the bracket tree: a played match, or a bye.
 * @property {number} round         1-based round this slot sits in.
 * @property {Entrant} a            The entrant in the slot's first seat. Never null.
 * @property {Entrant|null} b       The entrant it played — null exactly when `bye` is true.
 * @property {boolean} bye          True when `a` advanced without playing anyone.
 * @property {Entrant} winner       The entrant that advances out of this slot (=== `a` for a bye).
 * @property {PairResult|null} result   What `runPair` returned — null exactly when `bye` is true.
 */
/**
 * @typedef {Object} KnockoutRound
 * @property {number} round
 * @property {KnockoutSlot[]} matches   This round's slots in BRACKET order — slot i's winner meets
 *   slot i+1's winner in the next round. Byes are slots too (`bye: true`), listed first, so the
 *   round's own order IS the order its winners enter the next one.
 */
/**
 * @typedef {Object} KnockoutBracket
 * @property {Entrant[]} entrants   The seeded field, copied in the order given: index = seed, 0 = strongest.
 * @property {KnockoutRound[]} rounds
 *   Every round in order, so the whole tree (who played whom, who advanced, who had a bye) reads
 *   straight back out of this with nothing to re-derive.
 * @property {number} matchCount    Non-bye matches actually played — always entrants.length - 1.
 * @property {Entrant} champion     The last entrant standing.
 */
/**
 * Run a single-elimination bracket over an ALREADY-SEEDED field, with the match runner injected —
 * the same shape buildSwissBracket takes, so a caller can hand both formats the identical
 * `runPair`. See the KNOCKOUT header comment above for the bracket rule, the bye rule and the
 * draw tie-break.
 * @param {Entrant[]} seededEntrants   strongest first; this function consumes the order, never re-sorts it.
 * @param {{ seedBase?: number }} opts   forwarded to `runPair` verbatim, with `seedBase` replaced
 *   per round. Pass `{}` when there is nothing to forward — it is positional, like
 *   buildSwissBracket's own, so that the injected `runPair` stays last in both.
 * @param {(a: Entrant, b: Entrant, opts: Object) => PairResult} runPair
 * @returns {KnockoutBracket}
 * @throws {Error} on fewer than 2 entrants, a nameless entrant, or two entrants sharing a name.
 */
export function buildKnockoutBracket(seededEntrants, opts, runPair) {
  const config = opts || {};   // whatever the caller forwards to runPair; absent is simply an empty bag
  const entrants = [...seededEntrants];
  if (entrants.length < 2)
    throw new Error(`a knockout bracket needs at least 2 entrants, got ${entrants.length}`);
  // Same guard, same reasoning as tools/ailab.js's assertUniqueCandidateNames: a bracket is read
  // and rated by NAME (elo.js's RatingsTable is keyed by it), so two entrants sharing one would
  // make the tree ambiguous to anyone reading it and collide both sides' ratings downstream.
  const seedOf = new Map();
  entrants.forEach((e, i) => {
    if (!e || !e.name) throw new Error('every knockout entrant needs a "name"');
    if (seedOf.has(e.name)) throw new Error(`duplicate entrant name "${e.name}" — a knockout bracket is read by name`);
    seedOf.set(e.name, i);
  });

  const rounds = [];
  let field = entrants;
  let matchCount = 0;
  for (let round = 1; field.length > 1; round++) {
    // Byes only ever fire in round 1: after it the field is a power of two, and this is 0 by
    // construction from then on — which is why no later round needs a special case.
    const byes = nextPowerOfTwo(field.length) - field.length;
    // Fold the round into the seed base exactly as buildSwissBracket does, so every pairing's seed
    // derives from (competition seed, round) and a whole bracket replays byte-for-byte (D6).
    const roundSeedBase = hashStr(`${config.seedBase ?? 1}:knockout:round${round}`);
    const matches = [];
    for (let i = 0; i < byes; i++)
      matches.push({ round, a: field[i], b: null, bye: true, winner: field[i], result: null });
    for (let i = byes; i < field.length; i += 2) {
      const a = field[i], b = field[i + 1];
      const result = runPair(a, b, { ...config, seedBase: roundSeedBase });
      matches.push({ round, a, b, bye: false, winner: advanceFrom(a, b, result, seedOf), result });
      matchCount++;
    }
    rounds.push({ round, matches });
    field = matches.map(m => m.winner);
  }
  return { entrants, rounds, matchCount, champion: field[0] };
}

/* ============================================================
   SCHEDULE SHAPE — how many PAIRINGS each format schedules, and in how many rounds, WITHOUT
   running anything. Two callers need exactly this, for two different reasons:

     • the in-game tournament screen, to price a run before the player commits to it
       (docs/competitions-and-elo.md Phase 3: "a user who picks 16 entrants x 4 worlds x 3 seeds
       deserves to be told it's a long run before it starts, not after");
     • competitionWorker.js, to turn a flat "this is pairing number k" counter into the
       "round 2 of 4, pairing 3 of 8" coordinates a progress readout needs — neither
       buildSwissBracket nor buildKnockoutBracket tells its injected runPair where in the schedule
       it currently is, and neither should have to.

   It lives HERE, next to the schedules it describes, because a second copy of this arithmetic that
   disagreed with what actually runs is precisely the kind of drift this module exists to prevent —
   test/pairing.test.js checks every plan against a real bracket, round for round, rather than
   against a restatement of the formula.
   ============================================================ */

/**
 * @param {"round-robin"|"swiss"|"knockout"} format
 * @param {number} n         the field size.
 * @param {number} [rounds]  Swiss only: an explicit round count overriding swissRoundCount(n).
 *   Ignored by the other two formats, which have no round count to override.
 * @returns {{ round: number, pairings: number }[]} one entry per round, in order.
 * @throws {Error} on an unknown format or a field too small to schedule.
 */
export function tournamentRoundPlan(format, n, rounds) {
  if (!(n >= 2)) throw new Error(`a tournament needs at least 2 entrants, got ${n}`);
  // Round-robin is deliberately ONE flat round of every pair, matching roundRobinPairs above (see
  // its own comment on why this isn't circle-method round scheduling).
  if (format === "round-robin") return [{ round: 1, pairings: (n * (n - 1)) / 2 }];
  if (format === "swiss") {
    const count = rounds > 0 ? Math.floor(rounds) : swissRoundCount(n);
    // floor(n/2), not ceil: an odd field's leftover entrant takes a BYE, which is not a pairing and
    // costs no matches — pairRound's own rule.
    return Array.from({ length: count }, (_, i) => ({ round: i + 1, pairings: Math.floor(n / 2) }));
  }
  if (format === "knockout") {
    // Walk the same reduction buildKnockoutBracket performs: round 1 byes the top
    // `nextPowerOfTwo(size) - size` seeds and pairs the rest consecutively, leaving a power of two;
    // every later round halves it. The pairings sum to n - 1 for every n (knockoutMatchCount's own
    // fact), byes or no byes.
    const plan = [];
    let size = n;
    for (let round = 1; size > 1; round++) {
      const byes = nextPowerOfTwo(size) - size;
      const pairings = (size - byes) / 2;
      plan.push({ round, pairings });
      size = byes + pairings;
    }
    return plan;
  }
  throw new Error(`unknown tournament format "${format}"`);
}
