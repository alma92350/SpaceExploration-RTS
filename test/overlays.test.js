import { test } from "node:test";
import assert from "node:assert/strict";
// Pure engine modules — no DOM/window reference anywhere in their own import graph (see
// test/boot.test.js's identical reasoning for engine/state.js) — safe to import statically here,
// before the document/localStorage stubs below even exist. Used by the "reactive opening
// checklist" tests further down this file.
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { deployColonyShip } from "../engine/colony.js";
import { scoreBreakdown, playerScore } from "../engine/victory.js";
import * as sound from "../sound.js";

/* ============================================================
   overlays.js has no existing test file. This one covers showGalaxyToast's MAX_TOASTS=3 eviction
   policy (overlays.js's own header comment on the function, quoted here for reference): "Eviction
   rule at cap: drop the oldest NON-clickable toast; a plain toast never pushes out a clickable one
   (if it would have to, the plain one is dropped instead — it's non-critical)." Reading the
   function itself (overlays.js), that's actually a THREE-way branch once you also ask "what if the
   NEW toast is itself clickable":
     (a) at cap, a non-clickable toast is present -> it's evicted (the oldest ONE, by DOM/insertion
         order — `[...stack.children].find(c => !c._clickable)`), regardless of whether the new
         arrival is clickable or not.
     (b) at cap, ALL THREE existing toasts are clickable, and the new arrival is NOT clickable ->
         nothing is evicted; the new toast is simply never shown (`return null`).
     (c) at cap, ALL THREE existing toasts are clickable, and the new arrival IS clickable -> the
         oldest one overall (`stack.firstElementChild`) is evicted to make room.

   --- import setup -----------------------------------------------------------------------------
   overlays.js imports boot.js (`import { pauseLoop, resumeLoop, togglePause } from "./boot.js"`,
   overlays.js's own comment: "the boot↔overlays cycle resolves via live bindings") — the SAME
   large transitive graph test/boot.test.js's own header comment traces in full (render.js,
   minimap.js, hud.js, hudSelection.js, setup.js, saveload.js, input.js, engine/*, landingPicker.js,
   data.js, sound.js, …), with the same unguarded module-scope DOM calls (hud.js's repairBtn/
   departBtn, boot.js's underAttackEl, saveload.js's saveBtn/loadBtn/homeBtn — none of THOSE three
   guarded by `typeof window !== "undefined"` either, only by a truthy-button check). Proven
   already: hudSelection.js (line 44) imports boot.js directly too, AND hudSelection.js also
   imports overlays.js itself (line 46, for flashHint) — so test/hudSelection.test.js's own
   FakeElement/fakeDocument already imports this exact graph cleanly today, with `window` left
   deliberately UNDEFINED so every `typeof window !== "undefined"` guard anywhere in that graph
   (overlays.js's own help-toggle wiring included) stays off — no real timer/listener starts on
   import. Reused here almost verbatim; the two capabilities added beyond that file's copy:
   showGalaxyToast calls `.remove()` directly on a toast element (`evict.remove()` / `oldest.remove()`
   / the internal `remove` closure's `el.remove()`) — the real DOM's "detach yourself from your
   parent", not exercised by hudSelection.js — and reads `stack.firstElementChild`. Both need real
   parent-tracking, added to appendChild/append below.
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
  // Real per-instance parent tracking (beyond test/hudSelection.test.js's own copy, which never
  // needed it) — see the header comment: showGalaxyToast's eviction removes a CHILD toast
  // directly, the real DOM's Element.remove(), which needs to know its own parent to splice
  // itself out of.
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => { c._parent = this; this.children.push(c); }); }
  remove() {
    if (!this._parent) return;
    const i = this._parent.children.indexOf(this);
    if (i !== -1) this._parent.children.splice(i, 1);
    this._parent = null;
  }
  // children are pushed in append order, so index 0 IS the oldest — what showGalaxyToast's
  // all-clickable eviction branch (`stack.firstElementChild`) needs.
  get firstElementChild() { return this.children[0] || null; }
  // Real (if shallow) innerHTML round-trip — beyond the original "" -> clear-children special
  // case this file's toast tests needed — so showGameOver's score-breakdown div (built with a raw
  // innerHTML template, mirroring showScenarioEnd's own existing idiom) is actually inspectable
  // below, rather than always reading back empty. No real HTML PARSING (nothing here needs the
  // set string to become real child nodes, only to be readable again as the string it was).
  set innerHTML(v) { this._html = v; if (v === "") this.children = []; }
  get innerHTML() { return this._html ?? ""; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getContext() { return null; }
  click() { this.dispatchEvent(new Event("click")); }
}

function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    // Real per-id identity, same reasoning as test/hudSelection.test.js's fakeDocument: dom.js
    // resolves each handle exactly ONCE at import time, and every later doc.getElementById(id)
    // here must keep returning that SAME object, or the exported `galaxyToastEl` this file
    // imports below would silently diverge from what showGalaxyToast is actually appending to.
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    body,
  };
}

globalThis.document = fakeDocument();
// `window` deliberately left undefined — see the header comment: every `typeof window !==
// "undefined"` guard anywhere in the imported graph (overlays.js's own help-toggle wiring,
// saveload.js's autosave timer) stays off, so importing this module starts no real timer or
// listener beyond the per-toast setTimeout the tests below explicitly clean up themselves.

// A minimal in-memory localStorage, for the "reactive opening checklist" tests further down:
// overlays.js's own objectivesFinishedBefore/markObjectivesFinished guard every read/write behind
// `typeof localStorage !== "undefined"` (plain Node has no such global — confirmed empirically,
// `node -e "console.log(typeof localStorage)"` prints "undefined" on this project's Node version),
// so without this stub those two functions are permanently inert and half the coverage below
// would test nothing. Real per-key persistence (a Map), not a no-op — the tests need to observe
// what got written, not just that nothing threw.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}
globalThis.localStorage = fakeLocalStorage();

const { showGalaxyToast, showObjectives, hideObjectives, renderObjectives, updateObjectives, showGameOver, buildHelpOverlay } = await import("../overlays.js");
const { galaxyToastEl, objectivesEl, gameOverEl, helpOverlayEl } = await import("../dom.js");
const { game } = await import("../session.js");

// showGameOver (below) unconditionally calls sound.playVictory()/playDefeat(), which would
// otherwise reach for `window.AudioContext` — undefined in this file's stub environment (see the
// header comment: `window` is deliberately left off). Both playVictory/playDefeat check `muted`
// before touching audio at all, so this keeps every showGameOver call in this file silent and
// AudioContext-free, the same fix test/hudSelection.test.js uses for the identical hazard.
sound.setMuted(true);

// Every showGalaxyToast call arms a REAL setTimeout (5s plain / 8s clickable, overlays.js) to
// auto-dismiss — left alone, those are live timers that would keep `node --test` from exiting
// promptly after this file's last test (the exact hazard test/boot.test.js's own header comment
// describes for overlays.js's unrelated 30s objectives timer). Clears every toast's timer and
// empties the stack, so each test starts clean and none leak a live timer past this file's last
// test. Called at the START of every test below (not only at the end) so a test that fails
// partway through can never leak stale toasts into the next one.
function resetToasts() {
  for (const c of [...galaxyToastEl.children]) clearTimeout(c._timer);
  galaxyToastEl.children.length = 0;
  galaxyToastEl.classList.add("hidden");
}

test("showGalaxyToast: a single toast is appended, unhides the stack, and is returned", () => {
  resetToasts();
  const el = showGalaxyToast("Hello", "good");
  assert.ok(el, "returns the created element");
  assert.equal(galaxyToastEl.children.length, 1);
  assert.equal(galaxyToastEl.children[0], el, "the SAME element that was returned is what's in the stack");
  assert.equal(el.textContent, "Hello");
  assert.equal(el.className, "galaxy-toast good", "no onClick -> not clickable, so no 'clickable' class");
  assert.equal(el._clickable, false);
  assert.equal(galaxyToastEl.classList.contains("hidden"), false, "showing a toast unhides the stack");
  resetToasts();
});

test("showGalaxyToast: passing an onClick makes a toast clickable — the 'clickable' class and internal flag both flip", () => {
  resetToasts();
  const el = showGalaxyToast("Click me", "warn", () => {});
  assert.equal(el._clickable, true);
  assert.equal(el.className, "galaxy-toast warn clickable");
  resetToasts();
});

test("eviction (a): at cap with a non-clickable toast present, a new toast evicts THAT oldest non-clickable one — never the oldest overall", () => {
  resetToasts();
  showGalaxyToast("A", "warn", () => {});   // clickable — the oldest toast overall; must survive
  showGalaxyToast("B", "warn");             // NOT clickable — the one that should be evicted
  showGalaxyToast("C", "warn", () => {});   // clickable
  assert.equal(galaxyToastEl.children.length, 3, "sanity: at cap");

  const d = showGalaxyToast("D", "warn");   // a 4th, plain toast arrives at cap
  assert.ok(d, "the new toast is shown — a non-clickable slot existed to evict");

  const texts = galaxyToastEl.children.map(x => x.textContent);
  assert.equal(galaxyToastEl.children.length, 3, "still capped at MAX_TOASTS");
  assert.ok(!texts.includes("B"), "the non-clickable toast (B) was evicted");
  assert.deepEqual(texts, ["A", "C", "D"],
    "A and C (both clickable) survive untouched, in their original order, with D appended — " +
    "proves the rule is specifically 'oldest NON-clickable', not 'oldest overall' (A is the " +
    "oldest overall and is clickable, so it must NOT be the one evicted)");
  resetToasts();
});

test("eviction (b): at cap with ALL THREE toasts clickable, a new NON-clickable toast is not shown at all — nothing is evicted", () => {
  resetToasts();
  showGalaxyToast("A", "warn", () => {});
  showGalaxyToast("B", "warn", () => {});
  showGalaxyToast("C", "warn", () => {});
  assert.equal(galaxyToastEl.children.length, 3, "sanity: at cap, all clickable");

  const result = showGalaxyToast("D", "warn");   // plain — no onClick
  assert.equal(result, null, "a plain toast that would have to evict a clickable one is simply never shown");

  const texts = galaxyToastEl.children.map(x => x.textContent);
  assert.equal(galaxyToastEl.children.length, 3, "still exactly 3 — no eviction happened");
  assert.deepEqual(texts, ["A", "B", "C"], "every clickable toast survives untouched, in original order");
  assert.ok(!texts.includes("D"), "the rejected plain toast never entered the stack");
  resetToasts();
});

test("eviction (c): at cap with ALL THREE toasts clickable, a new CLICKABLE toast DOES evict the oldest one", () => {
  resetToasts();
  showGalaxyToast("A", "warn", () => {});
  showGalaxyToast("B", "warn", () => {});
  showGalaxyToast("C", "warn", () => {});
  assert.equal(galaxyToastEl.children.length, 3, "sanity: at cap, all clickable");

  const d = showGalaxyToast("D", "warn", () => {});   // clickable
  assert.ok(d, "a clickable toast that has to evict another clickable one is still shown");

  const texts = galaxyToastEl.children.map(x => x.textContent);
  assert.equal(galaxyToastEl.children.length, 3, "still capped at MAX_TOASTS");
  assert.ok(!texts.includes("A"), "the OLDEST toast (A) was evicted to make room");
  assert.deepEqual(texts, ["B", "C", "D"], "B and C survive, D is appended");
  resetToasts();
});

test("eviction never triggers below the cap: three toasts with a non-clickable one among them all survive together", () => {
  // A companion sanity check for (a): confirms the eviction branch is genuinely gated on
  // `stack.children.length >= MAX_TOASTS`, not merely "a non-clickable toast exists somewhere".
  resetToasts();
  const a = showGalaxyToast("A", "warn", () => {});
  const b = showGalaxyToast("B", "warn");
  assert.equal(galaxyToastEl.children.length, 2);
  assert.deepEqual(galaxyToastEl.children.map(x => x.textContent), ["A", "B"]);
  assert.ok(a && b, "both shown — no eviction below MAX_TOASTS");
  resetToasts();
});

/* ============================================================
   Reactive opening checklist (docs/improvement-proposals.md "Reactive opening checklist
   replacing the static objectives strip"): showObjectives()/renderObjectives() used to print one
   static sentence with no memory of what the player had actually done. renderObjectives(state,
   galaxy) now walks a small per-mode predicate table (5 items for a skirmish, 4 for Odyssey — the
   proposal's own lists) and paints a live checklist; updateObjectives(game) is the per-HUD-tick
   driver (hud.js renderHUD) that keeps it reactive and retires it once every item is satisfied.

   FakeElement (above) already gives real appendChild/classList/EventTarget behavior, so no
   further test double is needed to inspect the painted rows directly via objectivesEl.children.
   ============================================================ */

