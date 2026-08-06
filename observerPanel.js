/* ============================================================
   Observer Mode's UI: the topbar toggle button, the "you're spectating X" banner, and the
   live stats panel (archetype, stance, army, development, economy) for whichever world
   observer.js's observedState() currently points at. Pure view over observer.js's
   observerStats() — rebuilt every call, same idiom as starmap.js's renderStarmap.

   Self-wired like the other overlay buttons (starmapBtn/techChartBtn): the topbar button
   toggles Observer Mode directly, this module never needs to be told to do so.

   PHASE 5 (docs/competitions-and-elo.md) — the same UI now also serves a WATCHED AI-vs-AI
   exhibition match (game.spectateMatch), which differs from the Odyssey in three ways and is
   rendered accordingly:
     • there is no galaxy to jump around, so the banner says what's on screen and the SPECTATE BAR
       below it carries the controls a watched match needs — 1x/2x/4x/8x speed, the exhibition-only
       disclosure, and the way out;
     • both seats are named entrants, so the stats panel shows BOTH, by name, instead of "AI army"
       vs "Player forces" (which would name the human as a combatant in a match they aren't in);
     • there is no diplomacy and no neighbour, so Stance and the Odyssey development score are
       omitted rather than shown as confident numbers — see observerStats' own comment.
   The Leave button calls the callback the launcher parked on game.spectateMatch.onLeave rather
   than importing boot.js/competition.js: boot.js already imports THIS module, so importing back
   would grow test/static-integrity.test.js's documented UI cycle by two more members.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { observerBtn, observerBannerEl, spectateBarEl, observerPanelEl } from "./dom.js";
import {
  observedState, observerStats, toggleObserverMode,
  SPECTATE_SPEEDS, setSpectateSpeed, isSpectatingMatch,
} from "./observer.js";
import { planetName as worldName, LORE_FACTIONS, COM } from "./data.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";

function mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

// "skiff ×144, bastion ×143, …", biggest group first — the composition a scientist actually
// wants to read at a glance, not insertion order.
function composition(counts, table) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${table[type]?.name || type} ×${n}`)
    .join(", ") || "none";
}

// Minimize state lives as a class on observerPanelEl itself (the one stable element across
// renders — only its innerHTML gets wiped) rather than a JS variable, so it survives the
// innerHTML="" + full rebuild every renderPanelBody call below with no extra bookkeeping.
function minimizeToggleBtn() {
  const minimized = observerPanelEl.classList.contains("minimized");
  const btn = mk("button", "observer-min-btn", minimized ? "▸" : "▾");
  btn.type = "button";
  const label = minimized ? "Expand the observation panel" : "Minimize the observation panel — the stats block can cover the world you're watching";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.addEventListener("click", e => {
    e.stopPropagation();   // this button lives inside the panel; nothing above it should react to the click
    const min = observerPanelEl.classList.toggle("minimized");
    btn.textContent = min ? "▸" : "▾";
    const newLabel = min ? "Expand the observation panel" : "Minimize the observation panel — the stats block can cover the world you're watching";
    btn.title = newLabel;
    btn.setAttribute("aria-label", newLabel);
  });
  return btn;
}

// One "Label / value" row, the shape every entry in the panel below uses.
function statRow(label, value) {
  const row = mk("div", "observer-row");
  row.append(mk("span", "observer-label", label), mk("span", null, value));
  return row;
}

// A WATCHED match's panel: one block per SEAT, named after the entrant that holds it, because
// "AI army" vs "Player forces" would be two lies at once here (both seats are AI, and the human
// holds neither). Stance and the Odyssey development score are absent by construction — a
// skirmish has no diplomacy and no neighbour AI, and observerStats degrades both to null rather
// than handing this view a confident wrong number to print.
function renderSpectatePanelBody(state, s) {
  const watch = game.spectateMatch;
  // Entrant A holds owner "player", entrant B owner "ai" — competition.js's buildWatchConfig, the
  // same seating tools/duelCore.js's runDuelMatch uses for every simulated row.
  const nameFor = owner => (owner === "player" ? watch.aName : watch.bName);
  observerPanelEl.innerHTML = "";

  const head = mk("div", "observer-head");
  head.append(
    mk("span", "observer-ico", "👁"),
    mk("h3", null, `${watch.aName} vs ${watch.bName}`),
    mk("span", "observer-archetype", worldName(s.planetId)),
    minimizeToggleBtn(),
  );
  observerPanelEl.appendChild(head);

  const rows = mk("div", "observer-rows");
  s.seats.forEach(seat => {
    rows.appendChild(mk("div", "observer-seat-name", nameFor(seat.owner)));
    rows.appendChild(statRow("Army", composition(seat.units, UNITS)));
    const buildingCount = Object.values(seat.buildings).reduce((a, n) => a + n, 0);
    rows.appendChild(statRow("Buildings", `${buildingCount} — ${composition(seat.buildings, BUILDINGS)}`));
    rows.appendChild(statRow("Supply", `${seat.supplyUsed} / ${seat.supplyCap}`));
    rows.appendChild(statRow("Resources",
      Object.entries(seat.resources).map(([com, qty]) => `${COM[com]?.name || com} ${Math.floor(qty)}`).join(", ") || "none"));
  });
  observerPanelEl.appendChild(rows);
}

function renderPanelBody(state) {
  const s = observerStats(state);
  if (isSpectatingMatch()) { renderSpectatePanelBody(state, s); return; }
  observerPanelEl.innerHTML = "";

  const head = mk("div", "observer-head");
  head.append(
    mk("span", "observer-ico", LORE_FACTIONS[s.faction]?.ico || "🪐"),
    mk("h3", null, worldName(s.planetId)),
    mk("span", "observer-archetype", s.archetypeName),
    minimizeToggleBtn(),
  );
  observerPanelEl.appendChild(head);

  const rows = mk("div", "observer-rows");
  if (s.stanceLabel) {
    const stanceRow = mk("div", "observer-row");
    stanceRow.append(mk("span", "observer-label", "Stance"),
      mk("span", null, `${s.stanceLabel} (${s.stance.toFixed(2)}) · hostility ${(s.hostility * 100).toFixed(0)}%${s.pacified ? " · pacified" : ""}`));
    rows.appendChild(stanceRow);
  }
  const armyRow = mk("div", "observer-row");
  armyRow.append(mk("span", "observer-label", "AI army"), mk("span", null, composition(s.units.ai || {}, UNITS)));
  rows.appendChild(armyRow);

  if (s.units.player) {
    const playerRow = mk("div", "observer-row");
    playerRow.append(mk("span", "observer-label", "Player forces"), mk("span", null, composition(s.units.player, UNITS)));
    rows.appendChild(playerRow);
  }

  const buildRow = mk("div", "observer-row");
  const buildingCount = Object.values(s.buildings.ai || {}).reduce((a, n) => a + n, 0);
  buildRow.append(mk("span", "observer-label", "AI buildings"),
    mk("span", null, `${buildingCount} total (development score ${s.development}) — ${composition(s.buildings.ai || {}, BUILDINGS)}`));
  rows.appendChild(buildRow);

  const supplyRow = mk("div", "observer-row");
  supplyRow.append(mk("span", "observer-label", "Supply"), mk("span", null, `${s.supplyUsed} / ${s.supplyCap}`));
  rows.appendChild(supplyRow);

  const resText = Object.entries(s.resources).map(([com, qty]) => `${COM[com]?.name || com} ${Math.floor(qty)}`).join(", ") || "none";
  const resRow = mk("div", "observer-row");
  resRow.append(mk("span", "observer-label", "AI resources"), mk("span", null, resText));
  rows.appendChild(resRow);

  observerPanelEl.appendChild(rows);
}

/* ---------- the spectate bar (a watched match only) ---------- */

