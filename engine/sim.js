/* ============================================================
   Per-tick orchestrator: advances every unit and building by one fixed
   timestep, runs the AI's think cycle, and checks for a winner. This is
   the only thing engine/loop.js's `update` callback calls.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { buildUnitGrid } from "./grid.js";
import { updateGather } from "./gather.js";
import { updateScoutMode } from "./scout.js";
import { updateRepair } from "./repair.js";
import { updateCombat, updateBuildingCombat, updateWorkerCombat } from "./combat.js";
import { updateBuildingConstruction, updateProductionQueue, BUILD_REACH } from "./production.js";
import { applySeparation } from "./separation.js";
import { updateFog } from "./fog.js";
import { UNITS } from "./entities.js";
import { getEntity } from "./state.js";
import { checkWinCondition } from "./victory.js";
import { runAI } from "./ai.js";

export function tick(state, dt) {
  if (state.over) return;

  runAI(state, dt);

  // Broad-phase spatial index for this tick, shared by movement avoidance,
  // combat acquisition, and the separation pass below (see engine/grid.js).
  state.unitGrid = buildUnitGrid(state);
  // Per-node miner count for this tick, read by gather.js's saturation falloff.
  // Frozen before any worker mines so every miner on a node sees the same count
  // regardless of Map iteration order (determinism).
  countMiners(state);

  for (const unit of state.units.values()) updateUnit(state, unit, dt);
  applySeparation(state, dt);
  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");   // the AI sees only what its own units/buildings reveal, same as the player
  for (const building of state.buildings.values()) {
    updateBuildingConstruction(state, building, dt);
    updateProductionQueue(state, building, dt);
    updateBuildingCombat(state, building, dt);
  }

  // Healing runs last, once every combatant and building has taken its damage
  // for the tick, so a Mender patches the freshest wounds (see repair.js).
  updateRepair(state, dt);

  checkWinCondition(state);
  state.time += dt;
  state.tick++;
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
