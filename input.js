/* ============================================================
   Mouse + keyboard input: left-drag to box-select the player's own
   units, right-click to issue a context-sensitive order (attack an
   enemy, gather a node, or just move), a build-placement mode the HUD
   arms via startBuild(), and camera control (wheel to zoom, WASD/arrows
   to pan).
   ============================================================ */

"use strict";

import { issueMove, issueGather, issueAttack, issueAttackMove, issueBuild, issueAssistBuild, issueSetRally, issueStop, issueScout, issueHold, issueEscort } from "./engine/commands.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isVisibleAt, isNodeDiscovered } from "./engine/fog.js";
import { createCamera, screenToWorld, zoomAt, panCamera, clampCamera, dragCamera, pinchZoomPan } from "./camera.js";
import * as sound from "./sound.js";

const CLICK_THRESHOLD = 4;
const UNIT_PICK_RADIUS = 10;
const NODE_PICK_RADIUS = 14;
const ZOOM_STEP = 1.12;
const EDGE_SCROLL_MARGIN = 20;   // px from a canvas edge that starts scrolling the camera
// A is deliberately NOT a pan key — it's reserved for attack-move (the genre
// standard). Pan left with the arrow key or edge-scroll.
const PAN_KEYS = {
  arrowleft: [-1, 0],
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
  let attackMoveArmed = false;   // set by the A key; the next left-click issues an attack-move
  let lastWorldPos = { x: state.map.width / 2, y: state.map.height / 2 };
  const groups = new Map();          // control groups: digit -> [unit ids]
  let idleCycle = 0;                 // round-robins through idle workers on repeated presses
  let edgePan = [0, 0];              // camera nudge from the cursor sitting at a screen edge

  // ---- touch state ----
  // One finger = tap-to-select / tap-to-command / drag-a-box; two fingers =
  // pinch-zoom + pan. See the touch handlers below for the full gesture map.
  let touchStart = null;         // { cx, cy, wx, wy, moved } for the active one-finger drag (client + world)
  let pinchPrev = null;          // last two-finger snapshot { ax, ay, bx, by } for pinchZoomPan
  let gestureActive = false;     // a two-finger gesture happened; ignore fingers until all lift
  let lastTapAt = 0, lastTapCX = 0, lastTapCY = 0;   // for double-tap detection (client coords + time)

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
    return state.map.nodes.find(n => n.amount > 0 && isNodeDiscovered(state.fog, n)
      && Math.hypot(n.x - x, n.y - y) <= NODE_PICK_RADIUS) || null;
  }

  // Attack-move to (x,y): combat units advance-and-engage anything met on the
  // way; non-combat units (workers, the Ranger) can't attack-move, so they just
  // move. Same split the Ctrl-queue and minimap-command paths use.
  function aggressiveMove(units, x, y, queue = false) {
    const combatants = units.filter(u => UNITS[u.type].role === "combat");
    const others = units.filter(u => UNITS[u.type].role !== "combat");
    if (combatants.length) issueAttackMove(combatants, x, y, queue);
    if (others.length) issueMove(others, x, y, queue);
  }

  // The A key arms attack-move; the crosshair cursor + field tint show it's armed, and the
  // HUD's Attack-Move button flips to its ARMED state. onChange() is what makes that button
  // rebuild — without it, arming via the A key (or a right-click cancel) changed nothing the
  // player could see on the panel until some unrelated HUD tick happened to rebuild it.
  function setArmed(v) {
    if (attackMoveArmed === v) return;
    attackMoveArmed = v;
    canvas.classList.toggle("aim-cursor", v);
    onChange();
  }

  // First real touch flips the app into touch mode: CSS (style.css) grows the
  // tap targets and the HUD swaps to the touch legend. Idempotent.
  function onTouchActive() {
    if (!document.body.classList.contains("touch")) document.body.classList.add("touch");
  }

  // ---- shared selection / command logic ----
  // Extracted so the mouse and touch paths issue byte-identical orders: a
  // finger-tap runs exactly the same routing as a right-click, a drag-box the
  // same as a mouse box, and a double-tap the same as a double-click.

  // Resolve a world-space selection box (a tiny box is a point-pick) into the new
  // selection, additively when asked. Returns the ids picked.
  function applyBoxSelection(box, additive) {
    const dx = Math.abs(box.x2 - box.x1), dy = Math.abs(box.y2 - box.y1);
    let picks;
    if (dx < CLICK_THRESHOLD && dy < CLICK_THRESHOLD) {
      const hit = entityAt(box.x1, box.y1);
      picks = hit && hit.owner === "player" ? [hit.id] : [];
    } else {
      const x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2);
      const y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2);
      let inBox = [...state.units.values()]
        .filter(u => u.owner === "player" && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2);
      // Prioritise the army: a box that catches any fighter drops the workers, so
      // sweeping across your base to grab your army doesn't drag the miners along
      // (standard RTS). A box with no fighters still selects the workers as before.
      if (inBox.some(u => UNITS[u.type].role === "combat"))
        inBox = inBox.filter(u => u.type !== "worker");
      picks = inBox.map(u => u.id);
    }
    if (additive) {
      if (picks.length) state.selection = [...new Set([...state.selection, ...picks])];
    } else {
      state.selection = picks;
    }
    if (picks.length) sound.playSelect();
    onChange();
    return picks;
  }

  // Grab every same-type unit of yours currently on screen (the double-click /
  // double-tap gesture). Returns true if it hit one of your units.
  function selectSameTypeAt(p) {
    const hit = entityAt(p.x, p.y);
    if (!hit || hit.owner !== "player" || hit.kind !== "unit") return false;
    const { vw, vh } = viewport();
    const tl = screenToWorld(camera, vw, vh, 0, 0);
    const br = screenToWorld(camera, vw, vh, vw, vh);
    state.selection = [...state.units.values()]
      .filter(u => u.owner === "player" && u.type === hit.type
        && u.x >= tl.x && u.x <= br.x && u.y >= tl.y && u.y <= br.y)
      .map(u => u.id);
    onChange();
    return true;
  }

  // The context command at a world point (the right-click / touch command-tap):
  // a single selected production building sets its rally; otherwise the current
  // unit selection assists-builds, attacks, gathers, or moves as the target
  // warrants. `queue` chains it as a waypoint instead of replacing the order.
  function commandAt(p, queue) {
    if (state.selection.length === 1) {
      const building = state.buildings.get(state.selection[0]);
      if (building && building.owner === "player" && BUILDINGS[building.type].produces) {
        const node = nodeAt(p.x, p.y);
        issueSetRally(building, p.x, p.y, node ? node.id : null);
        sound.playOrder();
        onChange();
        return;
      }
    }

    const selected = state.selection.map(id => state.units.get(id)).filter(Boolean);
    if (!selected.length) return;

    const target = entityAt(p.x, p.y);
    if (target && target.owner === "player" && target.kind === "building" && target.constructing) {
      const workers = selected.filter(u => u.cargo);
      if (workers.length) { issueAssistBuild(workers, target.id, queue); sound.playOrder(); }
      return;
    }
    if (target && target.owner !== "player") {
      const attackers = selected.filter(u => UNITS[u.type].attack);
      if (attackers.length) { issueAttack(attackers, target.id, queue); sound.playOrder(); }
      return;
    }
    // A friendly SHIP as the target: the selection forms a protective escort ring around it and
    // follows it wherever it's ordered (engine/commands.js issueEscort). The target itself is
    // excluded, so right-clicking a ship that's part of the selection escorts it with the rest.
    if (target && target.owner === "player" && target.kind === "unit") {
      const escorts = selected.filter(u => u.id !== target.id);
      if (escorts.length) { issueEscort(escorts, target.id, queue); sound.playOrder(); return; }
    }
    const node = nodeAt(p.x, p.y);
    if (node) {
      const workers = selected.filter(u => u.cargo);
      if (workers.length) { issueGather(workers, node.id, queue); sound.playOrder(); }
      return;
    }
    if (queue) aggressiveMove(selected, p.x, p.y, true);
    else issueMove(selected, p.x, p.y);
    sound.playOrder();
  }

  canvas.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    const p = toWorld(e.clientX, e.clientY);
    if (buildMode) { placeBuildingAt(p); return; }
    // Armed attack-move: this click commits the order instead of starting a
    // selection drag. Consumes the arm, whether or not anything is selected.
    if (attackMoveArmed) {
      setArmed(false);
      const selected = selectedUnits();
      if (selected.length) { aggressiveMove(selected, p.x, p.y); sound.playOrder(); onChange(); }
      return;
    }
    dragBox = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  }, { signal });

  canvas.addEventListener("mousemove", e => {
    lastWorldPos = toWorld(e.clientX, e.clientY);   // tracked continuously for the build-placement ghost
    // Edge scroll: cursor within a margin of a canvas edge nudges the camera
    // that way, so you can drag the view without touching the keyboard.
    const rect = canvas.getBoundingClientRect();
    const lx = e.clientX - rect.left, ly = e.clientY - rect.top;
    edgePan = [
      lx < EDGE_SCROLL_MARGIN ? -1 : lx > rect.width - EDGE_SCROLL_MARGIN ? 1 : 0,
      ly < EDGE_SCROLL_MARGIN ? -1 : ly > rect.height - EDGE_SCROLL_MARGIN ? 1 : 0,
    ];
    if (!dragBox) return;
    dragBox.x2 = lastWorldPos.x;
    dragBox.y2 = lastWorldPos.y;
  }, { signal });
  canvas.addEventListener("mouseleave", () => { edgePan = [0, 0]; }, { signal });

  window.addEventListener("mouseup", e => {
    if (e.button !== 0 || !dragBox) return;
    const box = dragBox;
    dragBox = null;
    // Ctrl (the game's modifier — see the waypoint note below) adds to the
    // current selection instead of replacing it, so you can pull several groups
    // together. An empty additive click leaves the selection untouched.
    applyBoxSelection(box, e.ctrlKey);
  }, { signal });

  // Double-click a unit to grab every same-type unit of yours currently on
  // screen — the standard "select all of this type" gesture.
  canvas.addEventListener("dblclick", e => {
    selectSameTypeAt(toWorld(e.clientX, e.clientY));
  }, { signal });

  canvas.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (buildMode) { buildMode = null; onChange(); return; }
    if (attackMoveArmed) { setArmed(false); return; }   // right-click cancels a pending attack-move

    // Holding Ctrl queues the order as a waypoint instead of replacing what the
    // units are doing, so a sequence of Ctrl+right-clicks lays down a path
    // (move/attack/gather steps) the units run through in order. A plain
    // right-click issues immediately and clears any queued waypoints. NOT Shift:
    // Firefox force-shows the native context menu on Shift+right-click and
    // bypasses preventDefault, so a Shift-queued order could never be captured.
    commandAt(toWorld(e.clientX, e.clientY), e.ctrlKey);
  }, { signal });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const { vw, vh } = viewport();
    zoomAt(camera, state.map, vw, vh, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }, { signal, passive: false });

  /* ---------- touch (phones / tablets) ----------
     A one-button, no-hover parallel to the mouse controls, so the game is fully
     playable by finger:
       • tap your unit/building ....... select it (double-tap = all of that type on screen)
       • tap elsewhere ................ command the selection (move / attack a foe / gather a
                                        node), or set a selected production building's rally
       • one-finger drag .............. box-select your units
       • two-finger drag .............. pan · pinch ...... zoom (about the pinch)
       • Build mode / Attack-move ..... tap places the building / commits the attack-move
     Runs the SAME applyBoxSelection / commandAt / selectSameTypeAt / placeBuildingAt as the
     mouse, so touch and desktop issue identical orders. `touch-action: none` on the canvas
     (style.css) stops the browser hijacking these as page scroll / zoom. */
  const TAP_MOVE_TOL = 14;    // client px a finger may travel and still count as a tap, not a drag
  const DOUBLE_TAP_MS = 300, DOUBLE_TAP_DIST = 30;

  function twoSnapshot(t0, t1) {
    const rect = canvas.getBoundingClientRect();
    return { ax: t0.clientX - rect.left, ay: t0.clientY - rect.top,
             bx: t1.clientX - rect.left, by: t1.clientY - rect.top };
  }

  canvas.addEventListener("touchstart", e => {
    e.preventDefault();
    onTouchActive();
    if (e.touches.length >= 2) {
      // Second finger down: abandon any one-finger drag/box and start pinch-pan.
      touchStart = null; dragBox = null; gestureActive = true;
      pinchPrev = twoSnapshot(e.touches[0], e.touches[1]);
      return;
    }
    if (e.touches.length === 1 && !gestureActive) {
      const t = e.touches[0];
      const w = toWorld(t.clientX, t.clientY);
      touchStart = { cx: t.clientX, cy: t.clientY, wx: w.x, wy: w.y, moved: false };
      lastWorldPos = w;   // so the build ghost sits under the finger from the first touch
    }
  }, { signal, passive: false });

  canvas.addEventListener("touchmove", e => {
    e.preventDefault();
    const { vw, vh } = viewport();
    if (e.touches.length >= 2 && pinchPrev) {
      const cur = twoSnapshot(e.touches[0], e.touches[1]);
      pinchZoomPan(camera, state.map, vw, vh, pinchPrev, cur);
      pinchPrev = cur;
      return;
    }
    if (e.touches.length === 1 && touchStart && !gestureActive) {
      const t = e.touches[0];
      const w = toWorld(t.clientX, t.clientY);
      lastWorldPos = w;
      if (!touchStart.moved && Math.hypot(t.clientX - touchStart.cx, t.clientY - touchStart.cy) > TAP_MOVE_TOL) {
        touchStart.moved = true;
        // A drag that isn't placing a building becomes a selection box.
        if (!buildMode) dragBox = { x1: touchStart.wx, y1: touchStart.wy, x2: w.x, y2: w.y };
      }
      if (dragBox) { dragBox.x2 = w.x; dragBox.y2 = w.y; }
    }
  }, { signal, passive: false });

  function endTouch(e) {
    e.preventDefault();
    if (e.touches.length >= 2) { pinchPrev = twoSnapshot(e.touches[0], e.touches[1]); return; }
    if (e.touches.length === 1) {
      // Dropped from two fingers to one: don't let the leftover finger act — wait
      // for a clean, all-up release so a lifted pinch never fires a stray tap.
      pinchPrev = null;
      return;
    }
    // All fingers up.
    if (gestureActive) { gestureActive = false; touchStart = null; dragBox = null; return; }
    if (!touchStart) return;
    const start = touchStart; touchStart = null;

    if (start.moved && dragBox) {          // a drag: finish the selection box
      const box = dragBox; dragBox = null;
      applyBoxSelection(box, false);
      return;
    }
    dragBox = null;
    const p = { x: start.wx, y: start.wy };

    // In build mode, place at where the finger LIFTED (lastWorldPos tracks the
    // move) so a drag-to-position works; for a plain tap that's the tap point.
    if (buildMode) { placeBuildingAt(lastWorldPos); return; }
    if (attackMoveArmed) {
      setArmed(false);
      const sel = selectedUnits();
      if (sel.length) { aggressiveMove(sel, p.x, p.y); sound.playOrder(); onChange(); }
      return;
    }

    // A quick second tap near the first upgrades to select-all-of-type.
    const now = performance.now();   // UI-only timing; the deterministic sim never reads a clock
    const isDouble = now - lastTapAt < DOUBLE_TAP_MS
      && Math.hypot(start.cx - lastTapCX, start.cy - lastTapCY) < DOUBLE_TAP_DIST;
    lastTapAt = now; lastTapCX = start.cx; lastTapCY = start.cy;
    if (isDouble && selectSameTypeAt(p)) return;

    // Single tap: your own entity selects; anything else is a command to the
    // current selection (mirrors left-click select vs right-click order).
    const hit = entityAt(p.x, p.y);
    if (hit && hit.owner === "player") {
      state.selection = [hit.id];
      sound.playSelect();
      onChange();
    } else {
      commandAt(p, false);
    }
  }
  canvas.addEventListener("touchend", endTouch, { signal, passive: false });
  canvas.addEventListener("touchcancel", endTouch, { signal, passive: false });

  function alivePlayerUnitIds(ids) {
    return ids.filter(id => { const u = state.units.get(id); return u && u.owner === "player"; });
  }
  function selectedUnits() {
    return state.selection.map(id => state.units.get(id)).filter(Boolean);
  }
  function centerCamera(x, y) {
    const { vw, vh } = viewport();
    camera.x = x; camera.y = y;
    clampCamera(camera, state.map, vw, vh);
  }
  function recallGroup(digit) {
    const ids = alivePlayerUnitIds(groups.get(digit) || []);
    if (ids.length) state.selection = ids;
  }
  function stopSelected() {
    issueStop(selectedUnits());
  }
  // Send every selected Ranger off to chart the map on its own (see scout.js).
  // A no-op if nothing scout-role is selected.
  function scoutSelected() {
    issueScout(selectedUnits());
  }
  // Put selected combat units into the Hold-position stance.
  function holdSelected() {
    issueHold(selectedUnits());
  }
  function selectAllArmy() {
    state.selection = [...state.units.values()]
      .filter(u => u.owner === "player" && UNITS[u.type].role === "combat")
      .map(u => u.id);
  }
  // Cycle to the next worker of yours that's sitting idle (no order, no queued
  // waypoints) — selecting it and centering the camera on it, so a stalled
  // gatherer on a big map is one keypress away instead of a manual hunt.
  function focusIdleWorker() {
    const idle = [...state.units.values()].filter(u =>
      u.owner === "player" && u.type === "worker" && !u.order && (!u.orderQueue || !u.orderQueue.length));
    if (!idle.length) return;
    const w = idle[idleCycle % idle.length];
    idleCycle++;
    state.selection = [w.id];
    centerCamera(w.x, w.y);
    onChange();
  }

  window.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    heldKeys.add(k);   // still feeds the WASD/arrow camera pan
    if (e.repeat) return;
    // Match on e.code, not e.key: with Shift held the number row's e.key becomes
    // "!@#…", so only the physical Digit1–9 code is reliable for the bind case.
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) {
      // Shift+digit binds the current selection to a control group; a plain
      // digit recalls it. (Ctrl+digit is the browser's own tab-switch shortcut
      // and can't be reliably suppressed, so Shift is the bind modifier here.)
      if (e.shiftKey) groups.set(digit[1], [...state.selection]);
      else recallGroup(digit[1]);
      onChange();
      return;
    }
    if (k === "x") { stopSelected(); onChange(); return; }
    if (k === "q") { selectAllArmy(); onChange(); return; }
    if (k === "e") { scoutSelected(); onChange(); return; }   // send selected Rangers to auto-scout
    if (k === "a") { setArmed(true); return; }        // arm attack-move; next left-click commits it
    if (k === "h") { holdSelected(); onChange(); return; }   // hold position
    if (k === "escape") { setArmed(false); buildMode = null; onChange(); return; }   // bail out of a pending action
    if (k === "`") { focusIdleWorker(); return; }   // it calls onChange itself
  }, { signal });
  window.addEventListener("keyup", e => heldKeys.delete(e.key.toLowerCase()), { signal });

  // Only exits build mode on an actual successful placement -- an
  // invalid spot (see engine/colliders.js) or no eligible worker just
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
    focusIdleWorker,
    selectAllArmy: () => { selectAllArmy(); onChange(); },
    // Narrow the current selection to one unit type — the HUD's aggregated type rows
    // are clickable (hud.js), so clicking "12× Skiff" keeps only the Skiffs.
    selectType(type) {
      const ids = state.selection
        .map(id => state.units.get(id)).filter(u => u && u.type === type).map(u => u.id);
      if (ids.length) { state.selection = ids; sound.playSelect(); onChange(); }
    },
    stopSelected: () => { stopSelected(); onChange(); },
    scoutSelected: () => { scoutSelected(); onChange(); },
    holdSelected: () => { holdSelected(); onChange(); },
    // Attack-move as a HUD button (touch has no A key): toggle it, cancel it, and
    // read the armed state so the button can show as active.
    toggleAttackMove: () => { setArmed(!attackMoveArmed); onChange(); },
    get attackArmed() { return attackMoveArmed; },
    tickCamera(dt) {
      let dx = edgePan[0], dy = edgePan[1];
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
