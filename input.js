/* ============================================================
   Mouse input: left-drag to box-select the player's own units, right-
   click to issue a context-sensitive order (attack an enemy, gather a
   node, or just move), and a build-placement mode the HUD arms via
   startBuild().
   ============================================================ */

"use strict";

import { MAP_WIDTH, MAP_HEIGHT } from "./engine/map.js";
import { issueMove, issueGather, issueAttack, issueAttackMove, issueBuild, issueAssistBuild } from "./engine/commands.js";
import { UNITS } from "./engine/entities.js";

const CLICK_THRESHOLD = 4;
const UNIT_PICK_RADIUS = 10;
const NODE_PICK_RADIUS = 14;

export function attachInput(canvas, state, onChange) {
  let dragBox = null;
  let buildMode = null;

  function toWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * MAP_WIDTH,
      y: ((clientY - rect.top) / rect.height) * MAP_HEIGHT,
    };
  }

  function entityAt(x, y) {
    for (const u of state.units.values()) {
      if (Math.hypot(u.x - x, u.y - y) <= UNIT_PICK_RADIUS) return u;
    }
    for (const b of state.buildings.values()) {
      if (Math.abs(b.x - x) <= b.radius && Math.abs(b.y - y) <= b.radius) return b;
    }
    return null;
  }

  function nodeAt(x, y) {
    return state.map.nodes.find(n => n.amount > 0 && Math.hypot(n.x - x, n.y - y) <= NODE_PICK_RADIUS) || null;
  }

  canvas.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    const p = toWorld(e.clientX, e.clientY);
    if (buildMode) { placeBuildingAt(p); return; }
    dragBox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  });

  canvas.addEventListener("mousemove", e => {
    if (!dragBox) return;
    const p = toWorld(e.clientX, e.clientY);
    dragBox.x2 = p.x;
    dragBox.y2 = p.y;
  });

  window.addEventListener("mouseup", e => {
    if (e.button !== 0 || !dragBox) return;
    const box = dragBox;
    dragBox = null;
    const dx = Math.abs(box.x2 - box.x1), dy = Math.abs(box.y2 - box.y1);
    if (dx < CLICK_THRESHOLD && dy < CLICK_THRESHOLD) {
      const hit = entityAt(box.x1, box.y1);
      state.selection = hit && hit.owner === "player" ? [hit.id] : [];
    } else {
      const x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2);
      const y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2);
      state.selection = [...state.units.values()]
        .filter(u => u.owner === "player" && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2)
        .map(u => u.id);
    }
    onChange();
  });

  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (buildMode) { buildMode = null; onChange(); return; }

    const p = toWorld(e.clientX, e.clientY);
    const selected = state.selection.map(id => state.units.get(id)).filter(Boolean);
    if (!selected.length) return;

    const target = entityAt(p.x, p.y);
    if (target && target.owner === "player" && target.kind === "building" && target.constructing) {
      const workers = selected.filter(u => u.cargo);
      if (workers.length) issueAssistBuild(workers, target.id);
      return;
    }

    if (target && target.owner !== "player") {
      const attackers = selected.filter(u => UNITS[u.type].role === "combat");
      if (attackers.length) issueAttack(attackers, target.id);
      return;
    }

    const node = nodeAt(p.x, p.y);
    if (node) {
      const workers = selected.filter(u => u.cargo);
      if (workers.length) issueGather(workers, node.id);
      return;
    }

    // Plain right-click is a real move: it goes exactly where clicked,
    // ignoring any enemy it passes. Shift+right-click is the deliberate
    // aggressive-advance option (attack-move) for combat units, which
    // stops to fight anything encountered along the way.
    if (e.shiftKey) {
      const combatants = selected.filter(u => UNITS[u.type].role === "combat");
      const others = selected.filter(u => UNITS[u.type].role !== "combat");
      if (combatants.length) issueAttackMove(combatants, p.x, p.y);
      if (others.length) issueMove(others, p.x, p.y);
    } else {
      issueMove(selected, p.x, p.y);
    }
  });

  function placeBuildingAt(p) {
    const buildingType = buildMode.buildingType;
    buildMode = null;
    const worker = state.selection.map(id => state.units.get(id)).find(u => u && u.cargo);
    if (worker) issueBuild(state, worker.id, buildingType, p.x, p.y);
    onChange();
  }

  return {
    getDragBox: () => dragBox,
    startBuild(buildingType) { buildMode = { buildingType }; },
    get building() { return buildMode; },
  };
}
