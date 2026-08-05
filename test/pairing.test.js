/* ============================================================
   Guards for pairing.js — the pure pairing/scheduling logic behind every competition FORMAT
   (docs/competitions-and-elo.md Phase 3), extracted out of tools/ailab.js so the in-game
   competition screen (a browser Worker, next stage) and the CLI bench schedule tournaments through
   ONE implementation instead of two.

   Two halves, deliberately:

     1. THE EXTRACTED SWISS LOGIC (rankStandings / pairRound / buildSwissBracket). test/ailab.test.js
        still exercises every one of these through tools/ailab.js's own re-exports, unmodified —
        that suite is the safety net proving the extraction changed no observable behaviour, exactly
        as test/duelCore.test.js's header describes for Phase 1's own extraction. What's added here
        is DIRECT, ISOLATED coverage imported straight from ../pairing.js, so the three historical
        bugs this code encodes — a bye counted as a win, a rematch a greedy walk could not avoid,
        standings ranked by total games played instead of win rate — stay pinned to the module that
        actually implements them, whatever happens to tools/ailab.js later.
     2. THE NEW SCHEDULES: roundRobinPairs (the generalisation of runRoundRobin's inline double
        loop) and buildKnockoutBracket (single elimination, new in Phase 3).

   Every test here injects a synthetic runPair — the idiom buildSwissBracket's own tests already use
   and explain ("isolates the pairing algorithm from match simulation entirely") — so the
   combinatorics are proven in milliseconds instead of by simulating real 15-40 sim-minute matches.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  rankStandings, pairRound, buildSwissBracket,
  roundRobinPairs, buildKnockoutBracket, knockoutMatchCount,
} from "../pairing.js";
import { mulberry32, hashStr } from "../engine/rng.js";

/* ---------- shared fixtures ---------- */

// A deterministic stand-in for runSwappedDuel: the alphabetically-earlier name wins 2-0, so a
// schedule resolves predictably without simulating anything. The shape is runSwappedDuel's own
// aggregate — aWins/bWins/draws/avgMargin — which is all these schedules ever read off a result.
const fakePair = (a, b) => ({
  aName: a.name, bName: b.name, n: 2, draws: 0,
  aWins: a.name < b.name ? 2 : 0,
  bWins: a.name < b.name ? 0 : 2,
  avgMargin: a.name < b.name ? 5 : -5, rows: [],
});

// Zero-padded so alphabetical order IS seed order: with fakePair above, S00 beats everyone.
const field = n => Array.from({ length: n }, (_, i) => ({ name: `S${String(i).padStart(2, "0")}`, strategy: "default" }));
const names = list => list.map(e => e.name);
const key = (a, b) => [a, b].sort().join("::");
const nextPow2 = n => { let p = 1; while (p < n) p *= 2; return p; };

/* ============================================================
   roundRobinPairs — every unordered pair, once, in a fixed order
   ============================================================ */

test("roundRobinPairs returns every unordered pair exactly once", () => {
  const pairs = roundRobinPairs(field(5));
  assert.equal(pairs.length, (5 * 4) / 2, "n candidates -> C(n,2) pairs");
  const seen = new Set(pairs.map(([a, b]) => key(a.name, b.name)));
  assert.equal(seen.size, pairs.length, "no pair may appear twice");
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++)
      assert.ok(seen.has(key(`S0${i}`, `S0${j}`)), `pair S0${i}/S0${j} is missing`);
});

test("roundRobinPairs pair count is n(n-1)/2 across sizes, and degenerate fields produce none", () => {
  for (const n of [0, 1, 2, 3, 4, 7, 12])
    assert.equal(roundRobinPairs(field(n)).length, n < 2 ? 0 : (n * (n - 1)) / 2, `C(${n},2)`);
});

test("roundRobinPairs order is deterministic: i x j over the INPUT order, i < j", () => {
  const entrants = field(4);
  const expected = [];
  for (let i = 0; i < entrants.length; i++)
    for (let j = i + 1; j < entrants.length; j++) expected.push([entrants[i].name, entrants[j].name]);
  const actual = roundRobinPairs(entrants).map(([a, b]) => [a.name, b.name]);
  assert.deepEqual(actual, expected,
    "the order must match tools/ailab.js's own inline double loop exactly — this helper generalises it, it does not reschedule it");
  // Same field, listed differently, is a different (but still fully determined) order: the helper
  // consumes the caller's order, it never sorts one of its own.
  const reversed = roundRobinPairs([...entrants].reverse()).map(([a, b]) => [a.name, b.name]);
  assert.deepEqual(reversed[0], ["S03", "S02"]);
  assert.equal(JSON.stringify(roundRobinPairs(entrants)), JSON.stringify(roundRobinPairs(entrants)),
    "two calls on the same field must produce byte-identical pairings");
});

