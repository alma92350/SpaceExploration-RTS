// @ts-check
/* ============================================================
   WORKER HAULAGE (Odyssey logistics) — the muscle behind finite storage.

   A producing building (the Plasma Rig; factories in a later phase) banks its
   output into a FINITE local buffer (building.store, capped at def.storeCap). Those
   goods aren't spendable until they reach a Command Center — so an idle worker offers
   itself as a HAULER: it walks to a backed-up producer, loads a cargo of its output,
   carries it to the nearest drop-off, and banks it into the treasury. Run out of
   haulers and a producer's buffer fills and stalls it — logistics is now a live, to-
   the-end-of-the-game demand on labour, exactly as intended.

   Deterministic and DOM-free like the rest of the engine: nearest-target picks are
   distance-then-id, the per-tick hauler tally is frozen before assignment, and no
   wall clock or unseeded randomness is touched. Player-only in this phase — the AI
   builds no producers, so its workers never haul and its replay is byte-identical.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, storeTotal, storeCapOf, inputRoom, inputCapOf } from "./entities.js";
import { nearestCommandCenter } from "./gather.js";
import { recipeOf } from "./industry.js";

const SOURCE_REACH = 30;          // how close a hauler must get to a producer to load
const DROP_REACH = 30;            // …and to a drop-off to bank (matches gather.js)
const MAX_HAULERS = 2;            // workers auto-assigned to haul from one producer
const MAX_SUPPLIERS = 2;          // …and to supply one factory, so labour spreads
const ASSIGN_FRACTION = 0.34;     // haul once a producer's buffer is this full — wait for a worthwhile backlog
const SUPPLY_BATCHES = 12;        // keep a factory topped up to ~this many batches of each input

/**
 * Tally, per producing/consuming building, how many workers are currently hauling from it
 * (`haulers`) or supplying it (`suppliers`) — the caps ASSIGN reads. Frozen at tick start
 * (before any assignment) so every idle worker this tick sees the same counts regardless of
 * Map order. Only buildings with a buffer are touched; the fields are transient (stripped on
 * serialize, like a unit's grid index).
 * @param {State} state
 */
export function countLogistics(state) {
  for (const b of state.buildings.values()) {
    if (storeCapOf(b.type) > 0) b.haulers = 0;
    if (inputCapOf(b.type) > 0) b.suppliers = 0;
  }
  for (const u of state.units.values()) {
    const o = u.order;
    if (!o || !o.buildingId) continue;
    const b = state.buildings.get(o.buildingId);
    if (!b) continue;
    if (o.type === "haul") b.haulers = (b.haulers || 0) + 1;
    else if (o.type === "supply") b.suppliers = (b.suppliers || 0) + 1;
  }
}

/**
 * Give an idle worker a haul job if a producer needs one: the nearest own producer
 * whose buffer is at least ASSIGN_FRACTION full and isn't already served by MAX_HAULERS.
 * Claims a hauler slot immediately (so two idle workers this tick don't both pile onto
 * the same producer). No-op when nothing qualifies — including all of skirmish, where no
 * building has an output buffer. Deterministic: nearest by distance, ties broken by id.
 * @param {State} state @param {Unit} unit
 */
export function assignHaul(state, unit) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== unit.owner || b.constructing) continue;
    const cap = storeCapOf(b.type);
    if (cap <= 0) continue;
    if (storeTotal(b) < cap * ASSIGN_FRACTION) continue;   // not enough piled up to be worth a trip
    if ((b.haulers || 0) >= MAX_HAULERS) continue;         // already covered
    const d = Math.hypot(b.x - unit.x, b.y - unit.y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; }
  }
  if (!best) return;
  best.haulers = (best.haulers || 0) + 1;   // claim the slot for this tick
  unit.order = { type: "haul", buildingId: best.id, phase: "toSource" };
}

// Load one commodity from a producer's buffer into the worker's cargo (single-commodity,
// like a gatherer's). Drains the biggest pile first, deterministic tiebreak by name.
/** @param {Building} src @param {Unit} unit @param {number} cargoCap @returns {boolean} loaded anything */
function loadFrom(src, unit, cargoCap) {
  const s = src.store || {};
  let com = null, most = 0;
  for (const c of Object.keys(s).sort()) if ((s[c] || 0) > most) { most = s[c]; com = c; }
  if (!com || most <= 0) return false;
  if (!unit.cargo) return false;
  if (unit.cargo.com && unit.cargo.com !== com && unit.cargo.qty > 0) return false;   // don't mix loads
  const take = Math.min(cargoCap - (unit.cargo.qty || 0), s[com]);
  if (take <= 0) return false;
  unit.cargo.com = com;
  unit.cargo.qty = (unit.cargo.qty || 0) + take;
  s[com] -= take;
  if (s[com] <= 1e-9) delete s[com];
  return true;
}

