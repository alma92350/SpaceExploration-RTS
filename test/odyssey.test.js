import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { checkEndlessLoss } from "../engine/victory.js";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";

const commandCenters = (state, owner) =>
  [...state.buildings.values()].filter(b => b.owner === owner && b.type === "command");

test("createGalaxy settles the player on one world with a single command center", () => {
  const g = createGalaxy({ seed: 7, difficulty: "medium" });
  assert.ok(ODYSSEY_WORLDS.includes(g.activeId), "the start world is one of the roster");
  assert.equal(g.planets.size, 1, "Phase 1: exactly one planet");
  assert.equal(g.credits, 0, "credits start empty");
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
