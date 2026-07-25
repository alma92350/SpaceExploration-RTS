import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateFerry, updateHaul, countLogistics, assignHaul, FREIGHTER_AI_TECH, aiUpkeepRate, payAIUpkeep } from "../engine/haul.js";
import { issueFerryFreighter, issueSetAILogistics } from "../engine/commands.js";
import { storeTotal, freightUsed, freightRoom } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { mulberry32 } from "./_helpers.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

// A skirmish world seeds a finished Command Center + 3 workers, same fixture as test/haul.test.js.
function base(seed = 1) {
  const s = createGameState({ planetId: "ferros", rng: mulberry32(seed) });
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const workers = [...s.units.values()].filter(u => u.owner === "player" && u.type === "worker");
  return { s, cc, workers };
}
// A player Plasma Rig, pre-loaded with `store` and paused (don't dig — isolate the ferry/haul logic).
function plantRig(s, cc, store, dx = 50, dy = 0) {
  const rig = makeBuilding("plasmarig", "player", cc.x + dx, cc.y + dy);
  rig.store = { ...store };
  rig.paused = true;
  s.buildings.set(rig.id, rig);
  return rig;
}
function plantFreighter(s, type, x, y) {
  const f = makeUnit(type, "player", x, y);
  s.units.set(f.id, f);
  return f;
}
// Strip the seeded 3 idle workers so a freighter's own auto-logistics is the ONLY labour in
// play — otherwise a worker (also idle, also eligible) can beat the freighter to a nearby backlog
// and the test would stop proving what it claims to.
function removeSeededWorkers(s, workers) {
  for (const w of workers) s.units.delete(w.id);
}

// ---- FERRY: workers physically load/unload a landed freighter ------------------------------

test("a ferry worker carries a producer's backlog straight onto the assigned freighter's hold", () => {
  const { s, cc, workers } = base(1);
  const rig = plantRig(s, cc, { ore: 60 });
  const f = plantFreighter(s, "hauler", cc.x - 60, cc.y);
  const w = workers[0];
  w.x = f.x; w.y = f.y;
  w.order = { type: "ferry", freighterId: f.id, phase: "plan", manual: true };
  const oreBefore = s.players.player.resources.ore || 0;   // the skirmish seed starts with 300 ore

  // countLogistics resets/re-tallies the per-producer hauler cap each tick in the real sim loop
  // (engine/sim.js) — replicated here since this test drives updateFerry directly rather than
  // through tick(), and the "claim a slot for the tick" bump in the "plan" phase relies on that
  // periodic reset (otherwise repeat visits to the SAME producer across many calls would just keep
  // incrementing a count nothing ever brings back down).
  for (let i = 0; i < 8000 && (storeTotal(rig) > 0 || (w.cargo && w.cargo.qty > 0)); i++) { countLogistics(s); updateFerry(s, w, 0.05); }

  assert.equal(storeTotal(rig), 0, "the rig's whole buffer was carried away");
  assert.equal(freightUsed(f), 60, "…and all 60 landed on the freighter's hold");
  assert.equal(s.players.player.resources.ore || 0, oreBefore, "the treasury's own ore never moved — it went straight into the ship");
});

test("issueFerryFreighter assigns the order (workers only), and freightRoom bounds what fits", () => {
  const { s, workers } = base(2);
  const f = plantFreighter(s, "hauler", 0, 0);
  const ranger = makeUnit("ranger", "player", 0, 0);
  s.units.set(ranger.id, ranger);

  issueFerryFreighter([workers[0], ranger], f.id);

  assert.equal(workers[0].order.type, "ferry", "the worker is assigned");
  assert.equal(workers[0].order.freighterId, f.id);
  assert.equal(ranger.order, null, "a non-worker is ignored — ferrying is worker labour, not any unit's");
  assert.equal(freightRoom(f), 250, "an empty Hauler's room is its whole cargoHold");
});

