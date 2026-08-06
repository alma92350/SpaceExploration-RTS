/* ============================================================
   competitionLedger.js's PHASE 4 half (docs/competitions-and-elo.md Phase 4, D2/D4/D6) — the human
   entrant and the persisted, resumable Gauntlet. A sibling of test/competitionLedger.test.js rather
   than more of it: that file's own header scopes it to Phase 2's roster/ratings/history, and this
   phase adds a whole second persisted structure with its own rules. Same assertion STYLE as that
   file and test/save-hardening.test.js, deliberately: throw-with-a-clear-reason for the interactive
   seams, silent coercion for a merely-wrong imported shape, and — for anything prototype-adjacent —
   proving nothing was actually polluted, not merely that a call threw.

   THE FOUR RULES THIS PHASE IS ACTUALLY ABOUT, all pinned below:
     • exactly ONE roster entry may be the human (D4's "a roster row flagged human: true");
     • a gauntlet's fixtures are derived ONCE, deterministically, so a resume after a page reload
       replays the same worlds and seeds (D6);
     • a human match is rated through the same recordCompetition path an AI match is, into the
       gauntlet's own pinned difficulty bracket and no other (D1/D2);
     • every human row records seatSwapped: false, because the seat edge tools/selfplay.js measures
       is real, one-directional, and cannot be corrected by a side-swap when one seat is a person
       (D4). No row may claim otherwise, not even an imported one.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPETITION_VERSION, GAUNTLET_DEFAULT_MATCH_SECONDS,
  createLedger, addRosterEntry, removeRosterEntry, humanEntry,
  startGauntlet, currentGauntletFixture, recordGauntletMatch, recordGauntletForfeit,
  gauntletProgress, abandonGauntlet,
  standingsFor, exportLedger, importLedgerJSON, loadLedgerFromStorage, saveLedgerToStorage,
} from "../competitionLedger.js";

// A ledger with a human plus `n` AI entrants named Bot1..Botn — the starting position for almost
// every test below.
function seededLedger(n = 3) {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "You", human: true });
  for (let i = 1; i <= n; i++) addRosterEntry(ledger, { name: `Bot${i}`, strategy: "aggressive" });
  return ledger;
}

const FIELD3 = ["Bot1", "Bot2", "Bot3"];

function startedGauntlet(ledger = seededLedger(), opts = {}) {
  startGauntlet(ledger, { field: FIELD3, difficulty: "hard", matchTimeLimit: 1200, seedBase: 4242, ...opts });
  return ledger;
}

/* ---------- the human flag: exactly one, and it changes nothing else ---------- */

test("a roster entry is NOT human by default — the flag is additive, and every pre-existing entry keeps its meaning", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Blitz" });
  assert.equal(ledger.roster[0].human, false, "an ordinary entrant is explicitly non-human, never undefined");
  assert.equal(humanEntry(ledger), null, "a roster with no human entry reads back as no human");
});

test("addRosterEntry accepts exactly one human entrant, which is otherwise an ordinary roster row", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "You", human: true, strategy: "aggressive", faction: "syndicate" });
  assert.deepEqual(ledger.roster[0], {
    name: "You", strategy: "aggressive", archetype: null, faction: "syndicate", createdAt: null, human: true,
  }, "the human carries the same fields as anyone else — one extra flag, not a parallel system");
  assert.equal(humanEntry(ledger).name, "You");
});

test("addRosterEntry REJECTS a second human entrant with a clear error, touching nothing", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "You", human: true });
  assert.throws(() => addRosterEntry(ledger, { name: "Also You", human: true }), /human/i);
  assert.deepEqual(ledger.roster.map(r => r.name), ["You"], "the rejected entry was never added");
  assert.equal(humanEntry(ledger).name, "You", "the original human entry is untouched");
});

test("a non-human entrant can still be added alongside the human, and the human can be replaced after removal", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "You", human: true });
  assert.doesNotThrow(() => addRosterEntry(ledger, { name: "Bot1" }));
  removeRosterEntry(ledger, "You");
  assert.equal(humanEntry(ledger), null);
  assert.doesNotThrow(() => addRosterEntry(ledger, { name: "Someone Else", human: true }),
    "once the old human entry is gone, a new one is allowed");
  assert.equal(humanEntry(ledger).name, "Someone Else");
});