test("roundRobinPairs works on plain names as well as candidate objects, and never mutates its input", () => {
  assert.deepEqual(roundRobinPairs(["a", "b", "c"]), [["a", "b"], ["a", "c"], ["b", "c"]]);
  const entrants = field(3);
  const before = JSON.stringify(entrants);
  roundRobinPairs(entrants);
  assert.equal(JSON.stringify(entrants), before, "the input array (and its entries) must be left untouched");
});

/* ============================================================
   buildKnockoutBracket — single elimination
   ============================================================ */

test("a knockout bracket needs at least 2 entrants", () => {
  assert.throws(() => buildKnockoutBracket([], {}, fakePair), /at least 2 entrants/);
  assert.throws(() => buildKnockoutBracket(field(1), {}, fakePair), /at least 2 entrants/);
});

test("every knockout entrant needs a name, and no two may share one", () => {
  assert.throws(() => buildKnockoutBracket([{ name: "A" }, { strategy: "default" }], {}, fakePair), /needs a "name"/);
  assert.throws(() => buildKnockoutBracket([{ name: "A" }, { name: "A" }], {}, fakePair), /duplicate entrant name/);
});

test("a power-of-two field plays a bye-free bracket that halves every round to one champion", () => {
  const bracket = buildKnockoutBracket(field(8), {}, fakePair);
  assert.deepEqual(bracket.rounds.map(r => r.matches.length), [4, 2, 1], "8 -> 4 -> 2 -> 1");
  assert.deepEqual(bracket.rounds.map(r => r.round), [1, 2, 3], "rounds are numbered from 1");
  for (const r of bracket.rounds)
    for (const m of r.matches) {
      assert.equal(m.bye, false, "a power-of-two field must never hand out a bye");
      assert.ok(m.b, "a non-bye slot must carry both entrants");
      assert.ok(m.result, "a non-bye slot must carry the pairing result that decided it");
    }
  assert.equal(bracket.matchCount, 7, "8 entrants -> 7 matches");
  assert.equal(bracket.champion.name, "S00", "fakePair makes the alphabetically-first name win every pairing");
});

test("byes go to exactly the top (nextPow2(n) - n) seeds, only in round 1, and nobody else", () => {
  // The whole point of peeling byes off the TOP of the seed order: the first round reduces the
  // field to a power of two, so every later round is a clean halving with no byes left to hand out.
  for (const n of [3, 5, 6, 7, 9, 11, 12, 13]) {
    const entrants = field(n);
    const bracket = buildKnockoutBracket(entrants, {}, fakePair);
    const [first, ...later] = bracket.rounds;
    const byes = first.matches.filter(m => m.bye);
    const expectedByes = nextPow2(n) - n;
    assert.deepEqual(names(byes.map(m => m.a)), names(entrants.slice(0, expectedByes)),
      `n=${n}: the first ${expectedByes} seeds — and only those — must get the round-1 byes`);
    assert.equal(first.matches.length - byes.length, n - nextPow2(n) / 2,
      `n=${n}: the entrants left after the byes pair up consecutively`);
    for (const m of byes) {
      assert.equal(m.b, null, "a bye has no opponent");
      assert.equal(m.result, null, "a bye plays no match, so it carries no result");
      assert.equal(m.winner.name, m.a.name, "a bye advances the seat that got it");
    }
    // Every slot's winner enters the next round, so the field after round 1 is exactly a power of 2.
    assert.equal(first.matches.length, nextPow2(n) / 2, `n=${n}: round 1 must reduce the field to ${nextPow2(n) / 2}`);
    for (const r of later)
      assert.equal(r.matches.filter(m => m.bye).length, 0, `n=${n}: round ${r.round} must be bye-free`);
  }
});

