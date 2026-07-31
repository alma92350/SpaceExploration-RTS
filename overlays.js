/* ============================================================
   The small non-panel UI chrome: the seed + faction chips, the one-time
   objectives strip, and the controls/help overlay. Each self-wires its own
   click/keydown listeners at import time (referencing only its DOM handles and
   its own functions); the initial buildHelpOverlay() kickoff is called by
   main.js. boot.js calls showSeedChip / showFactionChip / showObjectives /
   hideObjectives when a game boots.
   ============================================================ */

"use strict";

import { seedChipEl, factionChipEl, objectivesEl, helpOverlayEl, helpBtn, gameOverEl, galaxyToastEl, uiHintEl } from "./dom.js";
import { FACTIONS } from "./engine/factions.js";
import { UNITS, committedDoctrine } from "./engine/entities.js";
import { game } from "./session.js";
import { scoreBreakdown, playerScore } from "./engine/victory.js";
import { pauseLoop, resumeLoop, togglePause } from "./boot.js";   // runtime-only calls; the boot↔overlays cycle resolves via live bindings
import * as sound from "./sound.js";

/* ---------- seed chip ---------- */

export function showSeedChip(seed) {
  seedChipEl.textContent = `Seed ${seed}`;
  seedChipEl.dataset.seed = String(seed);
  seedChipEl.classList.remove("hidden");
}

// "You: Frontier ⚔ Miners" — your faction vs the opponent's. Hidden for a
// neutral-vs-neutral match (a bare state with no factions picked).
export function showFactionChip(st) {
  const you = FACTIONS[st.players.player.faction], foe = FACTIONS[st.players.ai.faction];
  if (!you || you.id === "neutral") { factionChipEl.classList.add("hidden"); return; }
  factionChipEl.textContent = `You: ${you.short} ⚔ ${foe && foe.id !== "neutral" ? foe.short : "Foe"}`;
  factionChipEl.title = `You — ${you.name}: ${you.blurb}` + (foe && foe.id !== "neutral" ? `\nFoe — ${foe.name}: ${foe.blurb}` : "");
  factionChipEl.classList.remove("hidden");
}

if (seedChipEl) seedChipEl.addEventListener("click", () => {
  const s = seedChipEl.dataset.seed;
  if (s && navigator.clipboard) navigator.clipboard.writeText(s).catch(() => {});
  seedChipEl.classList.add("copied");
  setTimeout(() => seedChipEl.classList.remove("copied"), 900);
});

/* ---------- objectives checklist ---------- */

// The reactive opening checklist (docs/improvement-proposals.md "Reactive opening checklist
// replacing the static objectives strip"): a small per-mode predicate table, walked fresh every
// time the strip (re)paints. Each predicate reads (state, galaxy) and returns a boolean — a pure
// state read, so re-evaluating the whole table every HUD tick (updateObjectives, below) is always
// safe, and cheap: a handful of Map iterations, the same cost hud.js's own idle-worker counter
// already pays every tick. `text` is a function too, so the one dynamic item (the worker count)
// can report a live "n/8" instead of freezing at whatever it read on mount.
const WORKER_TARGET = 8;
const COMBAT_TARGET = 5;

function countUnits(state, owner, pred) {
  let n = 0;
  for (const u of state.units.values()) if (u.owner === owner && pred(UNITS[u.type])) n++;
  return n;
}
function hasBuilding(state, owner, type) {
  for (const b of state.buildings.values()) if (b.owner === owner && b.type === type && !b.constructing) return true;
  return false;
}

const SKIRMISH_OBJECTIVES = [
  {
    text: state => `Train Workers (${Math.min(countUnits(state, "player", d => d?.role === "worker"), WORKER_TARGET)}/${WORKER_TARGET})`,
    done: state => countUnits(state, "player", d => d?.role === "worker") >= WORKER_TARGET,
  },
  { text: () => "Build a Barracks", done: state => hasBuilding(state, "player", "barracks") },
  { text: () => `Field ${COMBAT_TARGET} combat units`, done: state => countUnits(state, "player", d => d?.role === "combat") >= COMBAT_TARGET },
  { text: () => "Pick a doctrine at the Refinery", done: state => !!committedDoctrine(state, "player") },
  { text: () => "Raise a Habitat before the supply cap", done: state => hasBuilding(state, "player", "habitat") },
];

