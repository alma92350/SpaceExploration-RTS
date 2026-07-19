/* ============================================================
   Entry point: a map-select screen picks which charted world to fight
   over, then wires up state, the fixed-timestep sim, rendering and
   input for that skirmish. Player vs scripted AI.
   ============================================================ */

"use strict";

import { createGameState } from "./engine/state.js";
import { createLoop } from "./engine/loop.js";
import { tick } from "./engine/sim.js";
import { queueProduction, cancelProduction, researchUpgrade } from "./engine/production.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { BUILDINGS, UNITS, UPGRADES } from "./engine/entities.js";
import { archetypeFor, PLANET_ARCHETYPE } from "./engine/aiArchetypes.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { PLANETS } from "./data.js";
import { drawFrame } from "./render.js";
import { attachInput } from "./input.js";
import { isVisibleAt } from "./engine/fog.js";
import { clampCamera } from "./camera.js";
import { drawMinimap, minimapToWorld } from "./minimap.js";
import { addTracer, addDeathFlash, addUnderAttackPing, resetEffects } from "./effects.js";
import * as sound from "./sound.js";

// The curated roster and its order both come from the AI archetype table, so
// the picker, the opponent temperament, and the tests all agree on one list.
const MAP_CHOICES = Object.keys(PLANET_ARCHETYPE);
const MINIMAP_W = 200, MINIMAP_H = 125;
const UNDER_ATTACK_THROTTLE_MS = 4000;
const UNDER_ATTACK_BANNER_MS = 2500;

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
const minimapCanvas = document.getElementById("minimap");
const minimapCtx = minimapCanvas.getContext("2d");
const resourcesEl = document.getElementById("resources");
const clockEl = document.getElementById("matchClock");
const panelEl = document.getElementById("selectionPanel");
const gameOverEl = document.getElementById("gameOver");
const mapSelectEl = document.getElementById("mapSelect");
const muteBtn = document.getElementById("muteBtn");
const underAttackEl = document.getElementById("underAttackAlert");

muteBtn.addEventListener("click", () => {
  const next = !sound.isMuted();
  sound.setMuted(next);
  muteBtn.setAttribute("aria-pressed", String(next));
  muteBtn.textContent = next ? "🔇" : "🔊";
});

// Right-click is a game command (move / attack / gather / queue a waypoint),
// so the browser's own context menu must never pop over the game. The canvas
// already suppresses it for clicks that land squarely on it, but the view has
// padding around the canvas and the minimap sits on top of it — a right-click
// on either of those would otherwise open the native menu. One window-level
// listener covers the whole window in one place.
window.addEventListener("contextmenu", e => e.preventDefault());

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function resizeMinimap() {
  const dpr = window.devicePixelRatio || 1;
  minimapCanvas.width = MINIMAP_W * dpr;
  minimapCanvas.height = MINIMAP_H * dpr;
  minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeMinimap);
resizeMinimap();

let state, input, loop, announced, lastHud, lastPanelSignature, lastUnderAttackAt, underAttackTimer;
// Timestamp until which the supply readout flashes red after a blocked
// production attempt — see drainSoundEvents/renderHUD below.
let supplyBlockedUntil = 0;

// Attached once, not per-game: state/input are read fresh from the outer
// closure at click time, so this stays correct across a "choose another
// battlefield" restart without needing to re-wire on every startGame().
minimapCanvas.addEventListener("click", e => {
  if (!state || !input) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const world = minimapToWorld(state.map, MINIMAP_W, MINIMAP_H, e.clientX - rect.left, e.clientY - rect.top);
  const camera = input.getCamera();
  camera.x = world.x;
  camera.y = world.y;
  clampCamera(camera, state.map, canvas.clientWidth, canvas.clientHeight);
});

// Splash-screen game setup, carried across "choose another battlefield"
// restarts. sizeMult scales the map (map.js); resourceMult scales every
// deposit's amount; aiApm caps the opponent's actions per minute (ai.js).
const SIZE_OPTIONS = [
  { label: "Small", mult: 1, note: "1600×1000" },
  { label: "Standard", mult: 2, note: "2× · room to expand" },
  { label: "Large", mult: 3, note: "3× · long game" },
  { label: "Gigantic", mult: 4, note: "4× · sprawling war" },
];
const RESOURCE_OPTIONS = [
  { label: "Rare", mult: 0.6, note: "lean deposits" },
  { label: "Normal", mult: 1.0, note: "balanced" },
  { label: "Abundant", mult: 1.5, note: "rich deposits" },
];
const setup = { aiApm: 60, sizeMult: 1, resourceMult: 1 };

