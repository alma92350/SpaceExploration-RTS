/* ============================================================
   Player/AI intent -> unit order. Both input.js (mouse/keyboard) and
   ai.js (the scripted opponent) call these directly; orders take effect
   immediately and the next sim tick acts on them.
   ============================================================ */

"use strict";

import { BUILDINGS, canAfford, payCost } from "./entities.js";
import { canPlaceBuilding } from "./colliders.js";
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

// Give a unit an order, either replacing what it's doing (a plain command)
// or appending it as a waypoint (queue = true, the Ctrl+command from input.js).
// Appending only queues when the unit is actually busy — a queued command to a
// fully idle unit acts immediately, so the first waypoint of a chain doesn't
// sit inert. A plain command always wipes any queued waypoints, so it cancels a
// chain cleanly. sim.js pulls the next queued order in as soon as `order` clears.
function dispatch(unit, order, queue) {
  if (!unit.orderQueue) unit.orderQueue = [];
  if (queue && (unit.order || unit.orderQueue.length)) {
    unit.orderQueue.push(order);
  } else {
    unit.order = order;
    unit.orderQueue = [];
  }
}

export function issueMove(units, x, y, queue = false) {
  const spots = formationSpots(units.length, x, y);
  units.forEach((u, i) => dispatch(u, { type: "move", x: spots[i].x, y: spots[i].y }, queue));
}

export function issueGather(units, nodeId, queue = false) {
  units.forEach(u => { if (u.cargo) dispatch(u, { type: "gather", nodeId }, queue); });
}

export function issueAttack(units, targetId, queue = false) {
  units.forEach(u => dispatch(u, { type: "attack", targetId }, queue));
}

export function issueAttackMove(units, x, y, queue = false) {
  const spots = formationSpots(units.length, x, y);
  units.forEach((u, i) => dispatch(u, { type: "attack-move", x: spots[i].x, y: spots[i].y }, queue));
}

// Pays the cost up front, drops a constructing building on the spot, and
// sends the chosen worker to stand at it until it finishes. Placement is
// validated (and payment withheld) before anything is committed, so a bad
// click never charges the player -- see engine/colliders.js for what
// counts as valid ground.
export function issueBuild(state, workerId, buildingType, x, y) {
  const worker = state.units.get(workerId);
  if (!worker) return null;
  const player = state.players[worker.owner];
  const def = BUILDINGS[buildingType];
  if (!def || !canAfford(player.resources, def.cost)) return null;
  if (!canPlaceBuilding(state, buildingType, x, y)) return null;
  payCost(player.resources, def.cost);
  const building = makeBuilding(buildingType, worker.owner, x, y, { constructing: true });
  state.buildings.set(building.id, building);
  worker.order = { type: "build", buildingId: building.id };
  return building.id;
}

// Sends more workers to help an already-founded construction site — no
// cost (already paid when it was placed), no new building. Extra hands
// speed the build up; see production.js's updateBuildingConstruction.
export function issueAssistBuild(units, buildingId, queue = false) {
  units.forEach(u => { if (u.cargo) dispatch(u, { type: "build", buildingId }, queue); });
}

// Halt: drop the active order and any queued waypoints so the unit stops
// where it stands. A combat unit still defends itself (it re-auto-acquires an
// enemy that wanders into range next tick), but it won't chase or resume a
// path — the standard RTS "stop" that pulls a unit out of a move or a chain.
export function issueStop(units) {
  units.forEach(u => { u.order = null; u.orderQueue = []; });
}

// Every unit the building produces from now on walks to this point
// instead of wherever the old rally was — production.js reads
// building.rally fresh at spawn time, so this takes effect immediately
// with no other plumbing needed.
export function issueSetRally(building, x, y) {
  building.rally = { x, y };
}
