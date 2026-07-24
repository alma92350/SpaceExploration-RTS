/* ============================================================
   Render shared toolkit — the primitives and render-side state every draw
   module needs, kept in one leaf (no engine, no cross-render imports) so the
   node / building / unit / effect draw modules can share them without an import
   cycle:
     • DETAIL — the near-white accent used for hull greebles across both colours.
     • the facing map + frame-to-frame interpolation state (prevPos), with
       snapshotPositions / lerpXY / updateFacing / pruneFacing / resetFacing.
     • pure geometry + colour helpers (hash/seed/shade/hexA/polygon/path/orient).
     • inView culling and the drawHealthBar bar primitive (used by units AND
       buildings).
   Pure render-side bookkeeping — never read by the deterministic sim.
   ============================================================ */

"use strict";

// A light, near-white accent used for hull details (sensor eyes, canopy
// glass, engine glow, antenna lights) across both players' colors — the
// same "light outline reads at small sizes" reasoning the old triangle
// used, just reused for interior greebles too instead of only the outline.
export const DETAIL = "#dce6ff";

// Facing angle per unit id, inferred frame-to-frame from movement — pure
// render-side bookkeeping, never read by the sim. Shared by every oriented
// unit type (currently Skiff, Bastion and Lancer) so hull/turret art can
// point the way the unit is actually moving. Buildings ("b*" ids) reuse it too
// (a Sentinel Turret's barrel), and they can't collide with unit ("u*") ids.
export const facing = new Map();

// --- render interpolation ---------------------------------------------------
// The sim ticks at a fixed 20 Hz but the screen paints at 60–144 Hz, so drawing raw sim
// positions makes every unit teleport in 50 ms steps. boot.js snapshots each unit's position
// BEFORE each tick (snapshotPositions), the loop hands render the leftover fraction (alpha),
// and we draw at prev + (cur - prev) * alpha — pure render-side smoothing that never touches
// the deterministic sim (drawFrame's "never mutates" contract holds). A unit that JUMPED this
// step (relief spawn, world relocation) moves too far to slide, so we snap it instead.
const prevPos = new Map();     // unit id -> { x, y } at the start of the current tick
const TELEPORT_SQ = 60 * 60;   // a one-tick move past this is a teleport, not motion — don't lerp it
const _lerpPt = { x: 0, y: 0 };   // reused scratch so per-frame interpolation allocates nothing

// Record every live unit's current position as the interpolation baseline. Called by boot.js
// immediately before each tick(); reuses stored objects, so it allocates only for new units.
export function snapshotPositions(state) {
  for (const u of state.units.values()) {
    const p = prevPos.get(u.id);
    if (p) { p.x = u.x; p.y = u.y; } else prevPos.set(u.id, { x: u.x, y: u.y });
  }
}

// The position to DRAW unit `u` at, given the frame's interpolation alpha (0..1). Returns the
// live unit when there's no baseline (a unit spawned this tick), at a full step (alpha ≥ 1), or
// across a teleport; otherwise a reused {x,y} scratch on the prev→cur segment. Read it
// immediately — the scratch is overwritten on the next call.
export function lerpXY(u, alpha) {
  const p = prevPos.get(u.id);
  if (!p || alpha >= 1) return u;
  const dx = u.x - p.x, dy = u.y - p.y;
  if (dx * dx + dy * dy >= TELEPORT_SQ) return u;
  _lerpPt.x = p.x + dx * alpha; _lerpPt.y = p.y + dy * alpha;
  return _lerpPt;
}

// Drop facing entries for entities that no longer exist, so a long match with
// heavy unit churn (or repeated restarts) doesn't grow the Map without bound.
// Cheap: one Map.has per live-or-dead key, and after pruning the Map holds at
// most one entry per currently-live oriented entity.
export function pruneFacing(state) {
  for (const id of facing.keys()) {
    if (!state.units.has(id) && !state.buildings.has(id)) facing.delete(id);
  }
  for (const id of prevPos.keys()) {
    if (!state.units.has(id)) prevPos.delete(id);   // interpolation baselines for dead units
  }
}

// Cleared on a fresh game so orientations/positions from a previous match don't linger.
export function resetFacing() {
  facing.clear();
  prevPos.clear();
}

// Infer and store a unit's facing angle from its frame-to-frame movement; returns the angle so
// an oriented hull can draw pointing the way it's actually moving. A near-stationary unit keeps
// its previous angle (no jitter). Buildings call it too (a turret barrel) — the "b*"/"u*" id
// spaces can't collide in the shared map.
export function updateFacing(unit) {
  const prev = facing.get(unit.id);
  let angle = prev ? prev.angle : -Math.PI / 2;
  if (prev) {
    const dx = unit.x - prev.x, dy = unit.y - prev.y;
    if (Math.hypot(dx, dy) > 0.5) angle = Math.atan2(dy, dx);
  }
  facing.set(unit.id, { x: unit.x, y: unit.y, angle });
  return angle;
}

// True when (x,y) — padded by radius r — overlaps the on-screen world rect (viewBounds). Every
// draw module culls off-screen entities with it, so on a big map the draw cost tracks what's
// visible, not total map size.
export function inView(view, x, y, r = 0) {
  return x + r >= view.minX && x - r <= view.maxX && y + r >= view.minY && y - r <= view.maxY;
}

/* ---------- small geometry helpers ---------- */

// Deterministic string hash → seeded PRNG, so each resource node's
// "irregular rock" silhouette is stable frame to frame (derived from its
// id) instead of jittering every draw call like a fresh Math.random() would.
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function seededRng(seed) {
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
export function shade(hex, percent) {
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = clamp((num >> 16) + amt);
  const g = clamp(((num >> 8) & 0xff) + amt);
  const b = clamp((num & 0xff) + amt);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

// A "#rrggbb" hex plus an alpha → an "rgba(r,g,b,a)" string, so a fixed palette
// colour can be drawn translucent (the efficiency-zone fills/rings).
export function hexA(hex, alpha) {
  const num = parseInt(hex.slice(1), 16);
  return `rgba(${num >> 16}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}

export function polygonPoints(cx, cy, r, sides, rotation = 0) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export function pathPoints(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

// Rotates a local point (nose along +x) by `angle` and places it at (cx,cy)
// — lets oriented-unit shapes be authored once in "facing right" space.
export function toWorld(cx, cy, angle, lx, ly) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
}
export function pathOriented(ctx, cx, cy, angle, localPts) {
  pathPoints(ctx, localPts.map(([lx, ly]) => toWorld(cx, cy, angle, lx, ly)));
}

// A three-band (green / amber / red) health bar, drawn only when damaged (or forced, e.g. a
// selected unit). Shared by the unit overlay pass and the building bar pass.
export function drawHealthBar(ctx, cx, y, w, hp, maxHp, force = false) {
  if (hp >= maxHp && !force) return;
  const pct = Math.max(0, hp / maxHp);
  ctx.fillStyle = "#243162";
  ctx.fillRect(cx - w / 2, y, w, 3);
  ctx.fillStyle = pct > 0.6 ? "#4ade80" : pct > 0.3 ? "#fbbf24" : "#f87171";
  ctx.fillRect(cx - w / 2, y, w * pct, 3);
}
