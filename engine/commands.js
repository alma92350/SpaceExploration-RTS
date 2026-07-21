/* ============================================================
   Player/AI intent -> unit order. Both input.js (mouse/keyboard) and
   ai.js (the scripted opponent) call these directly; orders take effect
   immediately and the next sim tick acts on them.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, canAfford, payCost, prereqsMet } from "./entities.js";
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
  unit.hold = false;   // any positive order (move/attack/gather/waypoint) cancels a Hold stance
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

// Escort a friendly ship: each unit takes a stable slot on a protective ring around the
// target and follows it wherever it's ordered (engine/movement.js escortSlot), holding the
// formation until given another order. A combat escort still auto-acquires threats that come
// near, then reforms. The target itself is never told to escort (it's filtered out by the
// caller). `slot`/`slots` fix each unit's place at issue time, so the ring is deterministic.
export function issueEscort(units, targetId, queue = false) {
  const n = units.length;
  units.forEach((u, i) => dispatch(u, { type: "escort", targetId, slot: i, slots: n }, queue));
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
  if (!prereqsMet(state, worker.owner, def)) return null;   // e.g. no founding a Foundry without a completed Barracks
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
  units.forEach(u => { u.order = null; u.orderQueue = []; u.hold = false; });
}

// Hold position: a combat unit stands its ground and fires on anything that
// wanders into weapon range, but never CHASES an auto-acquired target out of
// position (combat.js honours unit.hold) — the standard defensive stance for
// holding a line or a choke. Any move/attack order, or Stop, clears it.
export function issueHold(units) {
  units.forEach(u => {
    if (UNITS[u.type] && UNITS[u.type].role === "combat") { u.order = null; u.orderQueue = []; u.hold = true; }
  });
}

// Put a Ranger into autonomous scout mode (order type "scout"): it ranges the
// map on its own toward the nearest unexplored ground until re-ordered (see
// scout.js). Only scout-role units accept it, so issuing it to a mixed selection
// simply skips everything that isn't a Ranger. Clears any queued waypoints, like
// a plain command — the mode is persistent, not something to stack behind.
export function issueScout(units) {
  units.forEach(u => {
    if (UNITS[u.type] && UNITS[u.type].role === "scout") { u.order = { type: "scout" }; u.orderQueue = []; }
  });
}

// Every unit the building produces from now on walks to this point instead of
// wherever the old rally was — production.js reads building.rally fresh at spawn
// time, so this takes effect immediately with no other plumbing needed. If the
// rally was set ON a resource node (nodeId given), new workers spawn already
// gathering it instead of standing idle at the point — the standard "rally to
// minerals" convenience. Non-workers just walk to the point.
export function issueSetRally(building, x, y, nodeId = null) {
  building.rally = { x, y, nodeId };
}
