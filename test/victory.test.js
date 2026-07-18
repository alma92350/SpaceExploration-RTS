import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { checkWinCondition } from "../engine/victory.js";

function commandCenterOf(state, owner) {
  return [...state.buildings.values()].find(b => b.owner === owner && b.type === "command");
}

test("the game is not over while both sides still hold a Command Center", () => {
  const state = createGameState({ planetId: "ferros" });
  checkWinCondition(state);
  assert.equal(state.over, false);
});

test("losing your Command Center hands the win to the other side", () => {
  const state = createGameState({ planetId: "ferros" });
  state.buildings.delete(commandCenterOf(state, "player").id);

  checkWinCondition(state);

  assert.equal(state.over, true);
  assert.equal(state.winner, "ai");
});

test("losing one of two Command Centers doesn't end the game — losing both does", () => {
  const state = createGameState({ planetId: "ferros" });
  const seeded = commandCenterOf(state, "player");
  const expansion = makeBuilding("command", "player", 800, 500);
  state.buildings.set(expansion.id, expansion);

  state.buildings.delete(seeded.id);
  checkWinCondition(state);
  assert.equal(state.over, false, "the expansion still counts as a Command Center");

  state.buildings.delete(expansion.id);
  checkWinCondition(state);
  assert.equal(state.over, true);
  assert.equal(state.winner, "ai");
});

test("a still-constructing Command Center keeps a side in the game", () => {
  const state = createGameState({ planetId: "ferros" });
  const site = makeBuilding("command", "player", 800, 500, { constructing: true });
  state.buildings.set(site.id, site);
  state.buildings.delete(commandCenterOf(state, "player").id);

  checkWinCondition(state);

  assert.equal(state.over, false, "a founded expansion site is enough to stay in the fight");
});

test("checkWinCondition is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  state.buildings.delete(commandCenterOf(state, "player").id);   // would flip it to "ai" if not short-circuited

  checkWinCondition(state);

  assert.equal(state.winner, "player");
});
