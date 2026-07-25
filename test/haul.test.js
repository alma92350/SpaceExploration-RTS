import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateHaul, assignHaul, updateService, assignService, countLogistics } from "../engine/haul.js";
import { storeTotal, storeCapOf, inputTotal, inputRoom, inputCapOf } from "../engine/entities.js";
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

test("a hauler prefers a forward drop-off (Refinery/Foundry/Arsenal) over the Command Center when it's the closer place to deposit right now", () => {
  const { s, cc, workers } = base(1);
  // The rig sits far from the CC, with a Refinery planted right next to it — the documented
  // "forward drop-off shortens a distant mining run" pattern, now extended to a HAUL job.
  const rig = makeBuilding("plasmarig", "player", cc.x + 900, cc.y);
  rig.store = { ore: 60 };
  rig.paused = true;
  s.buildings.set(rig.id, rig);
  const refinery = makeBuilding("refinery", "player", rig.x + 20, rig.y);
  s.buildings.set(refinery.id, refinery);
  const w = workers[0];
  w.x = rig.x; w.y = rig.y;
  w.order = { type: "haul", buildingId: rig.id };
  const ccOreBefore = s.players.player.resources.ore || 0;

  for (let i = 0; i < 2000 && (storeTotal(rig) > 0 || (w.cargo && w.cargo.qty > 0)); i++) updateHaul(s, w, 0.05);

  assert.equal(storeTotal(rig), 0, "the rig's whole buffer was hauled away");
  assert.ok(storeTotal(refinery) > 0, "it landed in the much-closer Refinery's own buffer");
  assert.equal(s.players.player.resources.ore || 0, ccOreBefore,
    "not one trip detoured all the way to the distant Command Center while the Refinery had room");
});

test("a hauler falls back to the Command Center once the closer forward drop-off's buffer is full", () => {
  const { s, cc, workers } = base(1);
  const rig = makeBuilding("plasmarig", "player", cc.x + 900, cc.y);
  rig.store = { ore: storeCapOf("refinery") + 40 };   // more than the Refinery can ever hold
  rig.paused = true;
  s.buildings.set(rig.id, rig);
  const refinery = makeBuilding("refinery", "player", rig.x + 20, rig.y);
  s.buildings.set(refinery.id, refinery);
  const w = workers[0];
  w.x = rig.x; w.y = rig.y;
  w.order = { type: "haul", buildingId: rig.id };

  for (let i = 0; i < 6000 && (storeTotal(rig) > 0 || (w.cargo && w.cargo.qty > 0)); i++) updateHaul(s, w, 0.05);

  assert.equal(storeTotal(rig), 0, "the whole (oversized) buffer eventually clears");
  assert.equal(storeTotal(refinery), storeCapOf("refinery"), "the Refinery filled all the way up");
  assert.ok((s.players.player.resources.ore || 0) > 0, "and the overflow still reached the treasury via the Command Center");
});

