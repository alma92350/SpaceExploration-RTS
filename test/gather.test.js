import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { updateGather } from "../engine/gather.js";
import { UNITS } from "../engine/entities.js";

function firstNode(state, com) {
  return state.map.nodes.find(n => n.com === com);
}

// Cargo gained in one small mining tick with `miners` workers on the node —
// small dt so neither the node amount nor the cargo cap is the binding limit,
// leaving the take equal to gatherRate * efficiency * dt.
function takeWithMiners(miners) {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  worker.x = node.x; worker.y = node.y;
  worker.cargo = { com: "ore", qty: 0 };
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };
  if (miners !== undefined) node.miners = miners;
  updateGather(state, worker, 0.1);
  return worker.cargo.qty;
}

test("a worker walks to its node, fills cargo, then walks back and deposits", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const startOre = state.players.player.resources.ore;

  worker.order = { type: "gather", nodeId: node.id };

  // Run enough fixed ticks for a full walk-mine-walk-deposit cycle without
  // hardcoding tick counts to exact travel time (map geometry can shift).
  for (let i = 0; i < 2000 && state.players.player.resources.ore === startOre; i++) {
    updateGather(state, worker, 0.05);
  }

  assert.ok(state.players.player.resources.ore > startOre, "resources should increase after a deposit");
  assert.ok(node.amount < node.max, "the node should have less left after being mined");
});

test("mining respects the worker's cargo cap", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  worker.x = node.x; worker.y = node.y;   // skip travel — isolate the mining phase
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 50; i++) updateGather(state, worker, 0.5);

  assert.ok(worker.cargo.qty <= 10, "cargo never exceeds the worker's cap");
});

test("a fully depleted node leaves the worker idle after its final deposit", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  node.amount = 4;   // less than one worker's cargo cap
  worker.x = node.x; worker.y = node.y;
  worker.order = { type: "gather", nodeId: node.id, phase: "mining" };

  for (let i = 0; i < 2000 && worker.order; i++) updateGather(state, worker, 0.05);

  assert.equal(worker.order, null);
  assert.ok(node.amount <= 0);
});

test("mining saturates: workers past the soft cap pull a diminishing share, never zero", () => {
  const rate = UNITS.worker.gatherRate, cap = UNITS.worker.minerSoftCap, fall = UNITS.worker.minerFalloff;
  const full = rate * 0.1;
  // At or below the soft cap: full rate.
  assert.ok(Math.abs(takeWithMiners(1) - full) < 1e-9, "one miner mines at full rate");
  assert.ok(Math.abs(takeWithMiners(cap) - full) < 1e-9, "at the soft cap, still full rate");
  // Past it: the per-worker share is the node average (cap + extra*fall)/m.
  const eff6 = (cap + (6 - cap) * fall) / 6;
  assert.ok(Math.abs(takeWithMiners(6) - full * eff6) < 1e-9, "six miners each pull the averaged share");
  // Monotonically diminishing, but always above the floor.
  assert.ok(takeWithMiners(4) > takeWithMiners(6) && takeWithMiners(6) > takeWithMiners(10), "more miners -> less each");
  assert.ok(takeWithMiners(20) > full * fall * 0.99, "efficiency never drops below the falloff floor");
});

test("no miner count set (a direct-call test or legacy state) means no penalty — full rate", () => {
  const rate = UNITS.worker.gatherRate;
  assert.ok(Math.abs(takeWithMiners(undefined) - rate * 0.1) < 1e-9, "unset node.miners reads as full rate");
});

