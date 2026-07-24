import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { createFog, FOG_CELL_SIZE } from "../engine/fog.js";

// input.js is one big attachInput() closure that wires real DOM listeners (canvas +
// window), so exercising it under plain `node --test` (no browser, no jsdom — see
// package.json's zero-dependency `test` script) means giving it just enough of a DOM to be
// indistinguishable from the real thing for these three bugs. Node's own EventTarget/
// Event/AbortController are WHATWG-compliant (including the `{ signal }` auto-removal
// input.js relies on for teardown), so a canvas/window built ON them behaves exactly like
// the browser objects input.js expects — no fake dispatch bookkeeping needed. Verified
// empirically (not assumed): Node's EventTarget really does drop a listener once its
// AbortSignal fires, and dispatchEvent really does set event.target to the dispatching
// object, both load-bearing for the tests below.
//
// sound.js's tone() unconditionally calls window.AudioContext when unmuted; nothing here
// stubs an AudioContext, so sound is muted up front — commandAt()/applyBoxSelection() etc.
// still run their sound.playOrder()/playSelect() calls, they just no-op past `if (muted)
// return;` before ever touching window.AudioContext.
sound.setMuted(true);

// input.js's keydown handler reads the bare global `document.body` as part of its
// focused-control guard, but only past its `t &&` (e.target) short-circuit. Every event
// dispatched below that reaches that handler is dispatched straight on the fake `window`,
// and per the WHATWG dispatch algorithm that makes `event.target` that same window object
// — truthy — so the guard does go on to read `document.body`. A minimal stub is enough;
// nothing here reads anything beyond `.body`.
globalThis.document = { body: {} };

const { attachInput } = await import("../input.js");

const VW = 800, VH = 600;

// Stands in for the real HTMLCanvasElement: a real EventTarget (so addEventListener /
// dispatchEvent / the `{ signal }` teardown all behave exactly like the browser) plus the
// handful of extra properties/methods input.js actually reads off it.
class FakeCanvas extends EventTarget {
  constructor() {
    super();
    this.clientWidth = VW;
    this.clientHeight = VH;
    this.classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
}

// Ditto for `window` — input.js reads the bare global identifier, so each test points
// globalThis.window at its own fresh instance before calling attachInput.
class FakeWindow extends EventTarget {}

function ev(type, props = {}) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  return e;
}

// A large, empty, all-unrevealed map centred at (2000, 2000) — plenty of room to pan or
// place a click without clampCamera's edges ever getting involved.
function makeState() {
  const map = { width: 4000, height: 4000, nodes: [], bases: {} };
  return { map, units: new Map(), buildings: new Map(), selection: [], fog: createFog(map), planetId: "test" };
}

function reveal(fog, x, y) {
  const cx = Math.floor(x / FOG_CELL_SIZE), cy = Math.floor(y / FOG_CELL_SIZE);
  fog.visible[cy * fog.cols + cx] = 1;
}

// Fresh canvas/window/state/controller for one test, plus an onChange call counter.
// commandAt/setArmed/etc. don't pass onChange any arguments worth asserting on — only
// whether, and how often, it fired.
function setup() {
  globalThis.window = new FakeWindow();
  const canvas = new FakeCanvas();
  const state = makeState();
  let calls = 0;
  const controller = attachInput(canvas, state, () => { calls++; });
  return { canvas, window: globalThis.window, state, controller, calls: () => calls };
}

// The world point at (wx, wy) as canvas-local client coordinates, inverting the same
// screenToWorld math input.js's toWorld() uses (rect.left/top are 0 for FakeCanvas).
function clientFor(controller, wx, wy) {
  const cam = controller.getCamera();
  return { clientX: VW / 2 + (wx - cam.x) * cam.zoom, clientY: VH / 2 + (wy - cam.y) * cam.zoom };
}

// ============================================================================
// Bug 1 — alt-tab camera drift: a backgrounded tab doesn't reliably get a keyup, so a
// pan key held at the moment of alt-tab must not stay "held" forever. A window blur is
// the signal a browser DOES reliably deliver, and now clears heldKeys — the keyboard
// counterpart to the touchcancel handling already in place for the touch equivalent.
// ============================================================================

test("a window blur clears held pan keys, stopping the drift", () => {
  const { window, controller } = setup();

  window.dispatchEvent(ev("keydown", { key: "ArrowRight", code: "ArrowRight" }));
  const before = controller.getCamera().x;
  controller.tickCamera(0.1);
  const afterHeld = controller.getCamera().x;
  assert.ok(afterHeld > before, "holding the pan key actually moves the camera (sanity check)");

  window.dispatchEvent(ev("blur"));
  controller.tickCamera(0.1);
  assert.equal(controller.getCamera().x, afterHeld,
    "after a blur, ticking the camera again with the key never released must not move it further");
});

test("a blur with nothing held is a harmless no-op", () => {
  const { window, controller } = setup();
  const before = controller.getCamera().x;
  assert.doesNotThrow(() => window.dispatchEvent(ev("blur")));
  controller.tickCamera(0.1);
  assert.equal(controller.getCamera().x, before, "no key was held, so nothing pans");
});

