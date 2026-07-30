// @ts-check
/* ============================================================
   Worker gather/deposit loop: walk to node -> mine into cargo -> walk to
   the nearest completed drop-off -> deposit -> repeat until the node runs
   dry. A drop-off is the Command Center (see entities.js isGatherDropOff) —
   there is no forward/decentralized collection point, so every haul goes
   all the way back to a CC.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, BUILDINGS, isGatherDropOff, upgradeMult } from "./entities.js";
import { sideMod } from "./map.js";
import { hashStr } from "./rng.js";

const ORBIT_RADIUS = 16;   // workers ring the node instead of stacking on its exact center
const ARRIVE_REACH = 4;
const DROP_REACH = 30;

// Saturation: with `m` workers assigned to a node, the first `minerSoftCap`
// each mine at full rate and every extra at `minerFalloff` of a share, so the
// node's per-worker efficiency is the average. Floors above 0 (never softlocks
// a lone remaining seam). No cap field on the def (or no miner count, as in the
// direct-call unit tests) means no penalty — full rate, exactly as before.
/** @param {ResourceNode} node @param {*} def @returns {number} */
function miningEfficiency(node, def) {
  const cap = def.minerSoftCap ?? Infinity;
  const m = node.miners || 0;
  if (m <= cap) return 1;
  const extra = def.minerFalloff ?? 1;
  return (cap + (m - cap) * extra) / m;
}

// Stable per-worker angle around the node, so a group sent to the same
// node spreads out around it instead of converging on one point.
/** @param {ResourceNode} node @param {string} unitId @returns {{x:number, y:number}} */
function orbitSpot(node, unitId) {
  const angle = (hashStr(unitId) % 360) * (Math.PI / 180);
  return { x: node.x + Math.cos(angle) * ORBIT_RADIUS, y: node.y + Math.sin(angle) * ORBIT_RADIUS };
}

/** @param {State} state @param {Unit} unit @param {number} dt */
export function updateGather(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  const node = state.map.nodesById
    ? state.map.nodesById.get(order.nodeId)
    : state.map.nodes.find(n => n.id === order.nodeId);
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
    const take = Math.min(def.gatherRate * miningEfficiency(node, def) * dt, node.amount, room);
    unit.cargo.qty += take;
    node.amount -= take;
    if (unit.cargo.qty >= def.cargoCap - 1e-6 || node.amount <= 0) order.phase = "toDrop";
    return;
  }

  if (order.phase === "toDrop") {
    const drop = nearestGatherDrop(state, unit.owner, unit.x, unit.y);
    if (!drop) { unit.order = null; return; }   // no Command Center → hold the load, idle
    const dist = Math.hypot(drop.x - unit.x, drop.y - unit.y);
    if (dist <= DROP_REACH) {
      const player = state.players[unit.owner];
      // Per-side economy modifier for an asymmetric world (default 1 elsewhere):
      // a richer claim banks more per haul. The Logistics doctrine's yield upgrade
      // stacks on top (upgradeMult reads the researched upgrades).
      const banked = unit.cargo.qty
        * sideMod(state, unit.owner, "gatherMult", 1)
        * upgradeMult(player.upgrades, "gatherYieldMult");
      player.resources[unit.cargo.com] = (player.resources[unit.cargo.com] || 0) + banked;
      unit.cargo.qty = 0;
      order.phase = node.amount > 0 ? "toNode" : null;
      if (!order.phase) unit.order = null;
    } else {
      stepToward(state, unit, drop.x, drop.y, def.speed, dt);
    }
  }
}

