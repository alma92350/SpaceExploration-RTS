/* ============================================================
   Canvas rendering — the frame ORCHESTRATOR. Pure read of state — never mutates
   it. Assumes the caller already set up a device-pixel-ratio transform; drawFrame
   lays the camera transform on top, so every draw* helper works in plain world
   coordinates and never has to know about the viewport or camera itself.

   No image assets — the project is deliberately zero-dependency/no-build, so every
   entity is a small vector silhouette built from canvas paths rather than sprite
   files. To keep any one file from being a god object, the ~1900-line original was
   split into cohesive sibling modules that this file composes:
     • renderShared.js    — DETAIL, the facing/interpolation state, geometry+colour
                            primitives, inView culling, the health-bar primitive.
     • renderNodes.js     — resource-deposit silhouettes.
     • renderBuildings.js — building hulls + bars + Odyssey selection cues.
     • renderUnits.js     — unit hulls (two-pass) + overlays.
     • renderEffects.js   — tracers/flashes/pings, scenario route, ghosts, overlays.
   This file keeps drawFrame (the draw order), spriteIcon (the HUD button art),
   viewBounds, and the map backdrop (fog wash, terrain, screen-space fireworks).
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./engine/entities.js";
import { FOG_CELL_SIZE } from "./engine/fog.js";
import { activeFireworks } from "./effects.js";
import { DETAIL, facing, pruneFacing } from "./renderShared.js";
import { drawNodes } from "./renderNodes.js";
import { drawBuildings, drawBuildingShape, drawBuildingBars, drawJumpStaging, drawPowerGrid } from "./renderBuildings.js";
import { drawUnits, drawUnitShape } from "./renderUnits.js";
import { drawScenario, drawEffects, drawBuildGhost, drawWaypoints, drawEscortLinks,
         drawSelectionRings, drawRallyPoint, drawDragBox } from "./renderEffects.js";

// snapshotPositions + resetFacing live with the interpolation/facing state they drive
// (renderShared.js); re-export them here so boot.js keeps importing them from render.js.
export { snapshotPositions, resetFacing } from "./renderShared.js";

const ICON_BOX = 40;      // css px of the square icon
const ICON_R = 14;        // normalized sprite radius inside the box
const iconCache = new Map();
export function spriteIcon(kind, type, color = "#8fd3ff") {
  const key = `${kind}:${type}:${color}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let url = "";
  try {
    // Rasterize at device-pixel density (min 2×) so button art stays crisp next to the
    // DPR-scaled map art on a 3× display, instead of a fixed 2×.
    const scale = Math.max(2, Math.ceil((typeof window !== "undefined" && window.devicePixelRatio) || 1));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ICON_BOX * scale;
    const c = canvas.getContext("2d");
    c.scale(scale, scale);
    const def = kind === "unit" ? UNITS[type] : BUILDINGS[type];
    const actualR = (def && def.radius) || 16;
    c.translate(ICON_BOX / 2, ICON_BOX / 2);
    c.scale(ICON_R / actualR, ICON_R / actualR);      // normalize the sprite to ICON_R
    if (kind === "unit") {
      c.fillStyle = color; c.strokeStyle = DETAIL; c.lineWidth = 1.5;
      drawUnitShape(c, { id: "__icon__", type, x: 0, y: 0 }, def, color);
    } else {
      drawBuildingShape(c, { units: new Map(), buildings: new Map() }, { id: "__icon__", type, x: 0, y: 0, radius: actualR }, color);
    }
    facing.delete("__icon__");                          // don't leave a stray orientation in the shared map
    url = canvas.toDataURL();
  } catch (e) { url = ""; }
  if (url) iconCache.set(key, url);   // cache only a SUCCESSFUL render — a transient failure must retry, not
  return url;                          // permanently downgrade this button to text-only for the whole session
}

// The world-space rectangle currently on screen, padded so an entity straddling
// an edge still draws. Everything outside it is skipped — on a Gigantic (4x)
// map the vast majority of the field, its fog cells, and its entities are
// off-screen every frame, so culling is what keeps the draw cost bounded by
// what's visible rather than by total map size.
function viewBounds(camera, vw, vh, pad = 0) {
  const halfW = vw / (2 * camera.zoom), halfH = vh / (2 * camera.zoom);
  return {
    minX: camera.x - halfW - pad, maxX: camera.x + halfW + pad,
    minY: camera.y - halfH - pad, maxY: camera.y + halfH + pad,
  };
}

export function drawFrame(ctx, state, camera, viewportW, viewportH, dragBox, buildGhost, alpha = 1) {
  pruneFacing(state);
  ctx.save();
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, viewportW, viewportH);

  ctx.translate(viewportW / 2, viewportH / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  const view = viewBounds(camera, viewportW, viewportH, 40);   // 40px pad ≥ largest entity radius
  drawFogBase(ctx, state, view);
  drawTerrain(ctx, state, view);   // charted geography — under nodes/units, always visible
  // Resource deposits are charted map knowledge (see data.js), not
  // battlefield intel — they render at full visibility regardless of
  // fog, on top of the dimmed backdrop.
  drawNodes(ctx, state, view);
  if (state.scenario) drawScenario(ctx, state);   // the convoy route + stations, under the units
  drawBuildings(ctx, state, view);     // building hulls + foe pips (bars deferred below)
  drawUnits(ctx, state, view, alpha);  // unit hulls, then unit overlays (two passes)
  drawBuildingBars(ctx, state, view);  // building health bars last, so a passing ship can't paint them out
  drawJumpStaging(ctx, state, view);   // staging ring around a selected Spaceport (Odyssey)
  drawPowerGrid(ctx, state, view);     // efficiency zones around a selected Reactor (Odyssey)
  drawEffects(ctx);
  if (buildGhost) drawBuildGhost(ctx, state, buildGhost);
  drawWaypoints(ctx, state);
  drawEscortLinks(ctx, state);
  drawSelectionRings(ctx, state, alpha);
  drawRallyPoint(ctx, state);
  if (dragBox) drawDragBox(ctx, dragBox);

  ctx.restore();
  drawFireworks(ctx, viewportW, viewportH);   // screen-space (post-camera): milestone celebration, always on-screen
}

// Screen-space celebratory bursts for Odyssey progress milestones (see effects.js). Drawn
// AFTER the world/camera transform is popped, so a firework sits in viewport pixels and shows
// no matter where the camera is. Each spark flies out from its shell along its angle, arcs down
// under a little gravity, and fades as the shell ages; additive blending makes them glow.
function drawFireworks(ctx, vw, vh) {
  const shells = activeFireworks();
  if (!shells.length) return;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const f of shells) {
    const cx = f.cx * vw, cy = f.cy * vh;
    const ease = 1 - Math.pow(1 - f.age, 2);   // fast out, then settling
    const grav = 0.18 * f.age * f.age * vh;    // downward drift over the shell's life
    const alpha = Math.max(0, 1 - f.age);
    for (const p of f.parts) {
      const dist = p.spd * ease * vh;
      const x = cx + Math.cos(p.a) * dist;
      const y = cy + Math.sin(p.a) * dist + grav;
      ctx.beginPath();
      ctx.arc(x, y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 95%, ${58 + 22 * alpha}%, ${alpha})`;
      ctx.fill();
    }
  }
  ctx.restore();
}

// Explored-but-not-currently-visible cells get a faint cyan "charted space" wash so the
// player can see where they've already scouted — the same language the minimap uses. The
// old code painted this fill (and the unexplored one) in rgba(5,7,15,*), which IS the
// backdrop colour #05070f, so BOTH states were invisible: explored and unexplored ground
// rendered identically to empty space, and the promised scouted-territory cue never
// existed on the main map. Unexplored cells now draw nothing (bare backdrop reads as
// "unknown"); currently-visible cells draw nothing (the world underneath is at full
// brightness); only explored-not-visible cells get the wash.
function drawFogBase(ctx, state, view) {
  const fog = state.fog;
  if (!fog) return;
  // Only the cells overlapping the viewport — clamped to the grid — instead of
  // all rows*cols every frame (16k+ on a 4x map).
  const gx0 = view ? Math.max(0, Math.floor(view.minX / FOG_CELL_SIZE)) : 0;
  const gx1 = view ? Math.min(fog.cols - 1, Math.floor(view.maxX / FOG_CELL_SIZE)) : fog.cols - 1;
  const gy0 = view ? Math.max(0, Math.floor(view.minY / FOG_CELL_SIZE)) : 0;
  const gy1 = view ? Math.min(fog.rows - 1, Math.floor(view.maxY / FOG_CELL_SIZE)) : fog.rows - 1;
  ctx.fillStyle = "rgba(79, 209, 255, 0.05)";   // charted-but-not-live wash (matches the minimap)
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const idx = gy * fog.cols + gx;
      if (fog.visible[idx] || !fog.explored[idx]) continue;   // live cells and never-seen cells draw nothing
      ctx.fillRect(gx * FOG_CELL_SIZE, gy * FOG_CELL_SIZE, FOG_CELL_SIZE, FOG_CELL_SIZE);
    }
  }
}

// Terrain washes, drawn as charted geography beneath everything else. Rough
// ground reads as a cool slate haze, high ground as a warm gold glow — subtle,
// so it shapes the field without fighting the units for attention. OPEN cells
// (the majority) draw nothing; viewport-culled like the fog base, so on a big
// map the cost tracks the feature cells actually on screen.
const TERRAIN_FILL = { 1: "rgba(120, 140, 180, 0.16)", 2: "rgba(255, 209, 102, 0.13)" };
function drawTerrain(ctx, state, view) {
  const t = state.map.terrain;
  if (!t) return;
  const gx0 = view ? Math.max(0, Math.floor(view.minX / t.cell)) : 0;
  const gx1 = view ? Math.min(t.cols - 1, Math.floor(view.maxX / t.cell)) : t.cols - 1;
  const gy0 = view ? Math.max(0, Math.floor(view.minY / t.cell)) : 0;
  const gy1 = view ? Math.min(t.rows - 1, Math.floor(view.maxY / t.cell)) : t.rows - 1;
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const code = t.type[gy * t.cols + gx];
      if (!code) continue;
      ctx.fillStyle = TERRAIN_FILL[code];
      ctx.fillRect(gx * t.cell, gy * t.cell, t.cell + 1, t.cell + 1);   // +1 hides cell seams
    }
  }
}
