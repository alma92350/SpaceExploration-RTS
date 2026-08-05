/* ============================================================
   Guards for competition.js's PURE exports only — job construction, per-match seed derivation,
   worker-row -> display-table shaping, and Elo folding. No DOM, no real Worker: the same
   discipline test/duelCore.test.js and test/elo.test.js already hold themselves to for their own
   pure modules (docs/competitions-and-elo.md Phase 1). competition.js's DOM-rendering half (the
   actual Quick Duel / Tournament / Roster / Standings screens) is exercised by each stage's live
   browser verification instead — see CONTRIBUTING.md's C10 note on why the two halves are split in
   the first place. Phase 2 added the roster/standings shaping section; Phase 3 the tournament
   estimate/job/standings/bracket section at the bottom.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJob, matchCount, matchSeedFor, shapeResultsTable, eloFromRows,
  ARCHETYPE_OPTIONS, ROSTER_FACTION_OPTIONS, resolveEntrantPick, ratingLookup,
  hasRatingHistory, shapeRosterRow, shapeStandingsTable,
  TOURNAMENT_FORMAT_OPTIONS, SECONDS_PER_MATCH, tournamentPairingCount, tournamentEstimate,
  buildTournamentJob, seedFieldByRating, tournamentProgressLabel, tournamentStandingsRows,
  shapeTournamentStandings, shapeBracketView,
} from "../competition.js";
import { duelSeed } from "../tools/duelCore.js";
import { INITIAL_RATING } from "../elo.js";
import { ARCHETYPES } from "../engine/aiArchetypes.js";
import { createLedger, addRosterEntry, recordCompetition } from "../competitionLedger.js";
import { buildSwissBracket, buildKnockoutBracket, knockoutMatchCount, swissRoundCount } from "../pairing.js";

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
    entrantA: { name: "Alpha", strategy: "aggressive", archetype: null },
    entrantB: { name: "Beta", strategy: "economic", archetype: null },
    difficulty: "hard",
    worlds: ["ferros", "korrath"],
    seeds: 3,
    seedBase: 42,
  });
});

/* ---------- buildJob: archetype (D3) ---------- */

test("buildJob carries a valid archetype key straight through, per entrant, independently", () => {
  const job = buildJob({
    ...fixedCfg(),
    entrantA: { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
    entrantB: { name: "Beta", strategy: "economic", archetype: "economist" },
  });
  assert.equal(job.entrantA.archetype, "rusher");
  assert.equal(job.entrantB.archetype, "economist");
});

test("buildJob defaults a missing archetype to null -- byte-identical to before archetype existed as an option", () => {
  const job = buildJob(fixedCfg());
  assert.equal(job.entrantA.archetype, null);
  assert.equal(job.entrantB.archetype, null);
});

test("buildJob coerces an unrecognised archetype key to null rather than trusting it verbatim", () => {
  const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha", strategy: "default", archetype: "not-a-real-archetype" } });
  assert.equal(job.entrantA.archetype, null);
});

test("buildJob coerces a reserved/inherited key (__proto__, constructor, prototype) to null, not to the key itself", () => {
  // Regression: knownArchetype used to be `(a && ARCHETYPES[a]) ? a : null` -- a truthy
  // bracket-access, which for a plain object resolves "__proto__"/"constructor"/"prototype" to an
  // inherited (always-truthy) property rather than "not a real key". That let a hostile archetype
  // string survive into the job as-is, contradicting this function's own doc comment ("anything
  // else -- missing, blank, unknown -- becomes null"). Object.hasOwn is the fix.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha", strategy: "default", archetype: key } });
    assert.equal(job.entrantA.archetype, null, `"${key}" must coerce to null, not survive as "${key}"`);
  }
});