// Rebuilt only when something on it actually changed — this runs on the HUD's ~150ms cadence, and
// tearing down a row of buttons six times a second would make them unclickable (a click landing
// between mousedown and the next rebuild would hit a detached node) and steal focus.
let spectateBarSig = null;

function renderSpectateBar() {
  const watch = game.spectateMatch;
  if (!spectateBarEl) return;
  if (!watch || !game.observerMode) {
    spectateBarEl.classList.add("hidden");
    spectateBarSig = null;
    return;
  }
  spectateBarEl.classList.remove("hidden");
  const sig = `${watch.aName}|${watch.bName}|${game.spectateSpeed}`;
  if (sig === spectateBarSig) return;
  spectateBarSig = sig;
  spectateBarEl.innerHTML = "";

  spectateBarEl.appendChild(mk("span", "spectate-vs", `${watch.aName} vs ${watch.bName}`));

  const speeds = mk("div", "spectate-speeds");
  speeds.appendChild(mk("span", "spectate-speed-label", "Speed"));
  SPECTATE_SPEEDS.forEach(mult => {
    const btn = mk("button", "spectate-speed-btn" + (game.spectateSpeed === mult ? " active" : ""), `${mult}×`);
    btn.type = "button";
    btn.title = `Run the match at ${mult}× — the fixed simulation step is unchanged, only how many steps run per second`;
    btn.addEventListener("click", () => { setSpectateSpeed(mult); renderSpectateBar(); });
    speeds.appendChild(btn);
  });
  spectateBarEl.appendChild(speeds);

  // The exhibition disclosure, ON SCREEN for the whole match — not only on the button that started
  // it and the screen that ends it. A watched match looks exactly like a played one, so what makes
  // it different has to be visible while it's happening.
  spectateBarEl.appendChild(mk("span", "spectate-note", "Exhibition — not rated, nothing recorded"));

  if (watch.onLeave) {
    const leave = mk("button", "spectate-leave-btn", "← Leave");
    leave.type = "button";
    leave.title = "Stop watching and return to the Competition screen";
    leave.addEventListener("click", () => watch.onLeave());
    spectateBarEl.appendChild(leave);
  }
}

