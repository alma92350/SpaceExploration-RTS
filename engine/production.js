/* ============================================================
   Building construction progress and unit production queues.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, UPGRADES, canAfford, payCost, prereqsMet, committedDoctrine, upgradeMult } from "./entities.js";
import { makeUnit } from "./state.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { sideMod } from "./map.js";

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
  // The instant-build early-exit stays on the RAW buildTime — a modifier
  // never turns a real build time into a zero-time one.
  if (def.buildTime <= 0) {
    building.constructing = false;
    building.buildProgress = 1;
    building.hp = def.hp;
    return;
  }
  // A world's build-time modifier speeds (or slows) construction; per-side on an
  // asymmetric world (sideMod reads the default 1 for map-less test states). The
  // Logistics doctrine's production-speed upgrade compounds on top.
  const bt = def.buildTime * sideMod(state, building.owner, "buildTimeMult")
    * upgradeMult(state.players?.[building.owner]?.upgrades, "produceTimeMult");
  // The founding worker alone still builds at the original pace even if
  // it wanders off or dies — extra workers on-site are a bonus, not a
  // requirement.
  const builders = Math.min(countBuilders(state, building), MAX_BUILDERS);
  const rate = Math.max(1, builders);
  const before = building.buildProgress;
  building.buildProgress = Math.min(1, before + (rate * dt) / bt);
  // Construction ADDS the hp built this tick (a ceiling of def.hp * progress),
  // it never overwrites hp downward — so damage taken mid-build persists and a
  // building under sustained fire can actually be destroyed before it finishes,
  // instead of healing every hit away each tick. A building that survives to
  // completion while damaged finishes at def.hp minus the damage it soaked.
  const gain = def.hp * (building.buildProgress - before);
  building.hp = Math.min(building.hp + gain, def.hp * building.buildProgress);
  if (building.buildProgress >= 1) {
    building.constructing = false;
    state.events.push({ type: "buildingComplete", x: building.x, y: building.y, owner: building.owner });
  }
}

export function updateProductionQueue(state, building, dt) {
  if (building.constructing || building.queue.length === 0) return;
  const job = building.queue[0];
  const def = UNITS[job.unitType];
  // Same build-time modifier applies to unit production (a factory world trains
  // faster too), per-side on an asymmetric world — and the same Logistics
  // production-speed upgrade compounds here too.
  const bt = def.buildTime * sideMod(state, building.owner, "buildTimeMult")
    * upgradeMult(state.players?.[building.owner]?.upgrades, "produceTimeMult");
  job.progress += dt / bt;
  if (job.progress >= 1) {
    building.queue.shift();
    const spawn = { x: building.x + building.radius + 10, y: building.y + building.radius + 10 };
    const u = makeUnit(job.unitType, building.owner, spawn.x, spawn.y);
    // Rally-to-resource: if the rally sits on a live node and this unit can
    // gather (workers carry a cargo hold), it spawns already mining instead of
    // idling at the point. Everything else — and a rally on a drained node —
    // just walks to the rally point as before.
    const rallyNode = building.rally.nodeId
      ? (state.map.nodesById ? state.map.nodesById.get(building.rally.nodeId)
                             : state.map.nodes.find(n => n.id === building.rally.nodeId))
      : null;
    u.order = rallyNode && rallyNode.amount > 0 && u.cargo
      ? { type: "gather", nodeId: building.rally.nodeId }
      : { type: "move", x: building.rally.x, y: building.rally.y };
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
  // An Odyssey-only unit (e.g. the Colony Ship) can never be built in a skirmish,
  // regardless of menu wiring — hard-guarantees it stays out of the byte-identical
  // skirmish path. A no-op for existing skirmish (no odysseyOnly unit is reachable).
  if (def.odysseyOnly && !state.endless) return false;
  // Tech gate: a locked unit (its prereq building not yet completed) can't be
  // queued. Checked before affordability so "locked" outranks "too expensive".
  if (!prereqsMet(state, building.owner, def)) {
    state.events.push({ type: "productionBlocked", reason: "prereq",
                        x: building.x, y: building.y, owner: building.owner });
    return false;
  }
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

// Pulls a job out of the queue (in progress or still waiting, either
// one) and fully refunds its cost — the simplest, most player-friendly
// convention, and consistent with nothing having been spent on it yet
// beyond the ore itself (a part-built unit doesn't exist as an entity,
// unlike a part-built building, so there's no partial-progress asset to
// account for).
export function cancelProduction(state, buildingId, queueIndex) {
  const building = state.buildings.get(buildingId);
  if (!building) return false;
  const job = building.queue[queueIndex];
  if (!job) return false;
  building.queue.splice(queueIndex, 1);
  const player = state.players[building.owner];
  payCost(player.resources, negate(UNITS[job.unitType].cost));
  return true;
}

function negate(cost) {
  return Object.fromEntries(Object.entries(cost).map(([com, qty]) => [com, -qty]));
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
  if (!def) return false;
  // Doctrine lock: once committed to one doctrine, the other is off-limits.
  const chosen = committedDoctrine(state, building.owner);
  if (chosen && def.doctrine && chosen !== def.doctrine) return false;
  // Tier gate: a Tier-2 upgrade needs its Tier-1 already researched (prereqsMet
  // reads the requires upgrade token, same as the tech tree).
  if (!prereqsMet(state, building.owner, def)) return false;
  if (!canAfford(player.resources, def.cost)) return false;
  payCost(player.resources, def.cost);
  player.upgrades[upgradeId] = true;
  return true;
}