test("buildJob treats every ARCHETYPES key as valid, not just one", () => {
  for (const key of Object.keys(ARCHETYPES)) {
    const job = buildJob({ ...fixedCfg(), entrantA: { name: "Alpha", strategy: "default", archetype: key } });
    assert.equal(job.entrantA.archetype, key);
  }
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

/* ============================================================
   PHASE 2: roster/standings shaping and the roster-vs-adhoc entrant resolution. Same "no DOM, no
   Worker" discipline as everything above -- competitionLedger.js's own functions are real, DOM-free
   exports, so these tests build a live ledger with them directly rather than mocking anything.
   ============================================================ */

/* ---------- ARCHETYPE_OPTIONS / ROSTER_FACTION_OPTIONS: derived tables, not a hardcoded copy ---------- */

test("ARCHETYPE_OPTIONS derives its real entries from engine/aiArchetypes.js's ARCHETYPES, not a hardcoded duplicate list", () => {
  const keys = ARCHETYPE_OPTIONS.filter(o => o.mult !== null).map(o => o.mult);
  assert.deepEqual(keys.sort(), Object.keys(ARCHETYPES).sort());
  for (const opt of ARCHETYPE_OPTIONS) {
    if (opt.mult === null) continue;
    assert.equal(opt.label, ARCHETYPES[opt.mult].name, `${opt.mult}'s label must be its real ARCHETYPES name, not a hardcoded copy`);
  }
});

test("ARCHETYPE_OPTIONS offers a null \"no override\" choice first", () => {
  assert.equal(ARCHETYPE_OPTIONS[0].mult, null);
});

test("ROSTER_FACTION_OPTIONS covers every playable faction plus neutral, with no hardcoded label copy", () => {
  const keys = ROSTER_FACTION_OPTIONS.map(o => o.mult);
  assert.ok(keys.includes("neutral"), "a roster entry can default to Unaligned, unlike the skirmish setup screen's own FACTION_OPTIONS");
  assert.ok(keys.includes("frontier") && keys.includes("miners") && keys.includes("syndicate"));
  assert.equal(new Set(keys).size, keys.length, "no duplicate faction entries");
});

/* ---------- resolveEntrantPick: the roster-vs-adhoc entrant resolution ---------- */

test('resolveEntrantPick in "roster" mode reads the CURRENT roster entry back by name', () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate" });
  const resolved = resolveEntrantPick({ mode: "roster", rosterName: "Blitz" }, ledger);
  assert.deepEqual(resolved, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", isNew: false });
});

test('resolveEntrantPick in "roster" mode throws a clear error when the picked name is no longer on the roster', () => {
  const ledger = createLedger();
  assert.throws(() => resolveEntrantPick({ mode: "roster", rosterName: "Ghost" }, ledger), /roster/i);
});

test('resolveEntrantPick in "new" mode trims the name and defaults strategy/archetype/faction, marking isNew', () => {
  const resolved = resolveEntrantPick({ mode: "new", name: "  Fresh  " }, createLedger());
  assert.deepEqual(resolved, { name: "Fresh", strategy: "default", archetype: null, faction: "neutral", isNew: true });
});

test('resolveEntrantPick in "new" mode carries a chosen strategy/archetype/faction through unchanged', () => {
  const resolved = resolveEntrantPick(
    { mode: "new", name: "Fresh", strategy: "economic", archetype: "balanced", faction: "miners" }, createLedger());
  assert.deepEqual(resolved, { name: "Fresh", strategy: "economic", archetype: "balanced", faction: "miners", isNew: true });
});

test('resolveEntrantPick defaults to "new" semantics when mode is missing, unrecognised, or the pick itself is absent', () => {
  assert.equal(resolveEntrantPick({ name: "Fresh" }, createLedger()).isNew, true);
  assert.equal(resolveEntrantPick({ mode: "bogus", name: "Fresh" }, createLedger()).isNew, true);
  assert.equal(resolveEntrantPick(undefined, createLedger()).isNew, true);
});

/* ---------- ratingLookup ---------- */

test("ratingLookup returns the table's own entry when the entrant has played this bracket", () => {
  const table = { Alpha: { rating: 1300, games: 5 } };
  assert.deepEqual(ratingLookup(table, "Alpha"), { rating: 1300, games: 5 });
});

test("ratingLookup returns INITIAL_RATING at 0 games for an entrant absent from the table", () => {
  assert.deepEqual(ratingLookup({}, "Nobody"), { rating: INITIAL_RATING, games: 0 });
});

test("ratingLookup returns the same default when the table itself is undefined (bracket never played)", () => {
  assert.deepEqual(ratingLookup(undefined, "Nobody"), { rating: INITIAL_RATING, games: 0 });
});

test("ratingLookup does not mistake an inherited Object.prototype member for a real rating", () => {
  assert.deepEqual(ratingLookup({}, "toString"), { rating: INITIAL_RATING, games: 0 });
});

/* ---------- hasRatingHistory ---------- */

test("hasRatingHistory is true once an entrant has a rating entry in ANY bracket, false beforehand", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  assert.equal(hasRatingHistory(ledger, "Alpha"), false);
  recordCompetition(ledger, { difficulty: "hard", aName: "Alpha", bName: "Beta", rows: [{ aName: "Alpha", bName: "Beta", winner: "a" }] });
  assert.equal(hasRatingHistory(ledger, "Alpha"), true);
  assert.equal(hasRatingHistory(ledger, "Beta"), true);
  assert.equal(hasRatingHistory(ledger, "Gamma"), false, "an entrant that never even played has no history");
});

/* ---------- shapeRosterRow ---------- */

test("shapeRosterRow maps strategy/archetype/faction keys to their real display names", () => {
  const row = shapeRosterRow({ name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", createdAt: 1 });
  assert.equal(row.name, "Blitz");
  assert.equal(row.strategy, "Aggressive");
  assert.equal(row.archetype, "Rusher");
  assert.equal(row.faction, "Syndicate");
});

test("shapeRosterRow shows a clear placeholder for a null (world-default) archetype", () => {
  const row = shapeRosterRow({ name: "Plain", strategy: "default", archetype: null, faction: "neutral" });
  assert.equal(typeof row.archetype, "string");
  assert.notEqual(row.archetype, "");
});

test("shapeRosterRow falls back to the world-default placeholder for a reserved/inherited archetype key too", () => {
  // Regression: a truthy `ARCHETYPES[entry.archetype]` bracket-access resolved "__proto__" to
  // Object.prototype (always truthy, no .name), which would have rendered "undefined" instead of
  // "World default" -- competitionLedger.js's own roster guard means a real roster entry can never
  // actually carry this value, but the display function shouldn't depend on that upstream guard to
  // stay correct on its own.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const row = shapeRosterRow({ name: "Hostile", strategy: "default", archetype: key, faction: "neutral" });
    assert.equal(row.archetype, "World default", `"${key}" must render the placeholder, not "undefined"`);
  }
});

/* ---------- shapeStandingsTable: formats standingsFor's own rows, never recomputes them ---------- */

test("shapeStandingsTable formats standingsFor's own fields without recomputing any of them", () => {
  const standings = [{ name: "Alpha", rating: 1234.6, games: 7, wins: 5, losses: 1, draws: 1, avgMargin: 12.34, provisional: true }];
  assert.deepEqual(shapeStandingsTable(standings), [
    { name: "Alpha", rating: 1235, games: 7, record: "5-1-1", avgMargin: "12.3", provisional: true },
  ]);
});

test("shapeStandingsTable preserves standingsFor's own sort order (never re-sorts)", () => {
  const standings = [
    { name: "B", rating: 1300, games: 1, wins: 1, losses: 0, draws: 0, avgMargin: 5, provisional: true },
    { name: "A", rating: 1200, games: 1, wins: 0, losses: 1, draws: 0, avgMargin: -5, provisional: true },
  ];
  assert.deepEqual(shapeStandingsTable(standings).map(r => r.name), ["B", "A"]);
});

/* ============================================================
   PHASE 3: the Tournament tab's own pure logic -- the up-front cost estimate for all three
   formats, tournament-job construction from a field + format + options, and the standings/bracket
   shaping the results view renders. Same "no DOM, no Worker" discipline as everything above; the
   bracket/standings fixtures are REAL pairing.js schedules run with a synthetic runPair (the idiom
   test/pairing.test.js already uses and explains), so the shaping is tested against the exact shape
   competitionWorker.js posts rather than a hand-written guess at it.
   ============================================================ */

// The same deterministic stand-in test/pairing.test.js uses: the alphabetically-earlier name wins
// 2-0, so a whole schedule resolves predictably with nothing simulated.
const fakePair = (a, b) => ({
  aName: a.name, bName: b.name, draws: 0,
  aWins: a.name < b.name ? 2 : 0,
  bWins: a.name < b.name ? 0 : 2,
  avgMargin: a.name < b.name ? 5 : -5,
});
const tField = n => Array.from({ length: n }, (_, i) => ({ name: `S${String(i).padStart(2, "0")}`, strategy: "default", archetype: null }));

/* ---------- TOURNAMENT_FORMAT_OPTIONS ---------- */

test("TOURNAMENT_FORMAT_OPTIONS offers exactly the three formats pairing.js can schedule, in optionGroup's own shape", () => {
  assert.deepEqual(TOURNAMENT_FORMAT_OPTIONS.map(o => o.mult), ["round-robin", "swiss", "knockout"]);
  for (const o of TOURNAMENT_FORMAT_OPTIONS) {
    assert.equal(typeof o.label, "string");
    assert.ok(o.label.length, "every format needs a label for the picker");
    assert.equal(typeof o.note, "string", "optionGroup renders a note under each label");
  }
});

/* ---------- tournamentPairingCount: the per-format pairing arithmetic ---------- */

test("tournamentPairingCount: a round-robin is n x (n-1) / 2 pairings", () => {
  for (const [n, expected] of [[2, 1], [3, 3], [4, 6], [6, 15], [8, 28]])
    assert.equal(tournamentPairingCount({ format: "round-robin", entrants: n }), expected, `n=${n}`);
});

test("tournamentPairingCount: a knockout is ALWAYS n-1 pairings, byes or no byes", () => {
  for (let n = 2; n <= 17; n++) {
    assert.equal(tournamentPairingCount({ format: "knockout", entrants: n }), n - 1, `n=${n}`);
    // Not a second copy of the formula -- pairing.js's own knockoutMatchCount is the source.
    assert.equal(tournamentPairingCount({ format: "knockout", entrants: n }), knockoutMatchCount(n), `n=${n}`);
  }
});

test("tournamentPairingCount: Swiss is roundCount x floor(n/2), defaulting to max(3, ceil(log2 n))", () => {
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 4 }), 3 * 2, "ceil(log2 4) = 2, floored at 3 rounds");
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 5 }), 3 * 2, "an odd field pairs floor(n/2) per round -- the bye is not a pairing");
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 9 }), 4 * 4, "ceil(log2 9) = 4");
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 17 }), 5 * 8, "ceil(log2 17) = 5");
  for (const n of [4, 5, 9, 17])
    assert.equal(tournamentPairingCount({ format: "swiss", entrants: n }), swissRoundCount(n) * Math.floor(n / 2), `n=${n}`);
});