test("a key held again after a blur still pans normally (blur doesn't wedge the pan system)", () => {
  const { window, controller } = setup();
  window.dispatchEvent(ev("keydown", { key: "d", code: "KeyD" }));
  window.dispatchEvent(ev("blur"));
  window.dispatchEvent(ev("keydown", { key: "d", code: "KeyD" }));   // re-press after tabbing back in
  const before = controller.getCamera().x;
  controller.tickCamera(0.1);
  assert.ok(controller.getCamera().x > before, "a fresh press after the blur pans as normal");
});

test("destroy() tears the blur listener down along with every other listener", () => {
  const { window, controller } = setup();
  controller.destroy();
  // The blur handler is wired with the same { signal } as every other listener in the
  // file; aborting it must leave dispatching a blur harmless, not throwing.
  assert.doesNotThrow(() => window.dispatchEvent(ev("blur")));
});

// ============================================================================
// Bug 2 — commandAt() only called onChange() on the rally branch. Every other
// order-issuing branch (attack, gather, the plain move fallback, ...) left the HUD to
// notice the change on a stray ~150ms tick instead of updating immediately.
// ============================================================================

test("commandAt still notifies on a rally order (regression: the branch that already worked)", () => {
  const { state, canvas, controller, calls } = setup();
  const cc = makeBuilding("command", "player", 1000, 1000);   // BUILDINGS.command.produces is non-empty
  state.buildings.set(cc.id, cc);
  state.selection = [cc.id];

  const { clientX, clientY } = clientFor(controller, 2500, 2600);
  canvas.dispatchEvent(ev("contextmenu", { clientX, clientY, ctrlKey: false }));

  assert.deepEqual(cc.rally, { x: 2500, y: 2600, nodeId: null });
  assert.equal(calls(), 1, "onChange fires exactly once for the order");
});

test("commandAt notifies on an attack order (the headline branch the review flagged)", () => {
  const { state, canvas, controller, calls } = setup();
  const attacker = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 3000, 3000);
  state.units.set(attacker.id, attacker);
  state.units.set(enemy.id, enemy);
  state.selection = [attacker.id];
  reveal(state.fog, enemy.x, enemy.y);   // entityAt only returns a non-player unit if it's visible

  const { clientX, clientY } = clientFor(controller, enemy.x, enemy.y);
  canvas.dispatchEvent(ev("contextmenu", { clientX, clientY, ctrlKey: false }));

  assert.deepEqual(attacker.order, { type: "attack", targetId: enemy.id });
  assert.equal(calls(), 1, "the HUD's Attack-Move button (and everything else onChange refreshes) must hear about this immediately, not on a stray HUD tick");
});

test("commandAt notifies on a gather order", () => {
  const { state, canvas, controller, calls } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];
  const node = { id: "node-1", x: 2200, y: 2200, amount: 500, hidden: false };
  state.map.nodes.push(node);

  const { clientX, clientY } = clientFor(controller, node.x, node.y);
  canvas.dispatchEvent(ev("contextmenu", { clientX, clientY, ctrlKey: false }));

  assert.deepEqual(worker.order, { type: "gather", nodeId: "node-1" });
  assert.equal(calls(), 1);
});

test("commandAt notifies on the plain move fallback (nothing at the click point)", () => {
  const { state, canvas, controller, calls } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const { clientX, clientY } = clientFor(controller, 2800, 1400);   // empty ground, no unit/building/node
  canvas.dispatchEvent(ev("contextmenu", { clientX, clientY, ctrlKey: false }));

  assert.deepEqual(worker.order, { type: "move", x: 2800, y: 1400 });
  assert.equal(calls(), 1, "the fallback move branch must notify too, not just the rally special case");
});

// ============================================================================
// Bug 3 — dblclick ignored buildMode/attackMoveArmed and ran its normal
// reselect-fleet-of-this-type logic regardless, silently overriding the click that had
// just placed a building or committed an attack-move.
// ============================================================================

function placeTwoSkiffs(state) {
  const a = makeUnit("skiff", "player", 2000, 2000);
  const b = makeUnit("skiff", "player", 2030, 2000);   // both inside the default on-screen viewport
  state.units.set(a.id, a);
  state.units.set(b.id, b);
  return [a, b];
}

test("dblclick in build mode does not reselect — the mousedown for each click already placed", () => {
  const { state, canvas, controller } = setup();
  const [a] = placeTwoSkiffs(state);
  state.selection = [];
  controller.startBuild("barracks");

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));

  assert.deepEqual(state.selection, [], "the reselect-all-of-type gesture must not run mid-placement");
  assert.ok(controller.building, "build mode itself is untouched by the dblclick guard");
});

test("dblclick with attack-move armed does not reselect either", () => {
  const { state, canvas, controller } = setup();
  const [a] = placeTwoSkiffs(state);
  state.selection = [];
  controller.toggleAttackMove();
  assert.equal(controller.attackArmed, true);

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));

  assert.deepEqual(state.selection, [], "armed attack-move must not be overridden by a reselect");
});

test("dblclick with neither mode active still does the normal select-all-of-type (regression)", () => {
  const { state, canvas, controller } = setup();
  const [a, b] = placeTwoSkiffs(state);
  state.selection = [];

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  canvas.dispatchEvent(ev("dblclick", { clientX, clientY }));

  assert.deepEqual([...state.selection].sort(), [a.id, b.id].sort(),
    "with no build/attack-move mode active, dblclick still grabs every same-type unit on screen");
});
