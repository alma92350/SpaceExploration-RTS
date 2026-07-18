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
import { isVisibleAt, FOG_CELL_SIZE } from "./engine/fog.js";
import { isValidPlacement } from "./engine/placement.js";
import { activeEffects } from "./effects.js";

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

export function drawFrame(ctx, state, camera, viewportW, viewportH, dragBox, buildGhost) {
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
  drawEffects(ctx);
  if (buildGhost) drawBuildGhost(ctx, state, buildGhost);
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

function drawNodes(ctx, state) {
  for (const n of state.map.nodes) {
    if (n.amount <= 0) continue;
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

// Mined/exploited deposits (ore, crystals, radioactives, ice, relics) read
// as a faceted asteroid chunk — an irregular polygon beats a perfect circle
// at selling "rock" at a glance, and the per-node seed keeps it stable.
function drawRockyNode(ctx, n, r) {
  const rng = seededRng(hashStr(n.id));
  const pts = polygonPoints(n.x, n.y, r, 8, rng() * Math.PI * 2).map(([x, y]) => {
    const jitter = 0.72 + rng() * 0.5;
    return [n.x + (x - n.x) * jitter, n.y + (y - n.y) * jitter];
  });
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

function drawBuildings(ctx, state) {
  for (const b of state.buildings.values()) {
    if (b.owner !== "player" && !isVisibleAt(state.fog, b.x, b.y)) continue;
    const color = state.players[b.owner].color;
    ctx.globalAlpha = b.constructing ? 0.5 : 1;

    if (b.type === "command") drawCommandCenter(ctx, b, color);
    else if (b.type === "barracks") drawBarracks(ctx, b, color);
    else if (b.type === "refinery") drawRefinery(ctx, b, color);

    ctx.globalAlpha = 1;
    drawHealthBar(ctx, b.x, b.y - b.radius - 8, b.radius * 2, b.hp, b.maxHp);
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

/* ---------- units ---------- */

function drawUnits(ctx, state) {
  for (const u of state.units.values()) {
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

    if (u.type === "worker") drawWorker(ctx, u, def, color);
    else if (u.type === "skiff") drawSkiff(ctx, u, def, color);
    else if (u.type === "bastion") drawBastion(ctx, u, def, color);
    else if (u.type === "lancer") drawLancer(ctx, u, def, color);

    if (u.cargo && u.cargo.qty > 0) {
      ctx.beginPath();
      ctx.arc(u.x, u.y - def.radius - 5, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffd166";
      ctx.fill();
    }
    drawHealthBar(ctx, u.x, u.y - def.radius - 9, 16, u.hp, u.maxHp);
  }
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
    ctx.globalAlpha = Math.max(0, 1 - t.age);
    ctx.strokeStyle = tracerColor(t.unitType);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(t.fromX, t.fromY);
    ctx.lineTo(t.toX, t.toY);
    ctx.stroke();
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

  for (const p of pings) {
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
// engine/placement.js) so invalid placement is obvious before the
// player even clicks, not just rejected silently after.
function drawBuildGhost(ctx, state, ghost) {
  const def = BUILDINGS[ghost.buildingType];
  if (!def) return;
  const valid = isValidPlacement(state, ghost.buildingType, ghost.x, ghost.y);
  const color = valid ? "#4ade80" : "#f87171";

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = color;
  ctx.fillRect(ghost.x - def.radius, ghost.y - def.radius, def.radius * 2, def.radius * 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(ghost.x - def.radius, ghost.y - def.radius, def.radius * 2, def.radius * 2);
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
