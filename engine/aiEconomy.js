/* ============================================================
   AI — the economic build order: (re)seat a base from a colony ship, expand to
   fresh ore, raise workers/supply/Barracks and the Foundry+Arsenal tech gates,
   run the shared unit-production cycle with Turrets and forward Refineries, and
   research the doctrine. Depends on aiCommon (budget + affordability), aiWorkers
   (affordableOnSurface / aiDoctrine) and aiMilitary (pickNextUnitType); nothing
   depends back on this module, so the import graph stays acyclic.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueMove } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, isDropOff } from "./entities.js";
import { recipeOf } from "./industry.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { isNodeDiscovered } from "./fog.js";
import { playerUnits } from "./state.js";
import { deployColonyShip } from "./colony.js";
import { canAct, spend, canAffordKeeping, pickBuilder } from "./aiCommon.js";
import { affordableOnSurface, aiDoctrine } from "./aiWorkers.js";
import { pickNextUnitType } from "./aiMilitary.js";

const HOME_RADIUS = 420;          // nodes this close to an AI CC count as "home" economy
const CLAIM_RADIUS = 260;         // a cluster with any CC this close is already claimed
const CLUSTER_RADIUS = 160;       // nodes within this of an anchor sum into its cluster score
const EXPANSION_STANDOFF = 70;    // CC-to-anchor-node placement distance (26 CC radius + 16 node radius + clearance)
const BARRACKS_BUFFER = 150;      // bank kept when adding a barracks so the mix doesn't starve
const FORWARD_DROP_MIN = 360;     // ore worked this far from every drop-off is worth a forward Refinery drop-off
const MAX_AI_REFINERIES = 3;      // hard cap so forward drop-offs never run away with the AI's ore
const COLONY_ARRIVE = 40;         // Odyssey: an in-flight colony ship this close to its target deploys (ai.js expansion)

// Odyssey found/survive: no Command Center but a colony ship in hand -> deploy in place. Budget-exempt so even a 1-APM neighbour always seats a base (else it mis-reads as pacified). Skirmish: colonyShip is null -> no-op.
/** @param {State} state @param {AiContext} ctx */
export function aiFoundOrSurvive(state, ctx) {
  const { cc, colonyShip } = ctx;
  // ODYSSEY — FOUND / SURVIVE: no Command Center but a colony ship in hand → deploy in
  // place to (re)found the base. Covers the opening AND being razed to a lone ship. It's
  // EXEMPT from the APM budget (like the attack commit) so even a 1-APM neighbour always
  // seats a base and the world progresses (otherwise a base-less AI mis-reads as pacified,
  // engine/galaxy.js). Runs first, at top priority. Skirmish: colonyShip is null → no-op.
  if (state.endless && !cc && colonyShip) {
    if (deployColonyShip(state, colonyShip.id)) {
      state.ai.colonyTarget = null;   // re-seating cancels any stale expansion intent
    } else {
      const spot = findPlacement(state, "command", colonyShip.x, colonyShip.y);   // slide off bad ground, then retry next think
      if (spot && (spot.x !== colonyShip.x || spot.y !== colonyShip.y)) issueMove([colonyShip], spot.x, spot.y);
    }
  }
}

