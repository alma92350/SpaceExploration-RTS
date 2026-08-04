import { test } from "node:test";
import assert from "node:assert/strict";
import * as sound from "../sound.js";
// Pure engine modules — no DOM/window reference anywhere in their own import graph (see
// test/boot.test.js's identical reasoning for engine/state.js) — safe to import statically here,
// before the document/window stubs below even exist.
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { installFakeDom, fakeCtx } from "./_dom.js";

/* ============================================================
   techChart.js has no natural test-file home (it's a new leaf UI module, like starmap.js), so this
   uses the shared DOM harness in test/_dom.js — the established idiom for a toggleable full-screen
   overlay module in this codebase — installed with `context: fakeCtx`, needed here because, unlike
   starmap.js, techChart.js DOES call render.js's spriteIcon for its building/unit node icons and
   that path needs a live 2D context and a toDataURL to come back.

   --- import order --------------------------------------------------------------------------
   techChart.js imports boot.js (for pauseLoop/resumeLoop, the same way starmap.js does — "no
   boot.js import cycle; pause/resume passed or imported like starmap does" per the proposal) and
   overlays.js (for flashHint) — the same large transitive graph test/starmap.test.js's own header
   comment traces in full (setup.js, saveload.js, hud.js, hudSelection.js, input.js, engine/*, …),
   with the same unguarded module-scope DOM/window calls. That comment's own fix applies verbatim:
   import boot.js's whole graph FIRST, while `window` is still undefined (so saveload.js's guarded
   autosave `setInterval` never gets scheduled — a live timer would otherwise keep `node --test`
   from exiting), THEN install `window`, THEN import techChart.js itself.

   Unlike starmap.test.js, this file DOES need `window` to be a real, dispatch-capable EventTarget
   (not a no-op stub): techChart.js wires its Esc/T hotkey with a plain, unconditional
   `window.addEventListener("keydown", …)` at module scope (mirroring starmap.js's own M-key
   wiring), and several tests below need to actually dispatch a keydown and observe the effect.
   test/input.test.js already proves Node's own EventTarget/Event are WHATWG-compliant enough to
   stand in for the browser objects here (real addEventListener/dispatchEvent, real `event.target`
   set to the dispatching object) — same FakeWindow shape, and the same `window.closest = () =>
   true` trick that file's own "reserved for a focused control" test uses to simulate "e.target is
   inside a focused button/input/etc." without needing a whole fake focused element.
   ============================================================ */

// Ditto for `window` — a real EventTarget so techChart.js's own module-scope
// `window.addEventListener("keydown", …)` really registers and really fires (see the header
// comment). Installed only AFTER the boot.js pre-warm below, same as starmap.test.js's stub.
class FakeWindow extends EventTarget {}

function ev(type, props = {}) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, props);
  return e;
}

installFakeDom({ context: fakeCtx });

sound.setMuted(true);

// Pre-warm techChart.js's boot.js graph while `window` is still undefined — see the header
// comment. The result is unused; only the caching side effect matters.
await import("../boot.js");

globalThis.window = new FakeWindow();

const { game } = await import("../session.js");
const { openTechChart, closeTechChart, renderTechChart } = await import("../techChart.js");
const { techChartEl, techChartBtn } = await import("../dom.js");

// One node card's element, found by the `data-node-id`/`data-kind` techChart.js stamps on every
// card it builds — a depth-first walk since node cards nest inside per-tier columns inside the
// body, and the shared FakeElement (test/_dom.js) only implements class-selector querying, not
// attribute selectors.
function findNode(id) {
  function walk(el) {
    if (el.dataset && el.dataset.nodeId === id) return el;
    for (const c of el.children || []) { const found = walk(c); if (found) return found; }
    return null;
  }
  return walk(techChartEl);
}

