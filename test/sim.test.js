import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";

test("a full skirmish runs to a decisive winner without throwing", () => {
  const state = createGameState({ planetId: "ferros" });
  const dt = 0.1;
  let ticks = 0;
  const maxTicks = 20000;   // 2000s of sim time — generous ceiling for a scripted AI to close it out

  while (!state.over && ticks < maxTicks) {
    tick(state, dt);
    ticks++;
  }

  assert.equal(state.over, true, "the skirmish should reach a winner before the ceiling");
  assert.ok(["player", "ai"] .includes(state.winner));
});

test("tick() is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  const timeBefore = state.time;

  tick(state, 1);

  assert.equal(state.time, timeBefore);
});