test("addRosterEntry coerces a non-boolean human flag rather than trusting it", () => {
  const ledger = createLedger();
  addRosterEntry(ledger, { name: "Sneaky", human: "yes please" });
  assert.equal(ledger.roster[0].human, false, "only a real `true` makes an entry the human");
});

/* ---------- starting a gauntlet ---------- */

test("startGauntlet builds one fixture per field entrant, pins the difficulty and match length, and starts at index 0", () => {
  const ledger = startedGauntlet();
  const g = ledger.gauntlet;
  assert.equal(g.humanName, "You");
  assert.deepEqual(g.field, FIELD3);
  assert.equal(g.difficulty, "hard");
  assert.equal(g.matchTimeLimit, 1200);
  assert.equal(g.schedule.length, 3, "one fixture per opponent — the human plays each ONE live match");
  assert.deepEqual(g.schedule.map(f => f.opponent), FIELD3, "the schedule is field order, index-aligned");
  assert.deepEqual(g.results, []);
  assert.equal(g.nextIndex, 0);
});

test("startGauntlet alternates swapAsym by match index parity — the one half of the seat correction still available (D4)", () => {
  const ledger = startedGauntlet(seededLedger(4), { field: ["Bot1", "Bot2", "Bot3", "Bot4"] });
  assert.deepEqual(ledger.gauntlet.schedule.map(f => f.swapAsym), [false, true, false, true],
    "the map's own asym halves alternate across the gauntlet even though the SEAT can't be swapped");
});

test("startGauntlet defaults the match length to Quick (the Phase 4 brief's own default)", () => {
  const ledger = seededLedger();
  startGauntlet(ledger, { field: FIELD3, difficulty: "medium", seedBase: 1 });
  assert.equal(ledger.gauntlet.matchTimeLimit, GAUNTLET_DEFAULT_MATCH_SECONDS);
  assert.equal(GAUNTLET_DEFAULT_MATCH_SECONDS, 1200, "Quick — 20 minutes, setup.js's own MATCH_LENGTH_OPTIONS value");
});

test("startGauntlet rejects a field naming someone who isn't on the roster, or the human themself, or a duplicate — touching nothing", () => {
  for (const [field, pattern] of [
    [["Bot1", "Ghost"], /roster/i],
    [["Bot1", "You"], /yourself|human/i],
    [["Bot1", "Bot1"], /twice|duplicate/i],
    [[], /at least one|empty/i],
  ]) {
    const ledger = seededLedger();
    assert.throws(() => startGauntlet(ledger, { field, difficulty: "medium" }), pattern, `field ${JSON.stringify(field)}`);
    assert.equal(ledger.gauntlet, null, "a rejected start leaves no gauntlet behind at all");
  }
});

test("startGauntlet rejects an unknown difficulty, and refuses to run without a human entrant on the roster", () => {
  const ledger = seededLedger();
  assert.throws(() => startGauntlet(ledger, { field: FIELD3, difficulty: "impossible" }), /difficulty/i);
  assert.equal(ledger.gauntlet, null);

  const noHuman = createLedger();
  addRosterEntry(noHuman, { name: "Bot1" });
  assert.throws(() => startGauntlet(noHuman, { field: ["Bot1"], difficulty: "medium" }), /human/i);
  assert.equal(noHuman.gauntlet, null);
});

// addRosterEntry and the import sanitizer both already bar the three identity-hazard strings, so
// this can only be reached by a ledger assembled in memory — which is exactly why it must fail at
// START (touching nothing) rather than at the first recorded result, which would leave a real,
// scheduled run that could never be recorded into.
test("startGauntlet refuses a forbidden identity string reaching it some other way — at start, polluting nothing", () => {
  for (const bad of ["__proto__", "constructor", "prototype"]) {
    const ledger = seededLedger();
    ledger.roster.push({ name: bad, strategy: "default", archetype: null, faction: "neutral", createdAt: null, human: false });
    assert.throws(() => startGauntlet(ledger, { field: ["Bot1", bad], difficulty: "medium" }), /entrant name/i);
    assert.equal(ledger.gauntlet, null, `no gauntlet was scheduled for "${bad}"`);
    assert.equal(Object.getPrototypeOf(ledger), Object.prototype);
    assert.equal(({}).polluted, undefined);
  }
});

