/* ============================================================
   Scripted AI opponent: keep workers on the nearest node, keep
   population growing, put up a Barracks once it can afford one, then
   mix Skiffs and Bastions (roughly 1 Bastion per BASTION_RATIO units)
   and throw the whole army at the player's base once it's big enough
   (or the game's dragged on long enough that it should commit anyway).
   ============================================================ */

"use strict";

import { queueProduction } from "./production.js";
import { issueBuild, issueAttackMove } from "./commands.js";
import { BUILDINGS, canAfford } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;
const WORKER_TARGET = 6;
const ARMY_ATTACK_SIZE = 6;
const ATTACK_TIMEOUT = 150;
const BASTION_RATIO = 3;   // every 3rd unit built is a Bastion instead of a Skiff

export function runAI(state, dt) {
  state.aiThink = (state.aiThink || 0) - dt;
  if (state.aiThink > 0) return;
  state.aiThink = THINK_INTERVAL;

  const ai = state.players.ai;
  const workers = playerUnits(state, "ai").filter(u => u.type === "worker");
  const army = playerUnits(state, "ai").filter(u => u.type === "skiff" || u.type === "bastion");
  const buildings = playerBuildings(state, "ai");
  const cc = buildings.find(b => b.type === "command" && !b.constructing);
  const barracks = buildings.find(b => b.type === "barracks");

  assignIdleWorkers(state, workers);

  if (cc && workers.length < WORKER_TARGET && cc.queue.length === 0) {
    queueProduction(state, cc.id, "worker");
  }

  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    issueBuild(state, workers[0].id, "barracks", cc.x + 90, cc.y - 90);
  }

  if (barracks && !barracks.constructing && barracks.queue.length === 0) {
    const nextIsBastion = (state.aiUnitsBuilt || 0) % BASTION_RATIO === BASTION_RATIO - 1;
    if (queueProduction(state, barracks.id, nextIsBastion ? "bastion" : "skiff")) {
      state.aiUnitsBuilt = (state.aiUnitsBuilt || 0) + 1;
    }
  }

  const readyToAttack = army.length >= ARMY_ATTACK_SIZE || state.time > ATTACK_TIMEOUT;
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
