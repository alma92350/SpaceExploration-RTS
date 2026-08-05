/* ============================================================
   The Competition mode: Quick Duel / Tournament / Roster / Standings
   (docs/competitions-and-elo.md Phases 1-3). Quick Duel pits two entrants against each other,
   side-swapped across every world x seed the player picks, off the main thread in
   competitionWorker.js — never a playable game. This mode never touches boot.js, game.state, the
   canvas, or the HUD: it runs a background simulation and shows a results screen, nothing else.

   PHASE 3: the Tournament tab — round-robin, Swiss or a knockout bracket over a multi-selected
   field of roster entries, scheduled by pairing.js inside the same Worker, with an up-front
   match-count/time estimate, round-by-round progress, live standings or a bracket view, and every
   pairing folded into the ledger in real completion order (D6). Its pure half sits with the rest
   below ("TOURNAMENTS"); its screen sits with the rest of the DOM half ("TOURNAMENT SCREEN").

   PHASE 2 (D8/D3): every entrant is now a named, persistent ROSTER row, not a free-typed throwaway
   name — Entrant A/B are each either picked from competitionLedger.js's current roster or drafted
   fresh via "New Entrant" (which joins the roster, via competitionLedger.js's own addRosterEntry,
   the moment the duel using it actually runs — never on a keystroke, so an abandoned draft never
   pollutes the roster). A finished duel's rows are folded into the ledger for the duel's pinned
   difficulty bracket via competitionLedger.js's own recordCompetition — this module never hand-
   rolls a second elo.js applySeries call; the ledger owns that write. Roster and Standings are two
   more sub-screens of this same mode (a small tab row below), reading/writing the SAME ledger.

   Split the SAME way observer.js splits observerStats() (pure) from observerPanel.js's rendering
   consumer, and CONTRIBUTING.md's own C10 rule ("UI modules should stay import-safe under Node,
   guard top-level window/document access"): everything above "DOM RENDERING" below is pure —
   job construction, per-match seed derivation (reusing tools/duelCore.js's own duelSeed, never
   reimplementing its hash), worker-row -> display-table shaping, roster/standings shaping, and
   Elo — directly unit-testable under Node with no DOM and no Worker (test/competition.test.js).
   Everything below it touches `document`/`mapSelectEl` and is guarded the same way setup.js's own
   renderMapSelect() is.

   Wired in from setup.js's renderMapSelect(): a `setup.mode === "competition"` branch delegates
   to renderCompetition() below and returns, mirroring how that function's existing `if (odyssey)`
   branch already short-circuits for Odyssey's own different layout. That import (setup.js's
   STRATEGY_OPTIONS/optionGroup/MAP_CHOICES, reused rather than redefined here) plus setup.js's own
   import of renderCompetition together form a two-file cycle — already true of setup.js and
   boot.js/hud.js/hudSelection.js/overlays.js/saveload.js today (test/static-integrity.test.js's
   "known UI cluster"), so competition.js joins that same documented cluster rather than opening a
   new one; see that test's own KNOWN list for the accompanying note. competitionLedger.js sits
   OUTSIDE that cycle entirely (it imports elo.js/engine/*, nothing that leads back here), so
   importing it below adds no new cycle and needs no TDZ care.

   FAIRNESS carries over from tools/ailab.js/tools/duelCore.js unchanged: ONE shared Difficulty
   pick for the whole duel, never two (see competitionWorker.js's own header). Faction is still NOT
   offered as a DUEL dial — a duel's fairness dial set is archetype/strategy/difficulty
   (tools/selfplay.js's createSelfPlayState takes no faction option at all) — but a roster entry
   DOES carry a faction (competitionLedger.js's own RosterEntry shape), so the New Entrant form
   offers a Faction picker for that entry's own identity/flavor, with a note making clear it's
   cosmetic and doesn't change this duel's outcome; see D3.
   ============================================================ */

"use strict";

import { mapSelectEl } from "./dom.js";
import { STRATEGY_OPTIONS, optionGroup, MAP_CHOICES, setup, renderMapSelect } from "./setup.js";
import { DIFFICULTY_OPTIONS } from "./engine/aiDifficulty.js";
import { archetypeFor, ARCHETYPES } from "./engine/aiArchetypes.js";
import { FACTIONS, PLAYABLE_FACTIONS } from "./engine/factions.js";
import { planetName } from "./data.js";
import { duelSeed } from "./tools/duelCore.js";
import { swissRoundCount, tournamentRoundPlan, tallyStandings } from "./pairing.js";
import { INITIAL_RATING, PROVISIONAL_GAMES, applySeries } from "./elo.js";
import {
  createLedger, addRosterEntry, removeRosterEntry, recordCompetition, standingsFor,
  exportLedger, importLedgerJSON, loadLedgerFromStorage, saveLedgerToStorage,
} from "./competitionLedger.js";

/* ============================================================
   PURE — job construction, seed derivation, table/Elo shaping, roster/standings shaping. No DOM,
   no Worker. See test/competition.test.js.
   ============================================================ */

// The Archetype picker's option list (D3), reused via setup.js's own optionGroup — derived
// straight from engine/aiArchetypes.js's ARCHETYPES (its four keys and their own `name` fields),
// never a hardcoded second copy of that roster. `null` ("no override") comes first and is the
// default for both a brand-new draft entrant and a roster entry that never picked one — matches
// createAiController's own archetype opt: absent/unknown falls back to the world's own
// archetypeFor(planetId), byte-identical to before this option existed. Each real entry's `note`
// is likewise derived from the archetype's own numbers (never hand-written prose that could drift
// from the table it's describing).
export const ARCHETYPE_OPTIONS = [
  { label: "World default", mult: null, note: "uses the map's own temperament" },
  ...Object.keys(ARCHETYPES).map(key => ({
    label: ARCHETYPES[key].name,
    mult: key,
    note: `${ARCHETYPES[key].workerTarget} workers · attacks ~${ARCHETYPES[key].attackTimeout}s`,
  })),
];

// The Faction picker for a roster entry (New Entrant / Roster screen's own "add directly" form) —
// derived from engine/factions.js's FACTIONS/PLAYABLE_FACTIONS, plus "neutral" (Unaligned), which
// setup.js's own player-facing FACTION_OPTIONS omits (a skirmish player always picks an aligned
// side) but a roster entry's identity legitimately defaults to. This is FLAVOR on the roster row,
// not a duel dial — tools/selfplay.js's createSelfPlayState takes no faction option at all, so
// picking one here never changes this duel's outcome (the DOM layer says so next to the picker).
export const ROSTER_FACTION_OPTIONS = [...PLAYABLE_FACTIONS, "neutral"].map(id => ({
  label: FACTIONS[id].short, mult: id, note: FACTIONS[id].blurb,
}));

/**
 * Shape a raw config (as the entrant/world/seed pickers below hold it) into exactly the job
 * message competitionWorker.js expects: `{ entrantA:{name,strategy,archetype}, entrantB:{…},
 * difficulty, worlds, seeds, seedBase, matchTimeLimit? }`. Deterministic — same input, same
 * output — so randomness (an unset seed) must already be resolved by the CALLER before this runs
 * (mirrors boot.js's own resolveSeed(setup): random-vs-fixed is a DOM-layer decision, this stays
 * pure). Throws a clear, user-facing message for anything that would make competitionWorker.js's
 * own guards throw anyway — an empty name or an empty world list — so the config screen can catch
 * it before ever spinning up a Worker.
 * Also rejects two entrants sharing a name (post-trim): elo.js's RatingsTable is keyed by name
 * (D1/D2), so a same-name pairing would collide both entrants' Elo into one entry instead of two
 * (elo.js's own applyResult throws on exactly this, as a backstop) — catching it here means the
 * config screen can reject it before ever spinning up a Worker, instead of running a full duel
 * only to throw when the results view folds the rows through eloFromRows.
 * `archetype` (D3) is coerced the same defensive way createAiController itself resolves it: a
 * string that names a real ARCHETYPES key survives, anything else (missing, blank, unknown) becomes
 * `null` — "no override" — rather than being trusted verbatim and handed to the worker.
 * @param {{ entrantA: {name: string, strategy?: string, archetype?: string|null},
 *   entrantB: {name: string, strategy?: string, archetype?: string|null},
 *   difficulty: string, worlds: string[], seeds: number, seedBase: number, matchTimeLimit?: number }} cfg
 */
export function buildJob({ entrantA, entrantB, difficulty, worlds, seeds, seedBase, matchTimeLimit } = {}) {
  if (!entrantA || !entrantA.name || !entrantA.name.trim()) throw new Error("Entrant A needs a name");
  if (!entrantB || !entrantB.name || !entrantB.name.trim()) throw new Error("Entrant B needs a name");
  if (entrantA.name.trim() === entrantB.name.trim()) throw new Error("Entrant A and Entrant B need different names");
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("Pick at least one world");
  // Object.hasOwn, not a truthy `ARCHETYPES[a]` bracket-access: a plain object's inherited keys
  // (e.g. "constructor") or the specially-handled "__proto__" accessor would otherwise read back
  // as "known" even though they name no real archetype — this function's own doc comment above
  // promises unknown input becomes `null`, and a hostile-looking key is exactly "unknown".
  const knownArchetype = a => (typeof a === "string" && Object.hasOwn(ARCHETYPES, a)) ? a : null;
  const job = {
    entrantA: { name: entrantA.name.trim(), strategy: entrantA.strategy || "default", archetype: knownArchetype(entrantA.archetype) },
    entrantB: { name: entrantB.name.trim(), strategy: entrantB.strategy || "default", archetype: knownArchetype(entrantB.archetype) },
    difficulty: difficulty || "medium",
    worlds: [...worlds],
    seeds: Math.max(1, Math.floor(seeds) || 1),
    seedBase: (Number(seedBase) || 0) >>> 0,
  };
  if (matchTimeLimit) job.matchTimeLimit = matchTimeLimit;
  return job;
}