function objRows() {
  const list = objectivesEl.children.find(c => c.className === "obj-list");
  return list ? list.children : [];
}
function objRowText(row) { return row.children[1].textContent; }

// resetObjectives() is called at the START of every test below (not only at the end), the same
// "a failed test can never leak state into the next one" reasoning resetToasts() documents above
// — the objectives checklist has THREE separate pieces of module/session state that would
// otherwise bleed across tests: the painted DOM (hideObjectives), the finished-before flags
// (localStorage, keyed per mode), and the live game session (game.state/game.galaxy).
function resetObjectives() {
  hideObjectives();
  localStorage.clear();
  game.state = null;
  game.galaxy = null;
}

function trainWorkersTo(state, n) {
  const have = [...state.units.values()].filter(u => u.owner === "player" && u.type === "worker").length;
  for (let i = have; i < n; i++) { const w = makeUnit("worker", "player", 10 + i, 10); state.units.set(w.id, w); }
}
function addBuilding(state, type, x = 100, y = 100) {
  const b = makeBuilding(type, "player", x, y);
  state.buildings.set(b.id, b);
  return b;
}
function fieldCombatUnits(state, n) {
  for (let i = 0; i < n; i++) { const u = makeUnit("skiff", "player", 20 + i, 20); state.units.set(u.id, u); }
}

