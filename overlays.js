/* ============================================================
   The small non-panel UI chrome: the seed + faction chips, the one-time
   objectives strip, and the controls/help overlay. Each self-wires its own
   click/keydown listeners at import time (referencing only its DOM handles and
   its own functions); the initial buildHelpOverlay() kickoff is called by
   main.js. boot.js calls showSeedChip / showFactionChip / showObjectives /
   hideObjectives when a game boots.
   ============================================================ */

"use strict";

import { seedChipEl, factionChipEl, objectivesEl, helpOverlayEl, helpBtn, gameOverEl, galaxyToastEl } from "./dom.js";
import { FACTIONS } from "./engine/factions.js";
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

seedChipEl.addEventListener("click", () => {
  const s = seedChipEl.dataset.seed;
  if (s && navigator.clipboard) navigator.clipboard.writeText(s).catch(() => {});
  seedChipEl.classList.add("copied");
  setTimeout(() => seedChipEl.classList.remove("copied"), 900);
});

/* ---------- objectives strip ---------- */

// A one-time, dismissible strip at match start stating the goal and the core
// loop, so a first-time player isn't left guessing what to do. Auto-clears after
// the opening; pressing ? opens the full control sheet.
let objectivesTimer;
export function showObjectives(endless = false) {
  objectivesEl.innerHTML = (endless
    ? `<span class="obj-goal">Odyssey — build an economy and win the galaxy.</span>`
      + `<span class="obj-tip"><b>Deploy your colony ship</b> to found your first base, then gather ore to raise a production chain (<b>Reactor → Smelter → factories</b>) and a <b>Datacenter</b> for deeper tech. The neighbour shares this world and turns hostile as it mines out, so keep some <b>defence</b>. Win by building an <b>Antimatter Gate</b> from the Strategic tier — or by <b>conquering rival capitals</b> across the galaxy (build a <b>Spaceport</b> to jump between worlds). Press <b>M</b> for the galaxy map, <b>?</b> for controls.</span>`
    : `<span class="obj-goal">Objective — destroy every enemy Command Center.</span>`
      + `<span class="obj-tip">Workers gather ore → build a Barracks → train an army → <b>A</b> then click to attack-move it in. Press <b>?</b> for all controls.</span>`)
    + `<button class="obj-close" title="Dismiss" aria-label="Dismiss">×</button>`;
  objectivesEl.classList.remove("hidden");
  objectivesEl.querySelector(".obj-close").addEventListener("click", hideObjectives);
  clearTimeout(objectivesTimer);
  objectivesTimer = setTimeout(hideObjectives, 30000);
}
export function hideObjectives() {
  clearTimeout(objectivesTimer);
  objectivesEl.classList.add("hidden");
}

/* ---------- galaxy toast (Odyssey background-colony alerts) ---------- */

// A brief top-center notice for things happening on a world you're not on — a
// colony under attack or lost (boot.js drives it from galaxy.sweepColonies).
let galaxyToastTimer;
export function showGalaxyToast(msg, kind = "warn") {
  galaxyToastEl.textContent = msg;
  galaxyToastEl.className = "galaxy-toast " + kind;   // drops "hidden", sets the kind
  clearTimeout(galaxyToastTimer);
  galaxyToastTimer = setTimeout(() => galaxyToastEl.classList.add("hidden"), 5000);
}

/* ---------- help overlay ---------- */

// A persistent hotkey reference, openable at ANY time (unlike the selection-panel
// legend, which is only there when nothing is selected).
const HELP_ROWS = [
  ["Left-drag", "Select units · Ctrl+drag adds to selection"],
  ["Right-click", "Move · attack an enemy · gather a node"],
  ["A, then click", "Attack-move — advance and engage on the way"],
  ["Ctrl+right-click", "Queue a waypoint (chain a path)"],
  ["1–9 / Shift+1–9", "Recall / bind a control group"],
  ["Double-click", "Select every unit of that type on screen"],
  ["Q · E · X", "Select army · Ranger scout mode · stop"],
  ["H", "Hold position — fire in range, don't chase"],
  ["`", "Jump to the next idle worker"],
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
}
helpBtn.addEventListener("click", () => toggleHelp());
helpOverlayEl.addEventListener("click", () => toggleHelp(false));
window.addEventListener("keydown", e => {
  if (e.key === "F1" || e.key === "?") { e.preventDefault(); toggleHelp(); }
  else if (e.key === "Escape" && !helpOverlayEl.classList.contains("hidden")) toggleHelp(false);
});

/* ---------- game-over overlay ---------- */

// The end-of-match overlay: a terminal overlay like the objectives/help ones, so
// it lives here rather than with the live HUD readouts (it shares no code with
// them). Param-driven — the seed and the restart action are passed in, so this
// module needs neither the session nor setup.js (onRestart re-opens map-select).
export function showGameOver(winner, seed, onRestart, opts = {}) {
  if (winner === "player") sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  // Odyssey has its own victory: you don't raze an enemy CC, you fire the Antimatter
  // Gate. The loss copy (last Command Center destroyed) is right for both modes.
  const msg = document.createElement("div");
  msg.textContent = winner === "player"
    ? (opts.odyssey
        ? (opts.wonBy === "domination"
            ? "Conquest — the galaxy bows to your fleet. Rival capitals lie in ruins."
            : "Victory — the Antimatter Gate fires. The galaxy is yours.")
        : "Victory — the enemy's last Command Center is destroyed.")
    : "Defeat — your last Command Center was destroyed.";
  gameOverEl.appendChild(msg);

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
