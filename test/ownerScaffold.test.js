/* ============================================================
   The owner-generic SCAFFOLD. createGameState / rehydratePlanet no longer name
   "player"/"ai" twice over — they build the player map, the per-owner fog, the
   seeding and the victory check by ITERATING state.owners. These tests pin the
   structural invariants that make that safe:

   • state.owners is the canonical side list, and state.fog/state.fogAI are
     ALIASES into state.fogs (the same objects), so the generic map and the many
     legacy `state.fog` consumers can never drift apart.
   • a save round-trip rebuilds the scaffold identically.
   • the victory check reads last-side-standing for N sides, not just two, with a
     deterministic first-listed tie-break — so a future N-faction world is a
     change to the owner list, not a rewrite of victory.js.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { checkWinCondition, DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

function commandCenterOf(state, owner) {
  return [...state.buildings.values()].find(b => b.owner === owner && b.type === "command");
}

test("a fresh game exposes its sides as state.owners, in canonical order", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.deepEqual(state.owners, ["player", "ai"]);
  // one economy per owner, keyed by id
  for (const id of state.owners) {
    assert.ok(state.players[id], `players[${id}] exists`);
    assert.equal(state.players[id].id, id);
  }
});

test("state.fog / state.fogAI are the SAME objects as state.fogs entries (aliases, not copies)", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.equal(state.fog, state.fogs.player, "state.fog aliases state.fogs.player");
  assert.equal(state.fogAI, state.fogs.ai, "state.fogAI aliases state.fogs.ai");
  // Mutating through one view is visible through the other — proving they can't drift.
  state.fog.explored[0] = 1;
  assert.equal(state.fogs.player.explored[0], 1, "a write through the alias reaches the map entry");
  assert.deepEqual(Object.keys(state.fogs), state.owners, "one fog per owner");
});

test("a save round-trip rebuilds the owner scaffold and the fog aliases", () => {
  const state = createGameState({ planetId: "ferros", seed: 7 });
  const loaded = deserializeGame(serializeGame(state));
  assert.deepEqual(loaded.owners, ["player", "ai"], "owners restored");
  assert.equal(loaded.fog, loaded.fogs.player, "fog alias restored");
  assert.equal(loaded.fogAI, loaded.fogs.ai, "fogAI alias restored");
  for (const id of loaded.owners) assert.ok(loaded.players[id], `players[${id}] restored`);
});

test("victory reads last-side-standing for THREE sides, not just two", () => {
  const state = createGameState({ planetId: "ferros" });
  // Splice in a third faction with its own economy + Command Center — exactly the
  // shape a future N-owner world would carry.
  state.owners.push("rebels");
  state.players.rebels = { id: "rebels", faction: "neutral", isAI: true, resources: { ore: 0, crystals: 0, radioactives: 0 }, color: "#fbbf24", upgrades: {} };
  const rebelCC = makeBuilding("command", "rebels", 800, 500);
  state.buildings.set(rebelCC.id, rebelCC);

  // Three sides standing → the game runs on.
  checkWinCondition(state);
  assert.equal(state.over, false, "three Command Centers alive → no winner yet");

  // Knock out the player: two sides left, still no win.
  state.buildings.delete(commandCenterOf(state, "player").id);
  checkWinCondition(state);
  assert.equal(state.over, false, "two sides left → still running");

  // Knock out the AI: the rebels are the last side standing and take the world.
  state.buildings.delete(commandCenterOf(state, "ai").id);
  checkWinCondition(state);
  assert.equal(state.over, true);
  assert.equal(state.winner, "rebels", "the last Command Center standing wins, whoever owns it");
});

test("the score tie-break honours the FIRST side listed in state.owners", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // A dead-even board: clear everything and give every side an identical (empty) economy,
  // then force the time-limit tiebreak. The winner must be state.owners[0].
  state.units.clear();
  state.buildings.clear();   // no Command Centers → mutual-wipe path also runs scoreLeader
  state.owners = ["rebels", "player", "ai"];
  for (const id of state.owners)
    state.players[id] = { id, faction: "neutral", isAI: id !== "player", resources: { ore: 0, crystals: 0, radioactives: 0 }, color: "#fff", upgrades: {} };
  state.time = DEFAULT_MATCH_TIME_LIMIT + 1;

  checkWinCondition(state);
  assert.equal(state.over, true);
  assert.equal(state.winner, "rebels", "an exact score tie goes to the first-listed side (the defender's edge)");
});