test("tournamentPairingCount: an explicit Swiss round override replaces the default", () => {
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 6, rounds: 2 }), 2 * 3);
  assert.equal(tournamentPairingCount({ format: "swiss", entrants: 6, rounds: 7 }), 7 * 3);
  // The override is Swiss-only -- pairing.js's other two formats have no round count to override.
  assert.equal(tournamentPairingCount({ format: "round-robin", entrants: 6, rounds: 9 }), 15);
  assert.equal(tournamentPairingCount({ format: "knockout", entrants: 6, rounds: 9 }), 5);
});

test("tournamentPairingCount refuses an unknown format and a field too small to run", () => {
  assert.throws(() => tournamentPairingCount({ format: "battle-royale", entrants: 4 }), /format/i);
  assert.throws(() => tournamentPairingCount({ format: "swiss", entrants: 1 }), /at least 2/i);
});

/* ---------- tournamentEstimate: the "is this a 30-second run or a 20-minute one" line ---------- */

test("tournamentEstimate counts MATCHES, not pairings: pairings x worlds x seeds x 2 side-swapped directions", () => {
  const est = tournamentEstimate({ format: "round-robin", entrants: 4, worlds: ["ferros", "korrath"], seeds: 1 });
  assert.equal(est.pairings, 6);
  assert.equal(est.matches, 6 * 2 * 1 * 2);
  assert.equal(est.seconds, est.matches * SECONDS_PER_MATCH);
});

