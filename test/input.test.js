import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { createFog, FOG_CELL_SIZE } from "../engine/fog.js";
import { game } from "../session.js";   // control groups + hotkeyActions live here, not on `state` — see setup()

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
// — truthy — so the guard does go on to read `document.body`.
//
// The touch handlers separately call onTouchActive(), which flips document.body into "touch
// mode" (bigger tap targets, the touch HUD legend) via .classList.contains()/.add() on first
// real touch — so the stub grows a `classList` mirroring FakeCanvas's own below, still every
// method a harmless no-op/false. Nothing here reads anything of `document` beyond these.
globalThis.document = { body: { classList: { contains() { return false; }, add() {}, remove() {}, toggle() {} } } };

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
  // Control groups (keyboard digits) and the positional-hotkey action list both live on the
  // shared `game` singleton (session.js), not on `state` — see input.js's groups()/game.hotkeyActions
  // reads. That object survives across every test in this file (it's the same module-cached
  // import each time), so without a reset a group bound in one test — or a stubbed
  // hotkeyActions array — would silently leak into the next one, which always reuses the same
  // "test" planetId. Fresh empty state, every time.
  game.groups[state.planetId] = {};
  game.hotkeyActions = null;
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

// A real right-click (as of the click-and-drag heading gesture) is a button-2 mousedown on the
// canvas followed by a button-2 mouseup on window — commandAt now fires from mouseup, not a bare
// `contextmenu` event (contextmenu's only remaining job is suppressing the browser's native
// menu). Mouse down and up at the SAME point is a plain click: no drag, so no explicit heading —
// byte-identical to the old single-event behaviour these tests were written against.
function rightClick(canvas, window, clientX, clientY, ctrlKey = false) {
  canvas.dispatchEvent(ev("mousedown", { button: 2, clientX, clientY }));
  window.dispatchEvent(ev("mouseup", { button: 2, clientX, clientY, ctrlKey }));
}

// A left-click (selection) is the button-0 equivalent: mousedown on the canvas arms a
// selection box at that point, mouseup on window (same point, no drag) resolves it via
// applyBoxSelection's tiny-box/point-pick branch.
function leftClick(canvas, window, clientX, clientY, ctrlKey = false) {
  canvas.dispatchEvent(ev("mousedown", { button: 0, clientX, clientY }));
  window.dispatchEvent(ev("mouseup", { button: 0, clientX, clientY, ctrlKey }));
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
  rightClick(canvas, window, clientX, clientY);

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
  rightClick(canvas, window, clientX, clientY);

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
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(worker.order, { type: "gather", nodeId: "node-1" });
  assert.equal(calls(), 1);
});

test("commandAt notifies on the plain move fallback (nothing at the click point)", () => {
  const { state, canvas, controller, calls } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const { clientX, clientY } = clientFor(controller, 2800, 1400);   // empty ground, no unit/building/node
  rightClick(canvas, window, clientX, clientY);

  assert.deepEqual(worker.order, { type: "move", x: 2800, y: 1400 });
  assert.equal(calls(), 1, "the fallback move branch must notify too, not just the rally special case");
});

// ============================================================================
// Click-and-drag heading: a right-DRAG (mousedown then mouseup at a different point) sets the
// destination at the DRAG'S START and stamps the drag direction as an explicit facing (a plain
// click carries none — the two commandAt tests above already cover that byte-identical case).
// ============================================================================

test("a right-drag moves to where the drag STARTED, not where it ended", () => {
  const { state, canvas, controller } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const start = clientFor(controller, 2800, 1400);
  const end = clientFor(controller, 3200, 1400);   // dragged further along +x
  canvas.dispatchEvent(ev("mousedown", { button: 2, clientX: start.clientX, clientY: start.clientY }));
  window.dispatchEvent(ev("mouseup", { button: 2, clientX: end.clientX, clientY: end.clientY }));

  assert.deepEqual(worker.order, { type: "move", x: 2800, y: 1400 }, "destination is the drag's START point");
});