test("renderObjectives (skirmish): a fresh opening shows live counts and nothing done yet", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 201, rng: mulberry32(201) });

  const items = renderObjectives(state, null);

  assert.equal(items.length, 5, "skirmish's checklist is the proposal's 5-item table");
  assert.deepEqual(items.map(it => it.text), [
    "Train Workers (3/8)",   // a fresh skirmish already seeds 3 workers
    "Build a Barracks",
    "Field 5 combat units",
    "Pick a doctrine at the Refinery",
    "Raise a Habitat before the supply cap",
  ]);
  assert.ok(items.every(it => it.done === false), "nothing is satisfied yet");

  assert.equal(objectivesEl.classList.contains("hidden"), false, "renderObjectives shows the strip");
  const rows = objRows();
  assert.equal(rows.length, 5, "one painted row per item");
  assert.equal(objRowText(rows[0]), "Train Workers (3/8)");
  resetObjectives();
});

test("renderObjectives (skirmish): completed items are marked done in the painted rows, unfinished ones aren't", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 205, rng: mulberry32(205) });
  trainWorkersTo(state, 8);
  addBuilding(state, "barracks");
  fieldCombatUnits(state, 5);
  // doctrine and habitat deliberately left unsatisfied

  const items = renderObjectives(state, null);

  assert.deepEqual(items.map(it => it.done), [true, true, true, false, false]);
  assert.equal(items[0].text, "Train Workers (8/8)");

  const rows = objRows();
  for (let i = 0; i < 3; i++) assert.ok(rows[i].className.includes("done"), `row ${i} should read as done`);
  for (let i = 3; i < 5; i++) assert.ok(!rows[i].className.includes("done"), `row ${i} should NOT read as done yet`);
  resetObjectives();
});