test("tournamentEstimate agrees with Quick Duel's own matchCount for a single pairing's worth of work", () => {
  // A 2-entrant round-robin IS one Quick Duel, so the two estimates must not disagree.
  const est = tournamentEstimate({ format: "round-robin", entrants: 2, worlds: ["ferros", "korrath"], seeds: 3 });
  const job = buildJob(fixedCfg());
  assert.equal(est.matches, matchCount(job));
});

test("tournamentEstimate renders seconds under a minute and minutes above it", () => {
  const quick = tournamentEstimate({ format: "round-robin", entrants: 4, worlds: ["ferros", "korrath"], seeds: 1 });
  assert.equal(quick.seconds, 36);
  assert.match(quick.timeText, /^36 s$/, "under a minute reads in seconds");
  assert.match(quick.text, /24 matches/);

  const long = tournamentEstimate({ format: "knockout", entrants: 6, worlds: ["a", "b", "c", "d"], seeds: 2 });
  assert.equal(long.matches, 5 * 4 * 2 * 2);
  assert.equal(long.seconds, 120);
  assert.match(long.timeText, /^2 min$/, "a minute or more reads in minutes");
  assert.match(long.text, /80 matches/);
});

test("SECONDS_PER_MATCH sits between the doc's measured elimination and full-clock match costs", () => {
  // docs/competitions-and-elo.md's own measured table: ~1.0 s resolved by elimination, ~1.8 s worst
  // case when a match runs the full 40-sim-minute clock. The estimate constant is a documented
  // average of those two, not an invented number.
  assert.ok(SECONDS_PER_MATCH >= 1.0 && SECONDS_PER_MATCH <= 1.8, `got ${SECONDS_PER_MATCH}`);
});

