/* ============================================================
   Entry point: a map-select screen picks which charted world to fight
   over, then wires up state, the fixed-timestep sim, rendering and
   input for that skirmish. Player vs scripted AI.
   ============================================================ */

"use strict";

import { createGameState } from "./engine/state.js";
import { createLoop } from "./engine/loop.js";
import { tick } from "./engine/sim.js";
import { queueProduction, researchUpgrade } from "./engine/production.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { BUILDINGS, UNITS, UPGRADES } from "./engine/entities.js";
import { archetypeFor, PLANET_ARCHETYPE } from "./engine/aiArchetypes.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { PLANETS } from "./data.js";
import { drawFrame } from "./render.js";
import { attachInput } from "./input.js";
import { isVisibleAt } from "./engine/fog.js";
import * as sound from "./sound.js";

// The curated roster and its order both come from the AI archetype table, so
// the picker, the opponent temperament, and the tests all agree on one list.
const MAP_CHOICES = Object.keys(PLANET_ARCHETYPE);

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
const resourcesEl = document.getElementById("resources");
const clockEl = document.getElementById("matchClock");
const panelEl = document.getElementById("selectionPanel");
const gameOverEl = document.getElementById("gameOver");
const mapSelectEl = document.getElementById("mapSelect");
const muteBtn = document.getElementById("muteBtn");

muteBtn.addEventListener("click", () => {
  const next = !sound.isMuted();
  sound.setMuted(next);
  muteBtn.setAttribute("aria-pressed", String(next));
  muteBtn.textContent = next ? "🔇" : "🔊";
});

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

let state, input, loop, announced, lastHud, lastPanelSignature;
// Timestamp until which the supply readout flashes red after a blocked
// production attempt — see drainSoundEvents/renderHUD below.
let supplyBlockedUntil = 0;

renderMapSelect();

function renderMapSelect() {
  mapSelectEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "Choose a battlefield";
  mapSelectEl.appendChild(title);

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

  state = createGameState({ planetId });
  input = attachInput(canvas, state, () => renderHUD());
  announced = false;
  lastHud = 0;
  lastPanelSignature = null;
  supplyBlockedUntil = 0;
  let lastFrame = performance.now();

  loop = createLoop({
    update: dt => tick(state, dt),
    render: () => {
      const now = performance.now();
      input.tickCamera((now - lastFrame) / 1000);
      lastFrame = now;

      drawFrame(ctx, state, input.getCamera(), canvas.clientWidth, canvas.clientHeight, input.getDragBox());
      drainSoundEvents();
      if (now - lastHud > 150) { lastHud = now; renderHUD(); }
      if (state.over && !announced) { announced = true; loop.stop(); showGameOver(state.winner); }
    },
  });
  loop.start();
  renderHUD();
}

// A sim event plays a sound if it's the player's own, or if it happened
// somewhere currently visible — same "you can hear what you can see"
// rule as fog of war applies to rendering. Every AI-only skirmish
// happening off in the fogged dark stays silent.
function drainSoundEvents() {
  for (const ev of state.events) {
    if (ev.owner !== "player" && !isVisibleAt(state.fog, ev.x, ev.y)) continue;
    switch (ev.type) {
      case "unitSpawned": sound.playUnitSpawned(); break;
      case "attackHit": (ev.heavy ? sound.playHeavyHit : sound.playAttackHit)(); break;
      case "entityKilled": sound.playEntityKilled(); break;
      case "buildingComplete": sound.playBuildingComplete(); break;
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

function renderSelectionPanel() {
  const sel = state.selection.map(id => state.units.get(id) || state.buildings.get(id)).filter(Boolean);

  // Only rebuild the panel's DOM when the set of buttons it should show
  // would actually change (selection, or a building finishing
  // construction/entering build-placement mode). Rebuilding on every HUD
  // tick — even though hp numbers change constantly — replaced the exact
  // button the player was mid-click on with a fresh DOM node, and a
  // mouseup landing after that swap could drop the click entirely: felt
  // like only a sliver of the button was clickable, when really it was a
  // timing race, not a sizing one.
  const signature = sel.map(e => `${e.id}:${e.kind === "building" ? e.constructing : ""}`).join(",")
    + "|" + (input.building ? input.building.buildingType : "")
    + "|" + Object.keys(state.players.player.upgrades).sort().join(",");

  if (signature !== lastPanelSignature) {
    lastPanelSignature = signature;
    rebuildSelectionPanel(sel);
    return;
  }

  const rows = panelEl.querySelectorAll(".sel-row");
  sel.forEach((e, i) => {
    const def = e.kind === "unit" ? UNITS[e.type] : BUILDINGS[e.type];
    if (rows[i]) rows[i].textContent = `${def.name} — ${Math.ceil(e.hp)}/${e.maxHp} hp`;
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

  sel.forEach(e => {
    const def = e.kind === "unit" ? UNITS[e.type] : BUILDINGS[e.type];
    const row = document.createElement("div");
    row.className = "sel-row";
    row.textContent = `${def.name} — ${Math.ceil(e.hp)}/${e.maxHp} hp`;
    panelEl.appendChild(row);
  });

  const cc = sel.find(e => e.kind === "building" && e.type === "command" && !e.constructing);
  if (cc) {
    panelEl.appendChild(makeButton(`Produce Worker (${UNITS.worker.cost.ore} ore)`, () => queueProduction(state, cc.id, "worker")));
  }

  const barracks = sel.find(e => e.kind === "building" && e.type === "barracks" && !e.constructing);
  if (barracks) {
    panelEl.appendChild(makeButton(`Produce Skiff (${UNITS.skiff.cost.ore} ore)`, () => queueProduction(state, barracks.id, "skiff")));
    panelEl.appendChild(makeButton(`Produce Bastion (${UNITS.bastion.cost.ore} ore)`, () => queueProduction(state, barracks.id, "bastion")));
    panelEl.appendChild(makeButton(`Produce Lancer (${UNITS.lancer.cost.ore} ore)`, () => queueProduction(state, barracks.id, "lancer")));
    panelEl.appendChild(makeButton(`Produce Breacher (${costText(UNITS.breacher.cost)})`, () => queueProduction(state, barracks.id, "breacher")));
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
    hint.textContent = "Right-click to move (ignores enemies). Shift+right-click to attack-move.";
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
