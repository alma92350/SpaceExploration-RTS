/* ============================================================
   Per-tick orchestrator: advances every unit and building by one fixed
   timestep, runs the AI's think cycle, and checks for a winner. This is
   the only thing engine/loop.js's `update` callback calls.
   ============================================================ */

"use strict";

import { stepToward, escortSlot } from "./movement.js";
import { buildUnitGrid } from "./grid.js";
import { updateGather } from "./gather.js";
import { updateScoutMode } from "./scout.js";
import { updateRepair } from "./repair.js";
import { updateCombat, updateBuildingCombat, updateWorkerCombat } from "./combat.js";
import { updateBuildingConstruction, updateProductionQueue, BUILD_REACH } from "./production.js";
import { updateProduction } from "./industry.js";
import { updateResearch } from "./techtree.js";
import { updateWonder } from "./wonder.js";
import { applySeparation } from "./separation.js";
import { updateFog } from "./fog.js";
import { UNITS } from "./entities.js";
import { getEntity } from "./state.js";
import { checkWinCondition, checkEndlessLoss, checkEndlessWin } from "./victory.js";
import { runAI } from "./ai.js";
import { updateScenario } from "./scenarios.js";
import { updateMarket } from "./market.js";
import { updateDiplomacy } from "./diplomacy.js";

export function tick(state, dt) {
  if (state.over) return;

  // Scenario mode drives the convoy/piracy/objective itself; the skirmish
  // economy AI only runs in a normal match (see engine/scenarios.js).
  if (state.scenario) updateScenario(state, dt);
  else runAI(state, dt);

  // Broad-phase spatial index for this tick, shared by movement avoidance,
  // combat acquisition, and the separation pass below (see engine/grid.js).
  state.unitGrid = buildUnitGrid(state);
  // Per-node miner count for this tick, read by gather.js's saturation falloff.
  // Frozen before any worker mines so every miner on a node sees the same count
  // regardless of Map iteration order (determinism).
  countMiners(state);
  // Aura projectors (Aegis) for this tick, read by combat.js attackDamage. Collected
  // once here (a tiny list — the units are Tier-3 and rare) so a landed hit costs O(anvils)
  // not O(units); positions are frozen at tick start like the grid above (deterministic).
  collectAnvils(state);

  for (const unit of state.units.values()) updateUnit(state, unit, dt);
  applySeparation(state, dt);
  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");   // the AI sees only what its own units/buildings reveal, same as the player
  for (const building of state.buildings.values()) {
    updateBuildingConstruction(state, building, dt);
    updateProductionQueue(state, building, dt);
    updateProduction(state, building, dt);   // Odyssey factories refine raw hauls into goods (no-op without a recipe)
    updateResearch(state, building, dt);     // Odyssey Datacenter develops the tech tree (no-op for any other building)
    updateWonder(state, building, dt);       // Odyssey Antimatter Gate charges toward the galaxy win (no-op off a wonder)
    updateBuildingCombat(state, building, dt);
  }

  // Healing runs last, once every combatant and building has taken its damage
  // for the tick, so a Mender patches the freshest wounds (see repair.js).
  updateRepair(state, dt);

  // Scenario mode settles its own win/lose inside updateScenario; Odyssey
  // (endless) only ends on losing the player's Command Center; a normal match
  // uses the CC/score victory check.
  if (state.scenario) { /* updateScenario already set state.over if finished */ }
  else if (state.endless) { if (!state.background) { checkEndlessWin(state); checkEndlessLoss(state); } }   // win first (a Gate completing the same tick your CC falls still counts); a colony (background) is never "over"
  else checkWinCondition(state);

  if (state.market) updateMarket(state, dt);       // Odyssey: relax trade pressure back toward equilibrium
  if (state.diplomacy) updateDiplomacy(state, dt);  // Odyssey: drift the neighbour's stance with scarcity
  state.time += dt;
  state.tick++;
}

// Collect this tick's aura projectors (units with a guardAura, i.e. the Aegis) into a
// flat list on the state, so combat.js can look up "is this target inside a friendly
// aura" against a handful of entries instead of scanning every unit per hit. Transient
// (never serialized), rebuilt each tick from live positions — deterministic. Exported so
// combat-only test harnesses (which drive updateCombat directly, bypassing tick) can build
// the same list before a fight.
export function collectAnvils(state) {
  const out = [];
  for (const u of state.units.values()) {
    const g = UNITS[u.type]?.guardAura;
    if (g && u.hp > 0) out.push({ id: u.id, owner: u.owner, x: u.x, y: u.y, range: g.range, mult: g.damageTakenMult });
  }
  state.anvils = out;
}

