/* ============================================================
   Scripted AI opponent: keep workers on the nearest node, keep
   population growing, put up a Barracks once it can afford one, then
   cycle through its archetype's unit mix (Skiff/Bastion/Lancer — see
   entities.js for the rock-paper-scissors relationship between them)
   and throw its home army at the player's base in repeated waves, once
   each wave is big enough (or the game's dragged on long enough that it
   should commit anyway). Also puts up a Refinery and researches both
   upgrades once it can afford to, so the player isn't the only side
   that gets to use crystals/radioactives.

   Every few units it also breaks from the archetype's mix to build
   whatever directly counters the type the player fields most (see
   counterToPlayerArmy below) — full-knowledge scouting, consistent with
   the AI already playing with an unfogged view of the map (fog.js only
   ever gates the player's own view). The rest of the cycle still
   follows the archetype's own flavor, so a Rusher doesn't turn into a
   pure reactive counter-picker.

   How aggressively vs. how patiently it plays — worker/army targets,
   attack timing, unit mix — comes from state.aiArchetype (see
   engine/aiArchetypes.js), which is picked by which planet the match is
   on. This file just executes whatever profile it's handed.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueAttackMove } from "./commands.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;
const COUNTER_EVERY = 3;   // 1 in every 3 units built reacts to the player's army instead of following the mix

// Derived once from each unit's bonusVs table (entities.js), rather than
// hardcoded here, so this stays correct automatically if the roster or
// its counter relationships ever change: COUNTER_OF['lancer'] === 'skiff'
// means Skiff is the type that holds bonus damage against Lancer.
const COUNTER_OF = Object.values(UNITS).reduce((map, def) => {
  if (def.bonusVs) for (const targetType of Object.keys(def.bonusVs)) map[targetType] = def.id;
  return map;
}, {});

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

  assignIdleWorkers(state, workers);

  if (cc && workers.length < archetype.workerTarget && cc.queue.length === 0) {
    queueProduction(state, cc.id, "worker");
  }

  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    issueBuild(state, workers[0].id, "barracks", cc.x + 90, cc.y - 90);
  }

  if (barracks && !barracks.constructing && barracks.queue.length === 0) {
    const nextType = pickNextUnitType(state, archetype);
    if (queueProduction(state, barracks.id, nextType)) {
      state.aiUnitsBuilt = (state.aiUnitsBuilt || 0) + 1;
    }
  }

  if (!refinery && barracks && !barracks.constructing && workers.length > 0 && canAfford(ai.resources, BUILDINGS.refinery.cost)) {
    issueBuild(state, workers[0].id, "refinery", cc.x - 90, cc.y - 90);
  }

  if (refinery && !refinery.constructing) {
    for (const upgradeId of Object.keys(UPGRADES)) {
      if (ai.upgrades[upgradeId]) continue;
      if (researchUpgrade(state, refinery.id, upgradeId)) break;   // one purchase per think cycle is plenty
    }
  }

  // "Home" army is whatever hasn't already been sent off to attack — a
  // freshly produced or still-idle unit has order null/'move' (its walk
  // to the rally point), while a committed one is mid attack-move (see
  // combat.js: an attack-move order survives fighting along the way, and
  // only clears once the unit truly arrives with nothing left to fight).
  // Filtering on that instead of a one-shot flag means each new batch of
  // units automatically forms the next wave once the threshold is met
  // again, so the AI keeps attacking instead of throwing exactly one
  // army at the player for the whole match.
  const homeArmy = army.filter(u => !u.order || u.order.type === "move");
  const nextAttackAt = state.aiNextAttackAt ?? archetype.attackTimeout;
  const readyToAttack = homeArmy.length > 0 && (homeArmy.length >= archetype.armyAttackSize || state.time >= nextAttackAt);
  if (readyToAttack) {
    const target = state.map.bases.player;
    issueAttackMove(homeArmy, target.x, target.y);
    state.aiNextAttackAt = state.time + archetype.attackTimeout;
  }
}

function pickNextUnitType(state, archetype) {
  const built = state.aiUnitsBuilt || 0;
  if (built > 0 && built % COUNTER_EVERY === 0) {
    const counter = counterToPlayerArmy(state);
    if (counter) return counter;
  }
  const mix = archetype.unitMix;
  return mix[built % mix.length];
}

// Whatever combat type the player currently fields the most of, mapped
// to its hard counter. Ties keep whichever type was seen first, which is
// fine — there's no meaningfully "correct" pick between two equally
// common threats.
function counterToPlayerArmy(state) {
  const counts = {};
  for (const u of state.units.values()) {
    if (u.owner !== "player" || UNITS[u.type].role !== "combat") continue;
    counts[u.type] = (counts[u.type] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [type, count] of Object.entries(counts)) {
    if (count > bestCount) { bestCount = count; best = type; }
  }
  return best ? COUNTER_OF[best] : null;
}

function assignIdleWorkers(state, workers) {
  const nodes = state.map.nodes.filter(n => n.amount > 0);
  if (!nodes.length) return;
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
