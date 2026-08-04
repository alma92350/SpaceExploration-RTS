/* ============================================================
   Observer Mode's UI: the topbar toggle button, the "you're spectating X" banner, and the
   live stats panel (archetype, stance, army, development, economy) for whichever world
   observer.js's observedState() currently points at. Pure view over observer.js's
   observerStats() — rebuilt every call, same idiom as starmap.js's renderStarmap.

   Self-wired like the other overlay buttons (starmapBtn/techChartBtn): the topbar button
   toggles Observer Mode directly, this module never needs to be told to do so.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { observerBtn, observerBannerEl, observerPanelEl } from "./dom.js";
import { observedState, observerStats, toggleObserverMode } from "./observer.js";
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

function renderPanelBody(state) {
  const s = observerStats(state);
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

export function renderObserverPanel() {
  observerBtn.classList.toggle("hidden", !game.galaxy);
  if (!game.observerMode) {
    observerBannerEl.classList.add("hidden");
    observerPanelEl.classList.add("hidden");
    return;
  }
  const state = observedState();
  if (!state) return;

  observerBannerEl.classList.remove("hidden");
  observerBannerEl.textContent =
    `🔭 OBSERVING ${worldName(state.planetId)} — Space: cycle bases · Galaxy map: jump anywhere · O/Esc: exit`;

  observerPanelEl.classList.remove("hidden");
  renderPanelBody(state);
}

if (observerBtn) observerBtn.addEventListener("click", () => { toggleObserverMode(); renderObserverPanel(); });
