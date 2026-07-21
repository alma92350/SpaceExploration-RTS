/* ============================================================
   Canvas rendering. Pure read of state — never mutates it. Assumes the
   caller already set up a device-pixel-ratio transform; drawFrame lays
   the camera transform on top of that, so every draw* helper below just
   works in plain world coordinates (0..map.width, 0..map.height) and
   never has to know about the viewport or camera itself.

   No image assets — the project is deliberately zero-dependency/no-build,
   so every entity is a small vector silhouette built from canvas paths
   rather than sprite files, keeping that same "no assets to manage" story
   for art as for code.
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isVisibleAt, isNodeDiscovered, FOG_CELL_SIZE } from "./engine/fog.js";
import { JUMP_LOAD_RADIUS } from "./engine/galaxy.js";
import { canPlaceBuilding } from "./engine/colliders.js";
import { activeEffects, activeFireworks } from "./effects.js";

// A light, near-white accent used for hull details (sensor eyes, canopy
// glass, engine glow, antenna lights) across both players' colors — the
// same "light outline reads at small sizes" reasoning the old triangle
// used, just reused for interior greebles too instead of only the outline.
const DETAIL = "#dce6ff";

// Facing angle per unit id, inferred frame-to-frame from movement — pure
// render-side bookkeeping, never read by the sim. Shared by every oriented
// unit type (currently Skiff, Bastion and Lancer) so hull/turret art can
// point the way the unit is actually moving.
const facing = new Map();

// Cached once: whether the viewer asked the OS to reduce motion. Used to swap
// the repeating alert pulses for a static cue (see drawEffects).
let _reducedMotion = null;
function prefersReducedMotion() {
  if (_reducedMotion === null) {
    _reducedMotion = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
  }
  return _reducedMotion;
}

// Drop facing entries for entities that no longer exist, so a long match with
// heavy unit churn (or repeated restarts) doesn't grow the Map without bound.
// Cheap: one Map.has per live-or-dead key, and after pruning the Map holds at
// most one entry per currently-live oriented entity.
function pruneFacing(state) {
  for (const id of facing.keys()) {
    if (!state.units.has(id) && !state.buildings.has(id)) facing.delete(id);
  }
}

// Cleared on a fresh game so orientations from a previous match don't linger.
export function resetFacing() {
  facing.clear();
}

// A small sprite ICON for a unit or building type — the SAME art the map draws, rendered once
// to an offscreen canvas and cached as a data URL for the HUD's build/produce buttons. Source
// radii vary a lot, so every icon is normalized to a common size, tinted with the owner colour,
// and drawn at 2× for crispness. `kind` is "unit" | "building". Never throws — if canvas is
// unavailable it returns "" and the button just stays text-only.
const ICON_BOX = 40;      // css px of the square icon
const ICON_R = 14;        // normalized sprite radius inside the box
const iconCache = new Map();
export function spriteIcon(kind, type, color = "#8fd3ff") {
  const key = `${kind}:${type}:${color}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let url = "";
  try {
    const scale = 2;
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
  iconCache.set(key, url);
  return url;
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
function inView(view, x, y, r = 0) {
  return x + r >= view.minX && x - r <= view.maxX && y + r >= view.minY && y - r <= view.maxY;
}

export function drawFrame(ctx, state, camera, viewportW, viewportH, dragBox, buildGhost) {
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
  drawBuildings(ctx, state, view);
  drawUnits(ctx, state, view);
  drawJumpStaging(ctx, state, view);   // staging ring around a selected Spaceport (Odyssey)
  drawEffects(ctx);
  if (buildGhost) drawBuildGhost(ctx, state, buildGhost);
  drawWaypoints(ctx, state);
  drawEscortLinks(ctx, state);
  drawSelectionRings(ctx, state);
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

// Unexplored cells go solid black; explored-but-not-currently-visible
// cells get a dimming overlay so the player can see where they've
// scouted before without it looking fully lit. Currently-visible cells
// get nothing — the world underneath already reads at full brightness.
function drawFogBase(ctx, state, view) {
  const fog = state.fog;
  if (!fog) return;
  // Only the cells overlapping the viewport — clamped to the grid — instead of
  // all rows*cols every frame (16k+ on a 4x map).
  const gx0 = view ? Math.max(0, Math.floor(view.minX / FOG_CELL_SIZE)) : 0;
  const gx1 = view ? Math.min(fog.cols - 1, Math.floor(view.maxX / FOG_CELL_SIZE)) : fog.cols - 1;
  const gy0 = view ? Math.max(0, Math.floor(view.minY / FOG_CELL_SIZE)) : 0;
  const gy1 = view ? Math.min(fog.rows - 1, Math.floor(view.maxY / FOG_CELL_SIZE)) : fog.rows - 1;
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const idx = gy * fog.cols + gx;
      if (fog.visible[idx]) continue;
      ctx.fillStyle = fog.explored[idx] ? "rgba(5, 7, 15, 0.55)" : "#05070f";
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

/* ---------- small geometry helpers ---------- */