const ODYSSEY_OBJECTIVES = [
  { text: () => "Deploy the colony ship", done: state => hasBuilding(state, "player", "command") },
  { text: () => "Build a Market", done: state => hasBuilding(state, "player", "market") },
  { text: () => "Reactor → Smelter", done: state => hasBuilding(state, "player", "reactor") && hasBuilding(state, "player", "smelter") },
  { text: () => "Build a Datacenter", done: state => hasBuilding(state, "player", "datacenter") },
];

const SKIRMISH_GOAL = "Objective — destroy every enemy Command Center.";
const ODYSSEY_GOAL = "Odyssey — build an economy and win the galaxy.";

// `galaxy` is a truthy/falsy MODE signal here — the same way hud.js's own renderHUD already
// branches Odyssey-only readouts on `game.galaxy` rather than state.endless — not (yet) consulted
// for its own fields, since every predicate above is a per-planet state read.
function objectiveItems(state, galaxy) {
  const table = galaxy ? ODYSSEY_OBJECTIVES : SKIRMISH_OBJECTIVES;
  return table.map(item => ({ text: item.text(state), done: !!item.done(state, galaxy) }));
}
const sigOf = it => `${it.done ? 1 : 0}:${it.text}`;

// "Has this player already finished THIS mode's checklist in some earlier game?" — a UI-layer-only
// localStorage flag (engine/persist.js never sees it), keyed per mode since skirmish and Odyssey
// teach entirely different opening moves — finishing one shouldn't hide the other's first showing.
// Guarded like every other browser-only read in this file, so importing this module under Node
// (no `localStorage` global) never throws; storage being disabled/unavailable just means the strip
// shows every time, same as a player who's never finished it.
function objectivesDoneKey(galaxy) { return `sfObjectivesDone:${galaxy ? "odyssey" : "skirmish"}`; }
function objectivesFinishedBefore(galaxy) {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(objectivesDoneKey(galaxy)) === "1"; }
  catch { return false; }
}
function markObjectivesFinished(galaxy) {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(objectivesDoneKey(galaxy), "1"); }
  catch { /* storage unavailable (private browsing, some embeds) — nothing to persist, harmless */ }
}

// One checklist row: a check glyph (blank until done) + its live label. `flash` marks a row that
// just flipped to done THIS repaint (style.css .obj-row.flash), distinct from a row that was
// already done as of the last repaint.
function objectiveRow(item, flash) {
  const row = document.createElement("div");
  row.className = "obj-row" + (item.done ? " done" : "") + (flash ? " flash" : "");
  const check = document.createElement("span");
  check.className = "obj-check";
  check.textContent = item.done ? "✓" : "";
  const text = document.createElement("span");
  text.className = "obj-text";
  text.textContent = item.text;
  row.appendChild(check);
  row.appendChild(text);
  return row;
}

// The full (re)build of the strip's contents: goal line, every item row, the dismiss button. Built
// with createElement/appendChild (like showGameOver/showScenarioEnd below), not a raw innerHTML
// template, so wiring the dismiss button needs no querySelector round-trip.
function paintObjectives(galaxy, items, flashed) {
  objectivesEl.innerHTML = "";
  const goal = document.createElement("span");
  goal.className = "obj-goal";
  goal.textContent = galaxy ? ODYSSEY_GOAL : SKIRMISH_GOAL;
  objectivesEl.appendChild(goal);

  const list = document.createElement("div");
  list.className = "obj-list";
  items.forEach((item, i) => list.appendChild(objectiveRow(item, flashed[i])));
  objectivesEl.appendChild(list);

  const close = document.createElement("button");
  close.className = "obj-close";
  close.title = "Dismiss";
  close.ariaLabel = "Dismiss";
  close.textContent = "×";
  close.addEventListener("click", hideObjectives);
  objectivesEl.appendChild(close);

  objectivesEl.classList.remove("hidden");
}

