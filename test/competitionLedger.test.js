/* ============================================================
   competitionLedger.js — docs/competitions-and-elo.md Phase 2, D8. The ledger is a real,
   persisted, untrusted-input boundary (localStorage AND a hand-editable/importable file), so this
   suite mirrors test/save-hardening.test.js's and test/sanitize.test.js's own assertion STYLE, not
   just their existence: throw-with-a-clear-reason for structural hazards, silent coercion for
   merely-wrong shapes, and — for the __proto__ hazard specifically — proving nothing was actually
   polluted, not just that a call threw.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMPETITION_VERSION, createLedger, addRosterEntry, removeRosterEntry, recordCompetition,
  standingsFor, sanitizeLedgerStructure, exportLedger, importLedgerJSON,
  loadLedgerFromStorage, saveLedgerToStorage,
  seasonSummary, archiveSeason, seasonStandings, MAX_SEASON_LABEL,
  startGauntlet, recordGauntletMatch,
} from "../competitionLedger.js";
import { PROVISIONAL_GAMES } from "../elo.js";

// A single, valid match row shaped exactly like competitionWorker.js's own "done" rows field
// (competition.js's fixedRows() fixture uses the identical shape) — every field a real row
// carries, so tests that don't care about the extra fields can still spread over it realistically.
const row = (aName, bName, winner, margin = 0) => ({
  world: "ferros", seed: 1, difficulty: "medium", swapAsym: false,
  aName, aStrategy: "default", bName, bStrategy: "default",
  aDifficulty: "medium", bDifficulty: "medium", aApm: 65, bApm: 65, aMicro: false, bMicro: false,
  winner, winReason: winner === "draw" ? null : "elimination", time: 500,
  aScore: 20, bScore: 20, margin, direction: "bAsAi",
});

/* ---------- createLedger ---------- */

// `gauntlet: null` and a roster entry's `human: false` are Phase 4's two additive fields (see
// competitionLedger.js's own COMPETITION_VERSION comment for why they needed no version bump).
// They're asserted on here — in the exact-shape tests — rather than only in
// test/competitionGauntlet.test.js, because "the ledger's shape is exactly this" is what these
// three cases exist to pin, and a field silently missing from them would be a real regression.
test("createLedger returns an empty ledger with the current version", () => {
  assert.deepEqual(createLedger(), { v: COMPETITION_VERSION, roster: [], ratingsByDifficulty: {}, history: [], gauntlet: null, seasons: [] });
});

/* ---------- roster CRUD (the human flag and the one-human rule live in test/competitionGauntlet.test.js) ---------- */

test("addRosterEntry adds a well-formed entry, mutating and returning the ledger", () => {
  const ledger = createLedger();
  const returned = addRosterEntry(ledger, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", createdAt: 1000 });
  assert.equal(returned, ledger, "addRosterEntry returns the SAME ledger it mutated");
  assert.deepEqual(ledger.roster, [{ name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", createdAt: 1000, human: false }]);
});

test("addRosterEntry trims the name and coerces an unknown strategy/archetype/faction/createdAt to safe defaults", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "  Odd  ", strategy: "not-a-real-strategy", archetype: "not-a-real-archetype", faction: "not-a-real-faction", createdAt: "soon" });
  assert.deepEqual(ledger.roster[0], { name: "Odd", strategy: "default", archetype: null, faction: "neutral", createdAt: null, human: false });
});

test("addRosterEntry rejects a missing or blank name, touching nothing", () => {
  const ledger = createLedger();
  assert.throws(() => addRosterEntry(ledger, {}), /name/i);
  assert.throws(() => addRosterEntry(ledger, { name: "" }), /name/i);
  assert.throws(() => addRosterEntry(ledger, { name: "   " }), /name/i);
  assert.deepEqual(ledger.roster, []);
});

test("addRosterEntry rejects a duplicate name (post-trim), touching nothing", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  assert.throws(() => addRosterEntry(ledger, { name: "Alpha" }), /already/i);
  assert.throws(() => addRosterEntry(ledger, { name: "  Alpha  " }), /already/i, "duplicate check is post-trim, same as competition.js's own entrant-name collision check");
  assert.equal(ledger.roster.length, 1);
});

test("addRosterEntry rejects __proto__/constructor/prototype with a clear error, and pollutes NOTHING — not just a throw", () => {
  for (const bad of ["__proto__", "constructor", "prototype"]) {
    const ledger = createLedger();
    assert.throws(() => addRosterEntry(ledger, { name: bad }), /entrant name/i, `"${bad}" must be rejected`);
    assert.deepEqual(ledger.roster, [], `the roster array must still be empty after rejecting "${bad}"`);
    assert.equal(Object.getPrototypeOf(ledger), Object.prototype, "the ledger object's own prototype must be untouched");
    assert.equal(Object.getPrototypeOf(ledger.roster), Array.prototype, "the roster array's own prototype must be untouched");
  }
  assert.equal(({}).polluted, undefined, "Object.prototype itself must stay completely clean");
});

