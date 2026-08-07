// @ts-check
"use strict";

/* ============================================================
   THE COMPETITION LEDGER (docs/competitions-and-elo.md Phase 2, D8) — the persisted roster + Elo
   ladder behind the in-game competition screen. Root-level, not under engine/ — like elo.js, a
   ladder is not sim state (D1's own reasoning); like saveload.js, this module touches
   localStorage, which the engine is never allowed to (CONTRIBUTING.md).

   THIS IS A REAL, PERSISTED, UNTRUSTED-INPUT BOUNDARY, not a toy. Two distinct ways a hostile or
   merely corrupt payload can reach it: localStorage (reachable by any script/devtools on this
   origin) and a JSON file a player can hand-edit, download from anywhere, or receive from another
   player and import. engine/persist.js's sanitizeSave/cleanEntity/cleanController hardening is the
   model this file mirrors DELIBERATELY, not by analogy — same three structural guards (forbidden
   prototype-pollution keys, a node-count cap, a depth cap, a max string length), same two-step
   shape (a structural gate that THROWS on anything unsafe, then per-field coercion that silently
   drops/defaults anything merely wrong rather than trusting it), same exact-match version gate. See
   sanitizeLedgerStructure below for the structural gate and importLedgerJSON for the full pipeline.

   SHAPE (design already made in the doc — this module implements it):
     { v: COMPETITION_VERSION,
       roster: [ { name, strategy, archetype, faction, createdAt, human }, … ],
       ratingsByDifficulty: { [difficulty]: RatingsTable, … },   // elo.js RatingsTable, ONE PER BRACKET
       history: [ { at, difficulty, aName, bName, rows }, … ],   // rows: competitionWorker.js's own "done" rows shape, verbatim
       gauntlet: GauntletState|null }                            // Phase 4 — the in-progress human run, see THE GAUNTLET below

   THE GAUNTLET (docs/competitions-and-elo.md Phase 4 — added on top of everything above, changing
   none of it). A Gauntlet is the human against a field of AI roster entrants, ONE live match per
   opponent, in field order. That one-match-per-opponent rule is the whole reason this is the
   human-inclusive format that ships first: an AI-vs-AI pairing is worlds x seeds x 2 sides of
   simulated matches — a few seconds of compute — but a person cannot play 40 real matches.

   It lives INSIDE the ledger object, as one more top-level field, rather than in a second
   localStorage key: that way it rides the existing versioned sanitize/export/import/rotate pipeline
   for free, and "the ladder" and "the run currently moving it" can never get out of step with each
   other by being written separately. Resumability is the requirement it exists to satisfy — a
   gauntlet spans hours of real play across many sessions, so the browser WILL be closed mid-run,
   and its field, pinned difficulty, match length, whole world/seed schedule, every result so far
   and the index of the next unplayed fixture all have to come back exactly as they were.

   D4, stated here because it is a persistence rule and not only a UI one: the human is always owner
   "player", so a human pairing CANNOT be side-swapped (state.fog aliases state.fogs.player;
   input.js/hud.js resolve the human seat as "player" throughout). tools/selfplay.js's own header
   measures the "ai" seat reading state the "player" seat already mutated on ~13% of think cycles,
   FIXED IN DIRECTION, always favouring the "ai" seat — the seat the human does NOT sit in. So every
   human row this module writes records `seatSwapped: false` as a FACT of the format (never a
   caller-supplied field, and never trusted off an imported file either — see cleanHistoryRow), the
   map-side control `swapAsym` still alternates by match-index parity so the map half stays balanced,
   and there is deliberately NO compensating rating fudge: a disclosed, bounded, one-directional
   bias is honest; an underivable correction factor is not.

   A roster entry deliberately carries NO difficulty field. Difficulty is the BRACKET axis
   (ratingsByDifficulty's own keys), never part of an entrant's identity (D2) — the same named
   entrant accumulates SEPARATE ratings at, say, medium and hard, as two different brackets, never
   one blended number. elo.js itself stays completely unaware any of this "bracket" concept exists
   (see its own header) — this module is the caller that keeps two ratings objects apart, exactly
   the shape elo.js's header already anticipates.

   THE __proto__ HAZARD, and where it's actually guarded: elo.js's RatingsTable is a plain object
   keyed by entrant NAME (`ratings[aName] = {...}`). Ordinary property assignment on a plain object
   is not what JSON.parse does — assigning through a runtime string equal to "__proto__" trips
   Object.prototype's own __proto__ accessor and REASSIGNS THE OBJECT'S PROTOTYPE instead of
   creating a normal entry (Phase 1 review flagged exactly this, as a nit, when nothing persisted —
   see docs/competitions-and-elo.md's Phase 2 section for the full note). Persisting the roster
   turns that from a session curiosity into a durable, reusable, importable hazard, so it gets a
   real guard here: assertValidEntrantName is checked at BOTH of this module's two entrant-identity-
   minting seams — addRosterEntry (a name typed once, by a person) and recordCompetition (a name
   folded into a RatingsTable via elo.js's applyResult) — not inside elo.js itself, whose own
   contract ("the caller owns the ratings table") is fine as-is. A forbidden key arriving via
   JSON (roster/ratingsByDifficulty structurally carrying a literal "__proto__" OWN PROPERTY, which
   is how JSON.parse — unlike ordinary assignment — actually stores it) is a DIFFERENT mechanism
   and is caught by sanitizeLedgerStructure's forbidden-key walk instead; both seams matter, for
   two different reasons, and neither substitutes for the other.
   ============================================================ */

import { applySeries, PROVISIONAL_GAMES } from "./elo.js";
import { STRATEGIES } from "./engine/aiStrategy.js";
import { ARCHETYPES, PLANET_ARCHETYPE } from "./engine/aiArchetypes.js";
import { FACTIONS } from "./engine/factions.js";
import { DIFFICULTY_OPTIONS } from "./engine/aiDifficulty.js";
import { hashStr } from "./engine/rng.js";
import { sanitizeGenome } from "./tools/genome.js";

/**
 * @typedef {{ name: string, strategy: string, archetype: string|null, faction: string, createdAt: number|null, human: boolean }} RosterEntry
 *   `archetype` is a STRING KEY into engine/aiArchetypes.js's ARCHETYPES table (D3), or null for
 *   "no override — use whatever the world/planet hands out". Deliberately carries no difficulty
 *   field (see this file's header) — difficulty is the ratingsByDifficulty bracket axis, not part
 *   of an entrant's identity.
 *   `human` (Phase 4) marks THE one entry that is the player themself. At most one entry may carry
 *   it; it is otherwise an ordinary entrant, rated in the same bracketed tables as everyone else
 *   (D1: a human rating has to mean what an AI rating means, or comparing them is meaningless).
 *   Always present and always a real boolean — an entry written before this field existed imports
 *   as `human: false`, which is exactly what it always meant.
 */
/**
 * @typedef {{ opponent: string, world: string, seed: number, swapAsym: boolean }} GauntletFixture
 *   ONE live match: which AI entrant, on which world, from which map seed, with which half of an
 *   asymmetric map (engine/map.js's asym block on oort/nimbus). Built by gauntletFixture below,
 *   once, for the whole run at startGauntlet time — never re-derived afterwards, so a resume
 *   replays the identical fixture rather than a freshly-rolled one (D6).
 */
/**
 * @typedef {{ index: number, winner: "human"|"opponent"|"draw", forfeit: boolean, margin: number, at: number|null }} GauntletResult
 *   One resolved fixture, stated from the HUMAN's point of view — `index` is its own position in
 *   `schedule`, and `margin` is engine/victory.js's score margin signed the human's way, the same
 *   aName-relative convention standingsFor already reads history rows with.
 */
/**
 * @typedef {Object} GauntletState  An in-progress (or just-finished) Gauntlet — see this file's header.
 * @property {string} humanName        the human entrant's roster name, snapshotted at start.
 * @property {string[]} field          the AI opponents, IN PLAY ORDER. Index-aligned with `schedule`.
 * @property {string} difficulty       pinned once for the whole run — every opponent plays at it,
 *   and it is the rating bracket the whole gauntlet lands in (D2). Never per-opponent.
 * @property {number} matchTimeLimit   seconds, setup.js's own Match length convention (Quick 1200 /
 *   Standard 2400 / Marathon 3600). Pinned for the whole run, like difficulty.
 * @property {number} seedBase         the one number every fixture's world/seed derives from (D6).
 * @property {GauntletFixture[]} schedule   one fixture per field entrant, same length, same order.
 * @property {GauntletResult[]} results     resolved fixtures, in play order — results[i] resolves schedule[i].
 * @property {number} nextIndex        the next UNPLAYED fixture's index; === results.length, and ===
 *   schedule.length exactly when the run is finished. Stored rather than derived so a resumed run
 *   reads back "where am I" directly; the sanitizer coerces it back to results.length if a
 *   hand-edited ledger ever disagrees (the results are the record, the index is bookkeeping).
 * @property {number|null} startedAt   injected wall-clock ms, or null — never read from a clock here
 *   (this module is pure; timestamps arrive from the UI layer, same as recordCompetition's `at`).
 */
