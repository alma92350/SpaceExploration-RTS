import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";

/* ============================================================
   hudSelection.js builds the whole selection panel with direct DOM calls
   (document.createElement / panelEl.appendChild / classList / …) and exports
   exactly two functions — renderSelectionPanel() and resetSelectionSignature()
   — everything else (makeButton, the signature guard, every sub-panel
   renderer) is module-private. So the only way to exercise any of it is to
   give it a `document` that behaves enough like the real one, drive it
   through renderSelectionPanel(), and inspect the fake tree it built.

   dom.js resolves every element handle ONCE, at import time, via
   doc.getElementById(id) (doc = typeof document !== "undefined" ? document :
   null — dom.js:16-17). So globalThis.document has to exist BEFORE
   hudSelection.js (or anything that transitively imports dom.js) is first
   imported — under `node --test`'s native ESM loader that means a dynamic
   import() after the stub is installed, not a static one. See
   test/saveload.test.js:1-46 for the identical constraint on saveload.js's
   import graph, which that comment confirms already includes hudSelection.js
   and traces the graph for unguarded module-scope DOM access.

   That file's stubEl() clears the "don't throw at import time" bar (every
   module-scope .addEventListener call it needs to survive — hud.js:31-32,
   boot.js:68 — succeeds against a no-op), but it hands back the SAME inert
   object for every id and hardcodes classList.contains to false. Useless
   here: TARGET 1 needs to read back one SPECIFIC button's real classList,
   and TARGET 2 needs to compare SPECIFIC node references across two renders.
   FakeElement below tracks real per-instance class state and a real children
   array instead, and — being a real EventTarget — supports the same
   .addEventListener calls stubEl's no-ops were standing in for.
   ============================================================ */

class FakeElement extends EventTarget {
  constructor(tag = "div") {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      toggle: (c, f) => { f === undefined ? (this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c)) : (f ? this._classes.add(c) : this._classes.delete(c)); },
      contains: c => this._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { this.children.push(...cs); }
  set innerHTML(v) { if (v === "") this.children = []; }   // the only value rebuildSelectionPanel ever assigns it
  get innerHTML() { return ""; }
  querySelector() { return null; }    // renderSelectionPanel's live-patch ("skip") branch tolerates this —
  querySelectorAll() { return []; }   // it always guards with `if (row) …` / `rows[i] &&`, never assumes a hit
  // makeButton's {kind,type} icon path (render.js spriteIcon, called for every produce/build
  // button) draws into a real 2D context and reads canvas.toDataURL() back. Both have to
  // succeed, or spriteIcon's own catch fires a console.error on EVERY icon button, on every
  // single render, in every test below — see fakeCtx() just below for why a Proxy is enough.
  getContext() { return fakeCtx(); }
  toDataURL() { return "data:image/fake,"; }
  click() { this.dispatchEvent(new Event("click")); }   // mirrors real HTMLElement#click(); hudSelection.js's own prodButton (line 694) calls this itself for hotkey replay
}

// Same no-op-Proxy idiom as test/renderBuildings.test.js's fakeCtx(): any method call is a silent
// no-op, any property read/write round-trips through a plain backing object — so it tolerates
// whatever drawUnitShape/drawBuildingShape happen to call (scale/translate/fillStyle/strokeStyle/
// gradients/…) without hand-enumerating the 2D canvas API, and stays robust to unrelated changes
// in those drawing functions.
function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}

function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    // Real per-id identity — unlike saveload.test.js's stubEl(), which hands back an unrelated
    // fresh object on every single call, dom.js resolves each handle exactly ONCE at import time
    // (dom.js:20-52) and every later doc.getElementById(sameId) here must keep returning that
    // SAME object, or dom.js's exported `panelEl` would silently diverge from what hud.js/
    // hudSelection.js are actually appending to.
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    body,
  };
}

globalThis.document = fakeDocument();

// sound.js's tone() unconditionally reaches for window.AudioContext when unmuted; nothing here
// stubs one, so mute up front — same reasoning as test/input.test.js. A DISABLED button's click
// handler (makeButton, hudSelection.js:1586-1589) calls sound.playProductionBlocked() as its
// whole "denied" feedback, and that call has to survive without a real AudioContext for TARGET
// 1's disabled-click tests below to run at all.
sound.setMuted(true);

