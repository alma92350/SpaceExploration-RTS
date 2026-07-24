/* ============================================================
   AI — worker assignment and the unit-mix filters. Idle-worker logistics +
   gather steering (assignAiLogistics / assignIdleWorkers), and the map-aware
   mix helpers the production phases read: which unit types this world can
   actually sustain (effectiveMix / affordableOnSurface) and which upgrade
   doctrine its economy favours (aiDoctrine). A leaf module — no dependency on
   the other AI phase modules — so aiMilitary/aiEconomy can import from it freely.
   ============================================================ */

"use strict";

import { BUILDINGS, UNITS, UPGRADES, prereqsMet } from "./entities.js";
import { assignService, assignHaul, countLogistics } from "./haul.js";
import { isNodeDiscovered } from "./fog.js";

const SATURATION_STEER = 250;     // distance-equivalent penalty per worker a node is over the soft cap

// Every commodity that anything the AI builds actually costs — computed once.
// assignIdleWorkers prefers nodes of these types so a poor-economy world's AI
// (Glacius: ice/gas it can never spend) doesn't mine dead-end commodities.
const SPENDABLE = (() => {
  const coms = new Set();
  for (const d of [...Object.values(UNITS), ...Object.values(BUILDINGS), ...Object.values(UPGRADES)])
    for (const com of Object.keys(d.cost || {})) coms.add(com);
  return coms;
})();

// Give a BOUNDED share of the AI's idle workers real logistics jobs — servicing factories (carry
// inputs in, outputs out) and hauling pure producers (the Plasma Rig) to a Command Center — reusing
// the exact owner-generic machinery the player's workers use (engine/haul.js). Capped at HALF the
// worker pool so gathering never starves: a factory with no raws mined is no better off than one with
// no servers, so the AI must keep miners on the field too. Deterministic — countLogistics freezes the
// committed slots first, then assignService/assignHaul claim the nearest free slot (ties by id).
// Odyssey-only (industry is odysseyOnly); the player's own auto-haul path (engine/sim.js) is untouched.
export function assignAiLogistics(state, workers) {
  if (!workers.length) return;
  countLogistics(state);   // fresh committed haul/service tallies before we claim any new slots this cycle
  let budget = Math.floor(workers.length / 2)
    - workers.filter(w => w.order && (w.order.type === "service" || w.order.type === "haul")).length;
  if (budget <= 0) return;
  for (const w of workers) {
    if (budget <= 0) break;
    if (w.order) continue;
    assignService(state, w);            // sets w.order to a factory service round-trip if one needs it
    if (!w.order) assignHaul(state, w); // …else haul a backed-up pure producer (the rig)
    if (w.order) budget--;
  }
}

export function assignIdleWorkers(state, workers) {
  // ODYSSEY: the AI runs REAL logistics like the player — dedicate a bounded share of workers to
  // feeding/clearing its factories and rig (finite buffers, stalls and all) before the gather pass, so
  // its industry pays the same labour cost the player's does. Skirmish has no factories → no-op there.
  if (state.endless) assignAiLogistics(state, workers);
  // Only nodes the AI actually knows about: charted surface deposits (always)
  // plus any hidden cache it has scouted. It can't send workers to a cache it
  // hasn't discovered any more than the player can.
  const live = state.map.nodes.filter(n => n.amount > 0 && isNodeDiscovered(state.fogAI, n));
  if (!live.length) return;
  const oreLive = live.filter(n => n.com === "ore");
  const otherLive = live.filter(n => n.com !== "ore" && SPENDABLE.has(n.com));
  const nodeById = state.map.nodesById || new Map(state.map.nodes.map(n => [n.id, n]));
  let secondaryMiners = 0;
  for (const w of workers) {
    const n = w.order && w.order.type === "gather" ? nodeById.get(w.order.nodeId) : null;
    if (n && n.com !== "ore" && SPENDABLE.has(n.com)) secondaryMiners++;
  }
  // Crystals/radioactives buy only optional extras (a couple of turrets, the
  // one-time upgrades, the occasional Breacher), so a small trickle funds them
  // — everyone else stays on ore, the currency the whole army and every
  // building actually run on. A flat "half on ore" split would over-divert on
  // an ore-rich world and under-fund ore on an ore-poor one; capping the
  // secondary crew keeps ore primary everywhere while still reaching the
  // extras. On a crystal-heavy map (Helix) this is what stops workers piling
  // onto crystals and starving the ore the army needs.
  const secondaryCap = Math.min(2, Math.floor(workers.length / 3));

  // Projected miner tally per node, so the AI fills a node to the soft cap and
  // then hops to the next-nearest instead of piling everyone on one seam (which
  // saturation would drop to ~0.7 efficiency, slowing the tuned economy). Seeds
  // from workers already on a gather order, and counts each assignment made in
  // this same pass so consecutive idle workers spread across nodes.
  const softCap = UNITS.worker.minerSoftCap ?? Infinity;
  const projected = new Map();
  for (const w of workers) {
    if (w.order && w.order.type === "gather") projected.set(w.order.nodeId, (projected.get(w.order.nodeId) || 0) + 1);
  }

  workers.forEach(w => {
    if (w.order) return;
    let pool;
    if (otherLive.length && oreLive.length && secondaryMiners < secondaryCap) {
      pool = otherLive; secondaryMiners++;   // fund the extras with a small crew...
    } else if (oreLive.length) {
      pool = oreLive;                         // ...but keep the bulk of workers on ore
    } else {
      pool = otherLive.length ? otherLive : live;   // ore's gone — take spendable, else any live node
    }
    let best = null, bestScore = Infinity;
    for (const n of pool) {
      const m = projected.get(n.id) || 0;
      const over = Math.max(0, m + 1 - softCap);   // penalty kicks in once the node is already at the cap
      const score = Math.hypot(n.x - w.x, n.y - w.y) + over * SATURATION_STEER;
      if (score < bestScore) { bestScore = score; best = n; }
    }
    if (best) {
      w.order = { type: "gather", nodeId: best.id };
      projected.set(best.id, (projected.get(best.id) || 0) + 1);
    }
  });
}