/**
 * Resolve one entrant PICKER's current state (as compConfig.entrantA/B below holds it) against the
 * live ledger, into the plain `{name, strategy, archetype, faction}` shape buildJob/the roster
 * screen both want — the "roster-vs-adhoc entrant resolution" this stage's key UX decision hinges
 * on. `pick.mode === "roster"` reads the CURRENT roster entry back by name (never a stale copy —
 * if the Roster screen edited it, this always sees the latest), and throws a clear error if that
 * name is no longer on the roster (removed, most likely, between picking it and running the duel).
 * Anything else — including a missing/unrecognised mode — resolves as a fresh DRAFT (`isNew: true`)
 * from whatever fields the pick carries, trimmed/defaulted the same way addRosterEntry itself
 * would coerce them; the caller (startDuel) is the one that actually commits a draft to the roster,
 * and only once the duel is genuinely about to run (see this module's header).
 * @param {{ mode?: string, rosterName?: string, name?: string, strategy?: string, archetype?: string|null, faction?: string }} pick
 * @param {{ roster: Array<{name: string, strategy: string, archetype: string|null, faction: string}> }} ledger
 * @returns {{ name: string, strategy: string, archetype: string|null, faction: string, isNew: boolean }}
 */
export function resolveEntrantPick(pick, ledger) {
  if (pick && pick.mode === "roster") {
    const found = ((ledger && ledger.roster) || []).find(r => r.name === pick.rosterName);
    if (!found) throw new Error('Pick an entrant from the roster, or switch to "New Entrant"');
    return { name: found.name, strategy: found.strategy, archetype: found.archetype, faction: found.faction, isNew: false };
  }
  return {
    name: ((pick && pick.name) || "").trim(),
    strategy: (pick && pick.strategy) || "default",
    archetype: (pick && pick.archetype) || null,
    faction: (pick && pick.faction) || "neutral",
    isNew: true,
  };
}

/**
 * One entrant's rating out of a SINGLE bracket's ratings table (`ledger.ratingsByDifficulty
 * [difficulty]`, or undefined for a bracket nobody's played yet) — elo.js's own INITIAL_RATING at
 * 0 games when the entrant hasn't played this bracket, the same "hasn't played yet" reading
 * competitionLedger.js's own standingsFor gives (Object.hasOwn, not a truthy check — a plain
 * object inherits from Object.prototype, so an entrant legitimately named e.g. "toString" would
 * otherwise read back an inherited function as a bogus "rating"). Used by the results view to show
 * a real before/after delta straight from the ledger, replacing Phase 1's session-only eloFromRows
 * read (still exported below, unchanged, for whatever still wants a from-scratch session number).
 * @param {Object.<string, {rating: number, games: number}>|undefined} table
 * @param {string} name
 * @returns {{rating: number, games: number}}
 */
export function ratingLookup(table, name) {
  return (table && Object.hasOwn(table, name)) ? table[name] : { rating: INITIAL_RATING, games: 0 };
}

/**
 * True once `name` has a rating entry in ANY difficulty bracket of `ledger` — the Roster screen's
 * own signal for "removing this would drop something with real history off the Standings screen",
 * used to word its confirm dialog (removeRosterEntry itself never deletes the underlying
 * ratingsByDifficulty/history — see that function's own header — so this is purely about whether
 * the entry disappearing from the roster would also make it disappear from view).
 * @param {{ ratingsByDifficulty: Object.<string, object> }} ledger
 * @param {string} name
 * @returns {boolean}
 */
export function hasRatingHistory(ledger, name) {
  const tables = (ledger && ledger.ratingsByDifficulty) || {};
  return Object.keys(tables).some(d => Object.hasOwn(tables[d], name));
}

// key -> its own STRATEGY_OPTIONS label (setup.js's own table, reused rather than a second import
// of engine/aiStrategy.js's raw STRATEGIES here) — falls back to the first entry ("Adaptive",
// STRATEGIES.default's own label) for a key that isn't in the table, the same fallback strategyFor
// itself gives an absent/unknown strategy.
function strategyLabel(key) {
  return (STRATEGY_OPTIONS.find(o => o.mult === key) || STRATEGY_OPTIONS[0]).label;
}

/**
 * One roster entry -> its display row: strategy/archetype/faction KEYS resolved to their own
 * canonical display names (never re-deriving or re-wording them), so the Roster screen's table and
 * an entrant picker's roster `<select>` can both render straight off this. A null/unrecognised
 * archetype reads as "World default" — the same meaning ARCHETYPE_OPTIONS' own null entry carries.
 * @param {{ name: string, strategy: string, archetype: string|null, faction: string }} entry
 */
export function shapeRosterRow(entry) {
  return {
    name: entry.name,
    strategy: strategyLabel(entry.strategy),
    archetype: (typeof entry.archetype === "string" && Object.hasOwn(ARCHETYPES, entry.archetype))
      ? ARCHETYPES[entry.archetype].name : "World default",
    faction: (FACTIONS[entry.faction] || FACTIONS.neutral).short,
  };
}

/**
 * competitionLedger.js's own standingsFor(ledger, difficulty) rows -> the Standings table's display
 * rows. Pure FORMATTING only — rating rounded, W-L-D folded into one string, avgMargin fixed to one
 * decimal — never recomputing wins/losses/draws/avgMargin/provisional themselves (those are
 * standingsFor's own job; see this module's header and that function's own doc comment for exactly
 * which fields it already derives). Preserves standingsFor's own sort order (rating descending, tie
 * -> name) verbatim — this never re-sorts.
 * @param {Array<{name: string, rating: number, games: number, wins: number, losses: number, draws: number, avgMargin: number, provisional: boolean}>} standings
 */
export function shapeStandingsTable(standings) {
  return standings.map(s => ({
    name: s.name,
    rating: Math.round(s.rating),
    games: s.games,
    record: `${s.wins}-${s.losses}-${s.draws}`,
    avgMargin: s.avgMargin.toFixed(1),
    provisional: s.provisional,
  }));
}

// Total matches a job implies: every world x every seed replicate, both directions (side-swapped
// — see competitionWorker.js's own header). Shared by the config view's pre-run estimate and the
// progress view's initial "0 of N" (before the worker's own first progress message arrives).
export function matchCount(job) {
  return job.worlds.length * job.seeds * 2;
}

// One match's seed, reusing tools/duelCore.js's own duelSeed rather than re-deriving the hash —
// same inputs, same seed, by construction. (duelSeed sorts the pair's names into the hash, so this
// is deliberately independent of which entrant plays which owner for this replicate — see
// competitionWorker.js's header on why both directions of one (world, rep) share one map.)
export function matchSeedFor(job, world, rep) {
  return duelSeed(job.seedBase, world, job.difficulty, job.entrantA.name, job.entrantB.name, rep);
}

// Worker-shaped rows (competitionWorker.js's `runCompetitionJob` rows, tagged with `direction`) ->
// the results table's display rows. Never mutates `rows`. Entrant names land in plain strings
// here, not markup — the DOM layer renders every cell via textContent, never innerHTML, so a
// duel entrant's free-typed name can never be interpreted as markup.
export function shapeResultsTable(rows) {
  return rows.map(r => ({
    world: r.world,
    seed: r.seed,
    side: r.direction === "aAsAi" ? `${r.aName} as AI` : `${r.bName} as AI`,
    swap: !!r.swapAsym,
    winner: r.winner === "draw" ? "Draw" : r.winner === "a" ? r.aName : r.bName,
    reason: r.winReason || "-",
    time: r.time,
    aScore: r.aScore,
    bScore: r.bScore,
    margin: r.margin,
  }));
}

// Each match -> an elo.js MatchRow (score from A's point of view), the same eloRowOf shape
// tools/ailab.js's own printed Elo column already uses (D1: one shared meaning for "Elo"
// everywhere). `rows` must already be in the order they were RECEIVED (the worker's own
// completion order) — this folds them through applySeries in that exact order, starting a fresh
// ratings table at elo.js's INITIAL_RATING (D6: Elo is order-dependent; canonical order here is
// simply "the order the caller already has them in").
const eloRowOf = r => ({ aName: r.aName, bName: r.bName, score: r.winner === "a" ? 1 : r.winner === "draw" ? 0.5 : 0 });
export function eloFromRows(rows) {
  return applySeries({}, rows.map(eloRowOf));
}

/* ============================================================
   TOURNAMENTS (docs/competitions-and-elo.md Phase 3) — the pure half of the Tournament tab: the
   up-front cost estimate, the job competitionWorker.js's tournament kind receives, the knockout's
   own seeding, and the standings/bracket shaping the results view renders. Same split as
   everything above (observer.js's observerStats vs observerPanel.js): the DOM layer below decides
   only how these tables LOOK, never what they contain.

   Nothing here re-derives a schedule. pairing.js owns "how many pairings, in how many rounds"
   (tournamentRoundPlan/swissRoundCount) and "what a finished set of pairings tallies to"
   (tallyStandings); this module multiplies that by the worlds/seeds/side-swap the player picked
   and formats the result.
   ============================================================ */

// The format picker's options, in optionGroup's own { label, mult, note } shape — one entry per
// schedule pairing.js can actually run, with the note stating the cost rule the estimate below
// then applies, so the picker itself explains why one format is cheaper than another.
export const TOURNAMENT_FORMAT_OPTIONS = [
  { label: "Round-robin", mult: "round-robin", note: "every pair once — n × (n−1) / 2 pairings" },
  { label: "Swiss", mult: "swiss", note: "rounds paired by standing — ranks a big field cheaply" },
  { label: "Knockout", mult: "knockout", note: "single elimination — always n − 1 pairings" },
];

// Rough wall clock for ONE match, used only to price a run before it starts.
// docs/competitions-and-elo.md's own measured table (§1): ~1.0 s for a match resolved by
// elimination, ~1.8 s worst case for one that runs the full 40-sim-minute clock. 1.5 s is a
// documented average of those two measurements, deliberately nearer the worst case (a tournament
// full of evenly-matched entrants is exactly the population that goes the distance) — not an
// invented constant, and not a promise: the UI always renders it as "≈".
export const SECONDS_PER_MATCH = 1.5;

/**
 * How many PAIRINGS a format schedules over a field of `entrants` — pairing.js's own plan, summed.
 * Round-robin is n×(n−1)/2, Swiss is roundCount × floor(n/2) (an odd field's bye is not a pairing),
 * and a knockout is ALWAYS n−1 however many byes round 1 hands out.
 * @param {{ format: string, entrants: number, rounds?: number }} cfg
 * @returns {number}
 * @throws {Error} on an unknown format or a field smaller than 2 — pairing.js's own guards.
 */