// A node card's name/cost/recipe/detail spans live inside its own .techchart-node-body wrapper
// (icon-beside-text layout), not as direct children of the card — a depth-first search by class,
// same reasoning as findNode above.
function findByClass(root, cls) {
  for (const c of root.children || []) {
    if (c.className === cls) return c;
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

function freshSkirmish(seed) {
  return createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

function resetChart() {
  game.state = null;
  game.galaxy = null;
  game.input = null;
  techChartEl.innerHTML = "";
  techChartEl.classList.add("hidden");
  delete globalThis.window.closest;
}

/* ---------- rendering: no game, and the skirmish/Odyssey mode split ---------- */

test("renderTechChart is a no-op with no active game state — never throws, builds nothing", () => {
  resetChart();
  assert.doesNotThrow(() => renderTechChart());
  assert.equal(techChartEl.children.length, 0);
});

test("openTechChart does nothing with no active game state — the overlay stays hidden", () => {
  resetChart();
  openTechChart();
  assert.equal(techChartEl.classList.contains("hidden"), true);
});

test("skirmish (no galaxy): shows the small ladder — Foundry/Arsenal are present, an Odyssey-only building and every tech node are not", () => {
  resetChart();
  game.state = freshSkirmish(1);
  game.galaxy = null;

  renderTechChart();

  assert.ok(findNode("foundry"), "Foundry (skirmish's Tier-2 gate) is on the skirmish ladder");
  assert.ok(findNode("arsenal"), "Arsenal (skirmish's Tier-3 gate) is on the skirmish ladder");
  assert.equal(findNode("datacenter"), null, "an odysseyOnly building must not appear in the skirmish ladder");
  assert.equal(findNode("antimatter_gate"), null, "the Strategic-tier capstone must not appear in the skirmish ladder");
  assert.equal(findNode("metallurgy"), null, "no TECHS node appears outside Odyssey — the Datacenter that hosts them is itself odysseyOnly");
});

test("Odyssey (a galaxy is active): shows the full chart — the Strategic tier and tech nodes are present", () => {
  resetChart();
  game.state = freshSkirmish(2);
  game.galaxy = {};   // only truthiness matters to techChart.js, same convention starmap.js/overlays.js use

  renderTechChart();

  assert.ok(findNode("datacenter"), "the Datacenter is shown in the full Odyssey chart");
  assert.ok(findNode("antimatter_gate"), "the Antimatter Gate (the capstone) is shown");
  assert.ok(findNode("metallurgy"), "TECHS nodes are shown in Odyssey");
});

/* ---------- live-state colouring ---------- */

test("a completed building is 'built'; an unresearched-but-affordable building is 'buildable now'", () => {
  resetChart();
  const state = freshSkirmish(3);
  const cc = [...state.buildings.values()].find(b => b.type === "command");
  const barracks = makeBuilding("barracks", "player", cc.x + 100, cc.y);
  state.buildings.set(barracks.id, barracks);
  game.state = state; game.galaxy = null;

  renderTechChart();

  const barracksNode = findNode("barracks");
  assert.ok(barracksNode.className.includes("built"), "the completed Barracks reads as built");
  assert.equal(barracksNode.tagName, "div", "a built building isn't a clickable button — there's nothing left to arm");

  // Refinery: no requires, costs 200 ore, and the fresh state starts with 300 — affordable now.
  const refineryNode = findNode("refinery");
  assert.ok(refineryNode.className.includes("afford"), "an unbuilt, unlocked, affordable building reads as buildable now");
  assert.equal(refineryNode.tagName, "button", "a buildable-now building is a real clickable button");
});

test("a locked building spells out its FULL multi-level chain, not just its immediate prereq", () => {
  resetChart();
  game.state = freshSkirmish(4);   // fresh state: no Barracks, no Foundry built yet
  game.galaxy = null;

  renderTechChart();

  const arsenal = findNode("arsenal");
  assert.ok(arsenal.className.includes("locked"), "Arsenal is locked with neither Barracks nor Foundry built");
  const detail = findByClass(arsenal, "techchart-detail");
  assert.ok(detail, "expected a detail line explaining the locked state");
  // Arsenal requires Foundry, which itself requires Barracks — the FULL lineage, not just
  // "Requires Foundry" (the one-level lockTipFor style the Datacenter panel already had).
  assert.equal(detail.textContent, "Requires: Barracks → Foundry → Arsenal");
  assert.equal(arsenal.title, detail.textContent, "the same full chain is also the hover tooltip");
});

test("a building whose prereqs ARE met but is short on resources reads locked with a cost message, not a chain", () => {
  resetChart();
  game.state = freshSkirmish(5);   // 300 ore, 0 crystals — Turret needs 150 ore + 100 crystals
  game.galaxy = null;

  renderTechChart();

  const turret = findNode("turret");
  assert.ok(turret.className.includes("locked"), "unaffordable (even though unlocked) still reads as locked");
  const detail = findByClass(turret, "techchart-detail");
  assert.equal(detail.textContent, "Needs 150 ore, 100 crystals");
});

test("a factory building's node shows its recipe line (BUILDINGS[].recipe, via data.js RECIPES)", () => {
  resetChart();
  game.state = freshSkirmish(6);
  game.galaxy = {};   // Smelter is odysseyOnly

  renderTechChart();

  const smelter = findNode("smelter");
  assert.ok(smelter, "expected the Smelter in the Odyssey chart");
  const recipe = findByClass(smelter, "techchart-recipe");
  assert.ok(recipe, "expected a recipe line on a recipe-bearing building");
  assert.equal(recipe.textContent, "2 Ore + 2 Energy Cells → 2 Metals");
});

test("doctrine (UPGRADES) nodes show in both skirmish and Odyssey; the AI-only Hard Edge upgrade never shows", () => {
  resetChart();
  game.state = freshSkirmish(7);
  game.galaxy = null;
  renderTechChart();
  assert.ok(findNode("overchargedWeapons"), "a doctrine node shows in skirmish — doctrine research runs in both modes");
  assert.equal(findNode("hardEdge"), null, "hardEdge is aiOnly — never a player-facing node");

  game.galaxy = {};
  renderTechChart();
  assert.ok(findNode("overchargedWeapons"), "…and in Odyssey too");
  assert.equal(findNode("hardEdge"), null);
});

/* ---------- clicking a building node ---------- */

test("clicking a buildable-now building with a Worker selected arms input.startBuild and closes the overlay", () => {
  resetChart();
  const state = freshSkirmish(8);
  const worker = [...state.units.values()].find(u => u.type === "worker");
  state.selection = [worker.id];
  game.state = state; game.galaxy = null;
  const started = [];
  game.input = { startBuild: t => started.push(t), cancelGesture() {} };

  openTechChart();
  assert.equal(techChartEl.classList.contains("hidden"), false, "sanity: the overlay is open");

  findNode("barracks").click();   // Barracks: no requires, 150 ore <= the fresh 300 -> buildable now

  assert.deepEqual(started, ["barracks"], "startBuild was armed with the clicked building's type");
  assert.equal(techChartEl.classList.contains("hidden"), true, "the overlay closes on a successful arm");
});

test("clicking a buildable-now building with NO builder selected does not arm startBuild, and the overlay stays open", () => {
  resetChart();
  const state = freshSkirmish(9);
  state.selection = [];   // nothing selected
  game.state = state; game.galaxy = null;
  const started = [];
  game.input = { startBuild: t => started.push(t), cancelGesture() {} };

  openTechChart();
  findNode("barracks").click();

  assert.deepEqual(started, [], "no eligible builder is selected, so nothing was armed");
  assert.equal(techChartEl.classList.contains("hidden"), false, "the overlay stays open");
});

test("clicking a locked building does not arm startBuild", () => {
  resetChart();
  const state = freshSkirmish(10);
  const worker = [...state.units.values()].find(u => u.type === "worker");
  state.selection = [worker.id];
  game.state = state; game.galaxy = null;
  const started = [];
  game.input = { startBuild: t => started.push(t), cancelGesture() {} };

  openTechChart();
  findNode("arsenal").click();   // locked: neither Barracks nor Foundry is built

  assert.deepEqual(started, []);
  assert.equal(techChartEl.classList.contains("hidden"), false, "a denied click never closes the overlay");
});

/* ---------- open / close: Esc, backdrop, topbar button, hotkey ---------- */

test("Esc closes the open overlay", () => {
  resetChart();
  game.state = freshSkirmish(11);
  openTechChart();
  assert.equal(techChartEl.classList.contains("hidden"), false);

  window.dispatchEvent(ev("keydown", { key: "Escape" }));

  assert.equal(techChartEl.classList.contains("hidden"), true);
});

test("clicking the backdrop (the overlay element itself, not a node) closes it", () => {
  resetChart();
  game.state = freshSkirmish(12);
  openTechChart();

  techChartEl.dispatchEvent(new Event("click"));   // dispatched ON techChartEl -> event.target === techChartEl

  assert.equal(techChartEl.classList.contains("hidden"), true);
});

test("the topbar button toggles the overlay open and closed", () => {
  resetChart();
  game.state = freshSkirmish(13);
  assert.equal(techChartEl.classList.contains("hidden"), true, "sanity: starts closed");

  techChartBtn.click();
  assert.equal(techChartEl.classList.contains("hidden"), false);

  techChartBtn.click();
  assert.equal(techChartEl.classList.contains("hidden"), true);
});

test("the T hotkey opens the overlay when a game is active", () => {
  resetChart();
  game.state = freshSkirmish(14);

  window.dispatchEvent(ev("keydown", { key: "t" }));

  assert.equal(techChartEl.classList.contains("hidden"), false);
});

test("the T hotkey does nothing when no game is active", () => {
  resetChart();
  game.state = null;

  assert.doesNotThrow(() => window.dispatchEvent(ev("keydown", { key: "t" })));

  assert.equal(techChartEl.classList.contains("hidden"), true);
});

test("the T hotkey does not fire while a text-like control is focused", () => {
  resetChart();
  game.state = freshSkirmish(15);
  // Stands in for "event.target is inside a focused button/input/etc." — dispatchEvent always sets
  // event.target to the object dispatchEvent was called on (window, here), and the guard probes
  // exactly one method on it, `.closest(...)` — see test/input.test.js's identical trick for its
  // own "reserved for a focused control" case.
  window.closest = () => true;

  window.dispatchEvent(ev("keydown", { key: "t" }));

  assert.equal(techChartEl.classList.contains("hidden"), true, "the hotkey must not fire while a text control is focused");
  delete window.closest;
});

/* ---------- the field-manual link ---------- */

test("the overlay's footer links to the field manual, opening in a new tab", () => {
  resetChart();
  game.state = freshSkirmish(16);
  renderTechChart();

  const link = techChartEl.children.find(c => c.tagName === "a");
  assert.ok(link, "expected an <a> link in the overlay");
  assert.equal(link.href, "docs/player-handbook.html");
  assert.equal(link.target, "_blank");
  assert.match(link.textContent, /field manual/i);
});