const { game } = await import("../session.js");
const { createGameState } = await import("../engine/state.js");
const { mulberry32 } = await import("../engine/rng.js");
const { panelEl } = await import("../dom.js");
const { renderSelectionPanel, resetSelectionSignature } = await import("../hudSelection.js");
const { queueProduction } = await import("../engine/production.js");
const { UNITS } = await import("../engine/entities.js");

// Mirrors hudSelection.js's own module-private costText() (hudSelection.js:1509) — kept local so
// a button's label is matched against UNITS' REAL cost, not a hand-typed "50 ore" that could
// quietly drift from entities.js the next time the Worker gets rebalanced.
function costText(cost) {
  return Object.entries(cost).map(([com, qty]) => `${qty} ${com}`).join(", ");
}

// makeButton (hudSelection.js:1550) puts the label straight on btn.textContent UNLESS the button
// has a sprite icon, in which case the label lives on a nested .btn-label span instead
// (btn.append(iconEl, span), hudSelection.js:1566-1571) and btn.textContent is never touched.
// Every produce/build button in this suite takes the icon path (spriteIcon succeeds against
// fakeCtx above), so a label reader has to check both shapes.
function buttonLabel(el) {
  return el.children.length ? el.children.map(c => c.textContent || "").join("") : (el.textContent || "");
}

function findButton(labelPrefix) {
  return panelEl.children.find(c => c.tagName === "button" && buttonLabel(c).startsWith(labelPrefix));
}

