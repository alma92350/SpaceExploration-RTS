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
const { clockEl, scoreBarEl, idleProductionEl, gateChipEl, canvas } = await import("../dom.js");

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

/* ============================================================
   Persistent Antimatter Gate charge strip (docs/improvement-proposals.md lines 745-753): today
   the Gate's charge is visible only in boot.js's 25%-milestone toasts or by keeping the Gate
   itself selected in hudSelection.js's own wonder panel — invisible while the player is off
   defending the waves a charging Gate provokes (per CHANGELOG), and a stall (starved feed goods
   or throttled Power) is completely silent. renderHUD now finds the player's wonder-flagged
   building — gated on game.galaxy only, the same Odyssey idiom the power readout above already
   uses — and renders a slim persistent chip: percentage + color tier warming with progress,
   flipping to a "stalled" state when charge hasn't advanced since the last tick observed it.
   Clicking it centers the camera on the Gate, mirroring boot.js's underAttackEl click handler.
   ============================================================ */

// A player (or rival) wonder-flagged building, at a chosen charge. `charge` left undefined
// leaves `building.charge` completely unset — exactly what engine/wonder.js's updateWonder
// itself leaves a just-completed Gate with, before anything has fed it a first tick of progress.
function addGate(state, owner, charge, opts = {}) {
  const gate = makeBuilding("antimatter_gate", owner, opts.x ?? 400, opts.y ?? 300, opts);
  if (charge !== undefined) gate.charge = charge;
  state.buildings.set(gate.id, gate);
  return gate;
}

test("renderHUD: no gate chip in a skirmish — gated on game.galaxy only, even with a wonder-flagged building present", () => {
  const state = setup(420);   // setup()'s own default leaves game.galaxy null
  addGate(state, "player", 0.5);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: no gate chip in an Odyssey with no player-owned wonder", () => {
  setup(421);
  game.galaxy = {};

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: no gate chip for an AI-owned Gate — the strip watches the player's own clock, not a rival's", () => {
  const state = setup(422);
  game.galaxy = {};
  addGate(state, "ai", 0.5);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: no gate chip while the Gate is still under construction", () => {
  const state = setup(423);
  game.galaxy = {};
  addGate(state, "player", undefined, { constructing: true });

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), true);
});

test("renderHUD: shows the gate chip with the rounded charge once game.galaxy exists and a player wonder is present", () => {
  const state = setup(424);
  game.galaxy = {};
  addGate(state, "player", 0.417);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("hidden"), false);
  assert.equal(gateChipEl.textContent, "🌀 Gate 42% · provoking neighbours");
});

test('renderHUD: a freshly-completed Gate at exactly 0% charge reads as stalled, not "provoking neighbours"', () => {
  const state = setup(425);
  game.galaxy = {};
  addGate(state, "player", undefined);   // a just-finished Gate: nothing fed into it yet

  renderHUD();

  assert.equal(gateChipEl.textContent, "🌀 Gate 0% · stalled");
  assert.equal(gateChipEl.classList.contains("stalled"), true);
});

test("renderHUD: the gate chip's color tier warms as charge climbs, and drops warm/hot as appropriate", () => {
  const state = setup(426);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.3);

  renderHUD();
  assert.equal(gateChipEl.classList.contains("warm"), false);
  assert.equal(gateChipEl.classList.contains("hot"), false);

  gate.charge = 0.6;
  renderHUD();
  assert.equal(gateChipEl.classList.contains("warm"), true);
  assert.equal(gateChipEl.classList.contains("hot"), false);

  gate.charge = 0.9;
  renderHUD();
  assert.equal(gateChipEl.classList.contains("hot"), true);
  assert.equal(gateChipEl.classList.contains("warm"), false);
});

test("renderHUD: the gate chip is not stalled on the very first sighting of a charging wonder", () => {
  const state = setup(427);
  game.galaxy = {};
  addGate(state, "player", 0.3);

  renderHUD();

  assert.equal(gateChipEl.classList.contains("stalled"), false,
    "no prior tick to compare against yet, so this must not read as a stall");
});