test("renderObjectives retires itself immediately — and remembers the completion — if every item is already satisfied when it mounts", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 206, rng: mulberry32(206) });
  trainWorkersTo(state, 8);
  addBuilding(state, "barracks");
  fieldCombatUnits(state, 5);
  state.players.player.upgrades.overchargedWeapons = true;   // commits the Assault doctrine
  addBuilding(state, "habitat", 200, 200);

  const items = renderObjectives(state, null);

  assert.ok(items.every(it => it.done), "sanity: every predicate really is satisfied");
  assert.equal(objectivesEl.classList.contains("hidden"), true, "an already-complete checklist is never actually shown");
  assert.equal(localStorage.getItem("sfObjectivesDone:skirmish"), "1", "the completion is remembered for next time");
  resetObjectives();
});

test("renderObjectives (odyssey): the colony-ship opening's own 4-item table, checking off as the colony develops", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 203, rng: mulberry32(203), endless: true });
  const galaxy = {};   // only truthiness matters to renderObjectives today — see its own comment

  let items = renderObjectives(state, galaxy);
  assert.equal(items.length, 4, "Odyssey's checklist is the proposal's 4-item table");
  assert.deepEqual(items.map(it => it.text),
    ["Deploy the colony ship", "Build a Market", "Reactor → Smelter", "Build a Datacenter"]);
  assert.ok(items.every(it => !it.done), "a freshly-landed colony ship hasn't done any of these yet");

  const ship = [...state.units.values()].find(u => u.type === "colonyship");
  deployColonyShip(state, ship.id);
  items = renderObjectives(state, galaxy);
  assert.equal(items[0].done, true, "deploying the ship founds the Command Center this predicate checks for");

  addBuilding(state, "market", 300, 300);
  items = renderObjectives(state, galaxy);
  assert.equal(items[1].done, true);

  addBuilding(state, "reactor", 310, 300);
  items = renderObjectives(state, galaxy);
  assert.equal(items[2].done, false, "a Reactor alone isn't the full Reactor -> Smelter chain yet");
  addBuilding(state, "smelter", 320, 300);
  items = renderObjectives(state, galaxy);
  assert.equal(items[2].done, true, "Reactor AND Smelter together satisfy the chain item");

  addBuilding(state, "datacenter", 330, 300);
  items = renderObjectives(state, galaxy);
  assert.ok(items.every(it => it.done));
  assert.equal(objectivesEl.classList.contains("hidden"), true, "completing every item retires the strip automatically");
  resetObjectives();
});

