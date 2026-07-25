// @ts-check
/* ============================================================
   WORKER LOGISTICS (Odyssey) — the muscle behind finite storage.

   Buildings buffer goods locally (engine/entities.js store/input) and workers move
   them. Three jobs:

   - HAUL: a one-way run for a PURE producer (the Plasma Rig; the forward drop-offs) —
     buildings that only OUTPUT. The worker walks there, loads a cargo, and carries it to
     whichever is nearer RIGHT NOW — its own Command Center, or a closer forward drop-off
     (Refinery/Foundry/Arsenal) — the same "closest drop point at the moment" pick a raw
     gatherer already makes (gather.js nearestGatherDrop), re-checked every tick of the
     walk so a nearer option that appears or frees up room mid-trip is taken immediately.

   - SERVICE: a ROUND TRIP for a FACTORY — a building that both consumes inputs and
     produces output. In one loop the worker carries a needed INPUT from the treasury to
     the factory AND carries its finished OUTPUT back, so neither leg runs empty. Used
     both by auto-assignment and when the player manually assigns a worker to a building
     (`order.manual`, which makes it keep serving that one building instead of going idle).

   - FERRY: a worker assigned to a specific landed FREIGHTER — manually (right-click it,
     like a building — engine/commands.js issueFerryFreighter) or, for a COLLECTION-POINT
     freighter, automatically (assignFerry, the same idle-worker offer haul/service get).
     It carries a nearby producer's backlog straight onto the ship's hold — a freighter
     parked out at a remote claim becomes its own COLLECTION POINT, without every load
     detouring through the Command Center. Any landed freighter qualifies for a MANUAL
     assignment; no research needed — this is a worker loading a crate onto a ship, not
     the ship acting on its own (that's the separate AI-logistics mode below).

   A freighter parked as a FERRY target can also be toggled into COLLECTION-POINT mode
   (`unit.collectPoint`, HUD button — no research needed, engine/commands.js
   issueSetCollectPoint): once its hold is full it drives itself to the nearest own
   Command Center, banks everything, and returns to its ANCHOR (the spot it was
   standing when the mode was switched on) to keep collecting — assignShuttle /
   updateFreighterShuttle below. That toggle changes TWO things about how workers treat
   it: idle workers now offer themselves to ferry it automatically (assignFerry), the
   same way they offer to haul a producer or service a factory — no right-click needed —
   and a ferry worker (manual or auto) never DRAINS a collection-point freighter to carry
   its cargo home itself (updateFerry's "toPickup" leg is skipped for one), since the
   ship's own shuttle run already owns that trip; a plain (non-collection-point) freighter
   still gets that pickup-and-carry-home leg from a MANUALLY-ferrying worker, same as
   before, since nothing else will ever empty it.

   A freighter can ALSO be folded into the SAME auto-assigned HAUL/SERVICE chain a worker
   runs — "Autonomous Freight AI" (engine/techtree.js FREIGHTER_AI_TECH) lets the player
   toggle `unit.aiLogistics` on a hauler/heavy hauler/bulk freighter (engine/sim.js), at
   which point it grabs haul/service jobs on its own just like an idle worker, but at its
   own (far larger) cargo capacity — see `tripCapacity`. Running autonomously burns AI
   Cores from the treasury every tick (`payAIUpkeep`, called from sim.js): out of stock
   just pauses it in place for the tick, nothing lost, rather than stranding its cargo.
   Unlike collectPoint, this is research-gated and folds the freighter into the WHOLE
   base's logistics, not just its own hold — the two toggles are independent.

   Deterministic and DOM-free: nearest-target picks are distance-then-id, the per-tick
   job tallies are frozen before assignment, no wall clock or unseeded randomness. Player-
   only — the AI builds no producers/factories/freighters, so its replay is byte-identical.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, BUILDINGS, storeTotal, storeCapOf, storeRoom, inputRoom, freightUsed, freightRoom } from "./entities.js";
import { nearestCommandCenter, nearestGatherDrop } from "./gather.js";
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
 * (`servers`) — and, per FREIGHTER, how many workers are ferrying it (`ferriers`, manual or
 * auto-assigned alike) — the caps ASSIGN reads. Frozen at tick start (before any assignment) so
 * every idle worker this tick sees the same counts regardless of Map order. Transient (stripped
 * on serialize).
 * @param {State} state
 */
