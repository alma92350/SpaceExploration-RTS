// @ts-check
/* ============================================================
   Formation geometry: where each unit in a moving or holding group should
   stand, given a shape and (for shapes that have one) a leader position.
   Pure + deterministic — geometry only, no clock/RNG — so a move order's
   destinations are exactly reproducible, exactly like the flat grid spread
   this replaces.

   FOUR shapes:
     - "grid"   the original spread (a square-ish block, no leader distinction)
     - "line"   a single row abreast, the leader nudged ahead of it ("front")
                or trailing behind it ("back")
     - "wedge"  a V: the leader at the tip with flanks fanned out BEHIND it
                ("front" — a spearhead), or at the rear vertex with flanks
                fanned out AHEAD of it ("back" — a protective chevron)
     - "circle" a ring; the leader anchors the CENTER, escorted by the rest
                on the ring around it ("center" — the default and the one
                explicitly asked for), or takes a point ON the ring at the
                front/back with everyone else filling the rest evenly

   The "leader" is deterministic, not selection-order-dependent: the unit
   with the most maxHp (a bigger hull naturally leads), ties broken by id —
   see pickLeader.

   NESTED formations: a selection that's ALREADY spread into distinct spatial
   clusters (e.g. two armies on opposite sides of the map, box-selected
   together) is laid out as a formation OF formations — clusterUnits splits
   it, the SAME shape arranges the clusters' centres relative to each other
   (a wedge of wedges, a line of lines, …), spaced by each cluster's own
   footprint so sub-formations can't overlap, and each cluster is then laid
   out again internally around its assigned centre. A single blob of units —
   the ordinary case, everyone selected in one place — collapses to exactly
   ONE cluster, so nesting only ever engages when the selection already
   calls for it.

   Spacing is derived from the group's own hull sizes (spacingFor), not a
   flat constant, EXCEPT the plain single-group "grid" path, which keeps the
   exact historical flat spacing (GRID_SPACING) so the untouched default —
   no shape chosen, one blob of units — stays byte-identical to the old
   formationSpots this module replaces (see test/commands.test.js).
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";

export const FORMATION_SHAPES = ["grid", "line", "wedge", "circle"];
export const LEADER_POSITIONS = ["front", "back", "center"];

const GRID_SPACING = 20;        // unchanged from the legacy formationSpots (engine/commands.js)
const SPACING_PAD = 8;          // clearance beyond 2x the largest hull's radius
const CLUSTER_RADIUS = 150;     // units within this of each other (transitively) count as one army
const NEST_GAP_MULT = 2.4;      // outer (formation-of-formations) spacing, as a multiple of a cluster's own footprint

/** @param {Unit} u @returns {number} */
function radiusOf(u) {
  return UNITS[u.type] ? UNITS[u.type].radius : 9;
}

/** @param {{x?:number, y?:number}} u @returns {{x:number, y:number}} */
function pos(u) {
  return { x: Number.isFinite(u.x) ? u.x : 0, y: Number.isFinite(u.y) ? u.y : 0 };
}

/** @param {Unit[]} units @returns {{x:number, y:number}} */
function centroid(units) {
  let sx = 0, sy = 0;
  for (const u of units) { const p = pos(u); sx += p.x; sy += p.y; }
  return { x: sx / units.length, y: sy / units.length };
}

// The deterministic "flagship": the unit with the most maxHp (ties broken by id, never by
// selection/array order — the same pick must come out of the same group regardless of how the
// player happened to box-select it).
/** @param {Unit[]} units @returns {Unit} */
export function pickLeader(units) {
  let best = units[0];
  for (const u of units) {
    const bhp = best.maxHp ?? 0, uhp = u.maxHp ?? 0;
    if (uhp > bhp || (uhp === bhp && u.id < best.id)) best = u;
  }
  return best;
}

// Radius-aware baseline spacing for a group: room for the two largest hulls present to clear
// each other, plus a little breathing space — "sufficient spacing between units," not a flat
// number that a Bulk Freighter (radius 15) would blow straight through.
/** @param {Unit[]} units @returns {number} */
function spacingFor(units) {
  let maxR = 0;
  for (const u of units) maxR = Math.max(maxR, radiusOf(u));
  return maxR * 2 + SPACING_PAD;
}

