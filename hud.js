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
  resourcesEl, clockEl, panelEl, idleWorkersEl, isTouchMode,
  scenarioBarEl, scenarioBannerEl, scenarioStatusEl, repairBtn, departBtn,
  starmapBtn, saveBtn, loadBtn, groupChipsEl, pauseBtn,
} from "./dom.js";
import { queueProduction, cancelProduction, researchUpgrade } from "./engine/production.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { powerCap, powerDraw, recipeOf, powerThrottle, planetIndustryScale } from "./engine/industry.js";
import { rigInfo } from "./engine/rig.js";
import { TECHS, researchTech, techMult } from "./engine/techtree.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet, committedDoctrine } from "./engine/entities.js";
import { repairCost, repairConvoy, departNow } from "./engine/scenarios.js";
import { JUMP_COST, jumpCost, jumpManifest, jumpCapacity, spaceportTier, upgradeSpaceport,
         SPACEPORT_MAX_TIER, SPACEPORT_UPGRADE_COST, cargoManifest, freightCapacity,
         loadFreighter, unloadFreighter, freightUsed, freightRoom,
         upgradeToCapital, jumpVessel, CAPITAL_UPGRADE_COST, CAPITAL_HP_MULT } from "./engine/galaxy.js";
import { canPlaceBuilding } from "./engine/colliders.js";
import { deployColonyShip } from "./engine/colony.js";
import { sell, buy, unitPrice, tradeables, TRADE_LOT } from "./engine/market.js";
import { stanceLabel, PEACE_THRESHOLD, offerTribute, tributeCost, APPEASE_TIME } from "./engine/diplomacy.js";
import { performJump } from "./boot.js";
import { flashHint } from "./overlays.js";
import { spriteIcon } from "./render.js";
import { planetName, COM } from "./data.js";
import * as sound from "./sound.js";

// Scenario dock actions — wired once. They read game.state at click time, and
// re-render immediately so the button state / budget update without waiting for
// the next HUD tick.
repairBtn.addEventListener("click", () => { if (game.state && repairConvoy(game.state)) renderHUD(); });
departBtn.addEventListener("click", () => { if (game.state) { departNow(game.state); renderHUD(); } });

// Panel-rebuild guard: the last signature the selection panel was rebuilt for.
// Module-local (only renderSelectionPanel reads/writes it); boot.js clears it via
// resetPanelSignature() when a new game boots so the first frame rebuilds fresh.
let lastPanelSignature = null;
let lastTopbarSignature = null;   // same idiom for the resource/supply/credits/power/stance topbar
export function resetPanelSignature() { lastPanelSignature = null; lastTopbarSignature = null; }

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

// Selecting more than one unit collapses the panel to one row per type
// ("12× Skiff — 84% hp") instead of a row per unit — unusable past a
// handful of units otherwise. A single unit or building still gets its
// own detailed row. Buildings never aggregate (box-select only ever
// picks up units; a building is always a lone click-selection).
function countByType(units) {
  const counts = new Map();
  units.forEach(u => {
    const entry = counts.get(u.type) || { count: 0, hp: 0, maxHp: 0 };
    entry.count++;
    entry.hp += u.hp;
    entry.maxHp += u.maxHp;
    counts.set(u.type, entry);
  });
  return counts;
}

// Only the queue's *composition* (what's queued, in what order) needs a
// full rebuild -- a job's progress fraction changes every tick and is
// instead patched in place below, same reasoning as the hp-only patch
// path this already sits alongside.
function queueSignature(sel) {
  const b = sel.length === 1 && sel[0].kind === "building" ? sel[0] : null;
  if (!b) return "";
  const prod = b.queue ? b.queue.map(j => j.unitType).join(",") : "";
  // The Datacenter's tech research is its own queue — include it so queuing/finishing a
  // research rebuilds the panel (the progress % itself is then live-patched each tick).
  const research = b.researchQueue ? b.researchQueue.map(j => j.techId).join(",") : "";
  return prod + "#" + research;
}

// Fingerprint of what the player can currently afford and which completed
// buildings they hold — the two inputs to every button's greyed/locked state.
function availabilitySignature() {
  const { state } = game;
  const res = state.players.player.resources;
  const costs = [
    ...Object.values(UNITS).map(u => u.cost),
    ...Object.values(BUILDINGS).map(b => b.cost),
    ...Object.values(UPGRADES).map(u => u.cost),
  ];
  const afford = costs.map(c => (canAfford(res, c) ? 1 : 0)).join("");
  const built = [...new Set([...state.buildings.values()]
    .filter(b => b.owner === "player" && !b.constructing).map(b => b.type))].sort().join(",");
  return afford + "|" + built;
}

// The colour-band of a selected factory's status (or "" for none), so a status
// transition triggers a panel rebuild — see the panel signature above.
function factorySignature(sel) {
  const { state } = game;
  const f = sel.find(e => e.kind === "building" && recipeOf(e) && !e.constructing);
  return f ? factoryStatus(state, f, recipeOf(f)).cls : "";
}

