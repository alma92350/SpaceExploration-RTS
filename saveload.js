/* ============================================================
   Save / load. Because the sim is deterministic and seed-driven, a save is just
   the serialized dynamic state (engine/persist.js); the map regenerates from the
   seed on load. Two channels, by design:

     • The topbar Save / Load buttons move a save to and from a FILE — an explicit
       backup/transfer you keep on disk (download a .json, or pick one to import).
     • AutoSave keeps the CURRENT game in browser localStorage on a timer (and on
       tab-hide / unload), so the map-select "Continue" buttons (setup.js) can
       resume exactly where you left off without any manual save.

   Both channels branch on the mode: a skirmish is a single state (SAVE_KEY /
   serializeGame); an Odyssey is the whole galaxy (ODYSSEY_KEY / serializeGalaxy).
   A file import auto-detects which by shape (a galaxy carries `planets`).
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { saveBtn, loadBtn, homeBtn } from "./dom.js";
import { serializeGame, deserializeGame, serializeGalaxy, deserializeGalaxy } from "./engine/persist.js";
import { bootState, bootGalaxy, restartToMapSelect, pauseLoop, resumeLoop } from "./boot.js";
import * as sound from "./sound.js";

const SAVE_KEY = "stellarfrontier.save.v1";
const ODYSSEY_KEY = "stellarfrontier.odyssey.v1";
const AUTOSAVE_INTERVAL_MS = 12000;   // how often the current game is checkpointed to localStorage
const MAX_SAVE_BYTES = 8 * 1024 * 1024;   // reject an implausibly large import before parsing it (a real save is ≪ this)

const read = key => { try { return localStorage.getItem(key); } catch (e) { return null; } };

export function hasSave() { return !!read(SAVE_KEY); }
export function hasOdysseySave() { return !!read(ODYSSEY_KEY); }

// The save-format version of each stored save (null when absent/unparseable) — used by the
// update check (version.js saveImpact) to tell the player whether a new release keeps their data.
export function storedSaveVersions() {
  const ver = raw => { try { const o = JSON.parse(raw); return typeof o?.v === "number" ? o.v : null; } catch (e) { return null; } };
  const s = read(SAVE_KEY), o = read(ODYSSEY_KEY);
  return { skirmish: s ? ver(s) : null, odyssey: o ? ver(o) : null };
}

/* ---------- localStorage: the automatic checkpoint (resume) ---------- */

// Serialize the current game to a plain object, by mode — or null when there's
// nothing resumable (no game, a finished one, or a scripted scenario, which can't
// be saved). One place both channels agree on what "the current game" is.
function snapshot() {
  if (!game.state || game.state.over || game.state.scenario) return null;
  return game.galaxy
    ? { key: ODYSSEY_KEY, mode: "odyssey", data: serializeGalaxy(game.galaxy) }
    : { key: SAVE_KEY, mode: "skirmish", data: serializeGame(game.state) };
}

// Checkpoint the current game to localStorage. Cheap and safe to call often. Returns
// true on a successful write, false when there's nothing to save OR the write throws
// (quota exceeded, or Safari/Firefox private mode where setItem always throws). The
// periodic/hidden/unload callers ignore the result — the next tick is their fallback —
// but "Save & Exit" checks it, because silently swallowing a failure there would tell
// the player their game was checkpointed and then strand them with nothing to Continue.
export function autoSave() {
  const snap = snapshot();
  if (!snap) return false;
  try { localStorage.setItem(snap.key, JSON.stringify(snap.data)); return true; }
  catch (e) { return false; }
}

// Resume the autosaved Odyssey galaxy from localStorage (topbar-less; used by the
// setup "Continue Odyssey" button).
export function loadOdyssey() {
  const raw = read(ODYSSEY_KEY);
  if (!raw) { flashButton(loadBtn, "No save"); return; }
  try {
    sound.unlockAudio();
    bootGalaxy(deserializeGalaxy(JSON.parse(raw)), { intro: false });
  } catch (e) { flashButton(loadBtn, "Load failed"); }
}

