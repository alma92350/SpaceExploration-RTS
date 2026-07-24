/* ============================================================
   Resource-deposit rendering — the charted ore/crystal/gas silhouettes on the
   map. Deposits are charted map knowledge (data.js), not battlefield intel, so
   they draw at full visibility regardless of fog (a hidden cache only appears
   once scouted). Each rock's irregular outline is stable frame-to-frame (seeded
   off its id). Split out of render.js; drawFrame calls drawNodes.
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { isNodeDiscovered } from "./engine/fog.js";
import { hashStr, seededRng, pathPoints, inView } from "./renderShared.js";

export function drawNodes(ctx, state, view) {
  for (const n of state.map.nodes) {
    if (n.amount <= 0) continue;
    if (view && !inView(view, n.x, n.y, 20)) continue;   // off-screen deposit
    if (!isNodeDiscovered(state.fog, n)) continue;   // a hidden cache stays dark until scouted
    const r = 7 + 9 * (n.amount / n.max);
    const extract = COM[n.com]?.extract;
    if (extract === "forage") drawOrganicNode(ctx, n, r);
    else if (extract === "capture") drawGasNode(ctx, n, r);
    else drawRockyNode(ctx, n, r); // mine / exploit — ore, crystals, radioactives, ice, relics

    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#05070f";
    ctx.fillText(COM[n.com]?.ico || "?", n.x, n.y + 3);
  }
}

// Cached per-node unit silhouette (offsets at radius 1), so the seeded-PRNG
// polygon jitter is computed once per node instead of every single frame — the
// shape is static, only its radius changes as the deposit depletes.
const nodeShapeCache = new Map();
function rockyShape(id) {
  let shape = nodeShapeCache.get(id);
  if (!shape) {
    const rng = seededRng(hashStr(id));
    const rot = rng() * Math.PI * 2;   // same rng draw order as the original, so silhouettes are unchanged
    shape = [];
    for (let i = 0; i < 8; i++) {
      const a = rot + (i / 8) * Math.PI * 2;
      const jitter = 0.72 + rng() * 0.5;
      shape.push([Math.cos(a) * jitter, Math.sin(a) * jitter]);
    }
    nodeShapeCache.set(id, shape);
  }
  return shape;
}

// Mined/exploited deposits (ore, crystals, radioactives, ice, relics) read
// as a faceted asteroid chunk — an irregular polygon beats a perfect circle
// at selling "rock" at a glance, and the per-node seed keeps it stable.
function drawRockyNode(ctx, n, r) {
  const pts = rockyShape(n.id).map(([ux, uy]) => [n.x + ux * r, n.y + uy * r]);
  pathPoints(ctx, pts);
  ctx.fillStyle = "#ffd166";
  ctx.globalAlpha = 0.85;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#b9822f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Foraged deposits (biomass, spice) read as a soft cluster of overlapping
// blobs — organic growth rather than mineral facets.
function drawOrganicNode(ctx, n, r) {
  const rng = seededRng(hashStr(n.id) ^ 0x9e3779b9);
  ctx.fillStyle = "#ffd166";
  ctx.globalAlpha = 0.85;
  const lobes = 3;
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + rng() * 0.6;
    const dist = r * 0.32 * rng();
    const lr = r * (0.55 + rng() * 0.15);
    ctx.beginPath();
    ctx.arc(n.x + Math.cos(a) * dist, n.y + Math.sin(a) * dist, lr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// Captured deposits (Helium-3 gas) read as a soft drifting cloud — nested
// translucent rings instead of a hard edge.
function drawGasNode(ctx, n, r) {
  const rings = [
    { rr: r * 1.3, a: 0.18 },
    { rr: r * 0.95, a: 0.35 },
    { rr: r * 0.55, a: 0.7 },
  ];
  for (const { rr, a } of rings) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd166";
    ctx.globalAlpha = a;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
