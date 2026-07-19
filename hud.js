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
} from "./dom.js";
import { queueProduction, cancelProduction, researchUpgrade } from "./engine/production.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet, committedDoctrine } from "./engine/entities.js";
import { repairCost, repairConvoy, departNow } from "./engine/scenarios.js";
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
      const span = document.createElement("span");
      span.textContent = `${com}: ${Math.floor(qty)}`;
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
    + "|" + isTouchMode();

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

  const worker = sel.find(e => e.kind === "unit" && e.type === "worker");
  if (worker && !input.building) {
    // Odyssey gives you one Command Center — your single relocatable capital — so
    // a second can't be built there; a skirmish still allows expansion CCs.
    const buildables = ["barracks", "foundry", "arsenal", "refinery", "turret", "habitat"];
    if (!state.endless) buildables.push("command");
    for (const t of buildables) {
      const def = BUILDINGS[t];
      const locked = !prereqsMet(state, "player", def);
      panelEl.appendChild(makeButton(`Build ${def.name} (${costText(def.cost)})`,
        () => input.startBuild(t),
        { cost: def.cost, tip: unitTip(def), locked, lockTip: locked ? lockTipFor(def) : null }));
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
function lockTipFor(def) {
  return `Requires ${(def.requires || []).map(r => BUILDINGS[r]?.name || UPGRADES[r]?.name || r).join(", ")}`;
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