/**
 * Advance one worker's haul job by dt: walk to the producer → load a cargo → walk to the
 * nearest drop-off → bank it into the treasury (1:1 — the goods were already extracted, so
 * no gather multiplier). Repeats from the same producer while it still has a backlog, else
 * goes idle (auto-assign may re-task it next tick). Salvages gracefully if the producer is
 * razed mid-run or there's nowhere to deliver.
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateHaul(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  if (!order.phase) order.phase = "toSource";
  const src = order.buildingId ? state.buildings.get(order.buildingId) : null;

  if (order.phase === "toSource") {
    if (!src || src.constructing || storeTotal(src) <= 0) { unit.order = null; return; }   // nothing to haul
    const dist = Math.hypot(src.x - unit.x, src.y - unit.y);
    if (dist <= SOURCE_REACH) order.phase = "loading";
    else stepToward(state, unit, src.x, src.y, def.speed, dt);
    return;
  }

  if (order.phase === "loading") {
    if (!src) { unit.order = null; return; }
    loadFrom(src, unit, def.cargoCap);
    order.phase = "toDrop";
    if (!unit.cargo || unit.cargo.qty <= 0) unit.order = null;   // drained before we loaded → idle
    return;
  }

  if (order.phase === "toDrop") {
    const drop = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!drop) { unit.order = null; return; }   // no Command Center to deliver to — hold the load, drop the job
    const dist = Math.hypot(drop.x - unit.x, drop.y - unit.y);
    if (dist <= DROP_REACH) {
      const player = state.players[unit.owner];
      player.resources[unit.cargo.com] = (player.resources[unit.cargo.com] || 0) + unit.cargo.qty;
      unit.cargo.qty = 0;
      unit.cargo.com = null;
      // Still more piled up at the same producer? Fetch the next load; otherwise go idle.
      order.phase = (src && !src.constructing && storeTotal(src) > 0) ? "toSource" : null;
      if (!order.phase) unit.order = null;
    } else {
      stepToward(state, unit, drop.x, drop.y, def.speed, dt);
    }
  }
}

// The input commodity a factory most needs and the treasury can supply: the one with the
// fewest batches buffered (below the top-up target) that the owner actually has in stock.
// Null when the factory is well-stocked on everything the treasury could bring. Deterministic
// (recipe key order is stable; ties resolve to the first such key).
function neededInput(building, recipe, res) {
  let want = null, fewest = Infinity;
  for (const com in recipe.in) {
    if (com === "energy") continue;
    if ((res[com] || 0) <= 0) continue;                       // treasury can't supply it
    const batches = (building.input?.[com] || 0) / recipe.in[com];
    if (batches >= SUPPLY_BATCHES) continue;                  // already well-stocked
    if (batches < fewest) { fewest = batches; want = com; }
  }
  return want;
}

/**
 * Give an idle worker a supply job if a factory needs feeding: the nearest own factory with
 * input-buffer room, fewer than MAX_SUPPLIERS already on it, and a needed input the treasury
 * can provide. Claims a supplier slot immediately so two idle workers don't both pile on. No-op
 * when nothing qualifies. Deterministic: nearest by distance, ties broken by id.
 * @param {State} state @param {Unit} unit
 */
export function assignSupply(state, unit) {
  const res = state.players[unit.owner].resources;
  let best = null, bestD = Infinity, bestCom = null;
  for (const b of state.buildings.values()) {
    if (b.owner !== unit.owner || b.constructing) continue;
    const recipe = recipeOf(b);
    if (!recipe) continue;
    if (inputRoom(b) <= 0) continue;                          // larder full
    if ((b.suppliers || 0) >= MAX_SUPPLIERS) continue;        // already covered
    const com = neededInput(b, recipe, res);
    if (!com) continue;
    const d = Math.hypot(b.x - unit.x, b.y - unit.y);
    if (d < bestD || (d === bestD && best && b.id < best.id)) { bestD = d; best = b; bestCom = com; }
  }
  if (!best) return;
  best.suppliers = (best.suppliers || 0) + 1;   // claim the slot for this tick
  unit.order = { type: "supply", buildingId: best.id, com: bestCom, phase: "toSource" };
}

/**
 * Advance one worker's supply job by dt: walk to the nearest drop-off (the treasury/warehouse) →
 * load the needed input → walk to the factory → top up its input buffer. Clamps the pickup to what
 * will fit, so it rarely over-carries; drops the job cleanly if the factory is razed or the treasury
 * runs dry mid-run.
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateSupply(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  if (!order.phase) order.phase = "toSource";
  const factory = order.buildingId ? state.buildings.get(order.buildingId) : null;
  if (!factory || factory.constructing) {                    // target gone → drop the job (any in-transit load is lost with it)
    if (unit.cargo) { unit.cargo.qty = 0; unit.cargo.com = null; }
    unit.order = null;
    return;
  }

  if (order.phase === "toSource") {
    const res = state.players[unit.owner].resources;
    const carrying = unit.cargo && unit.cargo.qty > 0;
    if (!carrying && (res[order.com] || 0) <= 0) { unit.order = null; return; }   // treasury dry, nothing loaded
    const drop = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!drop) { unit.order = null; return; }
    const dist = Math.hypot(drop.x - unit.x, drop.y - unit.y);
    if (dist <= DROP_REACH) {
      const want = Math.min(def.cargoCap - (unit.cargo.qty || 0), res[order.com] || 0, inputRoom(factory));
      if (want > 0) {
        res[order.com] -= want;
        unit.cargo.com = order.com;
        unit.cargo.qty = (unit.cargo.qty || 0) + want;
      }
      order.phase = "toFactory";
      if (!unit.cargo || unit.cargo.qty <= 0) unit.order = null;   // couldn't load a thing → idle
    } else {
      stepToward(state, unit, drop.x, drop.y, def.speed, dt);
    }
    return;
  }

  if (order.phase === "toFactory") {
    const dist = Math.hypot(factory.x - unit.x, factory.y - unit.y);
    if (dist <= SOURCE_REACH) {
      const give = Math.min(unit.cargo.qty, inputRoom(factory));
      if (give > 0) {
        factory.input = factory.input || {};
        factory.input[unit.cargo.com] = (factory.input[unit.cargo.com] || 0) + give;
        unit.cargo.qty -= give;
      }
      if (unit.cargo.qty <= 1e-9) { unit.cargo.qty = 0; unit.cargo.com = null; }   // any leftover (buffer filled meanwhile) rides on; auto-assign re-tasks it
      unit.order = null;
    } else {
      stepToward(state, unit, factory.x, factory.y, def.speed, dt);
    }
  }
}