test("with nothing left to load, a ferry worker instead drains the freighter's hold home", () => {
  const { s, cc, workers } = base(3);
  const f = plantFreighter(s, "hauler", cc.x + 60, cc.y);
  f.freight = { alloys: 40 };
  const w = workers[0];
  w.x = f.x; w.y = f.y;
  w.order = { type: "ferry", freighterId: f.id, phase: "plan", manual: true };

  for (let i = 0; i < 8000 && (freightUsed(f) > 0 || (w.cargo && w.cargo.qty > 0)); i++) updateFerry(s, w, 0.05);

  assert.equal(freightUsed(f), 0, "the hold was fully drawn down");
  assert.ok((s.players.player.resources.alloys || 0) >= 40 - 1e-6, "…and banked into the treasury");
});

test("a ferry job releases a razed/jumped-away freighter gracefully, salvaging any cargo aboard", () => {
  const { s, cc, workers } = base(4);
  const f = plantFreighter(s, "hauler", cc.x + 40, cc.y);
  const w = workers[0];
  w.x = f.x; w.y = f.y;
  w.cargo = { com: "ore", qty: 25 };
  w.order = { type: "ferry", freighterId: f.id, phase: "toFreighter", manual: true };

  s.units.delete(f.id);   // the freighter is gone (razed, or jumped to another world)
  for (let i = 0; i < 8000 && w.order; i++) updateFerry(s, w, 0.05);

  assert.equal(w.order, null, "the job ends once there's nothing left to carry");
  assert.ok((s.players.player.resources.ore || 0) >= 25 - 1e-6, "…but the cargo it was carrying still made it to the treasury");
});

test("a FERRY worker's producer visit counts against the same per-producer hauler cap as a HAUL worker", () => {
  const { s, cc } = base(5);
  const rig = plantRig(s, cc, { ore: 120 });   // a full buffer → maximum pull
  const f = plantFreighter(s, "hauler", cc.x - 80, cc.y);
  // Pile candidates for BOTH job types right on the rig, so every one is a candidate this tick.
  const haulers = [];
  for (let i = 0; i < 4; i++) {
    const w = makeUnit("worker", "player", rig.x, rig.y);
    s.units.set(w.id, w);
    haulers.push(w);
  }
  const ferriers = [];
  for (let i = 0; i < 4; i++) {
    const w = makeUnit("worker", "player", rig.x, rig.y);
    s.units.set(w.id, w);
    ferriers.push(w);
  }
  countLogistics(s);
  for (const w of haulers) assignHaul(s, w);
  for (const w of ferriers) { w.order = { type: "ferry", freighterId: f.id, phase: "plan", manual: true }; updateFerry(s, w, 0); }

  const onRig = [...s.units.values()].filter(u =>
    (u.order?.type === "haul" && u.order.buildingId === rig.id) ||
    (u.order?.type === "ferry" && u.order.buildingId === rig.id)).length;
  assert.ok(onRig <= 2, `at most 2 workers (of either job) draw from one producer at once (got ${onRig})`);
});

// ---- FREIGHTER AI-LOGISTICS: an autonomous freighter folded into the haul/service chain -----

test("the freighterai tech id matches FREIGHTER_AI_TECH and requires AI Cores + the aicores tech", () => {
  assert.ok(TECHS[FREIGHTER_AI_TECH], "the tech tree carries a node under the exact id haul.js references");
  assert.ok(TECHS[FREIGHTER_AI_TECH].cost.ai > 0, "researching it costs AI Cores — automation is built FROM the good it burns");
  assert.ok(TECHS[FREIGHTER_AI_TECH].requires.includes("aicores"), "gated behind having unlocked AI Cores production");
});

test("issueSetAILogistics won't switch a freighter on without the research, but always allows standing down", () => {
  const { s } = base(6);
  const f = plantFreighter(s, "hauler", 0, 0);

  issueSetAILogistics([f], true, s);
  assert.equal(!!f.aiLogistics, false, "no FREIGHTER_AI_TECH researched yet — the toggle is refused");

  s.players.player.upgrades[FREIGHTER_AI_TECH] = true;
  issueSetAILogistics([f], true, s);
  assert.equal(f.aiLogistics, true, "researched — now it can be switched on");
  assert.deepEqual(f.cargo, { com: null, qty: 0 }, "a single-slot cargo hold is created for the haul/service chain to use");

  issueSetAILogistics([f], false, s);
  assert.equal(f.aiLogistics, false, "standing down is never gated");
});