// Partition a selection into spatial sub-armies: any two units within CLUSTER_RADIUS of each
// other (transitively) land in the same cluster — a plain union-find pass over CURRENT
// positions. A single blob of units (the common case) collapses to one cluster. O(n^2) on the
// selection size, which is issue-time work on a small array, not a per-tick cost.
/** @param {Unit[]} units @returns {Unit[][]} */
export function clusterUnits(units) {
  const n = units.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const P = units.map(pos);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) <= CLUSTER_RADIUS) union(i, j);
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(units[i]);
  }
  return [...groups.values()];
}

// A row abreast the direction of travel — leader (slot 0) nudged ahead of it ("front") or
// trailing behind it ("back"); everyone else fills the line, centred.
function lineOffsets(n, leaderPos, spacing) {
  const rest = n - 1;
  const out = new Array(n);
  for (let k = 0; k < rest; k++) out[k + 1] = { forward: 0, right: (k - (rest - 1) / 2) * spacing };
  out[0] = { forward: rest ? (leaderPos === "back" ? -spacing : spacing) : 0, right: 0 };
  return out;
}

// A V: rank 0 is the tip (the leader, slot 0), each rank after it adds two flanking slots
// further out and further back. "front" leaves it as a spearhead (tip leads, flanks trail);
// "back" mirrors the depth so the tip trails at the rear vertex, protected, while the flanks
// fan out ahead of it.
function wedgeOffsets(n, leaderPos, spacing) {
  const out = new Array(n);
  out[0] = { forward: 0, right: 0 };
  let idx = 1, rank = 1;
  while (idx < n) {
    const depth = rank * spacing * 0.85, lateral = rank * spacing * 0.7;
    out[idx++] = { forward: -depth, right: -lateral };
    if (idx < n) out[idx++] = { forward: -depth, right: lateral };
    rank++;
  }
  if (leaderPos === "back") for (const o of out) o.forward = -o.forward;
  return out;
}

// A ring. "center" seats the leader (slot 0) in the middle, protected, with everyone else
// evenly spaced on a ring around it (the group escorting its own flagship — the explicit ask:
// "leader center of circular formation"). "front"/"back" instead puts every unit, leader
// included, ON the ring, with the leader's slot at the front or back of it.
function circleOffsets(n, leaderPos, spacing) {
  const out = new Array(n);
  if (leaderPos !== "front" && leaderPos !== "back") {
    out[0] = { forward: 0, right: 0 };
    const ringN = n - 1;
    if (ringN === 0) return out;
    const R = Math.max(spacing, (ringN * spacing) / (2 * Math.PI));
    for (let k = 0; k < ringN; k++) {
      const a = (k / ringN) * Math.PI * 2;
      out[k + 1] = { forward: Math.cos(a) * R, right: Math.sin(a) * R };
    }
    return out;
  }
  const R = Math.max(spacing, (n * spacing) / (2 * Math.PI));
  const start = leaderPos === "back" ? Math.PI : 0;
  for (let k = 0; k < n; k++) {
    const a = start + (k / n) * Math.PI * 2;
    out[k] = { forward: Math.cos(a) * R, right: Math.sin(a) * R };
  }
  return out;
}

// Re-centre a set of {forward,right} offsets so their own mean is exactly (0,0) — guarantees
// every shape's centroid lands precisely on the anchor point once translated there, the same
// invariant the (inherently self-centring) grid formula already has.
function centerOffsets(offsets) {
  let mf = 0, mr = 0;
  for (const o of offsets) { mf += o.forward; mr += o.right; }
  mf /= offsets.length; mr /= offsets.length;
  return offsets.map(o => ({ forward: o.forward - mf, right: o.right - mr }));
}

function shapeOffsets(n, shape, leaderPos, spacing) {
  const raw = shape === "line" ? lineOffsets(n, leaderPos, spacing)
    : shape === "circle" ? circleOffsets(n, leaderPos, spacing)
    : wedgeOffsets(n, leaderPos, spacing);   // "wedge", and the fallback for any unrecognised shape
  return centerOffsets(raw);
}