test("showObjectives: mounts the live checklist for the current session state", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 207, rng: mulberry32(207) });
  game.state = state;
  game.galaxy = null;

  showObjectives(false);

  assert.equal(objectivesEl.classList.contains("hidden"), false);
  const rows = objRows();
  assert.equal(rows.length, 5);
  assert.equal(objRowText(rows[0]), "Train Workers (3/8)");
  resetObjectives();
});

test("showObjectives: never shown for a scripted scenario — its own scenario bar already states the objective", () => {
  resetObjectives();
  game.state = { scenario: { type: "escort" } };
  game.galaxy = null;

  showObjectives(false);

  assert.equal(objectivesEl.classList.contains("hidden"), true);
  resetObjectives();
});

test("showObjectives: skipped for a returning player who already finished THIS mode's checklist once", () => {
  resetObjectives();
  localStorage.setItem("sfObjectivesDone:skirmish", "1");
  const state = createGameState({ planetId: "ferros", seed: 208, rng: mulberry32(208) });
  game.state = state;
  game.galaxy = null;

  showObjectives(false);

  assert.equal(objectivesEl.classList.contains("hidden"), true, "a finished-before flag skips showing it again");
  resetObjectives();
});

test("showObjectives: the dismiss (x) button still hides the strip, same as before", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 209, rng: mulberry32(209) });
  game.state = state;
  game.galaxy = null;
  showObjectives(false);
  assert.equal(objectivesEl.classList.contains("hidden"), false);

  const closeBtn = objectivesEl.children.find(c => c.className === "obj-close");
  assert.ok(closeBtn, "expected a dismiss button in the painted strip");
  closeBtn.click();

  assert.equal(objectivesEl.classList.contains("hidden"), true);
  resetObjectives();
});

