// @ts-check
/* ============================================================
   WORKER LOGISTICS (Odyssey) — the muscle behind finite storage.

   Buildings buffer goods locally (engine/entities.js store/input) and workers move
   them. Three jobs:

   - HAUL: a one-way run for a PURE producer (the Plasma Rig; the forward drop-offs) —
     buildings that only OUTPUT. The worker walks there, loads a cargo, and banks it into
     the treasury at the nearest Command Center.

   - SERVICE: a ROUND TRIP for a FACTORY — a building that both consumes inputs and
     produces output. In one loop the worker carries a needed INPUT from the treasury to
     the factory AND carries its finished OUTPUT back, so neither leg runs empty. Used
     both by auto-assignment and when the player manually assigns a worker to a building
     (`order.manual`, which makes it keep serving that one building instead of going idle).

   - FERRY: a worker manually assigned to a specific landed FREIGHTER (right-click it,
     like a building — engine/commands.js issueFerryFreighter). It carries a nearby
     producer's backlog straight onto the ship's hold — a freighter parked out at a
     remote claim becomes its own COLLECTION POINT, without every load detouring through
     the Command Center — and, once there's nothing left to load, carries some of the
     ship's hold back to the treasury instead. Any landed freighter qualifies; no
     research needed — this is a worker loading a crate onto a ship, not the ship acting
     on its own (that's the separate AI-logistics mode below).

   A freighter can ALSO be folded into the SAME auto-assigned HAUL/SERVICE chain a worker
   runs — "Autonomous Freight AI" (engine/techtree.js FREIGHTER_AI_TECH) lets the player
   toggle `unit.aiLogistics` on a hauler/heavy hauler/bulk freighter (engine/sim.js), at
   which point it grabs haul/service jobs on its own just like an idle worker, but at its
   own (far larger) cargo capacity — see `tripCapacity`. Running autonomously burns AI
   Cores from the treasury every tick (`payAIUpkeep`, called from sim.js): out of stock
   just pauses it in place for the tick, nothing lost, rather than stranding its cargo.

   Deterministic and DOM-free: nearest-target picks are distance-then-id, the per-tick
   job tallies are frozen before assignment, no wall clock or unseeded randomness. Player-
   only — the AI builds no producers/factories/freighters, so its replay is byte-identical.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, storeTotal, storeCapOf, inputRoom, freightUsed, freightRoom } from "./entities.js";
import { nearestCommandCenter } from "./gather.js";
import { recipeOf } from "./industry.js";

const REACH = 30;                 // how close a worker must get to load/unload (matches gather.js DROP_REACH)
const MAX_HAULERS = 2;            // workers auto-assigned to haul from one pure producer
const MAX_SERVERS = 2;            // …and to service one factory, so labour spreads
const ASSIGN_FRACTION = 0.34;     // act once an output buffer is this full — wait for a worthwhile backlog
const SUPPLY_BATCHES = 12;        // keep a factory topped up to ~this many batches of each input

// The research node (engine/techtree.js TECHS) that unlocks a freighter's AI-logistics mode.
// Referenced by id here (not imported from techtree.js) to keep haul.js/sim.js free of a
// dependency on the tech tree — a plain flag on player.upgrades either way.
export const FREIGHTER_AI_TECH = "freighterai";

// AI Cores burned per second by an AUTONOMOUS freighter (aiLogistics on), scaled by its own
// cargoHold — a bigger hold is a bigger crew/compute footprint to run unmanned. At this rate a
// Hauler (250) costs ~0.1/s, a Heavy Hauler (650) ~0.26/s, a Bulk Freighter (1600) ~0.64/s: a real,
// tunable tax on the same scarce strategic good the AI Foundry cultivates, not a token cost.
const AI_UPKEEP_PER_CAPACITY_PER_SEC = 1 / 2500;

/** AI Cores/sec an autonomous freighter burns while actively working a haul/service job. */
export function aiUpkeepRate(unit) {
  return (UNITS[unit.type]?.cargoHold || 0) * AI_UPKEEP_PER_CAPACITY_PER_SEC;
}