test("mid-trip re-route: a hauler already walking toward the Command Center switches to a nearer drop-off that completes along the way", () => {
  const { s, cc, workers } = base(1);
  const rig = makeBuilding("plasmarig", "player", cc.x + 900, cc.y);
  rig.store = { ore: 30 };
  rig.paused = true;
  s.buildings.set(rig.id, rig);
  const w = workers[0];
  w.x = rig.x; w.y = rig.y;
  w.order = { type: "haul", buildingId: rig.id };

  // Load up and take a few steps toward the only (distant) Command Center...
  for (let i = 0; i < 20; i++) updateHaul(s, w, 0.05);
  assert.equal(w.order.phase, "toDrop");
  const midX = w.x;

  // ...then a Refinery completes right where the worker already is, much closer than the CC.
  const refinery = makeBuilding("refinery", "player", w.x + 5, w.y);
  s.buildings.set(refinery.id, refinery);

  for (let i = 0; i < 40 && w.order; i++) updateHaul(s, w, 0.05);

  assert.ok(storeTotal(refinery) > 0, "it re-routed to the newly-completed, much closer Refinery instead of continuing on to the CC");
  assert.ok(Math.abs(w.x - midX) < 50, "it didn't keep marching toward the distant CC first");
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
  countLogistics(s);
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
  countLogistics(s);
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

// ---- service round trip: workers carry inputs INTO a factory and its output BACK --------

// A player factory planted next to the CC, with a Reactor for Power.
function plantFactory(s, cc, type = "smelter") {
  const reactor = makeBuilding("reactor", "player", cc.x + 30, cc.y - 30);
  const f = makeBuilding(type, "player", cc.x + 55, cc.y);
  s.buildings.set(reactor.id, reactor);
  s.buildings.set(f.id, f);
  return f;
}

test("a service worker carries a factory's input from the treasury into its larder", () => {
  const { s, cc, workers } = base(1);
  const sm = plantFactory(s, cc);
  s.players.player.resources.ore = 100;
  const w = workers[0];
  w.x = cc.x; w.y = cc.y;
  w.order = { type: "service", buildingId: sm.id, phase: "plan" };

  for (let i = 0; i < 4000 && inputTotal(sm) <= 0; i++) updateService(s, w, 0.05);

  assert.ok(inputTotal(sm) > 0, "the smelter's larder was filled");
  assert.ok((s.players.player.resources.ore || 0) < 100, "…drawn from the treasury");
});

test("a service worker also carries the finished OUTPUT back on the return trip (round trip)", () => {
  const { s, cc, workers } = base(1);
  const sm = plantFactory(s, cc);
  sm.input = { ore: 999 };               // fully stocked, so there's no input to fetch this trip
  sm.store = { metals: 40 };             // …but a backlog of output to carry home
  s.players.player.resources.metals = 0;
  const w = workers[0];
  w.x = cc.x; w.y = cc.y;
  w.order = { type: "service", buildingId: sm.id, phase: "plan" };

  for (let i = 0; i < 4000 && (s.players.player.resources.metals || 0) <= 0; i++) updateService(s, w, 0.05);

  assert.ok((s.players.player.resources.metals || 0) > 0, "the worker hauled the factory's output back to the treasury");
  assert.ok(storeTotal(sm) < 40, "…drawing down its output buffer");
});

// ---- multi-input recipes: one oversupplied input must never crowd out room for another --------

test("inputCapOf splits the larder evenly across a recipe's real (non-energy) input commodities", () => {
  const single = inputCapOf("smelter");     // recipe "smelt": ore + energy — one real input
  const dual = inputCapOf("chipfab");       // recipe "chipfab": crystals + metals + energy — two real inputs
  assert.ok(near(single, 80, 1e-6), "a single-input factory keeps the whole 80 to itself");
  assert.ok(near(dual, 40, 1e-6), "a two-input factory splits it 40/40 — its own guaranteed slice each");
});

test("a Chip Fab starved of crystals can still receive them even with its metals larder already topped up", () => {
  const { s, cc, workers } = base(1);
  const fab = plantFactory(s, cc, "chipfab");
  // Metals already banked deep (well past where the OLD shared 80-total pool would have left
  // crystals no room at all) — crystals sits at zero despite the treasury having plenty of both.
  fab.input = { metals: 35 };
  s.players.player.resources.metals = 100;
  s.players.player.resources.crystals = 100;
  const w = workers[0];
  w.x = cc.x; w.y = cc.y;
  w.order = { type: "service", buildingId: fab.id, phase: "plan" };

  assert.ok(inputRoom(fab, "crystals") > 0, "crystals still has its OWN room even though metals is nearly full");

  for (let i = 0; i < 4000 && (fab.input.crystals || 0) <= 0; i++) updateService(s, w, 0.05);

  assert.ok((fab.input.crystals || 0) > 0, "the worker actually delivered the missing crystals — not stalled behind metals");
});

test("an oversupplied input is capped at its OWN slice, not the whole larder — so it can't starve the other input's room", () => {
  const { s, cc } = base(1);
  const fab = plantFactory(s, cc, "chipfab");
  fab.input = { metals: 39.9 };   // right at the edge of its own 40-unit slice
  s.players.player.resources.metals = 100;

  assert.ok(inputRoom(fab, "metals") > 0, "still a sliver of room in metals' own slice");
  assert.ok(near(inputRoom(fab, "crystals"), 40, 1e-6),
    "crystals' room is UNCHANGED by metals sitting almost full — each commodity has its own independent slice");
});

test("an idle worker auto-services a starving factory, and its metals come back to the treasury", () => {
  const { s, cc } = base(2);
  const sm = plantFactory(s, cc);
  s.players.player.resources.ore = 200;

  for (let i = 0; i < 800; i++) tick(s, 0.1);

  assert.ok((s.players.player.resources.ore || 0) < 200, "ore was carried out of the treasury into the smelter");
  assert.ok((s.players.player.resources.metals || 0) > 0, "…refined into metals and hauled back — the full round trip ran");
});

test("a manually-assigned worker keeps servicing its one building", () => {
  const { s, cc, workers } = base(6);
  const sm = plantFactory(s, cc);
  s.players.player.resources.ore = 300;
  const w = workers[0];
  w.order = { type: "service", buildingId: sm.id, phase: "plan", manual: true };
  for (let i = 0; i < 1200; i++) { tick(s, 0.1); if (!w.order) break; }
  assert.ok(w.order && w.order.type === "service" && w.order.buildingId === sm.id,
    "it stays bound to its assigned building rather than going idle");
  assert.ok((s.players.player.resources.metals || 0) > 0, "…and keeps the metals flowing back");
});

test("an AI-owned forward drop-off banks straight to the treasury — no buffer, no logistics (determinism)", () => {
  const { s, cc } = base(7);
  const aiCC = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  const ref = makeBuilding("refinery", "ai", aiCC.x + 30, aiCC.y);
  s.buildings.set(ref.id, ref);
  for (let i = 0; i < 300; i++) tick(s, 0.1);
  assert.equal(storeTotal(ref), 0, "the AI's Refinery buffer stays empty — AI banks to the treasury as before");
  const aiLogi = [...s.units.values()].some(u => u.owner === "ai" && u.order && (u.order.type === "haul" || u.order.type === "service"));
  assert.equal(aiLogi, false, "and no AI worker ever hauls or services");
});

test("assignService is owner-scoped and skips a well-stocked, cleared factory", () => {
  const { s, cc, workers } = base(3);
  const sm = plantFactory(s, cc);
  sm.input = { ore: 999 };              // brimming larder → no input needed
  sm.store = {};                        // …and no output backlog → nothing to clear
  s.players.player.resources.ore = 500;
  const w = workers[0]; w.order = null;
  countLogistics(s);
  assignService(s, w);
  assert.equal(w.order, null, "a fed, cleared factory pulls no worker");
});

// ---- fuel-burning power stations: a worker SERVICE run refills the larder, same as a factory --

// A player Combustion Generator (or Biomass Reactor) planted next to the CC, empty larder by default.
function plantGenerator(s, cc, type = "combustor") {
  const gen = makeBuilding(type, "player", cc.x + 45, cc.y);
  s.buildings.set(gen.id, gen);
  return gen;
}

test("a service worker carries fuel from the treasury into a Combustion Generator's own larder", () => {
  const { s, cc, workers } = base(1);
  const gen = plantGenerator(s, cc);
  s.players.player.resources.gas = 100;
  const w = workers[0];
  w.x = cc.x; w.y = cc.y;
  w.order = { type: "service", buildingId: gen.id, phase: "plan" };

  for (let i = 0; i < 4000 && inputTotal(gen) <= 0; i++) updateService(s, w, 0.05);

  assert.ok(inputTotal(gen) > 0, "the Generator's larder was filled");
  assert.ok((s.players.player.resources.gas || 0) < 100, "…drawn from the treasury");
});

test("an idle worker auto-refuels an empty Combustion Generator, and it powers on entirely on its own", () => {
  const { s, cc } = base(2);
  const gen = plantGenerator(s, cc);
  s.players.player.resources.gas = 200;
  assert.equal(gen.powered, undefined, "starts unfed");

  for (let i = 0; i < 800; i++) tick(s, 0.1);

  assert.ok(inputTotal(gen) > 0, "a worker hauled gas into its larder on its own — no manual assignment");
  assert.equal(gen.powered, true, "…and it's now actually running");
});

test("an idle worker auto-refuels a Biomass Reactor the same way, with biomass", () => {
  const { s, cc } = base(3);
  const gen = plantGenerator(s, cc, "biomassreactor");
  s.players.player.resources.biomass = 200;

  for (let i = 0; i < 800; i++) tick(s, 0.1);

  assert.ok((gen.input?.biomass || 0) > 0, "a worker hauled biomass into its larder on its own");
  assert.equal(gen.powered, true);
});

test("countLogistics resets a power station's `servers` tally each tick, same as a factory's — so a SECOND refuel run isn't permanently blocked", () => {
  // Regression: countLogistics used to only reset `servers` for a recipe-having building, never
  // for a fuel-burning power station — its tally could only ever climb, hard-capping out at
  // MAX_SERVERS after the very first worker and locking out every worker after, forever.
  const { s, cc, workers } = base(4);
  const gen = plantGenerator(s, cc);
  s.players.player.resources.gas = 500;
  const w = workers[0];
  w.x = cc.x; w.y = cc.y;

  for (let cycle = 0; cycle < 3; cycle++) {
    countLogistics(s);
    w.order = null;
    assignService(s, w);
    assert.equal(w.order?.type, "service", `cycle ${cycle}: still assignable — servers wasn't left stuck maxed-out`);
    for (let i = 0; i < 3000 && w.order; i++) { countLogistics(s); updateService(s, w, 0.05); }
  }
});

test("a Combustion Generator's fuel larder is deterministic: two same-seed runs end up identically fuelled", () => {
  const run = () => {
    const { s, cc } = base(5);
    const gen = plantGenerator(s, cc);
    s.players.player.resources.gas = 150;
    for (let i = 0; i < 600; i++) tick(s, 0.1);
    return { gas: gen.input?.gas || 0, powered: !!gen.powered };
  };
  assert.deepEqual(run(), run());
});
