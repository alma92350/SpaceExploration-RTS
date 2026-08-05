/* ============================================================
   The Quick Duel screen (docs/competitions-and-elo.md Phase 1's "thinnest end-to-end slice": two
   AI entrants, a real match, a real rating change). Pits two independently-configured AI entrants
   against each other, side-swapped across every world x seed the player picks, off the main
   thread in competitionWorker.js — never a playable game. This mode never touches boot.js,
   game.state, the canvas, or the HUD: a Quick Duel runs a background simulation and shows a
   results screen, nothing else.

   Split the SAME way observer.js splits observerStats() (pure) from observerPanel.js's rendering
   consumer, and CONTRIBUTING.md's own C10 rule ("UI modules should stay import-safe under Node,
   guard top-level window/document access"): everything above "DOM RENDERING" below is pure —
   job construction, per-match seed derivation (reusing tools/duelCore.js's own duelSeed, never
   reimplementing its hash), worker-row -> display-table shaping, and Elo — directly unit-testable
   under Node with no DOM and no Worker (test/competition.test.js). Everything below it touches
   `document`/`mapSelectEl` and is guarded the same way setup.js's own renderMapSelect() is.

   Wired in from setup.js's renderMapSelect(): a `setup.mode === "competition"` branch delegates
   to renderCompetition() below and returns, mirroring how that function's existing `if (odyssey)`
   branch already short-circuits for Odyssey's own different layout. That import (setup.js's
   STRATEGY_OPTIONS/optionGroup/MAP_CHOICES, reused rather than redefined here) plus setup.js's own
   import of renderCompetition together form a two-file cycle — already true of setup.js and
   boot.js/hud.js/hudSelection.js/overlays.js/saveload.js today (test/static-integrity.test.js's
   "known UI cluster"), so competition.js joins that same documented cluster rather than opening a
   new one; see that test's own KNOWN list for the accompanying note.

   FAIRNESS carries over from tools/ailab.js/tools/duelCore.js unchanged: ONE shared Difficulty
   pick for the whole duel, never two (see competitionWorker.js's own header). Faction is
   deliberately NOT offered here — a duel's dial set is archetype/strategy/difficulty
   (tools/selfplay.js's createSelfPlayState takes no faction option at all), so a Faction picker
   would be cosmetic in a way that could misleadingly imply a gameplay effect it doesn't have.

   Phase 1 has no persistent ledger yet (docs/competitions-and-elo.md D8 is Phase 2) — every Elo
   number here starts fresh at elo.js's INITIAL_RATING and is folded in from THIS duel's rows
   alone, discarded the moment the player leaves. The results view says so in one visible line;
   never let it read like a saved rating.
   ============================================================ */

"use strict";

import { mapSelectEl } from "./dom.js";
import { STRATEGY_OPTIONS, optionGroup, MAP_CHOICES, setup, renderMapSelect } from "./setup.js";
import { DIFFICULTY_OPTIONS } from "./engine/aiDifficulty.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { planetName } from "./data.js";
import { duelSeed } from "./tools/duelCore.js";
import { INITIAL_RATING, applySeries } from "./elo.js";

/* ============================================================
   PURE — job construction, seed derivation, table/Elo shaping. No DOM, no Worker. See
   test/competition.test.js.
   ============================================================ */

/**
 * Shape a raw config (as the entrant/world/seed pickers below hold it) into exactly the job
 * message competitionWorker.js expects: `{ entrantA:{name,strategy}, entrantB:{name,strategy},
 * difficulty, worlds, seeds, seedBase, matchTimeLimit? }`. Deterministic — same input, same
 * output — so randomness (an unset seed) must already be resolved by the CALLER before this runs
 * (mirrors boot.js's own resolveSeed(setup): random-vs-fixed is a DOM-layer decision, this stays
 * pure). Throws a clear, user-facing message for anything that would make competitionWorker.js's
 * own guards throw anyway — an empty name or an empty world list — so the config screen can catch
 * it before ever spinning up a Worker.
 * @param {{ entrantA: {name: string, strategy?: string}, entrantB: {name: string, strategy?: string},
 *   difficulty: string, worlds: string[], seeds: number, seedBase: number, matchTimeLimit?: number }} cfg
 */