test("consecutive seed pairing: the entrants left after the byes play their neighbour in seed order", () => {
  // Deliberately NOT standard tournament reseeding (1-vs-16, 2-vs-15) — simple consecutive pairing
  // once the byes are peeled off, which is what docs/competitions-and-elo.md Phase 3 asks for.
  const bracket = buildKnockoutBracket(field(6), {}, fakePair);
  const round1 = bracket.rounds[0].matches.map(m => [m.a.name, m.b && m.b.name]);
  assert.deepEqual(round1, [["S00", null], ["S01", null], ["S02", "S03"], ["S04", "S05"]],
    "6 entrants: 2 byes off the top, then S02/S03 and S04/S05");
});

test("a knockout always resolves to exactly one champion, having played exactly n-1 matches", () => {
  for (let n = 2; n <= 17; n++) {
    const bracket = buildKnockoutBracket(field(n), {}, fakePair);
    const played = bracket.rounds.flatMap(r => r.matches.filter(m => !m.bye));
    assert.equal(played.length, n - 1, `n=${n}: a single-elimination bracket eliminates one entrant per match`);
    assert.equal(bracket.matchCount, n - 1, `n=${n}: matchCount must agree with the matches actually run`);
    assert.equal(knockoutMatchCount(n), n - 1, `n=${n}: the up-front estimate must agree with what runs`);
    assert.equal(bracket.rounds.at(-1).matches.length, 1, `n=${n}: the last round is the final`);
    assert.equal(bracket.champion.name, bracket.rounds.at(-1).matches[0].winner.name,
      `n=${n}: the champion is whoever won the final`);
    assert.equal(bracket.rounds.length, Math.ceil(Math.log2(n)), `n=${n}: ceil(log2(n)) rounds`);
  }
});

test("knockoutMatchCount is the bracket's cost before it runs, and refuses a field too small to run", () => {
  assert.equal(knockoutMatchCount(2), 1);
  assert.equal(knockoutMatchCount(16), 15);
  assert.throws(() => knockoutMatchCount(1), /at least 2 entrants/);
});

test("the bracket tree is reconstructable: each round's field is the previous round's winners, in order", () => {
  // What the next stage's bracket view needs: who played whom, who advanced, who had a bye — all
  // readable back out of the returned structure with no re-derivation.
  for (const n of [4, 5, 11]) {
    const bracket = buildKnockoutBracket(field(n), {}, fakePair);
    let expected = names(bracket.entrants);
    for (const r of bracket.rounds) {
      const entering = r.matches.flatMap(m => (m.bye ? [m.a.name] : [m.a.name, m.b.name]));
      assert.deepEqual(entering, expected, `n=${n}, round ${r.round}: the field must enter in the order it advanced`);
      expected = r.matches.map(m => m.winner.name);
    }
    assert.deepEqual(expected, [bracket.champion.name], `n=${n}: one entrant is left standing`);
  }
});

test("a loss eliminates: nobody appears in any round after one they lost", () => {
  const bracket = buildKnockoutBracket(field(11), {}, fakePair);
  const eliminated = new Set();
  for (const r of bracket.rounds) {
    for (const m of r.matches) {
      for (const e of [m.a, m.b].filter(Boolean))
        assert.ok(!eliminated.has(e.name), `${e.name} played in round ${r.round} after already being knocked out`);
      if (!m.bye) eliminated.add(m.winner.name === m.a.name ? m.b.name : m.a.name);
    }
  }
  assert.equal(eliminated.size, 10, "11 entrants, 10 eliminated, 1 champion");
});

test("a knockout bracket is deterministic — same seeded field, same runPair, byte-identical twice", () => {
  const entrants = field(11);
  const opts = { worlds: ["korrath"], seeds: 1, seedBase: 7 };
  const once = buildKnockoutBracket(entrants, opts, fakePair);
  const twice = buildKnockoutBracket(entrants, opts, fakePair);
  assert.equal(JSON.stringify(once), JSON.stringify(twice),
    "two identical brackets diverged: something reads a clock or an unseeded pick");
});

