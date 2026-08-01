/* ============================================================
   Observer Mode: a free-look, read-only spectator over the Odyssey galaxy. Toggle it on (O)
   to reveal fog on whichever world you're looking at, jump the camera to ANY world or base —
   yours or a neighbour's — for free, and read a live stats panel (observerPanel.js) instead of
   issuing orders.

   Deliberately does not touch `game.state`, `game.galaxy.activeId`, or the real input camera:
   it only changes what gets DRAWN (boot.js's render callback swaps in observedState() + the
   camera below while active) and reads state that's already simulating regardless of what's
   on screen (stepGalaxy advances every world in the galaxy every tick, active or backgrounded
   — see engine/galaxy.js). So exiting always resumes normal play exactly where it was left,
   and nothing here can affect the deterministic sim.

   input.js delegates its mouse/wheel/keydown handlers to the small helpers below while
   game.observerMode is on, instead of running its own selection/order logic against the wrong
   world.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { createCamera, zoomAt, dragCamera, panCamera, clampCamera } from "./camera.js";
import { canvas } from "./dom.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { hostility, stanceLabel, aiDevelopment } from "./engine/diplomacy.js";
import { supplyUsed, supplyCap } from "./engine/supply.js";

const DOUBLE_PRESS_MS = 400;   // repeated Space within this window cycles bases, same feel as centerOnBase

// A small duplicate of input.js's own PAN_KEYS (not imported — input.js imports THIS module to
// delegate its handlers here while observing, so importing back the other way would cycle).
const PAN_KEYS = {
  arrowleft: [-1, 0], arrowright: [1, 0], d: [1, 0],
  arrowup: [0, -1], w: [0, -1],
  arrowdown: [0, 1], s: [0, 1],
};

// The world currently being spectated: the real active world's state when observerMode is
// off (so every other module can keep reading this without an `if (game.observerMode)` of its
// own), else whichever world spectateWorld() last pointed at.
export function observedState() {
  if (game.observerMode && game.galaxy) return game.galaxy.planets.get(game.spectateId) || game.state;
  return game.state;
}

// Any completed Command-Center-type building on `state`, regardless of owner — the whole point
// being to also land on a neighbour's capital, not just your own. Sorted by id for a stable
// cycling order (matches input.js's own player-only centerOnBase precedent).
export function findBases(state) {
  return [...state.buildings.values()]
    .filter(b => b.type === "command" && !b.constructing)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// Where to point the camera at a world we've just started spectating: its first base (any
// owner), else the map's own landing-zone marker, else createCamera's plain map-center default.
function initialFocus(state) {
  const bases = findBases(state);
  if (bases.length) return { x: bases[0].x, y: bases[0].y };
  const at = state.map.bases && (state.map.bases.player || state.map.bases.ai);
  return at ? { x: at.x, y: at.y } : null;
}

function pointCameraAt(state, at) {
  if (!game.observerCamera) return;
  if (at) { game.observerCamera.x = at.x; game.observerCamera.y = at.y; }
  clampCamera(game.observerCamera, state.map, canvas.clientWidth, canvas.clientHeight);
}

let obsBaseCycle = 0, lastObsBaseAt = -Infinity;

export function enterObserverMode() {
  if (!game.galaxy || game.observerMode) return;
  if (game.input) game.input.cancelGesture();   // don't let a drag armed just before this resolve into a real order
  game.observerMode = true;
  game.spectateId = game.galaxy.activeId;
  const real = game.input ? game.input.getCamera() : null;
  // Start exactly where normal play was looking — entering shouldn't jar the view — and only
  // recenter once actual observer navigation (Space / a starmap jump) asks for somewhere else.
  game.observerCamera = real ? { x: real.x, y: real.y, zoom: real.zoom } : createCamera(observedState().map);
  obsBaseCycle = 0; lastObsBaseAt = -Infinity;
}

export function exitObserverMode() {
  if (!game.observerMode) return;
  game.observerMode = false;
  game.spectateId = null;
  game.observerCamera = null;
}

export function toggleObserverMode() {
  if (game.observerMode) exitObserverMode(); else enterObserverMode();
}

// Free jump to any world's camera — no fuel, no canJumpTo gate, no real galaxy.activeId
// change. A no-op unless observerMode is actually on and the galaxy really has that world.
export function spectateWorld(id) {
  if (!game.observerMode || !game.galaxy || !game.galaxy.planets.has(id)) return;
  game.spectateId = id;
  obsBaseCycle = 0; lastObsBaseAt = -Infinity;
  pointCameraAt(game.galaxy.planets.get(id), initialFocus(game.galaxy.planets.get(id)));
}

// Space, while observing: cycle every completed Command Center on the spectated world, any
// owner — repeated presses within DOUBLE_PRESS_MS advance to the next one, same feel as
// input.js's own centerOnBase.
export function cycleObserverBase() {
  const state = observedState();
  if (!state) return;
  const bases = findBases(state);
  const now = performance.now();
  const cycling = bases.length > 0 && now - lastObsBaseAt < DOUBLE_PRESS_MS;
  lastObsBaseAt = now;
  if (!bases.length) { obsBaseCycle = 0; pointCameraAt(state, initialFocus(state)); return; }
  obsBaseCycle = cycling ? (obsBaseCycle + 1) % bases.length : 0;
  const at = bases[obsBaseCycle];
  pointCameraAt(state, { x: at.x, y: at.y });
}

/* ---------- camera input, delegated to from input.js while observerMode is on ---------- */