function renderSelectionPanel() {
  const { state, input } = game;
  const sel = state.selection.map(id => state.units.get(id) || state.buildings.get(id)).filter(Boolean);
  const aggregated = sel.length > 1 && sel.every(e => e.kind === "unit");

  // Only rebuild the panel's DOM when the set of buttons/rows it should
  // show would actually change (selection, build-placement mode,
  // upgrades researched, or the production queue's composition).
  // Rebuilding on every HUD tick — even though hp/progress numbers
  // change constantly — replaced the exact button the player was
  // mid-click on with a fresh DOM node, and a mouseup landing after that
  // swap could drop the click entirely: felt like only a sliver of the
  // button was clickable, when really it was a timing race, not a
  // sizing one.
  const signature = sel.map(e => `${e.id}:${e.kind === "building" ? e.constructing : ""}`).join(",")
    + "|" + (input.building ? input.building.buildingType : "")
    + "|" + Object.keys(state.players.player.upgrades).sort().join(",")
    + "|" + aggregated
    // Rebuild when attack-move arms/disarms so the Attack-Move button's ARMED label +
    // .armed class actually appear — without this the state changed with no panel cue.
    + "|" + input.attackArmed
    + "|" + queueSignature(sel)
    // Rebuild when any button's enabled state would flip: an option crossing the
    // affordability line, or a completed building unlocking a tech option (e.g.
    // the Foundry un-greying Lancer/Breacher). Keeps the greying live without
    // rebuilding every HUD tick.
    + "|" + availabilitySignature()
    // Rebuild when the app flips into touch mode, so the panel's legend + hints
    // swap from mouse/keyboard to finger phrasing on the first touch.
    + "|" + isTouchMode()
    // Rebuild when a selected factory's status transitions (running ↔ throttled ↔
    // starved ↔ stalled), so its "why it's not producing" line stays live without
    // a full rebuild every HUD tick.
    + "|" + factorySignature(sel)
    // Rebuild when the Odyssey diplomacy panel would appear/disappear (stance crossing
    // the 0.25 band) or its tribute button's cost/affordability would flip — so the
    // appease lever surfaces the moment the neighbour cools, without a per-tick rebuild.
    + "|" + (game.galaxy && state.diplomacy
        ? `${state.diplomacy.stance < 0.25}:${tributeCost(state.diplomacy)}:${game.galaxy.credits >= tributeCost(state.diplomacy)}`
        : "")
    // Rebuild when the Capital state changes (a CC upgraded to Capital → anchored note), a
    // staged colony ship appears/vanishes (the jump panel's "ship loaded?" hint), or the
    // credits cross the new-world jump cost (those Jump buttons enable/lock).
    + "|" + (game.galaxy
        ? `${jumpVessel(state) ? 1 : 0}:${game.galaxy.credits >= JUMP_COST ? 1 : 0}:${[...state.buildings.values()].filter(b => b.owner === "player" && b.capital).length}`
        : "")
    // Rebuild when a selected colony ship crosses a deploy-placement boundary, so its
    // "Deploy as Command Center" button locks/unlocks live as you move it to clear ground.
    + "|" + (() => {
        const cs = game.galaxy && sel.find(e => e.kind === "unit" && e.type === "colonyship");
        return cs ? (canPlaceBuilding(state, "command", cs.x, cs.y) ? 1 : 0) : "";
      })()
    // Rebuild the Spaceport panel when its tier changes (upgrade) or the staged fleet crosses
    // the pad capacity (units enter/leave the pad radius) — so the manifest preview stays live.
    + "|" + (() => {
        const sp = game.galaxy && sel.find(e => e.kind === "building" && e.type === "spaceport" && !e.constructing);
        if (!sp) return "";
        const m = jumpManifest(state, sp);
        return `${spaceportTier(sp)}:${m.used}:${m.leftBehind}:${m.staged}`;
      })()
    // Rebuild the freighter cargo panel when its hold or the loadable stockpile changes, so the
    // Load/Unload buttons and the used/cap readout stay live as goods move in and out of the hold.
    + "|" + (() => {
        const f = game.galaxy && sel.find(e => e.kind === "unit" && UNITS[e.type].cargoHold);
        if (!f) return "";
        const res = state.players.player.resources;
        return freightUsed(f) + ":" + JSON.stringify(f.freight) + ":" + loadableComs(state, f).map(c => Math.floor(res[c] || 0)).join(",");
      })()
    // Rebuild a selected Plasma Rig's status as it digs — its progress, last strike (each dig
    // increments digCount), and its power/nuclear situation — without a per-tick rebuild.
    + "|" + (() => {
        const rig = game.galaxy && sel.find(e => e.kind === "building" && BUILDINGS[e.type].rig && !e.constructing);
        if (!rig) return "";
        const info = rigInfo(state, rig);
        return `${!!rig.paused}:${info.nuclearOk}:${Math.round(info.throttle * 10)}:${rig.digCount || 0}:${Math.round(info.progress * 4)}`;
      })();

  if (signature !== lastPanelSignature) {
    lastPanelSignature = signature;
    rebuildSelectionPanel(sel);
    return;
  }

  if (aggregated) {
    const rows = panelEl.querySelectorAll(".sel-row");
    [...countByType(sel).entries()].forEach(([type, entry], i) => {
      const def = UNITS[type];
      const pct = Math.round((entry.hp / entry.maxHp) * 100);
      if (rows[i]) rows[i].textContent = `${entry.count}× ${def.name} — ${pct}% hp`;
    });
  } else {
    const rows = panelEl.querySelectorAll(".sel-row");
    sel.forEach((e, i) => {
      const def = e.kind === "unit" ? UNITS[e.type] : BUILDINGS[e.type];
      if (rows[i]) rows[i].textContent = `${def.name} — ${Math.ceil(e.hp)}/${e.maxHp} hp`;
    });
  }

  // Patch the in-progress queue slot's live percentage without touching
  // the cancel buttons (a full rebuild would otherwise be needed on
  // every single tick, since progress changes every tick).
  const building = sel.length === 1 && sel[0].kind === "building" ? sel[0] : null;
  if (building && building.queue && building.queue.length) {
    const queueLabels = panelEl.querySelectorAll(".queue-label");
    building.queue.forEach((job, i) => {
      if (!queueLabels[i]) return;
      const def = UNITS[job.unitType];
      queueLabels[i].textContent = i === 0 ? `${def.name} — ${Math.round(job.progress * 100)}%` : `${def.name} (queued)`;
    });
  }

  // Same live patch for the Datacenter's tech research (its own researchQueue) — otherwise the
  // "Researching … — N%" row would sit frozen at whatever % it had on the last rebuild.
  if (building && building.researchQueue && building.researchQueue.length) {
    const row = panelEl.querySelector(".research-progress");
    if (row) row.textContent = researchRowText(building.researchQueue);
  }
}

// The Datacenter research header text — shared by the rebuild and the live patch so the two
// never drift.
function researchRowText(queue) {
  const head = TECHS[queue[0].techId];
  return `${head.ico ? head.ico + " " : ""}Researching ${head.name} — ${Math.round(queue[0].progress * 100)}%`
    + (queue.length > 1 ? ` (+${queue.length - 1} queued)` : "");
}

function renderQueueRows(building) {
  const { state } = game;
  building.queue.forEach((job, i) => {
    const def = UNITS[job.unitType];
    const row = document.createElement("div");
    row.className = "sel-row queue-row";

    const label = document.createElement("span");
    label.className = "queue-label";
    label.textContent = i === 0 ? `${def.name} — ${Math.round(job.progress * 100)}%` : `${def.name} (queued)`;
    row.appendChild(label);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "queue-cancel";
    cancelBtn.textContent = "×";
    cancelBtn.title = "Cancel (full refund)";
    cancelBtn.addEventListener("click", () => { cancelProduction(state, building.id, i); renderHUD(); });
    row.appendChild(cancelBtn);

    panelEl.appendChild(row);
  });
}

