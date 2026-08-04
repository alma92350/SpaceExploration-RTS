import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./_dom.js";

/* ============================================================
   Same shared-DOM-harness (test/_dom.js) setup as test/starmap.test.js — see that file's header
   comment for why the stub must exist before ANY import and why the import order below
   (boot.js first, while `window` is still undefined, THEN window, THEN the module under
   test) matters. observer.js sits in the same import graph (boot.js and starmap.js both
   pull it in now), so it needs the exact same treatment.
   ============================================================ */

installFakeDom();
await import("../boot.js");
globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { game } = await import("../session.js");
const { createGalaxy } = await import("../engine/galaxy.js");
const { makeBuilding, makeUnit } = await import("../engine/state.js");
const {
  observedState, enterObserverMode, exitObserverMode, toggleObserverMode,
  spectateWorld, cycleObserverBase, findBases, observerStats,
} = await import("../observer.js");

function resetGame() {
  game.galaxy = null;
  game.state = null;
  game.input = null;
  game.observerMode = false;
  game.spectateId = null;
  game.observerCamera = null;
}

/* ---------- observedState / enter / exit / toggle ---------- */

test("observedState() returns game.state while observerMode is off", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  assert.equal(observedState(), game.state);
  resetGame();
});

test("enterObserverMode is a no-op without a galaxy — no crash, mode stays off", () => {
  resetGame();
  enterObserverMode();
  assert.equal(game.observerMode, false);
  resetGame();
});

test("enterObserverMode spectates the real active world by default, with its own camera", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  assert.equal(game.observerMode, true);
  assert.equal(game.spectateId, g.activeId);
  assert.ok(game.observerCamera, "an observer camera was created");
  assert.equal(observedState(), g.planets.get(g.activeId));
  resetGame();
});

test("exitObserverMode clears mode, spectateId, and the observer camera", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  exitObserverMode();
  assert.equal(game.observerMode, false);
  assert.equal(game.spectateId, null);
  assert.equal(game.observerCamera, null);
  assert.equal(observedState(), game.state, "falls back to the real state once observing stops");
  resetGame();
});

test("toggleObserverMode flips both directions and is a no-op without a galaxy", () => {
  resetGame();
  toggleObserverMode();
  assert.equal(game.observerMode, false, "no galaxy — still off");

  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  toggleObserverMode();
  assert.equal(game.observerMode, true);
  toggleObserverMode();
  assert.equal(game.observerMode, false);
  resetGame();
});

/* ---------- spectateWorld ---------- */

test("spectateWorld is a no-op when not currently observing", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  const other = g.worlds.find(id => id !== g.activeId);
  spectateWorld(other);
  assert.equal(game.spectateId, null, "still off, so the click had no effect");
  resetGame();
});

test("spectateWorld jumps the VIEW to another world for free — no activeId change", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  const other = g.worlds.find(id => id !== g.activeId);

  spectateWorld(other);

  assert.equal(game.spectateId, other, "now spectating the neighbour");
  assert.equal(observedState(), g.planets.get(other));
  assert.equal(g.activeId, g.planets.get(g.activeId).planetId, "the REAL active world never moved");
  assert.notEqual(g.activeId, other, "sanity: we really did spectate a different world than the real seat");
  resetGame();
});

test("spectateWorld ignores an id the galaxy doesn't actually have", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  const before = game.spectateId;

  spectateWorld("not-a-real-world");

  assert.equal(game.spectateId, before, "unrecognised id left the spectated world unchanged");
  resetGame();
});

/* ---------- findBases / cycleObserverBase ---------- */

test("findBases finds a completed Command Center regardless of owner, and skips one still under construction", () => {
  const state = { units: new Map(), buildings: new Map(), map: { width: 4000, height: 4000, bases: {} } };
  const playerCC = makeBuilding("command", "player", 500, 500);
  const aiCC = makeBuilding("command", "ai", 1500, 1500);
  const risingCC = makeBuilding("command", "ai", 2500, 2500);
  risingCC.constructing = true;
  for (const b of [playerCC, aiCC, risingCC]) state.buildings.set(b.id, b);

  const bases = findBases(state);

  assert.equal(bases.length, 2, "both completed CCs, any owner — not the one still going up");
  assert.ok(bases.some(b => b.owner === "player"));
  assert.ok(bases.some(b => b.owner === "ai"), "an AI base is a legitimate cycle stop, not just the player's own");
});