// A name that's only forbidden CASE-SENSITIVELY must still be accepted (the task's own spec: "case-
// sensitive, after trimming") — proves the guard isn't accidentally over-broad.
test("a differently-cased or padded variant of a forbidden name is NOT forbidden (case-sensitive, trimmed)", () => {
  const ledger = createLedger();
  assert.doesNotThrow(() => addRosterEntry(ledger, { name: "__PROTO__" }));
  assert.doesNotThrow(() => addRosterEntry(ledger, { name: "Constructor" }));
  assert.equal(ledger.roster.length, 2);
});

test("removeRosterEntry removes a matching entry and is a silent no-op otherwise", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  const returned = removeRosterEntry(ledger, "Alpha");
  assert.equal(returned, ledger);
  assert.deepEqual(ledger.roster.map(r => r.name), ["Beta"]);
  assert.doesNotThrow(() => removeRosterEntry(ledger, "NeverExisted"));
  assert.deepEqual(ledger.roster.map(r => r.name), ["Beta"], "removing a name that isn't on the roster changes nothing");
});

/* ---------- recordCompetition ---------- */

test("recordCompetition applies rows via elo.js's applySeries and appends one history entry", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  const rows = [row("Alpha", "Beta", "a", 20)];
  const returned = recordCompetition(ledger, { at: 555, difficulty: "medium", aName: "Alpha", bName: "Beta", rows });
  assert.equal(returned, ledger);
  assert.ok(ledger.ratingsByDifficulty.medium.Alpha, "a rating entry now exists for Alpha at medium");
  assert.ok(ledger.ratingsByDifficulty.medium.Beta);
  assert.equal(ledger.ratingsByDifficulty.medium.Alpha.games, 1);
  assert.ok(ledger.ratingsByDifficulty.medium.Alpha.rating > 1200, "Alpha won -- its rating must have moved up");
  assert.deepEqual(ledger.history, [{ at: 555, difficulty: "medium", aName: "Alpha", bName: "Beta", rows }]);
});

test("recordCompetition applies rows to the RIGHT difficulty bracket only, leaving every other bracket's ratings byte-for-byte untouched", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });

  recordCompetition(ledger, { difficulty: "hard", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 10)] });
  assert.ok(ledger.ratingsByDifficulty.hard);
  assert.equal(ledger.ratingsByDifficulty.medium, undefined, "recording at hard must not create a medium bracket");
  assert.equal(ledger.ratingsByDifficulty.easy, undefined);

  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "b", -3)] });
  const hardSnapshot = JSON.parse(JSON.stringify(ledger.ratingsByDifficulty.hard));

  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 4)] });
  assert.deepEqual(ledger.ratingsByDifficulty.hard, hardSnapshot,
    "recording another MEDIUM competition must leave the hard bracket exactly as it was (D2: never blended)");
});

test("recordCompetition does not re-sort rows -- the same results in a different order settle on a different final rating (D6)", () => {
  const rows = [
    row("Alpha", "Beta", "a", 1),
    row("Alpha", "Beta", "a", 1),
    row("Alpha", "Beta", "b", -1),
  ];
  const forward = createLedger();
  recordCompetition(forward, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows });

  const reversed = createLedger();
  recordCompetition(reversed, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [...rows].reverse() });

  assert.notDeepEqual(forward.ratingsByDifficulty.medium, reversed.ratingsByDifficulty.medium,
    "elo.js's applySeries is order-dependent -- recordCompetition must fold rows through it exactly as given, never re-sorted");
});

test("recordCompetition rejects an unrecognised difficulty", () => {
  const ledger = createLedger();
  assert.throws(() => recordCompetition(ledger, { difficulty: "impossible", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a")] }), /difficulty/i);
  assert.deepEqual(ledger.ratingsByDifficulty, {});
});

test("recordCompetition rejects missing or empty rows", () => {
  const ledger = createLedger();
  assert.throws(() => recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [] }), /row/i);
  assert.throws(() => recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta" }), /row/i);
});

test("recordCompetition rejects a row with an invalid winner value", () => {
  const ledger = createLedger();
  const rows = [{ ...row("Alpha", "Beta", "a"), winner: "nonsense" }];
  assert.throws(() => recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows }), /winner/i);
  assert.deepEqual(ledger.ratingsByDifficulty, {});
});

test("recordCompetition rejects a forbidden top-level entrant name and pollutes nothing -- ratingsByDifficulty/history stay empty", () => {
  const ledger = createLedger();
  const rows = [row("__proto__", "Beta", "a")];
  assert.throws(() => recordCompetition(ledger, { difficulty: "medium", aName: "__proto__", bName: "Beta", rows }), /entrant name/i);
  assert.deepEqual(ledger.ratingsByDifficulty, {}, "no bracket table was created");
  assert.deepEqual(ledger.history, [], "no history entry was appended");
  assert.equal(({}).polluted, undefined);
});