// The Odyssey trade panel, shown under the Command Center's production. One row
// per tradeable commodity: its live sell price, and Sell/Buy buttons in fixed
// lots. Selling banks universal credits (and nudges the local price down);
// buying spends them (and nudges it up) — see engine/market.js.
function renderMarket(state) {
  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = "Market — trade local goods for credits";
  panelEl.appendChild(head);

  const res = state.players.player.resources;
  for (const com of tradeables(state)) {
    const row = document.createElement("div");
    row.className = "market-row";

    const label = document.createElement("span");
    label.className = "market-com";
    // Reuse the commodity's data icon (data.js COM) — the same emblem the resource readout uses.
    const meta = COM[com];
    label.textContent = `${meta?.ico ? meta.ico + " " : ""}${meta?.name || com} ◈${Math.round(unitPrice(state.market, com, "sell"))}`;
    row.appendChild(label);

    const have = Math.floor(res[com] || 0);
    const sellBtn = document.createElement("button");
    sellBtn.className = "market-btn" + (have < TRADE_LOT ? " disabled" : "");
    sellBtn.textContent = `Sell ${TRADE_LOT}`;
    sellBtn.title = `Sell ${TRADE_LOT} ${com} for ~◈${Math.round(unitPrice(state.market, com, "sell") * TRADE_LOT)}`;
    sellBtn.addEventListener("click", () => {
      if (Math.floor(res[com] || 0) >= TRADE_LOT) { sell(game.galaxy, state, com, TRADE_LOT); renderHUD(); }
      else sound.playProductionBlocked();
    });
    row.appendChild(sellBtn);

    const buyPrice = unitPrice(state.market, com, "buy");
    const canBuy = game.galaxy.credits >= buyPrice * TRADE_LOT;
    const buyBtn = document.createElement("button");
    buyBtn.className = "market-btn" + (canBuy ? "" : " disabled");
    buyBtn.textContent = `Buy ${TRADE_LOT}`;
    buyBtn.title = `Buy ${TRADE_LOT} ${com} for ~◈${Math.round(buyPrice * TRADE_LOT)}`;
    buyBtn.addEventListener("click", () => {
      if (game.galaxy.credits >= unitPrice(state.market, com, "buy") * TRADE_LOT) { buy(game.galaxy, state, com, TRADE_LOT); renderHUD(); }
      else sound.playProductionBlocked();
    });
    row.appendChild(buyBtn);

    panelEl.appendChild(row);
  }
}

// Commodities a freighter panel offers to load: anything already aboard, or anything the player
// holds in stock on this world (excluding `energy` — that's Power, a utility, not freight). This
// deliberately goes beyond the market's tradeables, so the STRATEGIC goods (antimatter, AI cores,
// plasma torpedoes) — which no market buys — can still be loaded and shipped to the world charging
// your Antimatter Gate or building Leviathans at a Stardock, their only real sinks.
function loadableComs(state, f) {
  const res = state.players.player.resources;
  return [...new Set([
    ...Object.keys(f.freight || {}),
    ...Object.keys(COM).filter(c => c !== "energy" && Math.floor(res[c] || 0) >= 1),
  ])];
}

// Freighter cargo hold (Odyssey): load specific goods off THIS world's stockpile into the selected
// freighter, or unload them back — the manual control over what each ship carries on a jump
// (engine/galaxy.js load/unloadFreighter). A hold left empty still auto-fills at jump time, so this
// is optional fine-grained control (ship cheap spice to an industrial world, hold ore back), not a
// chore. Reuses the market row styling.
function renderFreight(state, f) {
  const cap = UNITS[f.type].cargoHold, used = freightUsed(f), room = freightRoom(f);
  const res = state.players.player.resources;

  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = `🚚 ${UNITS[f.type].name} — hold ${Math.round(used)}/${cap}`;
  panelEl.appendChild(head);

  // Bulk shortcuts: fill the remaining room most-valuable-first, or empty the whole hold to stock.
  const bulk = document.createElement("div");
  bulk.className = "market-row";
  const autoBtn = document.createElement("button");
  autoBtn.className = "market-btn" + (room <= 0 ? " disabled" : "");
  autoBtn.textContent = "Auto-load ▲";
  autoBtn.title = "Fill the remaining hold with the most valuable goods on this world";
  autoBtn.addEventListener("click", () => {
    const manifest = cargoManifest(state, freightRoom(f));
    let any = false;
    for (const com in manifest) if (loadFreighter(state, f.id, com, manifest[com]) > 0) any = true;
    if (any) renderHUD(); else sound.playProductionBlocked();
  });
  bulk.appendChild(autoBtn);
  const clearBtn = document.createElement("button");
  clearBtn.className = "market-btn" + (used <= 0 ? " disabled" : "");
  clearBtn.textContent = "Unload all ▼";
  clearBtn.title = "Unload the whole hold back onto this world's stockpile";
  clearBtn.addEventListener("click", () => {
    let any = false;
    for (const com of Object.keys(f.freight)) if (unloadFreighter(state, f.id, com, f.freight[com]) > 0) any = true;
    if (any) renderHUD(); else sound.playProductionBlocked();
  });
  bulk.appendChild(clearBtn);
  panelEl.appendChild(bulk);

  // One row per commodity that's either aboard already or sitting in this world's stockpile: load
  // all of it that fits, or unload all that's aboard, in one tap each.
  const coms = loadableComs(state, f);
  for (const com of coms) {
    const meta = COM[com];
    const aboard = Math.floor(f.freight[com] || 0), stock = Math.floor(res[com] || 0);
    const row = document.createElement("div");
    row.className = "market-row";
    const label = document.createElement("span");
    label.className = "market-com";
    label.textContent = `${meta?.ico ? meta.ico + " " : ""}${meta?.name || com} · ${aboard} aboard`;
    row.appendChild(label);

    const loadBtn = document.createElement("button");
    loadBtn.className = "market-btn" + (stock < 1 || room <= 0 ? " disabled" : "");
    loadBtn.textContent = "Load";
    loadBtn.title = `Load ${meta?.name || com} onto the ${UNITS[f.type].name} (as much as fits)`;
    loadBtn.addEventListener("click", () => {
      if (loadFreighter(state, f.id, com, freightRoom(f)) > 0) renderHUD(); else sound.playProductionBlocked();
    });
    row.appendChild(loadBtn);

    const unBtn = document.createElement("button");
    unBtn.className = "market-btn" + (aboard < 1 ? " disabled" : "");
    unBtn.textContent = "Unload";
    unBtn.title = `Unload ${meta?.name || com} back onto this world`;
    unBtn.addEventListener("click", () => {
      if (unloadFreighter(state, f.id, com, f.freight[com] || 0) > 0) renderHUD(); else sound.playProductionBlocked();
    });
    row.appendChild(unBtn);
    panelEl.appendChild(row);
  }
}

