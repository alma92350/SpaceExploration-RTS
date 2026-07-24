/* ============================================================
   Cosmetic overlays and cues, drawn on top of the world — attack tracers /
   death flashes / under-attack pings (effects.js), the convoy-scenario route,
   selection rings, rally point, movement waypoints, escort links, the build
   ghost (with its power-grid / rig-survey placement cues), and the drag box.
   These are the only render paths that read wall-clock-timed state (effects.js)
   rather than the sim's own state. Split out of render.js.
   ============================================================ */

"use strict";

import { COM } from "./data.js";
import { UNITS, BUILDINGS } from "./engine/entities.js";
import { isNodeDiscovered } from "./engine/fog.js";
import { powerEfficiency } from "./engine/industry.js";
import { rigSurvey, SURVEY_RADIUS } from "./engine/rig.js";
import { canPlaceBuilding } from "./engine/colliders.js";
import { activeEffects } from "./effects.js";
import { hexA, lerpXY } from "./renderShared.js";

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

// The convoy route overlay (scenario mode): a dashed lane connecting the
// stations, a muted ring at the start, cyan rings at the waypoint stations, and
// a bright green gate at the destination. The station the convoy is currently
// heading for gets a solid halo so the objective reads at a glance.
export function drawScenario(ctx, state) {
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
export function drawEffects(ctx) {
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

// The grid-efficiency cue drawn under a power-consumer build ghost: the nearest own
// Reactor's zones + a connector to it, and the ghost's resulting tier as a coloured ring
// and label ("On-grid · draw ×1.0" … "Isolated · draw ×2.3"). Mirrors how the Spaceport
// shows its jump radius — it turns "where do I put this factory?" into a visible choice.
function drawGhostPowerCue(ctx, state, ghost, def) {
  // The source that DETERMINES the ghost's tier: the nearest by RANGE-SCALED distance, so a
  // close short-range Generator can out-rank a far Reactor exactly as the efficiency math does.
  let nearest = null, bestD = Infinity, nearestScale = 1;
  for (const b of state.buildings.values()) {
    const bd = BUILDINGS[b.type];
    if (b.owner !== "player" || b.constructing || !(bd && bd.energyGrants > 0)) continue;
    const scale = bd.powerRange || 1;
    const d = Math.hypot(b.x - ghost.x, b.y - ghost.y) / scale;
    if (d < bestD) { bestD = d; nearest = b; nearestScale = scale; }
  }

  const tier = powerEfficiency(state, "player", ghost.x, ghost.y);
  const col = POWER_TIER_COLOR[tier.name];

  if (nearest) {
    drawReactorBands(ctx, nearest.x, nearest.y, nearestScale);
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = hexA(col, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nearest.x, nearest.y);
    ctx.lineTo(ghost.x, ghost.y);
    ctx.stroke();
    ctx.restore();
  }

  // A ring in the tier colour around the ghost, plus a label above it.
  ctx.save();
  ctx.beginPath();
  ctx.arc(ghost.x, ghost.y, def.radius + 7, 0, Math.PI * 2);
  ctx.strokeStyle = col;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const label = nearest
    ? `${tier.label} · draw ×${tier.mult.toFixed(1)}`
    : "No Reactor — power it first";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const ly = ghost.y - def.radius - 12;
  const w = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(5, 7, 15, 0.78)";
  ctx.fillRect(ghost.x - w / 2 - 5, ly - 15, w + 10, 17);
  ctx.fillStyle = nearest ? col : "#f87171";
  ctx.fillText(label, ghost.x, ly);
  ctx.restore();
}

// The Plasma Rig placement survey: a dashed violet ring at the survey radius, a highlight on
// each VISIBLE deposit the rig would read inside it, and a label predicting the vein + seam
// richness below (engine/rig.js rigSurvey). Only the player's charted surface counts, so a spot
// with no visible deposits reads "blind — a gamble", and an unscouted cache stays a surprise.
function drawRigSurveyCue(ctx, state, ghost, def) {
  const VIOLET = "180, 140, 255";
  ctx.save();
  ctx.setLineDash([4, 8]);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = `rgba(${VIOLET}, 0.5)`;
  ctx.beginPath();
  ctx.arc(ghost.x, ghost.y, SURVEY_RADIUS, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const visible = state.map.nodes.filter(n => n.amount > 0 && isNodeDiscovered(state.fog, n)
    && Math.hypot(n.x - ghost.x, n.y - ghost.y) < SURVEY_RADIUS);
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = `rgba(${VIOLET}, 0.85)`;
  ctx.lineWidth = 1.5;
  for (const n of visible) {
    ctx.beginPath();
    ctx.arc(n.x, n.y, 7 + 9 * (n.amount / n.max) + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const survey = rigSurvey(visible, state.planetId, ghost.x, ghost.y);
  const meta = survey.likelyVein ? COM[survey.likelyVein] : null;
  const confWord = !survey.likelyVein ? "" : survey.confidence >= 0.6 ? "likely " : survey.confidence >= 0.35 ? "maybe " : "toss-up: ";
  const label = survey.likelyVein
    ? `⛏ ${confWord}${meta?.name || survey.likelyVein} · ${survey.richLabel} seam`
    : "⛏ blind spot — no surface to read (a gamble)";

  ctx.save();
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  const ly = ghost.y - def.radius - 34;   // sits above the grid-efficiency label (at radius+12)
  const w = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(5, 7, 15, 0.8)";
  ctx.fillRect(ghost.x - w / 2 - 5, ly - 15, w + 10, 17);
  ctx.fillStyle = survey.likelyVein ? "#c4b5fd" : "#f0a0a0";
  ctx.fillText(label, ghost.x, ly);
  ctx.restore();
}

// Translucent footprint under the cursor while placing a building, green
// when the spot is buildable and red when it isn't (out of bounds,
// overlapping another building, or too close to a resource node — see
// engine/colliders.js) so invalid placement is obvious before the
// player even clicks, not just rejected silently after.
export function drawBuildGhost(ctx, state, ghost) {
  const def = BUILDINGS[ghost.buildingType];
  if (!def) return;

  // Placing a power consumer (a factory, the Plasma Rig, or the Gate)? Surface the
  // grid-efficiency zones of every nearby Reactor and tag the ghost with the tier it
  // would land in, so the "closer is cheaper to power" call is visible BEFORE the click.
  if (def.recipe || def.rig || def.wonder) drawGhostPowerCue(ctx, state, ghost, def);

  // Placing a Plasma Rig? Read the visible surface deposits and predict the vein + seam
  // richness below, so late-game placement is an educated guess off the map, not a blind pick.
  if (def.rig) drawRigSurveyCue(ctx, state, ghost, def);

  const valid = canPlaceBuilding(state, ghost.buildingType, ghost.x, ghost.y);
  const color = valid ? "#4ade80" : "#f87171";
  const r = def.radius;

  ctx.globalAlpha = 0.45;
  ctx.fillStyle = color;
  ctx.fillRect(ghost.x - r, ghost.y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  // An INVALID spot carries a non-colour cue too — a dashed outline plus an ✕ across the
  // footprint — so it reads without relying on the red-vs-green hue alone (the same
  // colourblind-safe principle the health bars use). A valid spot stays a clean solid box.
  if (valid) {
    ctx.strokeRect(ghost.x - r, ghost.y - r, r * 2, r * 2);
  } else {
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(ghost.x - r, ghost.y - r, r * 2, r * 2);
    ctx.beginPath();
    ctx.moveTo(ghost.x - r, ghost.y - r); ctx.lineTo(ghost.x + r, ghost.y + r);
    ctx.moveTo(ghost.x + r, ghost.y - r); ctx.lineTo(ghost.x - r, ghost.y + r);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// `force` keeps the bar visible at full health for a selected entity, so you
// can confirm your army's condition at a glance instead of it vanishing the
// moment it's topped off. Three colour bands (green / amber / red) so the
// health tier reads without relying on the green-vs-red distinction alone.

export function drawSelectionRings(ctx, state, alpha = 1) {
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 2;
  for (const id of state.selection) {
    const unit = state.units.get(id);
    const e = unit || state.buildings.get(id);
    if (!e) continue;
    const baseRadius = unit ? UNITS[unit.type].radius : e.radius;
    const r = baseRadius + 4;
    const d = unit ? lerpXY(unit, alpha) : e;   // ring follows the interpolated hull (buildings are static)
    ctx.beginPath();
    ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Shown only for the single selected production building, matching the
// usual RTS convention of not cluttering the view with every building's
// rally line at once.
export function drawRallyPoint(ctx, state) {
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
export function drawWaypoints(ctx, state) {
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
export function drawEscortLinks(ctx, state) {
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

export function drawDragBox(ctx, box) {
  const x = Math.min(box.x1, box.x2), y = Math.min(box.y1, box.y2);
  const w = Math.abs(box.x2 - box.x1), h = Math.abs(box.y2 - box.y1);
  ctx.fillStyle = "rgba(79, 209, 255, 0.15)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#4fd1ff";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
}
