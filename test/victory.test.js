import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
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

test("checkWinCondition is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  state.buildings.delete(commandCenterOf(state, "player").id);   // would flip it to "ai" if not short-circuited

  checkWinCondition(state);

  assert.equal(state.winner, "player");
});
