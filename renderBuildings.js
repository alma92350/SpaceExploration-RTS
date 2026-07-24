/* ============================================================
   Building rendering — the per-type structure silhouettes (Command Center,
   Barracks, Refinery, factories, Turret, …), their health-bar and store-bar
   overlays, and the Odyssey selection cues (jump-staging ring, power grid). The
   shape dispatch (drawBuildingShape) is shared with the HUD's button icons
   (render.js spriteIcon). Split out of render.js; drawFrame calls drawBuildings /
   drawBuildingBars / drawJumpStaging / drawPowerGrid.
   ============================================================ */

"use strict";

import { COM, RECIPES } from "./data.js";
import { BUILDINGS, storeCapOf, storeTotal } from "./engine/entities.js";
import { isVisibleAt } from "./engine/fog.js";
import { JUMP_LOAD_RADIUS } from "./engine/galaxy.js";
import { POWER_TIERS } from "./engine/industry.js";
import { DETAIL, facing, shade, hexA, polygonPoints, pathPoints, inView, drawHealthBar } from "./renderShared.js";

/* ---------- buildings ---------- */

// The shape dispatch, factored out of drawBuildings so the HUD's button icons
// (spriteIcon) render the exact same silhouette the map does. Only the turret reads
// `state` (it aims at its live target); an icon passes a stub state with empty Maps.
export function drawBuildingShape(ctx, state, b, color) {
  if (b.type === "command") drawCommandCenter(ctx, b, color);
  else if (b.type === "barracks") drawBarracks(ctx, b, color);
  else if (b.type === "refinery") drawRefinery(ctx, b, color);
  else if (b.type === "foundry") drawFoundry(ctx, b, color);
  else if (b.type === "arsenal") drawArsenal(ctx, b, color);
  else if (b.type === "turret") drawTurret(ctx, state, b, color);
  else if (b.type === "habitat") drawHabitat(ctx, b, color);
  else if (b.type === "spaceport") drawSpaceport(ctx, b, color);
  else if (factoryGlyph(b.type)) drawFactory(ctx, b, color);   // Odyssey factories + reactor/datacenter/etc: stamp a function glyph
  else drawGenericBuilding(ctx, b, color);   // any future building still gets a silhouette, never an invisible blank
}

export function drawBuildings(ctx, state, view) {
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
  }
}

// Building health bars, drawn in a LATER pass than every hull (see drawFrame) so a ship
// passing over a base no longer paints out the base's bar.
export function drawBuildingBars(ctx, state, view) {
  const selSet = new Set(state.selection);
  for (const b of state.buildings.values()) {
    if (view && !inView(view, b.x, b.y, b.radius + 12)) continue;
    if (b.owner !== "player" && !isVisibleAt(state.fog, b.x, b.y)) continue;
    drawHealthBar(ctx, b.x, b.y - b.radius - 8, b.radius * 2, b.hp, b.maxHp, selSet.has(b.id));
    drawStoreBar(ctx, b);   // a producer's output-buffer gauge, under the hull
  }
}

// A producer's finite output buffer (engine/haul.js) as a gauge UNDER the hull: how
// full it is, gold while there's room, red when it's brimming (production has stalled
// until a worker hauls it off). Only drawn for own producers with something in the
// buffer, so it reads as live logistics pressure without cluttering the field.
function drawStoreBar(ctx, b) {
  const cap = storeCapOf(b.type);
  if (cap <= 0 || b.owner !== "player") return;
  const total = storeTotal(b);
  if (total <= 0) return;
  const pct = Math.min(1, total / cap);
  const w = b.radius * 2, x = b.x - b.radius, y = b.y + b.radius + 4;
  ctx.fillStyle = "#243162";
  ctx.fillRect(x, y, w, 3);
  ctx.fillStyle = pct >= 0.999 ? "#f87171" : "#fbbf24";   // red = full/stalled, gold = filling
  ctx.fillRect(x, y, w * pct, 3);
}