test("a pairing tied on wins is decided by aggregate score margin, never randomly", () => {
  // The rare case: this codebase near-eliminates real draws through checkWinCondition's own score
  // tiebreak (docs/competitions-and-elo.md D7), but an AGGREGATE across worlds/seeds/sides can
  // still tie on wins. Margin is the same field runSwappedDuel-shaped results already carry.
  const tiedOnWins = margin => (a, b) => ({
    aName: a.name, bName: b.name, n: 2, aWins: 1, bWins: 1, draws: 0, avgMargin: margin, rows: [],
  });
  const bWinsOnMargin = buildKnockoutBracket(field(2), {}, tiedOnWins(-3.5));
  assert.equal(bWinsOnMargin.champion.name, "S01", "a negative aggregate margin is B's advantage — B must advance");
  const aWinsOnMargin = buildKnockoutBracket(field(2), {}, tiedOnWins(3.5));
  assert.equal(aWinsOnMargin.champion.name, "S00", "a positive aggregate margin is A's advantage — A must advance");
});

test("a pairing tied on wins AND margin advances the higher seed — deterministic, never random", () => {
  const deadHeat = (a, b) => ({ aName: a.name, bName: b.name, n: 2, aWins: 1, bWins: 1, draws: 0, avgMargin: 0, rows: [] });
  const bracket = buildKnockoutBracket(field(8), {}, deadHeat);
  assert.equal(bracket.champion.name, "S00", "with every pairing a dead heat, the top seed must win the bracket");
  for (const r of bracket.rounds)
    for (const m of r.matches)
      assert.equal(m.winner.name, m.a.name,
        "in this bracket the earlier-seeded entrant is always the `a` seat, so it must always advance");
  // And the same field seeded in the OPPOSITE order gives the opposite champion — proof the
  // tie-break reads the seeding it was handed, not the names.
  const flipped = buildKnockoutBracket([...field(8)].reverse(), {}, deadHeat);
  assert.equal(flipped.champion.name, "S07", "seeding is the caller's; the tie-break only consumes it");
});

test("runPair is handed the entrants themselves and a round-folded seed base (D6)", () => {
  const calls = [];
  const spy = (a, b, opts) => { calls.push({ a: a.name, b: b.name, seedBase: opts.seedBase, worlds: opts.worlds }); return fakePair(a, b); };
  buildKnockoutBracket(field(4), { worlds: ["korrath"], seeds: 1, seedBase: 7 }, spy);
  assert.equal(calls.length, 3, "4 entrants -> 3 matches");
  assert.deepEqual(calls.map(c => [c.a, c.b]), [["S00", "S01"], ["S02", "S03"], ["S00", "S02"]]);
  for (const c of calls) assert.deepEqual(c.worlds, ["korrath"], "the caller's own opts must pass through untouched");
  // Same derivation buildSwissBracket already uses for its rounds — hashStr, no clock, no
  // Math.random, so a whole bracket replays byte-for-byte from its competition seed.
  assert.equal(calls[0].seedBase, hashStr("7:knockout:round1"));
  assert.equal(calls[2].seedBase, hashStr("7:knockout:round2"));
  assert.notEqual(calls[0].seedBase, calls[2].seedBase, "a later round must not replay the earlier round's seeds");
});

test("a runPair that returns nothing is a loud failure, not a silent seed-order walkover", () => {
  assert.throws(() => buildKnockoutBracket(field(2), {}, () => undefined), /runPair/);
});

/* ============================================================
   The EXTRACTED Swiss logic, imported straight from pairing.js — the three historical bugs
   ============================================================ */

test("rankStandings ranks by win RATE, not by how many pairings the schedule handed out", () => {
  // Historical bug: standings sorted on absolute win totals, and a bye recipient simply plays one
  // fewer pairing — so the ranking was literally "everyone who avoided a bye, then everyone who
  // didn't". A 2W-2L candidate at 50% finished below a 3W-3L candidate at 50% for nothing but
  // having played more.
  const playedMore = { name: "played-more", wins: 3, losses: 3, draws: 0, byes: 0 };
  const better = { name: "better", wins: 3, losses: 1, draws: 0, byes: 1 };
  assert.equal(rankStandings([playedMore, better])[0].name, "better",
    "a 75% record must outrank a 50% one even though it played fewer pairings");
  // Raw wins break a rate tie, and the name breaks that — the order is total, so the table is
  // reproducible rather than dependent on input order.
  const tieA = { name: "zz", wins: 2, losses: 2, draws: 0, byes: 0 };
  const tieB = { name: "aa", wins: 2, losses: 2, draws: 0, byes: 0 };
  assert.deepEqual(names(rankStandings([tieA, tieB])), ["aa", "zz"]);
  assert.deepEqual(names(rankStandings([tieB, tieA])), ["aa", "zz"], "a rate+wins tie must not depend on input order");
  // A candidate that never played anything at all rates 0, not NaN.
  assert.deepEqual(names(rankStandings([{ name: "idle", wins: 0, losses: 0, draws: 0, byes: 2 }, tieA])), ["zz", "idle"]);
});