test("startGauntlet refuses to overwrite a gauntlet already in progress — progress is never silently discarded", () => {
  const ledger = startedGauntlet();
  const before = JSON.parse(JSON.stringify(ledger.gauntlet));
  assert.throws(() => startGauntlet(ledger, { field: ["Bot2"], difficulty: "easy" }), /in progress|already/i);
  assert.deepEqual(ledger.gauntlet, before, "the running gauntlet is exactly as it was");
});

/* ---------- D6: the fixture schedule is derived deterministically, up front ---------- */

test("the fixture schedule is DETERMINISTIC — the same inputs produce the same world/seed list twice (D6)", () => {
  const a = startedGauntlet();
  const b = startedGauntlet();
  assert.deepEqual(a.gauntlet.schedule, b.gauntlet.schedule,
    "two gauntlets built from the same seed/field/difficulty schedule byte-identical fixtures — that is what makes a resume replay the SAME match");
  assert.ok(a.gauntlet.schedule.every(f => Number.isInteger(f.seed) && f.seed >= 0), "every seed is a real unsigned integer");
  assert.ok(a.gauntlet.schedule.every(f => typeof f.world === "string" && f.world.length > 0), "every fixture names a real world");
});

test("a different seed base schedules different fixtures (the seed is genuinely an input, not decoration)", () => {
  const a = startedGauntlet(seededLedger(), { seedBase: 1 });
  const b = startedGauntlet(seededLedger(), { seedBase: 2 });
  assert.notDeepEqual(a.gauntlet.schedule.map(f => f.seed), b.gauntlet.schedule.map(f => f.seed));
});

test("startGauntlet draws fixture worlds only from the pool it was given", () => {
  const ledger = seededLedger();
  startGauntlet(ledger, { field: FIELD3, difficulty: "medium", seedBase: 7, worlds: ["ferros", "korrath"] });
  assert.ok(ledger.gauntlet.schedule.every(f => f.world === "ferros" || f.world === "korrath"));
});

test("startGauntlet rejects a worlds pool naming no real world at all", () => {
  const ledger = seededLedger();
  assert.throws(() => startGauntlet(ledger, { field: FIELD3, difficulty: "medium", worlds: ["atlantis"] }), /world/i);
  assert.equal(ledger.gauntlet, null);
});

/* ---------- reading the current fixture back ---------- */

test("currentGauntletFixture reads back the next unplayed fixture, with everything a live match needs to start", () => {
  const ledger = startedGauntlet();
  const fixture = currentGauntletFixture(ledger);
  assert.equal(fixture.index, 0);
  assert.equal(fixture.total, 3);
  assert.equal(fixture.opponent, "Bot1");
  assert.equal(fixture.humanName, "You");
  assert.equal(fixture.difficulty, "hard", "the gauntlet's pinned difficulty rides along — every opponent plays at it (D2)");
  assert.equal(fixture.matchTimeLimit, 1200);
  assert.equal(fixture.world, ledger.gauntlet.schedule[0].world);
  assert.equal(fixture.seed, ledger.gauntlet.schedule[0].seed);
  assert.equal(fixture.swapAsym, false);
});

test("currentGauntletFixture is null with no gauntlet, and null again once every fixture has been played", () => {
  assert.equal(currentGauntletFixture(createLedger()), null);
  const ledger = startedGauntlet();
  for (let i = 0; i < 3; i++) recordGauntletMatch(ledger, { winner: "human", margin: 5 });
  assert.equal(currentGauntletFixture(ledger), null, "a finished gauntlet has no NEXT fixture");
  assert.equal(gauntletProgress(ledger).complete, true, "...but it is still there to be read back as a finished run");
});

