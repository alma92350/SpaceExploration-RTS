import { test } from "node:test";
import assert from "node:assert/strict";
import { game } from "../session.js";

/* ============================================================
   boot.js's pause-reason refcounting is the #4 finding from the test-suite review (boot.js
   sits at 35% line / 0% function coverage). A module-scope `pauseReasons` Set backs three
   exported functions — pauseLoop(reason), resumeLoop(reason), togglePause() — and the whole
   POINT of refcounting it (instead of a plain boolean) is that several independent callers
   pause on open and resume on close: starmap.js ("starmap"), overlays.js's Help ("help"),
   saveload.js's Home-confirm modal ("home"), and boot.js's own landing-picker flow
   ("landing-pick"), on top of the manual P-key toggle ("manual"). Closing ONE of those must
   never resume a game the player ALSO paused another way — that's the behavior under test
   here, driven only through the three exported functions (pauseReasons/syncPause are private
   and deliberately not reached directly).

   --- import setup (the pattern is test/saveload.test.js's — see its header comment for the
   full trace of *why* this is needed) ------------------------------------------------------
   boot.js pulls in a large transitive graph (render.js, minimap.js, hud.js, overlays.js,
   setup.js, input.js, engine/scenarios.js, engine/galaxy.js, landingPicker.js, data.js,
   sound.js, ...), and a few modules in that graph make un-guarded MODULE-SCOPE DOM calls —
   e.g. hud.js's `repairBtn.addEventListener(...)`/`departBtn.addEventListener(...)` and
   boot.js's own `underAttackEl.addEventListener(...)` (line ~68). Under plain `node --test`
   (no `document` global) dom.js resolves every handle to `null` by design, so those calls
   throw at IMPORT time unless `document` already exists. saveload.js already imports boot.js
   and test/saveload.test.js proved the fix: define a fake `globalThis.document` BEFORE the
   dynamic `await import(...)`, so dom.js's handles resolve to stub elements instead of null.
   `window` is deliberately left UNDEFINED — saveload.js and overlays.js both guard their own
   real browser wiring behind `typeof window !== "undefined"`, and leaving it undefined keeps
   those guards off, exactly as intended for a Node-side unit test (no real timers/listeners).

   Confirmed by reading boot.js's own module-scope code (everything NOT inside a function
   body): the only two executable statements are `underAttackEl.addEventListener(...)` and
   `if (pauseBtn) pauseBtn.addEventListener("click", togglePause);` — both satisfied by the
   stub below the same way saveload.test.js's is.

   The one thing saveload.test.js's stub doesn't need but this file does: a WORKING
   `classList`. boot.js's private syncPause() calls
   `document.body.classList.toggle("paused", manual)` at RUNTIME (every pauseLoop/resumeLoop/
   togglePause call, not just at import) — since boot.js exports no paused-query, that class
   (plus, secondarily, the topbar pause button's label — also set by syncPause) is the ONLY
   observable signal of pause state from outside the module. saveload.test.js's classList
   stub hardcodes `contains() { return false; }`, which would make every assertion below
   pass or fail for the wrong reason. classList here is instead backed by a real Set.
   ============================================================ */

function makeClassList() {
  const _c = new Set();
  return {
    _c,
    add(c) { _c.add(c); },
    remove(c) { _c.delete(c); },
    toggle(c, force) { force === undefined ? (_c.has(c) ? _c.delete(c) : _c.add(c)) : (force ? _c.add(c) : _c.delete(c)); },
    contains(c) { return _c.has(c); },
  };
}

const stubEl = () => ({
  addEventListener() {},
  removeEventListener() {},
  classList: makeClassList(),
  style: {},
  dataset: {},
  getContext() { return null; },
  appendChild() {},
});

globalThis.document = {
  getElementById() { return stubEl(); },
  body: stubEl(),   // syncPause()'s "paused" class (and input.js's "touch" class, unused here) live on this one
  createElement() { return stubEl(); },
  addEventListener() {},
  removeEventListener() {},
};

const { pauseLoop, resumeLoop, togglePause } = await import("../boot.js");
// dom.js is already loaded (boot.js imports it statically) — re-importing it here just returns
// the SAME cached module, i.e. the SAME `pauseBtn` object boot.js's syncPause() mutates. A
// second, independent observable of the same `manual` boolean: the topbar button's label.
const { pauseBtn } = await import("../dom.js");

