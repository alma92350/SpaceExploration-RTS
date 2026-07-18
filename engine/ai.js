/* ============================================================
   Scripted AI opponent: keep workers on the nearest node, keep
   population growing, put up a Barracks once it can afford one, then
   mix Skiffs and Bastions and throw the whole army at the player's base
   once it's big enough (or the game's dragged on long enough that it
   should commit anyway). Also puts up a Refinery and researches both
   upgrades once it can afford to, so the player isn't the only side
   that gets to use crystals/radioactives.

   How aggressively vs. how patiently it plays — worker/army targets,
   attack timing, unit mix — comes from state.aiArchetype (see
   engine/aiArchetypes.js), which is picked by which planet the match is
   on. This file just executes whatever profile it's handed.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueAttackMove } from "./commands.js";
import { BUILDINGS, UPGRADES, canAfford } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;

export function runAI(state, dt) {
  state.aiThink = (state.aiThink || 0) - dt;
  if (state.aiThink > 0) return;
  state.aiThink = THINK_INTERVAL;

  const archetype = state.aiArchetype;
  const ai = state.players.ai;
  const workers = playerUnits(state, "ai").filter(u => u.type === "worker");
  const army = playerUnits(state, "ai").filter(u => u.type === "skiff" || u.type === "bastion");
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
    const nextIsBastion = (state.aiUnitsBuilt || 0) % archetype.bastionRatio === archetype.bastionRatio - 1;
    if (queueProduction(state, barracks.id, nextIsBastion ? "bastion" : "skiff")) {
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

  const readyToAttack = army.length >= archetype.armyAttackSize || state.time > archetype.attackTimeout;
  if (readyToAttack && army.length > 0 && !state.aiAttacked) {
    const target = state.map.bases.player;
    issueAttackMove(army, target.x, target.y);
    state.aiAttacked = true;
  }
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
