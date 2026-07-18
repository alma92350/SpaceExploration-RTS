/* ============================================================
   Player/AI intent -> unit order. Both input.js (mouse/keyboard) and
   ai.js (the scripted opponent) call these directly; orders take effect
   immediately and the next sim tick acts on them.
   ============================================================ */

"use strict";

import { BUILDINGS, canAfford, payCost } from "./entities.js";
import { makeBuilding } from "./state.js";

const FORMATION_SPACING = 20;

// Spreads a group moving to the same point across a grid centered on it,
// so a multi-unit move/attack-move doesn't converge into one stacked pile.
function formationSpots(count, x, y) {
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const spots = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols, row = Math.floor(i / cols);
    spots.push({
      x: x + (col - (cols - 1) / 2) * FORMATION_SPACING,
      y: y + (row - (rows - 1) / 2) * FORMATION_SPACING,
    });
  }
  return spots;
}

export function issueMove(units, x, y) {
  const spots = formationSpots(units.length, x, y);
  units.forEach((u, i) => { u.order = { type: "move", x: spots[i].x, y: spots[i].y }; });
}

export function issueGather(units, nodeId) {
  units.forEach(u => { if (u.cargo) u.order = { type: "gather", nodeId }; });
}

export function issueAttack(units, targetId) {
  units.forEach(u => { u.order = { type: "attack", targetId }; });
}

export function issueAttackMove(units, x, y) {
  const spots = formationSpots(units.length, x, y);
  units.forEach((u, i) => { u.order = { type: "attack-move", x: spots[i].x, y: spots[i].y }; });
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

// Sends more workers to help an already-founded construction site — no
// cost (already paid when it was placed), no new building. Extra hands
// speed the build up; see production.js's updateBuildingConstruction.
export function issueAssistBuild(units, buildingId) {
  units.forEach(u => { if (u.cargo) u.order = { type: "build", buildingId }; });
}
