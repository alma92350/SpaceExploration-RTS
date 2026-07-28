import { test } from "node:test";
import assert from "node:assert/strict";
import { game } from "../session.js";
// Pure engine/fixture modules — no DOM/window reference anywhere in their own code or import
// graph (engine/galaxy.js, engine/state.js — see test/saveload.test.js's header comment for the
// identical reasoning about createGalaxy), so safe to import statically here, before the document
// stub below even exists. jumpReadyGalaxy is the shared "pad, staged ship, funded" origin fixture
// test/odyssey.test.js's own jumpCapital tests already use — reused below (P2 finding, near the
// bottom of this file) so initiateJump's own tests don't re-roll it slightly differently.
import { jumpReadyGalaxy } from "./_helpers.js";
import { makeBuilding } from "../engine/state.js";

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
  // Needed once startGame() is driven for real, below (P1 finding #8) — overlays.js's
  // showObjectives() calls objectivesEl.querySelector(".obj-close").addEventListener(...). See
  // that section's own header comment for the full empirical trace of what else this required.
  querySelector() { return stubEl(); },
});

globalThis.document = {
  getElementById() { return stubEl(); },
  body: stubEl(),   // syncPause()'s "paused" class (and input.js's "touch" class, unused here) live on this one
  createElement() { return stubEl(); },
  addEventListener() {},
  removeEventListener() {},
};

const { pauseLoop, resumeLoop, togglePause, startGame, initiateJump } = await import("../boot.js");
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

/* ============================================================
   P1 finding #8 (the second boot.js gap from the same test-suite review): two more
   module-private helpers — difficultyDials(key) and resolveSeed(cfg) — are neither exported nor
   reachable except by driving a real start* function and reading what landed on the resulting
   game.state. startGame(planetId) is the natural driver: it calls both
   (difficultyDials(setup.difficulty), resolveSeed(setup)) and their outputs land straight on the
   created state — aiApm/aiMicro under state.ai.apm/state.ai.micro, the seed under state.seed
   (engine/state.js createGameState, confirmed by reading it: `apm: opts.aiApm ?? null`,
   `micro: opts.aiMicro ?? false`, `seed: opts.seed ?? null`).

   difficultyDials looks `key` up in setup.js's own exported DIFFICULTY_OPTIONS (the SAME array
   that drives the Easy/Medium/Hard picker) and falls back to the "medium" entry when `key`
   matches none of them — the exact fix boot.js's own comment on difficultyDials describes:
   boot.js used to keep a SEPARATE easy/medium/hard map, and a key that existed in one list but
   not the other silently fell back to Medium instead of erroring. That fallback branch (an
   unrecognised key) has never been exercised by any existing test. resolveSeed(cfg) either
   honors an explicit cfg.seed or draws a fresh Math.random() one, coerced >>> 0 to an unsigned
   32-bit int either way — also never directly exercised.

   --- extending the stub: what actually broke, in order, driving startGame("ferros") against
   the document-only stub above (confirmed empirically, not guessed) ---------------------------
     1. overlays.js's showObjectives() — called by bootState whenever `intro: true`, which
        startGame's own call to bootState always passes — does
        `objectivesEl.querySelector(".obj-close").addEventListener("click", hideObjectives)`.
        The stubEl() above had no querySelector; one line was added to it (harmless to the pause
        tests above, which never reach this code path).
     2. input.js's attachInput() (bootState wires every fresh state to one) registers its
        mouseup/keydown/keyup/blur listeners directly on the bare `window` global — unlike
        saveload.js's and overlays.js's own browser wiring, this call is NOT behind a
        `typeof window !== "undefined"` guard, so `window` must actually exist by the time
        startGame runs. Exactly the gap test/saveload.test.js's own "driving the real Load path"
        section already hit (see its header comment) and solved the same way: set up AFTER
        boot.js/setup.js are already imported above, so their own module-scope
        `typeof window !== "undefined"` guards (which already ran, above) still saw `undefined`
        and stayed off — this file still starts no real timers/listeners on import; only this
        section's own explicit startGame() calls below ever touch `window`.
     3. engine/loop.js's createLoop().start() (the last thing bootState does) calls the bare
        `requestAnimationFrame` global directly, and — once `loop` is already set, from an
        earlier call in this same section — loop.stop() equally needs `cancelAnimationFrame`.
   Nothing else broke: unlike saveload.test.js's Load-path section, no AudioContext stub is
   needed here — startGame/bootState never call sound.unlockAudio() or any sound.play*()
   synchronously (those only ever fire from click handlers, or from showGameOver/showScenarioEnd,
   neither reached here since a freshly created state always starts with `over: false`).

   One more real, ticking side effect showObjectives leaves behind: a genuine 30-SECOND
   `setTimeout(hideObjectives, 30000)` (overlays.js). Confirmed empirically: without cleanup,
   `node --test` on this file hangs for ~30s after its last test instead of exiting immediately,
   because a live Node timer keeps the process alive. hideObjectives() (which bootState itself
   already calls, unconditionally, at the very top of every later boot) clears it; each test below
   calls it again at the end so the suite never carries a live timer past its own last test.
   ============================================================ */

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

