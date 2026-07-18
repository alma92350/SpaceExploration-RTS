/* ============================================================
   Combat-role units (Skiff, Bastion): auto-acquire the nearest enemy
   within aggro range, close to weapon range, and fire on cooldown. An
   explicit 'attack' order pins the target; 'attack-move' auto-engages
   anything encountered en route to its destination. A unit type's
   bonusVs table (entities.js) adds extra damage against a specific
   target type — Bastion's slow, short-range bulk is built to punch
   through Skiff hulls specifically.

   A plain 'move' order is the deliberate exception: it's how a player
   pulls a unit OUT of a fight or redirects it past a threat, so it
   skips auto-acquire entirely rather than getting silently overridden
   the moment an enemy wanders into aggro range.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, UPGRADES } from "./entities.js";
import { getEntity, removeEntity } from "./state.js";

export function updateCombat(state, unit, dt) {
  const def = UNITS[unit.type];
  unit.attackTimer = Math.max(0, unit.attackTimer - dt);

  if (unit.order && unit.order.type === "move") {
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, def.speed, dt);
    if (arrived) unit.order = null;
    return;
  }

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
        target.hp -= attackDamage(state, unit, def, target);
        unit.attackTimer = def.cooldown;
        state.events.push({ type: "attackHit", x: target.x, y: target.y, owner: unit.owner });
        if (target.hp <= 0) {
          removeEntity(state, target.id);
          state.events.push({ type: "entityKilled", x: target.x, y: target.y, owner: target.owner });
          if (unit.order && unit.order.targetId === target.id) unit.order = null;
        }
      }
      return;
    }
  }

  if (unit.order && unit.order.type === "attack-move") {
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, def.speed, dt);
    if (arrived) unit.order = null;
  }
}

// Bonus-vs-type is a flat add (a specific hard counter), while researched
// Refinery upgrades (entities.js's UPGRADES) are multipliers applied on
// top — one on the attacker's side (damage dealt), one on the
// defender's (damage taken) — so both sides' research matters on every
// single hit, not just for units built after researching.
function attackDamage(state, unit, def, target) {
  const bonus = def.bonusVs && def.bonusVs[target.type] || 0;
  let dmg = def.attack + bonus;

  const attackerUpgrades = state.players[unit.owner].upgrades;
  if (attackerUpgrades.overchargedWeapons) dmg *= UPGRADES.overchargedWeapons.damageDealtMult;

  const defenderUpgrades = state.players[target.owner]?.upgrades;
  if (defenderUpgrades?.reinforcedPlating) dmg *= UPGRADES.reinforcedPlating.damageTakenMult;

  return dmg;
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
