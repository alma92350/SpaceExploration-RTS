/* ============================================================
   Entry point: a map-select screen picks which charted world to fight
   over, then wires up state, the fixed-timestep sim, rendering and
   input for that skirmish. Player vs scripted AI.
   ============================================================ */

"use strict";

import { createGameState } from "./engine/state.js";
import { mulberry32 } from "./engine/rng.js";
import { serializeGame, deserializeGame } from "./engine/persist.js";
import { createLoop } from "./engine/loop.js";
import { tick } from "./engine/sim.js";
import { queueProduction, cancelProduction, researchUpgrade } from "./engine/production.js";
import { issueMove, issueAttackMove } from "./engine/commands.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet, committedDoctrine } from "./engine/entities.js";
import { archetypeFor, PLANET_ARCHETYPE } from "./engine/aiArchetypes.js";
import { FACTIONS, PLAYABLE_FACTIONS } from "./engine/factions.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { PLANETS } from "./data.js";
import { drawFrame, resetFacing } from "./render.js";
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
const seedChipEl = document.getElementById("seedChip");
const factionChipEl = document.getElementById("factionChip");
const sheetToggleEl = document.getElementById("sheetToggle");
const idleWorkersEl = document.getElementById("idleWorkers");
const objectivesEl = document.getElementById("objectives");
idleWorkersEl.addEventListener("click", () => { if (input) input.focusIdleWorker(); });
const helpOverlayEl = document.getElementById("helpOverlay");
const helpBtn = document.getElementById("helpBtn");
const saveBtn = document.getElementById("saveBtn");
const loadBtn = document.getElementById("loadBtn");
const SAVE_KEY = "stellarfrontier.save.v1";

// Where the last under-attack alert fired — clicking the banner jumps there, so a
// raid on the far side of a big map is one click away instead of a frantic scroll.
let lastAttackAt = null;
underAttackEl.addEventListener("click", () => {
  if (!lastAttackAt || !input || !state) return;
  const cam = input.getCamera();
  cam.x = lastAttackAt.x;
  cam.y = lastAttackAt.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
});

muteBtn.addEventListener("click", () => {
  const next = !sound.isMuted();
  sound.setMuted(next);
  muteBtn.setAttribute("aria-pressed", String(next));
  muteBtn.textContent = next ? "🔇" : "🔊";
});

const volumeEl = document.getElementById("volume");
if (volumeEl) {
  volumeEl.addEventListener("input", () => sound.setVolume(Number(volumeEl.value) / 100));
}

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

// Portrait bottom-sheet collapse: hide the panel to reclaim the whole screen,
// then resize the canvas into the freed space. The button only shows in the
// portrait layout (style.css); the class is scoped to that layout too, so it's
// inert on desktop/landscape.
sheetToggleEl.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sheet-collapsed");
  sheetToggleEl.textContent = collapsed ? "▴" : "▾";
  requestAnimationFrame(resizeCanvas);   // the view grew/shrank — refit the backing store
});

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