/* ---------- buildTournamentJob: the job message competitionWorker.js's tournament kind expects ---------- */

const fixedTournamentCfg = () => ({
  format: "swiss",
  field: [
    { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
    { name: "Beta", strategy: "economic", archetype: null },
    { name: "Gamma", strategy: "default" },
  ],
  difficulty: "hard",
  worlds: ["ferros", "korrath"],
  seeds: 2,
  seedBase: 42,
});

test("buildTournamentJob produces exactly the tournament job message shape, and is deterministic", () => {
  const job = buildTournamentJob(fixedTournamentCfg());
  assert.deepEqual(job, {
    kind: "tournament",
    format: "swiss",
    field: [
      { name: "Alpha", strategy: "aggressive", archetype: "rusher" },
      { name: "Beta", strategy: "economic", archetype: null },
      { name: "Gamma", strategy: "default", archetype: null },
    ],
    difficulty: "hard",
    worlds: ["ferros", "korrath"],
    seeds: 2,
    seedBase: 42,
  });
  assert.deepEqual(buildTournamentJob(fixedTournamentCfg()), job, "the same config must build a byte-identical job");
});

test("buildTournamentJob carries a Swiss round override only for Swiss, and only when given", () => {
  assert.equal("rounds" in buildTournamentJob(fixedTournamentCfg()), false, "an unset round count is the worker's own default");
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), rounds: 5 }).rounds, 5);
  assert.equal("rounds" in buildTournamentJob({ ...fixedTournamentCfg(), format: "knockout", rounds: 5 }), false,
    "a knockout has no round count to override -- n-1 pairings whatever happens");
  assert.equal("rounds" in buildTournamentJob({ ...fixedTournamentCfg(), format: "round-robin", rounds: 5 }), false);
});