test("a right-drag stamps the drag direction as the unit's facing; a plain click clears it", () => {
  const { state, canvas, controller } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  const start = clientFor(controller, 2800, 1400);
  const end = clientFor(controller, 2800, 1800);   // dragged straight down (+y) from the start point
  canvas.dispatchEvent(ev("mousedown", { button: 2, clientX: start.clientX, clientY: start.clientY }));
  window.dispatchEvent(ev("mouseup", { button: 2, clientX: end.clientX, clientY: end.clientY }));

  assert.ok(Number.isFinite(worker.facing), "the drag set an explicit facing");
  assert.ok(Math.abs(worker.facing - Math.PI / 2) < 1e-6, "facing straight down (+y) is angle PI/2");

  rightClick(canvas, window, start.clientX, start.clientY);   // a later PLAIN click, no drag
  assert.ok(!Number.isFinite(worker.facing), "a plain command with no heading clears the earlier facing");
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

// ============================================================================
// Ctrl+click promotes an already-selected unit to leader (selection[0] — the formation leader,
// see engine/formation.js pickLeader) instead of the Set-union no-op it used to be.
// ============================================================================

test("ctrl+clicking a unit already in the selection promotes it to the front (leader)", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  const c = makeUnit("skiff", "player", 900, 500);
  [a, b, c].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id, b.id, c.id];

  const { clientX, clientY } = clientFor(controller, c.x, c.y);
  leftClick(canvas, window, clientX, clientY, true);   // ctrl+click c, already selected

  assert.deepEqual(state.selection, [c.id, a.id, b.id], "c is promoted to the front; a/b keep their relative order");
});

test("ctrl+clicking a not-yet-selected unit still just appends (existing behaviour, unchanged)", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id];

  const { clientX, clientY } = clientFor(controller, b.x, b.y);
  leftClick(canvas, window, clientX, clientY, true);   // ctrl+click b, not yet selected

  assert.deepEqual(state.selection, [a.id, b.id], "b is appended after the existing leader, a stays first");
});

test("ctrl+clicking the unit that's already the leader is a harmless no-op", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id, b.id];

  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  leftClick(canvas, window, clientX, clientY, true);   // ctrl+click a, already the leader

  assert.deepEqual(state.selection, [a.id, b.id], "already the leader — selection order is unchanged");
});

test("a plain (non-ctrl) click on an already-selected unit still resets the selection to just it", () => {
  const { state, canvas, controller } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  state.units.set(a.id, a); state.units.set(b.id, b);
  state.selection = [a.id, b.id];

  const { clientX, clientY } = clientFor(controller, b.x, b.y);
  leftClick(canvas, window, clientX, clientY, false);   // plain click on b, no ctrl

  assert.deepEqual(state.selection, [b.id], "a plain click always replaces the selection — promotion is a ctrl-only gesture");
});

// ============================================================================
// Keydown hotkey dispatch — control groups, Q/X, Escape, and the positional Z/C/V/B/N
// production keys. This whole dispatch body was previously only reachable through a real
// browser driving real keystrokes, so despite being the single most-used input path in the
// game (a fast-paced RTS lives and dies by hotkeys, not menu-hunting) it sat effectively
// untested. Same FakeWindow/`ev()` dispatch the blur tests up top already use —
// window.dispatchEvent(ev("keydown", {...})) is indistinguishable from the real thing for
// everything this handler reads (e.key/e.code/e.shiftKey/e.repeat/e.target).
// ============================================================================

test("Shift+digit binds the current selection to a control group; the bare digit recalls exactly that later, even after the selection has moved on", () => {
  const { state, window } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  const b = makeUnit("skiff", "player", 700, 500);
  const c = makeUnit("skiff", "player", 900, 500);
  [a, b, c].forEach(u => state.units.set(u.id, u));
  state.selection = [a.id, b.id];

  // Shift is the bind modifier (not Ctrl — Ctrl+digit is the browser's own tab-switch shortcut
  // and can't be reliably suppressed, per input.js's own comment). The match is on e.code, so
  // the real e.key ("!" under Shift on a US layout) never has to be right for this to bind.
  window.dispatchEvent(ev("keydown", { key: "1", code: "Digit1", shiftKey: true }));

  state.selection = [c.id];   // selection moves on to something else entirely before recalling

  window.dispatchEvent(ev("keydown", { key: "1", code: "Digit1" }));   // bare 1 — no shiftKey

  assert.deepEqual(state.selection, [a.id, b.id],
    "recall restores exactly what was bound earlier — a snapshot taken at bind time, not a live reference to whatever the selection is now");
});