/* ---------- recording a result ---------- */

test("recording a result advances EXACTLY one pairing and leaves the rest of the schedule untouched", () => {
  const ledger = startedGauntlet();
  const scheduleBefore = JSON.parse(JSON.stringify(ledger.gauntlet.schedule));

  recordGauntletMatch(ledger, { winner: "human", margin: 12, at: 999 });

  assert.equal(ledger.gauntlet.nextIndex, 1, "exactly one pairing was consumed");
  assert.equal(ledger.gauntlet.results.length, 1);
  assert.deepEqual(ledger.gauntlet.schedule, scheduleBefore, "the remaining fixtures are byte-identical — a resume replays them unchanged");
  assert.equal(currentGauntletFixture(ledger).opponent, "Bot2");
  assert.equal(ledger.history.length, 1, "exactly one competition was recorded, not one per remaining opponent");
});

test("a human match is rated through the same path as everyone else, into the gauntlet's OWN bracket and no other (D1/D2)", () => {
  const ledger = startedGauntlet();   // pinned at hard
  recordGauntletMatch(ledger, { winner: "human", margin: 30 });

  assert.ok(ledger.ratingsByDifficulty.hard, "the pinned bracket got the rating");
  assert.equal(ledger.ratingsByDifficulty.medium, undefined, "no other bracket was created");
  assert.equal(ledger.ratingsByDifficulty.easy, undefined);
  assert.ok(ledger.ratingsByDifficulty.hard.You.rating > 1200, "the human won — their rating moved up");
  assert.ok(ledger.ratingsByDifficulty.hard.Bot1.rating < 1200, "...and the opponent's moved down by the same match");
  assert.equal(ledger.ratingsByDifficulty.hard.You.games, 1);

  const standings = standingsFor(ledger, "hard");
  assert.deepEqual(standings.map(s => s.name), ["You", "Bot1"], "the human appears in the ordinary bracketed standings, ranked like anyone else");
  assert.equal(standings.find(s => s.name === "You").wins, 1);
  assert.equal(standings.find(s => s.name === "You").avgMargin, 30, "margin is recorded from the human's own point of view");
});

test("a human LOSS and a DRAW are recorded from the human's point of view, not the opponent's", () => {
  const ledger = startedGauntlet();
  recordGauntletMatch(ledger, { winner: "opponent", margin: -8 });
  recordGauntletMatch(ledger, { winner: "draw", margin: 0 });

  const you = standingsFor(ledger, "hard").find(s => s.name === "You");
  assert.deepEqual({ wins: you.wins, losses: you.losses, draws: you.draws }, { wins: 0, losses: 1, draws: 1 });
  assert.ok(ledger.ratingsByDifficulty.hard.You.rating < 1200, "losing then drawing leaves the human below the 1200 start");
});

test("recordGauntletMatch rejects an unrecognised winner and a call with no gauntlet or no fixture left, touching nothing", () => {
  const ledger = startedGauntlet();
  assert.throws(() => recordGauntletMatch(ledger, { winner: "player" }), /winner/i,
    "the engine's own owner ids are deliberately NOT accepted — the caller states the result in the gauntlet's own terms");
  assert.equal(ledger.gauntlet.nextIndex, 0, "a rejected result advances nothing");
  assert.equal(ledger.history.length, 0, "...and rates nothing");

  assert.throws(() => recordGauntletMatch(createLedger(), { winner: "human" }), /gauntlet/i);

  for (let i = 0; i < 3; i++) recordGauntletMatch(ledger, { winner: "human" });
  assert.throws(() => recordGauntletMatch(ledger, { winner: "human" }), /fixture|finished|complete/i);
  assert.equal(ledger.gauntlet.results.length, 3, "the finished gauntlet gained no fourth result");
});

/* ---------- D4: the seat edge is disclosed on every single human row ---------- */