// Deterministic string hash → seeded PRNG, so each resource node's
// "irregular rock" silhouette is stable frame to frame (derived from its
// id) instead of jittering every draw call like a fresh Math.random() would.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lightens (positive percent) or darkens (negative) a "#rrggbb" color, used
// to derive hull-shadow/highlight tones from a player's own color so
// buildings/units read as one paint job rather than a flat single fill.
function shade(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = clamp((num >> 16) + amt);
  const g = clamp(((num >> 8) & 0xff) + amt);
  const b = clamp((num & 0xff) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function polygonPoints(cx, cy, r, sides, rotation = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function pathPoints(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

// Rotates a local point (nose along +x) by `angle` and places it at (cx,cy)
// — lets oriented-unit shapes be authored once in "facing right" space.
function toWorld(cx, cy, angle, lx, ly) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
}
function pathOriented(ctx, cx, cy, angle, localPts) {
  pathPoints(ctx, localPts.map(([lx, ly]) => toWorld(cx, cy, angle, lx, ly)));
}

function drawNodes(ctx, state, view) {
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

/* ---------- buildings ---------- */

// The shape dispatch, factored out of drawBuildings so the HUD's button icons
// (spriteIcon) render the exact same silhouette the map does. Only the turret reads
// `state` (it aims at its live target); an icon passes a stub state with empty Maps.
function drawBuildingShape(ctx, state, b, color) {
  if (b.type === "command") drawCommandCenter(ctx, b, color);
  else if (b.type === "barracks") drawBarracks(ctx, b, color);
  else if (b.type === "refinery") drawRefinery(ctx, b, color);
  else if (b.type === "foundry") drawFoundry(ctx, b, color);
  else if (b.type === "arsenal") drawArsenal(ctx, b, color);
  else if (b.type === "turret") drawTurret(ctx, state, b, color);
  else if (b.type === "habitat") drawHabitat(ctx, b, color);
  else if (b.type === "spaceport") drawSpaceport(ctx, b, color);
  else drawGenericBuilding(ctx, b, color);   // any future building still gets a silhouette, never an invisible blank
}

function drawBuildings(ctx, state, view) {
  const selSet = new Set(state.selection);
  for (const b of state.buildings.values()) {
    if (view && !inView(view, b.x, b.y, b.radius + 12)) continue;   // off-screen (pad for the hp bar above it)
    if (b.owner !== "player" && !isVisibleAt(state.fog, b.x, b.y)) continue;
    const color = state.players[b.owner].color;
    ctx.globalAlpha = b.constructing ? 0.5 : 1;

    drawBuildingShape(ctx, state, b, color);

    ctx.globalAlpha = 1;
    // A foe marker under every enemy building, matching the one under enemy units:
    // friend/foe is then a SHAPE cue, not colour alone, so a colourblind player can
    // tell an enemy base from their own without relying on the cyan-vs-red hue.
    if (b.owner !== "player") drawEnemyPip(ctx, b.x, b.y + b.radius + 8);
    drawHealthBar(ctx, b.x, b.y - b.radius - 8, b.radius * 2, b.hp, b.maxHp, selSet.has(b.id));
  }
}

// The jump staging area around a SELECTED player Spaceport: a dashed ring at
// JUMP_LOAD_RADIUS with a faint fill (the disc whose units ride along on a jump —
// engine/galaxy.js stagedRiders), and a highlight on each unit currently inside it.
// Answers "where do I park units so they come with me?" — drawn only when the
// Spaceport is selected, so it never clutters the map otherwise.
function drawJumpStaging(ctx, state, view) {
  const selSet = new Set(state.selection);
  for (const b of state.buildings.values()) {
    if (b.type !== "spaceport" || b.owner !== "player" || b.constructing || !selSet.has(b.id)) continue;
    if (view && !inView(view, b.x, b.y, JUMP_LOAD_RADIUS + 8)) continue;

    ctx.save();
    ctx.beginPath();
    ctx.arc(b.x, b.y, JUMP_LOAD_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(120, 200, 255, 0.06)";   // faint disc so the AREA reads
    ctx.fill();
    ctx.setLineDash([9, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(120, 200, 255, 0.7)";
    ctx.stroke();
    ctx.restore();

    // Ring the units that would ride along, so it's clear WHICH entities jump.
    for (const u of state.units.values()) {
      if (u.owner !== "player") continue;
      if (Math.hypot(u.x - b.x, u.y - b.y) > JUMP_LOAD_RADIUS) continue;
      ctx.beginPath();
      ctx.arc(u.x, u.y, (u.radius || 6) + 3, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(120, 200, 255, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

// Command Center — the base's biggest, most "important-looking" structure:
// an octagonal hull, a raised central dome, four corner struts and a
// blinking antenna, so it reads as the hub building even before checking HP.
function drawCommandCenter(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;

  pathPoints(ctx, polygonPoints(cx, cy, r, 8, Math.PI / 8));
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 2;
  ctx.stroke();

  for (const [x, y] of polygonPoints(cx, cy, r * 0.92, 4, Math.PI / 4)) {
    ctx.fillStyle = shade(color, -25);
    ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 20);
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 0.85);
  ctx.lineTo(cx, cy - r * 1.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy - r * 1.2, 2, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();

  // The anchored Capital (engine/galaxy.js upgradeToCapital) wears a gold ring, so a
  // fortified, non-jumping Capital reads apart from a normal Command Center at a glance.
  if (b.capital) {
    pathPoints(ctx, polygonPoints(cx, cy, r * 1.3, 8, Math.PI / 8));
    ctx.strokeStyle = "#f2c14e";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
}

// Barracks — an angular bunker (a "home plate" silhouette with a pointed
// front) with hangar-door stripes and a radar dish, distinct from the
// Command Center's rounded dome and the Refinery's cylindrical tanks.
function drawBarracks(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.9, h = r * 1.6;
  pathPoints(ctx, [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h * 0.05],
    [cx, cy + h / 2],
    [cx - w / 2, cy + h * 0.05],
  ]);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  ctx.fillRect(cx - w * 0.28, cy - h * 0.4, w * 0.16, h * 0.55);
  ctx.fillRect(cx + w * 0.12, cy - h * 0.4, w * 0.16, h * 0.55);

  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx + w * 0.4, cy - h / 2);
  ctx.lineTo(cx + w * 0.48, cy - h * 0.75);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + w * 0.48, cy - h * 0.75, 2, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Refinery — a low industrial base with two cylindrical storage tanks
// (each given a highlight stripe to read as round, not just circular
// blobs) joined by a connecting pipe.
function drawRefinery(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.7, h = r * 0.9;

  ctx.fillStyle = shade(color, -15);
  ctx.fillRect(cx - w / 2, cy + h * 0.05, w, h * 0.55);
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy + h * 0.05, w, h * 0.55);

  ctx.strokeStyle = shade(color, -10);
  ctx.lineWidth = r * 0.35;
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.28, cy);
  ctx.lineTo(cx + w * 0.28, cy);
  ctx.stroke();

  const tankR = r * 0.5;
  for (const tx of [cx - w * 0.28, cx + w * 0.28]) {
    ctx.beginPath();
    ctx.arc(tx, cy - h * 0.1, tankR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#05070f";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx - tankR * 0.3, cy - h * 0.1 - tankR * 0.6);
    ctx.lineTo(tx - tankR * 0.3, cy - h * 0.1 + tankR * 0.6);
    ctx.stroke();
  }
}

// Habitat — a small residential dome: a squat foundation slab, a half-dome
// roof and a row of lit windows, so a supply building reads as "people live
// here" rather than as another weapons platform.
function drawHabitat(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.8, h = r * 0.9;
  ctx.fillStyle = shade(color, -20);
  ctx.fillRect(cx - w / 2, cy, w, h * 0.7);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy, w, h * 0.7);

  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.42, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill(); ctx.stroke();

  ctx.fillStyle = DETAIL;
  for (const dx of [-w * 0.25, 0, w * 0.25]) ctx.fillRect(cx + dx - 1.5, cy + h * 0.2, 3, 3);
}

// Foundry — the Tier-2 war-smeltery that unlocks the Lancer and Breacher: an
// industrial hall under a sawtooth factory roofline, a tall smokestack tipped
// with a hot ember and a molten forge vent glowing orange through its face, so
// the building that opens the advanced units reads as a working forge — not
// just another bunker.
function drawFoundry(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 2.0, h = r * 1.4;

  ctx.fillStyle = color;                                       // main hall
  ctx.fillRect(cx - w / 2, cy - h * 0.2, w, h * 0.7);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, cy - h * 0.2, w, h * 0.7);

  const teeth = 3, tw = w / teeth;                             // sawtooth roof
  for (let i = 0; i < teeth; i++) {
    const x0 = cx - w / 2 + i * tw;
    pathPoints(ctx, [[x0, cy - h * 0.2], [x0, cy - h * 0.52], [x0 + tw, cy - h * 0.2]]);
    ctx.fillStyle = shade(color, -20); ctx.fill();
    ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
  }

  ctx.fillStyle = "#ff8c42";                                   // molten forge vent
  ctx.fillRect(cx - w * 0.18, cy + h * 0.08, w * 0.36, h * 0.24);

  ctx.fillStyle = shade(color, -30);                           // smokestack
  ctx.fillRect(cx + w * 0.3, cy - h * 0.78, w * 0.15, h * 0.6);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5;
  ctx.strokeRect(cx + w * 0.3, cy - h * 0.78, w * 0.15, h * 0.6);
  ctx.beginPath();                                             // ember at the stack tip
  ctx.arc(cx + w * 0.375, cy - h * 0.8, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd166"; ctx.fill();
}

// Arsenal — the Tier-3 weapons manufactory that unlocks the Dreadnought capital
// ship: a squat armoured bunker with chamfered corners, a reinforced cap, a rack
// of stubby missile tubes on the roof and a lit reactor core, so the top of the
// tech tree reads as the most fortified, most militarised structure on the field.
function drawArsenal(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y, w = r * 1.9, h = r * 1.5, ch = r * 0.5;

  pathPoints(ctx, [                                            // chamfered armoured hull
    [cx - w / 2 + ch, cy - h * 0.35], [cx + w / 2 - ch, cy - h * 0.35],
    [cx + w / 2, cy - h * 0.35 + ch], [cx + w / 2, cy + h * 0.4 - ch],
    [cx + w / 2 - ch, cy + h * 0.4], [cx - w / 2 + ch, cy + h * 0.4],
    [cx - w / 2, cy + h * 0.4 - ch], [cx - w / 2, cy - h * 0.35 + ch],
  ]);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();

  ctx.fillStyle = shade(color, -22);                           // reinforced cap
  ctx.fillRect(cx - w * 0.3, cy - h * 0.5, w * 0.6, h * 0.18);
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1;
  ctx.strokeRect(cx - w * 0.3, cy - h * 0.5, w * 0.6, h * 0.18);

  ctx.fillStyle = shade(color, -35);                           // roof missile tubes
  for (const dx of [-w * 0.2, 0, w * 0.2]) ctx.fillRect(cx + dx - 2, cy - h * 0.62, 4, h * 0.16);

  ctx.beginPath();                                             // lit reactor core
  ctx.arc(cx, cy + h * 0.02, r * 0.34, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 25); ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy + h * 0.02, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL; ctx.fill();
}

// A last-resort silhouette for any building type without a bespoke draw — a
// hexagonal hull with a lit core. Nothing on the current roster falls through
// to it (every type above is handled), but it guarantees the "every entity has
// a graphical representation" invariant holds for anything added later, so a new
// building can never ship as an invisible click target.
function drawGenericBuilding(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 6, Math.PI / 6));
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 20); ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
}

// Spaceport — a round launch pad ringed by a gantry with an upright rocket
// standing on it, so the "leave this world" building reads at a glance.
function drawSpaceport(ctx, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.66, 0, Math.PI * 2);
  ctx.strokeStyle = shade(color, -30); ctx.lineWidth = 3; ctx.stroke();

  const bw = r * 0.26, bh = r * 0.92;                     // upright rocket body
  ctx.fillStyle = DETAIL;
  ctx.beginPath();
  ctx.moveTo(cx, cy - bh);
  ctx.lineTo(cx + bw, cy - bh * 0.4);
  ctx.lineTo(cx + bw, cy + bh * 0.5);
  ctx.lineTo(cx - bw, cy + bh * 0.5);
  ctx.lineTo(cx - bw, cy - bh * 0.4);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(color, -20);                     // fins
  ctx.beginPath();
  ctx.moveTo(cx - bw, cy + bh * 0.12); ctx.lineTo(cx - bw * 2.1, cy + bh * 0.5); ctx.lineTo(cx - bw, cy + bh * 0.5); ctx.closePath();
  ctx.moveTo(cx + bw, cy + bh * 0.12); ctx.lineTo(cx + bw * 2.1, cy + bh * 0.5); ctx.lineTo(cx + bw, cy + bh * 0.5); ctx.closePath();
  ctx.fill();

  // Tier pips (1–3): the launch pad's jump-capacity rank (engine/galaxy.js), so a bigger
  // Spaceport reads at a glance on the map.
  const tier = Math.min(3, Math.max(1, b.tier || 1));
  const pipR = r * 0.11, gap = pipR * 2.6, py = cy + r * 0.66;
  for (let i = 0; i < tier; i++) {
    const px = cx + (i - (tier - 1) / 2) * gap;
    ctx.beginPath(); ctx.arc(px, py, pipR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffd76a"; ctx.fill();
    ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1; ctx.stroke();
  }
}

// Sentinel Turret — a hexagonal base pad with a single barrel that swings to
// track its current target, so a defended base reads as actively guarded
// rather than as just another building. The barrel angle comes from the
// sim's auto-acquired targetId, not from any movement (a turret never moves).
function drawTurret(ctx, state, b, color) {
  const r = b.radius, cx = b.x, cy = b.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 6, Math.PI / 6));           // base pad
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 2; ctx.stroke();

  const angle = turretFacing(state, b);
  ctx.strokeStyle = shade(color, -25); ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * r * 1.5, cy + Math.sin(angle) * r * 1.5); ctx.stroke();

  ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);          // mount
  ctx.fillStyle = shade(color, 20); ctx.fill();
  ctx.strokeStyle = "#05070f"; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.beginPath();                                                    // muzzle tip light
  ctx.arc(cx + Math.cos(angle) * r * 1.5, cy + Math.sin(angle) * r * 1.5, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL; ctx.fill();
}

// Reuses the module-level facing Map — building "b*" ids can't collide with
// unit "u*" ids. Holds its last aim when idle (targetId null) instead of
// snapping back to a default, so a turret between shots keeps pointing where
// it last fired.
function turretFacing(state, b) {
  const prev = facing.get(b.id);
  let angle = prev ? prev.angle : -Math.PI / 2;
  const t = b.targetId ? (state.units.get(b.targetId) || state.buildings.get(b.targetId)) : null;
  if (t) angle = Math.atan2(t.y - b.y, t.x - b.x);
  facing.set(b.id, { x: b.x, y: b.y, angle });
  return angle;
}

/* ---------- units ---------- */

// The unit shape dispatch, factored out of drawUnits so the HUD's button icons render
// the exact same sprite. The caller sets ctx.fillStyle (owner colour) + strokeStyle
// (DETAIL) first, as drawUnits does. Oriented hulls default to facing "up" for a static
// icon (updateFacing has no movement to read).
function drawUnitShape(ctx, u, def, color) {
  if (u.type === "worker") drawWorker(ctx, u, def, color);
  else if (u.type === "ranger") drawRanger(ctx, u, def, color);
  else if (u.type === "skiff") drawSkiff(ctx, u, def, color);
  else if (u.type === "bastion") drawBastion(ctx, u, def, color);
  else if (u.type === "lancer") drawLancer(ctx, u, def, color);
  else if (u.type === "breacher") drawBreacher(ctx, u, def, color);
  else if (u.type === "dreadnought") drawDreadnought(ctx, u, def, color);
  else if (u.type === "mender") drawMender(ctx, u, def, color);
  else if (u.type === "wraith") drawWraith(ctx, u, def, color);
  else if (u.type === "aegis") drawAegis(ctx, u, def, color);
  else if (u.type === "colossus") drawColossus(ctx, u, def, color);
  else if (u.type === "freighter" || u.type === "hauler" || u.type === "heavyhauler" || u.type === "bulkfreighter") drawFreighter(ctx, u, def, color);
  else if (u.type === "colonyship") drawColonyShip(ctx, u, def, color);
  else drawGenericUnit(ctx, u, def, color);   // any future unit still gets a silhouette, never an invisible blank
}

function drawUnits(ctx, state, view) {
  const selSet = new Set(state.selection);
  for (const u of state.units.values()) {
    if (view && !inView(view, u.x, u.y, 16)) continue;   // off-screen unit
    if (u.owner !== "player" && !isVisibleAt(state.fog, u.x, u.y)) continue;
    const def = UNITS[u.type];
    const color = state.players[u.owner].color;
    ctx.fillStyle = color;
    // A dark outline disappears against the (equally dark) background —
    // it only ever separated overlapping same-color units, never defined
    // the silhouette. A light one keeps the shape crisp at small sizes,
    // where anti-aliasing otherwise blurs a hull's corners into looking
    // like just another blob.
    ctx.strokeStyle = DETAIL;
    ctx.lineWidth = 1.5;

    drawUnitShape(ctx, u, def, color);

    if (u.cargo && u.cargo.qty > 0) {
      ctx.beginPath();
      ctx.arc(u.x, u.y - def.radius - 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
    }
    // A small downward pip marks hostile units — a SHAPE cue, so telling friend
    // from foe in a melee doesn't rely on the cyan-vs-red colour alone (which a
    // colourblind player can't count on). Friendlies carry no marker.
    if (u.owner !== "player") drawEnemyPip(ctx, u.x, u.y + def.radius + 6);
    drawHealthBar(ctx, u.x, u.y - def.radius - 9, 16, u.hp, u.maxHp, selSet.has(u.id));
  }
}

function drawEnemyPip(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 4, y - 4);
  ctx.lineTo(x + 4, y - 4);
  ctx.lineTo(x, y + 1);
  ctx.closePath();
  ctx.fillStyle = "#f87171";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#05070f";
  ctx.stroke();
}

// Worker — a small hex-bodied utility pod with two stub grabber arms and a
// sensor "eye", reading as a drone rather than a combatant. Unoriented
// (nothing about gathering/building implies a facing), unlike the two
// combat units below.
function drawWorker(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 6, Math.PI / 6));
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  ctx.fillRect(cx - r - 2.5, cy - 1.5, 2.5, 3);
  ctx.fillRect(cx + r, cy - 1.5, 2.5, 3);

  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.1, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Ranger — a light, fast recon craft: a slim forward-swept hull ringed by a
// sensor scanner amidships with a lit eye at the nose, so the scout reads as
// "eyes, not guns" — distinct from the Skiff's winged dart. Oriented, since it's
// almost always on the move charting the map.
function drawRanger(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.7, W = r * 0.85, cx = u.x, cy = u.y;
  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [-L * 0.35, W],
    [-L * 0.7, 0],
    [-L * 0.35, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();                                   // sensor ring — signals its long sight
  ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.1;
  ctx.stroke();

  const [nx, ny] = toWorld(cx, cy, angle, L * 0.5, 0);   // lit scanner eye at the nose
  ctx.beginPath();
  ctx.arc(nx, ny, r * 0.24, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Colony Ship (Odyssey) — a mobile Command Center: the CC's octagonal hull at unit
// scale with a raised central dome so it reads as "a base in transit", and a warm
// engine flare at the stern so its heading is clear. Deploys (engine/colony.js) into
// a real Command Center at its parked spot.
function drawColonyShip(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, cx = u.x, cy = u.y;

  const [fx, fy] = toWorld(cx, cy, angle, -r * 1.35, 0);   // engine flare behind the hull
  ctx.beginPath();
  ctx.arc(fx, fy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = "#ffb454";
  ctx.fill();

  pathPoints(ctx, polygonPoints(cx, cy, r, 8, Math.PI / 8));   // octagon hull (echoes the CC)
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();                                            // raised central dome
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = shade(color, 20);
  ctx.fill();
  ctx.strokeStyle = "#05070f";
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Mender — a support drone, not a combatant. A rounded octagonal body carrying
// a bright green medic cross (a fixed heal-green on both sides, so "this one
// heals" reads independent of the friend/foe colour), flanked by two little
// emitter nubs. Unoriented like the Worker — it hovers and mends, it doesn't
// charge — so nothing about it says "gun", which is exactly the point.
const HEAL_GREEN = "#8ef5b0";
function drawMender(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  pathPoints(ctx, polygonPoints(cx, cy, r, 8, Math.PI / 8));
  ctx.fill();
  ctx.stroke();

  // Twin emitter nubs at the flanks (where the repair beams would emit from).
  ctx.fillStyle = shade(color, -25);
  ctx.fillRect(cx - r - 2, cy - 1.5, 2.5, 3);
  ctx.fillRect(cx + r - 0.5, cy - 1.5, 2.5, 3);

  // The medic cross — the whole identity of the unit.
  const a = r * 0.72, t = r * 0.26;
  ctx.fillStyle = HEAL_GREEN;
  ctx.fillRect(cx - t / 2, cy - a / 2, t, a);
  ctx.fillRect(cx - a / 2, cy - t / 2, a, t);
}

// A last-resort silhouette for any unit type without a bespoke draw — a small
// diamond with a lit core. Nothing on the roster falls through to it today, but
// it keeps the "every entity has a graphical representation" invariant true for
// anything added later, so a new unit can never ship invisible.
function drawGenericUnit(ctx, u, def, color) {
  const r = def.radius, cx = u.x, cy = u.y;
  pathPoints(ctx, [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.3, 0, Math.PI * 2);
  ctx.fillStyle = DETAIL;
  ctx.fill();
}

// Skiff — fast, ranged, cheap: drawn as a slim dart with swept wingtips and
// a lit engine tail, pointing the way it's moving so a mixed army reads at
// a glance and hints at facing mid-fight.
function drawSkiff(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.6, W = r * 1.1;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [-L * 0.3, W],
    [-L * 0.6, W * 0.35],
    [-L * 0.75, 0],
    [-L * 0.6, -W * 0.35],
    [-L * 0.3, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = DETAIL;
  for (const side of [1, -1]) {
    const [ex, ey] = toWorld(cx, cy, angle, -L * 0.7, side * W * 0.35);
    ctx.beginPath();
    ctx.arc(ex, ey, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Bastion — slow, tanky, short-ranged, bonus damage vs Skiffs: drawn as a
// heavier hull with side turret pods and twin nose cannons, so it reads
// as armored muscle rather than the Skiff's slim dart even at a glance.
function drawBastion(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.3, W = r * 1.0;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.45, W],
    [-L * 0.6, W * 0.85],
    [-L * 0.6, -W * 0.85],
    [L * 0.45, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    const [tx, ty] = toWorld(cx, cy, angle, -L * 0.05, side * W * 0.95);
    ctx.beginPath();
    ctx.arc(tx, ty, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.fillStyle = DETAIL;
  for (const side of [1, -1]) {
    const [nx, ny] = toWorld(cx, cy, angle, L * 0.85, side * W * 0.25);
    ctx.beginPath();
    ctx.arc(nx, ny, r * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Lancer — long-ranged, armor-piercing, squishier than Bastion: drawn as a
// slender javelin hull with a lit lance-tip and small tail fins, reading as
// a precision skirmisher distinct from Skiff's stubby dart and Bastion's
// armored bulk.
function drawLancer(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 2.0, W = r * 0.55;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.2, W],
    [-L * 0.7, W * 0.4],
    [-L, 0],
    [-L * 0.7, -W * 0.4],
    [L * 0.2, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = DETAIL;
  ctx.lineWidth = 1;
  const [shaftX1, shaftY1] = toWorld(cx, cy, angle, L * 0.9, 0);
  const [shaftX2, shaftY2] = toWorld(cx, cy, angle, -L * 0.3, 0);
  ctx.beginPath();
  ctx.moveTo(shaftX1, shaftY1);
  ctx.lineTo(shaftX2, shaftY2);
  ctx.stroke();

  ctx.fillStyle = DETAIL;
  const [tipX, tipY] = toWorld(cx, cy, angle, L, 0);
  ctx.beginPath();
  ctx.arc(tipX, tipY, r * 0.14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    const [fx1, fy1] = toWorld(cx, cy, angle, -L * 0.45, side * W * 0.3);
    const [fx2, fy2] = toWorld(cx, cy, angle, -L * 0.65, side * W * 0.55);
    const [fx3, fy3] = toWorld(cx, cy, angle, -L * 0.85, side * W * 0.25);
    ctx.beginPath();
    ctx.moveTo(fx1, fy1);
    ctx.lineTo(fx2, fy2);
    ctx.lineTo(fx3, fy3);
    ctx.closePath();
    ctx.fill();
  }
}

// Breacher — a wide, low siege chassis CARRYING an oversized gun, where the
// Lancer's whole hull instead IS its javelin. The barrel overhangs the hull
// well past the nose and two recoil spades brace the rear, so it reads as
// artillery hauling a cannon rather than a fighter.
function drawBreacher(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.2, W = r * 0.9;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L * 0.5, W],
    [L * 0.5, -W],
    [-L * 0.7, -W * 0.8],
    [-L * 0.7, W * 0.8],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = shade(color, -25);
  ctx.lineWidth = r * 0.3;
  const [bx1, by1] = toWorld(cx, cy, angle, -L * 0.2, 0);
  const [bx2, by2] = toWorld(cx, cy, angle, L * 1.9, 0);
  ctx.beginPath();
  ctx.moveTo(bx1, by1);
  ctx.lineTo(bx2, by2);
  ctx.stroke();

  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    pathOriented(ctx, cx, cy, angle, [
      [-L * 0.6, side * W * 0.45],
      [-L * 0.6, side * W * 0.8],
      [-L, side * W * 0.6],
    ]);
    ctx.fill();
  }

  ctx.fillStyle = DETAIL;
  const [tipX, tipY] = toWorld(cx, cy, angle, L * 1.9, 0);
  ctx.beginPath();
  ctx.arc(tipX, tipY, r * 0.16, 0, Math.PI * 2);
  ctx.fill();
}

// Dreadnought — the Tier-3 capital ship: a big, broad, armoured hull with a
// spinal cannon, four side batteries and a bright command bridge, so it reads
// as a fortress that dwarfs the line units even at a glance.
function drawDreadnought(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.5, W = r * 1.15;
  const cx = u.x, cy = u.y;

  // Broad angular hull.
  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [L * 0.55, W],
    [-L * 0.65, W],
    [-L, W * 0.5],
    [-L, -W * 0.5],
    [-L * 0.65, -W],
    [L * 0.55, -W],
  ]);
  ctx.fill();
  ctx.stroke();

  // Spinal cannon down the centreline.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.35;
  const [sx1, sy1] = toWorld(cx, cy, angle, -L * 0.4, 0);
  const [sx2, sy2] = toWorld(cx, cy, angle, L * 1.35, 0);
  ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2); ctx.stroke();

  // Four side battery pods.
  ctx.fillStyle = shade(color, -25);
  for (const side of [1, -1]) {
    for (const fx of [0.15, -0.5]) {
      const [px, py] = toWorld(cx, cy, angle, L * fx, side * W * 0.8);
      ctx.beginPath(); ctx.arc(px, py, r * 0.26, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Command bridge glow.
  ctx.fillStyle = DETAIL;
  const [bx, by] = toWorld(cx, cy, angle, -L * 0.25, 0);
  ctx.beginPath(); ctx.arc(bx, by, r * 0.32, 0, Math.PI * 2); ctx.fill();
}

// Wraith — the gas-fuelled glass cannon: a long, forward-swept interceptor with
// wingtips raked back and a hot fusion core amidships, so it reads as the
// fastest, most dangerous, most fragile thing on the field — all engine and gun,
// no armour.
const FUSION = "#ffd166";   // Helium-3 core glow (warm) — distinct from the Mender's heal-green
function drawWraith(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.9, W = r * 1.2;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, 0],
    [-L * 0.15, W * 0.5],
    [-L * 0.7, W],            // raked-back wingtip
    [-L * 0.5, W * 0.2],
    [-L * 0.85, 0],
    [-L * 0.5, -W * 0.2],
    [-L * 0.7, -W],
    [-L * 0.15, -W * 0.5],
  ]);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = FUSION;                                   // fusion core amidships
  const [gx, gy] = toWorld(cx, cy, angle, -L * 0.08, 0);
  ctx.beginPath(); ctx.arc(gx, gy, r * 0.3, 0, Math.PI * 2); ctx.fill();

  ctx.fillStyle = DETAIL;                                   // lit nose
  const [nx, ny] = toWorld(cx, cy, angle, L * 0.6, 0);
  ctx.beginPath(); ctx.arc(nx, ny, r * 0.16, 0, Math.PI * 2); ctx.fill();
}

// Aegis — the ice-armoured wall: a broad, blocky hull wider than it is long,
// carrying a thick frontal armour plate and only a token gun, so it reads as a
// shield on legs — the anvil the Wraith is the hammer to.
function drawAegis(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.1, W = r * 1.25;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, W * 0.6],
    [L, -W * 0.6],
    [-L * 0.7, -W],
    [-L, -W * 0.4],
    [-L, W * 0.4],
    [-L * 0.7, W],
  ]);
  ctx.fill();
  ctx.stroke();

  // Thick frontal armour plate, standing just off the nose.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.5;
  const [f1x, f1y] = toWorld(cx, cy, angle, L * 1.05, W * 0.8);
  const [f2x, f2y] = toWorld(cx, cy, angle, L * 1.05, -W * 0.8);
  ctx.beginPath(); ctx.moveTo(f1x, f1y); ctx.lineTo(f2x, f2y); ctx.stroke();

  ctx.fillStyle = DETAIL;
  const [cxx, cyy] = toWorld(cx, cy, angle, -L * 0.2, 0);
  ctx.beginPath(); ctx.arc(cxx, cyy, r * 0.28, 0, Math.PI * 2); ctx.fill();
}

// Colossus — the relic siege engine: a heavy hexagonal chassis behind an
// enormous barrel that overhangs far past the nose (the longest reach on the
// field), with an ancient-tech violet muzzle and core, so it reads as a slow,
// fragile-for-its-size superweapon that must be screened.
const RELIC = "#c4b5fd";   // ancient-tech violet
function drawColossus(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.3, W = r * 1.05;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L * 0.7, W],
    [L, 0],
    [L * 0.7, -W],
    [-L * 0.8, -W],
    [-L, 0],
    [-L * 0.8, W],
  ]);
  ctx.fill();
  ctx.stroke();

  // The oversized barrel — reaches further than any other unit's gun.
  ctx.strokeStyle = shade(color, -30);
  ctx.lineWidth = r * 0.32;
  const [b1x, b1y] = toWorld(cx, cy, angle, -L * 0.3, 0);
  const [b2x, b2y] = toWorld(cx, cy, angle, L * 2.4, 0);
  ctx.beginPath(); ctx.moveTo(b1x, b1y); ctx.lineTo(b2x, b2y); ctx.stroke();

  ctx.fillStyle = RELIC;                                    // muzzle + reactor core in relic-violet
  const [tx, ty] = toWorld(cx, cy, angle, L * 2.4, 0);
  ctx.beginPath(); ctx.arc(tx, ty, r * 0.2, 0, Math.PI * 2); ctx.fill();
  const [cxx, cyy] = toWorld(cx, cy, angle, -L * 0.15, 0);
  ctx.beginPath(); ctx.arc(cxx, cyy, r * 0.3, 0, Math.PI * 2); ctx.fill();
}

// The convoy route overlay (scenario mode): a dashed lane connecting the
// stations, a muted ring at the start, cyan rings at the waypoint stations, and
// a bright green gate at the destination. The station the convoy is currently
// heading for gets a solid halo so the objective reads at a glance.
function drawScenario(ctx, state) {
  const sc = state.scenario;
  if (!sc) return;
  if (sc.type === "bounty") { drawBountyMarkers(ctx, sc); return; }
  if (!sc.route) return;
  const route = sc.route;

  ctx.save();
  ctx.strokeStyle = "rgba(79, 209, 255, 0.30)";
  ctx.lineWidth = 2;
  ctx.setLineDash([12, 10]);
  ctx.beginPath();
  ctx.moveTo(route[0].x, route[0].y);
  for (let i = 1; i < route.length; i++) ctx.lineTo(route[i].x, route[i].y);
  ctx.stroke();
  ctx.setLineDash([]);

  const activeTarget = sc.phase === "travel" ? sc.legIndex + 1 : -1;
  route.forEach((p, i) => {
    const dest = i === route.length - 1;
    const start = i === 0;
    const col = dest ? "#4ade80" : start ? "#8593c4" : "#4fd1ff";
    if (i === activeTarget) {                          // halo the station we're steering for
      ctx.beginPath(); ctx.arc(p.x, p.y, 44, 0, Math.PI * 2);
      ctx.fillStyle = dest ? "rgba(74,222,128,0.12)" : "rgba(79,209,255,0.12)";
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(p.x, p.y, dest ? 38 : 32, 0, Math.PI * 2);
    ctx.strokeStyle = col; ctx.lineWidth = dest ? 4 : 2.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  });
  ctx.restore();
}

// Bounty Marshal has no route — it marks the scattered pirate camps instead. An
// uncleared camp gets a dashed red "wanted" ring and its bounty value (a hunt
// beacon that reads through fog, so the player always knows where to go); a
// cleared camp fades to a faint green ring so progress is visible on the map.
function drawBountyMarkers(ctx, sc) {
  ctx.save();
  ctx.textAlign = "center";
  for (const pack of sc.packs) {
    if (pack.cleared) {
      ctx.strokeStyle = "rgba(74, 222, 128, 0.28)";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pack.x, pack.y, 30, 0, Math.PI * 2); ctx.stroke();
      continue;
    }
    ctx.strokeStyle = "rgba(248, 113, 113, 0.6)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 7]);
    ctx.beginPath(); ctx.arc(pack.x, pack.y, 48, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#fca5a5";
    ctx.fillText(`💰 ${pack.bounty}`, pack.x, pack.y - 56);
  }
  ctx.restore();
}

// Freighter — a slow, blocky cargo hauler for the convoy scenarios: a wide hull
// stacked with darker container blocks and a lit bridge at the nose, so it reads
// unmistakably as a civilian freighter to protect, not a warship.
function drawFreighter(ctx, u, def, color) {
  const angle = updateFacing(u);
  const r = def.radius, L = r * 1.5, W = r * 0.95;
  const cx = u.x, cy = u.y;

  pathOriented(ctx, cx, cy, angle, [
    [L, W * 0.45], [L, -W * 0.45],
    [L * 0.6, -W], [-L, -W],
    [-L, W], [L * 0.6, W],
  ]);
  ctx.fill();
  ctx.stroke();

  // Cargo containers stacked down the hull.
  ctx.fillStyle = shade(color, -30);
  for (const fx of [0.35, -0.05, -0.45]) {
    pathOriented(ctx, cx, cy, angle, [
      [L * fx + r * 0.18, W * 0.72], [L * fx + r * 0.18, -W * 0.72],
      [L * fx - r * 0.22, -W * 0.72], [L * fx - r * 0.22, W * 0.72],
    ]);
    ctx.fill();
  }

  ctx.fillStyle = DETAIL;                                   // bridge light at the nose
  const [bx, by] = toWorld(cx, cy, angle, L * 0.82, 0);
  ctx.beginPath(); ctx.arc(bx, by, r * 0.18, 0, Math.PI * 2); ctx.fill();
}

function updateFacing(unit) {
  const prev = facing.get(unit.id);
  let angle = prev ? prev.angle : -Math.PI / 2;
  if (prev) {
    const dx = unit.x - prev.x, dy = unit.y - prev.y;
    if (Math.hypot(dx, dy) > 0.5) angle = Math.atan2(dy, dx);
  }
  facing.set(unit.id, { x: unit.x, y: unit.y, angle });
  return angle;
}

// Tracer color hints at what fired: Bastion's short, heavy hit reads
// warm/gold, Lancer's precision shot reads cool/blue, everything else
// (Skiff, and any future default) reads hostile red.
function tracerColor(unitType) {
  if (unitType === "bastion") return "#ffd166";
  if (unitType === "lancer") return "#4fd1ff";
  return "#f87171";
}

// Attack tracers, death flashes, and under-attack pings: all purely
// cosmetic and short-lived (see effects.js), so this is the only place
// in render.js that reads wall-clock-timed state instead of the sim's
// own state object.
function drawEffects(ctx) {
  const { tracers, deaths, pings } = activeEffects();

  for (const t of tracers) {
    const color = tracerColor(t.unitType);
    ctx.globalAlpha = Math.max(0, 1 - t.age);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(t.fromX, t.fromY);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
    // A small impact spark where the round lands — a quick bright flash that
    // fades faster than the tracer, so a hit reads as connecting, not just a
    // line drawn through the target.
    ctx.globalAlpha = Math.max(0, 1 - t.age * 1.6);
    ctx.fillStyle = "#ffe9c2";
    ctx.beginPath();
    ctx.arc(t.toX, t.toY, 2.5 + (1 - t.age) * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const d of deaths) {
    const r = 6 + d.age * 16;
    ctx.globalAlpha = Math.max(0, 1 - d.age);
    ctx.strokeStyle = "#ffab5e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  const reduced = prefersReducedMotion();
  for (const p of pings) {
    if (reduced) {
      // Motion-sensitive players get a steady ring that just fades out, instead
      // of the repeating expanding pulse.
      ctx.globalAlpha = Math.max(0, 0.6 * (1 - p.age));
      ctx.strokeStyle = "#f87171";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    // Two expanding rings on a repeating pulse read as an alarm rather
    // than a one-shot flash, matching a ping's much longer lifetime.
    const pulse = (p.age * 2.5) % 1;
    ctx.globalAlpha = Math.max(0, (1 - pulse) * (1 - p.age * 0.6));
    ctx.strokeStyle = "#f87171";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14 + pulse * 40, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

// Translucent footprint under the cursor while placing a building, green
// when the spot is buildable and red when it isn't (out of bounds,
// overlapping another building, or too close to a resource node — see
// engine/colliders.js) so invalid placement is obvious before the
// player even clicks, not just rejected silently after.
function drawBuildGhost(ctx, state, ghost) {
  const def = BUILDINGS[ghost.buildingType];
  if (!def) return;
  const valid = canPlaceBuilding(state, ghost.buildingType, ghost.x, ghost.y);
  const color = valid ? "#4ade80" : "#f87171";

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = color;
  ctx.fillRect(ghost.x - def.radius, ghost.y - def.radius, def.radius * 2, def.radius * 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(ghost.x - def.radius, ghost.y - def.radius, def.radius * 2, def.radius * 2);
}

// `force` keeps the bar visible at full health for a selected entity, so you
// can confirm your army's condition at a glance instead of it vanishing the
// moment it's topped off. Three colour bands (green / amber / red) so the
// health tier reads without relying on the green-vs-red distinction alone.
function drawHealthBar(ctx, cx, y, w, hp, maxHp, force = false) {
  if (hp >= maxHp && !force) return;
  const pct = Math.max(0, hp / maxHp);
  ctx.fillStyle = "#243162";
  ctx.fillRect(cx - w / 2, y, w, 3);
  ctx.fillStyle = pct > 0.6 ? "#4ade80" : pct > 0.3 ? "#fbbf24" : "#f87171";
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

// The queued-waypoint path for every selected player unit: a dashed line
// threading the unit through its active order and each queued step,
// with a dot at each stop. Only drawn for units that actually have a queue,
// so an ordinary single-destination move doesn't clutter the field.
function drawWaypoints(ctx, state) {
  ctx.save();
  ctx.setLineDash([4, 5]);
  for (const id of state.selection) {
    const unit = state.units.get(id);
    if (!unit || unit.owner !== "player" || !unit.orderQueue || unit.orderQueue.length === 0) continue;

    const stops = [];
    for (const order of [unit.order, ...unit.orderQueue]) {
      const pt = orderPoint(state, order);
      if (pt) stops.push(pt);
    }
    if (!stops.length) continue;

    ctx.strokeStyle = "rgba(79, 209, 255, 0.5)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(unit.x, unit.y);
    for (const s of stops) ctx.lineTo(s.x, s.y);
    ctx.stroke();

    ctx.fillStyle = "#4fd1ff";
    for (const s of stops) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// A faint link from each selected escort to the friendly ship it's guarding, plus a ring on the
// target — so an active escort order reads at a glance (it carries no waypoint line otherwise).
// Escort green, distinct from the cyan waypoint colour.
function drawEscortLinks(ctx, state) {
  const guarded = new Set();
  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "rgba(120, 230, 170, 0.5)";
  ctx.lineWidth = 1.1;
  for (const id of state.selection) {
    const u = state.units.get(id);
    if (!u || u.owner !== "player" || !u.order || u.order.type !== "escort") continue;
    const t = state.units.get(u.order.targetId);
    if (!t || t.hp <= 0) continue;
    ctx.beginPath(); ctx.moveTo(u.x, u.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    guarded.add(t);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(120, 230, 170, 0.75)";
  ctx.lineWidth = 1.4;
  for (const t of guarded) {
    ctx.beginPath();
    ctx.arc(t.x, t.y, (UNITS[t.type]?.radius || 10) + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// Where an order points on the map, for its waypoint marker — a fixed spot
// for move/attack-move, or the live position of the unit/building/node it's
// chasing. Null for an order with nowhere to point.
function orderPoint(state, order) {
  if (!order) return null;
  if (order.type === "move" || order.type === "attack-move") return { x: order.x, y: order.y };
  if (order.type === "attack" || order.type === "escort") {
    const t = state.units.get(order.targetId) || state.buildings.get(order.targetId);
    return t ? { x: t.x, y: t.y } : null;
  }
  if (order.type === "gather") {
    const n = state.map.nodes.find(nd => nd.id === order.nodeId);
    return n ? { x: n.x, y: n.y } : null;
  }
  if (order.type === "build") {
    const b = state.buildings.get(order.buildingId);
    return b ? { x: b.x, y: b.y } : null;
  }
  return null;
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