// Tally how many workers (both sides) are assigned to gather each node this
// tick — the single source of truth for gather.js's saturation efficiency.
// Counts every worker on a `gather` order, not just those physically at the
// rock, so the "~3 workers per node" rule reads by intent rather than by who
// happens to be mid-haul. Recomputed from scratch each tick — never accumulates.
function countMiners(state) {
  for (const n of state.map.nodes) n.miners = 0;
  for (const u of state.units.values()) {
    const o = u.order;
    if (o && o.type === "gather") {
      const n = state.map.nodesById ? state.map.nodesById.get(o.nodeId) : null;
      if (n) n.miners++;
    }
  }
}

function updateUnit(state, unit, dt) {
  // Whenever the active order finishes (arrival, target killed, node drained),
  // pull in the next queued waypoint before anything else runs this tick
  // — so a completed step flows straight into the next, and a combat unit only
  // falls back to auto-acquiring once its whole chain is exhausted.
  if (!unit.order && unit.orderQueue && unit.orderQueue.length) {
    unit.order = unit.orderQueue.shift();
  }

  const def = UNITS[unit.type];
  if (def.role === "combat") { updateCombat(state, unit, dt); return; }
  if (def.role === "support") { updateSupport(state, unit, def, dt); return; }

  if (!unit.order) return;
  switch (unit.order.type) {
    case "move": {
      const arrived = stepToward(state, unit, unit.order.x, unit.order.y, def.speed, dt);
      if (arrived) unit.order = null;
      break;
    }
    case "gather":
      updateGather(state, unit, dt);
      break;
    case "escort": {
      // A non-combat escort (worker) just keeps station on the ring around the guarded ship.
      const slot = escortSlot(state, unit);
      if (!slot) { unit.order = null; break; }
      stepToward(state, unit, slot.x, slot.y, def.speed, dt);
      break;
    }
    case "scout":
      updateScoutMode(state, unit, dt);
      break;
    case "attack":
      // Workers only reach here on an explicit attack order (combat units are
      // handled by updateCombat above); they close in and fight weakly.
      updateWorkerCombat(state, unit, def, dt);
      break;
    case "build": {
      const b = state.buildings.get(unit.order.buildingId);
      if (!b) { unit.order = null; break; }
      const dist = Math.hypot(b.x - unit.x, b.y - unit.y);
      if (dist > BUILD_REACH) stepToward(state, unit, b.x, b.y, def.speed, dt);
      else if (!b.constructing) unit.order = null;
      break;
    }
    // Any order type this non-combat/non-support unit can't act on (e.g. an
    // "attack-move" that reached a freighter) is dropped rather than left to stick
    // forever and wedge the unit's whole order queue. No valid caller hits this today.
    default:
      unit.order = null;
  }
}

// Support-role units (the Mender) carry no weapon — the actual healing is the
// global updateRepair pass in repair.js. All this does is MOVE them, so the
// player can position the drone: a plain move/attack-move goes to the point;
// an 'attack' order (should one ever be issued — input.js won't, since a Mender
// has no attack stat) is reinterpreted as "go to that foe" so the drone can be
// pushed toward a fight to mend the units in it, and it never deals damage.
function updateSupport(state, unit, def, dt) {
  const o = unit.order;
  if (!o) return;
  // A support escort (Mender) trails the guarded ship in formation, mending whatever's near it
  // via the global repair pass — a medic keeping station on the fleet it's protecting.
  if (o.type === "escort") {
    const slot = escortSlot(state, unit);
    if (!slot) { unit.order = null; return; }
    stepToward(state, unit, slot.x, slot.y, def.speed, dt);
    return;
  }
  let tx, ty, follow = false;
  if (o.type === "attack") {
    const t = getEntity(state, o.targetId);
    if (!t || t.hp <= 0) { unit.order = null; return; }
    tx = t.x; ty = t.y; follow = true;   // keep chasing a moving foe rather than stopping on arrival
  } else if (o.type === "move" || o.type === "attack-move") {
    tx = o.x; ty = o.y;
  } else {
    unit.order = null; return;   // gather / scout / build are meaningless for a drone
  }
  const arrived = stepToward(state, unit, tx, ty, def.speed, dt);
  if (arrived && !follow) unit.order = null;
}