/**
 * @typedef {{ at: number|null, difficulty: string, aName: string, bName: string, rows: object[] }} LedgerHistoryEntry
 *   `rows` is exactly competitionWorker.js's own "done" message rows field — this module treats it
 *   as opaque data it stores and reads back (aName/bName/winner/margin), never a shape it invents.
 */
/** @typedef {Object.<string, { rating: number, games: number }>} LedgerRatingsTable  elo.js's own RatingsTable shape. */
/**
 * @typedef {{ matches: number, entrants: number, brackets: Array<{ difficulty: string, top: string|null, topRating: number|null, entrants: number, matches: number }> }} SeasonSummary
 *   Always DERIVED from a season's own ratings/history, never stored-and-trusted — see seasonSummary.
 */
/**
 * @typedef {{ label: string, finishedAt: number|null, ratingsByDifficulty: Object.<string, LedgerRatingsTable>, history: LedgerHistoryEntry[], summary: SeasonSummary }} ArchivedSeason
 *   One CLOSED season (Phase 5): the ratings and history that were live when it was archived, under
 *   a label, with the wall-clock finish time the UI layer injected (never read from a clock here).
 *   Deliberately carries no roster of its own — the roster persists across seasons; only ratings
 *   restart. See the SEASONS section below.
 */
/**
 * @typedef {{ v: number, roster: RosterEntry[], ratingsByDifficulty: Object.<string, LedgerRatingsTable>, history: LedgerHistoryEntry[], gauntlet: GauntletState|null, seasons: ArchivedSeason[] }} CompetitionLedger
 */
/**
 * @typedef {{ roster: Array<{ name: string, human?: boolean }>, ratingsByDifficulty?: Object.<string, LedgerRatingsTable>, history?: LedgerHistoryEntry[] }} StandingsSource
 *   Exactly what standingsFor reads — a whole CompetitionLedger satisfies it, and so does a CLOSED
 *   season paired with a row list (seasonStandings below), which is what lets one function render
 *   both the live ladder and an archived one.
 */
/**
 * @typedef {{ name: string, rating: number, games: number, wins: number, losses: number, draws: number, avgMargin: number, provisional: boolean, human: boolean }} Standing
 */

// Exact-match version gate on load (CONTRIBUTING.md's save-versioning rule, applied to this
// second, separately-versioned store — the game's own SAVE_VERSION/GALAXY_SAVE_VERSION are
// untouched by any of this). Bump this whenever the ledger's shape changes in a way an older
// ledger can't survive; a purely additive field doesn't need a bump, same rule as engine/persist.js.
//
// PHASE 4 DELIBERATELY DID NOT BUMP THIS, and here is the reasoning, since the call is the kind
// that should be recorded rather than re-argued. Phase 4 added exactly two things: `human` on a
// roster entry, and `gauntlet` on the ledger. Both are purely additive optional fields whose
// ABSENCE already has the right meaning in every ledger written before them — an entry with no
// `human` flag was an AI entrant (cleanRosterEntry defaults it to false), and a ledger with no
// `gauntlet` had no gauntlet in progress (cleanLedgerShape defaults it to null). No existing
// field's type, range or meaning changed, so no already-stored ledger deserializes into something
// WRONG, which is the actual test CONTRIBUTING.md sets for a bump. And the gate has no migration
// step: bumping would make every ladder ever saved unloadable, silently discarding real ratings and
// history, in exchange for no safety at all.
//
// PHASE 5 DELIBERATELY DID NOT BUMP IT EITHER, by the same test, applied to its one new field:
// `seasons` on the ledger. A ledger written before it existed has no archived seasons, and that is
// exactly what its absence means — cleanLedgerShape defaults it to [], which reads back as "this
// ladder has always been one season", which is true. No existing field's type, range or meaning
// changed: `ratingsByDifficulty`/`history` still mean "the CURRENT season's ratings/history", which
// is what they meant when there was only ever one season. Nothing already stored deserializes into
// something WRONG, so the CONTRIBUTING.md rule-3 test for a bump is not met, and the no-migration
// gate would cost every existing ladder for no safety gained. (Replay, the other Phase 5 half,
// adds no stored field at all — it re-reads rows the ledger already had.)
// A roster entry may carry its OWN GENOME (docs/ai-evolution-design.md) — a player-authored or
// player-mirrored AI rather than one of the four shipped strategies. That genome arrives from
// untrusted places (an imported ladder file, a mirror someone was sent) and is written straight
// into the live AI tables at duel time, so it is validated against GENOME_SCHEMA exactly like every
// other field here is validated against its own enum. sanitizeGenome is a WHITELIST: unknown keys
// dropped, numbers coerced and clamped, categoricals checked against their declared alleles.
export const COMPETITION_VERSION = 1;

// A Gauntlet's default match length, in seconds — setup.js's own MATCH_LENGTH_OPTIONS "Quick"
// (20 minutes). Quick is the Phase 4 brief's mandated default for a reason worth keeping next to
// the number: a five-opponent gauntlet is FIVE real matches back to back, which at Standard (40
// min) is over three hours of play and at Quick is comfortably under two. Exported so the config
// screen defaults from the same constant the sanitizer falls back to.
export const GAUNTLET_DEFAULT_MATCH_SECONDS = 1200;

// The band a stored/typed match length has to land in to be believed: anything from a 1-minute
// sprint to a 2-hour epic. Wider than the three options the UI offers on purpose — this is the
// "is this a plausible number of seconds at all" guard, not a re-statement of the picker.
const GAUNTLET_MIN_MATCH_SECONDS = 60;
const GAUNTLET_MAX_MATCH_SECONDS = 7200;

// --- known-value tables, so untrusted/careless data is validated against the SAME enums the rest
// of the engine already treats as canonical, rather than this module inventing its own copy. ----
const KNOWN_STRATEGIES = new Set(Object.keys(STRATEGIES));
const KNOWN_ARCHETYPES = new Set(Object.keys(ARCHETYPES));
const KNOWN_FACTIONS = new Set(Object.keys(FACTIONS));
const KNOWN_DIFFICULTIES = new Set(DIFFICULTY_OPTIONS.map(o => o.mult));
// The skirmish world list, straight off engine/aiArchetypes.js's PLANET_ARCHETYPE — the same nine
// keys setup.js's own MAP_CHOICES is built from, and for the same reason it's built there rather
// than typed out: a world can't exist in one list and not the other. Read here (not imported from
// setup.js) because setup.js is a DOM-layer module in competition.js's own import cycle, and this
// module deliberately sits outside it — see this file's header.
const KNOWN_WORLDS = Object.keys(PLANET_ARCHETYPE);
const KNOWN_WORLD_SET = new Set(KNOWN_WORLDS);

// The three property names that collide with JavaScript's own object internals when used as a
// live object KEY — see this file's header. Same set, same three strings, as
// engine/persist.js's FORBIDDEN_KEYS; kept as this module's own copy (not a shared import) so the
// two hardening boundaries stay independently correct, the same way the two modules' node/depth/
// string caps are independently TUNED even though they guard the identical class of hazard.
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// Reject one of the three forbidden strings as an entrant name — called at both of this module's
// entrant-identity-minting seams (addRosterEntry, recordCompetition). Assumes `name` is already
// known to be a non-empty string; each call site does its own blank/type check first, since their
// "needs a name" messages differ enough by context to not share one generic string.
function assertValidEntrantName(name) {
  if (FORBIDDEN_NAMES.has(name)) {
    throw new Error(
      `"${name}" can't be used as an entrant name — it collides with JavaScript's own object ` +
      `internals when used as an elo.js RatingsTable key (see this file's header)`
    );
  }
}

/* ============================================================
   CREATE / ROSTER CRUD
   ============================================================ */

/**
 * A brand-new, empty competition ledger — the shape every other export in this module reads and
 * writes. `ratingsByDifficulty` starts with no brackets at all; recordCompetition below creates
 * one lazily, per difficulty, on first use.
 * @returns {CompetitionLedger}
 */
export function createLedger() {
  /** @type {CompetitionLedger} */
  const ledger = { v: COMPETITION_VERSION, roster: [], ratingsByDifficulty: {}, history: [], gauntlet: null, seasons: [] };
  return ledger;
}