test("renderHUD: the gate chip flips to a stalled state when charge hasn't advanced since the last tick", () => {
  const state = setup(428);
  game.galaxy = {};
  addGate(state, "player", 0.3);

  renderHUD();   // establishes the baseline tick
  renderHUD();   // charge unchanged since that baseline

  assert.equal(gateChipEl.classList.contains("stalled"), true);
  assert.match(gateChipEl.textContent, /stalled/);
});

test("renderHUD: the gate chip stays out of the stalled state while charge keeps climbing tick over tick", () => {
  const state = setup(429);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.3);

  renderHUD();
  gate.charge = 0.35;   // real progress since the last tick
  renderHUD();

  assert.equal(gateChipEl.classList.contains("stalled"), false);
  assert.match(gateChipEl.textContent, /provoking neighbours/);
});

test("renderHUD: a Gate razed and rebuilt starts its own clean stalled comparison instead of reading the dead Gate's last charge", () => {
  const state = setup(430);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.6);
  renderHUD();
  renderHUD();   // the old Gate reads stalled at 60% (two ticks, no change)
  assert.equal(gateChipEl.classList.contains("stalled"), true, "sanity: the old Gate really is showing stalled");

  state.buildings.delete(gate.id);   // razed mid-charge
  addGate(state, "player", 0.02, { x: 500, y: 500 });   // freshly rebuilt, low charge, genuinely advancing
  renderHUD();

  assert.equal(gateChipEl.classList.contains("stalled"), false,
    "a brand-new wonder id must not be judged against the destroyed Gate's final charge");
});

test("renderHUD: the topbar signature guard skips the gate chip too — an unrelated HUD change doesn't force a spurious re-render", () => {
  const state = setup(431);
  game.galaxy = {};
  addGate(state, "player", 0.5);

  renderHUD();   // priming tick: establishes game.lastGateCharge
  renderHUD();   // "before" snapshot -- charge unchanged since the priming tick, so this is already stable
  const before = gateChipEl.textContent;
  assert.ok(before.length > 0);

  gateChipEl.textContent = "SENTINEL";   // stomp — a real rebuild would overwrite this
  state.time += 5;   // an unrelated HUD change (the clock), not part of the topbar signature
  renderHUD();

  assert.equal(gateChipEl.textContent, "SENTINEL",
    "nothing the topbar signature tracks changed, so the chip's DOM must not be touched");
});

test("renderHUD: the topbar signature guard still rebuilds the chip once the tracked charge actually changes", () => {
  const state = setup(432);
  game.galaxy = {};
  const gate = addGate(state, "player", 0.5);

  renderHUD();
  renderHUD();
  gateChipEl.textContent = "SENTINEL";
  gate.charge = 0.7;   // a real, tracked change
  renderHUD();

  assert.notEqual(gateChipEl.textContent, "SENTINEL");
  assert.match(gateChipEl.textContent, /70%/);
});

test("clicking the gate chip centers the camera on the Gate, mirroring boot.js's underAttackEl click handler", () => {
  const state = setup(433);
  game.galaxy = {};
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  const cx = state.map.width / 2, cy = state.map.height / 2;
  addGate(state, "player", 0.5, { x: cx, y: cy });
  const camera = { x: 0, y: 0, zoom: 1 };
  game.input.getCamera = () => camera;

  renderHUD();
  gateChipEl.click();

  assert.equal(camera.x, cx);
  assert.equal(camera.y, cy);
});

test("clicking the gate chip when there is no player wonder is a no-op", () => {
  setup(434);
  game.galaxy = {};
  const camera = { x: 111, y: 222, zoom: 1 };
  game.input.getCamera = () => camera;

  renderHUD();   // no wonder -- chip stays hidden
  gateChipEl.click();

  assert.equal(camera.x, 111);
  assert.equal(camera.y, 222);
});

test("clicking the gate chip never throws with no active game", () => {
  game.state = null;
  game.input = null;
  game.galaxy = null;

  assert.doesNotThrow(() => gateChipEl.click());
});