test("updateObjectives: a no-op with nothing to update (no game, a scenario, or a strip that was never shown)", () => {
  resetObjectives();
  assert.doesNotThrow(() => updateObjectives({ state: null, galaxy: null }));
  assert.doesNotThrow(() => updateObjectives({ state: { scenario: {} }, galaxy: null }));

  const state = createGameState({ planetId: "ferros", seed: 210, rng: mulberry32(210) });
  assert.doesNotThrow(() => updateObjectives({ state, galaxy: null }));
  assert.equal(objectivesEl.classList.contains("hidden"), true, "still hidden — updateObjectives never shows a strip on its own");
  resetObjectives();
});

test("updateObjectives: the signature guard skips a repaint when nothing a player would see has changed", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 211, rng: mulberry32(211) });
  game.state = state; game.galaxy = null;
  showObjectives(false);
  const firstRows = objRows();

  updateObjectives({ state, galaxy: null });   // nothing changed since mount
  const secondRows = objRows();

  assert.equal(firstRows.length, secondRows.length);
  assert.ok(firstRows.every((r, i) => r === secondRows[i]), "identical row nodes — no rebuild happened for a no-op tick");
  resetObjectives();
});

test("updateObjectives: a real change rebuilds the strip with the updated live count, and flashes the item that just finished", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 212, rng: mulberry32(212) });
  game.state = state; game.galaxy = null;
  showObjectives(false);
  assert.equal(objRowText(objRows()[0]), "Train Workers (3/8)");

  trainWorkersTo(state, 8);
  updateObjectives({ state, galaxy: null });

  const rows = objRows();
  assert.equal(objRowText(rows[0]), "Train Workers (8/8)", "the live count actually updated");
  assert.ok(rows[0].className.includes("done"));
  assert.ok(rows[0].className.includes("flash"), "an item that just finished this tick gets flashed");
  resetObjectives();
});

test("updateObjectives: finishing every item retires the strip and remembers the completion, same as renderObjectives", () => {
  resetObjectives();
  const state = createGameState({ planetId: "ferros", seed: 213, rng: mulberry32(213) });
  game.state = state; game.galaxy = null;
  showObjectives(false);

  trainWorkersTo(state, 8);
  addBuilding(state, "barracks");
  fieldCombatUnits(state, 5);
  state.players.player.upgrades.overchargedWeapons = true;
  addBuilding(state, "habitat", 200, 200);
  updateObjectives({ state, galaxy: null });

  assert.equal(objectivesEl.classList.contains("hidden"), true);
  assert.equal(localStorage.getItem("sfObjectivesDone:skirmish"), "1");
  resetObjectives();
});

/* ============================================================
   showGameOver honesty (docs/improvement-proposals.md "Make the clock endgame visible, honest,
   and configurable"): the screen used to always claim "the enemy's last Command Center is
   destroyed", even when a score decision (mutual-wipe-score / timeout-score) ended the match —
   false in that case. It now branches on opts.winReason, and a score decision gets a small
   breakdown (bank/army/structures + both sides' final score) reusing showScenarioEnd's own
   "gameover-seed" div idiom just below.
   ============================================================ */

function gameOverBreakdownEl() {
  return gameOverEl.children.find(c => c.className === "gameover-seed" && c.innerHTML.includes("Bank"));
}

test("showGameOver (elimination): keeps the classic conquest copy, and shows no score breakdown", () => {
  const state = createGameState({ planetId: "ferros", seed: 301, rng: mulberry32(301) });

  showGameOver("player", 301, () => {}, { winReason: "elimination", state });
  assert.equal(gameOverEl.children[0].textContent, "Victory — the enemy's last Command Center is destroyed.");
  assert.equal(gameOverBreakdownEl(), undefined, "a conquest win shows no score breakdown — score had nothing to do with it");

  showGameOver("ai", 301, () => {}, { winReason: "elimination", state });
  assert.equal(gameOverEl.children[0].textContent, "Defeat — your last Command Center was destroyed.");
  assert.equal(gameOverBreakdownEl(), undefined);
});

