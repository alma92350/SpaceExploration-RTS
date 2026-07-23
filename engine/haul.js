// @ts-check
/* ============================================================
   WORKER LOGISTICS (Odyssey) — the muscle behind finite storage.

   Buildings buffer goods locally (engine/entities.js store/input) and workers move
   them. Two jobs:

   - HAUL: a one-way run for a PURE producer (the Plasma Rig; the forward drop-offs) —
     buildings that only OUTPUT. The worker walks there, loads a cargo, and banks it into
     the treasury at the nearest Command Center.

   - SERVICE: a ROUND TRIP for a FACTORY — a building that both consumes inputs and
     produces output. In one loop the worker carries a needed INPUT from the treasury to
     the factory AND carries its finished OUTPUT back, so neither leg runs empty. Used
     both by auto-assignment and when the player manually assigns a worker to a building
     (`order.manual`, which makes it keep serving that one building instead of going idle).

   Deterministic and DOM-free: nearest-target picks are distance-then-id, the per-tick
   job tallies are frozen before assignment, no wall clock or unseeded randomness. Player-
   only — the AI builds no producers/factories, so its replay is byte-identical.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, storeTotal, storeCapOf, inputRoom } from "./entities.js";
import { nearestCommandCenter } from "./gather.js";
import { recipeOf } from "./industry.js";

const REACH = 30;                 // how close a worker must get to load/unload (matches gather.js DROP_REACH)
const MAX_HAULERS = 2;            // workers auto-assigned to haul from one pure producer
const MAX_SERVERS = 2;            // …and to service one factory, so labour spreads
const ASSIGN_FRACTION = 0.34;     // act once an output buffer is this full — wait for a worthwhile backlog
const SUPPLY_BATCHES = 12;        // keep a factory topped up to ~this many batches of each input

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
  }
}

const reached = (unit, b) => Math.hypot(b.x - unit.x, b.y - unit.y) <= REACH;

// Load one commodity from a building's OUTPUT buffer into the worker's cargo (single-commodity, like
// a gatherer's). Drains the biggest pile first, deterministic tiebreak by name.
/** @param {Building} src @param {Unit} unit @param {number} cargoCap @returns {boolean} loaded anything */
function loadFrom(src, unit, cargoCap) {
  const s = src.store || {};
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

/**
 * Give an idle worker a HAUL job on a PURE producer (an output buffer, no recipe: the Plasma Rig,
 * the forward drop-offs) whose buffer is ≥ ASSIGN_FRACTION full and isn't already served by
 * MAX_HAULERS. Claims a slot for the tick. Deterministic: nearest by distance, ties broken by id.
 * @param {State} state @param {Unit} unit
 */
export function assignHaul(state, unit) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== unit.owner || b.constructing || recipeOf(b)) continue;   // factories are serviced, not hauled
    const cap = storeCapOf(b.type);
    if (cap <= 0 || storeTotal(b) < cap * ASSIGN_FRACTION) continue;
    if ((b.haulers || 0) >= MAX_HAULERS) continue;
    const d = Math.hypot(b.x - unit.x, b.y - unit.y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
  }
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
    loadFrom(src, unit, def.cargoCap);
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
      const want = Math.min(def.cargoCap, res[order.com] || 0, inputRoom(b));
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
      if (!unit.cargo || unit.cargo.qty <= 0) loadFrom(b, unit, def.cargoCap);  // pick up the finished goods
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