test("recalling a control-group digit that was never bound is a harmless no-op", () => {
  const { state, window } = setup();
  const a = makeUnit("skiff", "player", 500, 500);
  state.units.set(a.id, a);
  state.selection = [a.id];

  window.dispatchEvent(ev("keydown", { key: "9", code: "Digit9" }));   // group 9 was never assigned

  assert.deepEqual(state.selection, [a.id], "an unbound group's digit must not clear or otherwise touch the current selection");
});

test("Q selects the whole army — every combat-role unit you own, on-screen or not", () => {
  const { state, window } = setup();
  const skiff = makeUnit("skiff", "player", 500, 500);
  const offscreenBastion = makeUnit("bastion", "player", 3500, 3500);   // well outside the default viewport — Q is whole-map, not just what's visible
  const worker = makeUnit("worker", "player", 500, 500);                // role "worker" — must be excluded
  const enemySkiff = makeUnit("skiff", "ai", 500, 500);                 // right type, wrong owner — must be excluded
  [skiff, offscreenBastion, worker, enemySkiff].forEach(u => state.units.set(u.id, u));
  state.selection = [];

  window.dispatchEvent(ev("keydown", { key: "q", code: "KeyQ" }));

  assert.deepEqual([...state.selection].sort(), [skiff.id, offscreenBastion.id].sort(),
    "grabs every player-owned combat unit anywhere on the map; the worker (wrong role) and the enemy skiff (wrong owner) are both excluded");
});

test("X halts the selection: clears its active order and any queued waypoints", () => {
  const { state, window } = setup();
  const worker = makeUnit("worker", "player", 500, 500);
  worker.order = { type: "gather", nodeId: "node-1" };
  worker.orderQueue = [{ type: "move", x: 999, y: 999 }];   // a Ctrl-queued waypoint behind the current order
  state.units.set(worker.id, worker);
  state.selection = [worker.id];

  window.dispatchEvent(ev("keydown", { key: "x", code: "KeyX" }));

  assert.equal(worker.order, null, "the active order is cleared");
  assert.deepEqual(worker.orderQueue, [], "queued waypoints are dropped too — X is a full stop, not just cancel-the-current-leg");
});

test("Escape disarms a pending attack-move", () => {
  const { window, controller } = setup();
  controller.toggleAttackMove();
  assert.equal(controller.attackArmed, true, "attack-move is actually armed before Escape (sanity check)");

  window.dispatchEvent(ev("keydown", { key: "Escape", code: "Escape" }));

  assert.equal(controller.attackArmed, false, "Escape is the keyboard way to back out of an armed attack-move, same as a right-click cancel");
});

test("Escape also exits build mode", () => {
  const { window, controller } = setup();
  controller.startBuild("barracks");
  assert.ok(controller.building, "build mode is actually active before Escape (sanity check)");

  window.dispatchEvent(ev("keydown", { key: "Escape", code: "Escape" }));

  assert.equal(controller.building, null, "Escape backs out of build-placement mode without placing anything");
});

test("a positional production hotkey (Z) fires the HUD's bound action exactly once per keypress", () => {
  const { window } = setup();
  // hudSelection.js populates game.hotkeyActions with { key, click } entries as it rebuilds the
  // selection panel — click() replays the real button's own handler (see prodButton there). A
  // fake entry with its own counting `click` is enough to prove input.js finds the right slot
  // and fires it, without dragging in the whole HUD module just for this.
  let runs = 0;
  game.hotkeyActions = [{ key: "z", click: () => { runs++; } }];

  window.dispatchEvent(ev("keydown", { key: "z", code: "KeyZ" }));

  assert.equal(runs, 1, "the Z slot's action fired exactly once for one keypress");
});

// ============================================================================
// The focused-control guard: hotkeys must not fire while a real HUD control (a button, a text
// input, the Home-confirm modal) has focus, or Space/letters would double as both a game
// command AND whatever that control does with the same keystroke. dispatchEvent always sets
// event.target to the object dispatchEvent was called on (see the file-top comment on the
// document stub) — there's no DOM tree here for a click to bubble up from some other focused
// descendant, so this test's `window` instance has to stand in for the focused control itself.
// The guard only probes one method on that target, `.closest(...)`, so giving `window` one that
// returns truthy — exactly what a real focused <button>/<input>'s own .closest("button, input,
// ...") would return — reproduces the same branch a real focused HUD control takes.
// ============================================================================