test("recordCompetition rejects a forbidden name hiding inside a ROW even when the top-level aName/bName look safe -- and the whole call is atomic", () => {
  const ledger = createLedger();
  const rows = [row("Alpha", "Beta", "a", 5), { ...row("__proto__", "Beta", "b", -2) }];
  assert.throws(() => recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows }), /entrant name/i);
  assert.deepEqual(ledger.ratingsByDifficulty, {},
    "atomic: even the FIRST, valid-looking row must not have been applied once a later row is rejected");
  assert.deepEqual(ledger.history, []);
});

/* ---------- standingsFor ---------- */

// A name that collides with an INHERITED Object.prototype member (not one of the three
// FORBIDDEN_NAMES, so addRosterEntry legitimately allows it) must still read back as "hasn't
// played this bracket" rather than spuriously matching the inherited function.
test("standingsFor does not mistake an inherited Object.prototype member for a real rating (an entrant literally named toString)", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "toString" });
  addRosterEntry(ledger, { name: "Alpha" });
  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 1)] });
  assert.deepEqual(standingsFor(ledger, "medium").map(s => s.name), ["Alpha"],
    "an entrant named \"toString\" who has never played this bracket must not appear");
});

test("standingsFor lists only roster entries that have actually played at this difficulty", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  addRosterEntry(ledger, { name: "Gamma" });   // never plays a match at all
  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 1)] });

  assert.deepEqual(standingsFor(ledger, "medium").map(s => s.name).sort(), ["Alpha", "Beta"]);
  assert.deepEqual(standingsFor(ledger, "hard"), [], "nobody has played at hard yet");
});

test("standingsFor drops a since-removed roster entrant even though its historical rating persists", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 1)] });
  removeRosterEntry(ledger, "Beta");

  assert.deepEqual(standingsFor(ledger, "medium").map(s => s.name), ["Alpha"], "Beta no longer appears once removed from the roster");
  assert.ok(ledger.ratingsByDifficulty.medium.Beta, "...but Beta's own rating entry is still sitting in the table, untouched");
});

test("standingsFor computes wins/losses/draws and a correctly-signed avgMargin per entrant (margin is aName-relative)", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  recordCompetition(ledger, {
    difficulty: "medium", aName: "Alpha", bName: "Beta",
    rows: [
      row("Alpha", "Beta", "a", 20),    // Alpha win: Alpha's own margin +20, Beta's -20
      row("Alpha", "Beta", "b", -10),   // Beta win: Alpha's own margin -10, Beta's +10
      row("Alpha", "Beta", "draw", 0),
    ],
  });
  const standings = standingsFor(ledger, "medium");
  const alpha = standings.find(s => s.name === "Alpha");
  const beta = standings.find(s => s.name === "Beta");
  assert.deepEqual({ wins: alpha.wins, losses: alpha.losses, draws: alpha.draws }, { wins: 1, losses: 1, draws: 1 });
  assert.deepEqual({ wins: beta.wins, losses: beta.losses, draws: beta.draws }, { wins: 1, losses: 1, draws: 1 });
  assert.equal(alpha.avgMargin, (20 + -10 + 0) / 3);
  assert.equal(beta.avgMargin, (-20 + 10 + 0) / 3);
});

test("standingsFor sorts by rating descending, ties broken by name", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  addRosterEntry(ledger, { name: "Gamma" });
  for (let i = 0; i < 3; i++) {
    recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 10)] });
    recordCompetition(ledger, { difficulty: "medium", aName: "Gamma", bName: "Beta", rows: [row("Gamma", "Beta", "b", -10)] });
  }
  const standings = standingsFor(ledger, "medium");
  const ratings = standings.map(s => s.rating);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), "standings must already be sorted rating-descending");
  assert.equal(standings[0].name, "Alpha", "Alpha won every game it played -- should be on top");
});

// D4: the Standings screen is the one place a human rating is read side by side with AI ratings, so
// it has to be able to tell which row is the person -- to mark it, and to say the seat disclosure
// next to it. That fact lives on the RosterEntry already; standingsFor is the read path, so it
// carries it through rather than making every caller re-look-up the roster it just summarised.
test("standingsFor carries each entrant's own human flag through to its row (D4)", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Ada", human: true });
  addRosterEntry(ledger, { name: "Beta" });
  recordCompetition(ledger, { difficulty: "medium", aName: "Ada", bName: "Beta", rows: [row("Ada", "Beta", "a", 12)] });

  const standings = standingsFor(ledger, "medium");
  assert.equal(standings.find(s => s.name === "Ada").human, true);
  assert.equal(standings.find(s => s.name === "Beta").human, false,
    "an AI entrant's row must say human:false, not undefined -- the flag is the marker, so it is always present");
});

test("standingsFor flags provisional exactly at the games-below-ten boundary (PROVISIONAL_GAMES)", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  addRosterEntry(ledger, { name: "Beta" });
  for (let i = 0; i < PROVISIONAL_GAMES - 1; i++) {
    recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", i % 2 === 0 ? "a" : "b", 1)] });
  }
  let alpha = standingsFor(ledger, "medium").find(s => s.name === "Alpha");
  assert.equal(alpha.games, PROVISIONAL_GAMES - 1);
  assert.equal(alpha.provisional, true, `${PROVISIONAL_GAMES - 1} games is still provisional`);

  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 1)] });
  alpha = standingsFor(ledger, "medium").find(s => s.name === "Alpha");
  assert.equal(alpha.games, PROVISIONAL_GAMES);
  assert.equal(alpha.provisional, false, `${PROVISIONAL_GAMES} games graduates out of provisional`);
});

