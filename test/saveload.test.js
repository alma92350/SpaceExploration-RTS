import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// saveload.js's bottom comment says the `typeof window !== "undefined"` guard around its
// autosave-timer/listener wiring exists "so importing this module under Node (to unit-test its
// pure logic) doesn't start a real autosave timer". In practice, though, saveload.js imports
// boot.js, which imports hud.js — and hud.js has two MODULE-SCOPE calls that aren't null-guarded
// the way every other dom.js handle wired at module scope is:
//
//   hud.js:30   repairBtn.addEventListener("click", ...)
//   hud.js:31   departBtn.addEventListener("click", ...)
//   boot.js:54  underAttackEl.addEventListener("click", ...)
//
// Under plain `node --test` (no `document` global) dom.js resolves every handle to `null` by
// design (see dom.js + test/dom.test.js), so those three unguarded calls throw
// `TypeError: Cannot read properties of null (reading 'addEventListener')` at IMPORT time —
// before this file's own module body (or its `window` guard) ever runs. That's a real gap in
// the "importing this module under Node ... doesn't [start a timer]" claim, but fixing hud.js /
// boot.js is out of this fix's scope (only dom.js, saveload.js and renderShared.js get new
// tests here). So: shim the minimum fake `document` needed to survive those three specific
// calls, confirmed by tracing the whole saveload.js -> boot.js import graph (render.js,
// minimap.js, camera.js, input.js, effects.js, overlays.js, setup.js, hud.js, hudSelection.js,
// sound.js, the engine/* modules) for any OTHER un-guarded module-scope DOM access — there is
// none. Crucially, `window` is deliberately left undefined, so saveload.js's own
// `typeof window !== "undefined"` guard stays off and no real autosave timer/listener starts —
// preserving exactly the Node-safety the module's comment promises for the functions under
// test below.
const stubEl = () => ({
  addEventListener() {},
  removeEventListener() {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {},
  dataset: {},
  getContext() { return null; },
});
globalThis.document = {
  getElementById() { return stubEl(); },
  body: stubEl(),
  createElement() { return stubEl(); },
  addEventListener() {},
  removeEventListener() {},
};

const { hasSave, hasOdysseySave, storedSaveVersions } = await import("../saveload.js");

// --- environment check: is `localStorage` a real global under this Node install? -------------
// Node 22 gained an experimental, opt-in Web Storage implementation (see `node --help` ->
// `--localstorage-file`), but it is NOT on by default and `package.json`'s `test` script
// (`node --test`, no flags) and this repo's CI workflow both run without it on Node 20 AND 22.
// saveload.js's `read()` helper references the bare global `localStorage` (not
// `globalThis.localStorage` / `typeof`), so with no such global declared anywhere, a bare
// reference throws a ReferenceError — which `read()` already try/catches, falling back to null.
// Confirmed empirically (see scopeNotes in the task report) rather than assumed: bare
// `localStorage` throws under `node --test` in this environment, so the three functions below
// are exercised through their documented missing-global fallback path, not a live read/write
// round-trip.
const localStorageIsAvailable = (() => {
  try { void localStorage; return true; }
  catch { return false; }
})();

test("environment sanity: localStorage is not a live global under plain `node --test`", () => {
  // This pins down WHICH branch the tests below are actually exercising, so a future Node
  // upgrade that starts exposing a default `localStorage` doesn't silently leave this suite
  // testing the wrong path without anyone noticing.
  assert.equal(localStorageIsAvailable, false,
    "expected bare `localStorage` to be undeclared under `node --test` on this Node install; " +
    "if this now fails, saveload.js's read()/hasSave()/etc. can be tested against a real " +
    "localStorage round-trip instead of only the missing-global fallback");
});

test("hasSave() gracefully reports false when localStorage is unavailable (no save yet)", () => {
  assert.equal(hasSave(), false);
});

test("hasOdysseySave() gracefully reports false when localStorage is unavailable (no save yet)", () => {
  assert.equal(hasOdysseySave(), false);
});

test("storedSaveVersions() gracefully returns the null-shaped result when localStorage is unavailable", () => {
  assert.deepEqual(storedSaveVersions(), { skirmish: null, odyssey: null });
});

test("none of hasSave / hasOdysseySave / storedSaveVersions throw, called repeatedly", () => {
  // read()'s try/catch is the whole point of this on-ramp — a throwing/missing localStorage
  // must never bubble up into a crash for callers like the update-check / map-select screen.
  assert.doesNotThrow(() => { hasSave(); hasOdysseySave(); storedSaveVersions(); hasSave(); });
});

test("the module reads the documented literal storage keys", () => {
  // hasSave/hasOdysseySave/storedSaveVersions don't export SAVE_KEY/ODYSSEY_KEY, so with no
  // localStorage available to observe a real get/set against them, pin the literal strings
  // in the source itself — a silent rename here would strand every player's existing
  // browser-local autosave (they'd read back "no save" forever) without any other test catching it.
  const src = readFileSync(fileURLToPath(new URL("../saveload.js", import.meta.url)), "utf8");
  assert.match(src, /SAVE_KEY\s*=\s*"stellarfrontier\.save\.v1"/);
  assert.match(src, /ODYSSEY_KEY\s*=\s*"stellarfrontier\.odyssey\.v1"/);
});