// Right-click the minimap to command the current selection to that spot without
// scrolling the main view first — move for workers, attack-move for combat, so
// you can respond to a raid on a far flank straight from the map.
minimapCanvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (!state || !input) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const world = minimapToWorld(state.map, MINIMAP_W, MINIMAP_H, e.clientX - rect.left, e.clientY - rect.top);
  const selected = state.selection.map(id => state.units.get(id)).filter(Boolean);
  if (!selected.length) return;
  const combatants = selected.filter(u => UNITS[u.type].role === "combat");
  const others = selected.filter(u => UNITS[u.type].role !== "combat");
  if (combatants.length) issueAttackMove(combatants, world.x, world.y);
  if (others.length) issueMove(others, world.x, world.y);
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
// Difficulty bundles the two dials — how FAST the opponent acts (aiApm) and
// whether it MICROS its army (aiMicro: focus-fire, kiting, Ranger scouting) — into
// one Easy/Medium/Hard pick. Hard is the tactical opponent.
const DIFFICULTY_OPTIONS = [
  { label: "Easy", mult: "easy", note: "slow · no micro" },
  { label: "Medium", mult: "medium", note: "a fair fight" },
  { label: "Hard", mult: "hard", note: "fast · focus-fire · kite" },
];
const DIFFICULTY = {
  easy: { aiApm: 20, aiMicro: false },
  medium: { aiApm: 65, aiMicro: false },
  hard: { aiApm: 140, aiMicro: true },
};
// Playable factions for the setup picker — a passive-trait identity for your side
// (engine/factions.js). Each option's `mult` is the faction id, its note the short
// tagline of its edge. The AI's faction comes from the world's archetype instead.
const FACTION_OPTIONS = PLAYABLE_FACTIONS.map(id => ({
  label: FACTIONS[id].short, mult: id,
  note: { frontier: "faster · sees farther", miners: "richer · builds faster", syndicate: "hits harder · lean economy" }[id],
}));
const setup = { difficulty: "medium", faction: "frontier", sizeMult: 1, resourceMult: 1, seed: null };

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

  const diffRow = document.createElement("div");
  diffRow.className = "setup-row";
  const diffLabel = document.createElement("span");
  diffLabel.className = "setup-label";
  diffLabel.textContent = "Difficulty";
  diffRow.append(diffLabel, optionGroup(setup.difficulty, DIFFICULTY_OPTIONS, key => { setup.difficulty = key; }));
  panel.appendChild(diffRow);

  const hint = document.createElement("p");
  hint.className = "setup-hint";
  hint.textContent = "Easy is slow and holds formation; Medium fights at a fair pace; Hard is fast and micros its army — it focus-fires, kites, and scouts with a Ranger.";
  panel.appendChild(hint);

  const facRow = document.createElement("div");
  facRow.className = "setup-row";
  const facLabel = document.createElement("span");
  facLabel.className = "setup-label";
  facLabel.textContent = "Faction";
  facRow.append(facLabel, optionGroup(setup.faction, FACTION_OPTIONS, key => { setup.faction = key; renderFactionHint(); }));
  panel.appendChild(facRow);

  const facHint = document.createElement("p");
  facHint.className = "setup-hint";
  facHint.id = "factionHint";
  panel.appendChild(facHint);
  // Filled now and on every faction pick, so the blurb tracks the selection.
  function renderFactionHint() { facHint.textContent = FACTIONS[setup.faction].blurb; }
  renderFactionHint();

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

  // Optional seed: leave blank for a fresh random map, or enter a seed (shown on
  // the seed chip / game-over screen) to replay the exact same world.
  const seedRow = document.createElement("div");
  seedRow.className = "setup-row";
  const seedLabel = document.createElement("span");
  seedLabel.className = "setup-label";
  seedLabel.textContent = "Seed";
  const seedInput = document.createElement("input");
  seedInput.type = "text"; seedInput.inputMode = "numeric"; seedInput.className = "seed-input";
  seedInput.placeholder = "random";
  seedInput.value = setup.seed != null ? String(setup.seed) : "";
  seedInput.addEventListener("input", () => {
    const v = seedInput.value.trim();
    const n = Number.parseInt(v, 10);
    setup.seed = (v === "" || Number.isNaN(n)) ? null : (n >>> 0);
  });
  seedRow.append(seedLabel, seedInput);
  panel.appendChild(seedRow);

  return panel;
}

renderMapSelect();

