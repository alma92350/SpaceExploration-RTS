/* ============================================================
   Canvas rendering. Pure read of state — never mutates it. Assumes the
   caller already set up a device-pixel-ratio transform so drawing here
   happens in plain world coordinates (0..map.width, 0..map.height).
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { UNITS } from "./engine/entities.js";

// Facing angle per unit id, inferred frame-to-frame from movement — pure
// render-side bookkeeping, never read by the sim.
const facing = new Map();

export function drawFrame(ctx, state, dragBox) {
  const { width, height } = state.map;
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, width, height);

  drawNodes(ctx, state);
  drawBuildings(ctx, state);
  drawUnits(ctx, state);
  drawSelectionRings(ctx, state);
  if (dragBox) drawDragBox(ctx, dragBox);
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
    const def = UNITS[u.type];
    const color = state.players[u.owner].color;
    ctx.fillStyle = color;
    ctx.strokeStyle = "#05070f";
    ctx.lineWidth = 1.5;

    if (def.role === "combat") {
      drawTriangle(ctx, u, def.radius * 1.5);
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

function drawDragBox(ctx, box) {
  const x = Math.min(box.x1, box.x2), y = Math.min(box.y1, box.y2);
  const w = Math.abs(box.x2 - box.x1), h = Math.abs(box.y2 - box.y1);
  ctx.fillStyle = "rgba(79, 209, 255, 0.15)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}