test("without aiLogistics toggled on, an idle freighter is never auto-assigned a haul/service job", () => {
  const { s, cc, workers } = base(7);
  removeSeededWorkers(s, workers);
  plantRig(s, cc, { ore: 100 });
  const f = plantFreighter(s, "hauler", cc.x + 45, cc.y);   // right next to the backed-up rig
  s.players.player.upgrades[FREIGHTER_AI_TECH] = true;   // researched, but never switched on

  for (let i = 0; i < 300; i++) tick(s, 0.1);

  assert.equal(f.order, null, "a plain freighter stays fully player-controlled");
});

test("an AI-logistics freighter auto-hauls a producer's backlog at its OWN (far larger) capacity, burning AI Cores while it works", () => {
  const { s, cc, workers } = base(8);
  removeSeededWorkers(s, workers);
  const rig = plantRig(s, cc, { ore: 100 });
  const f = plantFreighter(s, "hauler", cc.x + 45, cc.y);
  s.players.player.upgrades[FREIGHTER_AI_TECH] = true;
  issueSetAILogistics([f], true, s);
  s.players.player.resources.ai = 500;
  const aiBefore = s.players.player.resources.ai;
  const oreBefore = s.players.player.resources.ore || 0;   // the skirmish seed starts with 300 ore

  for (let i = 0; i < 1500; i++) tick(s, 0.1);

  assert.equal(storeTotal(rig), 0, "the freighter alone cleared the whole 100-ore buffer");
  assert.ok(near((s.players.player.resources.ore || 0) - oreBefore, 100, 1e-3), "…and banked it to the treasury, just like a worker's haul");
  assert.ok((s.players.player.resources.ai || 0) < aiBefore, "running autonomously burned AI Cores from the treasury");
});

test("a freighter's single-trip haul capacity is its own cargoHold — a 100-unit backlog moves in one load, not ten", () => {
  const { s, cc } = base(9);
  const rig = plantRig(s, cc, { ore: 100 });   // well under the Hauler's 250 hold
  const f = plantFreighter(s, "hauler", rig.x, rig.y);
  f.cargo = { com: null, qty: 0 };
  f.order = { type: "haul", buildingId: rig.id, phase: "toSource" };

  updateHaul(s, f, 0.05);   // "toSource": already reached → flips to "loading"
  updateHaul(s, f, 0.05);   // "loading": one load, capped by tripCapacity (its own cargoHold)

  assert.equal(f.cargo.qty, 100, "the WHOLE 100-ore backlog fit in a single load — a worker (cargoCap 10) would need ten trips");
  assert.equal(storeTotal(rig), 0, "…draining the rig's buffer in one visit");
});

test("toggling AI logistics off mid-job stands the freighter down immediately, without losing its cargo", () => {
  const { s, cc } = base(10);
  const f = plantFreighter(s, "hauler", cc.x, cc.y);
  s.players.player.upgrades[FREIGHTER_AI_TECH] = true;
  f.aiLogistics = true;
  f.cargo = { com: "ore", qty: 40 };
  f.order = { type: "haul", buildingId: null, phase: "toDrop", aiJob: true };

  f.aiLogistics = false;
  tick(s, 0.1);

  assert.equal(f.order, null, "the job is dropped the instant AI-logistics is switched off");
  assert.deepEqual(f.cargo, { com: "ore", qty: 40 }, "…but whatever it was carrying just sits aboard, nothing lost");
});