test("buildTournamentJob keeps ONE shared difficulty for the whole tournament (D2), never a per-entrant one", () => {
  const job = buildTournamentJob({
    ...fixedTournamentCfg(),
    field: fixedTournamentCfg().field.map(e => ({ ...e, difficulty: "brutal" })),
  });
  assert.equal(job.difficulty, "hard");
  for (const entrant of job.field)
    assert.deepEqual(Object.keys(entrant).sort(), ["archetype", "name", "strategy"],
      "an entrant carries name/strategy/archetype only -- a per-entrant difficulty would break the bracket's whole fairness rule");
});

test("buildTournamentJob requires at least 2 entrants and rejects duplicate names", () => {
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), field: [] }), /at least 2/i);
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), field: [{ name: "Solo" }] }), /at least 2/i);
  assert.throws(() => buildTournamentJob({
    ...fixedTournamentCfg(), field: [{ name: "Alpha" }, { name: " Alpha " }, { name: "Beta" }],
  }), /same name|duplicate|different/i);
});

test("buildTournamentJob trims names, defaults strategy, and coerces an unknown archetype to null", () => {
  const job = buildTournamentJob({
    ...fixedTournamentCfg(),
    field: [{ name: "  Alpha  " }, { name: "Beta", archetype: "not-a-real-archetype" }, { name: "Gamma", archetype: "__proto__" }],
  });
  assert.deepEqual(job.field, [
    { name: "Alpha", strategy: "default", archetype: null },
    { name: "Beta", strategy: "default", archetype: null },
    { name: "Gamma", strategy: "default", archetype: null },
  ]);
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), field: [{ name: "  " }, { name: "Beta" }] }), /name/i);
});

test("buildTournamentJob rejects an unknown format and an empty world list, before any Worker spins up", () => {
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), format: "battle-royale" }), /format/i);
  assert.throws(() => buildTournamentJob({ ...fixedTournamentCfg(), worlds: [] }), /world/i);
});

test("buildTournamentJob copies the field and worlds arrays rather than aliasing the caller's", () => {
  const cfg = fixedTournamentCfg();
  const job = buildTournamentJob(cfg);
  job.worlds.push("vesper");
  job.field.push({ name: "Intruder", strategy: "default", archetype: null });
  assert.equal(cfg.worlds.length, 2);
  assert.equal(cfg.field.length, 3);
});

test("buildTournamentJob clamps seeds and coerces seedBase the same way buildJob already does", () => {
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), seeds: 2.9 }).seeds, 2);
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), seeds: 0 }).seeds, 1);
  assert.equal(buildTournamentJob({ ...fixedTournamentCfg(), seedBase: -1 }).seedBase, 0xFFFFFFFF);
});

/* ---------- seedFieldByRating: the knockout's seeding, which pairing.js deliberately never invents ---------- */

test("seedFieldByRating orders a knockout field strongest-first off the bracket's own ratings table", () => {
  const table = { Alpha: { rating: 1180, games: 12 }, Beta: { rating: 1320, games: 9 }, Gamma: { rating: 1240, games: 4 } };
  const seeded = seedFieldByRating([{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }], table);
  assert.deepEqual(seeded.map(e => e.name), ["Beta", "Gamma", "Alpha"]);
});

test("seedFieldByRating falls back to name order for anyone unrated, and never mutates its input", () => {
  const field = [{ name: "Zeta" }, { name: "Alpha" }, { name: "Mu" }];
  const seeded = seedFieldByRating(field, {});
  assert.deepEqual(seeded.map(e => e.name), ["Alpha", "Mu", "Zeta"], "an unrated field seeds alphabetically, deterministically");
  assert.deepEqual(field.map(e => e.name), ["Zeta", "Alpha", "Mu"], "the caller's array must be left alone");
  // An entrant with a rating outranks an unrated one only if that rating is actually higher --
  // ratingLookup's own INITIAL_RATING default is what an unrated entrant is compared at.
  const mixed = seedFieldByRating([{ name: "Zeta" }, { name: "Alpha" }], { Zeta: { rating: INITIAL_RATING + 100, games: 3 } });
  assert.deepEqual(mixed.map(e => e.name), ["Zeta", "Alpha"]);
});

/* ---------- tournamentProgressLabel: real round/pairing granularity, not one opaque spinner ---------- */

