/* ============================================================
   Every DOM handle the UI reaches for, resolved once, in one place — so the
   split-out UI modules (hud, setup, overlays, save, boot) share the exact same
   element references instead of each re-querying the document. Plus the two
   minimap-canvas dimension constants and the touch-mode predicate, which several
   modules read.
   ============================================================ */

"use strict";

export const canvas = document.getElementById("field");
export const ctx = canvas.getContext("2d");
export const minimapCanvas = document.getElementById("minimap");
export const minimapCtx = minimapCanvas.getContext("2d");
export const resourcesEl = document.getElementById("resources");
export const clockEl = document.getElementById("matchClock");
export const panelEl = document.getElementById("selectionPanel");
export const gameOverEl = document.getElementById("gameOver");
export const mapSelectEl = document.getElementById("mapSelect");
export const muteBtn = document.getElementById("muteBtn");
export const underAttackEl = document.getElementById("underAttackAlert");
export const seedChipEl = document.getElementById("seedChip");
export const factionChipEl = document.getElementById("factionChip");
export const sheetToggleEl = document.getElementById("sheetToggle");
export const idleWorkersEl = document.getElementById("idleWorkers");
export const objectivesEl = document.getElementById("objectives");
export const helpOverlayEl = document.getElementById("helpOverlay");
export const helpBtn = document.getElementById("helpBtn");
export const saveBtn = document.getElementById("saveBtn");
export const loadBtn = document.getElementById("loadBtn");
export const volumeEl = document.getElementById("volume");
export const scenarioBarEl = document.getElementById("scenarioBar");
export const scenarioBannerEl = document.getElementById("scenarioBanner");
export const scenarioStatusEl = document.getElementById("scenarioStatus");
export const repairBtn = document.getElementById("repairBtn");
export const departBtn = document.getElementById("departBtn");

export const MINIMAP_W = 200, MINIMAP_H = 125;

// Touch mode is a body-class flag (set by the first touch — see input.js and
// main.js). Read by hud (legend/hints phrasing) and overlays.
export function isTouchMode() { return document.body.classList.contains("touch"); }