// Why a selected factory is (or isn't) producing — the answer to "my antimatter
// isn't going up." Checks the same limits updateProduction (engine/industry.js)
// applies, in priority order: no Power at all, then a missing input, then a Power
// shortfall throttling everything, else running (with the live output rate).
function factoryStatus(state, b, recipe) {
  if (b.paused) return { cls: "paused", text: "Paused — banking its inputs" };
  const throttle = powerThrottle(state, b.owner);
  if (throttle <= 0) return { cls: "bad", text: "Stalled — no Power" };

  const res = state.players[b.owner].resources;
  let scarce = null, scarceRatio = Infinity;
  for (const com in recipe.in) {
    if (com === "energy") continue;
    const ratio = (res[com] || 0) / recipe.in[com];
    if (ratio < scarceRatio) { scarceRatio = ratio; scarce = com; }
  }
  if (scarceRatio < 1) return { cls: "bad", text: `Starved — needs ${COM[scarce]?.name || scarce}` };
  if (throttle < 0.995) return { cls: "warn", text: `Throttled ${Math.round(throttle * 100)}% — low Power` };

  const def = BUILDINGS[b.type], ups = state.players[b.owner].upgrades;
  const rate = (def.prodRate || 1) * techMult(ups, "rateMult") * planetIndustryScale(state)
    * throttle * recipe.qty * techMult(ups, "yieldMult");
  return { cls: "good", text: `Running · +${rate.toFixed(1)} ${COM[recipe.out]?.name || recipe.out}/s` };
}

// The Odyssey diplomacy panel, under the Command Center's market: pay universal
// credits to appease the neighbour for a while (engine/diplomacy.js offerTribute).
// The cost escalates per tribute and the truce decays, so it's a stopgap — buy time
// to weather a wave or finish a jump, not a permanent peace. A charging Antimatter
// Gate is unappeasable, by design. Credit-gated via locked/lockTip (NOT makeButton's
// `cost`, which checks the LOCAL economy), the same idiom as the Spaceport jump.
function renderDiplomacy(state) {
  const cost = tributeCost(state.diplomacy);
  const afford = game.galaxy.credits >= cost;

  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = `Diplomacy — ${stanceLabel(state.diplomacy.stance)} neighbour`;
  panelEl.appendChild(head);

  panelEl.appendChild(makeButton(`Send tribute (◈${cost})`,
    () => { offerTribute(game.galaxy, state); },   // makeButton adds renderHUD() on the affordable path
    { tip: `Buy ~${APPEASE_TIME}s of peace — the neighbour stands down, but the truce decays and each tribute costs more. A charging Gate can't be bought off.`,
      locked: !afford,
      lockTip: `Need ◈${cost} — you have ◈${Math.floor(game.galaxy.credits)}` }));
}

// The Odyssey Capital control on a Command Center: this CC is already the anchored
// Capital (a note), a Capital exists elsewhere (nothing — this one is a mobile base),
// or no Capital yet (an "Upgrade to Capital" button). Fortifying doubles HP and anchors
// it; only smaller CCs jump (engine/galaxy.js).
function renderCapital(state, cc) {
  if (cc.capital) {
    const row = document.createElement("div");
    row.className = "sel-note good";
    row.textContent = `◆ Capital — anchored fortress (${Math.ceil(cc.hp)}/${cc.maxHp} hp). Defends, never jumps.`;
    panelEl.appendChild(row);
    return;
  }
  if ([...state.buildings.values()].some(b => b.owner === "player" && b.capital)) return;  // one Capital already
  panelEl.appendChild(makeButton(`◆ Upgrade to Capital (${costText(CAPITAL_UPGRADE_COST)})`,
    () => { upgradeToCapital(state, cc); },
    { cost: CAPITAL_UPGRADE_COST, icon: { kind: "building", type: "command" },
      tip: `Fortify this Command Center into your anchored Capital: ×${CAPITAL_HP_MULT} HP. The Capital never jumps — only a smaller CC relocates.` }));
}

// Positional production/build hotkeys: the Nth produce/build button of the current panel is
// bound to the Nth of these keys (annotated on the label, like "Stop ( X )"). Chosen to avoid
// every existing key (digits, X/Q/E/A/H, P, `, M, WASD/arrows). game.hotkeyActions is the live
// list input.js invokes; each entry mimics a real click (so a locked option just buzzes).
const PANEL_HOTKEYS = ["z", "c", "v", "b", "n"];
let panelActions = [];
// A produce/build button that also claims the next positional hotkey. Wraps makeButton, shows
// the key in the label, and registers a click-mimicking action. Non-primary buttons (upgrades,
// market, tribute) keep plain makeButton and take no hotkey.
function prodButton(label, run, opts) {
  const key = PANEL_HOTKEYS[panelActions.length];
  const btn = makeButton(key ? `${label}  ( ${key.toUpperCase()} )` : label, run, opts);
  panelActions.push({ key, click: () => btn.click() });   // click() replays the real handler (incl. the disabled buzz)
  return btn;
}

