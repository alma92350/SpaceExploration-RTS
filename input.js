/* ============================================================
   Mouse + keyboard input: left-drag to box-select the player's own
   units, right-click to issue a context-sensitive order (attack an
   enemy, gather a node, or just move), a build-placement mode the HUD
   arms via startBuild(), and camera control (wheel to zoom, WASD/arrows
   to pan).
   ============================================================ */

"use strict";

import { issueMove, issueGather, issueAttack, issueAttackMove, issueBuild, issueAssistBuild, issueSetRally } from "./engine/commands.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isVisibleAt } from "./engine/fog.js";
import { createCamera, screenToWorld, zoomAt, panCamera } from "./camera.js";

const CLICK_THRESHOLD = 4;
const UNIT_PICK_RADIUS = 10;
const NODE_PICK_RADIUS = 14;
const ZOOM_STEP = 1.12;
const PAN_KEYS = {
  arrowleft: [-1, 0], a: [-1, 0],
  arrowright: [1, 0], d: [1, 0],
  arrowup: [0, -1], w: [0, -1],
  arrowdown: [0, 1], s: [0, 1],
};

export function attachInput(canvas, state, onChange) {
  const controller = new AbortController();
  const { signal } = controller;
  const camera = createCamera(state.map);
  const heldKeys = new Set();

  let dragBox = null;
  let buildMode = null;
  let lastWorldPos = { x: state.map.width / 2, y: state.map.height / 2 };

  function viewport() {
    return { vw: canvas.clientWidth, vh: canvas.clientHeight };
  }

  function toWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { vw, vh } = viewport();
    return screenToWorld(camera, vw, vh, clientX - rect.left, clientY - rect.top);
  }

  function entityAt(x, y) {
    for (const u of state.units.values()) {
      if (u.owner !== "player" && !isVisibleAt(state.fog, u.x, u.y)) continue;
      if (Math.hypot(u.x - x, u.y - y) <= UNIT_PICK_RADIUS) return u;
    }
    for (const b of state.buildings.values()) {
      if (b.owner !== "player" && !isVisibleAt(state.fog, b.x, b.y)) continue;
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
  }, { signal });

  canvas.addEventListener("mousemove", e => {
    lastWorldPos = toWorld(e.clientX, e.clientY);   // tracked continuously for the build-placement ghost
    if (!dragBox) return;
    dragBox.x2 = lastWorldPos.x;
    dragBox.y2 = lastWorldPos.y;
  }, { signal });

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
  }, { signal });

  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (buildMode) { buildMode = null; onChange(); return; }

    const p = toWorld(e.clientX, e.clientY);

    // A single selected production building sets its rally point instead
    // of the usual unit orders below (which need at least one unit
    // selected and don't apply to buildings at all).
    if (state.selection.length === 1) {
      const building = state.buildings.get(state.selection[0]);
      if (building && building.owner === "player" && BUILDINGS[building.type].produces) {
        issueSetRally(building, p.x, p.y);
        onChange();
        return;
      }
    }

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
  }, { signal });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const { vw, vh } = viewport();
    zoomAt(camera, state.map, vw, vh, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }, { signal, passive: false });

  window.addEventListener("keydown", e => heldKeys.add(e.key.toLowerCase()), { signal });
  window.addEventListener("keyup", e => heldKeys.delete(e.key.toLowerCase()), { signal });

  // Only exits build mode on an actual successful placement -- an
  // invalid spot (see engine/placement.js) or no eligible worker just
  // leaves the ghost up so the player can click again without having to
  // re-open the build menu. The ghost itself (drawBuildGhost in
  // render.js) already shows red/green before they even click.
  function placeBuildingAt(p) {
    const buildingType = buildMode.buildingType;
    const worker = state.selection.map(id => state.units.get(id)).find(u => u && u.cargo);
    const built = worker && issueBuild(state, worker.id, buildingType, p.x, p.y);
    if (built) buildMode = null;
    onChange();
  }

  return {
    getDragBox: () => dragBox,
    startBuild(buildingType) { buildMode = { buildingType }; },
    get building() { return buildMode; },
    getBuildGhost() { return buildMode ? { buildingType: buildMode.buildingType, x: lastWorldPos.x, y: lastWorldPos.y } : null; },
    getCamera: () => camera,
    tickCamera(dt) {
      let dx = 0, dy = 0;
      for (const key of heldKeys) {
        const dir = PAN_KEYS[key];
        if (dir) { dx += dir[0]; dy += dir[1]; }
      }
      const { vw, vh } = viewport();
      panCamera(camera, state.map, vw, vh, dx, dy, dt);
    },
    // Removes every listener this call added — without this, starting a
    // new game (map picker -> startGame again) would stack a second,
    // third, ... full set of handlers on the same canvas/window, each
    // reacting to one real click with a growing pile of stale ones.
    destroy() { controller.abort(); },
  };
}