test("pairRound backtracks to a zero-repeat matching a plain greedy walk would miss", () => {
  // Historical bug, reproduced by independent review: greedily pairing the two joint leaders first
  // strands the round's one forbidden pair together, even though pairing either leader with one of
  // them instead leaves a perfectly valid zero-repeat matching for the rest.
  const standings = [
    { name: "Aggressive", wins: 3, losses: 1 }, { name: "QuickCommit", wins: 3, losses: 1 },
    { name: "Adaptive", wins: 1, losses: 3 }, { name: "ForceParity", wins: 1, losses: 3 },
  ];
  const { pairs } = pairRound(standings, new Set(["Adaptive::ForceParity"]), new Set());
  const pairKeys = pairs.map(([a, b]) => key(a.name, b.name));
  assert.equal(pairs.length, 2, "4 candidates must produce 2 pairs");
  assert.ok(!pairKeys.includes("Adaptive::ForceParity"),
    `pairRound repeated the one forbidden pair even though a zero-repeat matching existed: got ${pairKeys.join(", ")}`);
});

test("pairRound avoids every avoidable repeat, checked against a brute-force oracle", () => {
  // The property the backtracking search exists to deliver, checked the way it was originally
  // validated during development: generate a field and an already-played set, ask an independent
  // exhaustive search whether ANY zero-repeat matching exists, and if one does, require pairRound
  // to have found one. Seeded (mulberry32, engine/rng.js) so the cases are fixed and reproducible —
  // a failure here is a case you can re-run, not a flake.
  const canAvoid = (pool, played) => {
    if (pool.length < 2) return true;
    const [a, ...rest] = pool;
    return rest.some((b, i) => !played.has(key(a, b)) && canAvoid(rest.filter((_, j) => j !== i), played));
  };
  let checked = 0;
  for (let s = 1; s <= 40; s++) {
    const rnd = mulberry32(s);
    const n = 4 + 2 * Math.floor(rnd() * 4);                       // 4, 6, 8 or 10 — even, so no bye
    const pool = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, wins: Math.floor(rnd() * 4), losses: 0, draws: 0 }));
    const played = new Set();
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) if (rnd() < 0.45) played.add(key(`P${i}`, `P${j}`));
    const { pairs, byeName } = pairRound(pool, played, new Set());
    assert.equal(byeName, null, `seed ${s}: an even field needs no bye`);
    assert.equal(pairs.length, n / 2, `seed ${s}: every candidate must be paired`);
    assert.equal(new Set(pairs.flatMap(([a, b]) => [a.name, b.name])).size, n, `seed ${s}: pairings must be disjoint`);
    if (!canAvoid(pool.map(p => p.name), played)) continue;         // genuinely forced repeats — nothing to prove
    checked++;
    const repeats = pairs.map(([a, b]) => key(a.name, b.name)).filter(k => played.has(k));
    assert.deepEqual(repeats, [], `seed ${s}: pairRound chose ${repeats.join(", ")} although a zero-repeat matching existed`);
  }
  assert.ok(checked >= 20, `fixture sanity: only ${checked} of the generated rounds had an avoidable repeat to check`);
});

test("pairRound still completes (with a forced repeat) when a zero-repeat matching is impossible", () => {
  // 4 candidates who have all already played each other leave no zero-repeat option anywhere —
  // pairRound must still return a complete pairing (via its greedy fallback) rather than hang or throw.
  const standings = ["A", "B", "C", "D"].map(name => ({ name, wins: 0, losses: 0 }));
  const played = new Set(["A::B", "A::C", "A::D", "B::C", "B::D", "C::D"]);
  const { pairs } = pairRound(standings, played, new Set());
  assert.equal(pairs.length, 2, "must still produce a complete pairing even with no zero-repeat option");
  assert.equal(new Set(pairs.flatMap(([a, b]) => [a.name, b.name])).size, 4, "every candidate must appear in exactly one pair");
});

