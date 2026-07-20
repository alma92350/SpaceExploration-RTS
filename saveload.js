/* ============================================================
   Save / load to localStorage. Because the sim is deterministic and
   seed-driven, a save is just the serialized dynamic state (engine/persist.js);
   the map regenerates from the seed on load. The topbar Save / Load buttons
   branch on the mode: a skirmish saves/loads a single state (SAVE_KEY); an
   Odyssey saves/loads the whole galaxy (ODYSSEY_KEY). The map-select "Resume"
   buttons (setup.js) reuse hasSave/loadGame (skirmish) and
   hasOdysseySave/loadOdyssey (Odyssey).
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { saveBtn, loadBtn } from "./dom.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy } from "./engine/persist.js";
import { bootState, bootGalaxy } from "./boot.js";
import * as sound from "./sound.js";

const SAVE_KEY = "stellarfrontier.save.v1";
const ODYSSEY_KEY = "stellarfrontier.odyssey.v1";

const read = key => { try { return localStorage.getItem(key); } catch (e) { return null; } };

export function hasSave() { return !!read(SAVE_KEY); }
export function hasOdysseySave() { return !!read(ODYSSEY_KEY); }

// Save button — routes to the galaxy or single-state serializer by mode.
function save() {
  try {
    if (game.galaxy) localStorage.setItem(ODYSSEY_KEY, JSON.stringify(serializeGalaxy(game.galaxy)));
    else if (game.state) localStorage.setItem(SAVE_KEY, JSON.stringify(serializeGame(game.state)));
    else return;
    flashButton(saveBtn, "Saved ✓");
  } catch (e) {
    flashButton(saveBtn, "Save failed");
  }
}

// Load an Odyssey galaxy from storage (topbar Load in Odyssey, or the setup
// "Resume Odyssey" button).
export function loadOdyssey() {
  const raw = read(ODYSSEY_KEY);
  if (!raw) { flashButton(loadBtn, "No save"); return; }
  try {
    sound.unlockAudio();
    bootGalaxy(deserializeGalaxy(JSON.parse(raw)), { intro: false });
  } catch (e) {
    flashButton(loadBtn, "Load failed");
  }
}

// Load a single skirmish from storage (topbar Load in a skirmish, or the setup
// "Resume saved game" button).
export function loadGame() {
  const raw = read(SAVE_KEY);
  if (!raw) { flashButton(loadBtn, "No save"); return; }
  try {
    sound.unlockAudio();
    bootState(deserializeGame(JSON.parse(raw)), { intro: false });
  } catch (e) {
    flashButton(loadBtn, "Load failed");
  }
}

// Topbar Load — routes by the current mode.
function load() { if (game.galaxy) loadOdyssey(); else loadGame(); }

function flashButton(btn, msg) {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = msg;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1100);
}
if (saveBtn) saveBtn.addEventListener("click", save);
if (loadBtn) loadBtn.addEventListener("click", load);
