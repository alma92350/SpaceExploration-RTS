/* ============================================================
   Canvas rendering. Pure read of state — never mutates it. Assumes the
   caller already set up a device-pixel-ratio transform so drawing here
   happens in plain world coordinates (0..map.width, 0..map.height).
   ============================================================ */

"use strict";

import { COM } from "./data.js";

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
    const color = state.players[u.owner].color;
    ctx.beginPath();
    ctx.arc(u.x, u.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (u.cargo && u.cargo.qty > 0) {
      ctx.beginPath();
      ctx.arc(u.x, u.y - 11, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
    }
    drawHealthBar(ctx, u.x, u.y - 15, 16, u.hp, u.maxHp);
  }
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
    const e = state.units.get(id) || state.buildings.get(id);
    if (!e) continue;
    const r = (e.radius || 9) + 4;
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