/**
 * The ONE roster entry flagged `human: true`, or null if the player hasn't added themself yet.
 * Every "is there a human, and what are they called" question — startGauntlet's own, and the UI's —
 * funnels through this rather than re-scanning the roster with its own predicate, so "exactly one
 * human" is read the same way it is enforced (addRosterEntry below, and cleanRoster on import).
 * @param {CompetitionLedger} ledger
 * @returns {RosterEntry|null}
 */
export function humanEntry(ledger) {
  return ((ledger && ledger.roster) || []).find(r => r.human === true) || null;
}

/**
 * Add a new roster entry, mutating and returning `ledger` (elo.js's own "mutate and return" idiom
 * — see applyResult/applySeries). Rejects — throws, touching nothing — a missing/blank name, one
 * of the three forbidden identity-hazard strings, a name already on the roster, or a SECOND
 * `human: true` entry; every other field is coerced to a known-safe value rather than trusted
 * verbatim (the same enum-or-fallback idiom engine/persist.js's cleanController already uses for
 * strategy/difficulty), `human` included — only a real boolean `true` marks the human, so a
 * truthy-but-not-boolean value from a form or a config file can't quietly claim the seat.
 *
 * WHY ONLY ONE HUMAN: the flag answers "which of these entrants is the person sitting here", and
 * that has exactly one answer. A second one would make humanEntry's answer depend on roster order,
 * and would let a Gauntlet be started as one identity and rated as another.
 * @param {CompetitionLedger} ledger
 * @param {{ name: string, strategy?: string, archetype?: string|null, faction?: string, createdAt?: number, human?: boolean }} [entry]
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function addRosterEntry(ledger, entry) {
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  if (!name) throw new Error("a roster entry needs a name");
  assertValidEntrantName(name);
  if (ledger.roster.some(r => r.name === name)) throw new Error(`an entrant named "${name}" is already on the roster`);
  const human = entry?.human === true;
  if (human) {
    const existing = humanEntry(ledger);
    if (existing)
      throw new Error(`"${existing.name}" is already the human entrant — there can only be one, so remove it first`);
  }
  // A genome makes this entrant its OWN strategy rather than a named shipped one: the row is
  // written into STRATEGIES under the entrant's name at duel time (competitionWorker.js), so the
  // strategy field carries that name instead of being flattened to "default" by the enum check.
  const genome = entry?.genome ? sanitizeGenome(entry.genome) : null;
  ledger.roster.push({
    name,
    strategy: genome ? name : (KNOWN_STRATEGIES.has(entry?.strategy) ? entry.strategy : "default"),
    archetype: KNOWN_ARCHETYPES.has(entry?.archetype) ? entry.archetype : null,
    faction: KNOWN_FACTIONS.has(entry?.faction) ? entry.faction : "neutral",
    createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : null,
    human,
    // Present ONLY when there is one. An entry naming a shipped strategy keeps exactly the shape it
    // has always had — the same "additive, absent means the old behaviour" discipline every other
    // field in this project follows, and it means existing rosters and exported ladders are
    // byte-identical rather than gaining a null nobody asked for.
    ...(genome ? { genome } : {}),
  });
  return ledger;
}

/**
 * Remove the roster entry named `name`, if any — a no-op (not an error) when no such entry exists,
 * the same "deleting something already gone isn't exceptional" treatment engine/state.js's
 * removeEntity gives a stale id. Deliberately does NOT touch ratingsByDifficulty or history: a
 * recorded rating/match is a fact about a competition that really happened, and outlives the
 * roster entry that triggered it (standingsFor reads the CURRENT roster back against each
 * bracket's table, so a removed entrant simply stops appearing in any future standings).
 *
 * ONE THING A CALLER OWNS, not this function: removing an entrant who is the human, or who is named
 * in an IN-PROGRESS gauntlet's field, leaves that gauntlet internally inconsistent — it keeps
 * running for the rest of this session and is then dropped by cleanGauntlet on the next load (a
 * gauntlet may only name entrants that still exist; see that function's severity note). This isn't
 * refused here because a roster edit is an ordinary, expected act and the ledger is not the place
 * to litigate it — but a UI offering both should confirm before doing it.
 * @param {CompetitionLedger} ledger
 * @param {string} name
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function removeRosterEntry(ledger, name) {
  ledger.roster = ledger.roster.filter(r => r.name !== name);
  return ledger;
}

/* ============================================================
   RECORD A FINISHED COMPETITION
   ============================================================ */

/**
 * Fold a finished competition's match rows into `ledger`: apply them, via elo.js's applySeries, to
 * the ratings table for `difficulty` (creating that bracket's table on first use) — in the EXACT
 * order `rows` already carries, never re-sorted (D6: Elo is order-dependent) — then append one
 * history entry recording the whole run. Every entrant name (the top-level aName/bName AND each
 * row's own aName/bName — a row's names are what actually reaches elo.js, so both seams are
 * checked) is validated BEFORE anything is mutated, so a rejected call leaves `ledger` completely
 * untouched — the same "guard fires before any mutation" discipline elo.js's own applyResult holds
 * itself to for the same-name collision it guards against.
 * @param {CompetitionLedger} ledger
 * @param {{ at?: number, difficulty: string, aName: string, bName: string, rows: object[] }} entry
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function recordCompetition(ledger, entry) {
  const { at, difficulty, aName, bName, rows } = entry || {};
  if (!KNOWN_DIFFICULTIES.has(difficulty)) throw new Error(`recordCompetition: unknown difficulty "${difficulty}"`);
  if (typeof aName !== "string" || !aName) throw new Error("recordCompetition needs aName");
  if (typeof bName !== "string" || !bName) throw new Error("recordCompetition needs bName");
  assertValidEntrantName(aName);
  assertValidEntrantName(bName);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("recordCompetition needs at least one match row");

  // Validate and shape every row into an elo.js MatchRow BEFORE touching the ledger at all.
  const matchRows = rows.map((r, i) => {
    if (!r || typeof r.aName !== "string" || typeof r.bName !== "string")
      throw new Error(`recordCompetition: row ${i} needs aName and bName`);
    assertValidEntrantName(r.aName);
    assertValidEntrantName(r.bName);
    if (r.winner !== "a" && r.winner !== "b" && r.winner !== "draw")
      throw new Error(`recordCompetition: row ${i} has an invalid winner: ${r.winner}`);
    return { aName: r.aName, bName: r.bName, score: r.winner === "a" ? 1 : r.winner === "draw" ? 0.5 : 0 };
  });

  const table = ledger.ratingsByDifficulty[difficulty] || (ledger.ratingsByDifficulty[difficulty] = {});
  applySeries(table, matchRows);
  ledger.history.push({
    at: Number.isFinite(at) ? at : null,
    difficulty, aName, bName,
    rows: JSON.parse(JSON.stringify(rows)),   // detached copy — the caller's own array is never aliased into the ledger
  });
  return ledger;
}

/* ============================================================
   READ BACK — bracket standings
   ============================================================ */

/**
 * One bracket's standings, shaped for display: one row per CURRENT roster entry that has actually
 * played a rated match at `difficulty` (i.e. has an entry in that bracket's ratings table) — a
 * roster entry that has never competed at this difficulty contributes no row, and a rating left
 * behind by a since-removed roster entry contributes no row either (this reads the roster as the
 * row list, not the ratings table). Sorted by rating descending, ties broken by name — a
 * leaderboard, not insertion order. W/L/D and avgMargin aren't in elo.js's RatingsTable at all
 * (it only ever tracks rating + games), so they're derived here by re-scanning `history` for this
 * difficulty; avgMargin is signed from THIS entrant's own perspective (their score minus the
 * opponent's, averaged — a row's own `margin` field is always aName-relative, so a row where this
 * entrant played as B contributes its negation). Each row also carries the roster entry's own
 * `human` flag, so a table mixing the person in with the AI field can mark which row is them and
 * state D4's seat disclosure beside it (see the Gauntlet section below) without re-reading the
 * roster it just summarised.
 * @param {StandingsSource} ledger  the live ledger, or a closed season's own tables (seasonStandings)
 * @param {string} difficulty
 * @returns {Standing[]}
 */