/**
 * Charge this tick's AI-Cores upkeep for an autonomous freighter's job, clamped to what's in
 * stock. Returns false (and charges nothing) when the treasury can't cover it — the caller then
 * just pauses the unit in place for the tick instead of advancing its order.
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function payAIUpkeep(state, unit, dt) {
  const cost = aiUpkeepRate(unit) * dt;
  if (cost <= 0) return true;
  const res = state.players[unit.owner].resources;
  if ((res.ai || 0) < cost) return false;
  res.ai -= cost;
  return true;
}

// A worker's single-trip capacity is its own UNITS[type].cargoCap. A freighter has no cargoCap of
// its own (its normal role carries a multi-commodity `freight` hold instead, engine/galaxy.js) —
// folded into the haul/service/ferry chain, it reuses its whole cargoHold as this trip's
// SINGLE-commodity size, so "larger capacity" falls out of the same def field its freight panel
// already shows, no duplicated number to keep in sync.
function tripCapacity(def) { return def.cargoCap ?? def.cargoHold ?? 0; }

/**
 * Tally, per building, how many workers are hauling from it (`haulers`) or servicing it
 * (`servers`) — the caps ASSIGN reads. Frozen at tick start (before any assignment) so every idle
 * worker this tick sees the same counts regardless of Map order. Transient (stripped on serialize).
 * @param {State} state
 */
export function countLogistics(state) {
  for (const b of state.buildings.values()) {
    if (storeCapOf(b.type) > 0) b.haulers = 0;
    if (recipeOf(b)) b.servers = 0;
  }
  for (const u of state.units.values()) {
    const o = u.order;
    if (!o || !o.buildingId) continue;
    const b = state.buildings.get(o.buildingId);
    if (!b) continue;
    if (o.type === "haul") b.haulers = (b.haulers || 0) + 1;
    else if (o.type === "service") b.servers = (b.servers || 0) + 1;
    // A FERRY worker's "toSource" leg draws on the same producer backlog auto-haulers do (and
    // clears its buildingId once it moves past that leg — see updateFerry), so it counts against
    // the SAME per-producer hauler cap, keeping the ≤MAX_HAULERS rule fair across both job types.
    else if (o.type === "ferry") b.haulers = (b.haulers || 0) + 1;
  }
}

const reached = (unit, b) => Math.hypot(b.x - unit.x, b.y - unit.y) <= REACH;

// Deposit a worker's cargo into a freighter's hold, clamped to its remaining room — whatever
// doesn't fit stays aboard the worker for the next leg (updateFerry re-plans from there). Mirrors
// bankCargo's shape but targets a finite ship's hold instead of the bottomless treasury.
/** @param {Unit} f @param {Unit} unit */
function depositToFreighter(f, unit) {
  if (!unit.cargo || unit.cargo.qty <= 0) return;
  const move = Math.min(unit.cargo.qty, freightRoom(f));
  if (move <= 0) return;
  f.freight[unit.cargo.com] = (f.freight[unit.cargo.com] || 0) + move;
  unit.cargo.qty -= move;
  if (unit.cargo.qty <= 1e-9) { unit.cargo.qty = 0; unit.cargo.com = null; }
}

// Load one commodity from a commodity->qty STORE (a building's output buffer, or a freighter's
// freight hold) into the worker's cargo (single-commodity, like a gatherer's). Drains the biggest
// pile first, deterministic tiebreak by name.
/** @param {Object.<string, number>} store @param {Unit} unit @param {number} cargoCap @returns {boolean} loaded anything */
function loadFrom(store, unit, cargoCap) {
  const s = store || {};
  let com = null, most = 0;
  for (const c of Object.keys(s).sort()) if ((s[c] || 0) > most) { most = s[c]; com = c; }
  if (!com || most <= 0 || !unit.cargo) return false;
  if (unit.cargo.com && unit.cargo.com !== com && unit.cargo.qty > 0) return false;   // don't mix loads
  const take = Math.min(cargoCap - (unit.cargo.qty || 0), s[com]);
  if (take <= 0) return false;
  unit.cargo.com = com;
  unit.cargo.qty = (unit.cargo.qty || 0) + take;
  s[com] -= take;
  if (s[com] <= 1e-9) delete s[com];
  return true;
}

