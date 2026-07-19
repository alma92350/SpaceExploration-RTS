import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, jumpCapital, galaxyStatus, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { checkEndlessLoss } from "../engine/victory.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";

const commandCenters = (state, owner) =>
  [...state.buildings.values()].filter(b => b.owner === owner && b.type === "command");
const playerBuildings = (state, type) =>
  [...state.buildings.values()].filter(b => b.owner === "player" && (!type || b.type === type));

// Stand a finished Spaceport beside the capital so a jump can launch, and return it.
function addSpaceport(state) {
  const cc = commandCenters(state, "player")[0];
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);   // no { constructing } ⇒ finished
  state.buildings.set(sp.id, sp);
  return sp;
}

test("createGalaxy settles the player on one world with a single command center", () => {
  const g = createGalaxy({ seed: 7, difficulty: "medium" });
  assert.ok(ODYSSEY_WORLDS.includes(g.activeId), "the start world is one of the roster");
  assert.equal(g.planets.size, 1, "Phase 1: exactly one planet");
  assert.ok(g.credits > 0, "you start with a credit stipend to fund the first jump");
  const s = activeState(g);
  assert.equal(s.endless, true, "the active planet is an endless (Odyssey) state");
  assert.equal(commandCenters(s, "player").length, 1, "the player has exactly one Command Center");
  assert.ok(commandCenters(s, "ai").length >= 1, "a neighbour is present to coexist / clash with");
});

test("endless mode never ends by conquest — razing the enemy CC does not win", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  for (const b of commandCenters(s, "ai")) s.buildings.delete(b.id);   // wipe the neighbour's CC
  checkEndlessLoss(s);
  assert.equal(s.over, false, "losing the enemy CC is not a victory in the open world");
});

test("endless mode ends in defeat only when the player's Command Center is lost", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  assert.equal(s.over, false);
  for (const b of commandCenters(s, "player")) s.buildings.delete(b.id);   // the capital falls
  checkEndlessLoss(s);
  assert.equal(s.over, true, "with no capital, the Odyssey is over");
  assert.equal(s.winner, "ai");
});

test("an endless state has no time-limit resolution", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.time = 100000;   // far beyond any skirmish clock
  checkEndlessLoss(s);
  assert.equal(s.over, false, "the sandbox does not resolve on a clock while the capital stands");
});

test("an Odyssey galaxy runs without ending while both capitals stand, and is deterministic", () => {
  const fingerprint = () => {
    const g = createGalaxy({ seed: 4242, difficulty: "medium" });
    const s = activeState(g);
    for (let i = 0; i < 200; i++) tick(s, 0.1);
    return `${g.activeId}|${s.over}|${s.tick}|${s.units.size}|${Math.round(s.players.player.resources.ore || 0)}`;
  };
  const a = fingerprint();
  assert.match(a, /\|false\|/, "the sandbox is still running after 20s (no premature end)");
  assert.equal(a, fingerprint(), "same galaxy seed replays identically");
});

test("addPlanet builds a distinct, deterministic world into the galaxy", () => {
  const g = createGalaxy({ seed: 11 });
  const other = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s1 = addPlanet(g, other);
  assert.equal(s1.endless, true);
  assert.equal(s1.planetId, other);
  // Rebuilding the same world from the same galaxy seed is identical (per-planet seed).
  const g2 = createGalaxy({ seed: 11 });
  const s2 = addPlanet(g2, other);
  assert.equal(s1.seed, s2.seed, "per-planet seed is stable across galaxies of the same seed");
});

test("an unsettled destination has only its neighbour — no auto-seeded player base", () => {
  const g = createGalaxy({ seed: 12 });
  const other = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s = addPlanet(g, other, { unsettled: true });
  assert.equal(playerBuildings(s).length, 0, "no player buildings until you land");
  assert.equal([...s.units.values()].filter(u => u.owner === "player").length, 0, "no player units either");
  assert.ok([...s.buildings.values()].some(b => b.owner === "ai"), "the neighbour is intact");
  assert.equal(s.background, true, "an unvisited world is a background world");
});

