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
import {
  buildJob, matchCount, matchSeedFor, shapeResultsTable, eloFromRows,
  ARCHETYPE_OPTIONS, ROSTER_FACTION_OPTIONS, resolveEntrantPick, ratingLookup,
  hasRatingHistory, shapeRosterRow, shapeStandingsTable,
} from "../competition.js";
import { duelSeed } from "../tools/duelCore.js";
import { INITIAL_RATING } from "../elo.js";
import { ARCHETYPES } from "../engine/aiArchetypes.js";
import { createLedger, addRosterEntry, recordCompetition } from "../competitionLedger.js";

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