export function standingsFor(ledger, difficulty) {
  const table = (ledger.ratingsByDifficulty && ledger.ratingsByDifficulty[difficulty]) || {};
  const relevantHistory = (ledger.history || []).filter(h => h.difficulty === difficulty);

  const rows = [];
  for (const entrant of ledger.roster) {
    // Object.hasOwn, not a truthy `table[entrant.name]` check: a plain object inherits from
    // Object.prototype, so an entrant legitimately named e.g. "toString" (not one of the three
    // FORBIDDEN_NAMES — those are barred outright at addRosterEntry) would otherwise read back the
    // INHERITED function as a truthy "rating" and produce a garbage standings row instead of being
    // correctly skipped as "hasn't played this bracket yet".
    if (!Object.hasOwn(table, entrant.name)) continue;
    const rated = table[entrant.name];

    let wins = 0, losses = 0, draws = 0, marginTotal = 0, marginGames = 0;
    for (const h of relevantHistory) {
      for (const row of h.rows) {
        const asA = row.aName === entrant.name, asB = row.bName === entrant.name;
        if (!asA && !asB) continue;
        if (row.winner === "draw") draws++;
        else if ((asA && row.winner === "a") || (asB && row.winner === "b")) wins++;
        else losses++;
        const margin = Number.isFinite(row.margin) ? row.margin : 0;
        marginTotal += asA ? margin : -margin;
        marginGames++;
      }
    }

    rows.push({
      name: entrant.name,
      rating: rated.rating,
      games: rated.games,
      wins, losses, draws,
      avgMargin: marginGames ? marginTotal / marginGames : 0,
      provisional: rated.games < PROVISIONAL_GAMES,
      // Carried through from the roster entry rather than left for the caller to re-look-up: a
      // standings table is exactly where D4's seat disclosure has to be stated, and a display layer
      // can only know to state it (and which row to mark as you) if the rows say who is the human.
      human: entrant.human === true,
    });
  }

  rows.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  return rows;
}

/* ============================================================
   THE GAUNTLET (docs/competitions-and-elo.md Phase 4) — the human against a field of AI roster
   entrants, ONE live match each, in field order. See this file's header for the format's own
   reasoning and for D4's seat rule; this section is the persistence and rating half of it.

   THREE THINGS EVERY FUNCTION BELOW HOLDS TO:
     • The schedule is derived ONCE, at start, from (seedBase, difficulty, names, index) through
       hashStr — the same style tools/duelCore.js's duelSeed derives a duel seed (D6), and for the
       same reason: a run that re-rolled its fixtures on resume would hand a player a different map
       for the match they were halfway through when the tab closed. duelSeed itself is deliberately
       NOT imported: it lives in tools/duelCore.js, which pulls in tools/selfplay.js and most of the
       engine behind it, and this module's dependency surface is kept small on purpose (header).
     • Rating goes through recordCompetition — the same call an AI-vs-AI duel and every tournament
       pairing already make — so a human rating is computed by the same elo.js code, in the same
       bracketed table, as everyone else's (D1). There is no parallel human rating path to drift.
     • A fixture is consumed EXACTLY once, and only after the rating write has succeeded. Validate,
       then rate, then advance: a rejected call leaves both the ratings and the gauntlet untouched,
       the same "guard fires before any mutation" discipline recordCompetition holds itself to.
   ============================================================ */

// One fixture's world and seed. The world is drawn from the pool by hash (not by cycling the pool,
// which would make a 3-world pool and a 3-opponent field always play world[i] — a pattern the
// player would notice and the seed would have no say in); the seed then folds that world in, in
// duelSeed's own `base:kind:world:difficulty:sortedNames:index` shape. Names are SORTED into the
// hash exactly as duelSeed sorts a duel's pair — here it costs nothing (the human is always seat
// "player"), and it keeps the two derivations recognisably the same thing.
function gauntletFixture(seedBase, difficulty, humanName, opponent, index, worlds) {
  const world = worlds[hashStr(`${seedBase}:gauntlet:world:${difficulty}:${opponent}:${index}`) % worlds.length];
  return {
    opponent,
    world,
    seed: hashStr(`${seedBase}:gauntlet:${world}:${difficulty}:${[humanName, opponent].sort().join("|")}:${index}`),
    // The ONE half of the seat-asymmetry correction still available to a human match (D4): the
    // map's own asym halves alternate by match-index parity, exactly as competitionWorker.js
    // alternates them by replicate parity for an AI-vs-AI duel. The SEAT cannot alternate.
    swapAsym: index % 2 === 1,
  };
}

/**
 * Start a Gauntlet: the human (whoever `humanEntry` resolves to) against `field`, one live match
 * each, at ONE pinned difficulty and ONE pinned match length. Throws — touching nothing — if there
 * is no human entrant, if a gauntlet is already in progress (progress is never silently discarded;
 * abandonGauntlet is the explicit way out), or if the field/difficulty/worlds don't check out.
 * @param {CompetitionLedger} ledger
 * @param {{ field: string[], difficulty: string, matchTimeLimit?: number, worlds?: string[], seedBase?: number, at?: number }} opts
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function startGauntlet(ledger, opts) {
  const { field, difficulty, matchTimeLimit, worlds, seedBase, at } = opts || {};
  if (ledger.gauntlet)
    throw new Error("a gauntlet is already in progress — finish or abandon it before starting another");
  const human = humanEntry(ledger);
  if (!human) throw new Error("add yourself to the roster as the human entrant before starting a gauntlet");
  if (!KNOWN_DIFFICULTIES.has(difficulty)) throw new Error(`startGauntlet: unknown difficulty "${difficulty}"`);

  const raw = Array.isArray(field) ? field : [];
  if (raw.length === 0) throw new Error("a gauntlet needs at least one opponent in the field");
  // Trimmed up front, the same normalisation addRosterEntry applies to a name it stores — so the
  // membership check below and the stored field agree on one spelling of each opponent.
  const names = raw.map(n => (typeof n === "string" ? n.trim() : ""));
  const seen = new Set();
  for (const name of names) {
    if (!name) throw new Error("every gauntlet opponent needs a name");
    if (name === human.name) throw new Error("you can't be your own opponent — leave yourself out of the field");
    if (!ledger.roster.some(r => r.name === name)) throw new Error(`"${name}" isn't on the roster`);
    if (seen.has(name)) throw new Error(`"${name}" is in the field twice — each opponent is played exactly once`);
    seen.add(name);
  }
  // Not redundant with the roster check above, even though addRosterEntry/cleanRoster both already
  // bar these three strings: a ledger assembled in memory rather than through those seams could
  // still carry one, and it must fail HERE — at the start, touching nothing — rather than at the
  // first recordGauntletMatch, which would leave a real, scheduled run that can never be recorded.
  assertValidEntrantName(human.name);
  for (const name of names) assertValidEntrantName(name);

  // An explicit pool is filtered to worlds that really exist and rejected if that leaves nothing;
  // no pool at all means the whole skirmish roster, which is what a player who never touched the
  // picker means by it.
  const pool = Array.isArray(worlds) ? worlds.filter(w => KNOWN_WORLD_SET.has(w)) : [];
  if (Array.isArray(worlds) && pool.length === 0) throw new Error("pick at least one real world for the gauntlet");
  const worldPool = pool.length ? pool : KNOWN_WORLDS;

  const base = (Number(seedBase) || 0) >>> 0;
  /** @type {GauntletState} */
  ledger.gauntlet = {
    humanName: human.name,
    field: [...names],
    difficulty,
    matchTimeLimit: cleanMatchTimeLimit(matchTimeLimit),
    seedBase: base,
    schedule: names.map((opponent, i) => gauntletFixture(base, difficulty, human.name, opponent, i, worldPool)),
    results: [],
    nextIndex: 0,
    startedAt: Number.isFinite(at) ? at : null,
  };
  return ledger;
}

/**
 * The next UNPLAYED fixture, flattened into everything a live match needs to be booted and later
 * recorded — or null when there's no gauntlet, or when every fixture has already been played (a
 * finished run has no NEXT match; gauntletProgress below is what reads a finished one back).
 * @param {CompetitionLedger} ledger
 * @returns {{ index: number, total: number, opponent: string, world: string, seed: number,
 *   swapAsym: boolean, difficulty: string, matchTimeLimit: number, humanName: string }|null}
 */
export function currentGauntletFixture(ledger) {
  const g = ledger && ledger.gauntlet;
  if (!g) return null;
  const fixture = g.schedule[g.nextIndex];
  if (!fixture) return null;
  return {
    index: g.nextIndex,
    total: g.schedule.length,
    opponent: fixture.opponent,
    world: fixture.world,
    seed: fixture.seed,
    swapAsym: fixture.swapAsym,
    difficulty: g.difficulty,
    matchTimeLimit: g.matchTimeLimit,
    humanName: g.humanName,
  };
}

