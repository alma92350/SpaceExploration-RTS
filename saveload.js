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
import { saveBtn, loadBtn, homeBtn } from "./dom.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy } from "./engine/persist.js";
import { bootState, bootGalaxy, restartToMapSelect } from "./boot.js";
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

// Home button — return to the menu, first asking whether to save. A scenario can't be
// resumed, so it's a plain "leave?" confirm there; a skirmish/Odyssey offers Save & Exit.
// A lightweight modal built on the fly (Cancel / backdrop / Esc dismiss it).
function goHome() {
  const scenario = !!(game.state && game.state.scenario);

  const overlay = document.createElement("div");
  overlay.className = "home-confirm";
  const card = document.createElement("div");
  card.className = "home-card";
  const h = document.createElement("h2");
  h.textContent = scenario ? "Leave the mission?" : "Return to the menu?";
  const p = document.createElement("p");
  p.textContent = scenario
    ? "A scenario can't be saved — leaving abandons this run."
    : "Save your progress before you go?";
  const actions = document.createElement("div");
  actions.className = "home-actions";
  card.append(h, p, actions);
  overlay.appendChild(card);

  const close = () => { overlay.remove(); window.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const act = (label, fn, cls) => {
    const b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", () => { close(); fn(); });
    actions.appendChild(b);
  };

  if (!scenario) act("Save & Exit", () => { save(); restartToMapSelect(); }, "primary");
  act(scenario ? "Leave" : "Exit without Saving", () => restartToMapSelect(), scenario ? "primary" : "");
  act("Cancel", () => {}, "ghost");

  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

if (saveBtn) saveBtn.addEventListener("click", save);
if (loadBtn) loadBtn.addEventListener("click", load);
if (homeBtn) homeBtn.addEventListener("click", goHome);
