import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
import { createGameState, makeBuilding } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";

/* ============================================================
   hud.js's endgame clock (docs/improvement-proposals.md "Make the clock endgame visible, honest,
   and configurable"): inside the final 5 minutes of a skirmish's score-decision clock, renderHUD
   flips #matchClock from elapsed time to a countdown and shows a compact two-sided score bar
   (playerScore(state,"player"/"ai")) — the score is otherwise completely invisible in-game, per
   the proposal's own Problem statement.

   renderHUD has no dedicated test file today. The DOM/import-graph setup below is test/
   hudSelection.test.js's own FakeElement/fakeDocument, reused near verbatim (see that file's
   header comment for the full empirical trace of why each piece is needed) — hud.js imports
   hudSelection.js directly (renderSelectionPanel), so the exact same transitive graph (render.js,
   boot.js, engine/*, …) has to import cleanly under Node, and that file already proves this
   fakeDocument does it.
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
  set innerHTML(v) { if (v === "") this.children = []; }
  get innerHTML() { return ""; }
  querySelector(selector) { return this._queryAll(selector)[0] || null; }
  querySelectorAll(selector) { return this._queryAll(selector); }
  _queryAll(selector) {
    const cls = selector.slice(1);
    const out = [];
    const walk = kids => { for (const c of kids) { if (c._classes?.has(cls)) out.push(c); if (c.children) walk(c.children); } };
    walk(this.children);
    return out;
  }
  getContext() { return fakeCtx(); }
  toDataURL() { return "data:image/fake,"; }
  click() { this.dispatchEvent(new Event("click")); }
}

function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}

function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    body,
  };
}

globalThis.document = fakeDocument();
// `window` deliberately left undefined, same reasoning as hudSelection.test.js/overlays.test.js:
// every `typeof window !== "undefined"` guard in the imported graph stays off, so no real
// timer/listener starts on import.

sound.setMuted(true);   // renderSelectionPanel's icon buttons can synthesize a blocked-click buzz; keep it silent and AudioContext-free

const { game } = await import("../session.js");
const { renderHUD, resetPanelSignature } = await import("../hud.js");
const { clockEl, scoreBarEl, idleProductionEl } = await import("../dom.js");

function setup(seed, opts = {}) {
  resetPanelSignature();
  const state = createGameState({ planetId: "ferros", seed, rng: mulberry32(seed), ...opts });
  game.state = state;
  game.galaxy = null;
  game.input = { building: null, attackArmed: false, focusIdleWorker() {}, focusIdleProducer() {}, selectAllArmy() {}, groupCounts: () => [] };
  game.supplyBlockedUntil = 0;
  state.selection = [];
  return state;
}

test("renderHUD: outside the final 5 minutes, the clock shows plain elapsed time and the score bar stays hidden", () => {
  const state = setup(401);
  state.time = 120;   // 2:00 elapsed, nowhere near the 40-minute default's final 5

  renderHUD();

  assert.equal(clockEl.textContent, "2:00");
  assert.equal(scoreBarEl.classList.contains("hidden"), true, "the score bar only appears once the endgame window opens");
});

test("renderHUD: inside the final 5 minutes, the clock flips to a countdown and the score bar shows both sides' scores", () => {
  const state = setup(402);
  state.time = DEFAULT_MATCH_TIME_LIMIT - 60;   // exactly 1:00 left on the default 40-minute clock

  renderHUD();

  assert.equal(clockEl.textContent, "-1:00", "a countdown, not elapsed time, once inside the final 5 minutes");
  assert.equal(scoreBarEl.classList.contains("hidden"), false);
  assert.match(scoreBarEl.textContent, /\d+/, "the score bar should show at least one numeric score");
});

test("renderHUD: the countdown respects a matchTimeLimit override, not just the 40-minute default", () => {
  const state = setup(403, { matchTimeLimit: 1200 });   // "Quick 20"
  state.time = 1200 - 30;   // 0:30 left on the SHORT override

  renderHUD();

  assert.equal(clockEl.textContent, "-0:30",
    "the override, not DEFAULT_MATCH_TIME_LIMIT, decides when the endgame window opens");
});

test("renderHUD: right at the 5-minute mark the clock is already a countdown; a second earlier it is still elapsed time", () => {
  const state = setup(404);

  state.time = DEFAULT_MATCH_TIME_LIMIT - 301;   // 5:01 left — just outside the window (34:59 elapsed)
  renderHUD();
  assert.equal(clockEl.textContent, "34:59", "5:01 remaining is still outside the final-5-minutes window");
  assert.equal(scoreBarEl.classList.contains("hidden"), true);

  state.time = DEFAULT_MATCH_TIME_LIMIT - 300;   // exactly 5:00 left — the boundary itself
  renderHUD();
  assert.equal(clockEl.textContent, "-5:00", "5:00 remaining is the boundary — inside the window");
  assert.equal(scoreBarEl.classList.contains("hidden"), false);
});

test("renderHUD: Odyssey (a galaxy in play) never shows the countdown/score bar, even at a huge elapsed time — there is no clock to count down to", () => {
  const state = setup(405, { endless: true });
  game.galaxy = {};   // only truthiness matters to hud.js's own Odyssey gate elsewhere in this file
  state.time = 100000;   // absurdly long — would be deep past any skirmish time limit

  renderHUD();

  assert.equal(scoreBarEl.classList.contains("hidden"), true, "the open-world sandbox has no timeout-score tiebreak to warn about");
  assert.doesNotMatch(clockEl.textContent, /^-/, "never a countdown for a mode with no clock at all");
});

/* ============================================================
   Idle-production topbar chip (docs/improvement-proposals.md "Space cycles bases and an
   idle-production topbar chip"): counts completed player production buildings
   (BUILDINGS[type].produces, !constructing, queue.length === 0) next to the idle-worker loop —
   multiple Barracks are normal mid-game, and an empty queue on one you aren't looking at is
   otherwise invisible.
   ============================================================ */

test("renderHUD: the idle-production chip already reads '1 idle' at kickoff — the seeded, empty-queue Command Center counts", () => {
  const state = setup(410);

  renderHUD();

  assert.equal(idleProductionEl.textContent, "🏭 1 idle");
  assert.equal(idleProductionEl.classList.contains("hidden"), false);

  // Queue something on it — the only producer in a fresh skirmish — and the chip hides at zero.
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.queue.push({ unitType: "worker", progress: 0 });
  renderHUD();

  assert.equal(idleProductionEl.classList.contains("hidden"), true, "a non-empty queue takes the only producer out of the idle count");
});

test("renderHUD: the idle-production count only includes finished buildings that actually produce something", () => {
  const state = setup(411);
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  cc.queue.push({ unitType: "worker", progress: 0 });   // no longer idle — isolate the count to what's added below

  const idleBarracks = makeBuilding("barracks", "player", 200, 200);
  state.buildings.set(idleBarracks.id, idleBarracks);   // produces, completed, empty queue -> counts

  const constructingBarracks = makeBuilding("barracks", "player", 260, 200, { constructing: true });
  state.buildings.set(constructingBarracks.id, constructingBarracks);   // still constructing -> must not count

  const refinery = makeBuilding("refinery", "player", 320, 200);
  state.buildings.set(refinery.id, refinery);   // no `produces` (it researches upgrades) -> must not count

  renderHUD();

  assert.equal(idleProductionEl.textContent, "🏭 1 idle", "only the finished, empty-queue Barracks counts");
  assert.equal(idleProductionEl.classList.contains("hidden"), false);
});
