/* ============================================================
   Scripted AI opponent: keep workers on the nearest node, keep
   population growing, put up a Barracks once it can afford one, then
   cycle through its archetype's unit mix (Skiff/Bastion/Lancer — see
   entities.js for the rock-paper-scissors relationship between them)
   and throw the whole army at the player's base once it's big enough
   (or the game's dragged on long enough that it should commit anyway).
   Also puts up a Refinery and researches both upgrades once it can
   afford to, so the player isn't the only side that gets to use
   crystals/radioactives.

   How aggressively vs. how patiently it plays — worker/army targets,
   attack timing, unit mix — comes from state.aiArchetype (see
   engine/aiArchetypes.js), which is picked by which planet the match is
   on. This file just executes whatever profile it's handed.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueAttackMove } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;

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

  // Build spots are fixed offsets from the CC, so anything already sitting
  // there (a node, an earlier building) would make issueBuild reject the
  // same spot every think cycle and stall the build order forever —
  // findPlacement slides the request to the nearest valid ground instead.
  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y - 90);
    if (spot) issueBuild(state, workers[0].id, "barracks", spot.x, spot.y);
  }

  if (barracks && !barracks.constructing && barracks.queue.length === 0) {
    const mix = archetype.unitMix;
    const nextType = mix[(state.aiUnitsBuilt || 0) % mix.length];
    if (queueProduction(state, barracks.id, nextType)) {
      state.aiUnitsBuilt = (state.aiUnitsBuilt || 0) + 1;
    }
  }

  if (!refinery && barracks && !barracks.constructing && workers.length > 0 && canAfford(ai.resources, BUILDINGS.refinery.cost)) {
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