/**
 * Record the result of the gauntlet's current live match: rate it through recordCompetition (into
 * the gauntlet's own pinned bracket, D2), append it to the run, and advance to the next fixture.
 *
 * `winner` is stated in the GAUNTLET's own vocabulary — "human" | "opponent" | "draw" — never the
 * engine's owner ids. boot.js's game-over hook holds `state.winner` as "player"/"ai" and maps it at
 * the call site: the mapping is trivial, and refusing to accept both vocabularies here means a
 * caller can never accidentally record "the player seat won" as an opponent win in a format where
 * the human is ALWAYS the player seat (D4).
 *
 * The written history row carries `seatSwapped: false` and `human: true` as FACTS of the format,
 * overriding whatever the caller passed (see this file's header on the seat edge) — everything
 * else on the row is either the fixture's own recorded truth (world/seed/swapAsym/difficulty) or a
 * coerced number the caller measured.
 * @param {CompetitionLedger} ledger
 * @param {{ winner: string, margin?: number, time?: number, winReason?: string|null, at?: number, forfeit?: boolean }} result
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function recordGauntletMatch(ledger, result) {
  const g = ledger && ledger.gauntlet;
  if (!g) throw new Error("there's no gauntlet in progress to record a result into");
  const fixture = g.schedule[g.nextIndex];
  if (!fixture) throw new Error("this gauntlet has no fixture left to play — every opponent has been faced");

  const { winner, margin, time, winReason, at, forfeit } = result || {};
  if (winner !== "human" && winner !== "opponent" && winner !== "draw")
    throw new Error(`recordGauntletMatch: winner must be "human", "opponent" or "draw", got ${JSON.stringify(winner)}`);

  const isForfeit = forfeit === true;
  const at_ = Number.isFinite(at) ? at : null;
  const margin_ = Number.isFinite(margin) ? margin : 0;
  const row = {
    world: fixture.world,
    seed: fixture.seed,
    difficulty: g.difficulty,
    swapAsym: fixture.swapAsym,
    // D4, on every single human row: the human is owner "player" and the pairing was NOT
    // side-swapped, because it cannot be. Hardcoded, not read off `result` — see the doc comment.
    seatSwapped: false,
    human: true,
    forfeit: isForfeit,
    // aName is the human, so `winner` and `margin` are both already human-relative — the same
    // aName-relative convention standingsFor reads every history row with.
    aName: g.humanName,
    bName: fixture.opponent,
    winner: winner === "human" ? "a" : winner === "opponent" ? "b" : "draw",
    winReason: isForfeit ? "forfeit" : (typeof winReason === "string" ? winReason : null),
    margin: margin_,
    time: Number.isFinite(time) ? time : null,
    // No `at` on the ROW: a gauntlet match is one match in one competition, so the history entry's
    // own `at` below already timestamps it. Two copies of one fact is two things to keep in step.
  };

  // Rate FIRST, advance SECOND: recordCompetition validates the names itself and throws without
  // mutating, so a rejected write leaves the gauntlet exactly where it was, still owing this match.
  recordCompetition(ledger, {
    at: at_, difficulty: g.difficulty,
    aName: g.humanName, bName: fixture.opponent, rows: [row],
  });

  g.results.push({ index: g.nextIndex, winner, forfeit: isForfeit, margin: margin_, at: at_ });
  g.nextIndex += 1;
  return ledger;
}

/**
 * Forfeit the gauntlet's current match: a rated LOSS for the human, recorded exactly like a played
 * one (same fixture consumed, same bracket, same seatSwapped: false row) and additionally flagged
 * `forfeit` so the UI can show it as one. This is what an abandoned match becomes — the Phase 4
 * brief's own rule that abandoning is never a silently dropped result. The player is told that
 * before it happens; this function is the "after they confirmed" half.
 * @param {CompetitionLedger} ledger
 * @param {{ at?: number }} [opts]
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function recordGauntletForfeit(ledger, opts) {
  return recordGauntletMatch(ledger, { winner: "opponent", forfeit: true, margin: 0, at: opts && opts.at });
}

/**
 * The whole run, summarised for display — or null when there's no gauntlet. Counts are derived from
 * `results` rather than stored, so they can never disagree with the results they describe; the
 * results themselves come back as a detached copy, so a caller rendering them can't reach into the
 * live ledger. `complete` is the finished-run signal currentGauntletFixture's null deliberately
 * doesn't distinguish from "no gauntlet at all".
 * @param {CompetitionLedger} ledger
 * @returns {{ humanName: string, difficulty: string, matchTimeLimit: number, field: string[],
 *   total: number, played: number, remaining: number, nextIndex: number, wins: number,
 *   losses: number, draws: number, forfeits: number, complete: boolean,
 *   results: GauntletResult[] }|null}
 */
export function gauntletProgress(ledger) {
  const g = ledger && ledger.gauntlet;
  if (!g) return null;
  const results = g.results;
  return {
    humanName: g.humanName,
    difficulty: g.difficulty,
    matchTimeLimit: g.matchTimeLimit,
    field: [...g.field],
    total: g.schedule.length,
    played: results.length,
    remaining: g.schedule.length - results.length,
    nextIndex: g.nextIndex,
    wins: results.filter(r => r.winner === "human").length,
    losses: results.filter(r => r.winner === "opponent").length,
    draws: results.filter(r => r.winner === "draw").length,
    forfeits: results.filter(r => r.forfeit).length,
    complete: g.nextIndex >= g.schedule.length,
    results: results.map(r => ({ ...r })),
  };
}

/**
 * Drop the current gauntlet, finished or not — a no-op (not an error) when there isn't one, the
 * same treatment removeRosterEntry gives a name that isn't on the roster. Deliberately does NOT
 * touch ratingsByDifficulty or history, and deliberately does NOT forfeit the unplayed remainder:
 * the matches already played really happened and keep their ratings, and the ones never played were
 * never played (rating someone for a match that didn't happen would be a worse lie than recording
 * nothing). Abandoning a single MATCH is the different, narrower act — that's recordGauntletForfeit.
 * @param {CompetitionLedger} ledger
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function abandonGauntlet(ledger) {
  ledger.gauntlet = null;
  return ledger;
}

/* ============================================================
   SEASONS (docs/competitions-and-elo.md Phase 5) — close the current ladder and start a fresh one.

   WHAT A SEASON IS, exactly: the ratings and history that were live when it was closed, filed
   under a label with a finish time, plus a small derived summary. WHAT IT ISN'T: a second copy of
   the roster. THE ROSTER PERSISTS ACROSS SEASONS and only the ratings restart — that asymmetry is
   the whole feature. An entrant is an identity the player built (a name, a strategy, an archetype,
   a faction); a rating is a claim about how that identity performed in one stretch of play. Wiping
   the identities too would make "start a fresh season" indistinguishable from "delete everything",
   and the player would simply never press it.

   A season is stored INSIDE the ledger, as one more top-level field, for the same reason the
   gauntlet is (see this file's header): it rides the existing versioned sanitize/export/import/
   rotate pipeline for free, and "the ladder" and "the ladders that came before it" can never get
   out of step by being written separately.

   THE SUMMARY IS DERIVED, NEVER STORED-AND-TRUSTED. archiveSeason computes it from the ratings and
   history it is archiving, and cleanSeason RE-computes it on every import rather than reading the
   file's own copy — so a hand-edited ladder cannot put a champion on screen who never won
   anything. Same discipline as cleanGauntlet's `nextIndex: results.length`: the record is the
   record, and bookkeeping derived from it follows it rather than being believed alongside it.
   ============================================================ */

// A season label is a display string, not an identity and never an object KEY, so it needs no
// FORBIDDEN_NAMES guard (over-broad guards are their own bug — see the case-sensitivity test that
// pins assertValidEntrantName's own narrowness). It does need a bound: it is free-typed and it is
// re-rendered on every visit to the Standings screen. Exported so the UI's own input can cap at
// exactly the number the sanitizer enforces, rather than the two drifting apart.
export const MAX_SEASON_LABEL = 60;

/**
 * The plain summary of one stretch of play — who finished top of each bracket, and how much was
 * actually played. Reads `{ ratingsByDifficulty, history }` off ANY source with that shape: the
 * LIVE ledger (so the archive confirm can preview what it is about to record), the object
 * archiveSeason is filing, and — on import — an archived season being re-derived rather than
 * believed. Brackets come back in DIFFICULTY_OPTIONS order, so the answer never depends on object
 * key insertion order (D2/D6's determinism discipline applied to a display string).
 * @param {{ ratingsByDifficulty?: Object.<string, LedgerRatingsTable>, history?: LedgerHistoryEntry[] }} source
 * @returns {{ matches: number, entrants: number, brackets: Array<{ difficulty: string, top: string|null, topRating: number|null, entrants: number, matches: number }> }}
 */