// The input commodity a factory most needs and the treasury can supply: the one with the fewest
// batches buffered (below the top-up target) that the owner has in stock. Null when it's well-stocked
// on everything the treasury could bring. Deterministic (recipe key order is stable).
function neededInput(building, recipe, res) {
  let want = null, fewest = Infinity;
  for (const com in recipe.in) {
    if (com === "energy") continue;
    if ((res[com] || 0) <= 0) continue;
    const batches = (building.input?.[com] || 0) / recipe.in[com];
    if (batches >= SUPPLY_BATCHES) continue;
    if (batches < fewest) { fewest = batches; want = com; }
  }
  return want;
}

// The nearest own PURE producer (an output buffer, no recipe: the Plasma Rig, the forward
// drop-offs) whose buffer is at least `minFraction` full and isn't already served by MAX_HAULERS —
// shared by assignHaul's auto-assignment (minFraction defaults to ASSIGN_FRACTION: don't pull a
// fresh worker off other work for a trivial backlog) and a FERRY worker's "plan" phase (which
// passes 0: a worker already dedicated to a freighter, with nothing else to do, should pick up
// ANY backlog rather than abandon a producer the moment its buffer dips under the "worth starting"
// bar). Deterministic: nearest by distance, ties broken by id.
/** @param {State} state @param {string} owner @param {number} x @param {number} y @param {number} [minFraction] @returns {Building|null} */
function nearestBacklogProducer(state, owner, x, y, minFraction = ASSIGN_FRACTION) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || recipeOf(b)) continue;   // factories are serviced, not hauled
    const cap = storeCapOf(b.type);
    if (cap <= 0 || storeTotal(b) < cap * minFraction) continue;
    if ((b.haulers || 0) >= MAX_HAULERS) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
  }
  return best;
}

/**
 * Give an idle worker (or an autonomous freighter, see FREIGHTER_AI_TECH) a HAUL job on the
 * nearest backed-up producer. Claims a slot for the tick.
 * @param {State} state @param {Unit} unit
 */
export function assignHaul(state, unit) {
  const best = nearestBacklogProducer(state, unit.owner, unit.x, unit.y);
  if (!best) return;
  best.haulers = (best.haulers || 0) + 1;
  unit.order = { type: "haul", buildingId: best.id, phase: "toSource" };
}

/**
 * Give an idle worker a SERVICE round trip on the nearest own factory that needs feeding (an input
 * low & in the treasury) OR clearing (an output backlog), and isn't already served by MAX_SERVERS.
 * @param {State} state @param {Unit} unit
 */
export function assignService(state, unit) {
  const res = state.players[unit.owner].resources;
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== unit.owner || b.constructing) continue;
    const recipe = recipeOf(b);
    if (!recipe || (b.servers || 0) >= MAX_SERVERS) continue;
    const needsIn = inputRoom(b) > 0 && neededInput(b, recipe, res);
    const needsOut = storeTotal(b) >= storeCapOf(b.type) * ASSIGN_FRACTION;
    if (!needsIn && !needsOut) continue;
    const d = Math.hypot(b.x - unit.x, b.y - unit.y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
  }
  if (!best) return;
  best.servers = (best.servers || 0) + 1;
  unit.order = { type: "service", buildingId: best.id, phase: "plan" };
}

