/* ============================================================
   Scripted AI opponent: keep workers on the nearest spendable node, keep
   population growing, put up a Barracks once it can afford one, then cycle
   through its archetype's unit mix (Skiff/Bastion/Lancer/Breacher — see
   entities.js for the rock-paper-scissors relationship) across every
   Barracks it owns, and throw the whole army at the player's base once it's
   big enough (or the game's dragged on long enough that it should commit
   anyway). Along the way it fortifies with Sentinel Turrets on the approach
   vector, expands to a second Command Center when its home ore runs thin,
   puts up a Refinery, and researches both upgrades — so the player isn't the
   only side that gets to use crystals/radioactives, expansions, or defenses.

   How aggressively vs. how patiently it plays — worker/army targets, attack
   timing, unit mix, how many turrets and barracks, when to expand — all comes
   from state.aiArchetype (see engine/aiArchetypes.js), which is picked by
   which planet the match is on. This file just executes whatever profile it's
   handed; every Tier 4 field is read with a use-site default so a legacy
   profile that predates them still runs.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueAttackMove } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford } from "./entities.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;

const HOME_RADIUS = 420;          // nodes this close to an AI CC count as "home" economy
const CLAIM_RADIUS = 260;         // a cluster with any CC this close is already claimed
const CLUSTER_RADIUS = 160;       // nodes within this of an anchor sum into its cluster score
const EXPANSION_STANDOFF = 70;    // CC-to-anchor-node placement distance (26 CC radius + 16 node radius + clearance)
const BARRACKS_BUFFER = 150;      // bank kept when adding a barracks so the mix doesn't starve

// Every commodity that anything the AI builds actually costs — computed once.
// assignIdleWorkers prefers nodes of these types so a poor-economy world's AI
// (Glacius: ice/gas it can never spend) doesn't mine dead-end commodities.
const SPENDABLE = (() => {
  const coms = new Set();
  for (const d of [...Object.values(UNITS), ...Object.values(BUILDINGS), ...Object.values(UPGRADES)])
    for (const com of Object.keys(d.cost || {})) coms.add(com);
  return coms;
})();

export function runAI(state, dt) {
  state.aiThink = (state.aiThink || 0) - dt;
  if (state.aiThink > 0) return;
  state.aiThink = THINK_INTERVAL;

  const archetype = state.aiArchetype;
  const ai = state.players.ai;
  const workers = playerUnits(state, "ai").filter(u => u.type === "worker");
  const army = playerUnits(state, "ai").filter(u => UNITS[u.type].role === "combat");
  const buildings = playerBuildings(state, "ai");
  const cc = buildings.find(b => b.type === "command" && !b.constructing);
  const barracks = buildings.find(b => b.type === "barracks");
  const refinery = buildings.find(b => b.type === "refinery");
  const allBarracks = buildings.filter(b => b.type === "barracks");
  let oreReserve = 0;

  assignIdleWorkers(state, workers);

  // EXPANSION: once home ore runs thin, plant a second Command Center on the
  // richest unclaimed cluster. Runs before every ore-spending block so it can
  // reserve the CC's cost (oreReserve) and keep the unit mix / a second
  // barracks / the refinery from draining the bank the expansion needs. At
  // most one expansion in flight — no stacking a third CC while one builds.
  const ccCost = BUILDINGS.command.cost.ore;
  const threshold = archetype.expandWhenNodesBelow || 0;
  if (threshold > 0 && cc && workers.length > 0
      && !buildings.some(b => b.type === "command" && b.constructing)) {
    const myCCs = buildings.filter(b => b.type === "command" && !b.constructing);
    if (homeOreFraction(state, myCCs) < threshold) {
      const anchor = bestExpansionCluster(state, myCCs);
      if (anchor) {
        oreReserve = ccCost;   // gate units / 2nd barracks / refinery this think
        if (ai.resources.ore >= ccCost) {
          const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // place on the home side of the cluster
          const spot = findPlacement(state, "command",
            anchor.x + Math.cos(toward) * EXPANSION_STANDOFF,
            anchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
          if (spot) { issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "command", spot.x, spot.y); oreReserve = 0; }
        }
      }
    }
  }

  if (cc && workers.length < archetype.workerTarget && cc.queue.length === 0) {
    queueProduction(state, cc.id, "worker");
  }

  // Near the cap (or over it after losing a Habitat) with none already
  // going up: put down a Habitat by the CC, or production stalls forever.
  // The `>= cap - 2` fires before a 2-supply unit can wedge the mix cycle
  // (the AI retries the same mix entry until it succeeds), and the same
  // condition covers the destroyed-Habitat over-cap case.
  const used = supplyUsed(state, "ai"), cap = supplyCap(state, "ai");
  const habitatConstructing = buildings.some(b => b.type === "habitat" && b.constructing);
  if (cc && workers.length > 0 && used >= cap - 2 && !habitatConstructing
      && canAfford(ai.resources, BUILDINGS.habitat.cost)) {
    const spot = findPlacement(state, "habitat", cc.x, cc.y + 90);
    if (spot) issueBuild(state, workers[0].id, "habitat", spot.x, spot.y);
  }

  // Build spots are fixed offsets from the CC, so anything already sitting
  // there (a node, an earlier building) would make issueBuild reject the
  // same spot every think cycle and stall the build order forever —
  // findPlacement slides the request to the nearest valid ground instead.
  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y - 90);
    if (spot) issueBuild(state, workers[0].id, "barracks", spot.x, spot.y);
  }

  // One shared production cycle across every completed Barracks: consecutive
  // barracks pick up consecutive mix entries, so two of them drain the same
  // sequence twice as fast rather than each running its own. Map insertion
  // order keeps the pick deterministic. canAffordKeeping honors the expansion
  // reserve so banking for a CC pauses the mix instead of starving it.
  const mix = effectiveMix(state, archetype);
  for (const b of allBarracks) {
    if (b.constructing || b.queue.length > 0) continue;
    const nextType = mix[(state.aiUnitsBuilt || 0) % mix.length];
    if (!canAffordKeeping(ai.resources, UNITS[nextType].cost, oreReserve)) continue;
    if (queueProduction(state, b.id, nextType)) {
      state.aiUnitsBuilt = (state.aiUnitsBuilt || 0) + 1;
    }
  }

  // Sentinel Turrets straddling the approach lane between the CC and mid-map,
  // alternating sides and stepping outward as they multiply. Crystals-funded,
  // so it's outside the ore expansion reserve; inert on crystal-less worlds
  // (canAfford simply never passes there — accepted flavor).
  if (cc && barracks && workers.length > 0) {
    const turrets = buildings.filter(b => b.type === "turret");
    if (turrets.length < (archetype.turretCount || 0) && canAfford(ai.resources, BUILDINGS.turret.cost)) {
      const mx = state.map.width / 2, my = state.map.height / 2;
      const len = Math.hypot(mx - cc.x, my - cc.y) || 1;
      const dx = (mx - cc.x) / len, dy = (my - cc.y) / len;   // the approach vector
      const i = turrets.length, side = i % 2 === 0 ? 1 : -1;
      const spot = findPlacement(state, "turret",
        cc.x + dx * (140 + 80 * i) - dy * 30 * side,
        cc.y + dy * (140 + 80 * i) + dx * 30 * side);
      if (spot) issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "turret", spot.x, spot.y);
    }
  }

  // A second Barracks once the first is up and the mix has a comfortable
  // buffer on top of any expansion reserve (allBarracks counts constructing
  // ones, so it never founds a third while the second is still going up).
  if (barracks && !barracks.constructing && cc && workers.length > 0
      && allBarracks.length < (archetype.maxBarracks || 1)
      && canAffordKeeping(ai.resources, BUILDINGS.barracks.cost, oreReserve + BARRACKS_BUFFER)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y + 90);
    if (spot) issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "barracks", spot.x, spot.y);
  }

  // Refinery — reserve-aware, and cc-guarded: cc is the completed-only find,
  // so once the AI can expand, a home CC destroyed mid-expansion leaves cc
  // undefined; without the guard cc.x below would throw.
  if (!refinery && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.refinery.cost, oreReserve)) {
    const spot = findPlacement(state, "refinery", cc.x - 90, cc.y - 90);
    if (spot) issueBuild(state, workers[0].id, "refinery", spot.x, spot.y);
  }

  if (refinery && !refinery.constructing) {
    for (const upgradeId of Object.keys(UPGRADES)) {
      if (ai.upgrades[upgradeId]) continue;
      if (researchUpgrade(state, refinery.id, upgradeId)) break;   // one purchase per think cycle is plenty
    }
  }

  const readyToAttack = army.length >= archetype.armyAttackSize || state.time > archetype.attackTimeout;
  if (readyToAttack && army.length > 0 && !state.aiAttacked) {
    const target = state.map.bases.player;
    issueAttackMove(army, target.x, target.y);
    state.aiAttacked = true;
  }
}

function assignIdleWorkers(state, workers) {
  const live = state.map.nodes.filter(n => n.amount > 0);
  if (!live.length) return;
  // Prefer nodes whose commodity the AI can actually spend; only fall back to
  // whatever's live if the map has no spendable node left at all.
  const useful = live.filter(n => SPENDABLE.has(n.com));
  const nodes = useful.length ? useful : live;
  workers.forEach(w => {
    if (w.order) return;
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best) w.order = { type: "gather", nodeId: best.id };
  });
}

// Fraction of home ore still in the ground: remaining/max summed over every
// ore node within HOME_RADIUS of one of this AI's Command Centers. No home ore
// at all reads as fully depleted — which is exactly what should trigger the
// first expansion the moment the starting seam runs dry.
function homeOreFraction(state, ccs) {
  let amt = 0, max = 0;
  for (const n of state.map.nodes) {
    if (n.com !== "ore") continue;
    if (!ccs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= HOME_RADIUS)) continue;
    amt += n.amount; max += n.max;
  }
  return max > 0 ? amt / max : 0;
}

// The ore node worth expanding to: richest surrounding cluster of live nodes,
// lightly penalized by distance from home so the AI grabs its own side first
// and only reaches across the map once the near ore is claimed or dry. Skips
// anchors already inside CLAIM_RADIUS of any CC (either owner, incl. those
// still under construction). Returns null when every live cluster is claimed —
// which is what keeps the reserve from ever engaging in a no-room deadlock.
function bestExpansionCluster(state, myCCs) {
  const allCCs = [...state.buildings.values()].filter(b => b.type === "command");
  let best = null, bestScore = -Infinity;
  for (const n of state.map.nodes) {
    if (n.com !== "ore" || n.amount <= 0) continue;                                 // anchor on live ore
    if (allCCs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= CLAIM_RADIUS)) continue;
    let cluster = 0;
    for (const m of state.map.nodes)
      if (m.amount > 0 && Math.hypot(m.x - n.x, m.y - n.y) <= CLUSTER_RADIUS) cluster += m.amount;
    const dHome = Math.min(...myCCs.map(c => Math.hypot(c.x - n.x, c.y - n.y)));
    const score = cluster - 0.2 * dHome;   // richness first; keeps it on its own side unless dry
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

// canAfford, but treating `oreReserve` ore as untouchable — used to bank for
// an expansion Command Center without letting the unit mix or a second
// barracks spend the ore out from under it.
function canAffordKeeping(resources, cost, oreReserve) {
  return Object.entries(cost).every(([com, qty]) =>
    (resources[com] || 0) - (com === "ore" ? oreReserve : 0) >= qty);
}

// The archetype's unit mix with entries this map can never pay for dropped —
// a cost commodity that no node on the map produces (Vesper has no
// radioactives, so its Breacher entry is skipped, leaving today's exact
// three-unit cycle). EXISTENCE, not remaining amount, is checked, so the
// surviving cycle is constant for the whole match (nodes drain, they never
// vanish) and the sequence stays deterministic. Falls back to plain Skiffs if
// the filter empties the mix entirely.
function effectiveMix(state, archetype) {
  const mix = (archetype.unitMix || []).filter(t =>
    UNITS[t]
    && BUILDINGS.barracks.produces?.includes(t)
    && Object.keys(UNITS[t].cost).every(com => state.map.nodes.some(n => n.com === com)));
  return mix.length ? mix : ["skiff"];
}

// Nearest free worker to (x, y) to found a building, skipping any already
// mid-build so an in-progress site keeps its founder. Falls back to
// workers[0] — buildings self-construct at rate 1 even with nobody on-site,
// so a slightly-worse builder pick is never a stall.
function pickBuilder(workers, x, y) {
  let best = workers[0], bestD = Infinity;
  for (const w of workers) {
    if (w.order && w.order.type === "build") continue;   // don't churn an assigned builder
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}