test("the focused-control guard suppresses a hotkey while a real HUD control has focus", () => {
  const { state, window, calls } = setup();
  const army = makeUnit("skiff", "player", 500, 500);
  state.units.set(army.id, army);
  state.selection = [];

  window.closest = () => true;   // stands in for "event.target is inside a focused button/input/etc."

  window.dispatchEvent(ev("keydown", { key: "q", code: "KeyQ" }));

  assert.deepEqual(state.selection, [], "Q must not fire while a focused control 'owns' the keystroke");
  assert.equal(calls(), 0, "nothing should react at all — onChange must not fire either");
});

// ============================================================================
// Touch double-tap: the finger equivalent of dblclick (see the Bug 3 section above) — a second
// tap close to the first, both in time (DOUBLE_TAP_MS) and screen position (DOUBLE_TAP_DIST),
// upgrades to select-all-of-this-type instead of just re-tapping the one unit. Runs through the
// exact same canvas EventTarget dispatch as the mouse tests; touchstart/touchend just need a
// `touches` array carrying the properties input.js actually reads (clientX/clientY) — same idea
// as `ev()` supplying whatever extra properties a MouseEvent needs.
// ============================================================================

// A tap is a single-finger touchstart immediately followed by touchend at the same point — the
// touch equivalent of leftClick/rightClick above. `touches: []` on touchend matches a real
// TouchList once the one finger that was down has lifted (input.js's endTouch only ever reads
// e.touches.length, never .changedTouches, so an empty array is all "all fingers up" needs).
function tap(canvas, clientX, clientY) {
  canvas.dispatchEvent(ev("touchstart", { touches: [{ clientX, clientY }] }));
  canvas.dispatchEvent(ev("touchend", { touches: [] }));
}

test("two quick taps on the same unit are a double-tap: select every unit of that type on screen (the touch equivalent of dblclick)", () => {
  const { state, canvas, controller } = setup();
  const [a, b] = placeTwoSkiffs(state);
  state.selection = [];

  // The very first tap of a fresh controller can never register as a double no matter how the
  // timing falls: lastTapCX/CY start at literal 0, and this tap's client position (near the
  // canvas center) is nowhere close to that origin, so the distance half of isDouble alone
  // already rules it out — no need to fake or wait out performance.now().
  const { clientX, clientY } = clientFor(controller, a.x, a.y);
  tap(canvas, clientX, clientY);
  assert.deepEqual(state.selection, [a.id], "a single tap on a unit just selects it, like a single click (sanity check)");

  tap(canvas, clientX, clientY);   // second tap, same spot, immediately after
  assert.deepEqual([...state.selection].sort(), [a.id, b.id].sort(),
    "a double-tap grabs every same-type unit on screen, exactly like dblclick");
});

test("two taps far apart on screen are NOT a double-tap — the second lands as an ordinary command instead", () => {
  const { state, canvas, controller } = setup();
  const [a] = placeTwoSkiffs(state);
  state.selection = [];

  const first = clientFor(controller, a.x, a.y);
  tap(canvas, first.clientX, first.clientY);   // selects `a` (see the distance argument in the test above)
  assert.deepEqual(state.selection, [a.id], "the first tap alone just selects a (sanity check)");

  // Dispatched an instant later (well inside DOUBLE_TAP_MS), but DOUBLE_TAP_DIST (30 client px)
  // away from the first tap — distance alone must disqualify this as a double-tap, even with
  // essentially zero time elapsed between the two taps.
  const far = { clientX: first.clientX + 200, clientY: first.clientY };
  tap(canvas, far.clientX, far.clientY);

  assert.deepEqual(state.selection, [a.id], "the far tap did not extend the selection to every skiff on screen");
  assert.deepEqual(a.order, { type: "move", x: 2200, y: 2000 },
    "instead it was read as an ordinary command for the standing selection — the same plain-move fallback commandAt uses elsewhere");
});