test("EVERY human row records seatSwapped: false — the seat could not be swapped, and the row says so (D4)", () => {
  const ledger = startedGauntlet();
  recordGauntletMatch(ledger, { winner: "human", margin: 3 });
  recordGauntletMatch(ledger, { winner: "opponent", margin: -3 });
  recordGauntletForfeit(ledger, {});

  const rows = ledger.history.flatMap(h => h.rows);
  assert.equal(rows.length, 3, "three fixtures, three rows");
  for (const row of rows) {
    assert.equal(row.seatSwapped, false, "a human match is never side-swapped — the human is always owner \"player\" (D4)");
    assert.equal(row.human, true, "and the row is marked as a live human match, not a simulated one");
  }
});

test("a caller cannot talk a human row into claiming seatSwapped: true", () => {
  const ledger = startedGauntlet();
  recordGauntletMatch(ledger, { winner: "human", seatSwapped: true, human: false });
  const row = ledger.history[0].rows[0];
  assert.equal(row.seatSwapped, false, "seatSwapped is a FACT about the format, not a caller-supplied field");
  assert.equal(row.human, true);
});

test("a human row carries the fixture's real world/seed/swapAsym, so the match it records is identifiable and replayable", () => {
  const ledger = startedGauntlet();
  const fixture = currentGauntletFixture(ledger);
  recordGauntletMatch(ledger, { winner: "human", margin: 1, time: 612.5, winReason: "elimination" });
  const row = ledger.history[0].rows[0];
  assert.equal(row.world, fixture.world);
  assert.equal(row.seed, fixture.seed);
  assert.equal(row.swapAsym, fixture.swapAsym);
  assert.equal(row.difficulty, "hard");
  assert.equal(row.aName, "You");
  assert.equal(row.bName, "Bot1");
  assert.equal(row.winner, "a");
  assert.equal(row.winReason, "elimination");
  assert.equal(row.time, 612.5);
});

/* ---------- forfeits ---------- */

test("a forfeit records a rated LOSS for the human, never a silently dropped result", () => {
  const ledger = startedGauntlet();
  recordGauntletForfeit(ledger, { at: 4242 });

  assert.equal(ledger.gauntlet.nextIndex, 1, "a forfeit consumes its fixture exactly like a played match");
  assert.equal(ledger.gauntlet.results[0].winner, "opponent");
  assert.equal(ledger.gauntlet.results[0].forfeit, true, "...and is recorded AS a forfeit, so it can be shown as one");

  const row = ledger.history[0].rows[0];
  assert.equal(row.winner, "b", "the opponent won the row");
  assert.equal(row.forfeit, true);
  assert.equal(row.seatSwapped, false);
  assert.ok(ledger.ratingsByDifficulty.hard.You.rating < 1200, "a forfeit is rated normally — it costs real rating");
  assert.equal(standingsFor(ledger, "hard").find(s => s.name === "You").losses, 1);
});

test("gauntletProgress counts wins, losses, draws and forfeits, and knows when the run is finished", () => {
  const ledger = startedGauntlet();
  assert.deepEqual(
    (({ total, played, wins, losses, draws, forfeits, complete }) => ({ total, played, wins, losses, draws, forfeits, complete }))(gauntletProgress(ledger)),
    { total: 3, played: 0, wins: 0, losses: 0, draws: 0, forfeits: 0, complete: false });

  recordGauntletMatch(ledger, { winner: "human" });
  recordGauntletForfeit(ledger, {});
  recordGauntletMatch(ledger, { winner: "draw" });

  const p = gauntletProgress(ledger);
  assert.deepEqual({ total: p.total, played: p.played, wins: p.wins, losses: p.losses, draws: p.draws, forfeits: p.forfeits, complete: p.complete },
    { total: 3, played: 3, wins: 1, losses: 1, draws: 1, forfeits: 1, complete: true });
  assert.equal(gauntletProgress(createLedger()), null, "no gauntlet, no progress");
});

/* ---------- abandon ---------- */