export function tournamentPairingCount({ format, entrants, rounds } = {}) {
  // `rounds` is a Swiss-only override; passing it for the other two would imply it means something
  // there, and it doesn't (see tournamentRoundPlan's own doc comment).
  const plan = tournamentRoundPlan(format, entrants, format === "swiss" ? rounds : undefined);
  return plan.reduce((sum, r) => sum + r.pairings, 0);
}

// Seconds -> a display string, rounded at the granularity a person actually plans around: seconds
// below a minute, whole minutes above it (nobody waits "94 seconds", they wait "about 2 minutes").
function estimateTimeText(seconds) {
  return seconds < 60 ? `${Math.round(seconds)} s` : `${Math.max(1, Math.round(seconds / 60))} min`;
}

/**
 * The whole up-front budget for a tournament — the Phase 3 brief's own "≈ 32 matches, ≈ 1 min",
 * shown BEFORE Start Tournament is clickable. A MATCH is one (world, seed, side) combination
 * within a pairing, so the count is pairings × worlds × seeds × 2 — the same "both directions,
 * side-swapped" rule matchCount applies to a single duel.
 * @param {{ format: string, entrants: number, worlds: string[]|number, seeds: number, rounds?: number }} cfg
 * @returns {{ pairings: number, matches: number, seconds: number, timeText: string, text: string }}
 */
export function tournamentEstimate({ format, entrants, worlds, seeds, rounds } = {}) {
  const pairings = tournamentPairingCount({ format, entrants, rounds });
  const worldCount = Array.isArray(worlds) ? worlds.length : Math.max(0, Math.floor(Number(worlds)) || 0);
  const matches = pairings * worldCount * Math.max(1, Math.floor(seeds) || 1) * 2;
  const seconds = matches * SECONDS_PER_MATCH;
  const timeText = estimateTimeText(seconds);
  return { pairings, matches, seconds, timeText, text: `≈ ${matches} matches · ≈ ${timeText}` };
}

// A field entrant, coerced exactly the way buildJob coerces a duel entrant (trimmed name, defaulted
// strategy, archetype validated against the real ARCHETYPES keys with Object.hasOwn rather than a
// truthy bracket-access). Deliberately carries NO difficulty: difficulty is ONE shared dial for the
// whole tournament (D2), pinned identical for every entrant in every pairing, exactly as a Quick
// Duel already pins it for both sides — a per-entrant difficulty would make the bracket meaningless.
function tournamentEntrant(raw) {
  const name = ((raw && raw.name) || "").trim();
  if (!name) throw new Error("Every tournament entrant needs a name");
  const archetype = raw && raw.archetype;
  return {
    name,
    strategy: (raw && raw.strategy) || "default",
    archetype: (typeof archetype === "string" && Object.hasOwn(ARCHETYPES, archetype)) ? archetype : null,
  };
}

/**
 * Shape a tournament config into exactly the job message competitionWorker.js's tournament kind
 * expects. Deterministic (an unset seed is resolved by the caller, same as buildJob), and it throws
 * a clear, user-facing message for anything the worker's own guards would reject anyway, so the
 * config screen can catch it before spinning a Worker up. The FIELD ORDER IS MEANINGFUL — it is the
 * knockout's seeding (see seedFieldByRating below), so this never sorts it.
 * @param {{ format: string, field: object[], difficulty: string, worlds: string[], seeds: number,
 *   seedBase: number, rounds?: number }} cfg
 */
export function buildTournamentJob({ format, field, difficulty, worlds, seeds, seedBase, rounds } = {}) {
  if (!TOURNAMENT_FORMAT_OPTIONS.some(o => o.mult === format)) throw new Error(`Unknown tournament format "${format}"`);
  const list = Array.isArray(field) ? field : [];
  if (list.length < 2) throw new Error("Pick at least 2 entrants for a tournament");
  const entrants = list.map(tournamentEntrant);
  const seen = new Set();
  for (const e of entrants) {
    // Same reasoning as buildJob's own same-name guard: elo.js's RatingsTable is keyed by name, so
    // one name twice in a field would collide two entrants' ratings into one entry.
    if (seen.has(e.name)) throw new Error(`"${e.name}" is in the field twice — every entrant needs a different name`);
    seen.add(e.name);
  }
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("Pick at least one world");
  const job = {
    kind: "tournament",
    format,
    field: entrants,
    difficulty: difficulty || "medium",
    worlds: [...worlds],
    seeds: Math.max(1, Math.floor(seeds) || 1),
    seedBase: (Number(seedBase) || 0) >>> 0,
  };
  // Swiss is the only format with a round count to override; the worker defaults an absent one to
  // pairing.js's swissRoundCount, so leaving it off is meaningful, not lossy.
  if (format === "swiss" && rounds > 0) job.rounds = Math.floor(rounds);
  return job;
}

/**
 * Order a knockout field strongest-first for pairing.js's buildKnockoutBracket, which consumes a
 * seeding and deliberately never invents one (its own header: "it consumes an order, it does not
 * invent one" — that is what keeps it decoupled from the ledger). Rating descending off THIS
 * bracket's own ratings table, falling back to name for anyone unrated, so the seeding is total and
 * reproducible rather than dependent on the order boxes happened to be ticked in.
 * @param {{name: string}[]} entrants
 * @param {Object.<string, {rating: number, games: number}>|undefined} table   one difficulty bracket's table
 * @returns {object[]} a new array; the caller's own is untouched.
 */
