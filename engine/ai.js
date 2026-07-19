/* ============================================================
   Scripted AI opponent: keep workers on the nearest spendable node, keep
   population growing, put up a Barracks once it can afford one, then cycle
   through its archetype's unit mix (Skiff/Bastion/Lancer/Breacher — see
   entities.js for the rock-paper-scissors relationship) across every
   Barracks it owns, and throw its home army at the player's base in
   repeated waves, once each wave is big enough (or the game's dragged on
   long enough that it should commit anyway). Along the way it fortifies
   with Sentinel Turrets on the approach vector, expands to a second
   Command Center when its home ore runs thin, puts up a Refinery (and, on a
   big map, plants extra Refineries forward as resource drop-offs to shorten a
   long ore haul without a whole second CC), and researches both upgrades — so
   the player isn't the only side that gets to use crystals/radioactives,
   expansions, decentralized collection, or defenses.

   The AI plays under its own fog of war (state.fogAI) — it is NOT omniscient.
   It keeps one unit out scouting (updateScout), and its intel-dependent moves
   are gated by what it has actually seen: every few units it breaks from the
   mix to counter whatever the player fields most, but only counting player
   units currently in its vision (counterToPlayerArmy); and it only mines or
   expands to nodes it has discovered — charted surface deposits always, hidden
   caches once scouted. The rest of the cycle follows the archetype's own
   flavor, so a Rusher doesn't turn into a pure reactive counter-picker.

   How aggressively vs. how patiently it plays — worker/army targets, attack
   timing, unit mix, how many turrets and barracks, when to expand — all comes
   from state.aiArchetype (see engine/aiArchetypes.js), which is picked by
   which planet the match is on. This file just executes whatever profile it's
   handed; every Tier 4 field is read with a use-site default so a legacy
   profile that predates them still runs.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueAttackMove, issueMove } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford, prereqsMet, isDropOff } from "./entities.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { isVisibleAt, isExploredAt, isNodeDiscovered, nearestUnexploredPoint } from "./fog.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;
const COUNTER_EVERY = 3;   // 1 in every 3 units built reacts to the player's army instead of following the mix
const APM_BURST_FRAC = 1 / 15;   // a busy AI can bank at most ~4 seconds' worth of unspent actions

// Derived once from each unit's bonusVs table (entities.js), rather than
// hardcoded here, so this stays correct automatically if the roster or
// its counter relationships ever change: COUNTER_OF['lancer'] === 'skiff'
// means Skiff is the type that holds bonus damage against Lancer.
const COUNTER_OF = Object.values(UNITS).reduce((map, def) => {
  if (def.bonusVs) for (const targetType of Object.keys(def.bonusVs)) map[targetType] = def.id;
  return map;
}, {});

const HOME_RADIUS = 420;          // nodes this close to an AI CC count as "home" economy
const CLAIM_RADIUS = 260;         // a cluster with any CC this close is already claimed
const CLUSTER_RADIUS = 160;       // nodes within this of an anchor sum into its cluster score
const EXPANSION_STANDOFF = 70;    // CC-to-anchor-node placement distance (26 CC radius + 16 node radius + clearance)
const BARRACKS_BUFFER = 150;      // bank kept when adding a barracks so the mix doesn't starve
const SATURATION_STEER = 250;     // distance-equivalent penalty per worker a node is over the soft cap
const FORWARD_DROP_MIN = 360;     // ore worked this far from every drop-off is worth a forward Refinery drop-off
const MAX_AI_REFINERIES = 3;      // hard cap so forward drop-offs never run away with the AI's ore

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
  accrueActionBudget(state, dt);   // every tick, so credits build up between think cycles
  state.aiThink = (state.aiThink || 0) - dt;
  if (state.aiThink > 0) return;
  state.aiThink = THINK_INTERVAL;

  const archetype = state.aiArchetype;
  const ai = state.players.ai;
  const workers = playerUnits(state, "ai").filter(u => u.type === "worker");
  const army = playerUnits(state, "ai").filter(u => UNITS[u.type].role === "combat");
  const rangers = playerUnits(state, "ai").filter(u => u.type === "ranger");
  const buildings = playerBuildings(state, "ai");
  const cc = buildings.find(b => b.type === "command" && !b.constructing);
  const barracks = buildings.find(b => b.type === "barracks");
  const refinery = buildings.find(b => b.type === "refinery");
  const allBarracks = buildings.filter(b => b.type === "barracks");
  let oreReserve = 0;

  // Computed once and reused by the attack block below: enemy combat units the
  // AI can see pressing its base. Under threat it won't lend a new scout — every
  // unit is needed at home.
  const threats = visibleThreatsNearHome(state);
  updateScout(state, army, rangers, threats.length > 0);   // before worker assignment, so a worker-turned-scout isn't re-tasked to gather
  assignIdleWorkers(state, workers);

  // TACTICAL: build one cheap Ranger up front to scout with — far sight,
  // all-terrain, and it doesn't bleed a fighter out of the army the way lending a
  // combat unit does (updateScout prefers it). Standard AI keeps lending a unit,
  // so its economy/opening is untouched. Ore-only and tiny (45), reserve-aware.
  if (state.aiMicro && cc && workers.length > 0 && rangers.length === 0
      && !cc.queue.some(j => j.unitType === "ranger")
      && canAffordKeeping(ai.resources, UNITS.ranger.cost, oreReserve) && canAct(state)) {
    if (queueProduction(state, cc.id, "ranger")) spend(state);
  }

  // EXPANSION: once home ore runs thin, plant a second Command Center on the
  // richest unclaimed cluster. Runs before every ore-spending block so it can
  // reserve the CC's cost (oreReserve) to bank toward it. The reserve pauses
  // only the lower-priority infrastructure spends (a second Barracks, the
  // Refinery) — never unit production, so the army keeps flowing while the AI
  // saves. Gating units too would starve the army indefinitely on an ore-poor
  // world, where income can't outrun a 400-ore bank before the last seam dries
  // and it never actually expands. At most one expansion in flight.
  const ccCost = BUILDINGS.command.cost.ore;
  const threshold = archetype.expandWhenNodesBelow || 0;
  if (threshold > 0 && cc && workers.length > 0
      && !buildings.some(b => b.type === "command" && b.constructing)) {
    const myCCs = buildings.filter(b => b.type === "command" && !b.constructing);
    if (homeOreFraction(state, myCCs) < threshold) {
      const anchor = bestExpansionCluster(state, myCCs);
      if (anchor) {
        oreReserve = ccCost;   // bank toward the CC by pausing infrastructure spend
        if (ai.resources.ore >= ccCost) {
          const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // place on the home side of the cluster
          const spot = findPlacement(state, "command",
            anchor.x + Math.cos(toward) * EXPANSION_STANDOFF,
            anchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
          if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "command", spot.x, spot.y)) {
            spend(state);
            oreReserve = 0;
          }
        }
      }
    }
  }

  if (cc && workers.length < archetype.workerTarget && cc.queue.length === 0 && canAct(state)) {
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
  const wantsFoundry = (archetype.unitMix || []).some(t => (UNITS[t]?.requires || []).includes("foundry"));
  let hasFoundry = buildings.some(b => b.type === "foundry");   // built or still constructing
  if (wantsFoundry && !hasFoundry && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.foundry.cost, oreReserve)) {
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
  const foundryReserve = wantsFoundry && !hasFoundry ? BUILDINGS.foundry.cost.ore : 0;
  const foundryHandled = !wantsFoundry || hasFoundry;

  // ARSENAL — the Tier-3 gate, one step past the Foundry (unlocks the
  // Dreadnought). Built OPPORTUNISTICALLY from genuine surplus (no reserve
  // pausing the army for it), so it stays the Economist's late out-scaling
  // flourish without slowing its core timing — the deep Tier-3 path is primarily
  // a strategic option for the human player. Only archetypes whose mix wants a
  // Tier-3 unit build it.
  const wantsArsenal = (archetype.unitMix || []).some(t => (UNITS[t]?.requires || []).includes("arsenal"));
  const hasArsenal = buildings.some(b => b.type === "arsenal");
  if (wantsArsenal && !hasArsenal && foundryHandled && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.arsenal.cost, oreReserve + BARRACKS_BUFFER)) {
    const spot = findPlacement(state, "arsenal", cc.x - 90, cc.y - 30);
    if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "arsenal", spot.x, spot.y)) spend(state);
  }
  // Refinery reserve, sequenced after the Foundry (Arsenal is unreserved above).
  const refineryReserve = archetype.wantsRefinery && !refinery && foundryHandled && oreReserve === 0
    ? BUILDINGS.refinery.cost.ore : 0;

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
    if (!canAffordKeeping(ai.resources, UNITS[nextType].cost, foundryReserve + refineryReserve)) continue;   // hold back ore while banking the Foundry / Refinery
    if (queueProduction(state, b.id, nextType)) {
      spend(state);
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
      if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "turret", spot.x, spot.y)) spend(state);
    }
  }

  // A second Barracks once the first is up and the mix has a comfortable
  // buffer on top of any expansion reserve (allBarracks counts constructing
  // ones, so it never founds a third while the second is still going up).
  if (barracks && !barracks.constructing && cc && workers.length > 0
      && allBarracks.length < (archetype.maxBarracks || 1)
      && canAffordKeeping(ai.resources, BUILDINGS.barracks.cost, oreReserve + BARRACKS_BUFFER)) {
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
    const keep = buildForwardDropoff ? oreReserve + BARRACKS_BUFFER : oreReserve;
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

  // DEFENSE first: if the AI can SEE enemy combat units pressing one of its
  // buildings, the whole army (bar the scout) drops what it's doing and rushes
  // that spot — including units already committed forward. This is the recall
  // that makes "absorb the wave, then counter" no longer a free win: hit the
  // AI's base and it brings its force home to meet you, instead of marching on
  // regardless while its economy burns. Exempt from the APM budget, same as the
  // attack commit, so a slow AI still always defends. Once the threat clears
  // vision, the army re-forms at home and the offensive logic below takes over.
  const nonScout = army.filter(u => u.id !== state.aiScoutId);
  if (threats.length > 0) {
    if (nonScout.length > 0) {
      const focus = threatCentroid(threats);
      issueAttackMove(nonScout, focus.x, focus.y);
    }
  } else {
    // OFFENSE. "Home" army is whatever hasn't already been sent off to attack —
    // a freshly produced or still-idle unit has order null/'move' (its walk to
    // the rally point), while a committed one is mid attack-move (see combat.js).
    // Filtering on that means each new batch automatically forms the next wave
    // once the threshold is met again, so the AI keeps attacking in waves.
    const homeArmy = nonScout.filter(u => !u.order || u.order.type === "move");
    const attackers = nonScout.filter(u => u.order && u.order.type === "attack-move");
    const cc = buildings.find(b => b.type === "command" && !b.constructing) || buildings[0];

    // RETREAT: a committed, non-desperation attack that's been ground down to a
    // fraction of what was sent — and is STILL facing live opposition — pulls its
    // survivors home instead of feeding the last of them into a lost fight. So an
    // engagement trades (both sides keep a remnant) rather than ending in a wipe,
    // and the saved veterans re-form into the next wave. Two guards preserve the
    // resolves-to-a-winner guarantee: a desperation (timeout) commit never
    // retreats, and a retreat only fires while the AI can SEE enemy combat units
    // near the fight — so against an undefended base (every headless resolve
    // test) it never triggers and the AI razes the base exactly as before.
    if (!state.aiAttackDesperate && state.aiAttackForce > 0 && attackers.length > 0
        && attackers.length < state.aiAttackForce * RETREAT_FRACTION && cc) {
      const focus = threatCentroid(attackers);
      if (visibleEnemyCombatNear(state, focus.x, focus.y, RETREAT_SIGHT) >= attackers.length) {
        issueMove(attackers, cc.x, cc.y);   // plain move disengages: combat.js skips auto-acquire on a 'move' order
        state.aiAttackForce = 0;
      }
    }

    const nextAttackAt = state.aiNextAttackAt ?? archetype.attackTimeout;
    const timedOut = state.time >= nextAttackAt;
    const readyToAttack = homeArmy.length > 0 && (homeArmy.length >= archetype.armyAttackSize || timedOut);
    if (readyToAttack && cc) {
      // A massed (size-triggered) attack keeps a home guard back; a timeout
      // commit is desperation and throws everything, so the game always resolves
      // even for a turtle that never quite reaches its attack size.
      const garrison = timedOut ? 0 : (archetype.garrison || 0);
      const strike = withoutHomeGuard(homeArmy, cc, garrison);
      if (strike.length > 0) {
        const target = chooseAttackTarget(state, cc);
        issueAttackMove(strike, target.x, target.y);
        state.aiNextAttackAt = state.time + archetype.attackTimeout;
        // Reset the retreat baseline to the whole committed force (survivors of a
        // prior wave plus this reinforcement) so a wave that's being topped up
        // doesn't read as "ground down".
        state.aiAttackForce = attackers.length + strike.length;
        state.aiAttackDesperate = timedOut;
      }
    }
  }

  // TACTICAL micro (opt-in via aiMicro): concentrate the army's fire on one
  // target so kills land faster and incoming damage drops sooner — a skilled
  // player's focus-fire, layered on top of the wave logic above without touching
  // it. Deliberately a no-op unless real enemy combat is in sight, so razing an
  // undefended base (every resolve test) is unchanged and the resolve guarantee
  // holds regardless of the setting.
  if (state.aiMicro) applyFocusFire(state, army);
}

const FOCUS_RANGE = 340;   // only army units this close to the chosen target concentrate on it

// Point every nearby AI combat unit's focus at a single best enemy: the lowest-HP
// visible enemy combat unit (secure the kill, cut its DPS), tie-broken toward the
// more dangerous one, then by id for determinism. combat.js reads unit.focusId
// and prefers it while it's a live enemy in aggro (else falls back to the normal
// dispersed acquire). Cleared when nothing hostile is in sight, so the razing
// path uses ordinary targeting untouched.
function applyFocusFire(state, army) {
  const enemies = [];
  for (const u of state.units.values()) {
    if (u.owner === "ai" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    enemies.push(u);
  }
  if (!enemies.length) { for (const a of army) a.focusId = null; return; }
  enemies.sort((a, b) => a.hp - b.hp
    || (UNITS[b.type].attack - UNITS[a.type].attack)
    || (a.id < b.id ? -1 : 1));
  const focus = enemies[0];
  for (const a of army) {
    a.focusId = Math.hypot(a.x - focus.x, a.y - focus.y) <= FOCUS_RANGE ? focus.id : null;
  }
}

const RETREAT_FRACTION = 0.4;   // a committed attack ground below this share of its launch size pulls back
const RETREAT_SIGHT = 260;      // ...if it can see at least as many enemy combat units this close (still losing)

// Player combat units the AI can currently SEE within `radius` of (x, y) — the
// live opposition at a fight. Zero against an undefended base, which is what
// makes the retreat safe for the resolves-to-a-winner guarantee.
function visibleEnemyCombatNear(state, x, y, radius) {
  let n = 0;
  for (const u of state.units.values()) {
    if (u.owner === "ai" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    if (Math.hypot(u.x - x, u.y - y) <= radius) n++;
  }
  return n;
}

const DEFEND_RADIUS = 340;   // enemy combat units this close to an AI building trigger a recall

// Enemy combat units the AI can currently SEE (its own fog) sitting within
// DEFEND_RADIUS of any building it owns. A lone scouting worker doesn't count —
// only real combat threats pull the army home, so the AI isn't yanked off an
// attack by a single drone. What it can't see, it can't react to.
function visibleThreatsNearHome(state) {
  const myBuildings = [...state.buildings.values()].filter(b => b.owner === "ai");
  if (!myBuildings.length) return [];
  const threats = [];
  for (const u of state.units.values()) {
    if (u.owner === "ai" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    if (myBuildings.some(b => Math.hypot(b.x - u.x, b.y - u.y) <= DEFEND_RADIUS)) threats.push(u);
  }
  return threats;
}

function threatCentroid(threats) {
  let x = 0, y = 0;
  for (const t of threats) { x += t.x; y += t.y; }
  return { x: x / threats.length, y: y / threats.length };
}

// Hold back the `garrison` units closest to home; return the rest as the strike
// force. The near-home units make the standing defense, the forward ones push.
function withoutHomeGuard(homeArmy, cc, garrison) {
  if (!garrison || !cc || homeArmy.length <= garrison) {
    return homeArmy.length > garrison ? homeArmy.slice() : [];
  }
  const byDistHome = homeArmy.slice().sort((a, b) =>
    Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y));
  return byDistHome.slice(garrison);   // drop the closest `garrison` — they stay home
}

// Where to send the wave. Prefer a seen enemy Command Center (the win
// condition), then any seen enemy building, then a seen enemy unit (raid the
// army or worker line). With nothing in sight it goes HUNTING: a player CC is
// still standing somewhere (the game isn't over), and the player can hold — and
// hide — several of them, so razing the first is not the win. It first marches on
// the player's start if it hasn't even charted it yet (the likeliest spot early,
// and the fast beeline that keeps the game resolving); once that's explored and
// empty, it sweeps the nearest unexplored ground, attack-moving to reveal fog,
// until it turns up a hidden expansion CC — instead of committing forever to a
// start coordinate the player has long since left.
function chooseAttackTarget(state, cc) {
  const from = cc || { x: state.map.bases.ai.x, y: state.map.bases.ai.y };
  const seen = e => e.owner === "player" && isVisibleAt(state.fogAI, e.x, e.y);
  const seenBuildings = [...state.buildings.values()].filter(seen);
  const ccs = seenBuildings.filter(b => b.type === "command");
  const nearestOf = list => {
    let best = null, bestD = Infinity;
    for (const e of list) {
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  };
  const target = nearestOf(ccs) || nearestOf(seenBuildings)
      || nearestOf([...state.units.values()].filter(seen));
  if (target) return target;
  const start = state.map.bases.player;
  if (!isExploredAt(state.fogAI, start.x, start.y)) return start;   // haven't looked at the start yet — go there
  return nearestUnexploredPoint(state.fogAI, from.x, from.y) || start;   // else search the map for a hidden CC
}

// The next unit to build: normally the next entry in the archetype's mix,
// but every COUNTER_EVERY-th unit it instead builds the hard counter to
// whatever the player fields most. Both draw from effectiveMix — the mix
// with entries this map can't pay for dropped (e.g. the Breacher on a world
// with no radioactives) — so the cycle never stalls on an unbuildable type,
// and a counter is only chosen when this map can actually build it.
function pickNextUnitType(state, archetype) {
  const mix = effectiveMix(state, archetype);
  const built = state.aiUnitsBuilt || 0;
  if (built > 0 && built % COUNTER_EVERY === 0) {
    const counter = counterToPlayerArmy(state);
    if (counter && mix.includes(counter)) return counter;
  }
  return mix[built % mix.length];
}

// Whatever combat type the player currently fields the most of — among only
// the units the AI can actually SEE right now (its own fog) — mapped to its
// hard counter. No vision of the player's army means no counter-pick, so the
// AI has to scout or fight to earn that intel, the same as the player. Ties
// keep whichever type was seen first; there's no meaningfully "correct" pick
// between two equally common threats.
function counterToPlayerArmy(state) {
  const counts = {};
  for (const u of state.units.values()) {
    if (u.owner !== "player" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;   // can't counter what it hasn't seen
    counts[u.type] = (counts[u.type] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [type, count] of Object.entries(counts)) {
    if (count > bestCount) { bestCount = count; best = type; }
  }
  return best ? COUNTER_OF[best] : null;
}

/* ---------- action budget (the configurable AI speed / APM) ---------- */

