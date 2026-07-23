// @ts-check
/* ============================================================
   Worker gather/deposit loop: walk to node -> mine into cargo -> walk to
   the nearest completed drop-off -> deposit -> repeat until the node runs
   dry. A drop-off is the Command Center OR any industrial building that
   proxies it (Refinery, Foundry, Arsenal — see entities.js isDropOff), so
   a forward industrial building shortens a distant haul without a full CC.
   ============================================================ */

"use strict";

import { stepToward } from "./movement.js";
import { UNITS, BUILDINGS, isGatherDropOff, storeRoom, upgradeMult } from "./entities.js";
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
    if (!drop) { unit.order = null; return; }   // no collection point with room (and no CC) → hold the load, idle
    const dist = Math.hypot(drop.x - unit.x, drop.y - unit.y);
    if (dist <= DROP_REACH) {
      const player = state.players[unit.owner];
      // Per-side economy modifier for an asymmetric world (default 1 elsewhere):
      // a richer claim banks more per haul. The Logistics doctrine's yield upgrade
      // stacks on top (upgradeMult reads the researched upgrades).
      const banked = unit.cargo.qty
        * sideMod(state, unit.owner, "gatherMult", 1)
        * upgradeMult(player.upgrades, "gatherYieldMult");
      // A PLAYER forward drop-off (Refinery/Foundry/Arsenal) has a FINITE intake buffer that
      // workers must haul to the Command Center (engine/haul.js). Bank what fits into it; the
      // Command Center (and every AI drop-off) is the bottomless treasury as before. Any
      // overflow rides on in the cargo — the gatherer reroutes to another drop-off next tick.
      if (unit.owner === "player" && !BUILDINGS[drop.type].isCommandCenter) {
        const put = Math.min(banked, storeRoom(drop));
        drop.store = drop.store || {};
        drop.store[unit.cargo.com] = (drop.store[unit.cargo.com] || 0) + put;
        unit.cargo.qty -= banked > 0 ? unit.cargo.qty * (put / banked) : unit.cargo.qty;
        if (unit.cargo.qty <= 1e-6) unit.cargo.qty = 0;
      } else {
        player.resources[unit.cargo.com] = (player.resources[unit.cargo.com] || 0) + banked;
        unit.cargo.qty = 0;
      }
      if (unit.cargo.qty <= 1e-6) {
        order.phase = node.amount > 0 ? "toNode" : null;
        if (!order.phase) unit.order = null;
      }
      // else: a partial deposit left cargo on board → stay in toDrop and reroute next tick.
    } else {
      stepToward(state, unit, drop.x, drop.y, def.speed, dt);
    }
  }
}

// The nearest COMPLETED collection point a gatherer may bank a raw haul at: its own Command
// Center or a pure forward drop-off (Refinery/Foundry/Arsenal — engine/entities.js
// isGatherDropOff). A PLAYER's forward drop-off has a finite intake buffer, so a FULL one is
// skipped and the gatherer reroutes to the next-nearest with room (the Command Center never
// fills). AI drop-offs are the bottomless treasury as before — so AI gather routing is
// byte-identical. Closest wins, deterministic Map order breaks ties.
/** @param {State} state @param {string} owner @param {number} x @param {number} y @returns {Building|null} */
function nearestGatherDrop(state, owner, x, y) {
  let best = null, bestD = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing || !isGatherDropOff(b.type)) continue;
    if (owner === "player" && !BUILDINGS[b.type].isCommandCenter && storeRoom(b) <= 0) continue;   // full forward buffer → skip
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}

// The nearest COMPLETED Command Center — the treasury/warehouse. Haulage delivers to it and
// supply runs pick up from it (engine/haul.js), so goods flow through the CC, not sideways
// between forward drop-offs. Null if the owner has no standing Command Center.
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
