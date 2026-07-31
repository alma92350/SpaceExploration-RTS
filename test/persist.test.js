import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { issuePatrol } from "../engine/commands.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { sideMod, PLANET_MODIFIERS } from "../engine/map.js";

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

// Pick your side of the Oort/Nimbus asymmetric matchups (docs/improvement-proposals.md): an
// additive per-state field next to sizeMult/resourceMult (engine/state.js, engine/persist.js) —
// default false, no SAVE_VERSION bump. Proves the flag round-trips AND that the RELOADED map
// (rehydratePlanet re-runs generateMap from the seed) still carries the swapped assignment, not
// just a bare boolean disconnected from the map it's supposed to describe.
test("swapAsym round-trips through save/load with its swapped map modifiers intact", () => {
  const a = createGameState({ planetId: "oort", seed: 55, rng: mulberry32(55), swapAsym: true });
  assert.equal(sideMod(a, "player", "buildTimeMult"), PLANET_MODIFIERS.oort.asym.ai.buildTimeMult,
    "sanity: swapAsym really did exchange the asym halves on the fresh state");

  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(b.swapAsym, true, "the flag itself round-trips");
  assert.equal(sideMod(b, "player", "buildTimeMult"), PLANET_MODIFIERS.oort.asym.ai.buildTimeMult,
    "the reloaded map was regenerated WITH the swap honored, not the unswapped default");
});

test("swapAsym defaults to false, and a save from before this field existed loads as unswapped", () => {
  const a = createGameState({ planetId: "oort", seed: 56, rng: mulberry32(56) });
  assert.equal(a.swapAsym, false, "swapAsym defaults false when not requested");
  const save = serializeGame(a);
  delete save.swapAsym;   // simulate a pre-this-feature save
  const b = deserializeGame(save);
  assert.equal(b.swapAsym, false, "an old save without the field loads as unswapped, not throwing/undefined");
});

// Patrol (docs/improvement-proposals.md "Patrol: looping attack-move waypoints"): the order's
// `patrol` flag is a purely additive field on the existing order/orderQueue shapes persist.js
// already serializes (serPlanet's `...u` rest-spread keeps whatever an order object carries —
// see engine/persist.js), so this needs no dedicated persist.js code and no SAVE_VERSION bump,
// per CONTRIBUTING's additive-field rule — this test is the empirical proof of that claim.
test("a patrol order's flag round-trips through save/load with no dedicated persist.js code", () => {
  const state = createGameState({ planetId: "ferros", seed: 99, rng: mulberry32(99) });
  const skiff = makeUnit("skiff", "player", 700, 500);
  state.units.set(skiff.id, skiff);
  issuePatrol([skiff], [{ x: 750, y: 500 }, { x: 750, y: 400 }]);

  const loaded = deserializeGame(JSON.parse(JSON.stringify(serializeGame(state))));
  const reloaded = loaded.units.get(skiff.id);

  assert.ok(reloaded, "the patrolling unit itself survived the round-trip");
  assert.equal(reloaded.order.patrol, true, "the active leg's patrol flag survives — persist.js's order serialization is a generic rest-spread, not a field allowlist");
  assert.equal(reloaded.orderQueue.length, skiff.orderQueue.length,
    "the whole queue length (including the trailing copy of the active leg — see test/commands.test.js) is preserved");
  assert.ok(reloaded.orderQueue.every(o => o.patrol === true), "every queued leg's patrol flag survives too");
});