test("cycleObserverBase advances through every base on repeated calls, any owner", () => {
  resetGame();
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  game.state = g.planets.get(g.activeId);
  enterObserverMode();
  const other = g.worlds.find(id => id !== g.activeId);
  const state = g.planets.get(other);
  state.buildings.clear();
  const a = makeBuilding("command", "ai", 400, 400);
  const b = makeBuilding("command", "player", 1200, 1200);
  state.buildings.set(a.id, a);
  state.buildings.set(b.id, b);
  spectateWorld(other);   // already parks the camera on base 0 as part of just arriving

  // Mirrors input.js's own centerOnBase: lastObsBaseAt resets to -Infinity on arrival, so the
  // FIRST Space press reads as a fresh (non-cycling) press and re-confirms base 0 — only a
  // SECOND, quick press actually advances to the next base. Both calls land well inside the
  // double-press window (real elapsed time between two synchronous calls is microseconds).
  cycleObserverBase();
  const firstStop = { x: game.observerCamera.x, y: game.observerCamera.y };
  cycleObserverBase();
  const secondStop = { x: game.observerCamera.x, y: game.observerCamera.y };

  assert.notDeepEqual(secondStop, firstStop, "a second Space press advances to the OTHER base");
  assert.equal(findBases(state).length, 2, "sanity: exactly the two bases this test set up");
  // A third press wraps back around — clampCamera may have nudged either stop off the base's
  // raw x/y (a small test map, real behaviour, not a bug), so round-tripping through the SAME
  // two-base cycle is what actually proves both bases got a turn, not just "it moved once".
  cycleObserverBase();
  const thirdStop = { x: game.observerCamera.x, y: game.observerCamera.y };
  assert.deepEqual(thirdStop, firstStop, "a third press wraps back to the first base");
  resetGame();
});

/* ---------- observerStats ---------- */

test("observerStats tallies units/buildings by owner and type, and surfaces archetype/stance/economy", () => {
  const state = {
    planetId: "ferros",
    units: new Map(), buildings: new Map(),
    diplomacy: { stance: -0.6, pacified: false },
    players: { ai: { resources: { ore: 42.7 } }, player: { upgrades: {} } },
  };
  const skiff1 = makeUnit("skiff", "ai", 0, 0);
  const skiff2 = makeUnit("skiff", "ai", 10, 10);
  const worker = makeUnit("worker", "player", 5, 5);
  for (const u of [skiff1, skiff2, worker]) state.units.set(u.id, u);
  const cc = makeBuilding("command", "ai", 0, 0);
  state.buildings.set(cc.id, cc);

  const s = observerStats(state);

  assert.equal(s.planetId, "ferros");
  assert.equal(typeof s.archetypeName, "string");
  assert.ok(s.archetypeName.length > 0, "ferros' archetype has a real name");
  assert.equal(s.stanceLabel, "Hostile");   // stance -0.6 <= -0.5, per engine/diplomacy.js stanceLabel
  assert.ok(s.hostility > 0, "a hostile stance reads as nonzero hostility");
  assert.deepEqual(s.units.ai, { skiff: 2 });
  assert.deepEqual(s.units.player, { worker: 1 });
  assert.deepEqual(s.buildings.ai, { command: 1 });
  assert.equal(s.resources.ore, 42.7);
});

test("observerStats reads null stance/hostility for a state with no diplomacy object", () => {
  const state = {
    planetId: "ferros", units: new Map(), buildings: new Map(),
    players: { ai: { resources: {} } },
  };
  const s = observerStats(state);
  assert.equal(s.stance, null);
  assert.equal(s.stanceLabel, null);
  assert.equal(s.hostility, null);
});