// The last-painted signature (each item's done flag + its live label) and per-item done[] flags —
// together they let updateObjectives skip a repaint when nothing visible changed, and tell a row
// that just flipped to done apart from one that was already done as of the previous paint.
let lastObjSig = null;
let lastObjDone = null;

// Computes the current checklist for `state`/`galaxy` and paints it fresh — used both for the
// initial mount (showObjectives) and by any caller that wants the live item list (e.g. a test).
// Returns the computed items. If every item is ALREADY satisfied (e.g. this mode's tutorial was
// somehow finished before the strip ever got a chance to show), it retires itself immediately
// instead of mounting a fully-checked list that would otherwise never go away on its own.
export function renderObjectives(state, galaxy) {
  const items = objectiveItems(state, galaxy);
  if (items.every(it => it.done)) { markObjectivesFinished(galaxy); hideObjectives(); return items; }
  paintObjectives(galaxy, items, items.map(() => false));
  lastObjSig = items.map(sigOf).join("|");
  lastObjDone = items.map(it => it.done);
  return items;
}

// A one-time checklist at match start: a live, reactive to-do list (see renderObjectives above)
// instead of one static sentence that used to auto-dismiss after 30s whether or not the player had
// actually done anything. `endless` is accepted only for call-site compatibility with boot.js's
// existing `showObjectives(state.endless)` — by the time bootState calls this, game.state/
// game.galaxy are already the freshly-booted values, so the live pair is read straight off the
// session instead of re-deriving mode from a lone boolean.
export function showObjectives(endless = false) {
  const state = game.state;
  // The scenario bar already states a scripted mission's own objective/clock/budget; these
  // predicates (Barracks, doctrine, supply…) describe a base economy a scenario doesn't have.
  if (!state || state.scenario) return;
  if (objectivesFinishedBefore(game.galaxy)) return;   // a returning player who's already finished THIS mode's checklist doesn't need it again
  renderObjectives(state, game.galaxy);
}
export function hideObjectives() {
  objectivesEl.classList.add("hidden");
}

// Called every HUD tick (hud.js renderHUD, ~150ms cadence) to keep the checklist reactive. Cheap
// on the overwhelming majority of ticks: bails immediately when there's no strip currently shown,
// and otherwise a signature guard — each item's done flag plus its live label (e.g. "Train Workers
// (4/8)") — skips the repaint unless something a player would actually SEE has changed, the same
// guard idiom hud.js's own renderHUD uses for the resource topbar (lastTopbarSignature). Retires
// the strip itself, and remembers the completion, the moment every item is done — rather than
// waiting on the player to notice and dismiss it.
export function updateObjectives(game) {
  const state = game.state;
  if (!state || state.scenario) return;
  if (objectivesEl.classList.contains("hidden")) return;
  const galaxy = game.galaxy;
  const items = objectiveItems(state, galaxy);
  const sig = items.map(sigOf).join("|");
  if (sig === lastObjSig) return;

  const flashed = items.map((it, i) => it.done && !(lastObjDone && lastObjDone[i]));
  lastObjSig = sig;
  lastObjDone = items.map(it => it.done);

  if (items.every(it => it.done)) { markObjectivesFinished(galaxy); hideObjectives(); return; }
  paintObjectives(galaxy, items, flashed);
}

/* ---------- galaxy toast (Odyssey background-colony alerts) ---------- */

