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
import { queryNeighbors } from "./grid.js";
import { sampleTerrain, sideMod } from "./map.js";

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
  // AI focus-fire (engine/ai.js sets focusId when the Tactical AI is directing a
  // squad onto one target): concentrate on it while it's a live enemy inside this
  // unit's aggro. If it's dead or out of reach we fall straight through to the
  // normal dispersed auto-acquire, so a stale/too-far focus never freezes a unit.
  if (!targetId && unit.focusId && stillEngageable(state, unit, def, unit.focusId)) {
    targetId = unit.focusId;
  }
  if (!targetId) {
    // Stick to last tick's auto-target while it's still a live enemy in aggro
    // range; only when it dies or slips away do we acquire a fresh (dispersed)
    // one. Committing to a target instead of re-picking the nearest every tick
    // is what makes spread-targeting hold — otherwise the whole line would
    // re-converge on the single closest enemy each frame.
    if (unit.autoTarget && stillEngageable(state, unit, def, unit.autoTarget)) {
      targetId = unit.autoTarget;
    } else {
      targetId = acquireTarget(state, unit, def);
      unit.autoTarget = targetId;
    }
  }

  if (targetId) {
    const target = getEntity(state, targetId);
    if (target && target.hp > 0) {
      const dist = Math.hypot(target.x - unit.x, target.y - unit.y);
      if (dist > def.range) {
        // Hold stance: stand fast rather than chasing an out-of-range target —
        // fire only once something comes to us (a player-set defensive stance;
        // the AI never sets it, so this can't touch the resolve guarantee).
        if (!unit.hold) stepToward(state, unit, target.x, target.y, def.speed, dt);
      } else if (unit.attackTimer <= 0) {
        const died = performAttack(state, unit, def, target);
        unit.attackTimer = def.cooldown;
        if (died && unit.order && unit.order.targetId === target.id) unit.order = null;
      } else if (state.aiMicro && unit.owner === "ai" && def.range >= KITE_MIN_RANGE) {
        maybeKite(state, unit, def, dt);   // in range but reloading — a Tactical ranged unit stutter-steps back
      }
      return;
    }
  }

  if (unit.order && unit.order.type === "attack-move") {
    const arrived = stepToward(state, unit, unit.order.x, unit.order.y, def.speed, dt);
    if (arrived) unit.order = null;
  }
}

// Only genuinely ranged units kite (Lancer 55 / Breacher 150 / Dreadnought 68);
// short-range brawlers (Skiff 40, Bastion 24) stand and trade.
const KITE_MIN_RANGE = 50;

// Stutter-step kiting: while a ranged unit is reloading and an enemy UNIT has
// closed inside 0.75x its weapon range, it steps directly away to keep the
// distance advantage, then stops to fire the instant its weapon is ready (that's
// the branch above this one). Only ever reacts to enemy UNITS — never buildings —
// so a ranged unit shelling an undefended base never backs off, keeping the
// resolves-to-a-winner guarantee intact. The retreat point is clamped to the map
// so a cornered kiter can't walk off the edge.
function maybeKite(state, unit, def, dt) {
  const danger = def.range * 0.75;
  const threat = nearestEnemyUnitWithin(state, unit, danger);
  if (!threat) return;
  const dx = unit.x - threat.x, dy = unit.y - threat.y;
  const len = Math.hypot(dx, dy) || 1;
  let tx = unit.x + (dx / len) * 40, ty = unit.y + (dy / len) * 40;
  if (state.map) {
    tx = Math.max(0, Math.min(state.map.width, tx));
    ty = Math.max(0, Math.min(state.map.height, ty));
  }
  stepToward(state, unit, tx, ty, def.speed, dt);
}

function nearestEnemyUnitWithin(state, unit, radius) {
  const cands = state.unitGrid ? queryNeighbors(state.unitGrid, unit.x, unit.y, radius) : state.units.values();
  let best = null, bestD = Infinity;
  for (const e of cands) {
    if (e.owner === unit.owner || e.hp <= 0 || UNITS[e.type].role !== "combat") continue;
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    if (d <= radius && d < bestD) { bestD = d; best = e; }
  }
  return best;
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
    grantSalvage(state, target);
    removeEntity(state, target.id);
    state.events.push({ type: "entityKilled", x: target.x, y: target.y, owner: target.owner });
    return true;
  }
  return false;
}

