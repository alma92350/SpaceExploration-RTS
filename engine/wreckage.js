// @ts-check
/* ============================================================
   Battle wreckage: nothing is really destroyed. A unit or building killed in
   ordinary combat (engine/combat.js) or by a Helium Bomb blast (engine/bomb.js)
   doesn't just vanish — it leaves behind ~80% of its own construction materials,
   which settle into real, mineable ResourceNodes a short delay later, the same
   "explosion -> consolidated mine" shape the Helium Bomb's own crater already
   uses (engine/bomb.js's spawnCraterNode). Unlike a crater (one random Raw-tier
   commodity, unrelated to what was destroyed), a wreck site returns exactly what
   was actually spent on the thing that died — usually more than one commodity
   (a Dreadnought costs ore AND radioactives) — so "a consolidated mine" here
   means a small CLUSTER of single-commodity nodes at one site, not one node
   (ResourceNode.com is a single commodity; a unit/building's `cost` is a dict).

   CONSOLIDATION: nearby deaths pool into the SAME site instead of each leaving
   its own tiny deposit. When something dies, its 80%-of-cost goods merge into
   an existing pending site within WRECK_MERGE_RADIUS (the nearest one, ties
   broken by lower id — see nearestWreckSite), or open a fresh site there. This
   is proximity-based, not a fixed grid, so one real fight's spread of kills
   reads as one battlefield while two unrelated fights across the map stay
   separate. A site's spawnAt is set by the FIRST death that opens it and is
   never extended by later contributions — kept simple, same as a Helium Bomb
   crater's own timer.

   NEUTRAL, LIKE ANY OTHER DEPOSIT: a wreck site carries no owner — first
   worker there mines it, same as every ResourceNode engine/map.js generates.
   Holding the ground after a fight is what earns the loot, not which side lost
   the units.

   This REPLACES the old instant, combat-unit-only salvage refund (formerly
   grantSalvage/SALVAGE_FRAC in engine/combat.js): that mechanic refunded 25%
   of a combat unit's cost straight to its OWNER on the spot, and gave workers
   and buildings nothing at all. depositWreckage below is the one place every
   death path funnels through — engine/combat.js's performAttack (an ordinary
   kill) AND engine/bomb.js's detonateBomb (a blast kill) both call it — so a
   unit, worker, or building dying any way at all leaves the same wreckage. A
   Helium-Bomb-blast kill leaves wreckage too now, stacking with the bomb's own
   separate crater.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { hashStr } from "./rng.js";

// Share of a destroyed thing's own construction cost that reappears as minable wreckage.
export const WRECK_RETURN_FRAC = 0.8;

// How close a death has to land to an already-pending wreck site to merge into it rather
// than opening a new one — comparable to the longer weapon/aggro ranges already in the
// roster (Breacher's 150 range, Colossus's 185), so one engagement's spread of kills
// realistically lands inside a single site.
export const WRECK_MERGE_RADIUS = 140;

// How long (sim seconds — state.time, not wall clock) after the first death at a site
// its wreckage takes to settle into real, mineable nodes. Shorter than the Helium Bomb
// crater's 60s (CRATER_SPAWN_DELAY, engine/bomb.js) — an ordinary battle is a far more
// frequent, smaller-scale event than a doomsday device going off.
export const WRECK_SPAWN_DELAY = 45;

// Cosmetic spread of a matured site's per-commodity nodes around its centroid, so a
// 2-3 commodity wreck reads as a small debris field instead of stacked identical-position
// nodes. Deterministic (hashStr-derived — no engine randomness, see engine/rng.js).
const WRECK_NODE_SPREAD_MIN = 18;
const WRECK_NODE_SPREAD_MAX = 40;

// The nearest pending wreck site to (x,y) within WRECK_MERGE_RADIUS, or null if none
// qualifies. Ties (an equal-distance pair, e.g. two sites opened the same tick) resolve
// to the lower id, so the result never depends on state.wrecks' array order.
function nearestWreckSite(wrecks, x, y) {
  let best = null, bestD = Infinity;
  for (const w of wrecks) {
    const d = Math.hypot(w.x - x, w.y - y);
    if (d > WRECK_MERGE_RADIUS) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && (!best || w.id < best.id))) { best = w; bestD = d; }
  }
  return best;
}

// Merge `entity`'s recovered goods (already scaled by WRECK_RETURN_FRAC) into the nearest
// qualifying pending site — folding its position into the site's running centroid — or
// open a new one at its position.
function mergeIntoWreckSite(state, entity, goods) {
  const wrecks = state.wrecks || (state.wrecks = []);
  const site = nearestWreckSite(wrecks, entity.x, entity.y);
  if (site) {
    site.x = (site.x * site.n + entity.x) / (site.n + 1);
    site.y = (site.y * site.n + entity.y) / (site.n + 1);
    site.n += 1;
    for (const com of Object.keys(goods)) site.goods[com] = (site.goods[com] || 0) + goods[com];
    return;
  }
  // Namespaced off the first contributing entity's own (globally-unique) id — the same
  // reasoning engine/bomb.js's `crater-${bomb.id}` already documents: guaranteed never to
  // collide with a map-generated node's "n<N>" scheme, and stable regardless of how many
  // more deaths merge into this site later.
  wrecks.push({
    id: `wreck-${entity.id}`, x: entity.x, y: entity.y, n: 1,
    goods: { ...goods }, spawnAt: state.time + WRECK_SPAWN_DELAY,
  });
}

// Call from every death path (engine/combat.js's performAttack, engine/bomb.js's
// detonateBomb) — BEFORE removeEntity, since this reads the dying entity's own position
// and type. A no-cost entity (e.g. the scenario-only Freighter, cost: {}) or an unknown
// type contributes nothing and is a harmless no-op.
/** @param {State} state @param {Unit|Building} entity */
export function depositWreckage(state, entity) {
  const def = (entity.kind === "building" ? BUILDINGS : UNITS)[entity.type];
  if (!def || !def.cost) return;
  const goods = {};
  for (const [com, qty] of Object.entries(def.cost)) {
    const amt = qty * WRECK_RETURN_FRAC;
    if (amt > 0) goods[com] = amt;
  }
  if (!Object.keys(goods).length) return;
  mergeIntoWreckSite(state, entity, goods);
}