// A brief top-center notice for things happening on a world you're not on — a colony under
// attack or lost, a milestone, a relief ship (boot.js drives these). #galaxyToast is a STACK:
// up to MAX_TOASTS live at once, each with its own timer + onclick, so a routine alert can no
// longer silently overwrite a one-shot clickable one (the old single-slot behaviour lost the
// "colony has fallen — click to retake" click target for good). An optional onClick makes a
// toast actionable (jump to the world); clicking runs it and dismisses that toast, and a
// clickable alert lingers a little longer. Eviction rule at cap: drop the oldest NON-clickable
// toast; a plain toast never pushes out a clickable one (if it would have to, the plain one is
// dropped instead — it's non-critical). Same signature, so every caller is unchanged.
const MAX_TOASTS = 3;
export function showGalaxyToast(msg, kind = "warn", onClick = null) {
  const stack = galaxyToastEl;
  stack.className = "galaxy-toast-stack";   // #galaxyToast is the container; toasts are its children
  stack.classList.remove("hidden");
  const clickable = !!onClick;

  if (stack.children.length >= MAX_TOASTS) {
    const evict = [...stack.children].find(c => !c._clickable);
    if (evict) { clearTimeout(evict._timer); evict.remove(); }
    else if (!clickable) return null;                     // full of clickable alerts; don't sacrifice one for a plain toast
    else { const oldest = stack.firstElementChild; clearTimeout(oldest._timer); oldest.remove(); }
  }

  const el = document.createElement("div");
  el.className = "galaxy-toast " + kind + (clickable ? " clickable" : "");
  el.textContent = msg;
  el._clickable = clickable;
  const remove = () => { clearTimeout(el._timer); el.remove(); if (!stack.children.length) stack.classList.add("hidden"); };
  if (clickable) el.onclick = () => { remove(); onClick(); };
  el._timer = setTimeout(remove, clickable ? 8000 : 5000);
  stack.appendChild(el);
  return el;
}

/* ---------- transient UI hint ---------- */

// A brief, single-slot bottom-center hint for immediate button feedback — chiefly the touch
// "why is this greyed" tip (hud.js makeButton). Deliberately SEPARATE from the galaxy-toast
// stack: that channel is capacity-limited and protects clickable colony alerts, so routing
// button feedback through it could let a full stack of alerts swallow the tip. This one is
// user-initiated and always shows (a new hint just replaces the last).
let uiHintTimer;
export function flashHint(msg) {
  uiHintEl.textContent = msg;
  uiHintEl.classList.remove("hidden");
  clearTimeout(uiHintTimer);
  uiHintTimer = setTimeout(() => uiHintEl.classList.add("hidden"), 2600);
}

/* ---------- help overlay ---------- */

// A persistent hotkey reference, openable at ANY time (unlike the selection-panel
// legend, which is only there when nothing is selected).
const HELP_ROWS = [
  ["Left-drag", "Select units · Ctrl+drag adds to selection · Alt+drag subtracts from it"],
  ["Right-click", "Move · attack an enemy · gather a node"],
  ["Right-click and drag", "…the drag direction also becomes the group's (or a lone unit's) facing"],
  ["A, then click", "Attack-move — advance and engage on the way"],
  ["Ctrl+right-click", "Queue a waypoint (chain a path)"],
  ["1–9 / Shift+1–9", "Recall / bind a control group"],
  ["Double-click", "Select every unit of that type on screen"],
  ["Ctrl+double-click", "Select every unit of that type across the WHOLE map, not just what's on screen"],
  ["Q · E · X", "Select army · Ranger scout mode · stop"],
  ["H", "Hold position — fire in range, don't chase"],
  ["R", "Patrol — loop the current waypoint chain, engaging anything met along the way"],
  ["F", "Form up — hold the chosen formation shape right here"],
  ["Z C V B N", "Produce / build the selected panel's Nth option"],
  ["`", "Jump to the next idle worker"],
  ["Space", "Jump the camera to your base — press again quickly to cycle through every base"],
  ["Backspace", "Jump to the last under-attack alert"],
  ["P", "Pause / resume"],
  ["M", "Odyssey — open the galaxy map"],
  ["Right-click a node", "(building selected) rally new workers to mine it"],
  ["Minimap", "Left-click to jump · right-click to order"],
  ["Wheel · arrows · edge", "Zoom · pan the camera"],
  ["Esc", "Cancel build placement or a pending attack-move"],
  ["F1 or ?", "Toggle this help"],
];
// The finger-only control scheme (see input.js's touch handlers).
const TOUCH_HELP_ROWS = [
  ["Tap your unit", "Select it · double-tap grabs all of that type on screen"],
  ["Tap elsewhere", "Order the selection — move · tap a foe to attack · tap a node to gather"],
  ["One-finger drag", "Box-select your units"],
  ["Two fingers", "Drag to pan · pinch to zoom"],
  ["Attack-Move button", "Arm it, then tap the map to advance-and-engage"],
  ["Tap a node (building selected)", "Rally new workers to mine it"],
  ["Minimap", "Tap to jump the view"],
];
function helpRows(rows) {
  return rows.map(([k, v]) =>
    `<div class="help-row"><span class="help-key">${k}</span><span>${v}</span></div>`).join("");
}
export function buildHelpOverlay() {
  helpOverlayEl.innerHTML = `<div class="help-card"><h2>Controls &amp; Help</h2>`
    + `<h3 class="help-sub">Mouse &amp; keyboard</h3>${helpRows(HELP_ROWS)}`
    + `<h3 class="help-sub">Touch</h3>${helpRows(TOUCH_HELP_ROWS)}`
    + `<p class="help-dismiss">Press F1, ?, or Esc to close</p></div>`;
}