// The only observable signal of pause state from outside boot.js — pauseReasons is private and
// boot.js exports no paused-query, so this (or pauseBtn's label, checked separately below) is it.
const isPausedUI = () => document.body.classList.contains("paused");

// Every reason any test below touches. pauseReasons is module-scope in boot.js and persists
// across tests in this file (node:test runs one file's top-level tests sequentially by
// default), and there is no exported way to reset it directly — only resumeLoop(reason) per
// reason, since clearPause() is private. Calling this at the START of every test (rather than
// only trusting each test's own end-of-test cleanup) means a test that fails partway through
// can never leak a stuck pause into the next one. Set.delete on an absent entry is a documented
// no-op, so resuming a reason that isn't actually active is always harmless.
const ALL_REASONS = ["manual", "landing-pick", "never-added"];
function resetPause() { for (const r of ALL_REASONS) resumeLoop(r); }

test("pauseLoop/resumeLoop refcount independently: closing one overlay must not resume a game paused another way", () => {
  resetPause();
  assert.equal(isPausedUI(), false, "sanity: clean slate before this test's own assertions");

  // Two independent real-world callers pausing for two independent reasons — e.g. the player
  // hit P (manual) and then a jump opened the landing picker (landing-pick), which also pauses.
  pauseLoop("manual");
  pauseLoop("landing-pick");
  assert.equal(isPausedUI(), true, "either reason alone is enough for the game to read as paused");
  assert.ok(pauseBtn.textContent.includes("Resume"), "the topbar button reflects the manual reason being active");

  // The landing picker closes (Confirm or Cancel, boot.js's initiateJump) and resumes ONLY its
  // own reason.
  resumeLoop("landing-pick");
  assert.equal(isPausedUI(), true,
    "closing ONE overlay must not resume a game the player ALSO paused manually with P — this " +
    "refcounted Set is the entire reason pauseReasons isn't a plain boolean");

  // Only once EVERY outstanding reason is resumed does the game actually read as running again.
  resumeLoop("manual");
  assert.equal(isPausedUI(), false, "the last outstanding reason resumed -> unpaused");
  assert.ok(pauseBtn.textContent.includes("Pause") && !pauseBtn.textContent.includes("Resume"),
    "the topbar button flips back once the manual reason clears");

  resetPause();
});

test("togglePause() is a no-op when there is no game in progress (game.state is falsy)", () => {
  resetPause();
  game.state = null;   // the map-select / menu screen — no engine state exists yet
  assert.doesNotThrow(() => togglePause());
  assert.equal(isPausedUI(), false, "nothing to pause on the menu -> togglePause must not add the manual reason");
  resetPause();
});

test("togglePause() is a no-op once the match has already ended (game.state.over)", () => {
  resetPause();
  game.state = { over: true };   // the game-over screen is up; the match is decided
  assert.doesNotThrow(() => togglePause());
  assert.equal(isPausedUI(), false, "an ended match can't be paused");
  resetPause();
  game.state = null;
});

test("togglePause() flips the manual pause on, then off, for a live in-progress game", () => {
  resetPause();
  game.state = {};   // a live game: no `over` flag set, so togglePause's guard falls through
  assert.equal(isPausedUI(), false, "sanity: starts unpaused");

  togglePause();   // e.g. the player presses P
  assert.equal(isPausedUI(), true, "first press pauses");

  togglePause();   // presses P again
  assert.equal(isPausedUI(), false, "second press resumes");

  resetPause();
  game.state = null;
});

test("resumeLoop() on a reason that was never added is harmless", () => {
  resetPause();
  assert.equal(isPausedUI(), false);
  assert.doesNotThrow(() => resumeLoop("never-added"));
  assert.equal(isPausedUI(), false,
    "Set.delete on a missing entry is a documented no-op in JS; resuming a reason that was " +
    "never paused must not somehow pause the game either");

  // Prove it's harmless NEXT TO an active, unrelated reason too — not just against an empty
  // Set. This is exactly the shape of bug this whole file guards against: a resumeLoop that
  // clears everything instead of deleting one entry would fail only this half of the test.
  pauseLoop("manual");
  resumeLoop("never-added");
  assert.equal(isPausedUI(), true, "an unrelated already-active pause reason must survive an unrelated resume");

  resumeLoop("manual");
  assert.equal(isPausedUI(), false);
  resetPause();
});
