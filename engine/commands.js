/* ============================================================
   Player/AI intent -> unit order. Both input.js (mouse/keyboard) and
   ai.js (the scripted opponent) call these directly; orders take effect
   immediately and the next sim tick acts on them.
   ============================================================ */

"use strict";

import { BUILDINGS, canAfford, payCost } from "./entities.js";
import { makeBuilding } from "./state.js";

export function issueMove(units, x, y) {
  units.forEach(u => { u.order = { type: "move", x, y }; });
}

export function issueGather(units, nodeId) {
  units.forEach(u => { if (u.cargo) u.order = { type: "gather", nodeId }; });
}

export function issueAttack(units, targetId) {
  units.forEach(u => { u.order = { type: "attack", targetId }; });
}

export function issueAttackMove(units, x, y) {
  units.forEach(u => { u.order = { type: "attack-move", x, y }; });
}

// Pays the cost up front, drops a constructing building on the spot, and
// sends the chosen worker to stand at it until it finishes.
export function issueBuild(state, workerId, buildingType, x, y) {
  const worker = state.units.get(workerId);
  if (!worker) return null;
  const player = state.players[worker.owner];
  const def = BUILDINGS[buildingType];
  if (!def || !canAfford(player.resources, def.cost)) return null;
  payCost(player.resources, def.cost);
  const building = makeBuilding(buildingType, worker.owner, x, y, { constructing: true });
  state.buildings.set(building.id, building);
  worker.order = { type: "build", buildingId: building.id };
  return building.id;
}