/* ---------- the interplanetary jump ---------- */

test("a jump relocates the capital + staged units and leaves a colony behind", () => {
  const g = createGalaxy({ seed: 5, difficulty: "easy" });
  const from = activeState(g);
  const sp = addSpaceport(from);
  const rider = makeUnit("skiff", "player", sp.x + 20, sp.y);       from.units.set(rider.id, rider);
  const stayer = makeUnit("worker", "player", sp.x + 900, sp.y);    from.units.set(stayer.id, stayer);

  const destId = g.worlds.find(w => w !== g.activeId);
  const res = jumpCapital(g, destId);
  assert.ok(res, "the jump ran");
  assert.equal(g.activeId, destId, "the destination is now active");

  const dest = activeState(g);
  assert.equal(commandCenters(dest, "player").length, 1, "the capital arrived at the destination");
  assert.ok([...dest.units.values()].some(u => u.owner === "player" && u.type === "skiff"), "the staged unit rode along");

  assert.equal(from.background, true, "the origin is now a background colony");
  assert.equal(dest.background, false, "the destination is the active seat");
  assert.equal(commandCenters(from, "player").length, 0, "the origin's capital left");
  assert.ok(playerBuildings(from, "spaceport").length === 1, "the Spaceport stays with the colony");
  assert.ok([...from.units.values()].some(u => u.owner === "player" && u.type === "worker"), "far units stay with the colony");
});

test("a jump destination keeps only the arriving capital as the player's presence", () => {
  const g = createGalaxy({ seed: 6 });
  addSpaceport(activeState(g));
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  const dest = g.planets.get(destId);
  const pb = playerBuildings(dest);
  assert.equal(pb.length, 1, "exactly one player building on arrival");
  assert.equal(pb[0].type, "command", "and it's the relocated capital");
  assert.ok([...dest.buildings.values()].some(b => b.owner === "ai"), "the destination's neighbour is intact");
});

test("after a jump the abandoned colony keeps evolving and never ends the game", () => {
  const g = createGalaxy({ seed: 7 });
  addSpaceport(activeState(g));
  const from = activeState(g);
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  for (let i = 0; i < 100; i++) for (const s of g.planets.values()) tick(s, 0.1);
  assert.equal(from.over, false, "a colony with no capital is not 'over'");
  assert.equal(activeState(g).over, false, "the active seat with its capital keeps running");
});

test("galaxyStatus reports one seat and the rest unexplored, then a colony after a jump", () => {
  const g = createGalaxy({ seed: 21 });
  let st = galaxyStatus(g);
  assert.equal(st.total, ODYSSEY_WORLDS.length);
  assert.equal(st.visited, 1);
  assert.equal(st.worlds.filter(w => w.status === "seat").length, 1, "exactly one active seat");
  assert.equal(st.worlds.filter(w => w.status === "unexplored").length, ODYSSEY_WORLDS.length - 1, "everything else unexplored");
  assert.equal(st.worlds.find(w => w.status === "seat").id, g.activeId);

  addSpaceport(activeState(g));
  g.credits = 1000;
  const dest = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, dest);
  st = galaxyStatus(g);
  assert.equal(st.visited, 2);
  assert.equal(st.worlds.find(w => w.id === dest).status, "seat", "the destination is the new seat");
  assert.ok(st.worlds.some(w => w.status === "colony"), "the world left behind is a colony");
});

test("the galaxy jump is deterministic", () => {
  const run = () => {
    const g = createGalaxy({ seed: 88, difficulty: "medium" });
    addSpaceport(activeState(g));
    const destId = g.worlds.find(w => w !== g.activeId);
    jumpCapital(g, destId);
    const dest = activeState(g), from = g.planets.get([...g.planets.keys()].find(k => k !== g.activeId));
    return `${g.activeId}|${dest.units.size}|${dest.buildings.size}|${from.units.size}|${from.buildings.size}`;
  };
  assert.equal(run(), run(), "same seed + same jump replays identically");
});