// Scout Ranger (Tactical) + EXPANSION: once home ore runs thin, found a base on the richest unclaimed cluster (Odyssey by colony ship, skirmish by a worker). Banks toward it via ctx.oreReserve, pausing only lower-priority infrastructure spends.
/** @param {State} state @param {AiContext} ctx */
export function aiExpand(state, ctx) {
  const { ai, cc, workers, rangers, buildings, colonyShip, arch } = ctx;
  // TACTICAL: build one cheap Ranger up front to scout with — far sight,
  // all-terrain, and it doesn't bleed a fighter out of the army the way lending a
  // combat unit does (updateScout prefers it). Standard AI keeps lending a unit,
  // so its economy/opening is untouched. Ore-only and tiny (45), reserve-aware.
  if (state.ai.micro && cc && workers.length > 0 && rangers.length === 0
      && !cc.queue.some(j => j.unitType === "ranger")
      && canAffordKeeping(ai.resources, UNITS.ranger.cost, ctx.oreReserve) && canAct(state)) {
    if (queueProduction(state, cc.id, "ranger")) spend(state);
  }

  // EXPANSION: once home ore runs thin, found a base on the richest unclaimed cluster.
  // Runs before every ore-spending block so it can reserve the cost (ctx.oreReserve) to
  // bank toward it — pausing only the lower-priority infrastructure spends, never unit
  // production, so the army keeps flowing while the AI saves. At most one in flight.
  const threshold = arch("expandWhenNodesBelow") || 0;   // Odyssey overlay can turn a never-expand Rusher into one that does
  const myCCs = buildings.filter(b => b.type === "command" && !b.constructing);

  if (state.endless) {
    // ODYSSEY: expand by COLONY SHIP — produce one, move it to a fresh cluster, deploy
    // on arrival (no more worker-builds-a-CC). A committed target (state.ai.colonyTarget)
    // keeps the ship homing on a fixed point rather than chasing a shifting cluster.
    const colonyCost = UNITS.colonyship.cost.ore;
    if (state.ai.colonyTarget && !colonyShip) state.ai.colonyTarget = null;   // ship deployed or died → reset the machine

    if (colonyShip && cc) {                                    // an EXPANSION ship is in flight (a start ship has no cc yet — handled above)
      if (!state.ai.colonyTarget) {                             // LAUNCH: commit a target and send it
        const anchor = bestExpansionCluster(state, myCCs);
        if (anchor) {
          const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // aim for the home side of the cluster
          const spot = findPlacement(state, "command",
            anchor.x + Math.cos(toward) * EXPANSION_STANDOFF, anchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
          if (spot && canAct(state)) { state.ai.colonyTarget = { x: spot.x, y: spot.y }; issueMove([colonyShip], spot.x, spot.y); spend(state); }
        }
      } else {                                                 // HOME IN → DEPLOY on arrival
        const t = state.ai.colonyTarget;
        if (Math.hypot(colonyShip.x - t.x, colonyShip.y - t.y) <= COLONY_ARRIVE && canAct(state)) {
          if (deployColonyShip(state, colonyShip.id)) { state.ai.colonyTarget = null; spend(state); }
          else {   // exact spot went invalid → re-aim to nearby valid ground and keep moving
            const spot = findPlacement(state, "command", colonyShip.x, colonyShip.y);
            if (spot) { state.ai.colonyTarget = { x: spot.x, y: spot.y }; issueMove([colonyShip], spot.x, spot.y); spend(state); }
          }
        } else if (!colonyShip.order && !(colonyShip.orderQueue && colonyShip.orderQueue.length) && canAct(state)) {
          issueMove([colonyShip], t.x, t.y); spend(state);     // fell idle short of target (blocked) → nudge back on course
        }
      }
    } else if (!colonyShip && cc && workers.length > 0
               && !buildings.some(b => b.type === "command" && b.constructing)
               && !cc.queue.some(j => j.unitType === "colonyship")) {
      // No ship in flight → bank for and PRODUCE one once home ore runs thin and there's somewhere to settle.
      if (threshold > 0 && homeOreFraction(state, myCCs) < threshold && bestExpansionCluster(state, myCCs)) {
        ctx.oreReserve = colonyCost;                               // pause infrastructure while banking (units keep flowing)
        if (ai.resources.ore >= colonyCost && canAct(state) && queueProduction(state, cc.id, "colonyship")) { spend(state); ctx.oreReserve = 0; }
      }
    }
  } else {
    // SKIRMISH — byte-for-byte as before: a worker builds an expansion Command Center.
    const ccCost = BUILDINGS.command.cost.ore;
    if (threshold > 0 && cc && workers.length > 0
        && !buildings.some(b => b.type === "command" && b.constructing)) {
      if (homeOreFraction(state, myCCs) < threshold) {
        const anchor = bestExpansionCluster(state, myCCs);
        if (anchor) {
          ctx.oreReserve = ccCost;   // bank toward the CC by pausing infrastructure spend
          if (ai.resources.ore >= ccCost) {
            const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // place on the home side of the cluster
            const spot = findPlacement(state, "command",
              anchor.x + Math.cos(toward) * EXPANSION_STANDOFF,
              anchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
            if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "command", spot.x, spot.y)) {
              spend(state);
              ctx.oreReserve = 0;
            }
          }
        }
      }
    }
  }
}