function toggleHelp(force) {
  const show = force ?? helpOverlayEl.classList.contains("hidden");
  helpOverlayEl.classList.toggle("hidden", !show);
  if (show) pauseLoop("help"); else resumeLoop("help");   // the sim holds while the reference is open
}
// Browser-only wiring: the help toggle button + the global F1/?/Esc/P hotkeys. Guarded so this
// module imports cleanly under Node (where the elements are null and `window` doesn't exist).
if (typeof window !== "undefined") {
  helpBtn.addEventListener("click", () => toggleHelp());
  helpOverlayEl.addEventListener("click", () => toggleHelp(false));
  window.addEventListener("keydown", e => {
    if (e.key === "F1" || e.key === "?") { e.preventDefault(); toggleHelp(); }
    else if (e.key === "Escape" && !helpOverlayEl.classList.contains("hidden")) toggleHelp(false);
    else if ((e.key === "p" || e.key === "P") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); togglePause(); }
  });
}

/* ---------- game-over overlay ---------- */

// Skirmish/scenario copy, keyed by engine/victory.js's state.winReason — so this screen stops
// always claiming a conquest that may not have happened (docs/improvement-proposals.md "Make the
// clock endgame visible, honest, and configurable"). A missing/unrecognised reason (an older save
// resuming into a game-over some other way, or any caller that predates this field) falls back to
// the original conquest copy below, unchanged.
const WIN_REASON_COPY = {
  elimination: {
    player: "Victory — the enemy's last Command Center is destroyed.",
    ai: "Defeat — your last Command Center was destroyed.",
  },
  "mutual-wipe-score": {
    player: "Victory — both sides' last Command Centers fell, and you held the higher score.",
    ai: "Defeat — both sides' last Command Centers fell, and the enemy held the higher score.",
  },
  "timeout-score": {
    player: "Victory — the match went the distance, and you held the higher score at the bell.",
    ai: "Defeat — the match went the distance, and the enemy held the higher score at the bell.",
  },
};