// The archetype's unit mix with entries this map can never pay for dropped —
// a cost commodity no SURFACE deposit produces (Vesper's surface has no
// radioactives, so its Breacher entry is skipped, leaving today's exact
// three-unit cycle). Hidden caches are deliberately excluded: they can hold a
// commodity the surface lacks, but they're far, contested, and may never be
// mined, so planning the whole cycle around one would just re-stall the mix on
// a unit the AI has no steady income for. Surface EXISTENCE, not remaining
// amount, is checked, so the surviving cycle is constant for the whole match
// (nodes drain, they never vanish) and the sequence stays deterministic. Falls
// back to plain Skiffs if the filter empties the mix entirely.
// Also drops any unit whose TECH prereqs aren't met yet (Lancer/Breacher before
// the Foundry is up), so the cycle runs Skiff/Bastion only until then and never
// stalls on a locked entry — pickNextUnitType can only ever return an unlocked,
// affordable unit. This makes the mix change ONCE, deterministically, the tick
// the Foundry completes; both the base cycle and the counter-pick (which only
// adopts a counter that mix.includes) are prereq-safe through this one filter.
export function effectiveMix(state, archetype) {
  const mix = (archetype.unitMix || []).filter(t =>
    UNITS[t]
    && BUILDINGS.barracks.produces?.includes(t)
    && prereqsMet(state, "ai", UNITS[t])
    && affordableOnSurface(state, t));
  return mix.length ? mix : ["skiff"];
}

// Can the AI pay for `unitType` from this world's STEADY income — i.e. does every
// cost commodity have a non-hidden (surface) deposit somewhere on the map? Shared
// by effectiveMix (which unit types actually cycle) and the Foundry/Arsenal
// "wants" gates below. Deliberately NOT prereq-aware: the gates use it to decide
// whether teching up would ever pay off, so folding in the building prereq would
// deadlock (you'd never build the Arsenal a gas-Wraith needs because the Wraith
// is prereq-locked until the Arsenal exists). ore/crystals/radioactives are
// seeded near every base (map.js MIN_GUARANTEE), so only the specialty commodities
// (gas/ice/relics) actually gate anything here.
export function affordableOnSurface(state, unitType) {
  const def = UNITS[unitType];
  return !!def && Object.keys(def.cost).every(com => state.map.nodes.some(n => n.com === com && !n.hidden));
}

// Which upgrade doctrine the AI commits to. It prefers its archetype's flavour
// (rusher/balanced Assault, economist Bulwark), but follows the world's economy
// when that world is clearly richer in the OTHER doctrine's commodity — Assault
// runs on radioactives, Bulwark on crystals — so it doesn't build a Refinery it
// can't actually research on a world short of its preferred commodity. Surface
// deposits only (mirrors effectiveMix): steady income, not a contested cache.
export function aiDoctrine(state, archetype) {
  const surfaceTotal = com => state.map.nodes
    .filter(n => n.com === com && !n.hidden).reduce((s, n) => s + n.max, 0);
  const rad = surfaceTotal("radioactives"), cry = surfaceTotal("crystals");
  const pref = archetype.doctrine || "assault";
  if (pref === "assault") return rad >= cry * 0.6 ? "assault" : "bulwark";
  return cry >= rad * 0.6 ? "bulwark" : "assault";
}
