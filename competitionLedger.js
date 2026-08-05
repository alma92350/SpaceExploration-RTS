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
       roster: [ { name, strategy, archetype, faction, createdAt }, … ],
       ratingsByDifficulty: { [difficulty]: RatingsTable, … },   // elo.js RatingsTable, ONE PER BRACKET
       history: [ { at, difficulty, aName, bName, rows }, … ] }  // rows: competitionWorker.js's own "done" rows shape, verbatim

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
import { ARCHETYPES } from "./engine/aiArchetypes.js";
import { FACTIONS } from "./engine/factions.js";
import { DIFFICULTY_OPTIONS } from "./engine/aiDifficulty.js";

/**
 * @typedef {{ name: string, strategy: string, archetype: string|null, faction: string, createdAt: number|null }} RosterEntry
 *   `archetype` is a STRING KEY into engine/aiArchetypes.js's ARCHETYPES table (D3), or null for
 *   "no override — use whatever the world/planet hands out". Deliberately carries no difficulty
 *   field (see this file's header) — difficulty is the ratingsByDifficulty bracket axis, not part
 *   of an entrant's identity.
 */
/**
 * @typedef {{ at: number|null, difficulty: string, aName: string, bName: string, rows: object[] }} LedgerHistoryEntry
 *   `rows` is exactly competitionWorker.js's own "done" message rows field — this module treats it
 *   as opaque data it stores and reads back (aName/bName/winner/margin), never a shape it invents.
 */
/** @typedef {Object.<string, { rating: number, games: number }>} LedgerRatingsTable  elo.js's own RatingsTable shape. */
/**
 * @typedef {{ v: number, roster: RosterEntry[], ratingsByDifficulty: Object.<string, LedgerRatingsTable>, history: LedgerHistoryEntry[] }} CompetitionLedger
 */
/**
 * @typedef {{ name: string, rating: number, games: number, wins: number, losses: number, draws: number, avgMargin: number, provisional: boolean }} Standing
 */

// Exact-match version gate on load (CONTRIBUTING.md's save-versioning rule, applied to this
// second, separately-versioned store — the game's own SAVE_VERSION/GALAXY_SAVE_VERSION are
// untouched by any of this). Bump this whenever the ledger's shape changes in a way an older
// ledger can't survive; a purely additive field doesn't need a bump, same rule as engine/persist.js.
export const COMPETITION_VERSION = 1;

// --- known-value tables, so untrusted/careless data is validated against the SAME enums the rest
// of the engine already treats as canonical, rather than this module inventing its own copy. ----
const KNOWN_STRATEGIES = new Set(Object.keys(STRATEGIES));
const KNOWN_ARCHETYPES = new Set(Object.keys(ARCHETYPES));
const KNOWN_FACTIONS = new Set(Object.keys(FACTIONS));
const KNOWN_DIFFICULTIES = new Set(DIFFICULTY_OPTIONS.map(o => o.mult));

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
  const ledger = { v: COMPETITION_VERSION, roster: [], ratingsByDifficulty: {}, history: [] };
  return ledger;
}

/**
 * Add a new roster entry, mutating and returning `ledger` (elo.js's own "mutate and return" idiom
 * — see applyResult/applySeries). Rejects — throws, touching nothing — a missing/blank name, one
 * of the three forbidden identity-hazard strings, or a name already on the roster; every other
 * field is coerced to a known-safe value rather than trusted verbatim (the same enum-or-fallback
 * idiom engine/persist.js's cleanController already uses for strategy/difficulty).
 * @param {CompetitionLedger} ledger
 * @param {{ name: string, strategy?: string, archetype?: string|null, faction?: string, createdAt?: number }} [entry]
 * @returns {CompetitionLedger} the same `ledger`, mutated in place
 */
export function addRosterEntry(ledger, entry) {
  const name = typeof entry?.name === "string" ? entry.name.trim() : "";
  if (!name) throw new Error("a roster entry needs a name");
  assertValidEntrantName(name);
  if (ledger.roster.some(r => r.name === name)) throw new Error(`an entrant named "${name}" is already on the roster`);
  ledger.roster.push({
    name,
    strategy: KNOWN_STRATEGIES.has(entry?.strategy) ? entry.strategy : "default",
    archetype: KNOWN_ARCHETYPES.has(entry?.archetype) ? entry.archetype : null,
    faction: KNOWN_FACTIONS.has(entry?.faction) ? entry.faction : "neutral",
    createdAt: Number.isFinite(entry?.createdAt) ? entry.createdAt : null,
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
 * entrant played as B contributes its negation).
 * @param {CompetitionLedger} ledger
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
    });
  }

  rows.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  return rows;
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

function cleanRosterEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || FORBIDDEN_NAMES.has(name)) return null;   // a forbidden or blank name is DROPPED on import, not thrown (see addRosterEntry for the throwing, interactive counterpart)
  return {
    name,
    strategy: KNOWN_STRATEGIES.has(raw.strategy) ? raw.strategy : "default",
    archetype: KNOWN_ARCHETYPES.has(raw.archetype) ? raw.archetype : null,
    faction: KNOWN_FACTIONS.has(raw.faction) ? raw.faction : "neutral",
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
  };
}

function cleanRoster(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const cleaned = cleanRosterEntry(r);
    if (!cleaned || seen.has(cleaned.name)) continue;   // a duplicate name (post-trim) keeps only the FIRST occurrence
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
  return { ...r };
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

function cleanLedgerShape(raw) {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  return {
    v: COMPETITION_VERSION,
    roster: cleanRoster(src.roster),
    ratingsByDifficulty: cleanRatingsByDifficulty(src.ratingsByDifficulty),
    history: cleanHistory(src.history),
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
