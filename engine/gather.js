/* ============================================================
   Worker gather/deposit loop: walk to node -> mine into cargo -> walk to
   the nearest completed Command Center -> deposit -> repeat until the
   node runs dry.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS } from "./entities.js";

const ORBIT_RADIUS = 16;   // workers ring the node instead of stacking on its exact center
const ARRIVE_REACH = 4;
const DROP_REACH = 30;

// Stable per-worker angle around the node, so a group sent to the same
// node spreads out around it instead of converging on one point.
function orbitSpot(node, unitId) {
  let hash = 7;
  for (const c of unitId) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const angle = (hash % 360) * (Math.PI / 180);
  return { x: node.x + Math.cos(angle) * ORBIT_RADIUS, y: node.y + Math.sin(angle) * ORBIT_RADIUS };
}

export function updateGather(state, unit, dt) {
  const def = UNITS.worker;
  const order = unit.order;
  const node = state.map.nodes.find(n => n.id === order.nodeId);
  if (!node || node.amount <= 0) { unit.order = null; return; }
  if (!order.phase) order.phase = "toNode";

  if (order.phase === "toNode") {
    const spot = orbitSpot(node, unit.id);
    const dist = Math.hypot(spot.x - unit.x, spot.y - unit.y);
    if (dist <= ARRIVE_REACH) order.phase = "mining";
    else stepToward(state, unit, spot.x, spot.y, def.speed, dt);
    return;
  }

  if (order.phase === "mining") {
    // Re-tasked mid-carry to a node of a DIFFERENT commodity: don't throw the
    // load away — haul it home and deposit it first, then come back to mine
    // the new node. (Same commodity just tops off the existing cargo.)
    if (unit.cargo.qty > 0 && unit.cargo.com && unit.cargo.com !== node.com) {
      order.phase = "toDrop";
      return;
    }
    unit.cargo.com = node.com;
    const room = def.cargoCap - unit.cargo.qty;
    const take = Math.min(def.gatherRate * dt, node.amount, room);
    unit.cargo.qty += take;
    node.amount -= take;
    if (unit.cargo.qty >= def.cargoCap - 1e-6 || node.amount <= 0) order.phase = "toDrop";
    return;
  }

  if (order.phase === "toDrop") {
    const drop = nearestCommand(state, unit.owner, unit.x, unit.y);
    if (!drop) { unit.order = null; return; }
    const dist = Math.hypot(drop.x - unit.x, drop.y - unit.y);
    if (dist <= DROP_REACH) {
      const player = state.players[unit.owner];
      player.resources[unit.cargo.com] = (player.resources[unit.cargo.com] || 0) + unit.cargo.qty;
      unit.cargo.qty = 0;
      order.phase = node.amount > 0 ? "toNode" : null;
      if (!order.phase) unit.order = null;
    } else {
      stepToward(state, unit, drop.x, drop.y, def.speed, dt);
    }
  }
}

function nearestCommand(state, owner, x, y) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || b.type !== "command") continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}