export function countLogistics(state) {
  for (const b of state.buildings.values()) {
    if (storeCapOf(b.type) > 0) b.haulers = 0;
    if (recipeOf(b)) b.servers = 0;
  }
  for (const u of state.units.values()) {
    if (UNITS[u.type]?.cargoHold) u.ferriers = 0;
  }
  for (const u of state.units.values()) {
    const o = u.order;
    if (!o) continue;
    if (o.buildingId) {
      const b = state.buildings.get(o.buildingId);
      if (b) {
        if (o.type === "haul") b.haulers = (b.haulers || 0) + 1;
        else if (o.type === "service") b.servers = (b.servers || 0) + 1;
        // A FERRY worker's "toSource" leg draws on the same producer backlog auto-haulers do (and
        // clears its buildingId once it moves past that leg — see updateFerry), so it counts against
        // the SAME per-producer hauler cap, keeping the ≤MAX_HAULERS rule fair across both job types.
        else if (o.type === "ferry") b.haulers = (b.haulers || 0) + 1;
      }
    }
    if (o.type === "ferry" && o.freighterId) {
      const f = state.units.get(o.freighterId);
      if (f) f.ferriers = (f.ferriers || 0) + 1;
    }
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
    const total = storeTotal(b);
    if (cap <= 0 || total <= 0 || total < cap * minFraction) continue;   // total<=0: a minFraction of 0 must still require SOME backlog
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
 * Give an idle worker a FERRY job on the nearest own COLLECTION-POINT freighter (`unit.collectPoint`
 * — a plain freighter is never auto-assigned, only ever ferried by hand) that has room AND sits
 * near a backlog actually worth fetching — the auto-assigned counterpart to a manual
 * issueFerryFreighter, so a freighter switched into collection-point mode gets treated like any
 * other collection point (haul it, service it) without the player chasing down a worker for it
 * every time. Shares the `ferriers` tally with manual assignments (MAX_HAULERS-capped), so labour
 * doesn't all pile onto one ship. Lands straight in "toSource" with its producer already picked
 * and that producer's `haulers` slot already claimed — same as assignHaul — so a plain haul auto-
 * assignment running later THIS SAME tick can't also grab it before countLogistics would otherwise
 * have caught up next tick. Deterministic: nearest freighter by distance, ties broken by id.
 * @param {State} state @param {Unit} unit
 */
export function assignFerry(state, unit) {
  let best = null, bestD = Infinity;
  for (const f of state.units.values()) {
    if (f.owner !== unit.owner || !f.collectPoint || !UNITS[f.type]?.cargoHold) continue;
    if (freightRoom(f) <= 0) continue;
    if ((f.ferriers || 0) >= MAX_HAULERS) continue;
    const d = Math.hypot(f.x - unit.x, f.y - unit.y);
    if (d < bestD || (d === bestD && best && f.id < best.id)) { bestD = d; best = f; }
  }
  if (!best) return;
  const src = nearestBacklogProducer(state, unit.owner, best.x, best.y);
  if (!src) return;   // nothing worth bringing it yet
  best.ferriers = (best.ferriers || 0) + 1;
  src.haulers = (src.haulers || 0) + 1;
  unit.order = { type: "ferry", freighterId: best.id, buildingId: src.id, phase: "toSource" };
}

/**
 * Advance a HAUL job: walk to the producer → load a cargo → carry it to the NEAREST place that'll
 * take it right now — its own Command Center, or a closer forward drop-off (Refinery/Foundry/
 * Arsenal) planted specifically to shorten a distant run, exactly like a raw gatherer already
 * picks (gather.js nearestGatherDrop) — and bank it there (1:1 — the goods were already
 * extracted). Re-picked fresh every tick of the walk, so a nearer option that appears (or frees up
 * room) mid-trip is taken immediately, not just at the moment the load first filled. Repeats while
 * the producer has a backlog, else idle. Salvages gracefully if the producer is razed or there's
 * nowhere to deliver to.
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
    const drop = nearestGatherDrop(state, unit.owner, unit.x, unit.y);
    if (!drop) { unit.order = null; return; }   // nowhere with room to deliver (and no CC) → hold the load, idle
    if (reached(unit, drop)) {
      depositHaul(state, unit, drop);
      if (unit.cargo && unit.cargo.qty > 0) return;   // a full forward drop-off took only part of it — reroute next tick
      order.phase = (src && !src.constructing && storeTotal(src) > 0) ? "toSource" : null;
      if (!order.phase) unit.order = null;
    } else stepToward(state, unit, drop.x, drop.y, def.speed, dt);
  }
}

// Deposit a hauler's cargo at `drop`: the bottomless treasury if it's a Command Center (bankCargo,
// 1:1, always takes the whole load), or — a forward drop-off (Refinery/Foundry/Arsenal) planted
// closer to the producer specifically to shorten the run — into ITS OWN finite `store` buffer,
// clamped to whatever room is left (same finite-intake handling gather.js's raw gatherers already
// get; a partial deposit just rides home on the cargo, and updateHaul above reroutes it next tick).
function depositHaul(state, unit, drop) {
  if (BUILDINGS[drop.type].isCommandCenter) { bankCargo(state, unit); return; }
  const put = Math.min(unit.cargo.qty, storeRoom(drop));
  drop.store = drop.store || {};
  drop.store[unit.cargo.com] = (drop.store[unit.cargo.com] || 0) + put;
  unit.cargo.qty -= put;
  if (unit.cargo.qty <= 1e-6) { unit.cargo.qty = 0; unit.cargo.com = null; }
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
 * Advance a FERRY job: a worker assigned to a specific landed freighter, manually
 * (engine/commands.js issueFerryFreighter, `order.manual`) or automatically (assignFerry, for a
 * COLLECTION-POINT one). While the freighter has room, it keeps ferrying the nearest own
 * producer's backlog straight onto its hold (the freighter IS the collection point — no CC
 * detour). Once there's nothing left to load: a PLAIN freighter still gets drained and carried
 * home by the worker (nothing else ever will); a COLLECTION-POINT one does NOT — its own shuttle
 * run (assignShuttle) owns that trip, so a ferry worker just tops it up and otherwise stays out of
 * its way. A MANUAL assignment then waits by the ship for more to load; an AUTO one goes idle,
 * freeing the worker for other work — same manual/auto split as SERVICE. Salvages gracefully if
 * the freighter jumps away/dies (carries home whatever's already aboard) or the CC is gone.
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
    // A collection-point freighter drives its own hold home once full (assignShuttle) — a ferry
    // worker only LOADS one, never drains it, so the two don't duplicate (or fight over) the same
    // trip. A plain freighter has no such run of its own, so the worker still carries it home.
    if (f && freightUsed(f) > 0 && !f.collectPoint) { order.phase = "toPickup"; return; }
    if (f && order.manual) {                                            // dedicated by hand → wait by the ship
      const fr = UNITS[f.type]?.radius || 0;
      if (Math.hypot(f.x - unit.x, f.y - unit.y) > REACH + fr) stepToward(state, unit, f.x, f.y, def.speed, dt);
      return;
    }
    unit.order = null;                                                  // auto-assigned & nothing to do → free for other work
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

// Bank a freighter's WHOLE freight hold into the owner's treasury (1:1, every commodity aboard)
// and empty it — the shuttle's unload step. Mirrors bankCargo's shape but for the multi-commodity
// `freight` hold instead of a worker's single-slot `cargo`.
function bankFreight(state, unit) {
  if (!unit.freight) return;
  const res = state.players[unit.owner].resources;
  for (const com in unit.freight) res[com] = (res[com] || 0) + unit.freight[com];
  unit.freight = {};
}

/**
 * Give an idle COLLECTION-POINT freighter (`unit.collectPoint`, HUD toggle — no research needed,
 * unlike AI-logistics) a SHUTTLE run: drive to the nearest own Command Center, bank the whole
 * hold, then drive back to its anchor (the spot it was standing when the mode was switched on —
 * engine/commands.js issueSetCollectPoint) to keep collecting. Triggers when the hold is literally
 * full, OR — since most producers can never actually fill a freighter's much bigger hold (a
 * 120-cap Plasma Rig can't fill a 250-cap Hauler on its own) — once there's SOME cargo aboard and
 * nothing left nearby worth waiting for. Without that second case a freighter fed by a small
 * producer would sit there holding SOMETHING forever, never quite reaching exact capacity and
 * never actually delivering it.
 * @param {State} state @param {Unit} unit
 */
export function assignShuttle(state, unit) {
  if (!unit.collectPoint) return;
  const used = freightUsed(unit);
  if (used <= 0) return;                                            // empty — nothing to deliver yet
  const full = freightRoom(unit) <= 1e-6;
  if (!full && nearestBacklogProducer(state, unit.owner, unit.x, unit.y, 0)) return;   // more still worth waiting for
  if (!unit.anchor) unit.anchor = { x: unit.x, y: unit.y };   // defensive fallback — issueSetCollectPoint normally sets this
  unit.order = { type: "shuttle", phase: "toCC" };
}

/**
 * Advance a freighter's own SHUTTLE run (see assignShuttle): walk to the Command Center, bank the
 * whole hold, walk back to the anchor, then go idle — ready to fill up again. Salvages gracefully
 * if there's no Command Center to deliver to (holds position, tries again next tick) or the anchor
 * is missing (a tampered/old save — just stops where it is).
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateFreighterShuttle(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;

  if (order.phase === "toCC") {
    const cc = nearestCommandCenter(state, unit.owner, unit.x, unit.y);
    if (!cc) return;   // no CC to deliver to — hold position and cargo, retry next tick
    if (reached(unit, cc)) { bankFreight(state, unit); order.phase = "toAnchor"; }
    else stepToward(state, unit, cc.x, cc.y, def.speed, dt);
    return;
  }

  if (order.phase === "toAnchor") {
    const a = unit.anchor;
    if (!a || Math.hypot(a.x - unit.x, a.y - unit.y) <= REACH) { unit.order = null; return; }
    stepToward(state, unit, a.x, a.y, def.speed, dt);
  }
}