test("abandonGauntlet clears the run but never rewrites history — the matches already played stay played", () => {
  const ledger = startedGauntlet();
  recordGauntletMatch(ledger, { winner: "human", margin: 9 });
  const ratedBefore = JSON.parse(JSON.stringify(ledger.ratingsByDifficulty));

  const returned = abandonGauntlet(ledger);
  assert.equal(returned, ledger, "abandonGauntlet returns the same ledger it mutated");
  assert.equal(ledger.gauntlet, null);
  assert.equal(currentGauntletFixture(ledger), null);
  assert.deepEqual(ledger.ratingsByDifficulty, ratedBefore, "the rating the played match earned is untouched");
  assert.equal(ledger.history.length, 1, "and so is its history row");
  assert.doesNotThrow(() => abandonGauntlet(ledger), "abandoning nothing is a silent no-op, not an error");
  assert.doesNotThrow(() => startGauntlet(ledger, { field: ["Bot1"], difficulty: "easy" }), "a new gauntlet can start once the old one is abandoned");
});

/* ---------- RESUMABILITY: the whole point of persisting any of this ---------- */

test("a half-played gauntlet round-trips through export/import completely unchanged", () => {
  const ledger = startedGauntlet();
  recordGauntletMatch(ledger, { winner: "human", margin: 14, at: 111 });
  recordGauntletForfeit(ledger, { at: 222 });

  const reimported = importLedgerJSON(JSON.stringify(exportLedger(ledger)));
  assert.deepEqual(reimported, ledger, "roster, ratings, history AND the in-progress gauntlet all survive the round trip");
  assert.equal(reimported.gauntlet.nextIndex, 2);
  assert.deepEqual(currentGauntletFixture(reimported), currentGauntletFixture(ledger),
    "the resumed ledger points at the same next fixture, on the same world, with the same seed");
});

test("a gauntlet survives a full localStorage save/load cycle — the browser closing mid-run must not lose it", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };

  const ledger = startedGauntlet();
  recordGauntletMatch(ledger, { winner: "human", margin: 4 });
  assert.equal(saveLedgerToStorage(ledger), true);

  const reloaded = loadLedgerFromStorage();
  assert.deepEqual(reloaded, ledger, "everything came back, gauntlet included");
  const fixture = currentGauntletFixture(reloaded);
  assert.equal(fixture.index, 1);
  assert.equal(fixture.opponent, "Bot2");

  // …and the resumed ledger keeps recording into the SAME run rather than starting a second one.
  recordGauntletMatch(reloaded, { winner: "opponent", margin: -2 });
  assert.equal(reloaded.gauntlet.nextIndex, 2);
  assert.equal(reloaded.history.length, 2);
  delete globalThis.localStorage;
});

/* ---------- THE SANITIZER: a hand-edited or imported gauntlet is untrusted input ---------- */

// Export a real ledger, mutate the plain JSON the way a hand-editor or a hostile file would, and
// import it back. Every assertion below proves what SURVIVED, not merely that something threw.
function tamper(mutate, { results = 1 } = {}) {
  const ledger = startedGauntlet();
  for (let i = 0; i < results; i++) recordGauntletMatch(ledger, { winner: "human", margin: 2 });
  const raw = exportLedger(ledger);
  mutate(raw);
  return { raw, imported: importLedgerJSON(JSON.stringify(raw)) };
}

test("the sanitizer coerces an out-of-range next-index back to the number of results actually recorded", () => {
  for (const bogus of [99, -1, 2.7, "2", null, undefined, NaN]) {
    const { imported } = tamper(raw => { raw.gauntlet.nextIndex = bogus; });
    assert.ok(imported.gauntlet, `a bad nextIndex (${String(bogus)}) is coerced, not a reason to drop the whole run`);
    assert.equal(imported.gauntlet.nextIndex, 1, "the RESULTS are the record of what was played; the index is bookkeeping that follows them");
    assert.equal(currentGauntletFixture(imported).index, 1, "so the resumed run points at the right fixture");
  }
});