// `heldKeys` is input.js's own live Set (tickCamera calls this with it directly) — observer.js
// doesn't track keyboard state of its own, it just reads whichever keys are currently down.
export function tickObserverCamera(dt, heldKeys) {
  const state = observedState();
  if (!state || !game.observerCamera) return;
  let dx = 0, dy = 0;
  for (const key of heldKeys) {
    const dir = PAN_KEYS[key];
    if (dir) { dx += dir[0]; dy += dir[1]; }
  }
  panCamera(game.observerCamera, state.map, canvas.clientWidth, canvas.clientHeight, dx, dy, dt);
}

export function observerWheelZoom(clientX, clientY, rect, factor) {
  const state = observedState();
  if (!state || !game.observerCamera) return;
  zoomAt(game.observerCamera, state.map, rect.width, rect.height, clientX - rect.left, clientY - rect.top, factor);
}

let dragAnchor = null;
export function observerDragStart(clientX, clientY) { dragAnchor = { x: clientX, y: clientY }; }
export function observerDragMove(clientX, clientY) {
  if (!dragAnchor) return;
  const state = observedState();
  if (!state || !game.observerCamera) return;
  const dsx = clientX - dragAnchor.x, dsy = clientY - dragAnchor.y;
  dragAnchor = { x: clientX, y: clientY };
  dragCamera(game.observerCamera, state.map, canvas.clientWidth, canvas.clientHeight, dsx, dsy);
}
export function observerDragEnd() { dragAnchor = null; }

/* ---------- stats panel data (observerPanel.js formats/displays this) ---------- */

// Live unit/building tallies for `state`, grouped by owner then type — the panel's "what does
// this archetype actually field" readout. Plain counts, computed fresh every call (state.units/
// buildings are already live Maps — nothing here is cached or sampled over time; that's the
// analytics/history layer this intentionally doesn't attempt yet).
function tally(map, keyOf) {
  const byOwner = {};
  for (const e of map.values()) {
    const owner = e.owner;
    (byOwner[owner] ||= {});
    const k = keyOf(e);
    byOwner[owner][k] = (byOwner[owner][k] || 0) + 1;
  }
  return byOwner;
}

// A snapshot of everything the panel shows for `state` — pure data, no DOM, so it's directly
// testable and reusable if a future analytics view wants the same numbers on a timer.
export function observerStats(state) {
  const archetype = archetypeFor(state.planetId);
  const dip = state.diplomacy;
  const ai = state.players.ai;
  return {
    planetId: state.planetId,
    archetypeName: archetype.name,
    faction: archetype.faction,
    stance: dip ? dip.stance : null,
    stanceLabel: dip ? stanceLabel(dip.stance) : null,
    hostility: dip ? hostility(state) : null,
    pacified: !!(dip && dip.pacified),
    units: tally(state.units, u => u.type),
    buildings: tally(state.buildings, b => b.type),
    development: aiDevelopment(state),
    supplyUsed: supplyUsed(state, "ai"),
    supplyCap: supplyCap(state, "ai"),
    resources: ai ? { ...ai.resources } : {},
  };
}