// setup.js/overlays.js are already loaded (transitively, via boot.js's own import graph at the
// top of this file) — re-importing them here just returns the SAME cached modules: the identical
// live `setup` object every UI module reads/writes (setup.js's card-click handlers, boot.js's
// start* functions), and the identical hideObjectives the comment above relies on.
const { setup, DIFFICULTY_OPTIONS } = await import("../setup.js");
const { hideObjectives } = await import("../overlays.js");

// Whatever difficulty/seed the setup screen actually started at — captured once, so every test
// below restores the EXACT starting values rather than a hardcoded guess. setup is a live
// cross-test singleton exactly like game (see the game.state resets throughout this file); no
// other test in this file touches it, but nothing resets it between files either.
const ORIGINAL_DIFFICULTY = setup.difficulty, ORIGINAL_SEED = setup.seed;
function resetSetup() { setup.difficulty = ORIGINAL_DIFFICULTY; setup.seed = ORIGINAL_SEED; }

test("difficultyDials(): a recognized difficulty key drives the created state's AI with that exact difficulty's aiApm/aiMicro", () => {
  resetSetup();
  const hard = DIFFICULTY_OPTIONS.find(o => o.mult === "hard");
  setup.difficulty = "hard";

  startGame("ferros");

  assert.equal(game.state.ai.apm, hard.aiApm, "state.ai.apm should be Hard's real aiApm from DIFFICULTY_OPTIONS");
  assert.equal(game.state.ai.micro, hard.aiMicro, "state.ai.micro should be Hard's real aiMicro (true — the AI micros: focus-fire, kiting)");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("difficultyDials(): an unrecognized key silently falls back to Medium's dials — never throws, never some other plausible-but-wrong default", () => {
  resetSetup();
  const medium = DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  setup.difficulty = "not-a-real-difficulty";   // e.g. a stale/typo'd save, or a future rename that missed one call site

  // This is the exact regression difficultyDials's own `|| DIFFICULTY_OPTIONS.find(o => o.mult
  // === "medium")` fallback exists to prevent: a difficulty key that matches no entry must not
  // crash the whole game start...
  assert.doesNotThrow(() => startGame("ferros"));
  // ...and must not silently run some OTHER wrong-but-plausible difficulty either — it must be
  // Medium's dials specifically.
  assert.equal(game.state.ai.apm, medium.aiApm, "an unrecognized key should fall back to Medium's aiApm");
  assert.equal(game.state.ai.micro, medium.aiMicro, "an unrecognized key should fall back to Medium's aiMicro");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("resolveSeed(): an explicit setup.seed is honored exactly on the created state, not overridden by a random draw", () => {
  resetSetup();
  setup.seed = 12345;

  startGame("ferros");

  assert.equal(game.state.seed, 12345, "an explicit seed must land on state.seed completely unchanged");

  hideObjectives();
  game.state = null;
  resetSetup();
});

test("resolveSeed(): a null setup.seed draws a fresh, valid unsigned-32-bit seed every call — never frozen/cached, never out of range", () => {
  resetSetup();
  setup.seed = null;

  startGame("ferros");
  const seed1 = game.state.seed;
  startGame("ferros");
  const seed2 = game.state.seed;

  for (const s of [seed1, seed2]) {
    assert.ok(Number.isInteger(s), `resolved seed ${s} must be an integer`);
    assert.ok(s >= 0 && s <= 0xFFFFFFFF, `resolved seed ${s} must be a valid unsigned 32-bit value`);
  }
  // Not an exact-value assertion (it's genuinely random) — proving it's really drawing a fresh
  // value each time, not some frozen/cached one, is instead that two independent draws disagree.
  assert.notEqual(seed1, seed2, "back-to-back calls with no explicit seed must not repeat the same random seed");

  hideObjectives();
  game.state = null;
  resetSetup();
});

/* ============================================================
   P2 finding: initiateJump's afford + needsPick gating (boot.js, `export function
   initiateJump(destId)`). Exported, so — unlike difficultyDials/resolveSeed above — it's
   directly importable; the interesting part is exercising its three branches for real, against a
   genuine galaxy (jumpReadyGalaxy from test/_helpers.js — the same "pad, staged ship, funded"
   origin fixture test/odyssey.test.js's own jumpCapital tests already use):

     1. Can't afford it (g.credits < jumpCost(g, destId)) -> null. initiateJump's own header
        comment: "a jump that plain can't happen still fails fast, synchronously, with no picker
        ever shown" — jumpCapital re-validates the SAME afford check internally, so this check
        alone isn't provable on the immediate-jump branch (double-gated there either way); it only
        bites for real on the needsPick=true branch, where — without it — a picker would open for
        a jump the player can't actually complete. So the test below deliberately targets a
        destination with NO player Spaceport (needsPick would be true if reached), the same shape
        as test 3 below, just unaffordable.
     2. Affordable, and the destination ALREADY has a player Spaceport (playerSpaceports(dest).length
        > 0) -> `needsPick` is false (engine/galaxy.js's landingZone already knows where "home" is
        there) -> jumps immediately, returning jumpCapital's own summary object — NOT the bare
        `true` the picker branch returns.
     3. Affordable, destination has NO player Spaceport, origin can actually launch (canJump) -> a
        pick genuinely applies -> returns `true`, having deferred the real jump to the landing
        picker's own onPick callback (landingPicker.js openLandingPicker).

   Branch 3 drives the REAL landingPicker.js openLandingPicker — a named ES-module import inside
   boot.js, so it can't be swapped for a spy from outside (and this repo's CI matrix runs Node 20
   too, where node:test's `mock.module` isn't available even if the target were only 22+). Read in
   full (landingPicker.js) for exactly what DOM surface it touches: div/h2/p/canvas/button elements
   via document.createElement, a 2D context to draw into, and one document.body.appendChild for the
   overlay itself — landingPickEl/withLandingPickDom below build just enough of a document for it
   to run to completion for real, and the overlay it genuinely appends is the observable proof a
   picker really opened. The swap is installed and restored inside EACH test body (never at module
   scope), so it can never affect another test regardless of where in the file it's written — every
   test body here only runs after this whole module's own top-level evaluation (every statement in
   this file, top to bottom) has already finished.
   ============================================================ */

// A no-op-Proxy 2D context — same idiom as test/hudSelection.test.js's fakeCtx(): any method call
// tolerated, any property read/write round-trips through a plain backing object — so
// openLandingPicker's draw() (fillStyle/fillRect/strokeStyle/beginPath/arc/stroke/…) runs to
// completion without hand-enumerating the canvas API.
function fakeLandingPickCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}
// Everything document.createElement(...) needs to survive a REAL openLandingPicker() call
// (confirmed by reading it in full): setAttribute/append/focus/remove beyond what this file's own
// stubEl() above offers, plus a WORKING (not null) 2D context specifically for its canvas.
function landingPickEl(tag) {
  return {
    addEventListener() {}, removeEventListener() {},
    classList: makeClassList(), style: {}, dataset: {},
    getContext() { return tag === "canvas" ? fakeLandingPickCtx() : null; },
    appendChild(c) { return c; }, append() {}, setAttribute() {}, remove() {}, focus() {},
    querySelector() { return landingPickEl("div"); },
  };
}
// Swap in a document capable of running the real openLandingPicker for the duration of `fn`
// (synchronous), returning whatever got appended to document.body — restored in a `finally` so a
// failing assertion can never leak the swap into a later test.
function withLandingPickDom(fn) {
  const appended = [];
  const originalCreateElement = document.createElement;
  const originalAppendChild = document.body.appendChild;
  document.createElement = tag => landingPickEl(tag);
  document.body.appendChild = c => { appended.push(c); return c; };
  try { fn(); } finally { document.createElement = originalCreateElement; document.body.appendChild = originalAppendChild; }
  return appended;
}

test("initiateJump: insufficient credits returns null without opening a picker or launching", () => {
  resetPause();
  game.input = null;   // isolate from whatever attachInput() the startGame-driving tests above left behind
  const g = jumpReadyGalaxy(101);
  const originId = g.activeId;
  const destId = g.worlds.find(w => w !== g.activeId);   // never-visited -> jumpCost(g, destId) > 0, and starts with no player Spaceport
  g.credits = 0;                                          // can't afford ANY nonzero-cost jump
  game.galaxy = g;

  const appended = withLandingPickDom(() => {
    assert.equal(initiateJump(destId), null, "an unaffordable jump must return null");
  });
  assert.equal(appended.length, 0, "no landing-picker overlay should ever have been created for a jump that can't be paid for");
  assert.equal(g.activeId, originId, "no jump can have happened — the active world is unchanged");
  assert.equal(g.credits, 0, "nothing was spent");

  game.galaxy = null;
  resetPause();
});

test("initiateJump: a destination that already has a player Spaceport needs no pick and jumps immediately", () => {
  resetPause();
  game.input = null;
  const g = jumpReadyGalaxy(102);
  const destId = g.worlds.find(w => w !== g.activeId);
  const dest = g.planets.get(destId);
  // Stand a finished Spaceport right on the destination — the exact shape test/landing.test.js's
  // own "a Spaceport already standing at the destination" fixture uses.
  const destPad = makeBuilding("spaceport", "player", dest.map.bases.player.x + 40, dest.map.bases.player.y);
  dest.buildings.set(destPad.id, destPad);   // playerSpaceports(dest).length > 0 -> needsPick is false
  game.galaxy = g;

  const result = initiateJump(destId);
  assert.notEqual(result, true, "an immediate jump must return jumpCapital's own result object, never the bare `true` the picker branch returns");
  assert.ok(result && typeof result === "object" && result.destId === destId,
    "the returned value is the real jump summary (engine/galaxy.js jumpCapital)");
  assert.equal(g.activeId, destId, "the jump actually ran synchronously — the active world changed");

  game.galaxy = null;
  game.state = null;
  game.input = null;
  resetPause();
});

test("initiateJump: a destination with no player Spaceport, origin launch-ready, opens a landing picker and defers the jump", () => {
  resetPause();
  game.input = null;
  const g = jumpReadyGalaxy(103);
  const originId = g.activeId;
  const destId = g.worlds.find(w => w !== g.activeId);   // never-visited, unsettled -> starts with no player Spaceport
  const creditsBefore = g.credits;
  game.galaxy = g;

  const appended = withLandingPickDom(() => {
    assert.equal(initiateJump(destId), true, "a pick that genuinely applies returns the bare `true` sentinel, not a jump result");
  });
  assert.equal(appended.length, 1, "the real landing picker (landingPicker.js openLandingPicker) should have appended its overlay to document.body");
  assert.equal(appended[0].className, "landing-pick-confirm", "…specifically the landing-pick overlay, identifiable by its own class");
  assert.equal(g.activeId, originId, "the jump itself is DEFERRED to the picker's own onPick — nothing has moved yet");
  assert.equal(g.credits, creditsBefore, "fuel isn't spent until the jump actually launches from onPick, not merely from opening the picker");

  resumeLoop("landing-pick");   // this test never drives the picker's own onPick/onCancel, so clear the pause it opened
  game.galaxy = null;
  resetPause();
});