test("the sanitizer DROPS a gauntlet whose field names an entrant that doesn't exist — never re-maps the remaining ones", () => {
  const { imported } = tamper(raw => { raw.gauntlet.field[1] = "Ghost"; raw.gauntlet.schedule[1].opponent = "Ghost"; });
  assert.equal(imported.gauntlet, null,
    "dropping just the bad name would silently re-index every later fixture and result onto the WRONG opponent");
  assert.deepEqual(imported.roster.map(r => r.name), ["You", "Bot1", "Bot2", "Bot3"], "the roster itself is untouched");
  assert.ok(imported.ratingsByDifficulty.hard.You, "and so is the rating the real, played match already earned");
  assert.equal(imported.history.length, 1);
});

test("the sanitizer drops a gauntlet naming the human as their own opponent, or naming a human who isn't on the roster / isn't flagged human", () => {
  assert.equal(tamper(raw => { raw.gauntlet.field[0] = "You"; raw.gauntlet.schedule[0].opponent = "You"; }).imported.gauntlet, null);
  assert.equal(tamper(raw => { raw.gauntlet.humanName = "Nobody"; }).imported.gauntlet, null);
  assert.equal(tamper(raw => { raw.roster.find(r => r.name === "You").human = false; }).imported.gauntlet, null,
    "a gauntlet whose human isn't the roster's human any more is inconsistent — drop it rather than guess");
});

test("the sanitizer drops a gauntlet whose schedule doesn't line up with its field, or names an impossible world", () => {
  assert.equal(tamper(raw => { raw.gauntlet.schedule.pop(); }).imported.gauntlet, null, "a short schedule");
  assert.equal(tamper(raw => { raw.gauntlet.schedule.push({ ...raw.gauntlet.schedule[0] }); }).imported.gauntlet, null, "a long schedule");
  assert.equal(tamper(raw => { raw.gauntlet.schedule[2].opponent = "Bot1"; }).imported.gauntlet, null, "a schedule out of step with the field");
  assert.equal(tamper(raw => { raw.gauntlet.schedule[0].world = "atlantis"; }).imported.gauntlet, null, "a world that doesn't exist");
  assert.equal(tamper(raw => { raw.gauntlet.schedule[0].seed = "hello"; }).imported.gauntlet, null, "a seed that isn't a number");
});

test("the sanitizer drops a gauntlet with more results than fixtures, or a result that isn't a real outcome", () => {
  assert.equal(tamper(raw => { raw.gauntlet.results.push({ ...raw.gauntlet.results[0], index: 1 }, { ...raw.gauntlet.results[0], index: 2 }, { ...raw.gauntlet.results[0], index: 3 }); }).imported.gauntlet, null,
    "more results than the schedule has fixtures");
  assert.equal(tamper(raw => { raw.gauntlet.results[0].winner = "everyone"; }).imported.gauntlet, null);
  assert.equal(tamper(raw => { raw.gauntlet.results[0].index = 5; }).imported.gauntlet, null, "a result that claims to be a fixture it isn't");
  assert.equal(tamper(raw => { raw.gauntlet.results = "all of them"; }).imported.gauntlet, null);
});

test("the sanitizer drops a gauntlet with an unknown difficulty, and defaults a nonsense match length instead of trusting it", () => {
  assert.equal(tamper(raw => { raw.gauntlet.difficulty = "impossible"; }).imported.gauntlet, null,
    "difficulty IS the rating bracket (D2) — an unknown one can't be rated into anything");
  for (const bogus of [0, -60, "long", 99999999, null]) {
    const { imported } = tamper(raw => { raw.gauntlet.matchTimeLimit = bogus; });
    assert.equal(imported.gauntlet.matchTimeLimit, GAUNTLET_DEFAULT_MATCH_SECONDS,
      `a match length of ${String(bogus)} is defaulted to Quick, not trusted`);
  }
});

test("the sanitizer drops a non-object gauntlet outright rather than reading fields off it", () => {
  for (const bogus of ["a gauntlet", 42, [], true]) {
    const { imported } = tamper(raw => { raw.gauntlet = bogus; });
    assert.equal(imported.gauntlet, null, `a gauntlet of ${JSON.stringify(bogus)} is no gauntlet`);
    assert.equal(imported.v, COMPETITION_VERSION, "…and the rest of the ledger still imported fine");
    assert.equal(imported.roster.length, 4);
  }
});