/* ---------- sanitizeLedgerStructure: the structural gate, tested directly (mirrors
   test/sanitize.test.js's own direct sanitizeSave() tests, same assertion style) ---------- */

test("sanitizeLedgerStructure passes a plain, bounded object through unchanged", () => {
  const ok = { v: 1, roster: [{ name: "Alpha" }], ratingsByDifficulty: { medium: { Alpha: { rating: 1200, games: 0 } } }, history: [] };
  assert.equal(sanitizeLedgerStructure(ok), ok, "valid data is returned as-is (identity)");
});

test("sanitizeLedgerStructure rejects non-objects", () => {
  assert.throws(() => sanitizeLedgerStructure(null), /not a valid object/);
  assert.throws(() => sanitizeLedgerStructure("a string"), /not a valid object/);
  assert.throws(() => sanitizeLedgerStructure([1, 2, 3]), /not a valid object/);
});

test("sanitizeLedgerStructure rejects a prototype-polluting key, nested or at the top", () => {
  const evil = JSON.parse('{"v":1,"__proto__":{"polluted":true}}');
  assert.throws(() => sanitizeLedgerStructure(evil), /forbidden key/);
  assert.throws(() => sanitizeLedgerStructure({ v: 1, a: { b: { constructor: 1 } } }), /forbidden key/);
  assert.throws(() => sanitizeLedgerStructure({ v: 1, a: { prototype: {} } }), /forbidden key/);
  assert.equal(({}).polluted, undefined, "Object.prototype stays clean");
});

test("sanitizeLedgerStructure rejects an oversized string", () => {
  assert.throws(() => sanitizeLedgerStructure({ v: 1, s: "x".repeat(3000) }), /oversized string/);
});

test("sanitizeLedgerStructure rejects an over-deep structure", () => {
  let root = {}, cur = root;
  for (let i = 0; i < 50; i++) { cur.n = {}; cur = cur.n; }
  assert.throws(() => sanitizeLedgerStructure({ v: 1, deep: root }), /too deeply nested/);
});

test("sanitizeLedgerStructure rejects a node bomb (too many values)", () => {
  const big = { v: 1, arr: [] };
  for (let i = 0; i < 50100; i++) big.arr.push(i);
  assert.throws(() => sanitizeLedgerStructure(big), /too large/);
});

/* ---------- importLedgerJSON: the full pipeline (mirrors test/save-hardening.test.js's own
   deserializeGame/deserializeGalaxy-level integration tests) ---------- */

test("importLedgerJSON throws a clear error on text that isn't valid JSON at all", () => {
  assert.throws(() => importLedgerJSON("{ not valid json"), /not valid JSON/);
});

test("importLedgerJSON rejects a wrong version", () => {
  const text = JSON.stringify({ v: 999, roster: [], ratingsByDifficulty: {}, history: [] });
  assert.throws(() => importLedgerJSON(text), /unsupported competition ledger version/);
});

test("importLedgerJSON rejects a forbidden __proto__ KEY hidden inside the roster", () => {
  const text = '{"v":1,"roster":[{"__proto__":{"polluted":true},"name":"Alpha"}],"ratingsByDifficulty":{},"history":[]}';
  assert.throws(() => importLedgerJSON(text), /forbidden key/);
  assert.equal(({}).polluted, undefined);
});

test("importLedgerJSON rejects a forbidden __proto__ KEY hidden inside ratingsByDifficulty", () => {
  const text = '{"v":1,"roster":[],"ratingsByDifficulty":{"medium":{"__proto__":{"rating":9999,"games":1}}},"history":[]}';
  assert.throws(() => importLedgerJSON(text), /forbidden key/);
  assert.equal(({}).polluted, undefined);
});

test("importLedgerJSON rejects an oversized string anywhere in the payload", () => {
  const text = JSON.stringify({ v: 1, roster: [{ name: "x".repeat(3000) }], ratingsByDifficulty: {}, history: [] });
  assert.throws(() => importLedgerJSON(text), /oversized string/);
});

test("importLedgerJSON rejects excessive nesting", () => {
  let root = {}, cur = root;
  for (let i = 0; i < 50; i++) { cur.n = {}; cur = cur.n; }
  const text = JSON.stringify({ v: 1, roster: [], ratingsByDifficulty: {}, history: [], deep: root });
  assert.throws(() => importLedgerJSON(text), /too deeply nested/);
});

test("importLedgerJSON COERCES a non-array roster or history to [] rather than throwing", () => {
  const text = JSON.stringify({ v: COMPETITION_VERSION, roster: "haxx", ratingsByDifficulty: {}, history: 12345 });
  const ledger = importLedgerJSON(text);
  assert.deepEqual(ledger.roster, [], "a non-array roster coerces to []");
  assert.deepEqual(ledger.history, [], "a non-array history coerces to []");
  assert.equal(ledger.v, COMPETITION_VERSION);
});