// The jump staging area around a SELECTED player Spaceport: a dashed ring at
// JUMP_LOAD_RADIUS with a faint fill (the disc whose units ride along on a jump —
// engine/galaxy.js stagedRiders), and a highlight on each unit currently inside it.
// Answers "where do I park units so they come with me?" — drawn only when the
// Spaceport is selected, so it never clutters the map otherwise.
export function drawJumpStaging(ctx, state, view) {
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

// The grid-efficiency tier palette (engine/industry.js POWER_TIERS): the closer a
// factory/rig sits to a Reactor the cheaper it is to power, so these zones tell the
// player WHERE to drop one. Green (on-grid, no loss) → red (isolated, worst).
const POWER_TIER_COLOR = { linked: "#4ade80", near: "#a3e635", far: "#fbbf24", isolated: "#f87171" };

// Concentric efficiency zones around one power source at (rx, ry): a faint tinted disc per
// finite band (painted largest-first so each inner band shows its own hue) with a dashed
// boundary ring. `scale` is the source's powerRange — a short-range Generator's zones shrink,
// so its rings sit tighter than a Reactor's. Shared by the selected-source overlay and the cue.
function drawReactorBands(ctx, rx, ry, scale = 1) {
  const bands = POWER_TIERS.filter(t => Number.isFinite(t.max));
  ctx.save();
  for (let i = bands.length - 1; i >= 0; i--) {        // largest radius first, so inner hues win
    const t = bands[i], col = POWER_TIER_COLOR[t.name];
    ctx.beginPath();
    ctx.arc(rx, ry, t.max * scale, 0, Math.PI * 2);
    ctx.fillStyle = hexA(col, 0.05);
    ctx.fill();
  }
  ctx.setLineDash([8, 7]);
  ctx.lineWidth = 1.5;
  for (const t of bands) {
    ctx.beginPath();
    ctx.arc(rx, ry, t.max * scale, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(POWER_TIER_COLOR[t.name], 0.55);
    ctx.stroke();
  }
  ctx.restore();
}

// The power-grid overlay around a SELECTED player power source (Reactor or Combustion Generator):
// its efficiency zones, so a player can see the on-grid / near / far bands — scaled to the source's
// reach — before placing a factory or rig near it. Drawn only for a selected source (mirrors the
// Spaceport's jump-staging ring), so it never clutters the field otherwise.
export function drawPowerGrid(ctx, state, view) {
  const selSet = new Set(state.selection);
  const outer = POWER_TIERS[POWER_TIERS.length - 2].max;
  for (const b of state.buildings.values()) {
    const def = BUILDINGS[b.type];
    if (!(def && def.energyGrants > 0) || b.owner !== "player" || b.constructing || !selSet.has(b.id)) continue;
    const scale = def.powerRange || 1;
    if (view && !inView(view, b.x, b.y, outer * scale + 8)) continue;
    drawReactorBands(ctx, b.x, b.y, scale);
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
// recipe id -> the commodity it OUTPUTS (data.js RECIPES), so a factory can show what it makes.
const RECIPE_OUT = Object.fromEntries(RECIPES.map(r => [r.id, r.out]));

// A distinguishing glyph for buildings that otherwise share the plain hex silhouette. A
// recipe-running factory shows the commodity it OUTPUTS; a handful of non-recipe industrial
// buildings get an explicit emoji for what they DO — the Reactor grants Power (⚡), the Datacenter
// runs research (🔬), the Stardock is a capital-ship yard (🛰️), the Antimatter Gate is the wonder (🌀).
const BUILDING_GLYPH = { reactor: "⚡", combustor: "🔥", datacenter: "🔬", stardock: "🛰️", antimatter_gate: "🌀", plasmarig: "⛏️" };
function factoryGlyph(type) {
  const def = BUILDINGS[type];
  if (def && def.recipe && RECIPE_OUT[def.recipe]) return COM[RECIPE_OUT[def.recipe]]?.ico || null;
  return BUILDING_GLYPH[type] || null;
}

// Every recipe-running factory (Smelter, Assembly Plant, Chip Fab, …) and the non-recipe industrial
// buildings above otherwise share the plain hex silhouette below — indistinguishable on the map and
// in the build menu. Stamp the building's glyph (its product's emoji, or the explicit icon) on a
// dark disc so each reads at a glance as what it does. Keyed on the building TYPE, so the HUD button
// icon (spriteIcon renders this same shape) gets the glyph too.
function drawFactory(ctx, b, color) {
  drawGenericBuilding(ctx, b, color);
  const ico = factoryGlyph(b.type);
  if (!ico) return;
  const r = b.radius;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(5,7,15,0.74)"; ctx.fill();
  ctx.font = `${Math.round(r * 0.95)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ico, b.x, b.y);
  ctx.textBaseline = "alphabetic";   // restore the canvas default so later text draws aren't shifted
}

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