// Comeback softener: when a COMBAT unit is destroyed, its owner reclaims a
// fraction of its cost as salvage. Because the side taking the heavier losses
// gets the larger refund, an army that's being ground down can rebuild faster —
// relaxing the deathball snowball where one lost engagement cascades into a loss.
// Combat units only (not workers or buildings), so it rewards standing and
// trading, not feeding the economy. Symmetric and deterministic; and since a
// passive opponent loses no units, it never fires in the resolve/determinism
// tests, leaving the resolves-to-a-winner guarantee untouched.
const SALVAGE_FRAC = 0.25;
function grantSalvage(state, target) {
  if (target.kind !== "unit") return;
  const def = UNITS[target.type];
  if (!def || def.role !== "combat" || !def.cost) return;
  const res = state.players[target.owner]?.resources;
  if (!res) return;
  for (const [com, qty] of Object.entries(def.cost)) res[com] = (res[com] || 0) + qty * SALVAGE_FRAC;
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

  // Every researched Assault upgrade (attacker side) stacks its damage-dealt
  // multiplier; every Bulwark upgrade (defender side) stacks its damage-taken
  // multiplier. Data-driven, so the doctrine tiers just work.
  const attackerUpgrades = state.players[unit.owner].upgrades;
  for (const id of Object.keys(attackerUpgrades)) {
    if (attackerUpgrades[id] && UPGRADES[id]?.damageDealtMult) dmg *= UPGRADES[id].damageDealtMult;
  }
  const defenderUpgrades = state.players[target.owner]?.upgrades;
  if (defenderUpgrades) {
    for (const id of Object.keys(defenderUpgrades)) {
      if (defenderUpgrades[id] && UPGRADES[id]?.damageTakenMult) dmg *= UPGRADES[id].damageTakenMult;
    }
  }

  // A positional edge, not a counter: an attacker firing from high ground hits
  // for a flat bonus (terrain combatMult). Situational and symmetric, so the RPS
  // triangle is untouched. OPEN / map-less states read 1.
  if (state.map?.terrain) dmg *= sampleTerrain(state.map.terrain, unit.x, unit.y).combatMult;

  return dmg;
}

// How many of the nearest in-weapon-range enemies attackers fan out across,
// instead of the whole line dogpiling the single closest. This is the softener
// for the focus-fire snowball: spreading damage lets the losing side keep its
// shooters alive longer, so engagements trade instead of ending in a near-wipe
// from a slight edge (Lanchester's square law relaxed toward a linear one).
const SPREAD_TARGETS = 3;

function isAlive(state, id) {
  const e = getEntity(state, id);
  return !!e && e.hp > 0;
}

// Still worth holding onto: a live enemy inside this unit's aggro range.
function stillEngageable(state, unit, def, id) {
  const e = getEntity(state, id);
  if (!e || e.hp <= 0) return false;
  const aggro = def.aggroRange * sideMod(state, unit.owner, "sightMult");
  return Math.hypot(e.x - unit.x, e.y - unit.y) <= aggro;
}

function hashId(id) {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

function nearestEnemy(entities, unit, maxRange) {
  let best = null, bestD = Infinity;
  for (const e of entities) {
    if (e.owner === unit.owner || e.hp <= 0) continue;   // hp>0 also skips stale dead refs a grid bucket may still hold
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    if (d <= maxRange && d < bestD) { bestD = d; best = e; }
  }
  return best ? { id: best.id, d: bestD } : null;
}

// Like nearestEnemy, but once several enemies are within weapon range it fans
// this unit onto one of the SPREAD_TARGETS nearest (chosen by a per-unit hash),
// rather than everyone locking the single closest. Still returns the plain
// nearest while closing in (nothing in weapon range yet), so units approach
// together and only spread once they can actually fire. Combined with the
// target stickiness in updateCombat, each attacker commits to its own target.
function spreadEnemy(entities, unit, def, aggro) {
  // The local engagement band — a bit past weapon range so it catches the front
  // line even in a tight melee, where almost no one has 2+ foes strictly within
  // their (often short) weapon range at once. Spreading across this band is what
  // actually reduces the dogpile.
  const band = def.range + 60;
  let nearest = null, nearestD = Infinity;
  const local = [];
  for (const e of entities) {
    if (e.owner === unit.owner || e.hp <= 0) continue;
    const d = Math.hypot(e.x - unit.x, e.y - unit.y);
    if (d > aggro) continue;
    if (d < nearestD) { nearestD = d; nearest = e; }
    if (d <= band) local.push({ e, d });
  }
  if (!nearest) return null;
  if (local.length <= 1) return { id: nearest.id, d: nearestD };   // approaching, or a lone foe — just take nearest
  local.sort((a, b) => a.d - b.d || (a.e.id < b.e.id ? -1 : 1));   // stable, deterministic order
  const pick = local[hashId(unit.id) % Math.min(local.length, SPREAD_TARGETS)];
  return { id: pick.e.id, d: pick.d };
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
  const aggro = def.aggroRange * sideMod(state, unit.owner, "sightMult");
  // Units through the broad-phase grid (there can be hundreds); buildings stay a
  // straight scan since there are only ever a handful. Full-scan fallback when
  // no grid is present (direct combat tests).
  const unitCandidates = state.unitGrid
    ? queryNeighbors(state.unitGrid, unit.x, unit.y, aggro)
    : state.units.values();
  const u = spreadEnemy(unitCandidates, unit, def, aggro);
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