test("importLedgerJSON drops a roster entry named __proto__/constructor/prototype (silently, on load — not a throw) and a duplicate name keeps only the first", () => {
  const text = JSON.stringify({
    v: COMPETITION_VERSION,
    roster: [{ name: "__proto__" }, { name: "constructor" }, { name: "Alpha" }, { name: "Alpha", strategy: "aggressive" }],
    ratingsByDifficulty: {}, history: [],
  });
  const ledger = importLedgerJSON(text);
  assert.deepEqual(ledger.roster.map(r => r.name), ["Alpha"]);
  assert.equal(ledger.roster[0].strategy, "default", "the FIRST occurrence of a duplicate name wins");
});

test("importLedgerJSON drops a ratingsByDifficulty bracket keyed by an unrecognised difficulty string", () => {
  const text = JSON.stringify({
    v: COMPETITION_VERSION, roster: [],
    ratingsByDifficulty: { medium: { Alpha: { rating: 1300, games: 5 } }, impossible: { Alpha: { rating: 9999, games: 1 } } },
    history: [],
  });
  const ledger = importLedgerJSON(text);
  assert.deepEqual(Object.keys(ledger.ratingsByDifficulty), ["medium"]);
});

test("importLedgerJSON coerces a non-finite/out-of-range rating entry away rather than trusting it", () => {
  const text = JSON.stringify({
    v: COMPETITION_VERSION, roster: [],
    ratingsByDifficulty: { medium: { Good: { rating: 1300, games: 5 }, Bad: { rating: "not a number", games: -3 } } },
    history: [],
  });
  const ledger = importLedgerJSON(text);
  assert.deepEqual(Object.keys(ledger.ratingsByDifficulty.medium), ["Good"], "the malformed entry is dropped, the real one survives");
});

/* ---------- full round trip ---------- */

test("full round trip: create, add roster entries, record a competition, export, import -- deep-equal", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", createdAt: 1000 });
  addRosterEntry(ledger, { name: "The Turtle", strategy: "economic", archetype: "economist", faction: "miners", createdAt: 2000 });
  const rows = [
    row("Blitz", "The Turtle", "a", 30),
    { ...row("Blitz", "The Turtle", "b", -26), swapAsym: true, direction: "aAsAi" },
  ];
  recordCompetition(ledger, { at: 123456, difficulty: "medium", aName: "Blitz", bName: "The Turtle", rows });

  const exported = exportLedger(ledger);
  const reimported = importLedgerJSON(JSON.stringify(exported));
  assert.deepEqual(reimported, ledger, "export -> JSON.stringify -> importLedgerJSON round-trips byte-for-byte");
});

test("exportLedger returns a detached copy -- mutating the live ledger afterward doesn't touch it", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  const exported = exportLedger(ledger);
  addRosterEntry(ledger, { name: "Beta" });
  assert.equal(exported.roster.length, 1, "the exported snapshot is unaffected by a later mutation of the live ledger");
  assert.equal(ledger.roster.length, 2);
});

/* ============================================================
   SEASONS (docs/competitions-and-elo.md Phase 5) — archive the current ladder under a label and
   start a fresh one, KEEPING the roster. The hardening half of this section is held to the same
   standard as the rest of this file: a hostile archived-season payload must be rejected or coerced
   safely, and the __proto__ cases must prove NOTHING WAS POLLUTED rather than only that a call
   threw.
   ============================================================ */

// A ledger with two entrants and one recorded medium-bracket duel — the smallest thing that is
// worth archiving, reused by most of the cases below.
function playedLedger() {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Blitz", strategy: "aggressive", archetype: "rusher", faction: "syndicate", createdAt: 1000 });
  addRosterEntry(ledger, { name: "Bulwark", strategy: "defensive", archetype: "turtle", faction: "miners", createdAt: 2000 });
  recordCompetition(ledger, {
    at: 111, difficulty: "medium", aName: "Blitz", bName: "Bulwark",
    rows: [row("Blitz", "Bulwark", "a", 40), row("Blitz", "Bulwark", "a", 12)],
  });
  return ledger;
}

test("seasonSummary counts the matches played and names who finished top of each bracket", () => {
  const ledger = playedLedger();
  recordCompetition(ledger, {
    at: 222, difficulty: "hard", aName: "Bulwark", bName: "Blitz",
    rows: [row("Bulwark", "Blitz", "a", 8)],
  });

  const summary = seasonSummary(ledger);
  assert.equal(summary.matches, 3, "every ROW across every history entry is one match played");
  assert.equal(summary.entrants, 2);
  assert.deepEqual(summary.brackets.map(b => b.difficulty), ["medium", "hard"],
    "brackets come back in DIFFICULTY_OPTIONS order, never object-key insertion order");
  const medium = summary.brackets.find(b => b.difficulty === "medium");
  assert.equal(medium.top, "Blitz", "Blitz won both medium matches, so Blitz tops that bracket");
  assert.ok(medium.topRating > 1200, "the top finisher's rating is the real, rated one");
  assert.equal(medium.matches, 2);
  assert.equal(medium.entrants, 2);
  assert.equal(summary.brackets.find(b => b.difficulty === "hard").top, "Bulwark");
});

