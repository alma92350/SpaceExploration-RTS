/* ============================================================
   Entry point / composition root. The game is split across focused modules —
   dom (element handles), session (the live state/input holder), setup (splash),
   boot (the run loop + frame events), hud (selection panel + readouts),
   overlays (chips/objectives/help), saveload (localStorage). Importing them here
   evaluates each module, which self-wires its own listeners; this file owns the
   remaining top-level chrome (mute, volume, the canvases' resize/backing store,
   the minimap commands, the sheet-collapse toggle, the touch-mode flag) and
   kicks the first screen off.
   ============================================================ */

"use strict";

import { game } from "./session.js";
import {
  canvas, ctx, minimapCanvas, minimapCtx, muteBtn, volumeEl,
  idleWorkersEl, sheetToggleEl, MINIMAP_W, MINIMAP_H, isTouchMode,
} from "./dom.js";
import { clampCamera } from "./camera.js";
import { minimapToWorld } from "./minimap.js";
import { issueMove, issueAttackMove } from "./engine/commands.js";
import { UNITS } from "./engine/entities.js";
import * as sound from "./sound.js";
import { buildHelpOverlay } from "./overlays.js";
import { renderMapSelect } from "./setup.js";
import "./starmap.js";   // self-wires the galaxy-map button + M key
import "./update.js";    // self-wires the version chip + auto-update check

idleWorkersEl.addEventListener("click", () => { if (game.input) game.input.focusIdleWorker(); });

muteBtn.addEventListener("click", () => {
  const next = !sound.isMuted();
  sound.setMuted(next);
  muteBtn.setAttribute("aria-pressed", String(next));
  muteBtn.textContent = next ? "🔇" : "🔊";
});

if (volumeEl) {
  volumeEl.addEventListener("input", () => sound.setVolume(Number(volumeEl.value) / 100));
}

// Right-click is a game command (move / attack / gather / queue a waypoint),
// so the browser's own context menu must never pop over the game. The canvas
// already suppresses it for clicks that land squarely on it, but the view has
// padding around the canvas and the minimap sits on top of it — a right-click
// on either of those would otherwise open the native menu. One window-level
// listener covers the whole window in one place.
window.addEventListener("contextmenu", e => e.preventDefault());

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);    // round so a fractional DPR (e.g. 1.25) doesn't
  canvas.height = Math.round(canvas.clientHeight * dpr);  // leave a sub-pixel sliver unrendered at the edges
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeCanvas);

// A monitor move (or an OS scaling change) can change devicePixelRatio WITHOUT firing a resize
// event — the CSS layout size is unchanged — leaving the backing store at the old DPR (blurry on
// the sharper screen, oversampled on the other). matchMedia on the current dppx fires once when
// the ratio leaves it; refit both canvases and re-arm for the new ratio.
function watchDPR() {
  if (!window.matchMedia) return;
  window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    .addEventListener("change", () => { resizeCanvas(); resizeMinimap(); watchDPR(); }, { once: true });
}

// Portrait bottom-sheet collapse: hide the panel to reclaim the whole screen,
// then resize the canvas into the freed space. The button only shows in the
// portrait layout (style.css); the class is scoped to that layout too, so it's
// inert on desktop/landscape.
sheetToggleEl.addEventListener("click", () => {
  const collapsed = document.body.classList.toggle("sheet-collapsed");
  sheetToggleEl.textContent = collapsed ? "▴" : "▾";
  requestAnimationFrame(resizeCanvas);   // the view grew/shrank — refit the backing store
});

function resizeMinimap() {
  const dpr = window.devicePixelRatio || 1;
  minimapCanvas.width = Math.round(MINIMAP_W * dpr);
  minimapCanvas.height = Math.round(MINIMAP_H * dpr);
  minimapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeMinimap);

// Attached once, not per-game: state/input are read fresh from the shared session
// at click time, so this stays correct across a "choose another battlefield"
// restart without needing to re-wire on every startGame().
minimapCanvas.addEventListener("click", e => {
  if (!game.state || !game.input) return;
  const rect = minimapCanvas.getBoundingClientRect();
  // Convert against the minimap's ACTUAL rendered size, not the fixed logical MINIMAP_W/H:
  // the CSS shrinks the element on small/portrait viewports (style.css), so using the
  // constant sent a phone tap on the right edge to ~56% of the map instead of the edge.
  const world = minimapToWorld(game.state.map, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
  const camera = game.input.getCamera();
  camera.x = world.x;
  camera.y = world.y;
  clampCamera(camera, game.state.map, canvas.clientWidth, canvas.clientHeight);
});

// Right-click the minimap to command the current selection to that spot without
// scrolling the main view first — move for workers, attack-move for combat, so
// you can respond to a raid on a far flank straight from the map.
minimapCanvas.addEventListener("contextmenu", e => {
  e.preventDefault();
  if (!game.state || !game.input) return;
  const rect = minimapCanvas.getBoundingClientRect();
  const world = minimapToWorld(game.state.map, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);   // actual size, not MINIMAP_W/H (see the click handler)
  const selected = game.state.selection.map(id => game.state.units.get(id)).filter(Boolean);
  if (!selected.length) return;
  const combatants = selected.filter(u => UNITS[u.type].role === "combat");
  const others = selected.filter(u => UNITS[u.type].role !== "combat");
  if (combatants.length) issueAttackMove(combatants, world.x, world.y);
  if (others.length) issueMove(others, world.x, world.y);
});

// Touch mode: the first finger anywhere grows the tap targets (style.css) and
// switches the HUD hints to touch phrasing. input.js sets the class on a canvas
// touch too; doing it here covers a first touch that lands on a HUD button. The
// panel signature includes isTouchMode(), so the loop's next renderHUD rebuilds
// the legend/hints in touch phrasing on its own.
window.addEventListener("touchstart", () => {
  if (!isTouchMode()) document.body.classList.add("touch");
}, { passive: true });

// ---- kickoff (all modules are evaluated by now, so these cross-module calls
// are safe) ----
buildHelpOverlay();
renderMapSelect();
resizeCanvas();
resizeMinimap();
watchDPR();
