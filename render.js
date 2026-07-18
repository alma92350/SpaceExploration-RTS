/* ============================================================
   Canvas rendering. Pure read of state — never mutates it. Assumes the
   caller already set up a device-pixel-ratio transform; drawFrame lays
   the camera transform on top of that, so every draw* helper below just
   works in plain world coordinates (0..map.width, 0..map.height) and
   never has to know about the viewport or camera itself.
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isVisibleAt, FOG_CELL_SIZE } from "./engine/fog.js";

// Facing angle per unit id, inferred frame-to-frame from movement — pure
// render-side bookkeeping, never read by the sim.
const facing = new Map();

export function drawFrame(ctx, state, camera, viewportW, viewportH, dragBox) {
  ctx.save();
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, viewportW, viewportH);

  ctx.translate(viewportW / 2, viewportH / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  drawFogBase(ctx, state);
  // Resource deposits are charted map knowledge (see data.js), not
  // battlefield intel — they render at full visibility regardless of
  // fog, on top of the dimmed backdrop.
  drawNodes(ctx, state);
  drawBuildings(ctx, state);
  drawUnits(ctx, state);
  drawSelectionRings(ctx, state);
  drawRallyPoint(ctx, state);
  if (dragBox) drawDragBox(ctx, dragBox);

  ctx.restore();
}

// Unexplored cells go solid black; explored-but-not-currently-visible
// cells get a dimming overlay so the player can see where they've
// scouted before without it looking fully lit. Currently-visible cells
// get nothing — the world underneath already reads at full brightness.
function drawFogBase(ctx, state) {
  const fog = state.fog;
  if (!fog) return;
  for (let gy = 0; gy < fog.rows; gy++) {
    for (let gx = 0; gx < fog.cols; gx++) {
      const idx = gy * fog.cols + gx;
      if (fog.visible[idx]) continue;
      ctx.fillStyle = fog.explored[idx] ? "rgba(5, 7, 15, 0.55)" : "#05070f";
      ctx.fillRect(gx * FOG_CELL_SIZE, gy * FOG_CELL_SIZE, FOG_CELL_SIZE, FOG_CELL_SIZE);
    }
  }
}

function drawNodes(ctx, state) {
  for (const n of state.map.nodes) {
    if (n.amount <= 0) continue;
    const r = 7 + 9 * (n.amount / n.max);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#05070f";
    ctx.fillText(COM[n.com]?.ico || "?", n.x, n.y + 3);
  }
}

function drawBuildings(ctx, state) {
  for (const b of state.buildings.values()) {
    if (b.owner !== "player" && !isVisibleAt(state.fog, b.x, b.y)) continue;
    const color = state.players[b.owner].color;
    ctx.globalAlpha = b.constructing ? 0.5 : 1;
    ctx.fillStyle = color;
    ctx.fillRect(b.x - b.radius, b.y - b.radius, b.radius * 2, b.radius * 2);
    ctx.strokeStyle = "#05070f";
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x - b.radius, b.y - b.radius, b.radius * 2, b.radius * 2);
    ctx.globalAlpha = 1;
    drawHealthBar(ctx, b.x, b.y - b.radius - 8, b.radius * 2, b.hp, b.maxHp);
  }
}

function drawUnits(ctx, state) {
  for (const u of state.units.values()) {
    if (u.owner !== "player" && !isVisibleAt(state.fog, u.x, u.y)) continue;
    const def = UNITS[u.type];
    const color = state.players[u.owner].color;
    ctx.fillStyle = color;
    // A dark outline disappears against the (equally dark) background —
    // it only ever separated overlapping same-color units, never defined
    // the silhouette. A light one keeps the shape crisp at small sizes,
    // where anti-aliasing otherwise blurs a triangle's corners into
    // looking like just another circle.
    ctx.strokeStyle = "#dce6ff";
    ctx.lineWidth = 1.5;

    if (u.type === "bastion") {
      drawDiamond(ctx, u.x, u.y, def.radius * 1.7);
    } else if (u.type === "lancer") {
      drawStar(ctx, u.x, u.y, def.radius * 1.9);
    } else if (def.role === "combat") {
      drawTriangle(ctx, u, def.radius * 2);
    } else {
      ctx.beginPath();
      ctx.arc(u.x, u.y, def.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (u.cargo && u.cargo.qty > 0) {
      ctx.beginPath();
      ctx.arc(u.x, u.y - def.radius - 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
    }
    drawHealthBar(ctx, u.x, u.y - def.radius - 9, 16, u.hp, u.maxHp);
  }
}

// Combat units render as a triangle pointing the way they're moving, so
// skiffs read as distinct from (round) Workers at a glance and hint at
// facing during a fight. Facing is inferred from the position delta since
// the last frame, since orders don't always carry a destination point
// (e.g. an 'attack' order tracks a target id, not x/y).
function drawTriangle(ctx, unit, r) {
  const prev = facing.get(unit.id);
  let angle = prev ? prev.angle : -Math.PI / 2;
  if (prev) {
    const dx = unit.x - prev.x, dy = unit.y - prev.y;
    if (Math.hypot(dx, dy) > 0.5) angle = Math.atan2(dy, dx);
  }
  facing.set(unit.id, { x: unit.x, y: unit.y, angle });

  const cx = unit.x, cy = unit.y;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
  ctx.lineTo(cx + Math.cos(angle + 2.4) * r, cy + Math.sin(angle + 2.4) * r);
  ctx.lineTo(cx + Math.cos(angle - 2.4) * r, cy + Math.sin(angle - 2.4) * r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// Bastion draws as a diamond — a third silhouette next to Worker's circle
// and Skiff's triangle, so a mixed army reads at a glance instead of
// needing color/size alone to tell a tanky melee unit from a skirmisher.
function drawDiamond(ctx, cx, cy, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

// Lancer draws as a 4-pointed star — a precision-strike reticle, the
// fourth distinct silhouette (circle/triangle/diamond/star) so all three
// combat types plus Worker read apart from each other at a glance.
function drawStar(ctx, cx, cy, r) {
  const inner = r * 0.42;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI / 4) * i - Math.PI / 2;
    const radius = i % 2 === 0 ? r : inner;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawHealthBar(ctx, cx, y, w, hp, maxHp) {
  if (hp >= maxHp) return;
  const pct = Math.max(0, hp / maxHp);
  ctx.fillStyle = "#243162";
  ctx.fillRect(cx - w / 2, y, w, 3);
  ctx.fillStyle = pct > 0.4 ? "#4ade80" : "#f87171";
  ctx.fillRect(cx - w / 2, y, w * pct, 3);
}

function drawSelectionRings(ctx, state) {
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 2;
  for (const id of state.selection) {
    const unit = state.units.get(id);
    const e = unit || state.buildings.get(id);
    if (!e) continue;
    const baseRadius = unit ? UNITS[unit.type].radius : e.radius;
    const r = baseRadius + 4;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Shown only for the single selected production building, matching the
// usual RTS convention of not cluttering the view with every building's
// rally line at once.
function drawRallyPoint(ctx, state) {
  if (state.selection.length !== 1) return;
  const building = state.buildings.get(state.selection[0]);
  if (!building || building.owner !== "player" || !BUILDINGS[building.type].produces) return;

  const { x: rx, y: ry } = building.rally;
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(79, 209, 255, 0.6)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(building.x, building.y);
  ctx.lineTo(rx, ry);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(rx, ry, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#4fd1ff";
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawDragBox(ctx, box) {
  const x = Math.min(box.x1, box.x2), y = Math.min(box.y1, box.y2);
  const w = Math.abs(box.x2 - box.x1), h = Math.abs(box.y2 - box.y1);
  ctx.fillStyle = "rgba(79, 209, 255, 0.15)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}
