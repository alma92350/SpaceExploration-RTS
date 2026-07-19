import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { issueMove } from "../engine/commands.js";
import { isNodeDiscovered } from "../engine/fog.js";
import { PLANET_ARCHETYPE } from "../engine/aiArchetypes.js";

// The load-bearing invariant for every economy/tech/terrain change: the scripted
// AI must still drive every world to a decisive finish. A stalled economy, a
// tech-gate deadlock, or terrain that traps a wave would show up here as a
// non-resolving world. Runs the whole roster, not just ferros/glacius.
for (const planetId of Object.keys(PLANET_ARCHETYPE)) {
  test(`a full skirmish resolves to a winner on ${planetId}`, () => {
    const state = createGameState({ planetId });
    let ticks = 0;
    while (!state.over && ticks < 20000) { tick(state, 0.1); ticks++; }
    assert.equal(state.over, true, `${planetId} should reach a winner before the ceiling`);
    assert.ok(["player", "ai"].includes(state.winner));
  });
}

// The resolve guarantee must also hold with the Tactical AI (focus-fire/kiting)
// enabled: its micro only ever engages VISIBLE enemy combat, so against a passive
// player it should raze the base exactly as the Standard AI does. If micro ever
// stalled the finish, one of these nine would blow past the ceiling.
for (const planetId of Object.keys(PLANET_ARCHETYPE)) {
  test(`a Tactical-AI skirmish still resolves to a winner on ${planetId}`, () => {
    const state = createGameState({ planetId, aiMicro: true });
    let ticks = 0;
    while (!state.over && ticks < 20000) { tick(state, 0.1); ticks++; }
    assert.equal(state.over, true, `${planetId} (Tactical AI) should reach a winner before the ceiling`);
    assert.ok(["player", "ai"].includes(state.winner));
  });
}

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

test("the AI is not omniscient: it scouts, revealing the map and discovering caches over a match", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const exploredCells = () => state.fogAI.explored.reduce((sum, v) => sum + v, 0);
  const start = exploredCells();   // just its home corner at kickoff

  for (let i = 0; i < 4000 && !state.over; i++) tick(state, 0.1);

  assert.ok(exploredCells() > start * 2, "the AI should have scouted well beyond its starting corner");
  const caches = state.map.nodes.filter(n => n.hidden);
  assert.ok(caches.some(c => isNodeDiscovered(state.fogAI, c)),
    "and turned up at least one hidden cache by exploring, rather than knowing it for free");
});

test("AI speed scales with its APM setting: a slow AI builds far less during ramp-up", () => {
  // Measured during ramp-up (2 min): above a moderate APM the AI becomes
  // resource-limited rather than action-limited and counts converge, so the
  // throttle is clearest early and with a wide gap.
  const output = apm => {
    const s = createGameState({ planetId: "ferros", rng: () => 0.5, aiApm: apm });
    for (let i = 0; i < 1200; i++) tick(s, 0.1);
    return [...s.units.values()].filter(u => u.owner === "ai").length
         + [...s.buildings.values()].filter(b => b.owner === "ai").length;
  };
  const slow = output(2), fast = output(150);
  assert.ok(slow < fast * 0.75, `a 2-APM AI (${slow} things) should build far less than a 150-APM one (${fast})`);
});

test("tick() is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  const timeBefore = state.time;

  tick(state, 1);

  assert.equal(state.time, timeBefore);
});