// Per-tick check (engine/sim.js, once per tick — not per-entity): matures every pending
// wreck site whose timer has come due this tick. Mutates state.wrecks/state.map in place;
// nothing to return. Mirrors engine/bomb.js's updateCraters exactly.
/** @param {State} state */
export function updateWreckage(state) {
  if (!state.wrecks || !state.wrecks.length) return;
  const ready = state.wrecks.filter(w => state.time >= w.spawnAt);
  if (!ready.length) return;
  state.wrecks = state.wrecks.filter(w => state.time < w.spawnAt);
  for (const site of ready) spawnWreckNodes(state, site);
}

// Turn one matured site into one plain ResourceNode (engine/types.js) PER commodity it
// accumulated — indistinguishable to gather.js/rendering/fog from anything engine/map.js
// generated, except for the `wreck: true` tag persist.js uses to know it needs full
// serialization (see engine/bomb.js's identical `crater` tag). Each node is offset from
// the site's centroid by a small deterministic jitter so a multi-commodity wreck reads as
// a small debris field rather than stacked identical-position nodes.
function spawnWreckNodes(state, site) {
  const coms = Object.keys(site.goods).filter(com => site.goods[com] > 0);
  if (!coms.length) return;
  const spawned = [];
  for (const com of coms) {
    const amount = site.goods[com];
    const id = `${site.id}-${com}`;
    const h = hashStr(id);
    const angle = (h % 360) * (Math.PI / 180);
    const dist = WRECK_NODE_SPREAD_MIN + ((h % 100) / 100) * (WRECK_NODE_SPREAD_MAX - WRECK_NODE_SPREAD_MIN);
    const node = {
      id, com, amount, max: amount,
      // No bounds clamping — same as engine/bomb.js's spawnCraterNode, which places its own
      // node at the exact blast center with no such check: a dying entity is always within
      // the map already, so the only way this could land outside it is a jitter offset (at
      // most WRECK_NODE_SPREAD_MAX) pushing a death right at the edge a little further out,
      // a harmless, rare cosmetic case not worth a special-case for.
      x: site.x + Math.cos(angle) * dist,
      y: site.y + Math.sin(angle) * dist,
      wreck: true,
    };
    state.map.nodes.push(node);
    if (state.map.nodesById) state.map.nodesById.set(node.id, node);
    spawned.push(com);
  }
  state.events.push({ type: "wreckMatured", x: site.x, y: site.y, coms: spawned });
}
