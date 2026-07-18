/* ============================================================
   Combat-role units (skiffs): auto-acquire the nearest enemy within
   aggro range, close to weapon range, and fire on cooldown. An explicit
   'attack' order pins the target; 'move'/'attack-move' just supply a
   fallback destination once nothing's left to fight.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS } from "./entities.js";
import { getEntity, removeEntity } from "./state.js";

export function updateCombat(state, unit, dt) {
  const def = UNITS[unit.type];
  unit.attackTimer = Math.max(0, unit.attackTimer - dt);

  let targetId = unit.order && unit.order.type === "attack" ? unit.order.targetId : null;
  if (targetId && !isAlive(state, targetId)) { unit.order = null; targetId = null; }
  if (!targetId) targetId = acquireTarget(state, unit, def);

  if (targetId) {
    const target = getEntity(state, targetId);
    if (target && target.hp > 0) {
      const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
      if (dist > def.range) {
        stepToward(state, unit, target.x, target.y, def.speed, dt);
      } else if (unit.attackTimer <= 0) {
        target.hp -= def.attack;
        unit.attackTimer = def.cooldown;
        if (target.hp <= 0) {
          removeEntity(state, target.id);
          if (unit.order && unit.order.targetId === target.id) unit.order = null;
        }
      }
      return;
    }
  }

  if (unit.order && (unit.order.type === "move" || unit.order.type === "attack-move")) {
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, def.speed, dt);
    if (arrived) unit.order = null;
  }
}

function isAlive(state, id) {
  const e = getEntity(state, id);
  return !!e && e.hp > 0;
}

function acquireTarget(state, unit, def) {
  let best = null, bestD = Infinity;
  for (const e of state.units.values()) {
    if (e.owner === unit.owner) continue;
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    if (d <= def.aggroRange && d < bestD) { bestD = d; best = e; }
  }
  for (const e of state.buildings.values()) {
    if (e.owner === unit.owner) continue;
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    if (d <= def.aggroRange && d < bestD) { bestD = d; best = e; }
  }
  return best ? best.id : null;
}