/**
 * Advance a HAUL job: walk to the producer → load a cargo → carry it to the nearest Command Center →
 * bank it into the treasury (1:1 — the goods were already extracted). Repeats while the producer has
 * a backlog, else idle. Salvages gracefully if the producer is razed or there's no CC to deliver to.
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateHaul(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  if (!order.phase) order.phase = "toSource";
  const src = order.buildingId ? state.buildings.get(order.buildingId) : null;

  if (order.phase === "toSource") {
    if (!src || src.constructing || storeTotal(src) <= 0) { unit.order = null; return; }
    if (reached(unit, src)) order.phase = "loading";
    else stepToward(state, unit, src.x, src.y, def.speed, dt);
    return;
  }
  if (order.phase === "loading") {
    if (!src) { unit.order = null; return; }
    loadFrom(src.store, unit, tripCapacity(def));
    order.phase = "toDrop";
    if (!unit.cargo || unit.cargo.qty <= 0) unit.order = null;
    return;
  }
  if (order.phase === "toDrop") {
    const cc = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!cc) { unit.order = null; return; }
    if (reached(unit, cc)) {
      bankCargo(state, unit);
      order.phase = (src && !src.constructing && storeTotal(src) > 0) ? "toSource" : null;
      if (!order.phase) unit.order = null;
    } else stepToward(state, unit, cc.x, cc.y, def.speed, dt);
  }
}

// Bank a worker's whole cargo into the owner's treasury (1:1) and empty it.
function bankCargo(state, unit) {
  if (!unit.cargo || unit.cargo.qty <= 0) return;
  const res = state.players[unit.owner].resources;
  res[unit.cargo.com] = (res[unit.cargo.com] || 0) + unit.cargo.qty;
  unit.cargo.qty = 0;
  unit.cargo.com = null;
}

/**
 * Advance a SERVICE round trip on a factory: fetch a needed INPUT from the treasury, carry it in,
 * drop it, pick up the finished OUTPUT, carry it back to the treasury — then loop (a manually-assigned
 * worker keeps serving its building; an auto-assigned one goes idle and may be re-tasked). Each leg
 * that would run empty is skipped: with no input needed it goes straight for the output; with no
 * output it just delivers the input. Salvages a razed target by banking whatever it carries.
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateService(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  const b = order.buildingId ? state.buildings.get(order.buildingId) : null;
  const res = state.players[unit.owner].resources;

  if (!b || b.constructing) {                       // target gone → return anything carried, then drop the job
    if (unit.cargo && unit.cargo.qty > 0) { order.phase = "toReturn"; order.buildingId = null; }
    else { unit.order = null; return; }
  }
  if (!order.phase) order.phase = "plan";
  const recipe = b ? recipeOf(b) : null;

  if (order.phase === "plan") {
    if (unit.cargo && unit.cargo.qty > 0) {                                    // finish whatever's aboard first
      const isInput = recipe && recipe.in[unit.cargo.com] && inputRoom(b) > 0;
      order.phase = isInput ? "toBuilding" : "toReturn";
      return;
    }
    const wantIn = recipe ? neededInput(b, recipe, res) : null;
    if (wantIn) { order.com = wantIn; order.phase = "toCC"; return; }          // fetch an input
    if (b && storeTotal(b) > 0) { order.phase = "toBuilding"; return; }        // just clear the output
    if (order.manual && b) { parkNear(state, unit, b, def, dt); return; }      // assigned & nothing to do → wait by it
    unit.order = null;
    return;
  }

  if (order.phase === "toCC") {                                                // load an input at the treasury
    const cc = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!cc) { unit.order = null; return; }
    if (reached(unit, cc)) {
      const want = Math.min(tripCapacity(def), res[order.com] || 0, inputRoom(b));
      if (want > 0) { res[order.com] -= want; unit.cargo.com = order.com; unit.cargo.qty = want; order.phase = "toBuilding"; }
      else order.phase = "plan";                                              // treasury dried up → re-plan
    } else stepToward(state, unit, cc.x, cc.y, def.speed, dt);
    return;
  }

  if (order.phase === "toBuilding") {                                          // deliver input, grab output for the return
    if (reached(unit, b)) {
      if (unit.cargo && unit.cargo.qty > 0 && recipe && recipe.in[unit.cargo.com]) {
        const give = Math.min(unit.cargo.qty, inputRoom(b));
        if (give > 0) { b.input = b.input || {}; b.input[unit.cargo.com] = (b.input[unit.cargo.com] || 0) + give; unit.cargo.qty -= give; }
        if (unit.cargo.qty <= 1e-9) { unit.cargo.qty = 0; unit.cargo.com = null; }
      }
      if (!unit.cargo || unit.cargo.qty <= 0) loadFrom(b.store, unit, tripCapacity(def));  // pick up the finished goods
      order.phase = (unit.cargo && unit.cargo.qty > 0) ? "toReturn" : endOrLoop(order);
      if (order.phase === null) unit.order = null;
    } else stepToward(state, unit, b.x, b.y, def.speed, dt);
    return;
  }

  if (order.phase === "toReturn") {                                            // bank the output at the treasury
    const cc = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!cc) { unit.order = null; return; }
    if (reached(unit, cc)) {
      bankCargo(state, unit);
      order.phase = endOrLoop(order);
      if (order.phase === null) unit.order = null;
    } else stepToward(state, unit, cc.x, cc.y, def.speed, dt);
  }
}

// A manually-assigned worker loops (re-plans) forever; an auto one finishes its cycle and idles.
function endOrLoop(order) { return order.manual && order.buildingId ? "plan" : null; }

// Hover by an assigned building while there's nothing to move, so the worker is on hand the moment
// it needs feeding or clearing (instead of wandering back to the base).
function parkNear(state, unit, b, def, dt) {
  if (Math.hypot(b.x - unit.x, b.y - unit.y) > REACH + b.radius) stepToward(state, unit, b.x, b.y, def.speed, dt);
}

/**
 * Advance a FERRY job: a worker manually assigned to a specific landed freighter
 * (engine/commands.js issueFerryFreighter). While the freighter has room, it keeps ferrying the
 * nearest own producer's backlog straight onto its hold (the freighter IS the collection point —
 * no CC detour); once there's nothing left to load, it instead draws some of the freighter's hold
 * and carries it home to the treasury. Loops forever like a manually-assigned SERVICE job — only
 * re-ordering the worker elsewhere ends it. Salvages gracefully if the freighter jumps away/dies
 * (carries home whatever's already aboard) or the CC is gone.
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateFerry(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  let f = order.freighterId ? state.units.get(order.freighterId) : null;
  if (f && (f.owner !== unit.owner || !UNITS[f.type]?.cargoHold)) f = null;

  if (!f) {                                          // target gone/jumped away → salvage, then drop the job
    if (unit.cargo && unit.cargo.qty > 0) { order.phase = "toReturn"; order.freighterId = null; }
    else { unit.order = null; return; }
  }
  if (!order.phase) order.phase = "plan";

  if (order.phase === "plan") {
    if (unit.cargo && unit.cargo.qty > 0) {                              // finish whatever's aboard first
      order.phase = (f && freightRoom(f) > 0) ? "toFreighter" : "toReturn";
      return;
    }
    if (f && freightRoom(f) > 0) {
      const src = nearestBacklogProducer(state, unit.owner, unit.x, unit.y, 0);
      if (src) { src.haulers = (src.haulers || 0) + 1; order.buildingId = src.id; order.phase = "toSource"; return; }
    }
    if (f && freightUsed(f) > 0) { order.phase = "toPickup"; return; }    // nothing to load → bring some cargo home instead
    if (f) {                                                              // nothing to do → wait by the ship
      const fr = UNITS[f.type]?.radius || 0;
      if (Math.hypot(f.x - unit.x, f.y - unit.y) > REACH + fr) stepToward(state, unit, f.x, f.y, def.speed, dt);
    }
    return;
  }

  if (order.phase === "toSource") {                                       // walk to the producer, load a cargo
    const src = order.buildingId ? state.buildings.get(order.buildingId) : null;
    if (!src || src.constructing || storeTotal(src) <= 0) { order.buildingId = null; order.phase = "plan"; return; }
    if (reached(unit, src)) {
      loadFrom(src.store, unit, tripCapacity(def));
      order.buildingId = null;
      order.phase = (unit.cargo && unit.cargo.qty > 0) ? "toFreighter" : "plan";
    } else stepToward(state, unit, src.x, src.y, def.speed, dt);
    return;
  }

  if (order.phase === "toFreighter") {                                    // deliver the load into the freighter's hold
    if (!f) { order.phase = "plan"; return; }
    if (reached(unit, f)) { depositToFreighter(f, unit); order.phase = "plan"; }
    else stepToward(state, unit, f.x, f.y, def.speed, dt);
    return;
  }

  if (order.phase === "toPickup") {                                       // draw some of the freighter's hold
    if (!f) { order.phase = "plan"; return; }
    if (reached(unit, f)) {
      loadFrom(f.freight, unit, tripCapacity(def));
      order.phase = (unit.cargo && unit.cargo.qty > 0) ? "toReturn" : "plan";
    } else stepToward(state, unit, f.x, f.y, def.speed, dt);
    return;
  }

  if (order.phase === "toReturn") {                                       // bank it at the treasury
    const cc = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!cc) { unit.order = null; return; }
    if (reached(unit, cc)) {
      bankCargo(state, unit);
      order.phase = "plan";
    } else stepToward(state, unit, cc.x, cc.y, def.speed, dt);
  }
}