function rebuildSelectionPanel(sel) {
  const { state, input } = game;
  panelEl.innerHTML = "";
  panelActions = [];
  game.hotkeyActions = panelActions;   // input.js reads this live array for the Z/C/V/B/N production keys

  if (!sel.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Drag-select units, or click a building.";
    panelEl.appendChild(hint);
    panelEl.appendChild(makeButton("Idle Worker ( ` )", () => input.focusIdleWorker()));
    panelEl.appendChild(makeButton("Select Army ( Q )", () => input.selectAllArmy()));
    panelEl.appendChild(controlsLegend());
    return;
  }

  if (sel.length > 1 && sel.every(e => e.kind === "unit")) {
    const counts = countByType(sel);
    const multiType = counts.size > 1;   // only worth sub-selecting when the mix has 2+ types
    for (const [type, entry] of counts) {
      const def = UNITS[type];
      const pct = Math.round((entry.hp / entry.maxHp) * 100);
      const label = `${entry.count}× ${def.name} — ${pct}% hp`;
      // With several types selected, each row is a button that narrows the selection
      // to just that type (input.selectType) — click "3× Bastion" to keep only them.
      if (multiType) {
        const btn = document.createElement("button");
        btn.className = "sel-row type-row";
        btn.textContent = label;
        btn.title = `Select only your ${def.name}s`;
        btn.addEventListener("click", () => input.selectType(type));
        panelEl.appendChild(btn);
      } else {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = label;
        panelEl.appendChild(row);
      }
    }
  } else {
    sel.forEach(e => {
      const def = e.kind === "unit" ? UNITS[e.type] : BUILDINGS[e.type];
      const row = document.createElement("div");
      row.className = "sel-row";
      row.textContent = `${def.name} — ${Math.ceil(e.hp)}/${e.maxHp} hp`;
      panelEl.appendChild(row);
    });
  }

  const cc = sel.find(e => e.kind === "building" && e.type === "command" && !e.constructing);
  if (cc) {
    // Odyssey: the CC also builds Colony Ships — the mobile seed you deploy to found a
    // new base (no more building a CC directly). Gated on game.galaxy like the sibling
    // Odyssey CC panels below, so a skirmish CC shows only Worker/Ranger.
    // Odyssey adds the Colony Ship (found a base) and the three cargo ships (haul goods on a jump —
    // gated behind the Spaceport, so they surface once you've built the jump pad).
    const ccUnits = game.galaxy ? ["worker", "ranger", "colonyship", "hauler", "heavyhauler", "bulkfreighter"] : ["worker", "ranger"];
    for (const t of ccUnits) {
      const def = UNITS[t];
      const locked = !prereqsMet(state, "player", def);
      panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.cost)})`,
        () => queueProduction(state, cc.id, t),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: t } }));
    }
    if (cc.queue.length) renderQueueRows(cc);
    if (game.galaxy) renderCapital(state, cc);              // Odyssey: fortify this CC into the anchored Capital
    if (game.galaxy && state.market) renderMarket(state);   // Odyssey: trade local commodities for universal credits
    // Odyssey diplomacy: appease the neighbour with credits — shown only once the
    // stance has cooled to Neutral-or-worse (no point paying while comfortably cordial).
    if (game.galaxy && state.diplomacy && state.diplomacy.stance < 0.25) renderDiplomacy(state);
  }

  const barracks = sel.find(e => e.kind === "building" && e.type === "barracks" && !e.constructing);
  if (barracks) {
    // Only offer a unit this world can actually pay for — a specialty unit
    // (Wraith/gas, Aegis/ice, Colossus/relics) is hidden entirely on a map that
    // deposits none of its commodity, instead of showing a forever-greyed button.
    const onMap = new Set(state.map.nodes.map(n => n.com));
    const buildable = t => Object.keys(UNITS[t].cost).every(c => onMap.has(c));
    for (const t of ["skiff", "bastion", "lancer", "breacher", "dreadnought", "mender", "wraith", "aegis", "colossus"]) {
      if (!buildable(t)) continue;
      const def = UNITS[t];
      const locked = !prereqsMet(state, "player", def);
      panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.cost)})`,
        () => queueProduction(state, barracks.id, t),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: t } }));
    }
    if (barracks.queue.length) renderQueueRows(barracks);
  }

  const refinery = sel.find(e => e.kind === "building" && e.type === "refinery" && !e.constructing);
  if (refinery) {
    const upgrades = state.players.player.upgrades;
    const chosen = committedDoctrine(state, "player");   // null until the first research commits a doctrine
    const label = { assault: "Assault", bulwark: "Bulwark", logistics: "Logistics" };
    Object.values(UPGRADES).forEach(u => {
      if (upgrades[u.id]) {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = `${u.ico ? u.ico + " " : ""}${u.name} (${label[u.doctrine]}) — researched`;
        panelEl.appendChild(row);
        return;
      }
      const doctrineLocked = chosen && chosen !== u.doctrine;
      const tierLocked = !prereqsMet(state, "player", u);
      const locked = doctrineLocked || tierLocked;
      const lockTip = doctrineLocked ? `Locked — committed to the ${label[chosen]} doctrine`
        : tierLocked ? `Requires ${UPGRADES[(u.requires || [])[0]]?.name || "its Tier 1"}` : null;
      panelEl.appendChild(makeButton(`Research ${u.name} · ${label[u.doctrine]} (${costText(u.cost)})`,
        () => researchUpgrade(state, refinery.id, u.id),
        { cost: u.cost, tip: u.desc, locked, lockTip, icon: u.ico ? { emoji: u.ico } : null }));
    });
  }

  // Datacenter (Odyssey): the industrial tech tree. Researches one node at a time,
  // paid in gathered commodities and developed over time — flat lock-tip buttons,
  // the same idiom as the Refinery's doctrine research (no separate tree UI).
  const datacenter = sel.find(e => e.kind === "building" && e.type === "datacenter" && !e.constructing);
  if (datacenter) {
    const upgrades = state.players.player.upgrades;
    const queue = datacenter.researchQueue || [];
    const queued = new Set(queue.map(j => j.techId));
    if (queue.length) {
      const row = document.createElement("div");
      row.className = "sel-row research-progress";   // patched live each tick (see renderSelectionPanel)
      row.textContent = researchRowText(queue);
      panelEl.appendChild(row);
    }
    Object.values(TECHS).forEach(t => {
      if (upgrades[t.id]) {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = `${t.ico ? t.ico + " " : ""}${t.name} — researched`;
        panelEl.appendChild(row);
        return;
      }
      if (queued.has(t.id)) return;   // already lined up — reflected in the header's "+N queued"
      // Available if every prereq is researched, a completed building, or queued ahead.
      const ready = (t.requires || []).every(r => queued.has(r) || prereqsMet(state, "player", { requires: [r] }));
      panelEl.appendChild(makeButton(`Research ${t.name} (${costText(t.cost)})`,
        () => researchTech(state, datacenter.id, t.id),
        { cost: t.cost, tip: t.desc, locked: !ready, lockTip: !ready ? lockTipFor(t) : null, icon: t.ico ? { emoji: t.ico } : null }));
    });
  }

  // Star Dock (Odyssey): trains the Leviathan capital ship. Its own panel (not the
  // Barracks) because the Leviathan costs strategic goods that never sit on the map,
  // so the Barracks' on-map-cost filter would hide it.
  const stardock = sel.find(e => e.kind === "building" && e.type === "stardock" && !e.constructing);
  if (stardock) {
    const def = UNITS.leviathan;
    const locked = !prereqsMet(state, "player", def);
    panelEl.appendChild(prodButton(`Produce ${def.name} (${costText(def.cost)})`,
      () => queueProduction(state, stardock.id, "leviathan"),
      { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "unit", type: "leviathan" } }));
    if (stardock.queue.length) renderQueueRows(stardock);
  }

  // Antimatter Gate (Odyssey): the endgame wonder. Shows its charge toward the
  // galaxy win — keep antimatter flowing and hold the line.
  const wonder = sel.find(e => e.kind === "building" && BUILDINGS[e.type]?.wonder && !e.constructing);
  if (wonder) {
    const pct = Math.round((wonder.charge || 0) * 100);
    const row = document.createElement("div");
    row.className = "sel-row";
    row.textContent = `Charging the galaxy jump — ${pct}%`;
    panelEl.appendChild(row);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Feeds on antimatter and shares your Reactor Power. At 100% the Gate fires and you win the galaxy — but razed mid-charge, the whole investment is lost, so defend it.";
    panelEl.appendChild(hint);
  }

  // Factory (Odyssey): a production building that converts raw hauls into refined
  // goods. Without this a selected Smelter reads only "420/420 hp" — the chain's
  // core loop is invisible. Show its recipe and, in colour, whether it's running
  // and why not (no Power / low Power / starved of an input).
  const factory = sel.find(e => e.kind === "building" && recipeOf(e) && !e.constructing);
  if (factory) {
    const recipe = recipeOf(factory);
    const inParts = Object.entries(recipe.in)
      .filter(([c]) => c !== "energy")
      .map(([c, q]) => `${q}${COM[c]?.ico || ""} ${COM[c]?.name || c}`).join(" + ");
    const energy = recipe.in.energy || 0;
    const recRow = document.createElement("div");
    recRow.className = "sel-row";
    recRow.textContent = `${inParts} → ${recipe.qty} ${COM[recipe.out]?.name || recipe.out}`
      + (energy ? ` · ⚡${energy}` : "");
    panelEl.appendChild(recRow);

    const st = factoryStatus(state, factory, recipe);
    const stRow = document.createElement("div");
    stRow.className = "sel-note " + st.cls;
    stRow.textContent = st.text;
    panelEl.appendChild(stRow);

    // Pause toggle: stop this factory drawing down its inputs (and Power) — the way to
    // keep a hungry Smelter from eating all your ore, or to free the grid for the Gate.
    panelEl.appendChild(makeButton(factory.paused ? "▶ Resume production" : "⏸ Pause production",
      () => { factory.paused = !factory.paused; },
      { tip: factory.paused ? "Resume converting inputs into goods"
                            : "Stop consuming inputs — banks and draws nothing until resumed" }));
  }

  // Plasma Rig (Odyssey): deep-core extraction. Say what it mines, how rich the seam is, its dig
  // progress + last strike, and why it's slow/stalled (out of nuclear, or a starved Power grid).
  const rig = sel.find(e => e.kind === "building" && BUILDINGS[e.type].rig && !e.constructing);
  if (rig) {
    const info = rigInfo(state, rig);
    const meta = COM[info.vein];
    const head = document.createElement("div");
    head.className = "sel-row";
    head.textContent = `⛏ Mining ${meta?.ico || ""} ${meta?.name || info.vein} · seam: ${info.richLabel}`;
    panelEl.appendChild(head);

    const progRow = document.createElement("div");
    progRow.className = "sel-note";
    progRow.textContent = `Dig ${Math.round(info.progress * 100)}%`
      + (info.lastTier ? ` · last strike: ${info.lastTier} (+${Math.round(info.lastYield)} ${meta?.name || info.vein})` : " · warming up…");
    panelEl.appendChild(progRow);

    let cls = "good", text = "Digging at full power";
    if (!info.nuclearOk) { cls = "bad"; text = "Stalled — out of radioactives (no nuclear to exploit)"; }
    else if (info.throttle <= 0) { cls = "bad"; text = "Stalled — no Power for the plasma arc (build a Reactor)"; }
    else if (info.throttle < 0.995) { cls = "warn"; text = `Throttled ${Math.round(info.throttle * 100)}% — low Power`; }
    const stRow = document.createElement("div");
    stRow.className = "sel-note " + cls;
    stRow.textContent = text;
    panelEl.appendChild(stRow);

    panelEl.appendChild(makeButton(rig.paused ? "▶ Resume digging" : "⏸ Pause digging",
      () => { rig.paused = !rig.paused; },
      { tip: rig.paused ? "Restart the plasma arc" : "Stop drawing Power and burning radioactives until resumed" }));
  }

  // Reactor (Odyssey): grants Power to the grid rather than running a recipe, so
  // it has no factory panel — say what it feeds and why it matters.
  const reactor = sel.find(e => e.kind === "building" && e.type === "reactor" && !e.constructing);
  if (reactor) {
    const row = document.createElement("div");
    row.className = "sel-note good";
    row.textContent = `Grants ⚡${BUILDINGS.reactor.energyGrants || 0} Power`;
    panelEl.appendChild(row);
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Powers your factories. If total draw outruns Power, every factory throttles — build more Reactors (or research Fusion Containment).";
    panelEl.appendChild(note);
  }

  // Spaceport (Odyssey): the interplanetary jump panel. Relocate the capital +
  // the units staged nearby to another world; the world you leave carries on as
  // a colony.
  const spaceport = sel.find(e => e.kind === "building" && e.type === "spaceport" && !e.constructing);
  if (spaceport && game.galaxy) {
    const m = jumpManifest(state, spaceport);   // capacity-capped preview: what lifts, what waits
    const tier = spaceportTier(spaceport);
    const vessel = jumpVessel(state);            // is a colony ship on the pad? (settles a NEW world) — a hint, not a gate

    const tierLine = document.createElement("div");
    tierLine.className = "sel-note good";
    tierLine.textContent = `Spaceport · Tier ${tier}/${SPACEPORT_MAX_TIER} · jump capacity ${m.capacity} supply`;
    panelEl.appendChild(tierLine);

    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = `Jump the fleet staged by the pad to another world — free to a world you already hold, fuel scaled by distance to reach a new one. A jump lifts up to ${m.capacity} supply (ship population); a larger fleet crosses in several jumps. Your bases here stay as a colony.`;
    panelEl.appendChild(info);

    // Staged-fleet manifest: total population vs the pad's capacity, and what waits for the next trip.
    const fleet = document.createElement("p");
    fleet.className = m.leftBehind > 0 ? "hint warn" : "hint";
    fleet.textContent = m.staged === 0
      ? "No units staged by the pad — a jump will carry only cargo. Park an army (to reinforce) or a Colony Ship (to settle) here to bring it."
      : m.leftBehind > 0
        ? `Fleet staged: ${m.stagedSupply} supply, ${m.staged} units. This jump lifts ${m.used}/${m.capacity} — ${m.leftBehind} unit${m.leftBehind === 1 ? "" : "s"} wait for the next trip (or upgrade the pad).`
        : `Fleet staged: ${m.stagedSupply}/${m.capacity} supply (${m.staged} units) — all fit in one jump.`;
    panelEl.appendChild(fleet);

    const shipHint = document.createElement("p");
    shipHint.className = "hint";
    shipHint.textContent = vessel
      ? "A Colony Ship is loaded — jump to a new world and deploy it to found a base."
      : "No Colony Ship on the pad: you can still hop to a world you hold (to control or reinforce it). To settle a NEW world, build a Colony Ship at a Command Center and park it here first.";
    panelEl.appendChild(shipHint);

    // Upgrade the launch pad (raises jump capacity) — an Odyssey fortification, like the Capital.
    if (tier < SPACEPORT_MAX_TIER) {
      const upCost = SPACEPORT_UPGRADE_COST[tier + 1];
      const nextCap = jumpCapacity({ tier: tier + 1 });
      panelEl.appendChild(makeButton(`⬆ Upgrade to Tier ${tier + 1} (${costText(upCost)}) — capacity ${nextCap}`,
        () => upgradeSpaceport(state, spaceport),
        { cost: upCost, icon: { kind: "building", type: "spaceport" },
          tip: `A bigger launch pad: jump capacity ${m.capacity} → ${nextCap} supply, so more of your fleet crosses per jump.` }));
    }

    // Cargo hold: manufactured goods ride in the CARGO SHIPS staged for this jump — the hold is
    // their combined capacity (build Haulers/Heavy Haulers/Bulk Freighters at a Command Center and
    // park them by the pad). Loaded most-valuable-first, up to that capacity.
    const capacity = freightCapacity(m.riders);
    const cargo = cargoManifest(state, capacity);
    const cargoTotal = Object.values(cargo).reduce((a, b) => a + b, 0);
    const cargoInfo = document.createElement("p");
    cargoInfo.className = "hint";
    cargoInfo.textContent = capacity === 0
      ? "Cargo hold: none — stage a cargo ship (Hauler / Heavy Hauler / Bulk Freighter) by the pad to haul goods."
      : cargoTotal
        ? `Cargo hold (${cargoTotal}/${capacity}): ${Object.entries(cargo).map(([c, q]) => `${q} ${c}`).join(", ")} — hauled to sell at the destination.`
        : `Cargo hold (0/${capacity}): empty — manufacture metals/alloys/electronics/machinery to fill your cargo ships.`;
    panelEl.appendChild(cargoInfo);
    for (const w of game.galaxy.worlds) {
      if (w === game.galaxy.activeId) continue;
      const name = planetName(w);
      const owned = game.galaxy.planets.has(w);   // a world you already hold → free to return
      const cost = jumpCost(game.galaxy, w);
      const afford = game.galaxy.credits >= cost;
      panelEl.appendChild(makeButton(`Jump ▸ ${name}${owned ? " · your colony" : ` · ◈${cost}`}`,
        () => performJump(w),
        { tip: owned ? "Hop to this world you already hold — free. Staged units ride along to control or reinforce it."
                     : "Settle new ground: carry the staged expedition here. Bring a Colony Ship to found a base.",
          locked: !afford,
          lockTip: `Need ◈${cost} fuel — you have ◈${Math.floor(game.galaxy.credits)}` }));
    }
  }

  // Colony ship (Odyssey): settle in place into a Command Center. Locked (with the
  // reason) when the current spot is blocked — move to clear ground and deploy.
  const colonyShip = sel.find(e => e.kind === "unit" && e.type === "colonyship");
  if (colonyShip && game.galaxy) {
    const blocked = !canPlaceBuilding(state, "command", colonyShip.x, colonyShip.y);
    panelEl.appendChild(makeButton("⛨ Deploy as Command Center",
      () => deployColonyShip(state, colonyShip.id),
      { locked: blocked, icon: { kind: "building", type: "command" },
        lockTip: blocked ? "Blocked here — move to open, buildable ground clear of buildings, nodes and rough terrain" : null,
        tip: "Settle: the colony ship becomes a Command Center on this spot (it can't move again). Colonists disembark as workers." }));
  }

  // Freighter (Odyssey cargo ship): a load/unload cargo panel for the first one selected.
  const freighter = game.galaxy && sel.find(e => e.kind === "unit" && UNITS[e.type].cargoHold);
  if (freighter) renderFreight(state, freighter);

  const worker = sel.find(e => e.kind === "unit" && e.type === "worker");
  if (worker && !input.building) {
    const buildBtn = t => {
      const def = BUILDINGS[t];
      const locked = !prereqsMet(state, "player", def);
      return prodButton(`Build ${def.name} (${costText(def.cost)})`,
        () => input.startBuild(t),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null, icon: { kind: "building", type: t } });
    };
    if (state.endless) {
      // Odyssey adds the Spaceport (jump pad) and the whole industry chain. You DON'T
      // build a Command Center here — new bases are founded by deploying a Colony Ship
      // (build one at a CC, move it, deploy). That's ~18 buildings — a flat list is a
      // wall — so group them by purpose. The entry tier of each group is always shown;
      // deeper buildings REVEAL as their prereqs are met (a greyed button per locked
      // tier would bury the menu), mirroring how the Barracks hides units you can't yet
      // field.
      const GROUPS = [
        ["Economy", ["reactor", "smelter", "datacenter", "assembler", "chipfab",
                     "machineworks", "antimatterforge", "aifoundry", "torpedoworks", "plasmarig"]],
        ["Military", ["barracks", "foundry", "arsenal", "refinery", "turret", "habitat", "stardock"]],
        ["Endgame", ["antimatter_gate"]],
        ["Travel", ["spaceport"]],
      ];
      const alwaysShow = new Set(["barracks", "foundry", "arsenal", "refinery", "turret",
                                  "habitat", "reactor", "smelter", "datacenter", "spaceport"]);
      for (const [title, types] of GROUPS) {
        const shown = types.filter(t => alwaysShow.has(t) || prereqsMet(state, "player", BUILDINGS[t]));
        if (!shown.length) continue;
        const head = document.createElement("div");
        head.className = "sel-group";
        head.textContent = title;
        panelEl.appendChild(head);
        for (const t of shown) panelEl.appendChild(buildBtn(t));
      }
    } else {
      // A skirmish still allows expansion CCs, has no Spaceport, and no industry.
      for (const t of ["barracks", "foundry", "arsenal", "refinery", "turret", "habitat", "command"])
        panelEl.appendChild(buildBtn(t));
    }
  }

  if (sel.some(e => e.kind === "unit")) {
    panelEl.appendChild(makeButton("Stop ( X )", () => input.stopSelected()));
  }
  if (sel.some(e => e.kind === "unit" && UNITS[e.type].role === "combat")) {
    // Attack-move as a button — the only way to arm it on touch (no A key), and a
    // discoverable one on desktop. Shows ARMED while waiting for the target tap.
    const amBtn = makeButton(input.attackArmed ? "Attack-Move: ARMED ( A )" : "Attack-Move ( A )",
      () => input.toggleAttackMove(),
      { tip: "Then tap the map: units advance and engage anything met on the way" });
    if (input.attackArmed) amBtn.classList.add("armed");
    panelEl.appendChild(amBtn);
    panelEl.appendChild(makeButton("Hold Position ( H )", () => input.holdSelected(),
      { tip: "Fire on anything in range, but hold ground — don't chase out of position" }));
  }
  const hasRanger = sel.some(e => e.kind === "unit" && UNITS[e.type].role === "scout");
  if (hasRanger) {
    panelEl.appendChild(makeButton("Scout Mode ( E )", () => input.scoutSelected(),
      { tip: "Auto-explore: the Ranger ranges toward the nearest unexplored ground on its own" }));
  }

  const touch = isTouchMode();
  if (input.building) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Tap the map to place it. Tap Build again to cancel."
                             : "Click the map to place it. Right-click to cancel.";
    panelEl.appendChild(hint);
  } else if (hasRanger) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Ranger: all-terrain, far sight. E / Scout Mode to auto-explore; tap the map to move it."
                             : "Ranger: all-terrain, far sight. E to auto-scout; right-click to move it yourself.";
    panelEl.appendChild(hint);
  } else if (sel.some(e => e.kind === "unit" && UNITS[e.type].role === "combat")) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Tap the map to move. Tap a foe to attack. Attack-Move advances and engages."
                             : "A + click to attack-move. Right-click moves (ignores enemies). Ctrl+right-click queues a waypoint.";
    panelEl.appendChild(hint);
  } else if (sel.length === 1 && (cc || barracks)) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = touch ? "Tap the map to set a rally point — tap a resource node to rally new workers onto it."
                             : "Right-click to set a rally point — right-click a resource node to rally new workers straight onto it.";
    panelEl.appendChild(hint);
  }
}

