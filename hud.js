/* ============================================================
   The in-game HUD: the resource/clock/idle readouts, the selection panel
   (its per-selection buttons and live-patched rows/queue), the small button /
   tooltip factories, and the game-over screen. Split out of main.js — the
   live `state`/`input` are read from the shared session (session.js) at the top
   of each function, so the bodies are unchanged from the original.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import {
  resourcesEl, clockEl, idleWorkersEl,
  scenarioBarEl, scenarioBannerEl, scenarioStatusEl, repairBtn, departBtn,
  starmapBtn, saveBtn, loadBtn, groupChipsEl, pauseBtn,
} from "./dom.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { powerCap, powerDraw } from "./engine/industry.js";
import { repairCost, repairConvoy, departNow } from "./engine/scenarios.js";
import { stanceLabel, PEACE_THRESHOLD } from "./engine/diplomacy.js";
import { COM } from "./data.js";
// The per-selection button/row subsystem lives in hudSelection.js (this file drives
// the topbar / scenario bar / group chips and orchestrates the tick); renderHUD calls
// renderSelectionPanel each frame, and resetPanelSignature clears both guards on boot.
import { renderSelectionPanel, resetSelectionSignature } from "./hudSelection.js";

// Scenario dock actions — wired once. They read game.state at click time, and
// re-render immediately so the button state / budget update without waiting for
// the next HUD tick.
repairBtn.addEventListener("click", () => { if (game.state && repairConvoy(game.state)) renderHUD(); });
departBtn.addEventListener("click", () => { if (game.state) { departNow(game.state); renderHUD(); } });

// Topbar-rebuild guard: the last signature the resource/supply/credits/power/stance
// topbar was rebuilt for (the selection panel keeps its own guard in hudSelection.js).
// boot.js clears BOTH via resetPanelSignature() when a new game boots so the first
// frame rebuilds fresh.
let lastTopbarSignature = null;
export function resetPanelSignature() { lastTopbarSignature = null; resetSelectionSignature(); }

export function renderHUD() {
  const { state } = game;

  // The galaxy-map button shows only in Odyssey. Save/Load work in a skirmish and
  // in an Odyssey (whole-galaxy save), but a scripted scenario can't be resumed,
  // so they're hidden there.
  starmapBtn.classList.toggle("hidden", !game.galaxy);
  saveBtn.classList.toggle("hidden", !!state.scenario);
  loadBtn.classList.toggle("hidden", !!state.scenario);
  pauseBtn.classList.remove("hidden");   // pause is available in every mode (touch has no P key)

  if (state.scenario) {
    // A scenario has no economy: its budget + clock live in the scenario bar,
    // so blank the skirmish readouts and drive the bar instead.
    resourcesEl.innerHTML = "";
    idleWorkersEl.classList.add("hidden");
    clockEl.textContent = "";
  } else {
    const res = state.players.player.resources;
    const used = supplyUsed(state, "player"), cap = supplyCap(state, "player");
    const blocked = performance.now() < game.supplyBlockedUntil;
    const pCap = game.galaxy ? powerCap(state, "player") : 0, pDraw = game.galaxy ? powerDraw(state, "player") : 0;
    const stance = game.galaxy && state.diplomacy ? state.diplomacy.stance : null;
    // Signature-guard the topbar exactly like the selection panel: this whole readout was torn
    // down and rebuilt (~8 createElement/appendChild) every 150 ms even when nothing changed.
    // Skip the rebuild unless a displayed value actually moved. (The clock + idle count below
    // are single-text writes, cheap enough to patch every tick.)
    const sig = Object.entries(res).map(([c, q]) => `${c}${Math.floor(q)}`).join("|")
      + `|s${used}/${cap}${used >= cap ? "C" : ""}${blocked ? "B" : ""}`
      + (game.galaxy ? `|◈${Math.floor(game.galaxy.credits)}|p${Math.round(pDraw)}/${pCap}` : "")
      + (stance !== null ? `|r${stance.toFixed(2)}` : "");
    if (sig !== lastTopbarSignature) {
      lastTopbarSignature = sig;
      resourcesEl.innerHTML = "";
      Object.entries(res).forEach(([com, qty]) => {
        const n = Math.floor(qty);
        // Suppress empty stockpiles (a fresh Odyssey shows "ai: 0", "antimatter: 0",
        // … for a dozen goods you haven't made yet) — but always keep ore, the
        // bread-and-butter you're never without. An iconed readout ("🪨 120")
        // reads far faster than a wall of "com: n" labels.
        if (n <= 0 && com !== "ore") return;
        const meta = COM[com];
        const span = document.createElement("span");
        span.textContent = meta?.ico ? `${meta.ico} ${n}` : `${com}: ${n}`;
        span.title = meta?.name || com;
        resourcesEl.appendChild(span);
      });

      const supplySpan = document.createElement("span");
      supplySpan.className = "supply" + (used >= cap ? " at-cap" : "") + (blocked ? " blocked" : "");
      supplySpan.textContent = `supply: ${used}/${cap}`;
      resourcesEl.appendChild(supplySpan);

      // Odyssey: your universal credit balance lives on the galaxy, not the planet
      // — shown alongside the local economy (spent on jumps and the market later).
      if (game.galaxy) {
        const creditsSpan = document.createElement("span");
        creditsSpan.className = "credits";
        creditsSpan.textContent = `◈ ${Math.floor(game.galaxy.credits)}`;
        creditsSpan.title = "Universal credits — galaxy-wide, carried between planets";
        resourcesEl.appendChild(creditsSpan);

        // Industrial Power — shown only once you've started industrializing (a
        // Reactor or a factory exists), so it never clutters the pre-industry HUD.
        // Reads like the supply gauge: draw/cap, flagged when factories out-draw
        // the Reactors and production throttles.
        if (pCap > 0 || pDraw > 0) {
          const pw = document.createElement("span");
          pw.className = "power" + (pDraw > pCap ? " at-cap" : "");
          pw.textContent = `⚡ ${Math.round(pDraw)}/${pCap}`;
          pw.title = "Industrial Power — Reactors grant it, factories draw it; short power throttles all production";
          resourcesEl.appendChild(pw);
        }

        // The neighbour's stance — it drifts hostile as this world's deposits run scarce.
        if (stance !== null) {
          const relSpan = document.createElement("span");
          relSpan.className = "relation " + (stance <= PEACE_THRESHOLD ? "hostile" : stance < 0.25 ? "neutral" : "friendly");
          relSpan.textContent = `neighbour: ${stanceLabel(stance)}`;
          relSpan.title = "Your neighbour's stance — it turns hostile as this world's deposits run scarce";
          resourcesEl.appendChild(relSpan);
        }
      }
    }

    const mins = Math.floor(state.time / 60);
    const secs = Math.floor(state.time % 60).toString().padStart(2, "0");
    clockEl.textContent = `${mins}:${secs}`;

    // Idle-worker indicator: a lost worker on a big map is easy to miss, so surface
    // the count in the topbar (click, or `, to jump to the next one).
    let idle = 0;
    for (const u of state.units.values()) {
      if (u.owner === "player" && u.type === "worker" && !u.order && (!u.orderQueue || !u.orderQueue.length)) idle++;
    }
    idleWorkersEl.textContent = `⚒ ${idle} idle`;
    idleWorkersEl.classList.toggle("hidden", idle === 0);
  }

  renderScenarioBar(state);
  renderGroupChips();
  renderSelectionPanel();
}

// A small always-visible row of the player's bound control groups ("1:8  2:3") near the
// minimap — so groups are discoverable, and on touch (no number row) each chip recalls its
// group on tap (a second tap recenters, via input.recallGroup's double-press). Rebuilt each
// HUD tick from live counts; hidden when nothing is bound.
let lastGroupChipSig = "";
function renderGroupChips() {
  const input = game.input;
  const list = input && input.groupCounts ? input.groupCounts() : [];
  const sig = list.map(e => `${e.digit}:${e.count}`).join(" ");
  if (sig === lastGroupChipSig) return;   // only touch the DOM when the counts actually change
  lastGroupChipSig = sig;
  groupChipsEl.innerHTML = "";
  groupChipsEl.classList.toggle("hidden", list.length === 0);
  for (const { digit, count } of list) {
    const chip = document.createElement("button");
    chip.className = "group-chip";
    chip.textContent = `${digit}:${count}`;
    chip.title = `Control group ${digit} (${count} unit${count === 1 ? "" : "s"}) — tap to select, tap again to jump`;
    // Read game.input LIVE in the handler, not the controller captured at build time: an
    // Odyssey jump swaps the controller, and if the chip counts happen to match (same sig)
    // the row isn't rebuilt — a captured handler would then recall on the old, destroyed
    // world's controller. recallGroup reads game.groups[planetId] live, so this is correct.
    chip.addEventListener("click", () => game.input && game.input.recallGroup(digit));
    groupChipsEl.appendChild(chip);
  }
}

// The scenario status strip: the phase banner, a leg/freighters/clock/budget
// line, and the Repair / Depart actions while docked at a station. Hidden
// entirely in a skirmish.
function renderScenarioBar(state) {
  const sc = state.scenario;
  if (!sc) { scenarioBarEl.classList.add("hidden"); return; }
  scenarioBarEl.classList.remove("hidden");
  scenarioBannerEl.textContent = sc.banner;

  const remain = Math.max(0, sc.timeLimit - state.time);

  // Bounty Marshal: a seek-and-destroy hunt — camps cleared toward the quota,
  // bounty banked, and the clock. No route/legs, so this runs before any route
  // access (a bounty scenario has no sc.route); no budget, no dock actions.
  if (sc.type === "bounty") {
    scenarioStatusEl.textContent =
      `Camps ${sc.packsCleared}/${sc.totalPacks} · Quota ${sc.targetPacks} · ⏱ ${clockStr(remain)} · 💰 ${sc.bounty}`;
    repairBtn.classList.add("hidden");
    departBtn.classList.add("hidden");
    return;
  }

  // The convoy scenarios (escort / raider) run a route of legs.
  const legs = sc.route.length - 1;
  const legNo = Math.min(sc.legIndex + 1, legs);

  // Pirate Raider: you hunt the AI convoy, so the readout is kills-toward-quota,
  // convoy still afloat, and the clock — no budget, no dock actions.
  if (sc.type === "raider") {
    const afloat = [...state.units.values()].filter(u => u.owner === sc.freighterOwner && u.type === "freighter").length;
    const sunk = sc.outcome ? sc.destroyed : (sc.freightersTotal - afloat - (sc.delivered || 0));
    scenarioStatusEl.textContent =
      `Leg ${legNo}/${legs} · Sunk ${sunk}/${sc.targetKills} · Convoy ${afloat} afloat · ⏱ ${clockStr(remain)}`;
    repairBtn.classList.add("hidden");
    departBtn.classList.add("hidden");
    return;
  }

  const alive = [...state.units.values()].filter(u => u.owner === "player" && u.type === "freighter").length;
  const shown = sc.outcome ? sc.delivered : alive;
  scenarioStatusEl.textContent =
    `Leg ${legNo}/${legs} · Freighters ${shown}/${sc.freightersTotal} · ⏱ ${clockStr(remain)} · 💰 ${Math.round(sc.budget)}`;

  if (sc.phase === "docked") {
    const cost = repairCost(state);
    repairBtn.classList.remove("hidden");
    departBtn.classList.remove("hidden");
    repairBtn.classList.toggle("disabled", sc.repairedThisStop || cost === 0 || cost > sc.budget);
    repairBtn.textContent = sc.repairedThisStop ? "Repaired ✓"
      : cost === 0 ? "No damage"
      : cost > sc.budget ? `Repair (${cost}) — no funds`
      : `Repair all (${cost} 💰)`;
  } else {
    repairBtn.classList.add("hidden");
    departBtn.classList.add("hidden");
  }
}

function clockStr(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
