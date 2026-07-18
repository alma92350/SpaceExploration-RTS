/* ============================================================
   Building construction progress and unit production queues.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, UPGRADES, canAfford, payCost } from "./entities.js";
import { makeUnit } from "./state.js";
import { supplyUsed, supplyCap } from "./supply.js";

// How close a worker has to stand to actually count as building, not just
// walking over. Shared with sim.js's arrival check for the 'build' order.
export const BUILD_REACH = 24;

// More workers can pile onto the same construction site to speed it up —
// capped so a single building can't be insta-rushed by massing an
// unlimited crowd of workers on it.
const MAX_BUILDERS = 4;

function countBuilders(state, building) {
  let n = 0;
  for (const u of state.units.values()) {
    if (u.owner !== building.owner) continue;
    if (!u.order || u.order.type !== "build" || u.order.buildingId !== building.id) continue;
    if (Math.hypot(u.x - building.x, u.y - building.y) <= BUILD_REACH) n++;
  }
  return n;
}

export function updateBuildingConstruction(state, building, dt) {
  if (!building.constructing) return;
  const def = BUILDINGS[building.type];
  if (def.buildTime <= 0) {
    building.constructing = false;
    building.buildProgress = 1;
    building.hp = def.hp;
    return;
  }
  // The founding worker alone still builds at the original pace even if
  // it wanders off or dies — extra workers on-site are a bonus, not a
  // requirement.
  const builders = Math.min(countBuilders(state, building), MAX_BUILDERS);
  const rate = Math.max(1, builders);
  building.buildProgress = Math.min(1, building.buildProgress + (rate * dt) / def.buildTime);
  building.hp = Math.round(def.hp * building.buildProgress);
  if (building.buildProgress >= 1) {
    building.constructing = false;
    state.events.push({ type: "buildingComplete", x: building.x, y: building.y, owner: building.owner });
  }
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
    state.events.push({ type: "unitSpawned", x: u.x, y: u.y, owner: u.owner });
  }
}

export function queueProduction(state, buildingId, unitType) {
  const building = state.buildings.get(buildingId);
  if (!building || building.constructing) return false;
  const def = UNITS[unitType];
  const producable = def && BUILDINGS[building.type].produces?.includes(unitType);
  if (!producable) return false;
  const player = state.players[building.owner];
  if (!canAfford(player.resources, def.cost)) return false;
  // Supply check sits AFTER canAfford (so being broke stays the silent
  // today-UX, and the supply beep only fires when supply is the real
  // blocker) and BEFORE payCost (reject before charging — nothing to
  // refund). All queued jobs already count toward supplyUsed, so this
  // is what actually caps queue-stuffing.
  if (supplyUsed(state, building.owner) + (def.supplyCost || 0) > supplyCap(state, building.owner)) {
    state.events.push({ type: "productionBlocked", reason: "supply",
                        x: building.x, y: building.y, owner: building.owner });
    return false;
  }
  payCost(player.resources, def.cost);
  building.queue.push({ unitType, progress: 0 });
  return true;
}

// A Refinery's one-time, player-wide purchase — see UPGRADES in
// entities.js for what each one does. Not a queue: it applies the
// instant it's paid for (combat.js reads state.players[owner].upgrades
// live), so there's nothing further to tick down.
export function researchUpgrade(state, buildingId, upgradeId) {
  const building = state.buildings.get(buildingId);
  if (!building || building.type !== "refinery" || building.constructing) return false;
  const player = state.players[building.owner];
  if (player.upgrades[upgradeId]) return false;
  const def = UPGRADES[upgradeId];
  if (!def || !canAfford(player.resources, def.cost)) return false;
  payCost(player.resources, def.cost);
  player.upgrades[upgradeId] = true;
  return true;
}