// "150 ore, 100 crystals" — renders any multi-commodity cost so buttons for
// crystal/radioactive-costed things read the same as the plain-ore ones.
function costText(cost) {
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

// A compact keyboard/mouse reference, shown when nothing is selected so the
// controls aren't hidden knowledge.
function controlsLegend() {
  const box = document.createElement("div");
  box.className = "legend";
  // Touch mode gets the finger legend; mouse/keyboard the desktop one.
  const rows = isTouchMode() ? [
    ["Tap unit", "select · double-tap = all of type"],
    ["Tap map", "move / attack / gather"],
    ["Drag", "box-select your units"],
    ["Two fingers", "pan · pinch to zoom"],
    ["Buttons", "Attack-Move · Stop · Hold · Scout"],
    ["Minimap", "tap to jump the view"],
    ["▾ handle", "hide / show this panel"],
    ["?", "all controls"],
  ] : [
    ["Left-drag", "select · Ctrl+drag adds"],
    ["Right-click", "move / attack / gather"],
    ["A + click", "attack-move"],
    ["Ctrl+right", "queue a waypoint"],
    ["Shift+1–9", "set group · 1–9 recall"],
    ["Double-click", "select all of that type"],
    ["Q · E · X · H", "army · scout · stop · hold"],
    ["Minimap", "left jumps · right orders"],
    ["Wheel", "zoom · arrows / edge-scroll pan"],
    ["F1 / ?", "all controls"],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="legend-row"><span class="legend-key">${k}</span><span>${v}</span></div>`).join("");
  return box;
}

// A build/produce/research button. When `cost` is given and the player can't
// afford it, the button greys out and a click just plays the denied buzz — so a
// broke click gives feedback instead of silently doing nothing (previously the
// only "can't" feedback was the supply block). `tip` becomes a hover tooltip.
function makeButton(label, onClick, { cost = null, tip = null, locked = false, lockTip = null, icon = null } = {}) {
  const { state } = game;
  const btn = document.createElement("button");
  btn.className = "btn";
  // An optional icon sits left of the label: a SPRITE ({kind,type}) — the actual unit/building
  // art the map draws — or an EMOJI ({emoji}) reused from the game's data icons (data.js COM /
  // FACTIONS, tech/doctrine icons), so a research or planet button reads at a glance too.
  let iconEl = null;
  if (icon && icon.emoji) {
    iconEl = document.createElement("span");
    iconEl.className = "btn-icon btn-emoji";
    iconEl.textContent = icon.emoji;
  } else if (icon && icon.kind && icon.type) {
    const url = spriteIcon(icon.kind, icon.type, state.players.player.color);
    if (url) { iconEl = document.createElement("img"); iconEl.className = "btn-icon"; iconEl.src = url; iconEl.alt = ""; }
  }
  if (iconEl) {
    btn.classList.add("has-icon");
    const span = document.createElement("span");
    span.className = "btn-label";
    span.textContent = label;
    btn.append(iconEl, span);
  } else {
    btn.textContent = label;
  }
  const tipText = locked && lockTip ? lockTip : (tip || "");
  btn.title = tipText;
  const affordable = !cost || canAfford(state.players.player.resources, cost);
  if (locked || !affordable) {
    btn.classList.add("disabled");   // a tech-locked or unaffordable option greys and just buzzes on click
    // On TOUCH there's no hover, so the reason a button is greyed is otherwise unreachable —
    // surface it on the tap that would just buzz. Prefer the BLOCK reason (the tech-lock, or
    // the affordability shortfall) over the stat tip, and use the dedicated hint channel, NOT
    // the capacity-limited galaxy-alert stack (colony alerts could otherwise suppress it).
    const reason = locked ? (lockTip || tip)
      : (!affordable ? `Not enough — needs ${costText(cost)}` : tip);
    btn.addEventListener("click", () => {
      sound.playProductionBlocked();
      if (isTouchMode() && reason) flashHint(reason);
    });
  } else {
    btn.addEventListener("click", () => { onClick(); renderHUD(); });
  }
  return btn;
}

// "Requires Foundry" style tooltip listing a def's unmet prerequisites by name.
// A prereq token is a building type, a doctrine upgrade, or a tech-tree node — the
// name lookup covers all three (prereqsMet resolves them the same way).
function lockTipFor(def) {
  return `Requires ${(def.requires || []).map(r => BUILDINGS[r]?.name || UPGRADES[r]?.name || TECHS[r]?.name || r).join(", ")}`;
}

// A compact stat line for a unit/building button tooltip.
function unitTip(def) {
  const bits = [`${def.hp} hp`];
  if (def.attack) bits.push(`${def.attack} dmg`, `rng ${def.range}`);
  if (def.repairRate) bits.push(`heals ${def.repairRate}/s`, `rng ${def.repairRange}`);
  if (def.cargoHold) bits.push(`cargo ${def.cargoHold}`);
  if (def.speed) bits.push(`spd ${def.speed}`);
  if (def.supplyCost) bits.push(`${def.supplyCost} supply`);
  if (def.supplyGrants) bits.push(`+${def.supplyGrants} supply`);
  if (def.dropOff || def.isCommandCenter) bits.push("resource drop-off");
  return bits.join(" · ");
}
