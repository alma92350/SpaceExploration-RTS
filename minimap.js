/* ============================================================
   Minimap: a small fixed-scale top-down view of the whole map, drawn
   into its own canvas each render frame. Same fog/ownership visibility
   rules as the main view (engine/fog.js) — it's a spatial summary of
   what render.js already draws, not a separate source of knowledge.
   ============================================================ */

"use strict";

import { isVisibleAt, FOG_CELL_SIZE } from "./engine/fog.js";

export function drawMinimap(ctx, state, camera, viewportW, viewportH, mmW, mmH) {
  const { map } = state;
  const sx = mmW / map.width, sy = mmH / map.height;

  ctx.save();
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, mmW, mmH);

  // Dim wash over ever-explored ground so the minimap reads as "known
  // space" at a glance -- no separate visible/explored distinction at
  // this scale, since the entity dots below already show what's live.
  const fog = state.fog;
  if (fog) {
    ctx.fillStyle = "rgba(79, 209, 255, 0.06)";
    for (let gy = 0; gy < fog.rows; gy++) {
      for (let gx = 0; gx < fog.cols; gx++) {
        if (!fog.explored[gy * fog.cols + gx]) continue;
        ctx.fillRect(gx * FOG_CELL_SIZE * sx, gy * FOG_CELL_SIZE * sy, FOG_CELL_SIZE * sx + 1, FOG_CELL_SIZE * sy + 1);
      }
    }
  }

  ctx.fillStyle = "#ffd166";
  ctx.globalAlpha = 0.7;
  for (const n of map.nodes) {
    if (n.amount <= 0) continue;
    ctx.fillRect(n.x * sx - 1, n.y * sy - 1, 2, 2);
  }
  ctx.globalAlpha = 1;

  for (const b of state.buildings.values()) {
    if (b.owner !== "player" && !isVisibleAt(fog, b.x, b.y)) continue;
    ctx.fillStyle = state.players[b.owner].color;
    ctx.fillRect(b.x * sx - 2, b.y * sy - 2, 4, 4);
  }
  for (const u of state.units.values()) {
    if (u.owner !== "player" && !isVisibleAt(fog, u.x, u.y)) continue;
    ctx.fillStyle = state.players[u.owner].color;
    ctx.fillRect(u.x * sx - 1, u.y * sy - 1, 2, 2);
  }

  // Camera viewport rectangle, so the minimap also shows where on the
  // map the main view is currently looking.
  const halfW = viewportW / (2 * camera.zoom), halfH = viewportH / (2 * camera.zoom);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";
  ctx.lineWidth = 1;
  ctx.strokeRect((camera.x - halfW) * sx, (camera.y - halfH) * sy, halfW * 2 * sx, halfH * 2 * sy);

  ctx.restore();
}

export function minimapToWorld(map, mmW, mmH, mx, my) {
  return { x: (mx / mmW) * map.width, y: (my / mmH) * map.height };
}