test("tournamentProgressLabel names the round AND the pairing for a multi-round format", () => {
  const label = tournamentProgressLabel({ format: "swiss", round: 2, roundTotal: 4, pairing: 3, pairingTotal: 8, completed: 12, total: 128 });
  assert.match(label, /round 2 of 4/i);
  assert.match(label, /pairing 3 of 8/i);
  assert.match(label, /12 of 128/, "the match counter still has to be visible");
});

test("tournamentProgressLabel drops the round clause for a round-robin, which is one flat round", () => {
  const label = tournamentProgressLabel({ format: "round-robin", round: 1, roundTotal: 1, pairing: 5, pairingTotal: 15, completed: 20, total: 60 });
  assert.match(label, /pairing 5 of 15/i);
  assert.doesNotMatch(label, /round 1 of 1/i);
});

/* ---------- tournamentStandingsRows / shapeTournamentStandings ---------- */

test("tournamentStandingsRows tallies completed pairings into wins/losses/draws, ranked best-first", () => {
  const rows = tournamentStandingsRows(["Alpha", "Beta", "Gamma"], [
    { aName: "Alpha", bName: "Beta", aWins: 3, bWins: 1, draws: 0 },
    { aName: "Alpha", bName: "Gamma", aWins: 2, bWins: 2, draws: 0 },
  ]);
  assert.deepEqual(rows.map(r => r.name), ["Alpha", "Gamma", "Beta"], "ranked by win rate, ties broken the same way pairing.js's rankStandings does");
  const alpha = rows.find(r => r.name === "Alpha");
  assert.deepEqual([alpha.wins, alpha.losses, alpha.draws, alpha.byes], [5, 3, 0, 0]);
});

test("tournamentStandingsRows lists an entrant that has not played yet at 0-0-0 rather than omitting it", () => {
  const rows = tournamentStandingsRows(["Alpha", "Beta", "Gamma"], [{ aName: "Alpha", bName: "Beta", aWins: 1, bWins: 0, draws: 0 }]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(r => r.name === "Gamma"), { name: "Gamma", wins: 0, losses: 0, draws: 0, byes: 0 });
});

test("tournamentStandingsRows counts a bye as a bye and NEVER as a win (pairing.js's own rule)", () => {
  const rows = tournamentStandingsRows(["Alpha", "Beta", "Gamma"],
    [{ aName: "Alpha", bName: "Beta", aWins: 2, bWins: 0, draws: 0 }], ["Gamma"]);
  const gamma = rows.find(r => r.name === "Gamma");
  assert.deepEqual([gamma.wins, gamma.losses, gamma.draws, gamma.byes], [0, 0, 0, 1]);
  assert.equal(rows[0].name, "Alpha", "a candidate that only sat out a round can't outrank one that won a real pairing");
});

test("tournamentStandingsRows reproduces buildSwissBracket's OWN standings from the pairings it reports", () => {
  // The live standings the progress view builds pairing-by-pairing must land on exactly the table
  // the finished bracket reports -- otherwise the number moving on screen means something different
  // from the number the results view finally shows.
  const bracket = buildSwissBracket(tField(5), 3, { worlds: ["korrath"], seeds: 1 }, fakePair);
  const pairings = bracket.roundsLog.flatMap(r => r.matches);
  const byeNames = bracket.roundsLog.map(r => r.byeName).filter(Boolean);
  const live = tournamentStandingsRows(tField(5).map(e => e.name), pairings, byeNames);
  assert.deepEqual(live, bracket.standings.map(r => ({ name: r.name, wins: r.wins, losses: r.losses, draws: r.draws, byes: r.byes })));
});

test("shapeTournamentStandings formats a row for display without recomputing any of it", () => {
  assert.deepEqual(shapeTournamentStandings([{ name: "Alpha", wins: 5, losses: 3, draws: 1, byes: 2 }]), [
    { name: "Alpha", record: "5-3-1", wins: 5, losses: 3, draws: 1, byes: 2 },
  ]);
});