// Core base build-out + the tech gates: more workers, a Habitat before the supply cap bites, the first Barracks, the Foundry (Tier-2 gate) and Arsenal (Tier-3 gate), and one Mender (Tactical). Sets ctx.foundryReserve / ctx.refineryReserve for the production phase.
/** @param {State} state @param {AiContext} ctx */
export function aiBaseAndTech(state, ctx) {
  const { cc, workers, ai, buildings, barracks, refinery, allBarracks, archetype, arch } = ctx;
  // The worker target GROWS with the AI's industry: every factory and Plasma Rig it runs needs workers
  // to supply and clear it (engine/haul.js assignAiLogistics), on top of the base gather crew — so the
  // AI builds the LABOUR its economy needs, the same investment the player makes. Odyssey only (the
  // industry that drives it is odysseyOnly); a skirmish keeps the archetype's flat workerTarget.
  const industryCount = state.endless
    ? buildings.filter(b => !b.constructing && (recipeOf(b) || BUILDINGS[b.type].rig)).length : 0;
  const workerTarget = arch("workerTarget") + industryCount * 2;   // ~MAX_SERVERS worth of haulers per factory/rig
  if (cc && workers.length < workerTarget && cc.queue.length === 0 && canAct(state)) {
    if (queueProduction(state, cc.id, "worker")) spend(state);
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
    if (spot && canAct(state) && issueBuild(state, workers[0].id, "habitat", spot.x, spot.y)) spend(state);
  }

  // First Barracks. Build spots are fixed offsets from the CC, so anything
  // already sitting there (a node, an earlier building) would make issueBuild
  // reject the same spot every think cycle and stall the order forever —
  // findPlacement slides the request to the nearest valid ground instead.
  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y - 90);
    if (spot && canAct(state) && issueBuild(state, workers[0].id, "barracks", spot.x, spot.y)) spend(state);
  }

  // FOUNDRY — the military tech gate for the Tier-2 units (Lancer/Breacher).
  // Built only if this archetype's mix actually wants a gated unit, so a
  // rush/legacy profile never wastes the build. Placed BEFORE the unit cycle so
  // the one-time tech investment isn't perpetually starved by the ungated unit
  // stream (which would otherwise eat every spare bit of ore); it's still
  // expansion-reserve-aware. Units keep flowing while it constructs, and
  // effectiveMix keeps the Tier-2 units out of the cycle until it completes —
  // so this reliably teches a patient AI up without ever stalling. Ore-only, so
  // it's affordable on every world.
  const wantsFoundry = (archetype.unitMix || []).some(t => (UNITS[t]?.requires || []).includes("foundry") && affordableOnSurface(state, t));
  let hasFoundry = buildings.some(b => b.type === "foundry");   // built or still constructing
  if (wantsFoundry && !hasFoundry && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.foundry.cost, ctx.oreReserve)) {
    const spot = findPlacement(state, "foundry", cc.x - 90, cc.y + 90);
    if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "foundry", spot.x, spot.y)) {
      spend(state);
      hasFoundry = true;
    }
  }
  // While teching, reserve the Foundry's ore from unit production so the AI
  // actually banks its cost instead of spending every spare 100 on another
  // Skiff and never reaching it. Cleared the instant it's founded (constructing
  // counts), so the pause is only the brief banking window — then units resume
  // at full flow while it builds. Zero for a rusher/legacy profile that doesn't
  // want a Foundry, so their army is never gated.
  ctx.foundryReserve = wantsFoundry && !hasFoundry ? BUILDINGS.foundry.cost.ore : 0;
  const foundryHandled = !wantsFoundry || hasFoundry;

  // ARSENAL — the Tier-3 gate, one step past the Foundry (unlocks the
  // Dreadnought). Built OPPORTUNISTICALLY from genuine surplus (no reserve
  // pausing the army for it), so it stays the Economist's late out-scaling
  // flourish without slowing its core timing — the deep Tier-3 path is primarily
  // a strategic option for the human player. Only archetypes whose mix wants a
  // Tier-3 unit build it.
  const wantsArsenal = (archetype.unitMix || []).some(t => (UNITS[t]?.requires || []).includes("arsenal") && affordableOnSurface(state, t));
  const hasArsenal = buildings.some(b => b.type === "arsenal");
  if (wantsArsenal && !hasArsenal && foundryHandled && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.arsenal.cost, ctx.oreReserve + BARRACKS_BUFFER)) {
    const spot = findPlacement(state, "arsenal", cc.x - 90, cc.y - 30);
    if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "arsenal", spot.x, spot.y)) spend(state);
  }
  // Refinery reserve, sequenced after the Foundry (Arsenal is unreserved above).
  ctx.refineryReserve = archetype.wantsRefinery && !refinery && foundryHandled && ctx.oreReserve === 0
    ? BUILDINGS.refinery.cost.ore : 0;

  // TACTICAL: keep exactly one Mender at home for army-sustain — it repairs
  // battle-damaged units between waves and patches wounded buildings (see
  // repair.js). Built at a Barracks (Foundry-gated, like the Tier-2 units) and
  // claimed BEFORE the mix cycle below fills every idle Barracks. Standard AI
  // never builds one, so its economy and opening are untouched; it's capped at
  // one, crystal-gated (canAfford only passes with a real crystal income), spends
  // only surplus ore (a mix buffer stays back), and it never attacks or defends —
  // so the resolves-to-a-winner guarantee holds even in the aiMicro resolve variant.
  const foundryDone = buildings.some(b => b.type === "foundry" && !b.constructing);
  if (state.ai.micro && foundryDone) {
    const haveMender = playerUnits(state, "ai").some(u => u.type === "mender")
      || allBarracks.some(b => b.queue.some(j => j.unitType === "mender"));
    const idleRax = allBarracks.find(b => !b.constructing && b.queue.length === 0);
    if (!haveMender && idleRax
        && canAffordKeeping(ai.resources, UNITS.mender.cost, ctx.oreReserve + BARRACKS_BUFFER)
        && canAct(state)) {
      if (queueProduction(state, idleRax.id, "mender")) spend(state);
    }
  }
}

