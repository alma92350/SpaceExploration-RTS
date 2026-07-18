/* ============================================================
   Building construction progress and unit production queues.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, canAfford, payCost } from "./entities.js";
import { makeUnit } from "./state.js";

export function updateBuildingConstruction(building, dt) {
  if (!building.constructing) return;
  const def = BUILDINGS[building.type];
  if (def.buildTime <= 0) {
    building.constructing = false;
    building.buildProgress = 1;
    building.hp = def.hp;
    return;
  }
  building.buildProgress = Math.min(1, building.buildProgress + dt / def.buildTime);
  building.hp = Math.round(def.hp * building.buildProgress);
  if (building.buildProgress >= 1) building.constructing = false;
}

export function updateProductionQueue(state, building, dt) {
  if (building.constructing || building.queue.length === 0) return;
  const job = building.queue[0];
  const def = UNITS[job.unitType];
  job.progress += dt / def.buildTime;
  if (job.progress >= 1) {
    building.queue.shift();
    const spawn = { x: building.x + building.radius + 10, y: building.y + building.radius + 10 };
    const u = makeUnit(job.unitType, building.owner, spawn.x, spawn.y);
    u.order = { type: "move", x: building.rally.x, y: building.rally.y };
    state.units.set(u.id, u);
  }
}

export function queueProduction(state, buildingId, unitType) {
  const building = state.buildings.get(buildingId);
  if (!building || building.constructing) return false;
  const def = UNITS[unitType];
  const producable = def && BUILDINGS[building.type].produces.includes(unitType);
  if (!producable) return false;
  const player = state.players[building.owner];
  if (!canAfford(player.resources, def.cost)) return false;
  payCost(player.resources, def.cost);
  building.queue.push({ unitType, progress: 0 });
  return true;
}
