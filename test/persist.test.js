import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

// The sim-owned facts, sorted by id so Map order can't matter — plus node
// amounts (mining) and fog memory, the dynamic bits a save has to preserve.
function snapshot(state) {
  const units = [...state.units.values()]
    .map(u => `${u.id}|${u.type}|${u.owner}|${u.x}|${u.y}|${u.hp}|${u.order ? u.order.type : "-"}`).sort();
  const builds = [...state.buildings.values()]
    .map(b => `${b.id}|${b.type}|${b.owner}|${b.hp}|${b.buildProgress}|${b.queue.length}`).sort();
  const res = JSON.stringify(state.players.player.resources) + JSON.stringify(state.players.ai.resources);
  const fog = state.fog.explored.reduce((a, v) => a + v, 0);
  const nodes = state.map.nodes.map(n => `${n.id}:${n.amount}`).sort().join(",");
  return JSON.stringify({ units, builds, res, fog, nodes,
    tick: state.tick, time: state.time, over: state.over, winner: state.winner });
}

test("a saved game round-trips through JSON to an identical state", () => {
  const a = createGameState({ planetId: "ferros", seed: 4242, rng: mulberry32(4242), aiMicro: true });
  for (let i = 0; i < 800; i++) tick(a, 0.1);   // build, fight, reveal fog, deplete nodes

  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));

  assert.equal(snapshot(b), snapshot(a), "the loaded state matches the saved one entity-for-entity");
});

test("a loaded game continues identically to the original — determinism survives the round-trip", () => {
  // Run the original fully FIRST (the id counter is module-global, so the two
  // states must not be ticked interleaved), capturing a save partway through.
  const a = createGameState({ planetId: "glacius", seed: 77, rng: mulberry32(77) });
  for (let i = 0; i < 500; i++) tick(a, 0.1);
  const save = serializeGame(a);
  for (let i = 0; i < 400; i++) tick(a, 0.1);   // original runs on to 900
  const original = snapshot(a);

  // Now reload from the mid-game save and run the SAME 400 ticks.
  const b = deserializeGame(save);               // restores the id counter to the save point
  for (let i = 0; i < 400; i++) tick(b, 0.1);

  assert.equal(snapshot(b), original, "the reloaded game replays the continuation exactly");
});

test("deserializeGame rejects an unknown save version", () => {
  assert.throws(() => deserializeGame({ v: 999 }), /unsupported save version/);
});