// The end-of-match overlay: a terminal overlay like the objectives/help ones, so
// it lives here rather than with the live HUD readouts (it shares no code with
// them). Param-driven — the seed and the restart action are passed in, so this
// module needs neither the session nor setup.js (onRestart re-opens map-select).
// opts.winReason + opts.state (engine/victory.js's state.winReason, and the state itself for the
// score breakdown below) are optional: an Odyssey game-over never sets either, and a caller that
// predates this feature simply gets the old conquest-copy default.
export function showGameOver(winner, seed, onRestart, opts = {}) {
  if (winner === "player") sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  // The Odyssey is a play-forever sandbox — it never ends in defeat, only by surrender (a
  // wipeout sends a relief colony ship instead). So an Odyssey game-over is always a surrender.
  // Skirmish/scenario keep the win-or-lose copy, now branched on WHY it ended.
  const msg = document.createElement("div");
  msg.textContent = opts.odyssey
    ? (opts.surrendered
        ? "Surrendered — you lay down your flag. The frontier falls quiet."
        : "The Odyssey has ended.")
    : (WIN_REASON_COPY[opts.winReason]?.[winner]
        ?? (winner === "player"
            ? "Victory — the enemy's last Command Center is destroyed."
            : "Defeat — your last Command Center was destroyed."));
  gameOverEl.appendChild(msg);

  // A SCORE decision (as opposed to conquest) gets a small breakdown — same "gameover-seed" div
  // idiom showScenarioEnd's own BREAKDOWNS use below — so "why did the clock decide this" is
  // answerable on screen, not just asserted. Conquest (winReason "elimination") shows none: the
  // score math had nothing to do with that outcome. Shown from the human player's own numbers,
  // alongside the enemy's final score for direct comparison.
  if (!opts.odyssey && opts.state && (opts.winReason === "mutual-wipe-score" || opts.winReason === "timeout-score")) {
    const bd = scoreBreakdown(opts.state, "player");
    const enemyScore = playerScore(opts.state, "ai");
    const breakdown = document.createElement("div");
    breakdown.className = "gameover-seed";
    breakdown.innerHTML = `Bank (×0.25): ${Math.round(bd.bank)} · Army (×1.35): ${Math.round(bd.army)} · Structures: ${Math.round(bd.structures)}`
      + `<br>Your score: <b>${Math.round(bd.total)}</b> · Enemy score: <b>${Math.round(enemyScore)}</b>`;
    gameOverEl.appendChild(breakdown);
  }

  if (seed != null) {
    const seedLine = document.createElement("div");
    seedLine.className = "gameover-seed";
    seedLine.textContent = `Seed ${seed} — enter it on the setup screen to replay this map.`;
    gameOverEl.appendChild(seedLine);
  }

  const again = document.createElement("button");
  again.className = "btn";
  again.style.width = "auto";
  again.style.padding = "10px 20px";
  again.style.marginTop = "16px";
  again.textContent = "Choose another battlefield";
  again.addEventListener("click", () => {
    gameOverEl.classList.add("hidden");
    onRestart();
  });
  gameOverEl.appendChild(again);
}

// The mission-end screen for a scenario (engine/scenarios.js) — its own screen
// rather than showGameOver, because it reports the objective + a score breakdown.
export function showScenarioEnd(state, onRestart) {
  const sc = state.scenario;
  if (sc.outcome === "win") sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  const win = sc.outcome === "win";
  const TITLES = {
    raider: win ? "Raid Successful" : "Convoy Escaped",
    bounty: win ? "Bounties Claimed" : "Quota Not Met",
    escort: win ? "Convoy Delivered" : "Convoy Lost",
  };
  const title = document.createElement("div");
  title.textContent = TITLES[sc.type] || TITLES.escort;
  gameOverEl.appendChild(title);

  const banner = document.createElement("div");
  banner.className = "gameover-seed";
  banner.textContent = sc.banner;
  gameOverEl.appendChild(banner);

  const BREAKDOWNS = {
    raider: `Freighters sunk: ${sc.destroyed}/${sc.freightersTotal} (quota ${sc.targetKills}) · Escorts destroyed: ${sc.escortsKilled}`
      + ` · Raiders surviving: ${sc.survivors}<br>Final score: <b>${sc.score}</b>`,
    bounty: `Camps cleared: ${sc.packsCleared}/${sc.totalPacks} (quota ${sc.targetPacks}) · Bounty banked: 💰 ${sc.bounty}`
      + ` · Posse surviving: ${sc.survivors}<br>Final score: <b>${sc.score}</b>`,
    escort: `Freighters delivered: ${sc.delivered}/${sc.freightersTotal} · Legs cleared: ${sc.legsDone}`
      + ` · Budget left: ${Math.round(sc.budget)}<br>Final score: <b>${sc.score}</b>`,
  };
  const breakdown = document.createElement("div");
  breakdown.className = "gameover-seed";
  breakdown.innerHTML = BREAKDOWNS[sc.type] || BREAKDOWNS.escort;
  gameOverEl.appendChild(breakdown);

  const again = document.createElement("button");
  again.className = "btn";
  again.style.width = "auto";
  again.style.padding = "10px 20px";
  again.style.marginTop = "16px";
  again.textContent = "Back to menu";
  again.addEventListener("click", () => {
    gameOverEl.classList.add("hidden");
    onRestart();
  });
  gameOverEl.appendChild(again);
}