test("a worker re-tasked to a different commodity keeps its load and hauls it home first", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const oreNode = firstNode(state, "ore");
  worker.cargo = { com: "crystals", qty: 7 };   // already carrying a partial crystal load
  worker.x = oreNode.x; worker.y = oreNode.y;
  worker.order = { type: "gather", nodeId: oreNode.id, phase: "mining" };
  const startCrystals = state.players.player.resources.crystals;

  // One mining-phase tick should NOT zero the cargo — it should route to drop.
  updateGather(state, worker, 0.05);
  assert.equal(worker.cargo.qty, 7, "the already-mined crystals are not thrown away");
  assert.equal(worker.order.phase, "toDrop", "instead the worker heads home to deposit them first");

  // Let it finish: it deposits the crystals, then returns to mine the ore node.
  for (let i = 0; i < 4000 && state.players.player.resources.crystals === startCrystals; i++) {
    updateGather(state, worker, 0.05);
  }
  assert.ok(state.players.player.resources.crystals >= startCrystals + 7, "the carried crystals reach the bank");
});

test("a constructing expansion Command Center only becomes a dropoff once it completes", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const site = makeBuilding("command", "player", node.x + 60, node.y, { constructing: true });
  state.buildings.set(site.id, site);

  // A full worker right beside the site, ready to deposit.
  worker.x = site.x + 10; worker.y = site.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;

  updateGather(state, worker, 0.05);
  assert.equal(state.players.player.resources.ore, before, "a construction site accepts no deposits — the worker heads for the distant seeded CC");

  site.constructing = false;
  site.buildProgress = 1;
  updateGather(state, worker, 0.05);
  assert.ok(state.players.player.resources.ore > before, "the finished expansion is the nearest dropoff");
});

test("an industrial building doubles as a drop-off: a worker banks at a forward Refinery, not the distant base CC", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  // A completed Refinery planted right on the node, far from the seeded base CC.
  const refinery = makeBuilding("refinery", "player", node.x + 12, node.y, { constructing: false });
  state.buildings.set(refinery.id, refinery);
  // The worker is full and standing at the node — well beyond DROP_REACH of the
  // base CC, so a deposit this tick can ONLY be the nearby Refinery.
  worker.x = node.x; worker.y = node.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;
  const cc = [...state.buildings.values()].find(b => b.type === "command");
  assert.ok(Math.hypot(cc.x - worker.x, cc.y - worker.y) > 30, "the base CC is out of drop reach — only the Refinery is close");

  updateGather(state, worker, 0.05);
  assert.ok(state.players.player.resources.ore > before, "the Refinery accepted the haul as a drop-off point");
  assert.equal(worker.cargo.qty, 0, "cargo emptied at the forward Refinery");
});

test("a still-constructing Refinery is not yet a drop-off", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
  const node = firstNode(state, "ore");
  const refinery = makeBuilding("refinery", "player", node.x + 12, node.y, { constructing: true });
  state.buildings.set(refinery.id, refinery);
  worker.x = node.x; worker.y = node.y;
  worker.cargo = { com: "ore", qty: 10 };
  worker.order = { type: "gather", nodeId: node.id, phase: "toDrop" };
  const before = state.players.player.resources.ore;

  updateGather(state, worker, 0.05);
  assert.equal(state.players.player.resources.ore, before, "an unfinished Refinery banks nothing — the worker heads for the distant CC");
});

test("Logistics Network (+25% yield) banks more per haul", () => {
  const bank = withUpgrade => {
    const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
    if (withUpgrade) state.players.player.upgrades.logisticsNetwork = true;
    const worker = [...state.units.values()].find(u => u.owner === "player" && u.type === "worker");
    const cc = [...state.buildings.values()].find(b => b.type === "command" && b.owner === "player");
    worker.x = cc.x; worker.y = cc.y;                     // on the drop-off, so one tick deposits
    worker.cargo = { com: "ore", qty: 10 };
    worker.order = { type: "gather", nodeId: firstNode(state, "ore").id, phase: "toDrop" };
    const before = state.players.player.resources.ore;
    updateGather(state, worker, 0.05);
    return state.players.player.resources.ore - before;
  };
  const base = bank(false), boosted = bank(true);
  assert.ok(Math.abs(boosted - base * 1.25) < 1e-6, `+25% yield: ${boosted} vs ${base}`);
});