export function seasonSummary(source) {
  const tables = (source && source.ratingsByDifficulty) || {};
  const history = (source && source.history) || [];
  const names = new Set();
  const brackets = [];

  for (const { mult: difficulty } of DIFFICULTY_OPTIONS) {
    if (!Object.hasOwn(tables, difficulty)) continue;
    const table = tables[difficulty];
    const rated = Object.keys(table);
    if (!rated.length) continue;
    for (const name of rated) names.add(name);
    // Highest rating wins the bracket, ties broken by name — standingsFor's own sort, so "top of
    // the table" means the same thing in the summary as on the screen it summarises.
    const top = rated.slice().sort((a, b) => table[b].rating - table[a].rating || a.localeCompare(b))[0];
    brackets.push({
      difficulty,
      top,
      topRating: table[top].rating,
      entrants: rated.length,
      matches: history.reduce((n, h) => n + (h.difficulty === difficulty ? h.rows.length : 0), 0),
    });
  }

  return {
    // Every ROW is one match; a history ENTRY is a whole competition (a duel, a tournament pairing,
    // one gauntlet fixture), which is not the number a player means by "matches played".
    matches: history.reduce((n, h) => n + h.rows.length, 0),
    entrants: names.size,
    brackets,
  };
}

// A caller-supplied (or stored) season label, believed only as far as it is displayable: trimmed,
// capped, and defaulted to the season's own number when it is missing, blank or not a string.
// Coerced rather than rejected — a label is cosmetic, so refusing an archive over one would cost
// the player a real feature to protect nothing (same severity call as cleanMatchTimeLimit's).
function cleanSeasonLabel(raw, index) {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label) return `Season ${index + 1}`;
  return label.length > MAX_SEASON_LABEL ? label.slice(0, MAX_SEASON_LABEL) : label;
}

/**
 * Close the current season: file the live ratings and history under `label` with a finish time,
 * then reset both — KEEPING the roster (see this section's header). Throws, touching nothing, if
 * there is nothing to archive or if a gauntlet is still in progress.
 *
 * WHY AN IN-PROGRESS GAUNTLET IS A HARD REFUSAL rather than something to carry over: a gauntlet is
 * one run, at one pinned bracket, rated as a whole. Archiving mid-run would file the matches
 * already played into the closed season and rate the remaining ones into a fresh table the run's
 * own standing was never computed against, so the player's ladder trail would silently be built
 * from two different seasons. Finishing or abandoning it first is one click and is honest. A
 * FINISHED gauntlet is the opposite case — it belongs to the season being closed, so it is cleared
 * along with the history it produced, and the new season starts with no run parked on it.
 * @param {CompetitionLedger} ledger
 * @param {{ label?: string, at?: number }} [opts]
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function archiveSeason(ledger, opts) {
  const { label, at } = opts || {};
  if (!Array.isArray(ledger.seasons)) ledger.seasons = [];   // a ledger built before this field existed

  const g = ledger.gauntlet;
  if (g && g.nextIndex < g.schedule.length)
    throw new Error("a gauntlet is still in progress — finish or abandon it before starting a new season");

  const summary = seasonSummary(ledger);
  if (summary.matches === 0 && summary.entrants === 0)
    throw new Error("there's nothing to archive yet — no rated match has been played this season");

  ledger.seasons.push({
    label: cleanSeasonLabel(label, ledger.seasons.length),
    finishedAt: Number.isFinite(at) ? at : null,
    // Detached via a JSON round-trip, the same idiom exportLedger and recordCompetition's own row
    // copy already use: a closed season is a record of what happened, and nothing that keeps
    // playing afterwards may reach back into it.
    ratingsByDifficulty: JSON.parse(JSON.stringify(ledger.ratingsByDifficulty)),
    history: JSON.parse(JSON.stringify(ledger.history)),
    summary,
  });

  ledger.ratingsByDifficulty = {};
  ledger.history = [];
  ledger.gauntlet = null;   // only ever a FINISHED run by this point (the in-progress case threw above)
  return ledger;
}

/**
 * One closed season's final table for one bracket, in exactly standingsFor's own Standing shape —
 * so a past season renders through the same code, and reads the same way, as the live ladder.
 *
 * Deliberately does NOT read the current roster as its row list, which is the one way this differs
 * from standingsFor: a closed season's table is what that season FINISHED as, so an entrant
 * removed from the roster since must still appear (removing someone today cannot retroactively
 * un-play their matches). The rows are therefore derived from the season's own ratings table, with
 * `human` looked up against the roster purely so the screen can still mark which row is the player.
 * An unknown index or an unplayed bracket is an empty list, never a throw — this is a display read.
 * @param {CompetitionLedger} ledger
 * @param {number} index   the season's own position in `ledger.seasons`
 * @param {string} difficulty
 * @returns {Standing[]}
 */
export function seasonStandings(ledger, index, difficulty) {
  const season = ((ledger && ledger.seasons) || [])[index];
  if (!season) return [];
  const table = season.ratingsByDifficulty[difficulty];
  if (!table) return [];
  const human = humanEntry(ledger);
  const roster = Object.keys(table).map(name => ({ name, human: !!human && human.name === name }));
  return standingsFor({ roster, ratingsByDifficulty: season.ratingsByDifficulty, history: season.history }, difficulty);
}

/* ============================================================
   SANITIZATION — the untrusted-input boundary itself. Same STRUCTURE of guard as
   engine/persist.js's sanitizeSave, tuned for a much smaller payload (a ladder, not a whole
   galaxy).
   ============================================================ */

const MAX_LEDGER_NODES = 50000;   // a whole galaxy's cap is 600000 — a ladder is a small fraction of that, generous headroom over any real roster/history
const MAX_LEDGER_DEPTH = 40;      // the ledger's own real shape bottoms out around depth 6 (ledger -> history -> entry -> rows -> row -> field)
const MAX_LEDGER_STRING = 2048;   // entrant names are UI-capped at 40 chars; this just needs headroom over the longest real field (a winReason string)

/**
 * Structural gate over untrusted ledger data — proves a payload is plain, bounded JSON before
 * anything downstream trusts its shape. Same three guards as engine/persist.js's sanitizeSave: a
 * forbidden-keys set (prototype pollution via a literal "__proto__"/"constructor"/"prototype" OWN
 * property — the mechanism JSON.parse itself uses, distinct from the runtime-string-assignment
 * hazard assertValidEntrantName guards above), a node-count cap, a depth cap, a max string length.
 * Correctness (version, per-field shape) is still importLedgerJSON's job below; this is purely the
 * safety gate. Throws with a clear reason; returns the input so it can be chained.
 * @param {*} input
 * @returns {Object}
 */
export function sanitizeLedgerStructure(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("competition ledger is not a valid object");
  let nodes = 0;
  const walk = (v, depth) => {
    if (depth > MAX_LEDGER_DEPTH) throw new Error("competition ledger is too deeply nested");
    if (++nodes > MAX_LEDGER_NODES) throw new Error("competition ledger is too large");
    if (v === null || typeof v === "number" || typeof v === "boolean") return;
    if (typeof v === "string") { if (v.length > MAX_LEDGER_STRING) throw new Error("competition ledger has an oversized string"); return; }
    if (Array.isArray(v)) { for (const el of v) walk(el, depth + 1); return; }
    if (typeof v === "object") {
      for (const k of Object.getOwnPropertyNames(v)) {   // getOwnPropertyNames also catches a non-enumerable __proto__
        if (FORBIDDEN_NAMES.has(k)) throw new Error(`competition ledger contains a forbidden key: ${k}`);
        walk(v[k], depth + 1);
      }
      return;
    }
    throw new Error("competition ledger contains an unsupported value");   // functions/symbols can't come from JSON, but be explicit
  };
  walk(input, 0);
  return input;
}

// --- per-field coercion (the "cleanXxx" half, engine/persist.js's own naming) — assumes its input
// already passed sanitizeLedgerStructure, so no OWN "__proto__"-named key can be present; still
// defensive about VALUE-level hazards (a roster entry's `name` FIELD holding the string
// "__proto__", say) since sanitizeLedgerStructure only ever inspects keys, never values. Anything
// that doesn't fit is dropped or defaulted, never trusted verbatim; nothing here throws. ----------

function cleanRatingEntry(e) {
  if (!e || typeof e !== "object") return null;
  const rating = Number(e.rating);
  const games = Number(e.games);
  if (!Number.isFinite(rating) || !Number.isFinite(games) || games < 0) return null;
  return { rating, games: Math.max(0, Math.floor(games)) };
}

function cleanRatingsByDifficulty(raw) {
  /** @type {Object.<string, LedgerRatingsTable>} */
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const difficulty of Object.keys(raw)) {
    if (!KNOWN_DIFFICULTIES.has(difficulty)) continue;
    const bracket = raw[difficulty];
    if (!bracket || typeof bracket !== "object" || Array.isArray(bracket)) continue;
    /** @type {LedgerRatingsTable} */
    const table = {};
    for (const name of Object.keys(bracket)) {
      if (FORBIDDEN_NAMES.has(name)) continue;   // belt-and-suspenders: sanitizeLedgerStructure already threw on this as a KEY
      const cleaned = cleanRatingEntry(bracket[name]);
      if (cleaned) table[name] = cleaned;
    }
    if (Object.keys(table).length) out[difficulty] = table;
  }
  return out;
}