// The shared unit-production cycle across every idle Barracks (Foundry/Refinery reserves held back), Sentinel Turrets along the approach lane, a second Barracks, and the research Refinery plus forward drop-off Refineries out at far seams.
/** @param {State} state @param {AiContext} ctx */
export function aiProduceAndFortify(state, ctx) {
  const { allBarracks, ai, archetype, cc, barracks, workers, buildings } = ctx;
  // One shared production cycle across every completed Barracks: consecutive
  // barracks pick up consecutive mix entries, so two of them drain the same
  // sequence twice as fast rather than each running its own. Map insertion
  // order keeps the pick deterministic. pickNextUnitType layers the
  // counter-pick on top of the archetype mix. Unit production is deliberately
  // NOT gated by the expansion reserve — the army keeps growing while the AI
  // banks for a CC out of its infrastructure budget, never freezing on a poor
  // world.
  for (const b of allBarracks) {
    if (b.constructing || b.queue.length > 0) continue;
    if (!canAct(state)) break;   // out of action budget this cycle — no more units for now
    const nextType = pickNextUnitType(state, archetype);
    if (!canAffordKeeping(ai.resources, UNITS[nextType].cost, ctx.foundryReserve + ctx.refineryReserve)) continue;   // hold back ore while banking the Foundry / Refinery
    if (queueProduction(state, b.id, nextType)) {
      spend(state);
      state.ai.unitsBuilt = (state.ai.unitsBuilt || 0) + 1;
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
      if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "turret", spot.x, spot.y)) spend(state);
    }
  }

  // A second Barracks once the first is up and the mix has a comfortable
  // buffer on top of any expansion reserve (allBarracks counts constructing
  // ones, so it never founds a third while the second is still going up).
  if (barracks && !barracks.constructing && cc && workers.length > 0
      && allBarracks.length < (archetype.maxBarracks || 1)
      && canAffordKeeping(ai.resources, BUILDINGS.barracks.cost, ctx.oreReserve + BARRACKS_BUFFER)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y + 90);
    if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "barracks", spot.x, spot.y)) spend(state);
  }

  // REFINERY & FORWARD DROP-OFFS. A Refinery both researches the AI's doctrine
  // and doubles as a resource drop-off (entities.js isDropOff). So the AI builds
  // its FIRST near home for the research (reserve-aware, kept safe behind the
  // base) — then, once a macro AI is hauling ore a long way from every drop-off,
  // it plants ADDITIONAL Refineries out at those far seams: cheap, decentralized
  // collection points that shorten the haul without the cost of a whole second
  // Command Center. Forward drop-offs spend genuine surplus only (the expansion
  // reserve and a mix buffer stay untouched) and are capped, and no seam on a
  // small map is ever far enough to trigger one — so it fires exactly on the big
  // maps where the fixed home cluster can't reach the deposits. cc-guarded: cc is
  // the completed-only find, so a home CC lost mid-expansion leaves it undefined.
  const refineries = buildings.filter(b => b.type === "refinery");
  const dropoffs = buildings.filter(b => !b.constructing && isDropOff(b.type));
  const fwdAnchor = forwardDropoffAnchor(state, workers, dropoffs);
  const buildResearchRefinery = refineries.length === 0;   // ungated by archetype, as before
  const buildForwardDropoff = archetype.wantsRefinery && refineries.length > 0
    && refineries.length < MAX_AI_REFINERIES && !refineries.some(r => r.constructing) && !!fwdAnchor;
  if ((buildResearchRefinery || buildForwardDropoff) && barracks && !barracks.constructing && cc && workers.length > 0) {
    // The research build banks behind an expansion; a forward drop-off spends
    // only genuine surplus (keeps the expansion reserve AND a mix buffer back).
    const keep = buildForwardDropoff ? ctx.oreReserve + BARRACKS_BUFFER : ctx.oreReserve;
    if (canAffordKeeping(ai.resources, BUILDINGS.refinery.cost, keep)) {
      let spot;
      if (buildForwardDropoff) {
        const toward = Math.atan2(cc.y - fwdAnchor.y, cc.x - fwdAnchor.x);   // home side of the far cluster
        spot = findPlacement(state, "refinery",
          fwdAnchor.x + Math.cos(toward) * EXPANSION_STANDOFF,
          fwdAnchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
      } else {
        spot = findPlacement(state, "refinery", cc.x - 90, cc.y - 90);
      }
      if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "refinery", spot.x, spot.y)) spend(state);
    }
  }
}

