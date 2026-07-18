/* ============================================================
   Per-tick orchestrator: advances every unit and building by one fixed
   timestep, runs the AI's think cycle, and checks for a winner. This is
   the only thing engine/loop.js's `update` callback calls.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { updateGather } from "./gather.js";
import { updateCombat } from "./combat.js";
import { updateBuildingConstruction, updateProductionQueue } from "./production.js";
import { UNITS } from "./entities.js";
import { checkWinCondition } from "./victory.js";
import { runAI } from "./ai.js";

export function tick(state, dt) {
  if (state.over) return;

  runAI(state, dt);

  for (const unit of state.units.values()) updateUnit(state, unit, dt);
  for (const building of state.buildings.values()) {
    updateBuildingConstruction(building, dt);
    updateProductionQueue(state, building, dt);
  }

  checkWinCondition(state);
  state.time += dt;
  state.tick++;
}

function updateUnit(state, unit, dt) {
  const def = UNITS[unit.type];
  if (def.role === "combat") { updateCombat(state, unit, dt); return; }

  if (!unit.order) return;
  switch (unit.order.type) {
    case "move": {
      const arrived = stepToward(unit, unit.order.x, unit.order.y, def.speed, dt);
      if (arrived) unit.order = null;
      break;
    }
    case "gather":
      updateGather(state, unit, dt);
      break;
    case "build": {
      const b = state.buildings.get(unit.order.buildingId);
      if (!b) { unit.order = null; break; }
      const dist = Math.hypot(b.x - unit.x, b.y - unit.y);
      if (dist > 24) stepToward(unit, b.x, b.y, def.speed, dt);
      else if (!b.constructing) unit.order = null;
      break;
    }
  }
}
