import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { checkWinCondition, DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";

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

test("a match that reaches the time limit with both bases intact is decided on score", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // Both keep their Command Center; push time past the limit and give the AI a
  // clear material edge — a stack of units it didn't have to fight for.
  state.players.ai.resources.ore += 500;
  for (let i = 0; i < 6; i++) {
    const u = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y + i * 6);
    state.units.set(u.id, u);
  }
  state.time = DEFAULT_MATCH_TIME_LIMIT + 1;

  checkWinCondition(state);

  assert.equal(state.over, true, "the time limit ends an otherwise-endless stalemate");
  assert.equal(state.winner, "ai", "the side that out-massed and out-banked takes the tiebreak");
});

test("before the time limit, an even, both-bases-standing match keeps running", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.time = DEFAULT_MATCH_TIME_LIMIT - 1;
  checkWinCondition(state);
  assert.equal(state.over, false, "the tiebreak only fires at the limit, not before");
});

test("checkWinCondition is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  state.buildings.delete(commandCenterOf(state, "player").id);   // would flip it to "ai" if not short-circuited

  checkWinCondition(state);

  assert.equal(state.winner, "player");
});