// Lay out `members` (units OR cluster-arrays — anything `weightOf`/`idOf`/`spacingOf` can read)
// into `shape`, oriented by (headingX,headingY), centred on (cx,cy). Returns points in the SAME
// order as `members`. `shape==="grid"` ignores heading entirely (world-axis-aligned, exactly the
// legacy behaviour); every other shape orients its forward axis along the heading (or a stable
// default when the group isn't actually travelling — e.g. re-forming in place).
function layout(members, cx, cy, headingX, headingY, shape, leaderPos, spacingOf, weightOf, idOf) {
  const n = members.length;
  if (n === 1) return [{ x: cx, y: cy }];
  const spacing = spacingOf(members);

  if (shape === "grid") {
    const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    return members.map((_, i) => {
      const col = i % cols, row = Math.floor(i / cols);
      return { x: cx + (col - (cols - 1) / 2) * spacing, y: cy + (row - (rows - 1) / 2) * spacing };
    });
  }

  let hx = headingX, hy = headingY;
  const hlen = Math.hypot(hx, hy);
  if (hlen < 1e-6) { hx = 1; hy = 0; } else { hx /= hlen; hy /= hlen; }

  // Leader-first slot order: which member sits in raw[0] (the shape's leader treatment) — most
  // weight wins, ties by id — same rule as pickLeader, generalised to non-Unit members (clusters).
  const order = members.map((_, i) => i).sort((ia, ib) => {
    const wa = weightOf(members[ia]), wb = weightOf(members[ib]);
    if (wa !== wb) return wb - wa;
    const a = idOf(members[ia]), b = idOf(members[ib]);
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  const raw = shapeOffsets(n, shape, leaderPos, spacing);
  const out = new Array(n);
  order.forEach((memberIdx, slot) => {
    const { forward, right } = raw[slot];
    out[memberIdx] = { x: cx + forward * hx + right * hy, y: cy + forward * hy - right * hx };
  });
  return out;
}

/**
 * Where each unit in `units` should stand for a move to (destX,destY) — or, for a stationary
 * hold, where the group's own current centroid already is (pass it as both the destination AND
 * `originX`/`originY`, or simply omit `originX`/`originY` and let it default there). Returns
 * one {x,y} per unit, in the SAME order as `units`.
 * @param {Unit[]} units
 * @param {number} destX
 * @param {number} destY
 * @param {{shape?:string, leaderPos?:string, originX?:number, originY?:number}} [opts]
 * @returns {{x:number, y:number}[]}
 */
export function formationSlots(units, destX, destY, opts = {}) {
  const n = units.length;
  if (n === 0) return [];
  const { shape = "grid", leaderPos = "front" } = opts || {};
  if (n === 1) return [{ x: destX, y: destY }];

  let { originX, originY } = opts || {};
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) {
    const c = centroid(units);
    originX = c.x; originY = c.y;
  }
  const headingX = destX - originX, headingY = destY - originY;

  const clusters = clusterUnits(units);
  if (clusters.length <= 1) {
    // The one path that must stay byte-identical to the old flat grid spread: no shape chosen,
    // one blob of units — the legacy formationSpots' exact spacing constant, untouched.
    const spacingOf = shape === "grid" ? () => GRID_SPACING : spacingFor;
    return layout(units, destX, destY, headingX, headingY, shape, leaderPos, spacingOf, u => u.maxHp ?? 0, u => u.id);
  }

  // Nested: a formation OF formations. Each cluster is one outer slot, arranged by the SAME
  // shape (a wedge of wedges, a line of lines, …) — spaced by the largest cluster's own
  // footprint so sub-formations can't overlap ("sufficient spacing… in formation of formations").
  const footprints = clusters.map(c => Math.max(1, Math.ceil(Math.sqrt(c.length))) * spacingFor(c));
  const outerSpacing = Math.max(...footprints) * NEST_GAP_MULT;
  const clusterWeight = c => c.reduce((s, u) => s + (u.maxHp ?? 0), 0);
  const centers = layout(
    clusters, destX, destY, headingX, headingY, shape, leaderPos,
    () => outerSpacing, clusterWeight, c => c[0].id,
  );

  const placed = new Map();
  clusters.forEach((cluster, i) => {
    const { x: ccx, y: ccy } = centers[i];
    const cc = centroid(cluster);
    const inner = layout(cluster, ccx, ccy, ccx - cc.x, ccy - cc.y, shape, leaderPos, spacingFor, u => u.maxHp ?? 0, u => u.id);
    cluster.forEach((u, k) => placed.set(u, inner[k]));
  });
  return units.map(u => placed.get(u));
}
