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
import { UNITS, BUILDINGS, UPGRADES } from "./entities.js";
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
        const died = performAttack(state, unit, def, target);
        unit.attackTimer = def.cooldown;
        if (died && unit.order && unit.order.targetId === target.id) unit.order = null;
      }
      return;
    }
  }

  if (unit.order && unit.order.type === "attack-move") {
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, def.speed, dt);
    if (arrived) unit.order = null;
  }
}

// Returns true if the target died. Shared by mobile units and turrets so
// upgrade multipliers and kill/event bookkeeping stay in exactly one place.
// The attackHit event carries both endpoints and the attacker's type so
// render.js can draw a tracer from shooter to target (a turret reads as
// its own "turret" type), and `heavy` so a siege hit thumps deeper.
function performAttack(state, attacker, def, target) {
  target.hp -= attackDamage(state, attacker, def, target);
  state.events.push({
    type: "attackHit", x: target.x, y: target.y,
    fromX: attacker.x, fromY: attacker.y, unitType: attacker.type, owner: attacker.owner,
    heavy: !!(def.bonusVsBuildings && target.kind === "building"),
  });
  if (target.hp <= 0) {
    removeEntity(state, target.id);
    state.events.push({ type: "entityKilled", x: target.x, y: target.y, owner: target.owner });
    return true;
  }
  return false;
}

// Workers can fight, but only on an explicit 'attack' order — they never
// auto-acquire (that's the whole point of keeping them on the economy), so
// this handles just the ordered case: close to the target, strike on cooldown
// with the worker's weak stats (entities.js), and drop the order when it dies
// so a queued waypoint (or idle) takes over. Reuses the same performAttack as
// real combat units, so a worker's hit shows a tracer and plays its sound too.
export function updateWorkerCombat(state, unit, def, dt) {
  unit.attackTimer = Math.max(0, unit.attackTimer - dt);
  const targetId = unit.order.targetId;
  if (!isAlive(state, targetId)) { unit.order = null; return; }

  const target = getEntity(state, targetId);
  const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
  if (dist > def.range) {
    stepToward(state, unit, target.x, target.y, def.speed, dt);
  } else if (unit.attackTimer <= 0) {
    const died = performAttack(state, unit, def, target);
    unit.attackTimer = def.cooldown;
    if (died) unit.order = null;
  }
}

// Bonus-vs-type is a flat add (a specific hard counter), while researched
// Refinery upgrades (entities.js's UPGRADES) are multipliers applied on
// top — one on the attacker's side (damage dealt), one on the
// defender's (damage taken) — so both sides' research matters on every
// single hit, not just for units built after researching.
function attackDamage(state, unit, def, target) {
  const bonus = def.bonusVs && def.bonusVs[target.type] || 0;
  // Siege class (Breacher) hits every building for a flat class-wide bonus
  // via bonusVsBuildings — kept separate from bonusVs (which is a hard
  // counter to one unit type) so new buildings need no per-type entries.
  const structureBonus = target.kind === "building" ? (def.bonusVsBuildings || 0) : 0;
  let dmg = def.attack + bonus + structureBonus;

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

function nearestEnemy(entities, unit, maxRange) {
  let best = null, bestD = Infinity;
  for (const e of entities) {
    if (e.owner === unit.owner) continue;
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    if (d <= maxRange && d < bestD) { bestD = d; best = e; }
  }
  return best ? { id: best.id, d: bestD } : null;
}

// Default policy is nearest-of-anything, with exact ties going to units
// (they're scanned first, so an equal-distance building never displaces a
// unit already chosen). prefersBuildings flips that for siege: shell
// structures inside aggro even when a unit stands closer, falling back to
// the nearest unit only when no building is in range.
function acquireTarget(state, unit, def) {
  // The same sight modifier that scales fog reveal also scales how far a unit
  // (or turret) reaches out to acquire — so a storm-shortened world bites both
  // sides' aggro symmetrically. Optional-chained for map-less test states.
  const aggro = def.aggroRange * (state.map?.modifiers?.sightMult ?? 1);
  const u = nearestEnemy(state.units.values(), unit, aggro);
  const b = nearestEnemy(state.buildings.values(), unit, aggro);
  if (def.prefersBuildings && b) return b.id;
  if (!u) return b ? b.id : null;
  if (!b) return u.id;
  return u.d <= b.d ? u.id : b.id;
}

// Static defense: a completed building with an attack stat (Sentinel
// Turret) acquires and fires like a unit that can never move — it only
// engages inside its own range (aggroRange === range by definition) and
// never chases. Buildings have no order pipeline, so there is no
// player-directed focus fire; nearest-enemy is the whole policy.
export function updateBuildingCombat(state, building, dt) {
  const def = BUILDINGS[building.type];
  if (!def.attack) return;
  if (building.constructing) { building.targetId = null; return; }

  building.attackTimer = Math.max(0, building.attackTimer - dt);
  building.targetId = acquireTarget(state, building, def);
  if (!building.targetId || building.attackTimer > 0) return;

  const target = getEntity(state, building.targetId);
  performAttack(state, building, def, target);
  building.attackTimer = def.cooldown;
}