export function buildJob({ entrantA, entrantB, difficulty, worlds, seeds, seedBase, matchTimeLimit } = {}) {
  if (!entrantA || !entrantA.name || !entrantA.name.trim()) throw new Error("Entrant A needs a name");
  if (!entrantB || !entrantB.name || !entrantB.name.trim()) throw new Error("Entrant B needs a name");
  if (!Array.isArray(worlds) || worlds.length === 0) throw new Error("Pick at least one world");
  const job = {
    entrantA: { name: entrantA.name.trim(), strategy: entrantA.strategy || "default" },
    entrantB: { name: entrantB.name.trim(), strategy: entrantB.strategy || "default" },
    difficulty: difficulty || "medium",
    worlds: [...worlds],
    seeds: Math.max(1, Math.floor(seeds) || 1),
    seedBase: (Number(seedBase) || 0) >>> 0,
  };
  if (matchTimeLimit) job.matchTimeLimit = matchTimeLimit;
  return job;
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
  entrantA: { name: "Entrant A", strategy: "default" },
  entrantB: { name: "Entrant B", strategy: "default" },
  difficulty: "medium",
  worlds: [],
  seeds: 1,
  seedText: "",   // blank = random, same convention as setup.js's own Seed row
};

let compView = "config";     // "config" | "progress" | "results"
let compError = null;        // a validation/run error, shown in the config view
let activeWorker = null;
let activeJob = null;        // the job the current/last worker run was built from
let progress = { completed: 0, total: 0 };
let lastDone = null;         // the last {type:"done", rows, aWins, bWins, draws} message
let wrapEl = null;           // the one div this module owns inside mapSelectEl

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
  return entry.games < 10 ? `${Math.round(entry.rating)}?` : String(Math.round(entry.rating));
}

function goBack() {
  if (activeWorker) { activeWorker.terminate(); activeWorker = null; }
  compView = "config";
  compError = null;
  setup.mode = "skirmish";
  renderMapSelect();
}

function refreshCompView() {
  if (!wrapEl) return;
  wrapEl.innerHTML = "";
  const backBtn = mk("button", "btn comp-back-btn", "← Back to Menu");
  backBtn.type = "button";
  backBtn.addEventListener("click", goBack);
  wrapEl.appendChild(backBtn);

  if (compView === "progress") renderProgressView(wrapEl);
  else if (compView === "results") renderResultsView(wrapEl);
  else renderConfigView(wrapEl);
}

/* ---------- config view ---------- */

function renderEntrantCard(container, key, label) {
  const entrant = compConfig[key];
  const card = mk("div", "comp-entrant");
  card.appendChild(mk("h4", "comp-entrant-heading", label));

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

  container.appendChild(card);
}