// A stored/typed match length, believed only if it's a plausible number of seconds — otherwise
// GAUNTLET_DEFAULT_MATCH_SECONDS. Defaulting (rather than dropping the whole gauntlet) is the right
// severity here: a wrong match length just makes matches longer or shorter, it can't misattribute a
// rating or point a resume at the wrong opponent, so it belongs with the other defaulted scalars
// (cleanRosterEntry's strategy/archetype/faction) rather than with the structural rejections.
function cleanMatchTimeLimit(raw) {
  const n = Number(raw);
  return (Number.isFinite(n) && n >= GAUNTLET_MIN_MATCH_SECONDS && n <= GAUNTLET_MAX_MATCH_SECONDS)
    ? Math.floor(n) : GAUNTLET_DEFAULT_MATCH_SECONDS;
}

function cleanRosterEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || FORBIDDEN_NAMES.has(name)) return null;   // a forbidden or blank name is DROPPED on import, not thrown (see addRosterEntry for the throwing, interactive counterpart)
  // Same rule as addRosterEntry: a valid genome makes the entrant its own strategy. Sanitised
  // first, so an imported ladder cannot smuggle an out-of-range dial — or a key the schema never
  // named — into the live AI tables.
  const genome = raw.genome ? sanitizeGenome(raw.genome) : null;
  return {
    name,
    strategy: genome ? name : (KNOWN_STRATEGIES.has(raw.strategy) ? raw.strategy : "default"),
    archetype: KNOWN_ARCHETYPES.has(raw.archetype) ? raw.archetype : null,
    faction: KNOWN_FACTIONS.has(raw.faction) ? raw.faction : "neutral",
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
    ...(genome ? { genome } : {}),   // absent unless real — see addRosterEntry
    // Strictly `=== true`, exactly as addRosterEntry reads it: an entry written before this field
    // existed (undefined) and an entry carrying some truthy junk both mean "not the human".
    human: raw.human === true,
  };
}

function cleanRoster(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  let humanTaken = false;
  for (const r of raw) {
    const cleaned = cleanRosterEntry(r);
    if (!cleaned || seen.has(cleaned.name)) continue;   // a duplicate name (post-trim) keeps only the FIRST occurrence
    // A file claiming two human entrants is coerced the same way it claiming two entrants of one
    // name is: the FIRST wins, and the later one is kept as an ordinary AI entrant rather than
    // dropped — nothing about the extra row is unsafe, only its claim to be the person playing.
    if (cleaned.human && humanTaken) cleaned.human = false;
    if (cleaned.human) humanTaken = true;
    seen.add(cleaned.name);
    out.push(cleaned);
  }
  return out;
}

function cleanHistoryRow(r) {
  // A match row is otherwise opaque data as far as this module is concerned (whatever shape
  // competitionWorker.js's "done" rows field carries — world/seed/aScore/margin/direction/…); only
  // the fields this module's OWN standingsFor/recordCompetition actually read (aName/bName/winner)
  // are validated. Coercing fields this module never reads would just be inventing a shape
  // competitionWorker.js doesn't actually promise.
  if (!r || typeof r !== "object") return null;
  if (typeof r.aName !== "string" || !r.aName || FORBIDDEN_NAMES.has(r.aName)) return null;
  if (typeof r.bName !== "string" || !r.bName || FORBIDDEN_NAMES.has(r.bName)) return null;
  if (r.winner !== "a" && r.winner !== "b" && r.winner !== "draw") return null;
  const cleaned = { ...r };
  // D4, enforced at the import boundary too: a row marked as a live HUMAN match can never come back
  // claiming its seats were swapped, whatever the file says. seatSwapped is a fact about the format
  // (the human is always owner "player" — there is no swapped half of a human pairing to record),
  // and the whole point of storing it is that a human-inclusive table is VISIBLY built on
  // half-corrected rows. A hand-edited file must not be able to erase that disclosure.
  //
  // Note the deliberate asymmetry with cleanRosterEntry's `human`, which insists on a literal
  // `true`: there, junk must not GRANT the human seat, so the check is strict; here, junk must not
  // ESCAPE the disclosure, so ANY claim of humanness is normalised into the disclosed form. Both
  // directions fail closed, which is why they read differently.
  if (cleaned.human) { cleaned.human = true; cleaned.seatSwapped = false; }
  return cleaned;
}

function cleanHistoryEntry(h) {
  if (!h || typeof h !== "object") return null;
  if (typeof h.difficulty !== "string" || !KNOWN_DIFFICULTIES.has(h.difficulty)) return null;
  if (typeof h.aName !== "string" || !h.aName || FORBIDDEN_NAMES.has(h.aName)) return null;
  if (typeof h.bName !== "string" || !h.bName || FORBIDDEN_NAMES.has(h.bName)) return null;
  const rows = Array.isArray(h.rows) ? h.rows.map(cleanHistoryRow).filter(Boolean) : [];
  if (!rows.length) return null;   // a history entry that lost every row to cleaning records nothing real — drop it, don't keep an empty husk
  return { at: Number.isFinite(h.at) ? h.at : null, difficulty: h.difficulty, aName: h.aName, bName: h.bName, rows };
}

function cleanHistory(raw) {
  return Array.isArray(raw) ? raw.map(cleanHistoryEntry).filter(Boolean) : [];
}

/* --- the gauntlet, as untrusted input. The severity rule this whole function is built on:
   anything that could make a resumed run point at the WRONG OPPONENT, rate into the WRONG BRACKET,
   or replay a DIFFERENT FIXTURE than the one already half-played is not coercible — the gauntlet is
   dropped whole (null, i.e. "no run in progress"), which costs at most an unfinished run while
   leaving the ratings and history it already earned completely intact, since those live in
   ratingsByDifficulty/history and are cleaned independently. Only genuinely inert bookkeeping is
   coerced: the match length (see cleanMatchTimeLimit) and nextIndex (which is redundant with
   results.length and simply follows it).

   Why not repair a field instead of dropping the run — e.g. filter out one unknown opponent? Because
   `field`, `schedule` and `results` are INDEX-ALIGNED with each other. Removing element 1 silently
   re-maps every later fixture and every later result onto a different opponent than the one that
   actually played, which would then be rated as if it had. A dropped run is honest; a re-indexed
   one is a quiet lie about who beat whom. --- */
function cleanGauntlet(raw, roster) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  // The human must still be the roster's human — startGauntlet snapshotted the name, and a ledger
  // where that entry is gone, renamed, or no longer flagged human is internally inconsistent.
  const humanName = typeof raw.humanName === "string" ? raw.humanName : "";
  if (!humanName || FORBIDDEN_NAMES.has(humanName)) return null;
  const human = roster.find(r => r.name === humanName);
  if (!human || !human.human) return null;

  if (!KNOWN_DIFFICULTIES.has(raw.difficulty)) return null;   // difficulty IS the bracket (D2) — an unknown one can't be rated into anything

  const field = Array.isArray(raw.field) ? raw.field : null;
  if (!field || field.length === 0) return null;
  const seen = new Set();
  for (const name of field) {
    if (typeof name !== "string" || !name || FORBIDDEN_NAMES.has(name)) return null;
    if (name === humanName) return null;                       // nobody plays themself
    if (!roster.some(r => r.name === name)) return null;        // an opponent who isn't on the roster
    if (seen.has(name)) return null;
    seen.add(name);
  }

  // The schedule is the record of WHICH MATCHES THIS RUN IS, so it's validated for alignment rather
  // than re-derived from seedBase: re-deriving would let an edited seedBase silently rewrite the
  // fixtures a player has already half-played, which is exactly the failure D6 exists to prevent.
  const schedule = Array.isArray(raw.schedule) ? raw.schedule : null;
  if (!schedule || schedule.length !== field.length) return null;
  const cleanSchedule = [];
  for (let i = 0; i < schedule.length; i++) {
    const f = schedule[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    if (f.opponent !== field[i]) return null;                  // out of step with the field it's supposed to describe
    if (typeof f.world !== "string" || !KNOWN_WORLD_SET.has(f.world)) return null;
    if (!Number.isFinite(f.seed)) return null;
    cleanSchedule.push({ opponent: field[i], world: f.world, seed: Math.floor(f.seed) >>> 0, swapAsym: f.swapAsym === true });
  }

  const rawResults = Array.isArray(raw.results) ? raw.results : null;
  if (!rawResults || rawResults.length > cleanSchedule.length) return null;   // more results than fixtures is not a run that happened
  const results = [];
  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    if (r.index !== i) return null;                            // results are the played prefix, in order — a gap or a jump means the record is unreadable
    if (r.winner !== "human" && r.winner !== "opponent" && r.winner !== "draw") return null;
    results.push({
      index: i,
      winner: r.winner,
      forfeit: r.forfeit === true,
      margin: Number.isFinite(r.margin) ? r.margin : 0,
      at: Number.isFinite(r.at) ? r.at : null,
    });
  }

  return {
    humanName,
    field: [...field],
    difficulty: raw.difficulty,
    matchTimeLimit: cleanMatchTimeLimit(raw.matchTimeLimit),
    seedBase: (Number(raw.seedBase) || 0) >>> 0,
    schedule: cleanSchedule,
    results,
    // The results ARE the record of what was played; nextIndex is bookkeeping that follows them, so
    // an out-of-range, missing, or merely disagreeing one is corrected rather than believed. (They
    // can only ever disagree in a hand-edited ledger: recordGauntletMatch appends and increments in
    // the same breath.)
    nextIndex: results.length,
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
  };
}