function apmDescriptor(apm) {
  if (apm <= 20) return "Sluggish";
  if (apm <= 55) return "Casual";
  if (apm <= 100) return "Sharp";
  return "Relentless";
}

// A one-of-N pick rendered as a row of buttons; clicking one selects it and
// stores its value via onPick.
function optionGroup(current, options, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "opt-group";
  options.forEach(opt => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn" + (opt.mult === current ? " active" : "");
    btn.innerHTML = `<span class="opt-label">${opt.label}</span><span class="opt-note">${opt.note}</span>`;
    btn.addEventListener("click", () => {
      onPick(opt.mult);
      wrap.querySelectorAll(".opt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function renderSetupPanel() {
  const panel = document.createElement("div");
  panel.className = "setup";

  const apmRow = document.createElement("div");
  apmRow.className = "setup-row";
  const apmLabel = document.createElement("span");
  apmLabel.className = "setup-label";
  apmLabel.textContent = "AI speed";
  const slider = document.createElement("input");
  slider.type = "range"; slider.min = "1"; slider.max = "150"; slider.step = "1";
  slider.value = String(setup.aiApm); slider.className = "apm-slider";
  const apmValue = document.createElement("span");
  apmValue.className = "setup-value";
  const showApm = () => { apmValue.textContent = `${setup.aiApm} APM · ${apmDescriptor(setup.aiApm)}`; };
  showApm();
  slider.addEventListener("input", () => { setup.aiApm = Number(slider.value); showApm(); });
  apmRow.append(apmLabel, slider, apmValue);
  panel.appendChild(apmRow);

  const hint = document.createElement("p");
  hint.className = "setup-hint";
  hint.textContent = "Actions per minute the opponent can take — a click, a selection, a command. 1 is a crawl; 150 is relentless.";
  panel.appendChild(hint);

  const sizeRow = document.createElement("div");
  sizeRow.className = "setup-row";
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "setup-label";
  sizeLabel.textContent = "Map size";
  sizeRow.append(sizeLabel, optionGroup(setup.sizeMult, SIZE_OPTIONS, m => { setup.sizeMult = m; }));
  panel.appendChild(sizeRow);

  const resRow = document.createElement("div");
  resRow.className = "setup-row";
  const resLabel = document.createElement("span");
  resLabel.className = "setup-label";
  resLabel.textContent = "Resources";
  resRow.append(resLabel, optionGroup(setup.resourceMult, RESOURCE_OPTIONS, m => { setup.resourceMult = m; }));
  panel.appendChild(resRow);

  return panel;
}

renderMapSelect();

function renderMapSelect() {
  mapSelectEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "Configure the skirmish";
  mapSelectEl.appendChild(title);

  mapSelectEl.appendChild(renderSetupPanel());

  const subtitle = document.createElement("h3");
  subtitle.className = "cards-heading";
  subtitle.textContent = "Then choose a battlefield";
  mapSelectEl.appendChild(subtitle);

  const cards = document.createElement("div");
  cards.className = "cards";
  MAP_CHOICES.forEach(id => {
    const planet = PLANETS.find(p => p.id === id);
    const mod = PLANET_MODIFIERS[id];
    const card = document.createElement("button");
    card.className = "map-card";
    // Each card advertises who you're up against (the archetype's temperament)
    // and how the world itself bends the fight (its modifier, if any), so the
    // choice of battlefield is an informed one rather than just flavor text.
    card.innerHTML = `<span class="name">${planet.name}</span><span class="tag">${planet.tag}</span><span class="desc">${planet.desc}</span>`
      + `<span class="ai-note">Opponent doctrine: ${archetypeFor(id).name}</span>`
      + (mod ? `<span class="mod-note">${mod.label}</span>` : "");
    card.addEventListener("click", () => {
      sound.unlockAudio();   // this click is a real user gesture, so it's safe to start the AudioContext here
      mapSelectEl.classList.add("hidden");
      startGame(id);
    });
    cards.appendChild(card);
  });
  mapSelectEl.appendChild(cards);
}

function startGame(planetId) {
  if (loop) loop.stop();
  if (input) input.destroy();
  gameOverEl.classList.add("hidden");
  underAttackEl.classList.add("hidden");
  clearTimeout(underAttackTimer);

  state = createGameState({ planetId, aiApm: setup.aiApm, sizeMult: setup.sizeMult, resourceMult: setup.resourceMult });
  input = attachInput(canvas, state, () => renderHUD());
  // Open on the player's own base, not the map centre — on a big map the base
  // sits far off toward the edge and you'd otherwise start staring at nothing.
  const cam = input.getCamera();
  cam.x = state.map.bases.player.x;
  cam.y = state.map.bases.player.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
  resetEffects();
  announced = false;
  lastHud = 0;
  lastPanelSignature = null;
  lastUnderAttackAt = -Infinity;
  supplyBlockedUntil = 0;
  let lastFrame = performance.now();

  loop = createLoop({
    update: dt => tick(state, dt),
    render: () => {
      const now = performance.now();
      input.tickCamera((now - lastFrame) / 1000);
      lastFrame = now;

      drawFrame(ctx, state, input.getCamera(), canvas.clientWidth, canvas.clientHeight, input.getDragBox(), input.getBuildGhost());
      drawMinimap(minimapCtx, state, input.getCamera(), canvas.clientWidth, canvas.clientHeight, MINIMAP_W, MINIMAP_H);
      processFrameEvents();
      if (now - lastHud > 150) { lastHud = now; renderHUD(); }
      if (state.over && !announced) { announced = true; loop.stop(); showGameOver(state.winner); }
    },
  });
  loop.start();
  renderHUD();
}

// A sim event plays a sound (and spawns a matching visual effect — see
// effects.js) if it's the player's own, or if it happened somewhere
// currently visible — same "you can hear what you can see" rule as fog
// of war applies to rendering. Every AI-only skirmish happening off in
// the fogged dark stays silent. An attackHit whose attacker is the AI
// necessarily means the target is the player's (only two sides exist),
// so that's also the under-attack alert's trigger.
function processFrameEvents() {
  for (const ev of state.events) {
    if (ev.owner !== "player" && !isVisibleAt(state.fog, ev.x, ev.y)) continue;
    switch (ev.type) {
      case "unitSpawned":
        sound.playUnitSpawned();
        break;
      case "attackHit":
        (ev.heavy ? sound.playHeavyHit : sound.playAttackHit)();
        addTracer(ev.fromX, ev.fromY, ev.x, ev.y, ev.unitType);
        if (ev.owner === "ai") triggerUnderAttack(ev.x, ev.y);
        break;
      case "entityKilled":
        sound.playEntityKilled();
        addDeathFlash(ev.x, ev.y);
        break;
      case "buildingComplete":
        sound.playBuildingComplete();
        break;
      // Only the player's own supply block beeps and flashes — a visible
      // enemy stalling on supply is their problem, not a HUD alert of ours.
      case "productionBlocked":
        if (ev.owner === "player") {
          sound.playProductionBlocked();
          supplyBlockedUntil = performance.now() + 800;
        }
        break;
    }
  }
  state.events.length = 0;
}

// Throttled independently of sound.js's own internal throttle (which
// only governs the alarm tone) so the banner and the minimap/world ping
// stay in lockstep with each other during a sustained siege instead of
// re-flashing on every single hit.
function triggerUnderAttack(x, y) {
  const now = performance.now();
  if (now - lastUnderAttackAt < UNDER_ATTACK_THROTTLE_MS) return;
  lastUnderAttackAt = now;

  sound.playUnderAttack();
  addUnderAttackPing(x, y);
  underAttackEl.classList.remove("hidden");
  clearTimeout(underAttackTimer);
  underAttackTimer = setTimeout(() => underAttackEl.classList.add("hidden"), UNDER_ATTACK_BANNER_MS);
}

function renderHUD() {
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
    + (performance.now() < supplyBlockedUntil ? " blocked" : "");
  supplySpan.textContent = `supply: ${used}/${cap}`;
  resourcesEl.appendChild(supplySpan);

  const mins = Math.floor(state.time / 60);
  const secs = Math.floor(state.time % 60).toString().padStart(2, "0");
  clockEl.textContent = `${mins}:${secs}`;

  renderSelectionPanel();
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

function renderSelectionPanel() {
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
    + "|" + queueSignature(sel);

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
  panelEl.innerHTML = "";

  if (!sel.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Drag-select units, or click a building.";
    panelEl.appendChild(hint);
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
    panelEl.appendChild(makeButton(`Produce Worker (${UNITS.worker.cost.ore} ore)`, () => queueProduction(state, cc.id, "worker")));
    if (cc.queue.length) renderQueueRows(cc);
  }

  const barracks = sel.find(e => e.kind === "building" && e.type === "barracks" && !e.constructing);
  if (barracks) {
    panelEl.appendChild(makeButton(`Produce Skiff (${UNITS.skiff.cost.ore} ore)`, () => queueProduction(state, barracks.id, "skiff")));
    panelEl.appendChild(makeButton(`Produce Bastion (${UNITS.bastion.cost.ore} ore)`, () => queueProduction(state, barracks.id, "bastion")));
    panelEl.appendChild(makeButton(`Produce Lancer (${UNITS.lancer.cost.ore} ore)`, () => queueProduction(state, barracks.id, "lancer")));
    panelEl.appendChild(makeButton(`Produce Breacher (${costText(UNITS.breacher.cost)})`, () => queueProduction(state, barracks.id, "breacher")));
    if (barracks.queue.length) renderQueueRows(barracks);
  }

  const refinery = sel.find(e => e.kind === "building" && e.type === "refinery" && !e.constructing);
  if (refinery) {
    const upgrades = state.players.player.upgrades;
    Object.values(UPGRADES).forEach(u => {
      if (upgrades[u.id]) {
        const row = document.createElement("div");
        row.className = "sel-row";
        row.textContent = `${u.name} — researched`;
        panelEl.appendChild(row);
      } else {
        panelEl.appendChild(makeButton(`Research ${u.name} (${costText(u.cost)})`, () => researchUpgrade(state, refinery.id, u.id)));
      }
    });
  }

  const worker = sel.find(e => e.kind === "unit" && e.type === "worker");
  if (worker && !input.building) {
    panelEl.appendChild(makeButton(`Build Barracks (${BUILDINGS.barracks.cost.ore} ore)`, () => input.startBuild("barracks")));
    panelEl.appendChild(makeButton(`Build Refinery (${BUILDINGS.refinery.cost.ore} ore)`, () => input.startBuild("refinery")));
    panelEl.appendChild(makeButton(`Build Turret (${costText(BUILDINGS.turret.cost)})`, () => input.startBuild("turret")));
    panelEl.appendChild(makeButton(`Build Habitat (${BUILDINGS.habitat.cost.ore} ore)`, () => input.startBuild("habitat")));
    panelEl.appendChild(makeButton(`Build Command Center (${BUILDINGS.command.cost.ore} ore)`, () => input.startBuild("command")));
  }

  if (input.building) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Click the map to place it. Right-click to cancel.";
    panelEl.appendChild(hint);
  } else if (sel.some(e => e.kind === "unit" && UNITS[e.type].role === "combat")) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Right-click to move (ignores enemies). Ctrl+right-click to queue a waypoint.";
    panelEl.appendChild(hint);
  } else if (sel.length === 1 && (cc || barracks)) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Right-click the map to set its rally point.";
    panelEl.appendChild(hint);
  }
}

// "150 ore, 100 crystals" — renders any multi-commodity cost so buttons for
// crystal/radioactive-costed things read the same as the plain-ore ones.
function costText(cost) {
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

function makeButton(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = label;
  btn.addEventListener("click", () => { onClick(); renderHUD(); });
  return btn;
}

function showGameOver(winner) {
  if (winner === "player") sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  const msg = document.createElement("div");
  msg.textContent = winner === "player"
    ? "Victory — the enemy's last Command Center is destroyed."
    : "Defeat — your last Command Center was destroyed.";
  gameOverEl.appendChild(msg);

  const again = document.createElement("button");
  again.className = "btn";
  again.style.width = "auto";
  again.style.padding = "10px 20px";
  again.style.marginTop = "16px";
  again.textContent = "Choose another battlefield";
  again.addEventListener("click", () => {
    gameOverEl.classList.add("hidden");
    renderMapSelect();
    mapSelectEl.classList.remove("hidden");
  });
  gameOverEl.appendChild(again);
}