test("shapeTournamentStandings preserves its input order (the ranking is tournamentStandingsRows' job)", () => {
  const rows = [{ name: "B", wins: 0, losses: 1, draws: 0, byes: 0 }, { name: "A", wins: 1, losses: 0, draws: 0, byes: 0 }];
  assert.deepEqual(shapeTournamentStandings(rows).map(r => r.name), ["B", "A"]);
});

/* ---------- shapeBracketView: the knockout picture, shaped off a REAL pairing.js bracket ---------- */

test("shapeBracketView turns a finished bracket into one column per round, ending in a champion", () => {
  const bracket = buildKnockoutBracket(tField(4), {}, fakePair);
  const view = shapeBracketView(bracket);
  assert.equal(view.champion, "S00");
  assert.equal(view.rounds.length, 2);
  assert.deepEqual(view.rounds.map(r => r.round), [1, 2]);
  assert.deepEqual(view.rounds.map(r => r.matches.length), [2, 1]);
  assert.deepEqual(view.rounds[1].matches[0], {
    round: 2, a: "S00", b: "S02", bye: false, winner: "S00", aWon: true, bWon: false, score: "2-0",
  });
});

test("shapeBracketView names the closing rounds Final/Semifinals/Quarterfinals, numbering the rest", () => {
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(2), {}, fakePair)).rounds.map(r => r.title), ["Final"]);
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(4), {}, fakePair)).rounds.map(r => r.title), ["Semifinals", "Final"]);
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(8), {}, fakePair)).rounds.map(r => r.title),
    ["Quarterfinals", "Semifinals", "Final"]);
  assert.deepEqual(shapeBracketView(buildKnockoutBracket(tField(16), {}, fakePair)).rounds.map(r => r.title),
    ["Round 1", "Quarterfinals", "Semifinals", "Final"]);
});

test("shapeBracketView renders a non-power-of-two field's first-round byes as visible BYE slots", () => {
  // 6 entrants: nextPow2(6) - 6 = 2 byes off the top, then two real matches (pairing.js's own rule).
  const view = shapeBracketView(buildKnockoutBracket(tField(6), {}, fakePair));
  const round1 = view.rounds[0].matches;
  assert.equal(round1.length, 4);
  assert.deepEqual(round1.filter(m => m.bye).map(m => m.a), ["S00", "S01"]);
  for (const m of round1.filter(m => m.bye)) {
    assert.equal(m.b, null, "a bye has no opponent -- the view has to say so rather than render an empty name");
    assert.equal(m.winner, m.a, "a bye advances its own entrant");
    assert.equal(m.aWon, true);
    assert.equal(m.bWon, false);
  }
  assert.equal(view.rounds.reduce((s, r) => s + r.matches.filter(m => !m.bye).length, 0), knockoutMatchCount(6),
    "the rendered bracket must show exactly the n-1 matches that really ran");
});

test("shapeBracketView marks exactly one winner per played match, and it is the entrant that advanced", () => {
  const bracket = buildKnockoutBracket(tField(5), {}, fakePair);
  const view = shapeBracketView(bracket);
  for (const round of view.rounds)
    for (const m of round.matches) {
      assert.equal(m.aWon !== m.bWon, true, `${m.a}/${m.b}: exactly one side may be flagged as the winner`);
      assert.equal(m.winner, m.aWon ? m.a : m.b);
    }
  const finalMatch = view.rounds.at(-1).matches[0];
  assert.equal(view.champion, finalMatch.winner, "the champion is whoever won the final, never re-derived some other way");
});

test("shapeBracketView reads names only -- it never assumes the worker shipped the match rows back inside the tree", () => {
  // competitionWorker.js posts the bracket with each pairing's rows stripped out (they travel once,
  // in the pairings list, for the ledger). The view must be shapeable from what actually arrives.
  const bracket = buildKnockoutBracket(tField(5), {}, fakePair);
  const lean = JSON.parse(JSON.stringify(bracket));
  for (const r of lean.rounds) for (const m of r.matches) if (m.result) delete m.result.rows;
  assert.deepEqual(shapeBracketView(lean), shapeBracketView(bracket));
});