test("the round-1 bye doesn't depend on the order candidates were listed in", () => {
  // Historical bug: pairRound sorted on wins alone and every round-1 standing is 0-0, so a stable
  // sort left the loop taking the LAST-LISTED candidate — listing order alone decided the bye.
  const rows = order => order.map(n => ({ name: n, wins: 0, losses: 0, draws: 0, byes: 0 }));
  const byeFor = order => pairRound(rows(order), new Set(), new Set()).byeName;
  const forward = byeFor(["A", "B", "C", "D", "E"]);
  assert.equal(byeFor(["E", "D", "C", "B", "A"]), forward, "listing the same field in reverse changed the bye");
  assert.equal(byeFor(["C", "A", "E", "B", "D"]), forward, "listing the same field shuffled changed the bye");
});

test("byes rotate: nobody gets a second bye while another candidate hasn't had one", () => {
  const bracket = buildSwissBracket(field(5), 5, { worlds: ["korrath"], seeds: 1 }, fakePair);
  const byes = bracket.roundsLog.map(r => r.byeName);
  assert.equal(new Set(byes).size, 5, `every candidate should get exactly one bye across 5 rounds of 5, got: ${byes.join(", ")}`);
});

test("a bye is scorable-neutral: it adds to nobody's wins or losses, only its own bye count", () => {
  // Historical bug: a bye was credited as a full pairing's worth of wins with zero losses, which let
  // a candidate that never fought at all tie or outrank one that won a genuine match.
  const opts = { worlds: ["ferros", "vesper"], seeds: 2 };
  const bracket = buildSwissBracket(field(3), 3, opts, fakePair);
  const totalWins = bracket.standings.reduce((s, r) => s + r.wins, 0);
  const totalLosses = bracket.standings.reduce((s, r) => s + r.losses, 0);
  assert.equal(totalWins, totalLosses, "every win must have a matching loss somewhere — a bye must add to neither");
  assert.equal(bracket.standings.reduce((s, r) => s + r.byes, 0), 3, "3 rounds of an odd field hand out 3 byes");
  // byeMatchCount stays informational — "how big a real pairing this round would have been" — and
  // must be reported accurately, just never added to anyone's standing.
  const expectedMatchCount = opts.worlds.length * opts.seeds * 2;
  assert.equal(bracket.byeMatchCount, expectedMatchCount);
  assert.equal(bracket.roundsLog.find(r => r.byeName).byeMatchCount, expectedMatchCount);
});

test("buildSwissBracket runs the whole schedule through the injected runPair, deterministically", () => {
  const opts = { worlds: ["korrath"], seeds: 1, seedBase: 3 };
  const once = buildSwissBracket(field(8), 3, opts, fakePair);
  const twice = buildSwissBracket(field(8), 3, opts, fakePair);
  assert.equal(JSON.stringify(once), JSON.stringify(twice), "two identical Swiss brackets diverged");
  assert.equal(once.roundsLog.length, 3);
  for (const r of once.roundsLog) assert.equal(r.matches.length, 4, "8 candidates -> 4 pairings a round, no bye");
  // No pairing repeats while unplayed opponents remain — the guarantee the backtracking buys.
  const seen = new Set();
  for (const r of once.roundsLog)
    for (const m of r.matches) {
      assert.ok(!seen.has(key(m.aName, m.bName)), `pairing ${m.aName}/${m.bName} repeated across rounds`);
      seen.add(key(m.aName, m.bName));
    }
});

/* ---------- purity: this module is imported by a browser Worker in the next stage ---------- */

test("pairing.js names no browser global, no clock and no unseeded randomness — anywhere, comments included", () => {
  // test/duelCore.test.js's idiom, at engine-purity.test.js's strictness ("not even in a comment"):
  // this module is imported by a browser Worker in the next stage AND has to replay byte-for-byte
  // from a competition seed (D6), so both halves are worth pinning textually rather than only
  // behaviourally.
  const src = readFileSync(new URL("../pairing.js", import.meta.url), "utf8");
  for (const banned of ["document", "window", "process", "localStorage", "Math.random", "Date.now"]) {
    const hits = [...src.matchAll(new RegExp(`\\b${banned.replace(".", "\\.")}\\b`, "g"))];
    assert.equal(hits.length, 0, `pairing.js references \`${banned}\` — it must stay Worker-importable and deterministic`);
  }
});
