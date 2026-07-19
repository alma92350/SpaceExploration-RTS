/* ============================================================
   Save / load to localStorage. Because the sim is deterministic and
   seed-driven, a save is just the serialized dynamic state (engine/persist.js);
   the map regenerates from the seed on load. Self-wires the Save / Load topbar
   buttons; the map-select "Resume saved game" button (setup.js) reuses hasSave
   and loadGame.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { saveBtn, loadBtn } from "./dom.js";
import { serializeGame, deserializeGame } from "./engine/persist.js";
import { bootState } from "./boot.js";
import * as sound from "./sound.js";

const SAVE_KEY = "stellarfrontier.save.v1";

export function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
}
function saveGame() {
  if (!game.state) return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serializeGame(game.state)));
    flashButton(saveBtn, "Saved ✓");
  } catch (e) {
    flashButton(saveBtn, "Save failed");
  }
}
export function loadGame() {
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
