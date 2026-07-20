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
  starmapBtn, saveBtn, loadBtn,
} from "./dom.js";
import { queueProduction, cancelProduction, researchUpgrade } from "./engine/production.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { powerCap, powerDraw, recipeOf, powerThrottle, planetIndustryScale } from "./engine/industry.js";
import { TECHS, researchTech, techMult } from "./engine/techtree.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet, committedDoctrine } from "./engine/entities.js";
import { repairCost, repairConvoy, departNow } from "./engine/scenarios.js";
import { JUMP_COST, stagedRiders, cargoManifest, CARGO_CAPACITY } from "./engine/galaxy.js";
import { sell, buy, unitPrice, tradeables, TRADE_LOT } from "./engine/market.js";
import { stanceLabel, PEACE_THRESHOLD, offerTribute, tributeCost, APPEASE_TIME } from "./engine/diplomacy.js";
import { performJump } from "./boot.js";
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
export function resetPanelSignature() { lastPanelSignature = null; }

export function renderHUD() {
  const { state } = game;

  // The galaxy-map button shows only in Odyssey. Save/Load work in a skirmish and
  // in an Odyssey (whole-galaxy save), but a scripted scenario can't be resumed,
  // so they're hidden there.
  starmapBtn.classList.toggle("hidden", !game.galaxy);
  saveBtn.classList.toggle("hidden", !!state.scenario);
  loadBtn.classList.toggle("hidden", !!state.scenario);

  if (state.scenario) {
    // A scenario has no economy: its budget + clock live in the scenario bar,
    // so blank the skirmish readouts and drive the bar instead.
    resourcesEl.innerHTML = "";
    idleWorkersEl.classList.add("hidden");
    clockEl.textContent = "";
  } else {
    const res = state.players.player.resources;
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

    const used = supplyUsed(state, "player"), cap = supplyCap(state, "player");
    const supplySpan = document.createElement("span");
    supplySpan.className = "supply"
      + (used >= cap ? " at-cap" : "")
      + (performance.now() < game.supplyBlockedUntil ? " blocked" : "");
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
      const pCap = powerCap(state, "player"), pDraw = powerDraw(state, "player");
      if (pCap > 0 || pDraw > 0) {
        const pw = document.createElement("span");
        pw.className = "power" + (pDraw > pCap ? " at-cap" : "");
        pw.textContent = `⚡ ${Math.round(pDraw)}/${pCap}`;
        pw.title = "Industrial Power — Reactors grant it, factories draw it; short power throttles all production";
        resourcesEl.appendChild(pw);
      }

      // The neighbour's stance — it drifts hostile as this world's deposits run scarce.
      if (state.diplomacy) {
        const st = state.diplomacy.stance;
        const relSpan = document.createElement("span");
        relSpan.className = "relation " + (st <= PEACE_THRESHOLD ? "hostile" : st < 0.25 ? "neutral" : "friendly");
        relSpan.textContent = `neighbour: ${stanceLabel(st)}`;
        relSpan.title = "Your neighbour's stance — it turns hostile as this world's deposits run scarce";
        resourcesEl.appendChild(relSpan);
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
  renderSelectionPanel();
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
  return b && b.queue ? b.queue.map(j => j.unitType).join(",") : "";
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
        : "");

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
    label.textContent = `${com} ◈${Math.round(unitPrice(state.market, com, "sell"))}`;
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

// Why a selected factory is (or isn't) producing — the answer to "my antimatter
// isn't going up." Checks the same limits updateProduction (engine/industry.js)
// applies, in priority order: no Power at all, then a missing input, then a Power
// shortfall throttling everything, else running (with the live output rate).
function factoryStatus(state, b, recipe) {
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

function rebuildSelectionPanel(sel) {
  const { state, input } = game;
  panelEl.innerHTML = "";

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
    for (const [type, entry] of countByType(sel)) {
      const def = UNITS[type];
      const row = document.createElement("div");
      row.className = "sel-row";
      const pct = Math.round((entry.hp / entry.maxHp) * 100);
      row.textContent = `${entry.count}× ${def.name} — ${pct}% hp`;
      panelEl.appendChild(row);
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
    for (const t of ["worker", "ranger"]) {
      const def = UNITS[t];
      panelEl.appendChild(makeButton(`Produce ${def.name} (${costText(def.cost)})`,
        () => queueProduction(state, cc.id, t), { cost: def.cost, tip: unitTip(def) }));
    }
    if (cc.queue.length) renderQueueRows(cc);
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
      panelEl.appendChild(makeButton(`Produce ${def.name} (${costText(def.cost)})`,
        () => queueProduction(state, barracks.id, t),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null }));
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
        row.textContent = `${u.name} (${label[u.doctrine]}) — researched`;
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
        { cost: u.cost, tip: u.desc, locked, lockTip }));
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
      const head = TECHS[queue[0].techId];
      const row = document.createElement("div");
      row.className = "sel-row";
      row.textContent = `Researching ${head.name} — ${Math.round(queue[0].progress * 100)}%`
        + (queue.length > 1 ? ` (+${queue.length - 1} queued)` : "");
      panelEl.appendChild(row);
    }
    Object.values(TECHS).forEach(t => {
      if (upgrades[t.id]) {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = `${t.name} — researched`;
        panelEl.appendChild(row);
        return;
      }
      if (queued.has(t.id)) return;   // already lined up — reflected in the header's "+N queued"
      // Available if every prereq is researched, a completed building, or queued ahead.
      const ready = (t.requires || []).every(r => queued.has(r) || prereqsMet(state, "player", { requires: [r] }));
      panelEl.appendChild(makeButton(`Research ${t.name} (${costText(t.cost)})`,
        () => researchTech(state, datacenter.id, t.id),
        { cost: t.cost, tip: t.desc, locked: !ready, lockTip: !ready ? lockTipFor(t) : null }));
    });
  }

  // Star Dock (Odyssey): trains the Leviathan capital ship. Its own panel (not the
  // Barracks) because the Leviathan costs strategic goods that never sit on the map,
  // so the Barracks' on-map-cost filter would hide it.
  const stardock = sel.find(e => e.kind === "building" && e.type === "stardock" && !e.constructing);
  if (stardock) {
    const def = UNITS.leviathan;
    const locked = !prereqsMet(state, "player", def);
    panelEl.appendChild(makeButton(`Produce ${def.name} (${costText(def.cost)})`,
      () => queueProduction(state, stardock.id, "leviathan"),
      { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null }));
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
    const staged = stagedRiders(state, spaceport).length;
    const afford = game.galaxy.credits >= JUMP_COST;
    const info = document.createElement("p");
    info.className = "hint";
    info.textContent = `Relocate your capital to another world (◈${JUMP_COST} fuel). ${staged} unit${staged === 1 ? "" : "s"} staged by the pad will jump too — park units near the Spaceport to bring them.`;
    panelEl.appendChild(info);

    // Cargo hold: manufactured goods that ride along to be sold at the destination
    // (they price differently per world). Loaded most-valuable-first, up to capacity.
    const cargo = cargoManifest(state);
    const cargoTotal = Object.values(cargo).reduce((a, b) => a + b, 0);
    const cargoInfo = document.createElement("p");
    cargoInfo.className = "hint";
    cargoInfo.textContent = cargoTotal
      ? `Cargo hold (${cargoTotal}/${CARGO_CAPACITY}): ${Object.entries(cargo).map(([c, q]) => `${q} ${c}`).join(", ")} — hauled to sell at the destination.`
      : `Cargo hold (0/${CARGO_CAPACITY}): empty — manufacture metals/alloys/electronics/machinery to haul and sell elsewhere.`;
    panelEl.appendChild(cargoInfo);
    for (const w of game.galaxy.worlds) {
      if (w === game.galaxy.activeId) continue;
      const name = planetName(w);
      const visited = game.galaxy.planets.has(w) && w !== game.galaxy.activeId;
      panelEl.appendChild(makeButton(`Jump ▸ ${name}${visited ? " · your colony" : ""}`,
        () => performJump(w),
        { tip: "Relocate the Command Center and staged units to this world",
          locked: !afford, lockTip: `Need ◈${JUMP_COST} fuel — you have ◈${Math.floor(game.galaxy.credits)}` }));
    }
  }

  const worker = sel.find(e => e.kind === "unit" && e.type === "worker");
  if (worker && !input.building) {
    const buildBtn = t => {
      const def = BUILDINGS[t];
      const locked = !prereqsMet(state, "player", def);
      return makeButton(`Build ${def.name} (${costText(def.cost)})`,
        () => input.startBuild(t),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null });
    };
    if (state.endless) {
      // Odyssey gives you one relocatable Command Center (no second CC), so a Worker
      // instead builds the Spaceport (jump pad) plus the whole industry chain. That's
      // ~18 buildings — a flat list is a wall — so group them by purpose. The entry
      // tier of each group is always shown; deeper buildings REVEAL as their prereqs
      // are met (a greyed button per locked tier would bury the menu), mirroring how
      // the Barracks hides units you can't yet field.
      const GROUPS = [
        ["Economy", ["reactor", "smelter", "datacenter", "assembler", "chipfab",
                     "machineworks", "antimatterforge", "aifoundry", "torpedoworks"]],
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
function makeButton(label, onClick, { cost = null, tip = null, locked = false, lockTip = null } = {}) {
  const { state } = game;
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = label;
  btn.title = locked && lockTip ? lockTip : (tip || "");
  const affordable = !cost || canAfford(state.players.player.resources, cost);
  if (locked || !affordable) {
    btn.classList.add("disabled");   // a tech-locked or unaffordable option greys and just buzzes on click
    btn.addEventListener("click", () => sound.playProductionBlocked());
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
  if (def.speed) bits.push(`spd ${def.speed}`);
  if (def.supplyCost) bits.push(`${def.supplyCost} supply`);
  if (def.supplyGrants) bits.push(`+${def.supplyGrants} supply`);
  if (def.dropOff || def.isCommandCenter) bits.push("resource drop-off");
  return bits.join(" · ");
}
