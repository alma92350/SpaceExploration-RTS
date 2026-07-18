/* ============================================================
   Entry point: wires state, the fixed-timestep sim, rendering and input
   together. One skirmish, one planet, player vs scripted AI.
   ============================================================ */

"use strict";

import { createGameState } from "./engine/state.js";
import { createLoop } from "./engine/loop.js";
import { tick } from "./engine/sim.js";
import { queueProduction } from "./engine/production.js";
import { BUILDINGS, UNITS } from "./engine/entities.js";
import { MAP_WIDTH, MAP_HEIGHT } from "./engine/map.js";
import { drawFrame } from "./render.js";
import { attachInput } from "./input.js";

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");
const resourcesEl = document.getElementById("resources");
const clockEl = document.getElementById("matchClock");
const panelEl = document.getElementById("selectionPanel");
const gameOverEl = document.getElementById("gameOver");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = MAP_WIDTH * dpr;
  canvas.height = MAP_HEIGHT * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const state = createGameState({ planetId: "ferros" });
const input = attachInput(canvas, state, () => renderHUD());

let announced = false;
let lastHud = 0;
const loop = createLoop({
  update: dt => tick(state, dt),
  render: () => {
    drawFrame(ctx, state, input.getDragBox());
    const now = performance.now();
    if (now - lastHud > 150) { lastHud = now; renderHUD(); }
    if (state.over && !announced) { announced = true; loop.stop(); showGameOver(state.winner); }
  },
});
loop.start();
renderHUD();

function renderHUD() {
  const res = state.players.player.resources;
  resourcesEl.innerHTML = "";
  Object.entries(res).forEach(([com, qty]) => {
    const span = document.createElement("span");
    span.textContent = `${com}: ${Math.floor(qty)}`;
    resourcesEl.appendChild(span);
  });

  const mins = Math.floor(state.time / 60);
  const secs = Math.floor(state.time % 60).toString().padStart(2, "0");
  clockEl.textContent = `${mins}:${secs}`;

  renderSelectionPanel();
}

function renderSelectionPanel() {
  panelEl.innerHTML = "";
  const sel = state.selection.map(id => state.units.get(id) || state.buildings.get(id)).filter(Boolean);

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
  }

  const worker = sel.find(e => e.kind === "unit" && e.type === "worker");
  if (worker && !input.building) {
    panelEl.appendChild(makeButton(`Build Barracks (${BUILDINGS.barracks.cost.ore} ore)`, () => input.startBuild("barracks")));
  }

  if (input.building) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Click the map to place it. Right-click to cancel.";
    panelEl.appendChild(hint);
  }
}

function makeButton(label, onClick) {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.textContent = label;
  btn.addEventListener("click", () => { onClick(); renderHUD(); });
  return btn;
}

function showGameOver(winner) {
  gameOverEl.classList.remove("hidden");
  gameOverEl.textContent = winner === "player"
    ? "Victory — enemy Command Center destroyed."
    : "Defeat — your Command Center was destroyed.";
}