export function seedFieldByRating(entrants, table) {
  return [...entrants].sort((a, b) =>
    ratingLookup(table, b.name).rating - ratingLookup(table, a.name).rating
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * One progress message -> the line the progress view shows. Real granularity, per the Phase 3
 * brief: a multi-round format names the round AND the pairing within it; a round-robin is one flat
 * round (roundRobinPairs' own shape), so naming "round 1 of 1" would be noise. The match counter
 * rides along either way, because that is what the bar is filling with.
 * @param {{ round: number, roundTotal: number, pairing: number, pairingTotal: number, completed: number, total: number }} p
 * @returns {string}
 */
export function tournamentProgressLabel({ round, roundTotal, pairing, pairingTotal, completed, total } = {}) {
  const head = roundTotal > 1
    ? `Round ${round} of ${roundTotal} · pairing ${pairing} of ${pairingTotal}`
    : `Pairing ${pairing} of ${pairingTotal}`;
  return `${head} — ${completed} of ${total} matches`;
}

/**
 * Standings rows for a set of FINISHED pairings — pairing.js's own tallyStandings, which is the
 * same arithmetic buildSwissBracket accumulates internally (and, for a bye, the same "adds to
 * nobody's wins or losses" rule). Used for the LIVE table as each pairing lands and, for a
 * round-robin, for the final one too; a finished Swiss bracket ships its own ranked standings and
 * those are used verbatim instead of being recomputed here.
 * @param {string[]} names        the whole field, so an entrant that hasn't played yet still shows.
 * @param {{aName: string, bName: string, aWins: number, bWins: number, draws: number}[]} pairings
 * @param {string[]} [byeNames]
 */
export function tournamentStandingsRows(names, pairings, byeNames) {
  return tallyStandings(names, pairings, byeNames);
}

/**
 * Tournament standings rows -> display rows. Pure FORMATTING, exactly like shapeStandingsTable's
 * own contract (W-L-D folded into one string, nothing recomputed, the input order — which IS the
 * ranking — preserved). `byes` rides through for the Swiss table's own extra column.
 * @param {{name: string, wins: number, losses: number, draws: number, byes: number}[]} rows
 */
export function shapeTournamentStandings(rows) {
  return rows.map(r => ({
    name: r.name,
    record: `${r.wins}-${r.losses}-${r.draws}`,
    wins: r.wins, losses: r.losses, draws: r.draws,
    byes: r.byes || 0,
  }));
}

// The closing rounds get their real names, counting back from the final; anything earlier is just
// "Round N". Indexed by DISTANCE from the last round, so a 2-entrant bracket's single round is the
// Final and a 16-entrant bracket's first round isn't miscalled one.
const KNOCKOUT_ROUND_TITLES = ["Final", "Semifinals", "Quarterfinals"];

/**
 * A finished knockout bracket (pairing.js's own KnockoutBracket, with or without the per-match rows
 * — competitionWorker.js strips those before posting) -> the bracket VIEW: one column per round,
 * each match naming both entrants (or a bye), which of them advanced, and the pairing's aggregate
 * score. Names only, no entrant objects: the DOM layer renders every cell via textContent.
 * @param {{ rounds: {round: number, matches: object[]}[], champion: {name: string} }} bracket
 */
export function shapeBracketView(bracket) {
  const rounds = (bracket && bracket.rounds) || [];
  return {
    champion: (bracket && bracket.champion && bracket.champion.name) || null,
    rounds: rounds.map(r => ({
      round: r.round,
      title: KNOCKOUT_ROUND_TITLES[rounds.length - r.round] || `Round ${r.round}`,
      matches: r.matches.map(m => {
        const a = m.a ? m.a.name : null;
        const b = m.b ? m.b.name : null;
        const winner = m.winner ? m.winner.name : null;
        const res = m.result;
        return {
          round: m.round, a, b, bye: !!m.bye, winner,
          aWon: winner != null && winner === a,
          bWon: b != null && winner === b,
          // A bye is not a scoreline; a played pairing shows its aggregate from A's side, with the
          // draw count appended only when there actually were draws (they're near-impossible here —
          // D7 — so a permanent "-0" would be noise).
          score: m.bye ? "bye" : res ? (res.draws ? `${res.aWins}-${res.bWins}-${res.draws}` : `${res.aWins}-${res.bWins}`) : "",
        };
      }),
    })),
  };
}

/* ============================================================
   DOM RENDERING — guarded the dom.js way: every entry point below either checks `mapSelectEl`
   itself or is only ever reached from one that did, so this whole section is inert (never throws)
   under Node with no DOM. See test/static-integrity.test.js's C10 check.
   ============================================================ */

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// Persisted across renders/mode-switches, same philosophy as setup.js's own `setup` object
// ("carried across choose another battlefield restarts").
//
// worlds starts EMPTY, not `[MAP_CHOICES[0]]` — this file and setup.js import each other (see the
// header above), and reading an imported binding at TOP LEVEL in either half of a cycle risks a
// TDZ ReferenceError depending purely on which side happens to evaluate first (main.js -> setup.js
// -> competition.js means setup.js is always mid-evaluation, its own `MAP_CHOICES` line not yet
// reached, the instant competition.js's top-level code would run — confirmed by
// test/static-integrity.test.js's cycle test, which spawns EVERY shipped module as its own entry
// point and so catches both directions). renderCompetition() below defaults it lazily, well after
// module evaluation has finished, exactly to avoid this.
const compConfig = {
  // mode: "new" (a draft that joins the roster the instant a duel using it runs) or "roster" (an
  // existing, persistent entry picked by name — see resolveEntrantPick above). Every field below
  // mode is the "new"-mode draft; rosterName is the "roster"-mode pick. Both sets of fields are
  // always present (never deleted on a mode switch) purely so flipping back and forth doesn't lose
  // whatever the player already typed.
  entrantA: { mode: "new", rosterName: "", name: "Entrant A", strategy: "default", archetype: null, faction: "neutral" },
  entrantB: { mode: "new", rosterName: "", name: "Entrant B", strategy: "default", archetype: null, faction: "neutral" },
  difficulty: "medium",
  worlds: [],
  seeds: 1,
  seedText: "",   // blank = random, same convention as setup.js's own Seed row
};

let compScreen = "duel";     // "duel" | "roster" | "standings" — the mode's own tab row
let compView = "config";     // "config" | "progress" | "results" — Quick Duel's own sub-view
let compError = null;        // a validation/run error, shown in the config view
let activeWorker = null;
let activeJob = null;        // the job the current/last worker run was built from
let progress = { completed: 0, total: 0 };
let lastDone = null;         // the last {type:"done", rows, aWins, bWins, draws} message
let lastEloDelta = null;     // { [entrantName]: {before, after} } captured when the last duel's rows were recorded
let lastRecordError = null;  // set only if recordCompetition itself somehow rejected a finished duel's rows
let wrapEl = null;           // the one div this module owns inside mapSelectEl

// The persisted roster + ladder (competitionLedger.js), loaded lazily on first real use — not at
// module-evaluation time, so importing this module for its pure exports alone (tests) never
// touches localStorage, and so a real browser load order that hasn't rendered the competition
// screen yet never pays for a read it doesn't need. competitionLedger.js sits outside this file's
// own import cycle with setup.js (see the header), so there's no TDZ reason for the laziness here —
// it's purely "don't do I/O nothing asked for yet".
let ledger = null;
function ensureLedger() {
  if (!ledger) ledger = loadLedgerFromStorage() || createLedger();
  return ledger;
}

let standingsDifficulty = null;   // lazily defaulted to compConfig.difficulty by renderCompetition() below
let compRosterError = null;       // a validation/import error, shown on the Roster screen
// The Roster screen's own "add a new entry directly" form state (task's own point 2 — not only
// reachable via a duel's New Entrant path). Rebuilt fresh after every successful add so the form
// doesn't carry a stale name into the next entry.
function freshRosterDraft() {
  return { name: "", strategy: "default", archetype: null, faction: "neutral" };
}
let rosterDraft = freshRosterDraft();

// --- Tournament screen state (Phase 3). Its own config object rather than sharing compConfig's:
// the two screens are configured independently (picking 4 worlds for a tournament shouldn't silently
// rewrite the Quick Duel screen you were just on), but they drive the SAME pickers — see
// renderWorldPicker/renderSeedsRow/renderSeedRow above, which take whichever config they're editing.
// `worlds`/`difficulty` start empty/null and are defaulted lazily by renderCompetition() for exactly
// the TDZ reason compConfig.worlds already documents. ------------------------------------------
const tourneyConfig = {
  format: "round-robin",
  field: [],          // roster NAMES, in tick order — a knockout re-seeds a COPY by rating, never this
  difficulty: null,
  worlds: [],
  seeds: 1,
  seedText: "",       // blank = random, same convention as the Quick Duel/skirmish Seed rows
  roundsText: "",     // Swiss only; blank = pairing.js's own swissRoundCount default
};
let tourneyView = "config";      // "config" | "progress" | "results"
let tourneyError = null;
let tourneyJob = null;           // the job the current/last tournament run was built from
let tourneyProgress = null;      // the last {type:"progress"} message (plus a pre-run {completed,total})
let tourneyPairings = [];        // {type:"pairing"} summaries in arrival order — the live standings' input
let tourneyDone = null;          // the last {type:"done"} tournament message
let tourneyLedgerNote = null;    // what the ledger fold did: { recorded, total, error, before, after }

// Same fallback boot.js's own resolveSeed(setup) uses — blank/invalid text means "pick something
// random", a real Math.random call, which is exactly why this lives in the DOM layer and not
// among the pure exports above.
function resolveSeedBase(text) {
  const v = (text || "").trim();
  const n = Number.parseInt(v, 10);
  return (v === "" || Number.isNaN(n)) ? (Math.floor(Math.random() * 0x100000000) >>> 0) : (n >>> 0);
}

function formatElo(entry) {
  if (!entry) return `${INITIAL_RATING}?`;
  return entry.games < PROVISIONAL_GAMES ? `${Math.round(entry.rating)}?` : String(Math.round(entry.rating));
}

function goBack() {
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  compView = "config";
  // Leaving the mode kills whatever was running, so a run that was mid-flight must not come back as
  // a frozen, un-cancellable progress view next time this screen opens. A FINISHED tournament's
  // results are still worth returning to, so only the progress view is reset.
  if (tourneyView === "progress") tourneyView = "config";
  compError = null;
  setup.mode = "skirmish";
  renderMapSelect();
}

const COMP_TABS = [
  { key: "duel", label: "🏆 Quick Duel" },
  { key: "tournament", label: "🏟 Tournament" },
  { key: "roster", label: "📋 Roster" },
  { key: "standings", label: "📈 Standings" },
];

function renderCompTabs(container) {
  const row = mk("div", "comp-tabs");
  COMP_TABS.forEach(t => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "comp-tab-btn" + (compScreen === t.key ? " active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      if (compScreen === t.key) return;
      compScreen = t.key;
      compError = null;
      compRosterError = null;
      tourneyError = null;
      refreshCompView();
    });
    row.appendChild(btn);
  });
  container.appendChild(row);
}

function refreshCompView() {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  const backBtn = mk("button", "btn comp-back-btn", "← Back to Menu");
  backBtn.type = "button";
  backBtn.addEventListener("click", goBack);
  wrapEl.appendChild(backBtn);

  renderCompTabs(wrapEl);

  if (compScreen === "roster") renderRosterScreen(wrapEl);
  else if (compScreen === "standings") renderStandingsScreen(wrapEl);
  else if (compScreen === "tournament") renderTournamentScreen(wrapEl);
  else if (compView === "progress") renderProgressView(wrapEl);
  else if (compView === "results") renderResultsView(wrapEl);
  else renderConfigView(wrapEl);
}

/* ---------- config view ---------- */

const ENTRANT_MODE_OPTIONS = [
  { label: "From Roster", mult: "roster", note: "pick an existing, persistent entrant" },
  { label: "New Entrant", mult: "new", note: "create one — joins the roster once this duel runs" },
];

// name(strategy · archetype · faction) — reuses shapeRosterRow's own display strings so the picker
// and the Roster screen's table never describe the same entry two different ways.
function rosterOptionLabel(entry) {
  const row = shapeRosterRow(entry);
  return `${row.name} — ${row.strategy} · ${row.archetype} · ${row.faction}`;
}

function renderEntrantCard(container, key, label) {
  const entrant = compConfig[key];
  const card = mk("div", "comp-entrant");
  card.appendChild(mk("h4", "comp-entrant-heading", label));

  card.appendChild(optionGroup(entrant.mode, ENTRANT_MODE_OPTIONS, val => { entrant.mode = val; refreshCompView(); }));

  if (entrant.mode === "roster") {
    const roster = ensureLedger().roster;
    if (roster.length === 0) {
      card.appendChild(mk("p", "setup-hint", "No roster entries yet — switch to New Entrant to create one."));
    } else {
      const select = document.createElement("select");
      select.className = "comp-roster-select";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "— pick an entrant —";
      placeholder.disabled = true;
      placeholder.selected = !entrant.rosterName;
      select.appendChild(placeholder);
      roster.forEach(r => {
        const opt = document.createElement("option");
        opt.value = r.name;
        opt.textContent = rosterOptionLabel(r);
        opt.selected = r.name === entrant.rosterName;
        select.appendChild(opt);
      });
      select.addEventListener("change", () => { entrant.rosterName = select.value; });
      card.appendChild(select);
    }
  } else {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "comp-name-input";
    nameInput.placeholder = label;
    nameInput.maxLength = 40;
    nameInput.value = entrant.name;
    nameInput.addEventListener("input", () => { entrant.name = nameInput.value; });
    card.appendChild(nameInput);

    card.appendChild(mk("span", "setup-label comp-substrategy-label", "Strategy"));
    card.appendChild(optionGroup(entrant.strategy, STRATEGY_OPTIONS, val => { entrant.strategy = val; }));

    card.appendChild(mk("span", "setup-label comp-substrategy-label", "Archetype"));
    card.appendChild(optionGroup(entrant.archetype, ARCHETYPE_OPTIONS, val => { entrant.archetype = val; }));

    card.appendChild(mk("span", "setup-label comp-substrategy-label", "Faction"));
    card.appendChild(optionGroup(entrant.faction, ROSTER_FACTION_OPTIONS, val => { entrant.faction = val; }));
    card.appendChild(mk("p", "setup-hint",
      "Faction is stored on this roster entry for flavor — it doesn't change this duel (a self-play match has no faction dial)."));
  }

  container.appendChild(card);
}

// The world/seeds/seed pickers below all take the config object they edit, so the Tournament screen
// (Phase 3) drives the SAME three pickers Quick Duel does — same classes, same behaviour, same
// "every world × every seed runs both directions" rule — over its own state, rather than growing a
// second, drifting copy of each. `cfg` is compConfig or tourneyConfig; both carry
// worlds/seeds/seedText.
function renderWorldPicker(container, cfg) {
  container.appendChild(mk("p", "setup-hint",
    "Worlds — pick one or more. Every world × every seed below runs BOTH directions, side-swapped."));
  const wrap = mk("div", "opt-group comp-worlds");
  MAP_CHOICES.forEach(id => {
    const selected = cfg.worlds.includes(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn" + (selected ? " active" : "");
    btn.appendChild(mk("span", "opt-label", planetName(id)));
    btn.appendChild(mk("span", "opt-note", archetypeFor(id).name));
    btn.addEventListener("click", () => {
      cfg.worlds = cfg.worlds.includes(id) ? cfg.worlds.filter(w => w !== id) : [...cfg.worlds, id];
      refreshCompView();
    });
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
}

function renderSeedsRow(container, cfg) {
  const seedsRow = mk("div", "setup-row");
  seedsRow.appendChild(mk("span", "setup-label", "Seeds / world"));
  const seedsInput = document.createElement("input");
  seedsInput.type = "number";
  seedsInput.min = "1";
  seedsInput.max = "10";
  seedsInput.className = "comp-seeds-input";
  seedsInput.value = String(cfg.seeds);
  seedsInput.addEventListener("change", () => {
    cfg.seeds = Math.max(1, Math.floor(Number(seedsInput.value)) || 1);
    refreshCompView();
  });
  seedsRow.appendChild(seedsInput);
  container.appendChild(seedsRow);
}

function renderSeedRow(container, cfg) {
  const seedRow = mk("div", "setup-row");
  seedRow.appendChild(mk("span", "setup-label", "Seed"));
  const seedInput = document.createElement("input");
  seedInput.type = "text";
  seedInput.inputMode = "numeric";
  seedInput.className = "seed-input";
  seedInput.placeholder = "random";
  seedInput.value = cfg.seedText;
  seedInput.addEventListener("input", () => { cfg.seedText = seedInput.value; });
  seedRow.appendChild(seedInput);
  container.appendChild(seedRow);
}

function renderConfigView(container) {
  container.appendChild(mk("p", "setup-hint comp-intro",
    "Pick two named entrants — from the roster, or fresh — and watch them fight, side-swapped " +
    "across every world × seed you choose. Runs entirely in the background — no player economy, " +
    "no canvas — then folds the result into the ladder for this difficulty's bracket."));

  const entrants = mk("div", "comp-entrants");
  renderEntrantCard(entrants, "entrantA", "Entrant A");
  renderEntrantCard(entrants, "entrantB", "Entrant B");
  container.appendChild(entrants);

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Difficulty"));
  diffRow.appendChild(optionGroup(compConfig.difficulty, DIFFICULTY_OPTIONS, key => { compConfig.difficulty = key; }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "One shared difficulty for the whole duel — pinned identical for both entrants, a duel's whole fairness point."));

  renderWorldPicker(container, compConfig);
  renderSeedsRow(container, compConfig);
  renderSeedRow(container, compConfig);

  const n = compConfig.worlds.length * compConfig.seeds * 2;
  container.appendChild(mk("p", "setup-hint",
    compConfig.worlds.length ? `This will run ${n} match${n === 1 ? "" : "es"}.` : "Pick at least one world."));

  if (compError) container.appendChild(mk("p", "comp-error", compError));

  const runBtn = mk("button", "btn", "▶ Run Duel");
  runBtn.type = "button";
  runBtn.addEventListener("click", startDuel);
  container.appendChild(runBtn);
}

/* ---------- progress view ---------- */

function renderProgressView(container) {
  const wrap = mk("div", "comp-progress");
  wrap.appendChild(mk("p", "setup-hint", `Running duel — ${progress.completed} of ${progress.total} matches`));

  const bar = mk("div", "comp-progress-bar");
  const fill = mk("div", "comp-progress-fill");
  const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  fill.style.width = pct + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const cancelBtn = mk("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => {
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    compView = "config";
    refreshCompView();
  });
  wrap.appendChild(cancelBtn);

  container.appendChild(wrap);
}

/* ---------- results view ---------- */

// `delta` is { before, after } — both real ledger rating entries (ratingLookup), captured straight
// across recordCompetition's own mutation in startDuel's "done" handler below — so the number
// shown is the actual persisted change, not a from-scratch session estimate (Phase 1's own
// eloFromRows, still exported/tested above, but no longer what the results view itself renders).
function eloCard(name, delta) {
  const card = mk("div", "comp-elo-card");
  const change = Math.round(delta.after.rating) - Math.round(delta.before.rating);
  card.appendChild(mk("span", "comp-elo-name", name));
  card.appendChild(mk("span", "comp-elo-value", `${formatElo(delta.after)} (${change > 0 ? "+" : ""}${change})`));
  card.appendChild(mk("span", "comp-elo-games",
    `${delta.after.games} game${delta.after.games === 1 ? "" : "s"}${delta.after.games < PROVISIONAL_GAMES ? " — provisional" : ""}`));
  return card;
}

function buildResultsTable(rows) {
  const shaped = shapeResultsTable(rows);
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["World", "Seed", "Side", "Swap", "Winner", "Reason", "Time (s)", "Margin"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  shaped.forEach(r => {
    const tr = document.createElement("tr");
    [planetName(r.world), r.seed, r.side, r.swap ? "yes" : "no", r.winner, r.reason, r.time, r.margin]
      .forEach(v => tr.appendChild(mk("td", null, String(v))));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function renderResultsView(container) {
  const { rows, aWins, bWins, draws } = lastDone;
  const aName = activeJob.entrantA.name, bName = activeJob.entrantB.name;
  const diffLabel = (DIFFICULTY_OPTIONS.find(o => o.mult === activeJob.difficulty) || {}).label || activeJob.difficulty;

  container.appendChild(mk("h3", "cards-heading", `${aName} vs ${bName} — ${aWins}-${bWins}-${draws} (W-L-D)`));
  container.appendChild(mk("p", lastRecordError ? "comp-note" : "comp-note comp-note-good",
    lastRecordError
      ? `The duel finished, but the ladder couldn't be updated: ${lastRecordError}`
      : `Elo updated for the ${diffLabel} bracket — see the Standings screen.`));

  if (lastEloDelta) {
    const eloRow = mk("div", "comp-elo-row");
    eloRow.appendChild(eloCard(aName, lastEloDelta[aName]));
    eloRow.appendChild(eloCard(bName, lastEloDelta[bName]));
    container.appendChild(eloRow);
  }

  const tableWrap = mk("div", "comp-table-wrap");
  tableWrap.appendChild(buildResultsTable(rows));
  container.appendChild(tableWrap);

  const actions = mk("div", "comp-actions");
  const again = mk("button", "btn", "Run Another Duel");
  again.type = "button";
  again.addEventListener("click", () => { compView = "config"; refreshCompView(); });
  actions.appendChild(again);
  const seeStandings = mk("button", "btn", "View Standings");
  seeStandings.type = "button";
  seeStandings.addEventListener("click", () => { standingsDifficulty = activeJob.difficulty; compScreen = "standings"; refreshCompView(); });
  actions.appendChild(seeStandings);
  container.appendChild(actions);
}

/* ---------- run ---------- */

function startDuel() {
  compError = null;
  const activeLedger = ensureLedger();

  // Resolve BOTH pickers against the current roster before building the job at all — a "roster"
  // pick whose name has since vanished (removed on the Roster screen mid-edit) is caught here,
  // not after a Worker has already spun up.
  let resolvedA, resolvedB;
  try {
    resolvedA = resolveEntrantPick(compConfig.entrantA, activeLedger);
    resolvedB = resolveEntrantPick(compConfig.entrantB, activeLedger);
  } catch (err) {
    compError = err.message;
    refreshCompView();
    return;
  }

  let job;
  try {
    job = buildJob({
      entrantA: resolvedA,
      entrantB: resolvedB,
      difficulty: compConfig.difficulty,
      worlds: compConfig.worlds,
      seeds: compConfig.seeds,
      seedBase: resolveSeedBase(compConfig.seedText),
    });
  } catch (err) {
    compError = err.message;
    refreshCompView();
    return;
  }

  // THE KEY UX POINT: a brand-new entrant joins the roster HERE — the duel is genuinely about to
  // run, validated and about to start a Worker — never on a keystroke while its form was still a
  // draft. Best-effort atomic: if committing the SECOND entrant fails (its name collided with
  // something added since it was typed, or is one of the three forbidden identity strings —
  // addRosterEntry's own guard), roll back the first so a rejected click never leaves half a pair
  // behind on the roster.
  const committed = [];
  try {
    if (resolvedA.isNew) {
      addRosterEntry(activeLedger, { name: job.entrantA.name, strategy: job.entrantA.strategy, archetype: job.entrantA.archetype, faction: resolvedA.faction, createdAt: Date.now() });
      committed.push(job.entrantA.name);
    }
    if (resolvedB.isNew) {
      addRosterEntry(activeLedger, { name: job.entrantB.name, strategy: job.entrantB.strategy, archetype: job.entrantB.archetype, faction: resolvedB.faction, createdAt: Date.now() });
      committed.push(job.entrantB.name);
    }
  } catch (err) {
    for (const name of committed) removeRosterEntry(activeLedger, name);
    compError = err.message;
    refreshCompView();
    return;
  }
  saveLedgerToStorage(activeLedger);
  // Point each freshly-created entrant's own picker at its new roster row, so "Run Another Duel"
  // reuses it instead of trying (and failing, "already on the roster") to re-add the same name.
  if (resolvedA.isNew) { compConfig.entrantA.mode = "roster"; compConfig.entrantA.rosterName = job.entrantA.name; }
  if (resolvedB.isNew) { compConfig.entrantB.mode = "roster"; compConfig.entrantB.rosterName = job.entrantB.name; }

  activeJob = job;
  progress = { completed: 0, total: matchCount(job) };
  compView = "progress";
  // One worker slot for the whole mode: this duel takes it. A tournament that was running is about
  // to be terminated below, so its progress view must not be left behind to come back frozen.
  if (tourneyView === "progress") tourneyView = "config";
  refreshCompView();

  if (activeWorker) activeWorker.terminate();   // guard against a stray prior worker, belt-and-suspenders
  activeWorker = new Worker(new URL("./competitionWorker.js", import.meta.url), { type: "module" });
  activeWorker.onmessage = e => {
    const msg = e.data;
    // Every branch below updates state unconditionally (the ledger write must happen regardless
    // of which tab is on screen when the worker finishes) but only calls refreshCompView() when
    // the Quick Duel tab is actually the one showing — otherwise a stray progress/done/error tick
    // would wipe wrapEl.innerHTML out from under whatever the Roster/Standings screen is doing
    // right now (an open confirm-delete dialog, most notably) via refreshCompView's own reset.
    const onDuelTab = () => compScreen === "duel";
    if (msg.type === "progress") {
      progress = { completed: msg.completed, total: msg.total };
      if (onDuelTab() && compView === "progress") refreshCompView();
    } else if (msg.type === "done") {
      lastDone = msg;
      activeWorker = null;

      // Fold this duel's rows into the ledger for the pinned difficulty bracket. The ledger owns
      // this write (competitionLedger.js's own recordCompetition, applying elo.js's applySeries
      // internally) — never a second, hand-rolled applySeries call here. Ratings are snapshotted
      // BEFORE and read back AFTER so the results view can show the real persisted delta.
      const bracketBefore = activeLedger.ratingsByDifficulty[job.difficulty];
      const beforeA = ratingLookup(bracketBefore, job.entrantA.name);
      const beforeB = ratingLookup(bracketBefore, job.entrantB.name);
      try {
        recordCompetition(activeLedger, {
          at: Date.now(), difficulty: job.difficulty,
          aName: job.entrantA.name, bName: job.entrantB.name, rows: msg.rows,
        });
        saveLedgerToStorage(activeLedger);
        lastRecordError = null;
      } catch (err) {
        // Not expected in practice — buildJob/addRosterEntry above already guarantee both names are
        // real, distinct, and non-forbidden — but a rejected write must surface, not vanish.
        lastRecordError = err.message;
      }
      const bracketAfter = activeLedger.ratingsByDifficulty[job.difficulty];
      lastEloDelta = {
        [job.entrantA.name]: { before: beforeA, after: ratingLookup(bracketAfter, job.entrantA.name) },
        [job.entrantB.name]: { before: beforeB, after: ratingLookup(bracketAfter, job.entrantB.name) },
      };

      compView = "results";
      if (onDuelTab()) refreshCompView();
    } else if (msg.type === "error") {
      activeWorker = null;
      compError = `The duel failed to run: ${msg.message}`;
      compView = "config";
      if (onDuelTab()) refreshCompView();
    }
  };
  activeWorker.postMessage(job);
}

/* ============================================================
   TOURNAMENT SCREEN (docs/competitions-and-elo.md Phase 3) — format picker, field builder over the
   roster, the shared world/seed/difficulty pickers, an up-front cost estimate, live round-by-round
   progress, and a standings table (round-robin/Swiss) or a real bracket (knockout). Every pairing
   folds into the ledger when the tournament finishes, one recordCompetition call each, in the
   worker's own completion order (D6) — see foldTournamentIntoLedger below.

   ENTRANTS ARE ROSTER ROWS, always. Phase 2 established that for Quick Duel ("every entrant is a
   named, persistent roster row"); a tournament has no ad-hoc-name path AT ALL, because a field of
   throwaway names would write throwaway rows into the very ladder the tournament exists to move.
   Too small a roster is answered by pointing at the Roster tab, not by letting names be typed here.
   ============================================================ */

const formatLabelFor = key => (TOURNAMENT_FORMAT_OPTIONS.find(o => o.mult === key) || {}).label || key;
const difficultyLabelFor = key => (DIFFICULTY_OPTIONS.find(o => o.mult === key) || {}).label || key;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The Swiss round override as a NUMBER, or undefined for "use pairing.js's own default" — blank and
// junk both mean the default, the same lenient reading resolveSeedBase gives the Seed box.
function swissRoundsOverride() {
  const n = Number.parseInt((tourneyConfig.roundsText || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function tourneyDifficulty() {
  return tourneyConfig.difficulty || compConfig.difficulty;
}

function renderTournamentScreen(container) {
  if (tourneyView === "progress") renderTournamentProgress(container);
  else if (tourneyView === "results" && tourneyDone) renderTournamentResults(container);
  else renderTournamentConfig(container);
}

/* ---------- tournament: config ---------- */

function renderFieldBuilder(container) {
  const roster = ensureLedger().roster;
  // The label goes in its own .setup-row, like every other labelled row on this screen (Format,
  // Difficulty, Swiss rounds, Seeds/world). .setup-label is styled for life INSIDE a .setup-row —
  // appended straight into .comp-screen it picked up the wrong layout and sat misaligned against
  // its siblings. The field list and its actions stay OUTSIDE the row: they're a full-width block,
  // not a label-plus-control pair like the others.
  const labelRow = mk("div", "setup-row");
  labelRow.appendChild(mk("span", "setup-label", "Field"));
  container.appendChild(labelRow);

  if (roster.length < 2) {
    container.appendChild(mk("p", "setup-hint",
      "A tournament runs on named, persistent entrants, and needs at least 2 of them. " +
      "Add entrants on the Roster tab, then come back."));
    const go = mk("button", "btn comp-back-btn", "→ Go to the Roster tab");
    go.type = "button";
    go.addEventListener("click", () => { compScreen = "roster"; tourneyError = null; refreshCompView(); });
    container.appendChild(go);
    return;
  }

  // Drop any pick whose roster entry has since been removed, so the field can never name a
  // now-missing entrant (resolveEntrantPick guards the Quick Duel side of the same hazard).
  const known = new Set(roster.map(r => r.name));
  tourneyConfig.field = tourneyConfig.field.filter(name => known.has(name));

  const list = mk("div", "comp-field-list");
  roster.forEach(entry => {
    const shaped = shapeRosterRow(entry);
    const row = mk("label", "comp-field-row" + (tourneyConfig.field.includes(entry.name) ? " picked" : ""));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "comp-field-check";
    box.checked = tourneyConfig.field.includes(entry.name);
    box.addEventListener("change", () => {
      tourneyConfig.field = box.checked
        ? [...tourneyConfig.field, entry.name]
        : tourneyConfig.field.filter(name => name !== entry.name);
      refreshCompView();
    });
    row.appendChild(box);
    row.appendChild(mk("span", "comp-field-name", shaped.name));
    row.appendChild(mk("span", "comp-field-meta", `${shaped.strategy} · ${shaped.archetype} · ${shaped.faction}`));
    list.appendChild(row);
  });
  container.appendChild(list);

  const actions = mk("div", "comp-field-actions");
  const all = mk("button", "btn comp-remove-btn", "Select all");
  all.type = "button";
  all.addEventListener("click", () => { tourneyConfig.field = roster.map(r => r.name); refreshCompView(); });
  const none = mk("button", "btn comp-remove-btn", "Clear");
  none.type = "button";
  none.addEventListener("click", () => { tourneyConfig.field = []; refreshCompView(); });
  actions.append(all, none);
  actions.appendChild(mk("span", "comp-field-count", `${tourneyConfig.field.length} of ${roster.length} selected`));
  container.appendChild(actions);
}

function renderTournamentConfig(container) {
  container.appendChild(mk("p", "setup-hint comp-intro",
    "Run a real tournament over your roster — round-robin, Swiss, or a knockout bracket. Every " +
    "pairing is a full side-swapped duel, run in the background, and every one of them folds into " +
    "the ladder for this difficulty's bracket as the tournament finishes."));

  const formatRow = mk("div", "setup-row");
  formatRow.appendChild(mk("span", "setup-label", "Format"));
  formatRow.appendChild(optionGroup(tourneyConfig.format, TOURNAMENT_FORMAT_OPTIONS, val => {
    tourneyConfig.format = val;
    refreshCompView();
  }));
  container.appendChild(formatRow);

  renderFieldBuilder(container);

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Difficulty"));
  diffRow.appendChild(optionGroup(tourneyDifficulty(), DIFFICULTY_OPTIONS, key => { tourneyConfig.difficulty = key; refreshCompView(); }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "One shared difficulty for the WHOLE tournament — pinned identical for every entrant in every " +
    "pairing, and its own ladder bracket (D2). Never a per-entrant difficulty."));

  renderWorldPicker(container, tourneyConfig);
  renderSeedsRow(container, tourneyConfig);
  renderSeedRow(container, tourneyConfig);

  const n = tourneyConfig.field.length;
  if (tourneyConfig.format === "swiss") {
    const roundsRow = mk("div", "setup-row");
    roundsRow.appendChild(mk("span", "setup-label", "Swiss rounds"));
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "20";
    input.className = "comp-seeds-input";
    input.placeholder = n >= 2 ? String(swissRoundCount(n)) : "auto";
    input.value = tourneyConfig.roundsText;
    input.addEventListener("change", () => { tourneyConfig.roundsText = input.value; refreshCompView(); });
    roundsRow.appendChild(input);
    container.appendChild(roundsRow);
    container.appendChild(mk("p", "setup-hint",
      n >= 2
        ? `Leave blank for the default, max(3, ceil(log₂ n)) — ${plural(swissRoundCount(n), "round")} for this field.`
        : "Leave blank for the default, max(3, ceil(log₂ n))."));
  }

  // The up-front budget, BEFORE Start Tournament is clickable (the Phase 3 brief's own point: a
  // player who picks a huge field deserves to be told it's a long run before it starts).
  const ready = n >= 2 && tourneyConfig.worlds.length > 0;
  if (ready) {
    const est = tournamentEstimate({
      format: tourneyConfig.format, entrants: n,
      worlds: tourneyConfig.worlds, seeds: tourneyConfig.seeds, rounds: swissRoundsOverride(),
    });
    const line = mk("p", "comp-estimate", est.text);
    line.appendChild(mk("span", "comp-estimate-detail",
      `${plural(est.pairings, "pairing")} × ${plural(tourneyConfig.worlds.length, "world")} × ` +
      `${plural(tourneyConfig.seeds, "seed")} × 2 sides, at roughly ${SECONDS_PER_MATCH}s a match`));
    container.appendChild(line);
  } else {
    container.appendChild(mk("p", "setup-hint",
      n < 2 ? "Pick at least 2 entrants above to see what this run will cost." : "Pick at least one world."));
  }

  if (tourneyError) container.appendChild(mk("p", "comp-error", tourneyError));

  const startBtn = mk("button", "btn" + (ready ? "" : " disabled"), "▶ Start Tournament");
  startBtn.type = "button";
  startBtn.disabled = !ready;
  if (ready) startBtn.addEventListener("click", startTournament);
  container.appendChild(startBtn);
}

/* ---------- tournament: progress ---------- */

// One table shared by the live progress view and the finished round-robin/Swiss results view, so
// the number moving on screen and the number it settles on are rendered by the same code.
function renderTournamentStandingsTable(container, rows, showByes) {
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["#", "Name", "W-L-D", ...(showByes ? ["Byes"] : [])].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  shapeTournamentStandings(rows).forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.appendChild(mk("td", null, String(i + 1)));
    tr.appendChild(mk("td", null, row.name));
    tr.appendChild(mk("td", null, row.record));
    if (showByes) tr.appendChild(mk("td", null, String(row.byes)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

// Every pairing that has finished, newest last — the knockout's live view (a bracket can't be drawn
// until its tree exists) and a running log for the other two formats.
function renderPairingLog(container, pairings) {
  if (!pairings.length) return;
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Round", "Pairing", "Result"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  pairings.forEach(p => {
    const tr = document.createElement("tr");
    const winner = p.aWins === p.bWins ? "tied" : `${p.aWins > p.bWins ? p.aName : p.bName} won`;
    [String(p.round), `${p.aName} vs ${p.bName}`, `${p.aWins}-${p.bWins}-${p.draws} — ${winner}`]
      .forEach(v => tr.appendChild(mk("td", null, v)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderTournamentProgress(container) {
  const wrap = mk("div", "comp-progress");
  const p = tourneyProgress || { completed: 0, total: 0 };
  wrap.appendChild(mk("p", "setup-hint",
    `${formatLabelFor(tourneyConfig.format)} — ` +
    (p.round ? tournamentProgressLabel(p) : `starting… 0 of ${p.total} matches`)));

  const bar = mk("div", "comp-progress-bar");
  const fill = mk("div", "comp-progress-fill");
  fill.style.width = (p.total ? Math.round((p.completed / p.total) * 100) : 0) + "%";
  bar.appendChild(fill);
  wrap.appendChild(bar);

  const cancelBtn = mk("button", "btn", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", () => {
    // Worker#terminate() kills the thread outright mid-match — competitionWorker.js needs no
    // cooperative cancellation, and nothing is written to the ledger until its "done" message,
    // which a terminated worker never sends.
    if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
    tourneyView = "config";
    refreshCompView();
  });
  wrap.appendChild(cancelBtn);
  container.appendChild(wrap);

  if (tourneyConfig.format === "knockout") {
    renderPairingLog(container, tourneyPairings);
  } else if (tourneyJob) {
    container.appendChild(mk("p", "setup-hint", "Standings so far:"));
    renderTournamentStandingsTable(
      container,
      tournamentStandingsRows(tourneyJob.field.map(e => e.name), tourneyPairings),
      tourneyConfig.format === "swiss",
    );
    if (tourneyConfig.format === "swiss")
      container.appendChild(mk("p", "setup-hint", "Byes are settled when the tournament finishes."));
  }
}

/* ---------- tournament: results ---------- */

function bracketSeat(name, won, isBye) {
  const seat = mk("div", "comp-bracket-seat" + (won ? " winner" : "") + (isBye ? " bye" : ""));
  seat.appendChild(mk("span", "comp-bracket-seat-name", isBye ? "BYE" : name));
  if (won) seat.appendChild(mk("span", "comp-bracket-check", "✓"));
  return seat;
}

function renderBracket(container, view) {
  const wrap = mk("div", "comp-bracket-wrap");
  const board = mk("div", "comp-bracket");
  view.rounds.forEach(round => {
    const col = mk("div", "comp-bracket-round");
    col.appendChild(mk("h4", "comp-bracket-title", round.title));
    round.matches.forEach(m => {
      const card = mk("div", "comp-bracket-match" + (m.bye ? " is-bye" : ""));
      card.appendChild(bracketSeat(m.a, m.aWon, false));
      card.appendChild(bracketSeat(m.b, m.bWon, m.b == null));
      card.appendChild(mk("span", "comp-bracket-score", m.score));
      col.appendChild(card);
    });
    board.appendChild(col);
  });
  wrap.appendChild(board);
  container.appendChild(wrap);
}

// What the ledger fold actually did to every entrant's rating, straight off the ledger (before and
// after recordCompetition), so "the ladder was updated" is shown rather than merely claimed.
function renderLadderMovement(container, note) {
  const names = Object.keys(note.after);
  if (!names.length) return;
  container.appendChild(mk("p", "setup-hint", "Ladder movement:"));
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Name", "Rating", "Change", "Games"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  names
    .sort((x, y) => note.after[y].rating - note.after[x].rating || x.localeCompare(y))
    .forEach(name => {
      const before = note.before[name], after = note.after[name];
      const change = Math.round(after.rating) - Math.round(before.rating);
      const tr = document.createElement("tr");
      [name, formatElo(after), `${change > 0 ? "+" : ""}${change}`, String(after.games)]
        .forEach(v => tr.appendChild(mk("td", null, v)));
      tbody.appendChild(tr);
    });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderTournamentResults(container) {
  const done = tourneyDone;
  const job = tourneyJob;
  const diffLabel = difficultyLabelFor(job.difficulty);

  container.appendChild(mk("h3", "cards-heading",
    `${formatLabelFor(done.format)} — ${plural(done.field.length, "entrant")}, ${plural(done.pairings.length, "pairing")}`));

  const note = tourneyLedgerNote || { recorded: 0, total: 0, error: "the result was never recorded" };
  container.appendChild(mk("p", note.error ? "comp-note" : "comp-note comp-note-good",
    note.error
      ? `The tournament finished, but the ladder update stopped after ${plural(note.recorded, "pairing")}: ${note.error}`
      : `Elo updated for the ${diffLabel} bracket — ${plural(note.recorded, "pairing")} recorded, in the order they were played. See the Standings screen.`));

  if (done.format === "knockout") {
    container.appendChild(mk("p", "comp-champion", `🏆 Champion: ${done.champion}`));
    renderBracket(container, shapeBracketView(done.bracket));
  } else {
    renderTournamentStandingsTable(container, done.standings, done.format === "swiss");
    if (done.format === "swiss" && done.byeNames && done.byeNames.length)
      container.appendChild(mk("p", "setup-hint",
        `Byes: ${done.byeNames.join(", ")} — a bye is never scored as a win, only recorded as a round sat out.`));
    renderPairingLog(container, done.pairings);
  }

  if (tourneyLedgerNote) renderLadderMovement(container, tourneyLedgerNote);

  const actions = mk("div", "comp-actions");
  const again = mk("button", "btn", "Run Another Tournament");
  again.type = "button";
  again.addEventListener("click", () => { tourneyView = "config"; refreshCompView(); });
  actions.appendChild(again);
  const seeStandings = mk("button", "btn", "View Standings");
  seeStandings.type = "button";
  seeStandings.addEventListener("click", () => { standingsDifficulty = job.difficulty; compScreen = "standings"; refreshCompView(); });
  actions.appendChild(seeStandings);
  container.appendChild(actions);
}

/* ---------- tournament: run ---------- */

// Fold a finished tournament into the ledger: ONE recordCompetition call PER PAIRING, in the exact
// order the worker finished them (round 1 before round 2, in-round order preserved) — D6's
// canonical-ordering rule applied to a multi-pairing tournament, since Elo is order-dependent.
// Deliberately NOT one batched call: recordCompetition is shaped around a single aName/bName pair
// and writes one history entry per competition, exactly as Quick Duel already calls it per duel.
function foldTournamentIntoLedger(job, done) {
  const activeLedger = ensureLedger();
  const names = job.field.map(e => e.name);
  const bracketBefore = activeLedger.ratingsByDifficulty[job.difficulty];
  const before = {};
  for (const name of names) before[name] = ratingLookup(bracketBefore, name);

  let recorded = 0;
  let error = null;
  for (const pairing of done.pairings) {
    try {
      recordCompetition(activeLedger, {
        at: Date.now(), difficulty: job.difficulty,
        aName: pairing.aName, bName: pairing.bName, rows: pairing.rows,
      });
      recorded++;
    } catch (err) {
      // Not expected — buildTournamentJob already guarantees every name is real, distinct and
      // non-forbidden — but a rejected write must surface rather than vanish, and the pairings
      // already recorded stay recorded (they really were played).
      error = err.message;
      break;
    }
  }
  saveLedgerToStorage(activeLedger);

  const bracketAfter = activeLedger.ratingsByDifficulty[job.difficulty];
  const after = {};
  for (const name of names) after[name] = ratingLookup(bracketAfter, name);
  tourneyLedgerNote = { recorded, total: done.pairings.length, error, before, after };
}

function startTournament() {
  tourneyError = null;
  const activeLedger = ensureLedger();

  // Resolve every pick against the CURRENT roster (never a stale copy) before building the job —
  // the same discipline resolveEntrantPick gives a Quick Duel's two pickers.
  const picked = tourneyConfig.field
    .map(name => activeLedger.roster.find(r => r.name === name))
    .filter(Boolean);
  if (picked.length < 2) {
    tourneyError = "Pick at least 2 entrants from the roster.";
    refreshCompView();
    return;
  }

  const difficulty = tourneyDifficulty();
  // A knockout consumes a SEEDING and never invents one (pairing.js's own contract), so seed it
  // here, off this difficulty bracket's own ladder. The other two formats read the field's order as
  // nothing more than an order, so they keep the player's own selection order.
  const field = tourneyConfig.format === "knockout"
    ? seedFieldByRating(picked, activeLedger.ratingsByDifficulty[difficulty])
    : picked;

  let job;
  try {
    job = buildTournamentJob({
      format: tourneyConfig.format,
      field,
      difficulty,
      worlds: tourneyConfig.worlds,
      seeds: tourneyConfig.seeds,
      seedBase: resolveSeedBase(tourneyConfig.seedText),
      rounds: swissRoundsOverride(),
    });
  } catch (err) {
    tourneyError = err.message;
    refreshCompView();
    return;
  }

  tourneyJob = job;
  tourneyPairings = [];
  tourneyDone = null;
  tourneyLedgerNote = null;
  tourneyProgress = {
    completed: 0,
    total: tournamentEstimate({
      format: job.format, entrants: job.field.length, worlds: job.worlds, seeds: job.seeds, rounds: job.rounds,
    }).matches,
  };
  tourneyView = "progress";
  // The mirror of startDuel's own line: a Quick Duel that was still running loses the worker slot
  // below, so its progress view is reset rather than left to come back frozen.
  if (compView === "progress") compView = "config";
  refreshCompView();

  // One worker slot for the whole mode: starting a tournament cancels whatever was running, exactly
  // as starting a duel already does.
  if (activeWorker) activeWorker.terminate();
  activeWorker = new Worker(new URL("./competitionWorker.js", import.meta.url), { type: "module" });
  activeWorker.onmessage = e => {
    const msg = e.data;
    // Same rule as startDuel's handler: state updates land unconditionally (the ledger write must
    // happen whichever tab is on screen), but the DOM is only rebuilt when the Tournament tab is
    // actually showing — otherwise a progress tick would wipe the Roster/Standings screen out from
    // under whatever it's doing.
    const onTourneyTab = () => compScreen === "tournament";
    if (msg.type === "progress") {
      tourneyProgress = msg;
      if (onTourneyTab() && tourneyView === "progress") refreshCompView();
    } else if (msg.type === "pairing") {
      tourneyPairings = [...tourneyPairings, msg];
      if (onTourneyTab() && tourneyView === "progress") refreshCompView();
    } else if (msg.type === "done") {
      activeWorker = null;
      tourneyDone = msg;
      foldTournamentIntoLedger(job, msg);
      tourneyView = "results";
      if (onTourneyTab()) refreshCompView();
    } else if (msg.type === "error") {
      activeWorker = null;
      tourneyError = `The tournament failed to run: ${msg.message}`;
      tourneyView = "config";
      if (onTourneyTab()) refreshCompView();
    }
  };
  activeWorker.postMessage(job);
}

/* ---------- roster screen ---------- */

// A small local Blob-plus-synthetic-anchor download, mirroring saveload.js's own Save-button idiom
// (downloadJSON there) rather than importing it: competitionLedger.js's own header keeps this
// module's dependency surface small on purpose ("kept independent of saveload.js itself ... to
// keep this module DOM-free and its dependency surface small") and saveload.js doesn't export its
// helper anyway — same reasoning, one file over.
function stampFilename() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function exportLadderToFile() {
  const blob = new Blob([JSON.stringify(exportLedger(ensureLedger()))], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `stellar-frontier-ladder-${stampFilename()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const MAX_LADDER_FILE_BYTES = 4 * 1024 * 1024;   // generous headroom over any real ladder (competitionLedger.js's own sanitizer caps it further)

function importLadderFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_LADDER_FILE_BYTES) { compRosterError = "Import failed: that file is too large to be a real ladder."; refreshCompView(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      // JSON.parse first (never eval); importLedgerJSON sanitizes the structure and every field
      // before any of it is trusted (competitionLedger.js's own untrusted-input pipeline) — a
      // corrupt or hostile file throws a clear message here rather than failing silently.
      try {
        ledger = importLedgerJSON(String(reader.result));
        saveLedgerToStorage(ledger);
        compRosterError = null;
      } catch (err) {
        compRosterError = `Import failed: ${err.message}`;
      }
      refreshCompView();
    };
    reader.onerror = () => { compRosterError = "Import failed: could not read the file."; refreshCompView(); };
    reader.readAsText(file);
  });
  input.click();
}

// A small confirm-before-delete modal, same overlay/card idiom as saveload.js's own goHome and
// landingPicker.js's landing-pick-confirm — each of those gets its OWN class names rather than
// literally sharing .home-confirm (see landingPicker.js's own comment), so this does too
// (.comp-confirm/.comp-confirm-card in style.css).
function confirmRemoveRosterEntry(name) {
  const activeLedger = ensureLedger();
  const overlay = mk("div", "comp-confirm");
  const card = mk("div", "comp-confirm-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;

  const h = mk("h3", null, `Remove "${name}"?`);
  const played = hasRatingHistory(activeLedger, name);
  const p = mk("p", null, played
    ? `${name} has rating history. Removing it drops it from the Standings screen, but its recorded matches and ratings stay in the ledger.`
    : `${name} hasn't played a rated match yet.`);
  card.append(h, p);

  // Same close()-funnels-every-exit-path discipline as saveload.js's own goHome() confirm modal:
  // Cancel, Confirm, a backdrop click, AND Escape all have to detach the SAME window keydown
  // listener, or closing any way but Escape leaks one listener per dialog opened.
  const previouslyFocused = document.activeElement;
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };

  const actions = mk("div", "comp-confirm-actions");
  const cancelBtn = mk("button", "btn ghost", "Cancel");
  cancelBtn.type = "button";
  cancelBtn.addEventListener("click", close);
  const confirmBtn = mk("button", "btn comp-danger-btn", "Remove");
  confirmBtn.type = "button";
  confirmBtn.addEventListener("click", () => {
    close();
    removeRosterEntry(activeLedger, name);
    saveLedgerToStorage(activeLedger);
    refreshCompView();
  });
  actions.append(cancelBtn, confirmBtn);
  card.appendChild(actions);

  overlay.appendChild(card);
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);
  wrapEl.appendChild(overlay);
  confirmBtn.focus();
}

function renderRosterTable(container, roster) {
  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Name", "Strategy", "Archetype", "Faction", ""].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  roster.forEach(entry => {
    const row = shapeRosterRow(entry);
    const tr = document.createElement("tr");
    [row.name, row.strategy, row.archetype, row.faction].forEach(v => tr.appendChild(mk("td", null, v)));
    const actionsTd = document.createElement("td");
    const removeBtn = mk("button", "btn comp-remove-btn", "Remove");
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => confirmRemoveRosterEntry(entry.name));
    actionsTd.appendChild(removeBtn);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

function renderAddRosterEntryForm(container) {
  container.appendChild(mk("h4", "comp-entrant-heading", "Add a roster entry"));
  const card = mk("div", "comp-entrant");

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "comp-name-input";
  nameInput.placeholder = "Name";
  nameInput.maxLength = 40;
  nameInput.value = rosterDraft.name;
  nameInput.addEventListener("input", () => { rosterDraft.name = nameInput.value; });
  card.appendChild(nameInput);

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Strategy"));
  card.appendChild(optionGroup(rosterDraft.strategy, STRATEGY_OPTIONS, val => { rosterDraft.strategy = val; }));

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Archetype"));
  card.appendChild(optionGroup(rosterDraft.archetype, ARCHETYPE_OPTIONS, val => { rosterDraft.archetype = val; }));

  card.appendChild(mk("span", "setup-label comp-substrategy-label", "Faction"));
  card.appendChild(optionGroup(rosterDraft.faction, ROSTER_FACTION_OPTIONS, val => { rosterDraft.faction = val; }));

  if (compRosterError) card.appendChild(mk("p", "comp-error", compRosterError));

  const addBtn = mk("button", "btn", "+ Add to Roster");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    const activeLedger = ensureLedger();
    try {
      addRosterEntry(activeLedger, {
        name: rosterDraft.name, strategy: rosterDraft.strategy, archetype: rosterDraft.archetype,
        faction: rosterDraft.faction, createdAt: Date.now(),
      });
      saveLedgerToStorage(activeLedger);
      rosterDraft = freshRosterDraft();
      compRosterError = null;
    } catch (err) {
      compRosterError = err.message;
    }
    refreshCompView();
  });
  card.appendChild(addBtn);

  container.appendChild(card);
}

function renderRosterScreen(container) {
  const activeLedger = ensureLedger();

  container.appendChild(mk("p", "setup-hint comp-intro",
    "Every roster entry is a named, persistent competitor. Quick Duel entrants are picked from " +
    "here — or created fresh there, which adds them here the moment their duel actually runs."));

  if (activeLedger.roster.length === 0) {
    container.appendChild(mk("p", "setup-hint", "No roster entries yet — add one below."));
  } else {
    renderRosterTable(container, activeLedger.roster);
  }

  renderAddRosterEntryForm(container);

  const ioRow = mk("div", "comp-io-row");
  const exportBtn = mk("button", "btn", "⭳ Export Ladder");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", exportLadderToFile);
  ioRow.appendChild(exportBtn);
  const importBtn = mk("button", "btn", "⭱ Import Ladder");
  importBtn.type = "button";
  importBtn.addEventListener("click", importLadderFromFile);
  ioRow.appendChild(importBtn);
  container.appendChild(ioRow);
  container.appendChild(mk("p", "setup-hint",
    "Export downloads the whole ladder (roster, ratings, history) as a .json file. Import replaces " +
    "the current ladder with one from a file — a corrupt or unrecognised file is rejected with an error, never applied silently."));
}

/* ---------- standings screen ---------- */

function renderStandingsScreen(container) {
  const activeLedger = ensureLedger();

  const diffRow = mk("div", "setup-row");
  diffRow.appendChild(mk("span", "setup-label", "Bracket"));
  diffRow.appendChild(optionGroup(standingsDifficulty, DIFFICULTY_OPTIONS, key => { standingsDifficulty = key; refreshCompView(); }));
  container.appendChild(diffRow);
  container.appendChild(mk("p", "setup-hint",
    "Each difficulty is its own bracket (D2) — ratings are never blended across them."));

  const standings = standingsFor(activeLedger, standingsDifficulty);
  if (standings.length === 0) {
    container.appendChild(mk("p", "setup-hint", "Nobody has played a rated match at this difficulty yet."));
    return;
  }

  const wrap = mk("div", "comp-table-wrap");
  const table = document.createElement("table");
  table.className = "comp-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["#", "Name", "Rating", "Games", "W-L-D", "Avg Margin"].forEach(h => headRow.appendChild(mk("th", null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  shapeStandingsTable(standings).forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.appendChild(mk("td", null, String(i + 1)));
    const nameTd = mk("td", null, row.name);
    if (row.provisional) nameTd.appendChild(mk("span", "comp-provisional-badge", "provisional"));
    tr.appendChild(nameTd);
    [row.rating, row.games, row.record, row.avgMargin].forEach(v => tr.appendChild(mk("td", null, String(v))));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

/* ---------- entry point, called from setup.js's renderMapSelect() ---------- */

export function renderCompetition() {
  if (!mapSelectEl) return;   // import-safe under Node (CONTRIBUTING: follow the dom.js idiom)
  // Lazy defaults (see compConfig's own comment on why these can't just be the initializers above):
  // by the time a real render happens, module evaluation is long finished either way.
  if (compConfig.worlds.length === 0) compConfig.worlds = [MAP_CHOICES[0]];
  if (tourneyConfig.worlds.length === 0) tourneyConfig.worlds = [MAP_CHOICES[0]];
  if (tourneyConfig.difficulty == null) tourneyConfig.difficulty = compConfig.difficulty;
  if (standingsDifficulty == null) standingsDifficulty = compConfig.difficulty;
  wrapEl = mk("div", "comp-screen");
  mapSelectEl.appendChild(wrapEl);
  refreshCompView();
}