test("showGameOver (mutual-wipe-score / timeout-score): honest score-decision copy instead of a false conquest claim, plus a real breakdown", () => {
  const state = createGameState({ planetId: "ferros", seed: 302, rng: mulberry32(302) });

  showGameOver("player", 302, () => {}, { winReason: "timeout-score", state });
  const msg = gameOverEl.children[0].textContent;
  assert.match(msg, /score/i, "the score decision is named in the copy");
  assert.doesNotMatch(msg, /Command Center is destroyed/, "must not claim a conquest that didn't happen");

  const bd = scoreBreakdown(state, "player");
  const enemyScore = playerScore(state, "ai");
  const breakdown = gameOverBreakdownEl();
  assert.ok(breakdown, "expected a score breakdown line for a score-decided match");
  for (const n of [bd.bank, bd.army, bd.structures, bd.total, enemyScore]) {
    assert.ok(breakdown.innerHTML.includes(String(Math.round(n))), `breakdown should include ${Math.round(n)}`);
  }

  showGameOver("ai", 302, () => {}, { winReason: "mutual-wipe-score", state });
  assert.match(gameOverEl.children[0].textContent, /score/i);
  assert.ok(gameOverBreakdownEl(), "a mutual wipe is also a score decision, so it gets the breakdown too");
});

test("showGameOver: a missing winReason falls back to the classic conquest copy, backward-compatibly", () => {
  showGameOver("player", 303, () => {});   // no opts at all — the pre-existing call shape
  assert.equal(gameOverEl.children[0].textContent, "Victory — the enemy's last Command Center is destroyed.");
  assert.equal(gameOverBreakdownEl(), undefined, "no state was even passed — nothing to build a breakdown from");
});

test("showGameOver: the Odyssey branch ignores winReason entirely — its own surrendered/ended copy is unchanged", () => {
  showGameOver("ai", null, () => {}, { odyssey: true, winReason: "timeout-score" });
  assert.equal(gameOverEl.children[0].textContent, "The Odyssey has ended.");
  assert.equal(gameOverBreakdownEl(), undefined, "the Odyssey sandbox has no score tiebreak to explain");

  showGameOver("ai", null, () => {}, { odyssey: true, surrendered: true, winReason: "elimination" });
  assert.equal(gameOverEl.children[0].textContent, "Surrendered — you lay down your flag. The frontier falls quiet.");
});

test("showGameOver: 'Choose another battlefield' still invokes onRestart, same as before", () => {
  let restarted = false;
  showGameOver("player", 304, () => { restarted = true; }, { winReason: "elimination" });
  const again = gameOverEl.children.find(c => c.textContent === "Choose another battlefield");
  assert.ok(again, "expected the restart button");
  again.click();
  assert.equal(restarted, true);
  assert.equal(gameOverEl.classList.contains("hidden"), true);
});

/* ============================================================
   HELP_ROWS coverage for this batch's UX/input proposals (docs/improvement-proposals.md "Attack
   pings on the minimap plus a jump-to-last-alert key" and "Selection subtraction and map-wide
   select-all-of-type"): buildHelpOverlay() renders HELP_ROWS straight into helpOverlayEl's
   innerHTML, so a plain string-content check is enough to prove each new hotkey/gesture is
   actually documented, without needing HELP_ROWS itself exported.
   ============================================================ */

test("buildHelpOverlay documents Backspace (jump to last alert), Alt+drag (subtract), and Ctrl+double-click (map-wide select)", () => {
  buildHelpOverlay();
  const html = helpOverlayEl.innerHTML;

  assert.match(html, /Backspace/, "the jump-to-last-alert key should appear in the help reference");
  assert.match(html, /Alt\+drag/, "the selection-subtraction gesture should appear in the help reference");
  assert.match(html, /Ctrl\+double-click/, "the map-wide select-all-of-type gesture should appear in the help reference");
});

// docs/improvement-proposals.md "Tech & Industry Chart overlay": docs/player-handbook.html — the
// one place the full unlock ladder is drawn — used to be linked from nowhere in the app. It's now
// linked from techChart.js's own overlay AND from here, the persistent help reference.
test("buildHelpOverlay links to the full field manual, opening in a new tab", () => {
  buildHelpOverlay();
  const html = helpOverlayEl.innerHTML;

  assert.match(html, /href="docs\/player-handbook\.html"/, "expected a link to the field manual");
  assert.match(html, /target="_blank"/, "expected it to open in a new tab, not navigate away from the running match");
  assert.match(html, /Full field manual/i);
});