// Same list, position-for-position: true only if EVERY slot holds the exact same object as
// before. assert.deepEqual would call two DIFFERENT-but-identically-shaped button objects
// "equal" too — precisely the false positive TARGET 2 has to rule out (a skip proven only by
// looking the same, not by literally being the same node).
function sameNodes(a, b) {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

// Fresh engine state with a real Command Center selected — the shared starting point for every
// test below. resetSelectionSignature() is NOT optional here: lastPanelSignature (hudSelection.js
// :66) is module-scope and OUTLIVES any single test, and createGameState() resets its entity-id
// counter to 1 on every call (engine/state.js:22,87) — so two unrelated tests' Command Centers
// both mint id "b1", and with everything else about a fresh two-worker skirmish state identical
// too, can produce byte-identical signature strings. Without a reset, a later test's very FIRST
// render could wrongly hit the "nothing changed" branch and inherit the previous test's stale
// DOM — verified empirically while building this file (a sentinel object pushed onto panelEl.
// children survived a fresh createGameState() + render with no reset in between).
function setup(seed) {
  resetSelectionSignature();
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
  game.state = state;
  game.input = { building: null, attackArmed: false, focusIdleWorker() {}, selectAllArmy() {} };
  game.galaxy = null;
  game.collapsedSections = new Set();
  game.hotkeyActions = [];   // the shape rebuildSelectionPanel (hudSelection.js:722) overwrites on every real rebuild
  const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
  state.selection = [cc.id];
  return { state, cc };
}

// "Produce Worker (50 ore)" — the base-cost button (as opposed to the Worker's altCost biomass
// button, which is a separate button with a different label and stays disabled throughout since
// these tests never grant the player any biomass).
const WORKER_LABEL = `Produce Worker (${costText(UNITS.worker.cost)})`;

/* ---------------------------------------------------------------------------------------------
   TARGET 1 — makeButton's affordable gate (hudSelection.js:1550-1594): a button with a `cost`
   greys out unless canAfford(resources, cost), and a disabled button's click plays the denied
   buzz instead of ever calling the real action.
   --------------------------------------------------------------------------------------------- */

test("produce-Worker button is disabled and its click is inert when the player can't afford the cost", () => {
  const { state, cc } = setup(101);
  state.players.player.resources.ore = 10;   // Worker costs 50 ore (UNITS.worker.cost) — well short

  renderSelectionPanel();
  const btn = findButton(WORKER_LABEL);
  assert.ok(btn, "expected to find the produce-Worker button in the rebuilt panel");
  assert.ok(btn.classList.contains("disabled"), "unaffordable ⇒ makeButton must grey the button out");

  // The concrete bug this guards against: if the `locked || !affordable` gate ever broke (e.g.
  // flipped to `locked && !affordable`), this click would fall through to the REAL handler
  // (queueProduction) instead of just buzzing.
  btn.click();
  assert.deepEqual(cc.queue, [], "a disabled button's click must never queue production");
  assert.equal(state.players.player.resources.ore, 10, "…and must never spend resources either");
});

test("the same produce option ungreys, and its click really queues production, once the player affords the exact cost", () => {
  const { state, cc } = setup(102);
  state.players.player.resources.ore = 50;   // exactly UNITS.worker.cost.ore — canAfford is >=, not >, so this is the boundary

  renderSelectionPanel();
  const btn = findButton(WORKER_LABEL);
  assert.ok(btn, "expected to find the produce-Worker button in the rebuilt panel");
  assert.ok(!btn.classList.contains("disabled"), "affording the exact cost must ungrey the button");

  btn.click();
  assert.equal(cc.queue.length, 1, "an enabled button's click must queue the real production job");
  assert.equal(cc.queue[0].unitType, "worker");
  assert.equal(state.players.player.resources.ore, 0, "…and must actually spend the cost, not just pretend to");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 2 — the panel rebuild-signature memoization. lastPanelSignature/queueSignature/
   availabilitySignature/factorySignature: hudSelection.js:62-135; the gate that compares the
   freshly-built signature against lastPanelSignature and either skips or calls
   rebuildSelectionPanel(): hudSelection.js:278-282.
   --------------------------------------------------------------------------------------------- */

test("renderSelectionPanel skips the rebuild — same DOM node objects, not just same-looking ones — when nothing the signature tracks changed", () => {
  setup(103).state.players.player.resources.ore = 300;

  renderSelectionPanel();   // first call after resetSelectionSignature() always rebuilds (signature can never equal null)
  const before = panelEl.children.slice();
  assert.ok(before.length > 0, "sanity: the CC panel actually rendered something to compare");

  renderSelectionPanel();   // nothing touched game.state/game.input/game.formation/game.collapsedSections/… in between
  assert.ok(sameNodes(panelEl.children, before),
    "re-rendering with no covered change must leave every existing node in place — a real rebuild " +
    "would swap the exact button the player might be mid-click on for a fresh, unclicked one, which " +
    "is precisely the dropped-click bug hudSelection.js's own comment above the signature (lines " +
    "142-149) says this guard exists to prevent");
});

test("renderSelectionPanel rebuilds fresh nodes when the production queue changes under an unchanged selection", () => {
  const { state, cc } = setup(104);
  state.players.player.resources.ore = 300;

  renderSelectionPanel();
  const before = panelEl.children.slice();
  const beforeBtn = findButton(WORKER_LABEL);
  assert.ok(beforeBtn, "sanity: the produce-Worker button exists before the queue changes");

  queueProduction(state, cc.id, "worker");   // queueSignature(sel) (hudSelection.js:90-98) now covers this job
  renderSelectionPanel();

  assert.ok(!sameNodes(panelEl.children, before), "the queue changed — this must be a real rebuild, not a skip");
  assert.equal(panelEl.children.length, before.length + 1,
    "the new queue row (hudSelection.js's renderQueueRows, called once cc.queue.length is truthy) must actually appear");
  assert.ok(panelEl.children.some(c => c.className.includes("queue-row")), "…specifically as a .queue-row");
  assert.notEqual(findButton(WORKER_LABEL), beforeBtn,
    "even the untouched produce button must come back as a fresh node — rebuildSelectionPanel " +
    "clears panelEl (innerHTML = \"\") and re-creates everything, it doesn't patch just the diff");
});

test("renderSelectionPanel rebuilds fresh nodes when a button's affordability crosses the line — how TARGET 1's disabled-class flip is even possible", () => {
  const { state } = setup(105);
  state.players.player.resources.ore = 10;   // unaffordable

  renderSelectionPanel();
  const before = findButton(WORKER_LABEL);
  assert.ok(before, "sanity: the produce-Worker button exists before affording it");
  assert.ok(before.classList.contains("disabled"));
  const beforeCount = panelEl.children.length;

  state.players.player.resources.ore = 300;   // now affordable — availabilitySignature() (hudSelection.js:114-121) must change
  renderSelectionPanel();
  const after = findButton(WORKER_LABEL);

  assert.notEqual(after, before,
    "makeButton only computes `affordable` at BUILD time (hudSelection.js:1577) — the disabled " +
    "class can never change via the live-patch skip path, only via a full rebuild, so crossing " +
    "the affordability line must trigger one (this is the same mechanism the two TARGET-1 tests " +
    "above rely on to see the class flip across their own re-render)");
  assert.ok(!after.classList.contains("disabled"), "…and the fresh node must reflect the new affordability");
  assert.equal(panelEl.children.length, beforeCount,
    "unlike the queue-change rebuild above, this one changes no button's existence — same shape, different identity");
});