test("an imported ledger claiming TWO human entrants keeps only the first as human — and pollutes nothing", () => {
  const { imported } = tamper(raw => { raw.roster.find(r => r.name === "Bot2").human = true; });
  assert.deepEqual(imported.roster.map(r => r.name), ["You", "Bot1", "Bot2", "Bot3"], "no roster entry is lost — only the flag is corrected");
  assert.deepEqual(imported.roster.map(r => r.human), [true, false, false, false], "the FIRST human wins, exactly like the duplicate-name rule");
  assert.equal(humanEntry(imported).name, "You");
  assert.equal(Object.getPrototypeOf(imported), Object.prototype);
  assert.equal(({}).polluted, undefined, "Object.prototype itself must stay completely clean");
});

test("a gauntlet naming a forbidden identity string is dropped, and nothing is polluted", () => {
  for (const bad of ["__proto__", "constructor", "prototype"]) {
    const { imported } = tamper(raw => { raw.gauntlet.field[0] = bad; raw.gauntlet.schedule[0].opponent = bad; });
    assert.equal(imported.gauntlet, null, `a field naming "${bad}" is dropped`);
    const humanNamed = tamper(raw => { raw.gauntlet.humanName = bad; }).imported;
    assert.equal(humanNamed.gauntlet, null, `a humanName of "${bad}" is dropped`);
    assert.equal(Object.getPrototypeOf(humanNamed), Object.prototype, "the imported ledger's own prototype is untouched");
    assert.equal(({}).polluted, undefined);
    assert.equal(({}).rating, undefined);
  }
});

test("an imported HUMAN history row can never claim seatSwapped: true, whatever the file says (D4)", () => {
  const { imported } = tamper(raw => {
    raw.history[0].rows[0].seatSwapped = true;
    raw.history[0].rows[0].human = true;
  });
  assert.equal(imported.history[0].rows[0].seatSwapped, false,
    "the seat edge is disclosed by the FORMAT, not by whatever a hand-edited file asserts");
  assert.equal(imported.history[0].rows[0].human, true);
});

// The near-miss the strict-boolean check would have let through: a row claiming humanness in some
// truthy-but-not-boolean way, alongside a seatSwapped: true it must not be allowed to keep.
test("a merely TRUTHY claim of humanness on an imported row is normalised into the disclosed form, not waved through", () => {
  const { imported } = tamper(raw => {
    raw.history[0].rows[0].seatSwapped = true;
    raw.history[0].rows[0].human = "definitely";
  });
  assert.equal(imported.history[0].rows[0].human, true, "any claim of humanness normalises to a real boolean");
  assert.equal(imported.history[0].rows[0].seatSwapped, false, "...and takes the disclosure with it");
});

// The mirror of the rule above, in the direction where the strictness runs the other way: on the
// ROSTER, junk must not GRANT the human seat (test "the sanitizer coerces a non-boolean human flag"
// covers addRosterEntry's half of the same rule).
test("a merely TRUTHY human flag on an imported ROSTER entry does not make that entry the human", () => {
  const { imported } = tamper(raw => {
    raw.roster.find(r => r.name === "You").human = false;
    raw.roster.find(r => r.name === "Bot2").human = 1;
  });
  assert.deepEqual(imported.roster.map(r => r.human), [false, false, false, false]);
  assert.equal(humanEntry(imported), null, "nobody claimed the seat with a 1");
});

test("an imported ledger with no gauntlet field at all is fine — the field is additive, so an older stored ledger still loads", () => {
  const older = { v: COMPETITION_VERSION, roster: [{ name: "Blitz", strategy: "aggressive" }], ratingsByDifficulty: {}, history: [] };
  const imported = importLedgerJSON(JSON.stringify(older));
  assert.equal(imported.gauntlet, null, "no gauntlet means exactly what it always meant: none in progress");
  assert.equal(imported.roster[0].human, false, "and a roster entry written before the flag existed is simply not the human");
  assert.equal(imported.roster[0].strategy, "aggressive", "…with everything else it did carry intact");
});
