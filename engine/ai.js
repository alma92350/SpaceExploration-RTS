/* ============================================================
   Scripted AI opponent: keep workers on the nearest node, keep
   population growing, put up a Barracks once it can afford one, then
   pump Skiffs and throw them at the player's base once it has a real
   force (or the game's dragged on long enough that it should commit
   anyway).
   ============================================================ */

"use strict";

import { queueProduction } from "./production.js";
import { issueBuild, issueAttackMove } from "./commands.js";
import { BUILDINGS, canAfford } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;
const WORKER_TARGET = 6;
const SKIFF_ATTACK_SIZE = 6;
const ATTACK_TIMEOUT = 150;

export function runAI(state, dt) {
  state.aiThink = (state.aiThink || 0) - dt;
  if (state.aiThink > 0) return;
  state.aiThink = THINK_INTERVAL;

  const ai = state.players.ai;
  const workers = playerUnits(state, "ai").filter(u => u.type === "worker");
  const skiffs = playerUnits(state, "ai").filter(u => u.type === "skiff");
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
    queueProduction(state, barracks.id, "skiff");
  }

  const readyToAttack = skiffs.length >= SKIFF_ATTACK_SIZE || state.time > ATTACK_TIMEOUT;
  if (readyToAttack && skiffs.length > 0 && !state.aiAttacked) {
    const target = state.map.bases.player;
    issueAttackMove(skiffs, target.x, target.y);
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
