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
const { createGameState, makeBuilding } = await import("../engine/state.js");
const { mulberry32 } = await import("../engine/rng.js");
const { panelEl } = await import("../dom.js");
const { renderSelectionPanel, resetSelectionSignature } = await import("../hudSelection.js");
const { queueProduction, researchUpgrade } = await import("../engine/production.js");
const { UNITS, UPGRADES } = await import("../engine/entities.js");

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

// factoryStatus's {cls,text} (hudSelection.js:578-599) becomes the ONE "sel-note <cls>" div
// rebuildSelectionPanel appends right after the recipe row (hudSelection.js:986-990) — but
// three OTHER sel-note rows in that very same factory panel (Larder, Output, Grid, Ice Coolant)
// can carry the exact same cls words ("bad"/"warn"/"good") for their OWN unrelated reasons (a
// brimming output buffer is ALSO "bad", a far-flung Smelter's grid line is ALSO "warn", …), so
// matching on cls alone would be ambiguous. Matched instead by TEXT PREFIX: the five strings
// factoryStatus actually returns ("Paused"/"Stalled"/"Starved"/"Throttled"/"Running") are the
// only text in the whole panel that starts with those words.
const FACTORY_STATUS_PREFIXES = ["Paused", "Stalled", "Starved", "Throttled", "Running"];
function findStatusLine() {
  return panelEl.children.find(c => c.tagName === "div" && c.className.startsWith("sel-note")
    && FACTORY_STATUS_PREFIXES.some(p => c.textContent.startsWith(p)));
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

/* ---------------------------------------------------------------------------------------------
   TARGET 3 — factoryStatus (hudSelection.js:578-599): a genuinely PURE function (no DOM at all)
   that picks a selected factory's status line by PRIORITY — paused, then no Power, then starved
   of a specific input, then a full output buffer, then a Power shortfall throttling everything,
   else running with the live rate. Reached only through renderSelectionPanel(), same as every
   other target in this file, by selecting a real factory building and reading back the ONE
   "sel-note" row it renders (findStatusLine, above). Each test below builds a factory that could
   plausibly match TWO reasons at once and checks the row shows the HIGHER-priority one — not
   just that each reason works in isolation.
   --------------------------------------------------------------------------------------------- */

// A completed Smelter (ore + power -> metals, data.js RECIPES.smelt, prodRate 2) — the simplest
// factory in the game, and the one every test below standardises on. Selecting it REPLACES the
// selection setup() already made (the Command Center it picked stays a building in
// state.buildings, just dropped from state.selection), so the panel's factory branch
// (hudSelection.js:973) is the only sub-panel in play — nothing about a Command Center muddies
// the DOM tree findStatusLine reads back.
function makeSmelter(state, fields = {}) {
  const sm = makeBuilding("smelter", "player", 500, 500);
  Object.assign(sm, fields);
  state.buildings.set(sm.id, sm);
  state.selection = [sm.id];
  return sm;
}

// A completed, fuelled Reactor (energyGrants 30, entities.js). powerCap/powerDraw
// (engine/industry.js) only count a combust-fuelled source as ACTIVE once `powered` is true —
// real play sets that from updateCombustors ticking its own fuel larder down, but these tests
// never call tick()/updateCombustors, so it's set by hand here, the same shortcut
// industry.test.js's "a high-industry world…" test takes for the identical reason.
function makeReactor(state, x = 500, y = 500) {
  const r = makeBuilding("reactor", "player", x, y);
  r.powered = true;
  state.buildings.set(r.id, r);
  return r;
}

test("factoryStatus: paused beats every other reason at once — no Power, starved, AND a full output buffer are ALSO true here", () => {
  const { state } = setup(206);
  // No Reactor anywhere (no Power too), an empty input larder (starved too), and the output
  // buffer already at its 80-unit cap (buffer-full too) — paused is checked FIRST in the source
  // (hudSelection.js:579), so it alone should win the row even though every other branch below
  // it would also fire if it were ever reached.
  makeSmelter(state, { paused: true, input: {}, store: { metals: 80 } });

  renderSelectionPanel();
  const row = findStatusLine();
  assert.ok(row, "expected the factory status row to render");
  assert.equal(row.className, "sel-note paused");
  assert.equal(row.textContent, "Paused — banking its inputs");
});

test("factoryStatus: no Power beats starved when both are true", () => {
  const { state } = setup(207);
  // No Reactor at all ⇒ powerThrottle is 0 ⇒ "no Power" (hudSelection.js:581) — and the input
  // larder is ALSO empty, so the starved check just below it (hudSelection.js:592) would fire
  // too, if the no-Power branch above it hadn't already returned.
  makeSmelter(state, { input: {} });

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note bad");
  assert.equal(row.textContent, "Stalled — no Power");
});

test("factoryStatus: starved beats a full output buffer when both are true, and names the scarce input", () => {
  const { state } = setup(208);
  makeReactor(state);
  // Fully powered (throttle 1, so the no-Power check above it is out of the running) — but the
  // input larder is empty (starved) AND the output buffer already sits at its 80-unit cap
  // (buffer-full), so BOTH hudSelection.js:592 and :593 would match; starved is checked first
  // and should win.
  makeSmelter(state, { input: {}, store: { metals: 80 } });

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note bad");
  assert.equal(row.textContent, "Starved — needs Ore carried in",
    "names the ONE scarce commodity the smelt recipe needs (ore) — the only non-energy input it has");
});

// Both of the next two tests share this rig: 1 Reactor (cap 30) + 6 on-grid Smelters (draw 4
// each: smelt's energy 2 × prodRate 2) + 2 on-grid Assembly Plants (draw 3 each: alloy's energy
// 2 × prodRate 1.5) = 24 + 6 = 30 — exactly SATURATING the Reactor with zero slack (throttle
// would be a flat 1.0 with nothing else drawing). `extra` PAUSED Machine Works are then added
// purely as fine-grained Power-draw ballast on top: a paused factory still idles at a
// PAUSED_POWER_FRACTION (5%, industry.js) standby trickle of its own recipe's draw, and Machine
// Works' recipe (data.js RECIPES.machine) draws the LEAST of any factory in the game (1 energy ×
// prodRate 1) — so paused, each one adds exactly 0.05 draw, the finest knob powerDraw exposes.
// That makes the exact 0.995 throttle line (hudSelection.js:594) reachable with real buildings
// instead of a guess: 30/(30+0.05·3) = 200/201 ≈ 0.995025 (just ABOVE the line) and
// 30/(30+0.05·4) = 150/151 ≈ 0.993377 (just BELOW it) — both fractions checked once against the
// literal `0.995` in a node REPL before being written in below, not eyeballed. Being paused (and
// never selected), the filler Machine Works never render a status row of their own — only the
// one selected Smelter's does.
function throttleRig(state, extraPausedMachineWorks) {
  makeReactor(state);
  const sm = makeSmelter(state, { input: { ore: 1000 } });   // the SELECTED factory — plenty of ore, never starved
  for (let i = 0; i < 5; i++) {
    const filler = makeBuilding("smelter", "player", 520 + i * 8, 500);
    state.buildings.set(filler.id, filler);
  }
  for (let i = 0; i < 2; i++) {
    const filler = makeBuilding("assembler", "player", 580 + i * 8, 500);
    state.buildings.set(filler.id, filler);
  }
  for (let i = 0; i < extraPausedMachineWorks; i++) {
    const filler = makeBuilding("machineworks", "player", 620 + i * 8, 500);
    filler.paused = true;
    state.buildings.set(filler.id, filler);
  }
  return sm;
}

test("factoryStatus: throttle just under the 0.995 line reads Throttled, not Running", () => {
  const { state } = setup(209);
  throttleRig(state, 4);   // total draw 30.2 -> throttle 150/151 ≈ 0.993377, which IS < 0.995

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note warn");
  assert.equal(row.textContent, "Throttled 99% — low Power");
});

test("factoryStatus: throttle AT the 0.995 line (not below it) reads Running, with the live output rate", () => {
  const { state } = setup(210);
  throttleRig(state, 3);   // total draw 30.15 -> throttle 200/201 ≈ 0.995025, which is NOT < 0.995

  renderSelectionPanel();
  const row = findStatusLine();
  assert.equal(row.className, "sel-note good");
  // rate = prodRate 2 × planetIndustryScale(ferros, industry 4) 0.8 × throttle (200/201) ×
  // recipe.qty 2 — no techs researched, so both techMult factors are the neutral 1×. Computed
  // once in the same node REPL as the throttle fractions above (3.18407960199005, toFixed(1)
  // "3.2"), not re-derived by hand here.
  assert.equal(row.textContent, "Running · +3.2 Metals/s",
    "the `<` in hudSelection.js:594 must let a throttle sitting exactly ON 0.995 through, not just above it");
});

/* ---------------------------------------------------------------------------------------------
   TARGET 4 — the Refinery's doctrine-lock vs tier-lock precedence (hudSelection.js:886-890):
   `doctrineLocked` (committed to a DIFFERENT doctrine) and `tierLocked` (this upgrade's own
   Tier-1 isn't researched yet) are computed independently and OR'd into one `locked` flag, but
   the lockTip STRING picks doctrine's message over tier's whenever both are true. The doctrine
   is committed via the real researchUpgrade (engine/production.js) on a real state, never by
   hand-setting player.upgrades — so a regression in researchUpgrade's OWN doctrine gate would
   surface here too.
   --------------------------------------------------------------------------------------------- */

// Mirrors hudSelection.js's own module-private `label` map inside the refinery branch
// (hudSelection.js:876) — kept local for the same reason costText() is: so a button's title is
// checked against the real doctrine names, not a hand-typed guess that could drift.
const DOCTRINE_LABEL = { assault: "Assault", bulwark: "Bulwark", logistics: "Logistics" };

// A completed Refinery, selected alone — the Research sub-panel (hudSelection.js:872-896) is a
// flat, ungrouped button-per-upgrade list (no separate tree UI), so this is the only building
// whose selection ever renders it.
function selectRefinery(state) {
  const refinery = makeBuilding("refinery", "player", 500, 500);
  state.buildings.set(refinery.id, refinery);
  state.selection = [refinery.id];
  return refinery;
}

// Mirrors the refinery branch's own button label format (hudSelection.js:891) — kept local for
// the same "match the real data, don't hand-type a copy" reason costText()/WORKER_LABEL are.
// Every UPGRADES entry carries an `ico` (unlike the Worker button WORKER_LABEL matches against,
// which takes makeButton's SPRITE-icon path), so — same as makeButton's own emoji-icon branch
// (hudSelection.js:1558-1561, appended before the label span at :1571) — buttonLabel() reads the
// icon's textContent back FIRST, with no separator: the emoji has to lead here too, or findButton
// (a plain .startsWith) never matches.
function upgradeButtonLabel(u) {
  return `${u.ico || ""}Research ${u.name} · ${DOCTRINE_LABEL[u.doctrine]} (${costText(u.cost)})`;
}

test("Refinery research: doctrine-lock wins over tier-lock when a button is BOTH — committed to a different doctrine AND its own Tier-1 is unmet", () => {
  const { state } = setup(211);
  const refinery = selectRefinery(state);
  Object.assign(state.players.player.resources, { ore: 2000, crystals: 2000, radioactives: 2000 });

  // Commit to Assault for real, through the exact gate the button's own click handler calls —
  // not by poking player.upgrades directly.
  assert.equal(researchUpgrade(state, refinery.id, "overchargedWeapons"), true, "sanity: commits the Assault doctrine");

  renderSelectionPanel();
  // Reinforced Bulwark is Bulwark's Tier-2 — a DIFFERENT doctrine than the one just committed
  // (doctrineLocked true) — AND its own Tier-1 (Reinforced Plating) was never researched
  // (tierLocked ALSO true): both locks apply to this one button at once.
  const btn = findButton(upgradeButtonLabel(UPGRADES.reinforcedBulwark));
  assert.ok(btn, "expected the Reinforced Bulwark research button in the rebuilt panel");
  assert.ok(btn.classList.contains("disabled"), "locked (by either reason) ⇒ greyed out");
  assert.equal(btn.title, "Locked — committed to the Assault doctrine",
    "the doctrine-locked message must win over the tier-locked one when both are true");
  assert.ok(!btn.title.includes("Requires"), "must NOT show the tier-locked wording here");

  // And the lock is REAL, not just cosmetic: same idiom as TARGET 1's disabled-click check —
  // clicking a locked button must never grant the upgrade underneath the misleading tip.
  btn.click();
  assert.equal(state.players.player.upgrades.reinforcedBulwark, undefined, "a locked button's click must never research the upgrade");
});

test("Refinery research: with the SAME doctrine committed, an unmet Tier-1 alone shows the tier-locked message (sanity baseline)", () => {
  const { state } = setup(212);
  const refinery = selectRefinery(state);
  Object.assign(state.players.player.resources, { ore: 2000, crystals: 2000, radioactives: 2000 });

  // Commit to Logistics via its OWN Tier-1 (Logistics Network). Field Recycling is Logistics'
  // Tier-3: its doctrine is already satisfied (doctrineLocked false — chosen === u.doctrine) but
  // its own Tier-2 prereq (Rapid Fabrication) was never researched (tierLocked true) — only ONE
  // of the two locks applies to this button.
  assert.equal(researchUpgrade(state, refinery.id, "logisticsNetwork"), true, "sanity: commits the Logistics doctrine");

  renderSelectionPanel();
  const btn = findButton(upgradeButtonLabel(UPGRADES.recycling));
  assert.ok(btn, "expected the Field Recycling research button in the rebuilt panel");
  assert.ok(btn.classList.contains("disabled"));
  assert.equal(btn.title, "Requires Rapid Fabrication", "same doctrine ⇒ only the tier-locked message applies");
});
