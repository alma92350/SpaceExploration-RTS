/* ============================================================
   Worker gather/deposit loop: walk to node -> mine into cargo -> walk to
   the nearest completed Command Center -> deposit -> repeat until the
   node runs dry.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS } from "./entities.js";

const NODE_REACH = 18;
const DROP_REACH = 30;

export function updateGather(state, unit, dt) {
  const def = UNITS.worker;
  const order = unit.order;
  const node = state.map.nodes.find(n => n.id === order.nodeId);
  if (!node || node.amount <= 0) { unit.order = null; return; }
  if (!order.phase) order.phase = "toNode";

  if (order.phase === "toNode") {
    const dist = Math.hypot(node.x - unit.x, node.y - unit.y);
    if (dist <= NODE_REACH) order.phase = "mining";
    else stepToward(unit, node.x, node.y, def.speed, dt);
    return;
  }

  if (order.phase === "mining") {
    if (unit.cargo.com && unit.cargo.com !== node.com) unit.cargo.qty = 0;
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
      stepToward(unit, drop.x, drop.y, def.speed, dt);
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