// Research along this archetype's chosen doctrine only, lowest tier first, one purchase per think cycle.
/** @param {State} state @param {AiContext} ctx */
export function aiResearch(state, ctx) {
  const { refinery, ai, archetype } = ctx;
  // Research along this archetype's chosen doctrine only (rusher/balanced go
  // Assault, economist Bulwark), lowest tier first — so it commits to one path
  // and deepens it (T1 then T2) instead of dabbling in both. The doctrine lock
  // in researchUpgrade backs this up. One purchase per think cycle is plenty.
  if (refinery && !refinery.constructing && canAct(state)) {
    const doctrine = aiDoctrine(state, archetype);
    const path = Object.values(UPGRADES).filter(u => u.doctrine === doctrine).sort((a, b) => a.tier - b.tier);
    for (const u of path) {
      if (ai.upgrades[u.id]) continue;
      if (researchUpgrade(state, refinery.id, u.id)) { spend(state); break; }
    }
  }
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
// and only reaches across the map once the near ore is claimed or dry. Only
// nodes the AI has discovered count (surface ore always, hidden ore caches
// once scouted) — so on a map where the near ore is spent, the AI has to send
// its scout out to find somewhere to expand, just like the player. Skips
// anchors inside CLAIM_RADIUS of any CC (either owner, incl. constructing).
// Returns null when nothing known is available — which keeps the reserve from
// ever engaging in a no-room deadlock.
function bestExpansionCluster(state, myCCs) {
  const allCCs = [...state.buildings.values()].filter(b => b.type === "command");
  let best = null, bestScore = -Infinity;
  for (const n of state.map.nodes) {
    if (n.com !== "ore" || n.amount <= 0) continue;                                 // anchor on live ore
    if (!isNodeDiscovered(state.fogAI, n)) continue;                                // ...that the AI actually knows about
    if (allCCs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= CLAIM_RADIUS)) continue;
    let cluster = 0;
    for (const m of state.map.nodes)
      if (m.amount > 0 && isNodeDiscovered(state.fogAI, m) && Math.hypot(m.x - n.x, m.y - n.y) <= CLUSTER_RADIUS) cluster += m.amount;
    const dHome = Math.min(...myCCs.map(c => Math.hypot(c.x - n.x, c.y - n.y)));
    const score = cluster - 0.2 * dHome;   // richness first; keeps it on its own side unless dry
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

// The ore seam worth a forward Refinery drop-off: the richest cluster the AI is
// ACTIVELY hauling from that sits beyond FORWARD_DROP_MIN of every existing
// drop-off. Keying it off ore workers are really mining (not just any charted
// seam) keeps the drop-off on the AI's own side — workers pick the nearest ore,
// so a "far" worked seam is far from home, never across the map at the enemy —
// and only fires it when the round trip is genuinely long. Returns null when
// every worked seam is already inside a drop-off's reach, which is always the
// case on a small map, so the forward drop-off is a big-map behaviour only.
function forwardDropoffAnchor(state, workers, dropoffs) {
  if (!dropoffs.length) return null;
  const nodeById = state.map.nodesById || new Map(state.map.nodes.map(n => [n.id, n]));
  const seen = new Set();
  let best = null, bestCluster = -Infinity;
  for (const w of workers) {
    if (!w.order || w.order.type !== "gather") continue;
    const n = nodeById.get(w.order.nodeId);
    if (!n || n.com !== "ore" || n.amount <= 0 || seen.has(n.id)) continue;
    seen.add(n.id);
    const dDrop = Math.min(...dropoffs.map(d => Math.hypot(d.x - n.x, d.y - n.y)));
    if (dDrop < FORWARD_DROP_MIN) continue;   // already inside an existing drop-off's haul
    let cluster = 0;
    for (const m of state.map.nodes)
      if (m.com === "ore" && m.amount > 0 && Math.hypot(m.x - n.x, m.y - n.y) <= CLUSTER_RADIUS) cluster += m.amount;
    if (cluster > bestCluster) { bestCluster = cluster; best = n; }
  }
  return best;
}