export function renderObserverPanel() {
  // Still an ODYSSEY-only affordance, and deliberately so now that a second thing can be observed:
  // a watched match is ALWAYS observing (boot.js enters on launch and observer.js refuses to
  // leave — see requestExitObserverMode), so a toggle there would be a button that does nothing
  // half the time and hands you an AI's army the other half. Its spectate bar carries Leave
  // instead. An ordinary skirmish shows it in neither case: that would just be a fog cheat.
  observerBtn.classList.toggle("hidden", !game.galaxy);
  if (!game.observerMode) {
    observerBannerEl.classList.add("hidden");
    observerPanelEl.classList.add("hidden");
    renderSpectateBar();
    return;
  }
  const state = observedState();
  if (!state) return;

  observerBannerEl.classList.remove("hidden");
  // Deliberately SHORT for a watched match: the spectate bar sits directly beneath this strip, so a
  // banner that wraps to a second line lands underneath it. The navigation hints the Odyssey banner
  // carries are also less needed here — there is one world, and the bar itself shows the controls.
  observerBannerEl.textContent = game.spectateMatch
    ? `👁 WATCHING ${worldName(state.planetId)} — both sides are AI, you issue no orders`
    : `🔭 OBSERVING ${worldName(state.planetId)} — Space: cycle bases · Galaxy map: jump anywhere · O/Esc: exit`;
  renderSpectateBar();

  observerPanelEl.classList.remove("hidden");
  renderPanelBody(state);
}

if (observerBtn) observerBtn.addEventListener("click", () => { toggleObserverMode(); renderObserverPanel(); });
