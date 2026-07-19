import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { issueMove } from "../engine/commands.js";

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

test("a full skirmish concludes on a modified, poor-economy world (glacius)", () => {
  // glacius carries a speed modifier and deposits no crystals/radioactives —
  // it exercises the modifier plumbing and the AI's spendable-node filter and
  // effectiveMix together. If any of them stalled the AI's economy or its lone
  // wave, the game would never reach a winner within the ceiling.
  const state = createGameState({ planetId: "glacius" });
  const dt = 0.1;
  let ticks = 0;
  const maxTicks = 20000;

  while (!state.over && ticks < maxTicks) {
    tick(state, dt);
    ticks++;
  }

  assert.equal(state.over, true, "the skirmish should reach a winner before the ceiling");
  assert.ok(["player", "ai"].includes(state.winner));
});

test("a unit walks through its queued waypoints in order, then goes idle", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // Isolate one worker so nothing else steers or interrupts it.
  const w = makeUnit("worker", "player", 800, 500);
  state.units.clear();
  state.units.set(w.id, w);

  const path = [[900, 500], [900, 300], [700, 300]];
  issueMove([w], path[0][0], path[0][1]);            // first leg, immediate
  issueMove([w], path[1][0], path[1][1], true);      // queued
  issueMove([w], path[2][0], path[2][1], true);      // queued
  assert.equal(w.orderQueue.length, 2, "two waypoints are queued behind the active leg");

  const visited = [];
  for (let i = 0; i < 600; i++) {   // 30s of sim — comfortably longer than the ~10s path
    tick(state, 0.05);
    const next = path[visited.length];
    if (next && Math.hypot(w.x - next[0], w.y - next[1]) < 1.5) visited.push(next);
  }

  assert.deepEqual(visited, path, "it reaches each waypoint in the order they were queued");
  assert.equal(w.order, null, "with the chain finished it holds no order");
  assert.equal(w.orderQueue.length, 0, "and the queue is drained");
});

test("an idle worker never auto-acquires a neighbouring enemy — it stays on the economy", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // Midfield, clear of both bases so nothing else can reach them in one tick.
  const worker = makeUnit("worker", "player", 700, 300);
  const enemy = makeUnit("skiff", "ai", 712, 300);   // right on top of the worker
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = null;
  const enemyStartHp = enemy.hp;

  tick(state, 0.1);

  assert.equal(enemy.hp, enemyStartHp, "with no attack order, the worker never swings at the enemy beside it");
});

test("tick() is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  const timeBefore = state.time;

  tick(state, 1);

  assert.equal(state.time, timeBefore);
});