function renderWorldPicker(container) {
  container.appendChild(mk("p", "setup-hint",
    "Worlds — pick one or more. Every world × every seed below runs BOTH directions, side-swapped."));
  const wrap = mk("div", "opt-group comp-worlds");
  MAP_CHOICES.forEach(id => {
    const selected = compConfig.worlds.includes(id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn" + (selected ? " active" : "");
    btn.appendChild(mk("span", "opt-label", planetName(id)));
    btn.appendChild(mk("span", "opt-note", archetypeFor(id).name));
    btn.addEventListener("click", () => {
      compConfig.worlds = compConfig.worlds.includes(id)
        ? compConfig.worlds.filter(w => w !== id)
        : [...compConfig.worlds, id];
      refreshCompView();
    });
    wrap.appendChild(btn);
  });
  container.appendChild(wrap);
}

function renderConfigView(container) {
  container.appendChild(mk("p", "setup-hint comp-intro",
    "Pick two AI configurations and watch them fight, side-swapped across every world × seed you " +
    "choose. Runs entirely in the background — no player economy, no canvas — then reports a " +
    "per-match table and a one-off Elo rating for this duel alone."));

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

  renderWorldPicker(container);

  const seedsRow = mk("div", "setup-row");
  seedsRow.appendChild(mk("span", "setup-label", "Seeds / world"));
  const seedsInput = document.createElement("input");
  seedsInput.type = "number";
  seedsInput.min = "1";
  seedsInput.max = "10";
  seedsInput.className = "comp-seeds-input";
  seedsInput.value = String(compConfig.seeds);
  seedsInput.addEventListener("change", () => {
    compConfig.seeds = Math.max(1, Math.floor(Number(seedsInput.value)) || 1);
    refreshCompView();
  });
  seedsRow.appendChild(seedsInput);
  container.appendChild(seedsRow);

  const seedRow = mk("div", "setup-row");
  seedRow.appendChild(mk("span", "setup-label", "Seed"));
  const seedInput = document.createElement("input");
  seedInput.type = "text";
  seedInput.inputMode = "numeric";
  seedInput.className = "seed-input";
  seedInput.placeholder = "random";
  seedInput.value = compConfig.seedText;
  seedInput.addEventListener("input", () => { compConfig.seedText = seedInput.value; });
  seedRow.appendChild(seedInput);
  container.appendChild(seedRow);

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

function eloCard(name, entry) {
  const card = mk("div", "comp-elo-card");
  const delta = Math.round(entry.rating) - INITIAL_RATING;
  card.appendChild(mk("span", "comp-elo-name", name));
  card.appendChild(mk("span", "comp-elo-value", `${formatElo(entry)} (${delta > 0 ? "+" : ""}${delta})`));
  card.appendChild(mk("span", "comp-elo-games", `${entry.games} game${entry.games === 1 ? "" : "s"}${entry.games < 10 ? " — provisional" : ""}`));
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
  const ratings = eloFromRows(rows);
  const aEntry = ratings[aName] || { rating: INITIAL_RATING, games: 0 };
  const bEntry = ratings[bName] || { rating: INITIAL_RATING, games: 0 };

  container.appendChild(mk("h3", "cards-heading", `${aName} vs ${bName} — ${aWins}-${bWins}-${draws} (W-L-D)`));
  container.appendChild(mk("p", "comp-note",
    "Elo shown is for this duel only and isn't saved — a persistent ladder is coming in a later update."));

  const eloRow = mk("div", "comp-elo-row");
  eloRow.appendChild(eloCard(aName, aEntry));
  eloRow.appendChild(eloCard(bName, bEntry));
  container.appendChild(eloRow);

  const tableWrap = mk("div", "comp-table-wrap");
  tableWrap.appendChild(buildResultsTable(rows));
  container.appendChild(tableWrap);

  const actions = mk("div", "comp-actions");
  const again = mk("button", "btn", "Run Another Duel");
  again.type = "button";
  again.addEventListener("click", () => { compView = "config"; refreshCompView(); });
  actions.appendChild(again);
  container.appendChild(actions);
}

/* ---------- run ---------- */

function startDuel() {
  compError = null;
  let job;
  try {
    job = buildJob({
      entrantA: compConfig.entrantA,
      entrantB: compConfig.entrantB,
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

  activeJob = job;
  progress = { completed: 0, total: matchCount(job) };
  compView = "progress";
  refreshCompView();

  if (activeWorker) activeWorker.terminate();   // guard against a stray prior worker, belt-and-suspenders
  activeWorker = new Worker(new URL("./competitionWorker.js", import.meta.url), { type: "module" });
  activeWorker.onmessage = e => {
    const msg = e.data;
    if (msg.type === "progress") {
      progress = { completed: msg.completed, total: msg.total };
      if (compView === "progress") refreshCompView();
    } else if (msg.type === "done") {
      lastDone = msg;
      activeWorker = null;
      compView = "results";
      refreshCompView();
    } else if (msg.type === "error") {
      activeWorker = null;
      compError = `The duel failed to run: ${msg.message}`;
      compView = "config";
      refreshCompView();
    }
  };
  activeWorker.postMessage(job);
}

/* ---------- entry point, called from setup.js's renderMapSelect() ---------- */

export function renderCompetition() {
  if (!mapSelectEl) return;   // import-safe under Node (CONTRIBUTING: follow the dom.js idiom)
  // Lazy default (see compConfig's own comment on why this can't just be the initializer above):
  // by the time a real render happens, module evaluation is long finished either way.
  if (compConfig.worlds.length === 0) compConfig.worlds = [MAP_CHOICES[0]];
  wrapEl = mk("div", "comp-screen");
  mapSelectEl.appendChild(wrapEl);
  refreshCompView();
}