// The AI's "speed" is an actions-per-minute allowance, set from the splash
// screen (state.aiApm). Every command it issues — produce, build, expand,
// research, send the scout — costs one action; the attack commit is the one
// exemption, so a slow AI still throws whatever it has at you and the game
// always resolves. Credits accrue continuously and cap at a few seconds' worth,
// so a busy AI can't hoard a giant burst. When aiApm is null (the default, and
// every headless test) the AI is unthrottled — behaviour is exactly as before.
function accrueActionBudget(state, dt) {
  if (state.aiApm == null) return;
  const cap = Math.max(2, state.aiApm * APM_BURST_FRAC);
  state.aiActionBudget = Math.min((state.aiActionBudget || 0) + (state.aiApm / 60) * dt, cap);
}

function canAct(state) {
  return state.aiApm == null || (state.aiActionBudget || 0) >= 1;
}

function spend(state) {
  if (state.aiApm != null) state.aiActionBudget -= 1;
}

// Keep one spare unit ranging across the contested middle so the AI earns its
// intel — uncovering hidden caches and spotting the player's forces — instead
// of knowing the map for free. Only lends a scout once the army can spare one;
// a box sweep of the centre laid down as plain-move waypoints (it reveals fog
// rather than diving into a fight), re-issued whenever the scout falls idle or
// dies. Runs before assignIdleWorkers so a scout is never re-tasked to gather.
function updateScout(state, army, rangers, defending = false) {
  if (defending) return;   // base under attack — hold every unit home, don't lend a scout
  let scout;
  const ranger = (rangers && rangers.length) ? rangers[0] : null;
  if (ranger) {
    // Prefer a dedicated Ranger (Tactical builds one): it out-sees any fighter,
    // goes anywhere, and costs the army nothing. Leave it be while it's sweeping;
    // re-task only once it falls idle (or send it out the first time).
    if (ranger.order || (ranger.orderQueue && ranger.orderQueue.length)) return;
    scout = ranger;
  } else {
    // No Ranger: fall back to lending a combat unit, but only if one isn't already
    // out — don't pull a second fighter off the line.
    const current = state.aiScoutId ? state.units.get(state.aiScoutId) : null;
    if (current && (current.order || (current.orderQueue && current.orderQueue.length))) return;
    if (army.length < 4) { state.aiScoutId = null; return; }   // need a genuine spare to lend
    scout = army.find(u => u.id !== state.aiScoutId);
  }
  if (!scout || !canAct(state)) return;   // no spare, or no action budget to send one out yet
  spend(state);
  state.aiScoutId = scout.id;
  const w = state.map.width, h = state.map.height;
  const home = { x: scout.x, y: scout.y };
  const pb = state.map.bases.player;
  issueMove([scout], w * 0.42, h * 0.22);
  issueMove([scout], w * 0.58, h * 0.22, true);
  issueMove([scout], w * 0.58, h * 0.78, true);
  issueMove([scout], w * 0.42, h * 0.78, true);
  // ...then swing toward the player's side to actually see the army it needs to
  // counter (a pure centre sweep can miss what's massing at the enemy base),
  // stopping short of diving into the base itself, before folding back home.
  issueMove([scout], home.x + (pb.x - home.x) * 0.6, home.y + (pb.y - home.y) * 0.6, true);
  issueMove([scout], home.x, home.y, true);   // and head home to fold back into the army
}