function renderMapSelect() {
  mapSelectEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "Configure the skirmish";
  mapSelectEl.appendChild(title);

  // Offer to pick up a saved game before starting a fresh one.
  if (hasSave()) {
    const resume = document.createElement("button");
    resume.className = "btn resume-btn";
    resume.textContent = "▶ Resume saved game";
    resume.addEventListener("click", loadGame);
    mapSelectEl.appendChild(resume);
  }

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
  // Seed the sim so the match is reproducible: a player can note the seed and
  // re-enter it to replay the exact same map. The seed itself is drawn from the
  // UI layer (Math.random is fine here — it's not the sim); everything downstream
  // flows from the seeded mulberry32, so same seed ⇒ same world.
  const seed = (setup.seed != null ? setup.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
  const diff = DIFFICULTY[setup.difficulty] || DIFFICULTY.medium;
  // The player picks their faction; the AI's comes from this world's archetype
  // (aiArchetypes.js), so the opponent's identity is part of the world's character.
  const aiFaction = archetypeFor(planetId).faction || "neutral";
  const fresh = createGameState({ planetId, seed, rng: mulberry32(seed),
    aiApm: diff.aiApm, aiMicro: diff.aiMicro, sizeMult: setup.sizeMult, resourceMult: setup.resourceMult,
    playerFaction: setup.faction, aiFaction });
  bootState(fresh, { intro: true });
}

// Wire a state — freshly created OR loaded from a save — to input, camera, the
// fixed-timestep loop, and the HUD. The single boot path both startGame and
// loadGame funnel through.
function bootState(newState, { intro }) {
  if (loop) loop.stop();
  if (input) input.destroy();
  mapSelectEl.classList.add("hidden");
  gameOverEl.classList.add("hidden");
  underAttackEl.classList.add("hidden");
  clearTimeout(underAttackTimer);
  hideObjectives();

  state = newState;
  showSeedChip(state.seed);
  showFactionChip(state);
  if (intro) showObjectives();
  input = attachInput(canvas, state, () => renderHUD());
  // Open on the player's own base, not the map centre — on a big map the base
  // sits far off toward the edge and you'd otherwise start staring at nothing.
  const cam = input.getCamera();
  cam.x = state.map.bases.player.x;
  cam.y = state.map.bases.player.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
  resetEffects();
  resetFacing();
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

/* ---------- save / load (localStorage; the seed regenerates the map) ---------- */

function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
}
function saveGame() {
  if (!state) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serializeGame(state)));
    flashButton(saveBtn, "Saved ✓");
  } catch (e) {
    flashButton(saveBtn, "Save failed");
  }
}
function loadGame() {
  let raw = null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch (e) { /* storage blocked */ }
  if (!raw) { flashButton(loadBtn, "No save"); return; }
  try {
    sound.unlockAudio();
    bootState(deserializeGame(JSON.parse(raw)), { intro: false });
  } catch (e) {
    flashButton(loadBtn, "Load failed");
  }
}
function flashButton(btn, msg) {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = msg;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1100);
}
if (saveBtn) saveBtn.addEventListener("click", saveGame);
if (loadBtn) loadBtn.addEventListener("click", loadGame);

/* ---------- seed chip · objectives strip · help overlay ---------- */

function showSeedChip(seed) {
  seedChipEl.textContent = `Seed ${seed}`;
  seedChipEl.dataset.seed = String(seed);
  seedChipEl.classList.remove("hidden");
}