test("seasonSummary of an untouched ladder is empty rather than throwing", () => {
  const summary = seasonSummary(createLedger());
  assert.deepEqual(summary, { matches: 0, entrants: 0, brackets: [] });
});

test("archiveSeason files the ladder under a label with a finish time, and RESETS the live ratings and history", () => {
  const ledger = playedLedger();
  const before = exportLedger(ledger);

  const returned = archiveSeason(ledger, { label: "Opening Season", at: 987 });
  assert.equal(returned, ledger, "archiveSeason returns the SAME ledger it mutated (elo.js's own idiom)");

  assert.equal(ledger.seasons.length, 1);
  const season = ledger.seasons[0];
  assert.equal(season.label, "Opening Season");
  assert.equal(season.finishedAt, 987);
  assert.deepEqual(season.ratingsByDifficulty, before.ratingsByDifficulty, "the archived table is the one that was live");
  assert.deepEqual(season.history, before.history);
  assert.equal(season.summary.matches, 2);
  assert.equal(season.summary.brackets[0].top, "Blitz");

  assert.deepEqual(ledger.ratingsByDifficulty, {}, "the live ratings restart from nothing");
  assert.deepEqual(ledger.history, [], "…and so does the live history");
});

test("archiveSeason KEEPS the roster — entrants persist across a season boundary, only their ratings restart", () => {
  const ledger = playedLedger();
  const rosterBefore = exportLedger(ledger).roster;

  archiveSeason(ledger, { label: "Season One", at: 5 });

  assert.deepEqual(ledger.roster, rosterBefore, "every roster entry survives the reset byte-for-byte");
  assert.deepEqual(standingsFor(ledger, "medium"), [],
    "…and yet nobody has a standing any more: the new season starts unrated");
});

test("archiveSeason's archived copy is DETACHED — later play cannot reach back into a closed season", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Season One" });
  recordCompetition(ledger, { at: 333, difficulty: "medium", aName: "Blitz", bName: "Bulwark", rows: [row("Blitz", "Bulwark", "b", -9)] });

  assert.equal(ledger.seasons[0].history.length, 1, "the closed season still records exactly what it recorded");
  assert.equal(ledger.history.length, 1, "the new season's history is its own");
  assert.equal(ledger.seasons[0].summary.matches, 2);
});

test("archiveSeason defaults an absent/blank label to the season's own number, and truncates an over-long one", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, {});
  assert.equal(ledger.seasons[0].label, "Season 1");

  recordCompetition(ledger, { difficulty: "medium", aName: "Blitz", bName: "Bulwark", rows: [row("Blitz", "Bulwark", "a", 1)] });
  archiveSeason(ledger, { label: "   " });
  assert.equal(ledger.seasons[1].label, "Season 2", "a blank label is no label at all");

  recordCompetition(ledger, { difficulty: "medium", aName: "Blitz", bName: "Bulwark", rows: [row("Blitz", "Bulwark", "a", 1)] });
  archiveSeason(ledger, { label: "L".repeat(MAX_SEASON_LABEL + 40) });
  assert.equal(ledger.seasons[2].label.length, MAX_SEASON_LABEL, "an over-long label is truncated, not rejected — it's cosmetic");
});

test("archiveSeason refuses a ladder with nothing on it, touching nothing", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Blitz" });
  assert.throws(() => archiveSeason(ledger, { label: "Empty" }), /nothing to archive/i);
  assert.deepEqual(ledger.seasons, [], "a refused archive leaves the ledger completely alone");
  assert.equal(ledger.roster.length, 1);
});

test("archiveSeason refuses while a gauntlet is still in progress, touching nothing", () => {
  const ledger = playedLedger();
  addRosterEntry(ledger, { name: "Commander", human: true });
  startGauntlet(ledger, { field: ["Blitz", "Bulwark"], difficulty: "medium", worlds: ["ferros"], seedBase: 7 });

  assert.throws(() => archiveSeason(ledger, { label: "Too Soon" }), /gauntlet/i);
  assert.deepEqual(ledger.seasons, []);
  assert.ok(ledger.gauntlet, "the run in progress is untouched");
  assert.equal(ledger.history.length, 1, "…and so is the history it has already earned");
});

test("archiveSeason clears a FINISHED gauntlet — the run belongs to the season being closed", () => {
  const ledger = playedLedger();
  addRosterEntry(ledger, { name: "Commander", human: true });
  startGauntlet(ledger, { field: ["Blitz"], difficulty: "medium", worlds: ["ferros"], seedBase: 7 });
  recordGauntletMatch(ledger, { winner: "human", margin: 12, at: 50 });
  assert.ok(ledger.gauntlet, "sanity: a finished run is still parked on the ledger");

  archiveSeason(ledger, { label: "Season One" });
  assert.equal(ledger.gauntlet, null, "the finished run went with the season it was played in");
  assert.equal(ledger.seasons[0].history.length, 2, "…and its rated match is archived with it");
});