function assignIdleWorkers(state, workers) {
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

// canAfford, but treating `oreReserve` ore as untouchable — used to bank for
// an expansion Command Center without letting the unit mix or a second
// barracks spend the ore out from under it.
function canAffordKeeping(resources, cost, oreReserve) {
  return Object.entries(cost).every(([com, qty]) =>
    (resources[com] || 0) - (com === "ore" ? oreReserve : 0) >= qty);
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
function effectiveMix(state, archetype) {
  const mix = (archetype.unitMix || []).filter(t =>
    UNITS[t]
    && BUILDINGS.barracks.produces?.includes(t)
    && prereqsMet(state, "ai", UNITS[t])
    && Object.keys(UNITS[t].cost).every(com => state.map.nodes.some(n => n.com === com && !n.hidden)));
  return mix.length ? mix : ["skiff"];
}

// Which upgrade doctrine the AI commits to. It prefers its archetype's flavour
// (rusher/balanced Assault, economist Bulwark), but follows the world's economy
// when that world is clearly richer in the OTHER doctrine's commodity — Assault
// runs on radioactives, Bulwark on crystals — so it doesn't build a Refinery it
// can't actually research on a world short of its preferred commodity. Surface
// deposits only (mirrors effectiveMix): steady income, not a contested cache.
function aiDoctrine(state, archetype) {
  const surfaceTotal = com => state.map.nodes
    .filter(n => n.com === com && !n.hidden).reduce((s, n) => s + n.max, 0);
  const rad = surfaceTotal("radioactives"), cry = surfaceTotal("crystals");
  const pref = archetype.doctrine || "assault";
  if (pref === "assault") return rad >= cry * 0.6 ? "assault" : "bulwark";
  return cry >= rad * 0.6 ? "bulwark" : "assault";
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