// The nearest COMPLETED collection point a gatherer may bank a raw haul at (engine/entities.js
// isGatherDropOff — today, always the Command Center; there is no forward/decentralized
// collection point). Closest wins, deterministic Map order breaks ties. `excludeId`, when given,
// skips that one building — a defensive guard against a worker finding its own HAUL source as its
// drop target and looping (engine/haul.js updateHaul passes its own source id here); harmless
// no-op while a Command Center can never itself be a HAUL source.
/** @param {State} state @param {string} owner @param {number} x @param {number} y @param {string} [excludeId] @returns {Building|null} */
export function nearestGatherDrop(state, owner, x, y, excludeId) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || !isGatherDropOff(b.type)) continue;
    if (excludeId && b.id === excludeId) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

// The nearest COMPLETED Command Center — the treasury/warehouse. Haulage delivers to it and
// supply runs pick up from it (engine/haul.js). Null if the owner has no standing Command Center.
/** @param {State} state @param {string} owner @param {number} x @param {number} y @returns {Building|null} */
export function nearestCommandCenter(state, owner, x, y) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || !BUILDINGS[b.type].isCommandCenter) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

// A Command Center's "zone" is simply whichever of an owner's CCs sits nearest to a point — no
// stored/cached assignment, so founding or losing a CC instantly redraws every boundary on the
// very next call, with nothing to invalidate. `zoneFirst` runs a caller-supplied scan TWICE: once
// restricted to the searcher's OWN zone (candidates whose nearest CC matches the searcher's), and —
// only if that comes back empty — once more with no restriction at all, today's plain global
// search. This is how haulers/servers/ferriers (engine/haul.js) and the auto-repair Mender/worker
// repair job (engine/repair.js) all stay loyal to their own base first and only "commute" to
// another one when their own genuinely has nothing queued — the fix for a multi-base empire
// where a saturated home base used to send idle labour on long, arbitrary cross-map treks the
// instant its own ≤2-per-target caps filled up.
//
// A one-CC game (nearly every test, and most real matches before a player expands) has exactly one
// zone, so the FIRST pass's candidate set is identical to the plain global one — `scan(inZone)` and
// `scan(null)` return the exact same answer, and behaviour is byte-identical to before this existed.
// `scan(inZone)` receives either a same-zone predicate `(x,y) => boolean` or `null` (no restriction);
// it does its own candidate loop/tie-break and returns its best match or null either way.
//
// `homeId`, when given, is a PLAYER-ASSIGNED override (`unit.homeCC`, engine/commands.js
// issueSetHomeBase — a right-click on a Command Center with eligible units selected) that wins over
// the usual "nearest CC by distance" guess: the player decides which base's territory a worker/
// Mender/freighter stays loyal to, not just raw distance. A stale override (its CC destroyed, or
// never valid) is ignored and this falls straight back to the distance guess — self-healing, same
// "never cache, recompute from state" shape as everything else here.
//
// The two cases behave differently once the home zone comes up EMPTY, by design:
//   - No override (or a stale one): the distance guess is just a heuristic, not a commitment, so an
//     empty home zone still widens to the whole empire — today's plain global search, a last resort.
//   - A VALID explicit override: the player deliberately assigned this base, so it's a hard
//     boundary, not a suggestion. An empty zone returns null (no job) rather than reaching into
//     another base's territory — the unit just waits for its OWN zone to need something, until the
//     player reassigns it to a different Command Center or clears the override outright.
/** @param {State} state @param {string} owner @param {number} x @param {number} y
 *  @param {(inZone: ((ex:number, ey:number) => boolean)|null) => *} scan @param {string} [homeId]
 *  @returns {*} */
export function zoneFirst(state, owner, x, y, scan, homeId) {
  const overrideCC = homeId ? state.buildings.get(homeId) : null;
  const pinned = !!(overrideCC && overrideCC.owner === owner && !overrideCC.constructing && BUILDINGS[overrideCC.type]?.isCommandCenter);
  const home = pinned ? overrideCC : nearestCommandCenter(state, owner, x, y);
  if (!home) return scan(null);
  const inZone = (ex, ey) => nearestCommandCenter(state, owner, ex, ey) === home;
  const result = scan(inZone);
  if (result != null) return result;
  return pinned ? null : scan(null);
}