test("seasonStandings reads a closed season's final table back — including an entrant since removed from the roster", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Season One", at: 1 });
  removeRosterEntry(ledger, "Bulwark");

  const rows = seasonStandings(ledger, 0, "medium");
  assert.deepEqual(rows.map(r => r.name), ["Blitz", "Bulwark"],
    "a closed season's table is complete: it is what the season FINISHED as, not what the current roster still contains");
  assert.ok(rows[0].rating > rows[1].rating, "sorted by rating descending, exactly like a live bracket");
  assert.equal(rows[0].wins, 2, "W-L-D is derived from that season's own history");
  assert.deepEqual(seasonStandings(ledger, 0, "hard"), [], "a bracket the season never played is empty, not an error");
  assert.deepEqual(seasonStandings(ledger, 99, "medium"), [], "an out-of-range season index is empty, never a throw");
});

/* ---------- seasons as untrusted input ---------- */

test("full round trip WITH a season: archive, export, import -- deep-equal", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Opening Season", at: 4242 });
  recordCompetition(ledger, { at: 555, difficulty: "hard", aName: "Blitz", bName: "Bulwark", rows: [row("Blitz", "Bulwark", "b", -3)] });

  const reimported = importLedgerJSON(JSON.stringify(exportLedger(ledger)));
  assert.deepEqual(reimported, ledger, "an archived season survives export -> JSON -> import byte-for-byte");
});

test("importLedgerJSON rejects a forbidden __proto__ KEY hidden inside an ARCHIVED season, and pollutes nothing", () => {
  const text = '{"v":1,"roster":[],"ratingsByDifficulty":{},"history":[],"seasons":'
    + '[{"label":"Season 1","ratingsByDifficulty":{"medium":{"__proto__":{"rating":9999,"games":1}}},"history":[]}]}';
  assert.throws(() => importLedgerJSON(text), /forbidden key/);
  assert.equal(({}).polluted, undefined, "Object.prototype itself must stay completely clean");
  assert.equal(({}).rating, undefined, "…and must not have picked up a rating either");
});

test("importLedgerJSON COERCES a non-array seasons field to [] rather than throwing", () => {
  const text = JSON.stringify({ v: COMPETITION_VERSION, roster: [], ratingsByDifficulty: {}, history: [], seasons: "haxx" });
  assert.deepEqual(importLedgerJSON(text).seasons, []);
});

test("importLedgerJSON RE-DERIVES an archived season's summary — a fabricated one is never believed", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Opening Season", at: 1 });
  const hostile = exportLedger(ledger);
  hostile.seasons[0].summary = { matches: 999999, entrants: 4242, brackets: [{ difficulty: "medium", top: "Cheater", topRating: 99999, entrants: 1, matches: 999999 }] };

  const clean = importLedgerJSON(JSON.stringify(hostile));
  assert.deepEqual(clean.seasons[0].summary, ledger.seasons[0].summary,
    "the summary is recomputed from the season's OWN cleaned ratings/history — the file's claim about it is discarded");
  assert.equal(clean.seasons[0].summary.brackets[0].top, "Blitz", "…so a fabricated champion never makes it onto the screen");
});

test("importLedgerJSON drops a junk season entry, an unknown bracket inside a season, and a season that cleans away to nothing", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Real Season", at: 1 });
  const payload = exportLedger(ledger);
  payload.seasons[0].ratingsByDifficulty.impossible = { Blitz: { rating: 9999, games: 3 } };
  payload.seasons.push("not a season");
  payload.seasons.push({ label: "Husk", ratingsByDifficulty: {}, history: [] });
  payload.seasons.push({ label: "Junk brackets", ratingsByDifficulty: { impossible: { X: { rating: 1, games: 1 } } }, history: "nope" });

  const clean = importLedgerJSON(JSON.stringify(payload));
  assert.equal(clean.seasons.length, 1, "only the one season that records something real survives");
  assert.deepEqual(Object.keys(clean.seasons[0].ratingsByDifficulty), ["medium"], "the unrecognised bracket is dropped");
  assert.equal(clean.seasons[0].label, "Real Season");
});

test("importLedgerJSON coerces a season's own label and finish time rather than trusting them", () => {
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Real Season", at: 1 });
  const payload = exportLedger(ledger);
  payload.seasons[0].label = 12345;
  payload.seasons[0].finishedAt = "yesterday";
  payload.seasons.push({ ...exportLedger(ledger).seasons[0], label: "  padded  " });

  const clean = importLedgerJSON(JSON.stringify(payload));
  assert.equal(clean.seasons[0].label, "Season 1", "a non-string label falls back to the season's own number");
  assert.equal(clean.seasons[0].finishedAt, null, "a non-finite finish time reads as 'unknown', never as a number");
  assert.equal(clean.seasons[1].label, "padded", "a label is trimmed, like every other stored name in this file");
});