test("an autonomous freighter pauses in place (job + cargo intact) when the treasury runs dry of AI Cores, and resumes once resupplied", () => {
  const { s, cc, workers } = base(11);
  removeSeededWorkers(s, workers);
  const rig = plantRig(s, cc, { ore: 100 });
  const f = plantFreighter(s, "hauler", cc.x + 200, cc.y);   // far from the rig — several ticks of walking ahead
  s.players.player.upgrades[FREIGHTER_AI_TECH] = true;
  issueSetAILogistics([f], true, s);
  s.players.player.resources.ai = 0;   // dry from the start

  const x0 = f.x, y0 = f.y;
  for (let i = 0; i < 50; i++) tick(s, 0.1);
  assert.equal(f.x, x0, "no AI Cores in stock → it never even starts moving");
  assert.equal(f.y, y0);
  assert.equal(f.order, null, "…and never claims a job it can't afford to run, so nothing is stuck mid-plan");

  s.players.player.resources.ai = 500;   // resupplied
  for (let i = 0; i < 1500; i++) tick(s, 0.1);
  assert.equal(storeTotal(rig), 0, "now it goes to work and clears the backlog");
});

test("AI-logistics haulage is deterministic: two same-seed runs bank identical treasuries and spend identical AI Cores", () => {
  const run = () => {
    const { s, cc, workers } = base(12);
    removeSeededWorkers(s, workers);
    plantRig(s, cc, { ore: 90, crystals: 30 });
    const f = plantFreighter(s, "hauler", cc.x + 45, cc.y);
    s.players.player.upgrades[FREIGHTER_AI_TECH] = true;
    issueSetAILogistics([f], true, s);
    s.players.player.resources.ai = 500;
    for (let i = 0; i < 1500; i++) tick(s, 0.1);
    return {
      ore: s.players.player.resources.ore || 0,
      crystals: s.players.player.resources.crystals || 0,
      ai: s.players.player.resources.ai || 0,
    };
  };
  assert.deepEqual(run(), run());
});

test("a freighter's aiLogistics flag, an in-progress aiJob haul order, and a worker's ferry order all survive a save/load round-trip", () => {
  const { s, cc, workers } = base(14);
  const rig = plantRig(s, cc, { ore: 80 });
  const f = plantFreighter(s, "hauler", cc.x + 45, cc.y);
  s.players.player.upgrades[FREIGHTER_AI_TECH] = true;
  issueSetAILogistics([f], true, s);
  s.players.player.resources.ai = 500;

  const ferryTarget = plantFreighter(s, "heavyhauler", cc.x - 80, cc.y);
  const w = workers[1];
  removeSeededWorkers(s, [workers[0], workers[2]]);   // isolate: only the freighter and w compete for the rig
  issueFerryFreighter([w], ferryTarget.id);

  // Just ONE tick: rig and CC both sit within the freighter's own REACH of its start position, and
  // its 250-cargoHold trip capacity clears the whole 80-ore buffer in a single load — so it's
  // already mid-job (and would FINISH within a handful more ticks) rather than needing to travel.
  tick(s, 0.1);
  assert.equal(f.order?.aiJob, true, "sanity: the freighter is mid-job before we save");

  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(s))));
  const f2 = b.units.get(f.id), w2 = b.units.get(w.id);

  assert.equal(f2.aiLogistics, true, "the AI-logistics toggle survives");
  assert.equal(f2.order?.type, "haul", "…and its in-progress autonomous job survives");
  assert.equal(f2.order?.aiJob, true);
  assert.equal(w2.order?.type, "ferry", "the worker's ferry assignment survives too");
  assert.equal(w2.order?.freighterId, ferryTarget.id);

  // And the reloaded game keeps working exactly as before: the freighter finishes the haul it was
  // mid-way through when the save was taken.
  for (let i = 0; i < 1500; i++) tick(b, 0.1);
  assert.equal(storeTotal(b.buildings.get(rig.id)), 0, "the reloaded freighter completes the haul");
});

test("payAIUpkeep is a no-op (always succeeds) for a non-freighter unit — cargoHold-scaled, zero for anything without one", () => {
  const { s, workers } = base(13);
  const before = s.players.player.resources.ai || 0;
  assert.equal(payAIUpkeep(s, workers[0], 1), true, "a worker has no cargoHold, so its upkeep rate is zero");
  assert.equal(s.players.player.resources.ai || 0, before, "…and nothing was charged");
  assert.equal(aiUpkeepRate(workers[0]), 0);
  assert.ok(aiUpkeepRate({ type: "hauler" }) > 0, "a freighter's rate scales with its own cargoHold");
});
