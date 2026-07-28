import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { issueMove, issueEscort } from "../engine/commands.js";
import { isNodeDiscovered } from "../engine/fog.js";
import { PLANET_ARCHETYPE } from "../engine/aiArchetypes.js";
import { UNITS } from "../engine/entities.js";
import { mulberry32, hashStr } from "../engine/rng.js";

// Seeded per planet (mulberry32, not the unseeded Math.random fallback — see
// engine/state.js's deterministic-exempt default) so a failure in any of the 18 cases
// across the two loops below reproduces exactly on rerun, instead of being a one-off
// tied to whatever that run's platform PRNG happened to roll for the map.
//
// The load-bearing invariant for every economy/tech/terrain change: the scripted
// AI must still drive every world to a decisive finish. A stalled economy, a
// tech-gate deadlock, or terrain that traps a wave would show up here as a
// non-resolving world. Runs the whole roster, not just ferros/glacius.
for (const planetId of Object.keys(PLANET_ARCHETYPE)) {
  test(`a full skirmish resolves to a winner on ${planetId}`, () => {
    const state = createGameState({ planetId, rng: mulberry32(hashStr(planetId)) });
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
    const state = createGameState({ planetId, aiMicro: true, rng: mulberry32(hashStr(planetId)) });
    let ticks = 0;
    while (!state.over && ticks < 20000) { tick(state, 0.1); ticks++; }
    assert.equal(state.over, true, `${planetId} (Tactical AI) should reach a winner before the ceiling`);
    assert.ok(["player", "ai"].includes(state.winner));
  });
}

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

// ---- updateUnit's switch actually reaches "scout"/"attack" through tick() — not just
// via the direct updateScoutMode/updateWorkerCombat calls scout.test.js/combat.test.js make ----

test("a worker given a scout order actually scouts once tick() dispatches to it, not just when updateScoutMode is called directly", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // Midfield, clear of both bases — same isolation the other direct-injection tests above use.
  const worker = makeUnit("worker", "player", 700, 300);
  state.units.set(worker.id, worker);
  worker.order = { type: "scout" };   // the real order shape (see test/scout.test.js) — sim.js/scout.js fill in tx/ty themselves
  const x0 = worker.x, y0 = worker.y;

  for (let i = 0; i < 20; i++) tick(state, 0.1);

  assert.ok(Math.hypot(worker.x - x0, worker.y - y0) > 1, "the worker travelled toward unexplored ground — scout mode actually ran under tick()'s real dispatch");
  assert.equal(worker.order.type, "scout", "scout mode is persistent through the real dispatch too, same as issueScout would leave it");
});

test("a worker with an explicit attack order damages its target once tick() dispatches to updateWorkerCombat", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = makeUnit("worker", "player", 700, 300);
  // Player-owned (not "ai") so the AI's own think-cycle — which runs on this very first tick —
  // never touches it; the only thing that can explain a change in its hp is the worker's swing.
  const target = makeUnit("skiff", "player", 708, 300);   // within the worker's short reach
  state.units.set(worker.id, worker);
  state.units.set(target.id, target);
  worker.order = { type: "attack", targetId: target.id };
  const startHp = target.hp;

  tick(state, 0.1);

  assert.equal(startHp - target.hp, UNITS.worker.attack, "the worker's weak swing landed through tick()'s real 'case attack' dispatch, not just a direct updateWorkerCombat call");
});

// ---- updateSupport's Mender-only branches, same gap: "attack" (reinterpreted as a harmless
// chase — see the comment above updateSupport in engine/sim.js) and "escort" are only ever
// proven at the updateSupport/keepEscortStation level, never through the real tick() entry point ----

test("a Mender's attack order chases its target but deals it no damage, through the real tick dispatch", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const cx = state.map.width / 2, cy = state.map.height / 2;   // mid-map, clear of both bases
  // Player-owned and idle, same isolation reasoning as test/escort.test.js's own tick()-driven
  // escort test — nothing but the Mender's own approach can explain the closing distance.
  const target = makeUnit("skiff", "player", cx, cy);
  const mender = makeUnit("mender", "player", cx - 300, cy);
  state.units.set(target.id, target);
  state.units.set(mender.id, mender);
  mender.order = { type: "attack", targetId: target.id };
  const d0 = Math.hypot(mender.x - target.x, mender.y - target.y);
  const hp0 = target.hp;

  for (let i = 0; i < 120; i++) tick(state, 0.1);

  const d1 = Math.hypot(mender.x - target.x, mender.y - target.y);
  assert.ok(d1 < d0 - 100, `the Mender closed hard on its target through tick()'s real dispatch (${d0.toFixed(0)} -> ${d1.toFixed(0)})`);
  assert.equal(target.hp, hp0, "an 'attack' order on a Mender is reinterpreted as chase-and-mend — it must deal NO damage, even through the real dispatch");
  assert.equal(mender.order.type, "attack", "a persistent chase — never clears on arrival, unlike a plain move");
});

test("a Mender given an escort order keeps station on its guarded unit, through the real tick dispatch", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const cx = state.map.width / 2, cy = state.map.height / 2;
  const target = makeUnit("skiff", "player", cx, cy);
  const mender = makeUnit("mender", "player", cx - 300, cy);
  state.units.set(target.id, target);
  state.units.set(mender.id, mender);
  issueEscort([mender], target.id);   // same real command test/escort.test.js's own tick()-driven case uses
  const d0 = Math.hypot(mender.x - target.x, mender.y - target.y);

  for (let i = 0; i < 120; i++) tick(state, 0.1);

  const d1 = Math.hypot(mender.x - target.x, mender.y - target.y);
  assert.ok(d1 < d0 - 100, `the Mender closed on its escort slot through tick()'s real dispatch (${d0.toFixed(0)} -> ${d1.toFixed(0)})`);
  assert.ok(mender.order && mender.order.type === "escort", "and it's still escorting — keeping station, not a one-shot move");
});