test("the structural gate walks INSIDE an archived season too — a forbidden key there is rejected, and pollutes nothing", () => {
  for (const bad of ["__proto__", "constructor", "prototype"]) {
    const text = '{"v":1,"roster":[],"ratingsByDifficulty":{},"history":[],"seasons":[{"label":"Season 1",'
      + `"ratingsByDifficulty":{"medium":{${JSON.stringify(bad)}:{"rating":9999,"games":9}}},"history":[]}]}`;
    assert.throws(() => importLedgerJSON(text), /forbidden key/, `"${bad}" inside a season must be rejected`);
  }
  assert.equal(({}).rating, undefined, "Object.prototype itself must stay completely clean");
  assert.equal(({}).games, undefined);
});

test("a season's table doesn't mistake an inherited Object.prototype member for a real rating (an entrant literally named toString)", () => {
  // "toString" is NOT one of the three forbidden identity strings, so it is a perfectly legal
  // entrant name that a plain object nonetheless answers truthily for. Same hazard standingsFor's
  // own Object.hasOwn already guards on the live ladder, re-checked on the archived path.
  const ledger = playedLedger();
  archiveSeason(ledger, { label: "Real Season", at: 1 });
  const payload = exportLedger(ledger);
  const clean = importLedgerJSON(JSON.stringify(payload));

  assert.deepEqual(Object.keys(clean.seasons[0].ratingsByDifficulty.medium).sort(), ["Blitz", "Bulwark"]);
  assert.deepEqual(seasonStandings(clean, 0, "medium").map(r => r.name), ["Blitz", "Bulwark"],
    "an inherited member must never read back as an extra, garbage standings row");
  assert.equal(Object.getPrototypeOf(clean.seasons[0]), Object.prototype, "the cleaned season object's own prototype is untouched");
});

/* ---------- localStorage persistence: saveload.js's key + PREV_SUFFIX two-generation idiom ---------- */

// Assigned fresh INSIDE each test that needs a working store — same reasoning as
// test/saveload.test.js's own fakeLocalStorage: node:test only starts running test BODIES after
// this whole module has finished its synchronous load, so a module-scope assignment here would
// flip every test in the file (including ones declared earlier) onto a live store.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}

test("the module reads the documented literal storage key (competitionLedger.js source)", () => {
  const src = readFileSync(fileURLToPath(new URL("../competitionLedger.js", import.meta.url)), "utf8");
  assert.match(src, /STORAGE_KEY\s*=\s*"stellarfrontier\.competitions\.v1"/);
  assert.match(src, /PREV_SUFFIX\s*=\s*"\.prev"/);
});

test("loadLedgerFromStorage returns null (never throws) when localStorage is unavailable entirely", () => {
  delete globalThis.localStorage;   // guarantee the precondition regardless of test execution order
  assert.doesNotThrow(() => loadLedgerFromStorage());
  assert.equal(loadLedgerFromStorage(), null);
});

test("saveLedgerToStorage / loadLedgerFromStorage round-trip through a fake localStorage", () => {
  globalThis.localStorage = fakeLocalStorage();
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Alpha" });
  recordCompetition(ledger, { difficulty: "medium", aName: "Alpha", bName: "Beta", rows: [row("Alpha", "Beta", "a", 5)] });

  assert.equal(saveLedgerToStorage(ledger), true);
  assert.deepEqual(loadLedgerFromStorage(), ledger);
});

test("saveLedgerToStorage rotates generations, and loadLedgerFromStorage falls back to .prev when the primary is corrupt", () => {
  globalThis.localStorage = fakeLocalStorage();
  const STORAGE_KEY = "stellarfrontier.competitions.v1";

  const first = createLedger();
  addRosterEntry(first, { name: "Alpha" });
  assert.equal(saveLedgerToStorage(first), true, "first write: nothing to rotate yet");
  assert.equal(localStorage.getItem(STORAGE_KEY + ".prev"), null);

  const second = createLedger();
  addRosterEntry(second, { name: "Beta" });
  assert.equal(saveLedgerToStorage(second), true);
  assert.ok(localStorage.getItem(STORAGE_KEY + ".prev"), "the OLD primary rotated into .prev");

  localStorage.setItem(STORAGE_KEY, "{ not valid json");   // corrupt the primary directly
  assert.deepEqual(loadLedgerFromStorage(), first, "falls back to the .prev generation -- the FIRST saved ledger");
});

test("loadLedgerFromStorage returns null when both generations are corrupt or missing", () => {
  globalThis.localStorage = fakeLocalStorage();
  assert.equal(loadLedgerFromStorage(), null, "nothing stored at all");

  const STORAGE_KEY = "stellarfrontier.competitions.v1";
  localStorage.setItem(STORAGE_KEY, "{ not valid json");
  localStorage.setItem(STORAGE_KEY + ".prev", "{ also not valid json");
  assert.equal(loadLedgerFromStorage(), null, "both generations corrupt");
});

test("saveLedgerToStorage never throws even when localStorage.setItem always throws (private-mode style failure)", () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => {} };
  const ledger = createLedger();
  assert.doesNotThrow(() => saveLedgerToStorage(ledger));
  assert.equal(saveLedgerToStorage(ledger), false);
});
