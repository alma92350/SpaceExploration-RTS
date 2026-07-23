import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateHaul, assignHaul, countHaulers } from "../engine/haul.js";
import { storeTotal, storeCapOf } from "../engine/entities.js";
import { mulberry32 } from "./_helpers.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// A skirmish world seeds a finished Command Center + 3 workers (a drop-off + labour),
// which is exactly what haulage needs; the Plasma Rig is odysseyOnly but nothing stops a
// test from planting one to drive the haul loop directly.
function base(seed = 1) {
  const s = createGameState({ planetId: "ferros", rng: mulberry32(seed) });
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const workers = [...s.units.values()].filter(u => u.owner === "player" && u.type === "worker");
  return { s, cc, workers };
}
// A player rig planted next to the CC, pre-loaded with `store`, so the haul loop has something to move.
function plantRig(s, cc, store) {
  const rig = makeBuilding("plasmarig", "player", cc.x + 50, cc.y);
  rig.store = { ...store };
  s.buildings.set(rig.id, rig);
  return rig;
}

test("a hauler carries a producer's buffered output to the Command Center and banks it 1:1", () => {
  const { s, cc, workers } = base(1);
  const rig = plantRig(s, cc, { ore: 55 });
  rig.paused = true;   // don't dig — isolate the haulage (buffer only drains)
  const w = workers[0];
  w.x = rig.x; w.y = rig.y;
  w.order = { type: "haul", buildingId: rig.id };
  const before = s.players.player.resources.ore || 0;

  for (let i = 0; i < 6000 && (storeTotal(rig) > 0 || (w.cargo && w.cargo.qty > 0)); i++) updateHaul(s, w, 0.05);

  assert.equal(storeTotal(rig), 0, "the whole buffer is hauled away");
  assert.ok(near((s.players.player.resources.ore || 0) - before, 55, 1e-3),
    "the treasury gains exactly what the buffer held — no gather multiplier double-dips a rig's yield");
});

test("an idle worker auto-assigns to a backed-up producer and keeps it flowing", () => {
  const { s, cc } = base(2);
  // Deep in a filled buffer already, so the ≥34% assign threshold is met immediately.
  const rig = plantRig(s, cc, { crystals: 80 });
  const before = s.players.player.resources.crystals || 0;

  // The seeded workers are idle at the base; the sim should send one to haul.
  for (let i = 0; i < 400; i++) tick(s, 0.1);

  assert.ok((s.players.player.resources.crystals || 0) > before, "an idle worker fetched the buffered crystals to the CC");
  assert.ok(storeTotal(rig) < 80, "the producer's buffer was drawn down");
});

test("no more than the hauler cap is assigned to one producer", () => {
  const { s, cc, workers } = base(3);
  const rig = plantRig(s, cc, { ore: 120 });   // full buffer → maximum pull
  // Pile many idle workers right on the rig so every one of them is a candidate this tick.
  for (let i = 0; i < 8; i++) {
    const w = makeUnit("worker", "player", rig.x, rig.y);
    s.units.set(w.id, w);
  }
  countHaulers(s);
  for (const w of [...s.units.values()].filter(u => u.owner === "player" && u.type === "worker")) {
    if (!w.order) assignHaul(s, w);
  }
  const onRig = [...s.units.values()].filter(u => u.order && u.order.type === "haul" && u.order.buildingId === rig.id).length;
  assert.ok(onRig <= 2, `at most 2 haulers on one producer (got ${onRig})`);
  assert.ok(onRig >= 1, "…but at least one takes the job");
});

test("assignHaul is owner-scoped: a worker won't haul from another side's producer", () => {
  const { s, cc, workers } = base(4);
  // Re-flag the rig as AI-owned; a player worker must ignore it.
  const rig = plantRig(s, cc, { ore: 120 });
  rig.owner = "ai";
  const w = workers[0];
  w.x = rig.x; w.y = rig.y;
  w.order = null;
  countHaulers(s);
  assignHaul(s, w);
  assert.equal(w.order, null, "a player worker is not assigned to an AI-owned producer");
});

test("skirmish never hauls: with no output buffers there are no haul orders", () => {
  const { s } = base(5);
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  const anyHaul = [...s.units.values()].some(u => u.order && u.order.type === "haul");
  assert.equal(anyHaul, false, "no producer has a buffer in a skirmish, so no worker ever hauls");
});

test("haulage is deterministic: two same-seed runs bank identical treasuries", () => {
  const run = () => {
    const { s, cc } = base(9);
    plantRig(s, cc, { ore: 90, crystals: 30 });
    for (let i = 0; i < 500; i++) tick(s, 0.1);
    return { ore: s.players.player.resources.ore || 0, crystals: s.players.player.resources.crystals || 0 };
  };
  assert.deepEqual(run(), run());
});