/* --- an ARCHIVED SEASON, as untrusted input (Phase 5). Two things make this simpler than
   cleanGauntlet above, and they are worth stating rather than leaving as an apparent oversight:
     • A closed season is INERT. It can't misdirect a resume or rate anything — nothing ever writes
       through it. So there is no "drop the whole thing rather than half-repair it" hazard here:
       per-field coercion (the cleanRosterEntry severity, not the cleanGauntlet one) is exactly
       right, and a bracket or a rating entry that doesn't check out is simply dropped.
     • Its ratings and history are the SAME shapes the live ledger's are, so they are cleaned by
       the SAME two functions rather than by second copies that could drift.
   The one thing this must not do is believe the file's own `summary`: that is the field a hand-
   edited ladder would use to put a champion on screen who never won a match, and it is entirely
   derivable, so it is RE-DERIVED from the cleaned tables. Same reasoning as cleanGauntlet's
   `nextIndex: results.length`. A season that cleans away to nothing at all (no surviving bracket
   and no surviving history) records nothing real and is dropped whole, exactly as cleanHistoryEntry
   drops a history entry that lost every row. --- */
function cleanSeason(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ratingsByDifficulty = cleanRatingsByDifficulty(raw.ratingsByDifficulty);
  const history = cleanHistory(raw.history);
  if (!Object.keys(ratingsByDifficulty).length && !history.length) return null;
  return {
    label: cleanSeasonLabel(raw.label, index),
    finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
    ratingsByDifficulty,
    history,
    summary: seasonSummary({ ratingsByDifficulty, history }),
  };
}

function cleanSeasons(raw) {
  if (!Array.isArray(raw)) return [];
  // Indexed by SURVIVING position, not by the raw one, so a default label ("Season 3") always
  // matches where the season actually ends up in the list the player reads.
  const out = [];
  for (const s of raw) {
    const cleaned = cleanSeason(s, out.length);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function cleanLedgerShape(raw) {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const roster = cleanRoster(src.roster);
  return {
    v: COMPETITION_VERSION,
    roster,
    ratingsByDifficulty: cleanRatingsByDifficulty(src.ratingsByDifficulty),
    history: cleanHistory(src.history),
    // Cleaned against the ALREADY-CLEANED roster, not the raw one: a gauntlet may only name
    // entrants that survived roster cleaning, and its human may only be the human that survived
    // cleanRoster's own one-human coercion.
    gauntlet: cleanGauntlet(src.gauntlet, roster),
    // Deliberately NOT cleaned against the roster: a closed season records who was rated in it, and
    // an entrant removed from the roster since must keep the standing they finished with (see
    // seasonStandings). Roster membership is a fact about NOW; a season is a fact about THEN.
    seasons: cleanSeasons(src.seasons),
  };
}

/* ============================================================
   JSON EXPORT / IMPORT — the Save/Load file idiom (D8), kept independent of saveload.js itself to
   keep this module's own dependency surface small (saveload.js pulls in boot.js's whole UI graph).
   ============================================================ */

/**
 * `ledger`, as a detached plain object ready for `JSON.stringify` or handing to a file-download
 * helper (a future UI stage's own tiny download function, mirroring saveload.js's downloadJSON —
 * not imported here, to keep this module DOM-free and its dependency surface small). Detached via
 * a JSON round-trip, the same idiom engine/persist.js's serializeGame uses, so a caller mutating
 * the live ledger afterwards can never reach back into an object this function already handed out.
 * @param {CompetitionLedger} ledger
 * @returns {Object}
 */
export function exportLedger(ledger) {
  return JSON.parse(JSON.stringify(ledger));
}

/**
 * Parse untrusted raw text (a dropped-in file, or a localStorage slot) into a clean
 * CompetitionLedger. Sanitizes structurally FIRST, then version-gates, then coerces every field —
 * the same order engine/persist.js's deserializeGame/deserializeGalaxy hold themselves to (see
 * test/sanitize.test.js's "the deserializer sanitizes first, then still guards its version").
 * Throws a clear Error on invalid JSON, a structurally unsafe payload, or an unsupported version —
 * this function never trusts a dropped-in file, by design; a caller that wants a soft failure
 * (localStorage) should catch around this instead of this function swallowing anything itself —
 * see loadLedgerFromStorage below.
 * @param {string} text
 * @returns {CompetitionLedger}
 */
export function importLedgerJSON(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { throw new Error("competition ledger file is not valid JSON"); }
  sanitizeLedgerStructure(parsed);   // reject unsafe/oversized payloads before anything else
  if (parsed.v !== COMPETITION_VERSION) throw new Error(`unsupported competition ledger version ${parsed.v}`);
  return cleanLedgerShape(parsed);
}

/* ============================================================
   LOCALSTORAGE PERSISTENCE — saveload.js's key-plus-PREV_SUFFIX two-generation rotation idiom,
   verbatim, for the same reason it exists there: one bad or interrupted write shouldn't lose the
   whole ladder. Lower stakes than saveload.js's whole-campaign case (losing one ladder update is
   recoverable — the next competition just re-records), so no failure-streak/toast machinery is
   needed here, just a clean, non-throwing false/null on any failure.
   ============================================================ */

const STORAGE_KEY = "stellarfrontier.competitions.v1";
const PREV_SUFFIX = ".prev";

// Bare `localStorage` (not `globalThis.localStorage`), same as saveload.js's own `read()` — under
// plain Node there IS no such global at all, so the reference itself throws a ReferenceError,
// which this try/catch turns into a clean null exactly like saveload.js's does.
function readRaw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

/**
 * Load the ledger from localStorage: try the primary generation, then fall back to the rotated
 * `.prev` generation (written by saveLedgerToStorage below) if the primary is missing, corrupt, or
 * fails to import — the same primary-then-.prev fallback saveload.js's loadGame/loadOdyssey use.
 * Never throws: an unavailable localStorage, invalid JSON, a hostile payload, or a version
 * mismatch on BOTH generations all read back as "no ledger yet" (null), the same soft-failure
 * saveload.js's own loadGame gives when both its generations are corrupt.
 * @returns {CompetitionLedger|null}
 */
export function loadLedgerFromStorage() {
  for (const key of [STORAGE_KEY, STORAGE_KEY + PREV_SUFFIX]) {
    const raw = readRaw(key);
    if (!raw) continue;
    try { return importLedgerJSON(raw); }
    catch (e) { /* try the next generation */ }
  }
  return null;
}

/**
 * Checkpoint `ledger` to localStorage, rotating whatever's currently in the primary slot into
 * `.prev` FIRST — saveload.js's writeGeneration, verbatim, so loadLedgerFromStorage above always
 * has last cycle's good ledger to fall back to if this write lands badly or the next one does. A
 * setItem quota throw is met with exactly one retry: drop the `.prev` backup (freeing its space)
 * and write the primary alone, so a nearly-full quota can never let the backup starve the primary
 * out of ever being written at all. Never throws; returns false on total failure (quota exceeded
 * even after the retry, or a browser — Safari/Firefox private mode — where setItem always throws).
 * @param {CompetitionLedger} ledger
 * @returns {boolean}
 */
export function saveLedgerToStorage(ledger) {
  const str = JSON.stringify(exportLedger(ledger));
  const prevKey = STORAGE_KEY + PREV_SUFFIX;
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current != null) localStorage.setItem(prevKey, current);
    localStorage.setItem(STORAGE_KEY, str);
    return true;
  } catch (e) {
    try {
      localStorage.removeItem(prevKey);
      localStorage.setItem(STORAGE_KEY, str);
      return true;
    } catch (e2) { return false; }
  }
}