// "You: Frontier ⚔ Miners" — your faction vs the opponent's. Hidden for a
// neutral-vs-neutral match (a bare state with no factions picked).
function showFactionChip(st) {
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

// A one-time, dismissible strip at match start stating the goal and the core
// loop, so a first-time player isn't left guessing what to do. Auto-clears after
// the opening; pressing ? opens the full control sheet.
let objectivesTimer;
function showObjectives() {
  objectivesEl.innerHTML =
    `<span class="obj-goal">Objective — destroy every enemy Command Center.</span>`
    + `<span class="obj-tip">Workers gather ore → build a Barracks → train an army → <b>A</b> then click to attack-move it in. Press <b>?</b> for all controls.</span>`
    + `<button class="obj-close" title="Dismiss" aria-label="Dismiss">×</button>`;
  objectivesEl.classList.remove("hidden");
  objectivesEl.querySelector(".obj-close").addEventListener("click", hideObjectives);
  clearTimeout(objectivesTimer);
  objectivesTimer = setTimeout(hideObjectives, 30000);
}
function hideObjectives() {
  clearTimeout(objectivesTimer);
  objectivesEl.classList.add("hidden");
}

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
function buildHelpOverlay() {
  helpOverlayEl.innerHTML = `<div class="help-card"><h2>Controls &amp; Help</h2>`
    + `<h3 class="help-sub">Mouse &amp; keyboard</h3>${helpRows(HELP_ROWS)}`
    + `<h3 class="help-sub">Touch</h3>${helpRows(TOUCH_HELP_ROWS)}`
    + `<p class="help-dismiss">Press F1, ?, or Esc to close</p></div>`;
}
buildHelpOverlay();

// Touch mode: the first finger anywhere grows the tap targets (style.css) and
// switches the HUD hints to touch phrasing. input.js sets the class on a canvas
// touch too; doing it here covers a first touch that lands on a HUD button.
function isTouchMode() { return document.body.classList.contains("touch"); }
// Covers a first touch that lands on a HUD button (input.js sets the class on a
// canvas touch). The panel signature includes isTouchMode(), so the loop's next
// renderHUD rebuilds the legend/hints in touch phrasing on its own.
window.addEventListener("touchstart", () => {
  if (!isTouchMode()) document.body.classList.add("touch");
}, { passive: true });
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

// Stereo pan (-1..1) for a world-x, relative to the camera: a fight off the
// left edge of the view is heard on the left. Clamped, and flattened toward
// center for things near the middle so it isn't distractingly hard-panned.
function panFor(worldX) {
  if (!state || !input) return 0;
  const cam = input.getCamera();
  const halfW = canvas.clientWidth / (2 * cam.zoom) || 1;
  return Math.max(-1, Math.min(1, (worldX - cam.x) / halfW)) * 0.85;
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
    const pan = panFor(ev.x);   // stereo-place the sound by where it happened on screen
    switch (ev.type) {
      case "unitSpawned":
        sound.playUnitSpawned(pan);
        break;
      case "attackHit":
        (ev.heavy ? sound.playHeavyHit : sound.playAttackHit)(pan);
        addTracer(ev.fromX, ev.fromY, ev.x, ev.y, ev.unitType);
        if (ev.owner === "ai") triggerUnderAttack(ev.x, ev.y);
        break;
      case "entityKilled":
        sound.playEntityKilled(pan);
        addDeathFlash(ev.x, ev.y);
        break;
      case "buildingComplete":
        sound.playBuildingComplete(pan);
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
  lastAttackAt = { x, y };   // remembered even while throttled, so a click always jumps to the freshest hit
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

  // Idle-worker indicator: a lost worker on a big map is easy to miss, so surface
  // the count in the topbar (click, or `, to jump to the next one).
  let idle = 0;
  for (const u of state.units.values()) {
    if (u.owner === "player" && u.type === "worker" && !u.order && (!u.orderQueue || !u.orderQueue.length)) idle++;
  }
  idleWorkersEl.textContent = `⚒ ${idle} idle`;
  idleWorkersEl.classList.toggle("hidden", idle === 0);

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

// Fingerprint of what the player can currently afford and which completed
// buildings they hold — the two inputs to every button's greyed/locked state.
function availabilitySignature() {
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
    for (const t of ["skiff", "bastion", "lancer", "breacher", "dreadnought", "mender"]) {
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
    for (const t of ["barracks", "foundry", "arsenal", "refinery", "turret", "habitat", "command"]) {
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

function showGameOver(winner) {
  if (winner === "player") sound.playVictory(); else sound.playDefeat();

  gameOverEl.classList.remove("hidden");
  gameOverEl.innerHTML = "";

  const msg = document.createElement("div");
  msg.textContent = winner === "player"
    ? "Victory — the enemy's last Command Center is destroyed."
    : "Defeat — your last Command Center was destroyed.";
  gameOverEl.appendChild(msg);

  if (state && state.seed != null) {
    const seedLine = document.createElement("div");
    seedLine.className = "gameover-seed";
    seedLine.textContent = `Seed ${state.seed} — enter it on the setup screen to replay this map.`;
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
    renderMapSelect();
    mapSelectEl.classList.remove("hidden");
  });
  gameOverEl.appendChild(again);
}
