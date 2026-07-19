import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";

// A tiny seeded PRNG so both runs draw the *same* varying sequence — a
// constant rng would make map generation degenerate and wouldn't exercise the
// id-driven tie-breaks the determinism guarantee actually rests on.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Serialize just the deterministic, sim-owned facts: entity positions/hp/state,
// both economies, and how much fog has been revealed. Sorted by id so Map
// iteration order can't matter.
function snapshot(state) {
  const units = [...state.units.values()]
    .map(u => `${u.id}|${u.type}|${u.owner}|${u.x}|${u.y}|${u.hp}|${u.order ? u.order.type : "-"}`)
    .sort();
  const builds = [...state.buildings.values()]
    .map(b => `${b.id}|${b.type}|${b.owner}|${b.hp}|${b.buildProgress}|${b.queue.length}`)
    .sort();
  const res = JSON.stringify(state.players.player.resources) + JSON.stringify(state.players.ai.resources);
  const fog = state.fog.explored.reduce((a, v) => a + v, 0);
  return JSON.stringify({ units, builds, res, fog, tick: state.tick, over: state.over, winner: state.winner });
}

function runTo(planetId, seed, ticks) {
  const state = createGameState({ planetId, rng: mulberry32(seed) });
  for (let i = 0; i < ticks && !state.over; i++) tick(state, 0.1);
  return state;
}

test("the sim is deterministic: two same-seed runs produce byte-identical state", () => {
  // Long enough that the AI has built, fought, revealed fog, and units have
  // jostled through separation/avoidance — all the id-hashed tie-breaks.
  const a = runTo("ferros", 12345, 2500);
  const b = runTo("ferros", 12345, 2500);
  assert.equal(snapshot(a), snapshot(b), "identical seed + planet must replay identically");
  assert.ok(a.tick > 100, "and the run must actually have progressed, not ended instantly");
});

test("different seeds diverge — the determinism above isn't just a frozen sim", () => {
  const a = snapshot(runTo("ferros", 1, 1500));
  const b = snapshot(runTo("ferros", 2, 1500));
  assert.notEqual(a, b, "two different seeds should not produce the same world");
});

test("id counter resets per game: a second createGameState in the same process replays identically", () => {
  // Guards the nextEntityId reset — before it, the module-global counter kept
  // climbing across games, so the second run minted different ids (and thus
  // different id-hashed micro-positions) despite the identical seed.
  const first = runTo("ferros", 999, 800);
  const second = runTo("ferros", 999, 800);
  assert.equal(snapshot(first), snapshot(second));
});

test("perf guard: 200 units for 120 ticks stays well under a generous budget", () => {
  // Not a benchmark — a catastrophe alarm. Catches an accidental O(n^2)->O(n^3)
  // regression or a per-tick allocation blow-up without flaking on a slow CI box.
  const state = createGameState({ planetId: "ferros", rng: mulberry32(7) });
  for (let i = 0; i < 200; i++) {
    const owner = i % 2 === 0 ? "player" : "ai";
    const type = ["skiff", "bastion", "lancer"][i % 3];
    const u = makeUnit(type, owner, 700 + (i % 20) * 6, 400 + Math.floor(i / 20) * 6);
    u.order = { type: "attack-move", x: 800, y: 500 };
    state.units.set(u.id, u);
  }
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) tick(state, 0.05);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 8000, `200-unit sim took ${elapsed.toFixed(0)}ms for 120 ticks (budget 8000ms)`);
});