// Resume the autosaved skirmish from localStorage (setup "Continue" button).
export function loadGame() {
  const raw = read(SAVE_KEY);
  if (!raw) { flashButton(loadBtn, "No save"); return; }
  try {
    sound.unlockAudio();
    bootState(deserializeGame(JSON.parse(raw)), { intro: false });
  } catch (e) { flashButton(loadBtn, "Load failed"); }
}

/* ---------- file: the explicit backup/transfer (Save / Load buttons) ---------- */

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Save button — download the current game as a .json file (galaxy or skirmish).
function saveToFile() {
  try {
    if (game.galaxy) {
      downloadJSON(`stellar-frontier-odyssey-${stamp()}.json`, serializeGalaxy(game.galaxy));
    } else if (game.state) {
      downloadJSON(`stellar-frontier-skirmish-seed${game.state.seed}-${stamp()}.json`, serializeGame(game.state));
    } else { flashButton(saveBtn, "No game"); return; }
    flashButton(saveBtn, "Saved ✓");
  } catch (e) { flashButton(saveBtn, "Save failed"); }
}

// Boot a parsed save, auto-detecting the mode by shape — a galaxy carries `planets`.
function importSave(parsed) {
  sound.unlockAudio();
  if (parsed && Array.isArray(parsed.planets)) bootGalaxy(deserializeGalaxy(parsed), { intro: false });
  else bootState(deserializeGame(parsed), { intro: false });
}

// Load button — open a file picker and import the chosen .json save.
function loadFromFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_SAVE_BYTES) { flashButton(loadBtn, "File too large"); return; }   // bound before we parse it
    const reader = new FileReader();
    reader.onload = () => {
      // JSON.parse first (never eval), then deserialize sanitizes the shape (engine/persist.js).
      try { importSave(JSON.parse(reader.result)); }
      catch (e) { flashButton(loadBtn, "Load failed"); }
    };
    reader.onerror = () => flashButton(loadBtn, "Load failed");
    reader.readAsText(file);
  });
  input.click();
}

function flashButton(btn, msg) {
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = msg;
  clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1100);
}

// Home button — return to the menu, first asking whether to keep progress. A scenario
// can't be resumed, so it's a plain "leave?" confirm there; a skirmish/Odyssey offers
// "Save & Exit", which checkpoints to localStorage so the setup "Continue" button can
// pick it up. A lightweight modal built on the fly (Cancel / backdrop / Esc dismiss it).
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
    : "Your progress autosaves — Save & Exit checkpoints it now so you can Continue later.";
  const actions = document.createElement("div");
  actions.className = "home-actions";
  card.append(h, p, actions);
  overlay.appendChild(card);

  pauseLoop("home");   // hold the sim while the leave-confirm modal is up
  const close = () => { resumeLoop("home"); overlay.remove(); window.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  const act = (label, fn, cls) => {
    const b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", () => { close(); fn(); });
    actions.appendChild(b);
  };

  // Save & Exit only leaves once the checkpoint actually lands. If localStorage is
  // unavailable (quota / private mode) we DON'T pretend it saved and exit into a lost
  // game — we fall back to a file download and keep the player in-game so nothing is lost.
  if (!scenario) act("Save & Exit", () => {
    if (autoSave()) restartToMapSelect();
    else saveToFile();
  }, "primary");
  act(scenario ? "Leave" : "Exit without Saving", () => restartToMapSelect(), scenario ? "primary" : "");
  act("Cancel", () => {}, "ghost");

  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

if (saveBtn) saveBtn.addEventListener("click", saveToFile);
if (loadBtn) loadBtn.addEventListener("click", loadFromFile);
if (homeBtn) homeBtn.addEventListener("click", goHome);

// Keep the current game checkpointed without any manual step: on a timer, whenever the
// tab is hidden (task-switch / phone lock), and on unload (tab close / refresh). These
// are the writes the setup "Continue" buttons read back.
setInterval(autoSave, AUTOSAVE_INTERVAL_MS);
window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") autoSave(); });
window.addEventListener("beforeunload", autoSave);
