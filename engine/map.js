/* ============================================================
   Skirmish map generation.
   Picks one charted world from data.js and scatters resource nodes
   mirrored across the map, sized by that world's own deposit yields —
   so which planet you fight over changes what the map plays like.

   Configurable from the splash screen (see main.js): a size multiplier
   (Small 1x … Gigantic 4x) scales the whole map self-similarly, and a
   resource multiplier (Rare … Abundant) scales every deposit's amount.
   At sizeMult=1, resourceMult=1 the layout is byte-identical to the
   original small map.
   ============================================================ */

"use strict";

import { PLANETS } from "../data.js";

// The "Small" map — every other size is a whole-number multiple of this.
export const MAP_WIDTH = 1600;
export const MAP_HEIGHT = 1000;

// Fraction of the (scaled) map width that counts as "near a base" for the
// build-critical resource guarantee below. 500/1600 → exactly 500 on a Small
// map, and proportional on bigger ones.
const NEAR_BASE_FRAC = 500 / MAP_WIDTH;

// Every build ultimately needs ore (all units/buildings), crystals (Turret,
// Reinforced Plating) and radioactives (Breacher, Overcharged Weapons). A
// planet's deposit table is its *specificity* — how much of each it holds —
// but every map must still let you make everything, so any of these three the
// surface doesn't provide near a base gets a lean guaranteed seam. A world
// rich in a commodity keeps its big deposits; a world without it gets just
// this minimum. Ore's floor is highest since it funds the whole economy.
const BUILD_CRITICAL = ["ore", "crystals", "radioactives"];
const MIN_GUARANTEE = { ore: 480, crystals: 300, radioactives: 300 };
// Vertical offset (fraction of height) each guaranteed seam sits at, so the
// three don't pile onto one point when a world needs several of them.
const GUARANTEE_Y = { ore: 0, crystals: -0.12, radioactives: 0.12 };

const CACHE_BASE_AMOUNT = 360;   // ~0.6x a normal 600 cluster — a real bonus, not a second economy

export function generateMap(planetId = "ferros", rng = Math.random, opts = {}) {
  const planet = PLANETS.find(p => p.id === planetId);
  if (!planet) throw new Error(`Unknown planet: ${planetId}`);
  const modifiers = PLANET_MODIFIERS[planetId] || {};

  const sizeMult = opts.sizeMult || 1;
  const resourceMult = opts.resourceMult || 1;
  const width = MAP_WIDTH * sizeMult;
  const height = MAP_HEIGHT * sizeMult;
  // A node's final amount: its base yield, the world's own richness modifier,
  // and the player's Rare/Normal/Abundant resource choice, all folded in.
  const amountOf = base => Math.max(1, Math.round(base * (modifiers.nodeAmountMult || 1) * resourceMult));

  const bases = {
    player: { x: width * 0.1, y: height * 0.5 },
    ai: { x: width * 0.9, y: height * 0.5 },
  };

  const nodes = [];
  let nid = 0;
  // A near-base cluster on each side, mirrored, sized by the planet's yield.
  // x is drawn independently per side (matching the original generator), y
  // spreads the clusters down the map. All in fractions of the scaled dims.
  Object.entries(planet.deposits).forEach(([com, yieldMult]) => {
    const clusters = Math.max(1, Math.round(yieldMult * 1.5));
    for (let i = 0; i < clusters; i++) {
      const t = (i + 1) / (clusters + 1);
      const y = height * 0.12 + t * height * 0.76;
      const amount = amountOf(600 * yieldMult);
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.2 + rng() * width * 0.1, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.8 - rng() * width * 0.1, y });
    }
  });

  // Build-critical minimums: any of ore/crystals/radioactives the surface
  // doesn't already offer near the player base gets a lean mirrored seam, so
  // every build is possible on every world. Checked (and added) in a fixed
  // order so the rng draw sequence — and thus the map — stays deterministic.
  // Placed before the caches so a hidden cache can never satisfy the check.
  const nearBase = width * NEAR_BASE_FRAC;
  for (const com of BUILD_CRITICAL) {
    const has = nodes.some(n => n.com === com &&
      Math.hypot(n.x - bases.player.x, n.y - bases.player.y) <= nearBase);
    if (has) continue;
    const y = height * (0.5 + GUARANTEE_Y[com]);
    const amount = amountOf(MIN_GUARANTEE[com]);
    nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.2 + rng() * width * 0.1, y });
    nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.8 - rng() * width * 0.1, y });
  }

  // A world can seed extra deposit clusters (helix's dense crystal belt),
  // mirrored per side, stacked around mid-map. Before resolveNodeOverlaps so
  // the newcomers get spread apart from the deposit-table nodes just the same.
  Object.entries(modifiers.extraClusters || {}).forEach(([com, extra]) => {
    for (let i = 0; i < extra; i++) {
      const y = height * 0.5 + (i - (extra - 1) / 2) * height * 0.12;
      const amount = amountOf(600 * (planet.deposits[com] || 1));
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.2 + rng() * width * 0.1, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: width * 0.8 - rng() * width * 0.1, y });
    }
  });

  // Hidden resource caches: extra deposits the survey missed, out in the
  // contested middle and along the vertical extremes, invisible until a unit
  // scouts their cell (fog.js's isNodeDiscovered). Fixed, mirrored fractional
  // positions — the find is gated by fog, not placement luck — and more of
  // them on bigger maps so exploring the larger space keeps paying off.
  const cacheAmount = amountOf(CACHE_BASE_AMOUNT);
  for (const [xf, yf, com, mirror] of cacheSpecs(sizeMult)) {
    // Per-match position jitter so cache spots aren't memorizable map knowledge:
    // each seed hides them somewhere a little different. A mirrored pair jitters
    // its anchor and reflects it (both sides stay equidistant — fair); a
    // centerline cache keeps x=0.5 and only shifts vertically. The jitter is
    // small and the anchors sit far from both bases, so a cache never lands in
    // reach of a start (map.test guards the >300 clearance).
    const jx = mirror ? (rng() - 0.5) * 0.08 : 0;   // ±4% of width; centerline stays centered
    const jy = (rng() - 0.5) * 0.10;                // ±5% of height
    const cx = width * (xf + jx), cy = height * (yf + jy);
    nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: cx, y: cy, hidden: true });
    if (mirror) nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: width - cx, y: cy, hidden: true });
  }

  resolveNodeOverlaps(nodes, width, height);
  // Index by id so the per-tick node lookups (gather, render, AI) are O(1)
  // instead of a linear .find over a node list that grows with map size. Nodes
  // are never added or removed after generation (they deplete in place), so the
  // Map stays valid for the whole match and holds live references.
  const nodesById = new Map(nodes.map(n => [n.id, n]));
  return { planet, width, height, bases, nodes, nodesById, modifiers };
}

// Hidden-cache placements as [xFrac, yFrac, commodity, mirror?]: mirror pairs
// the spot across the map's vertical centerline for fairness; a centerline
// spot (xFrac 0.5) is left single (equidistant from both bases). All sit clear
// of the base-side deposit clusters, out where you have to explore. Bigger
// maps add extra mirrored pairs tiling the wider middle, cycling commodities.
function cacheSpecs(sizeMult) {
  const specs = [
    [0.375, 0.20, "crystals", true],
    [0.375, 0.80, "radioactives", true],
    [0.4375, 0.50, "ore", true],
    [0.5, 0.15, "radioactives", false],
    [0.5, 0.85, "crystals", false],
  ];
  const coms = ["crystals", "radioactives", "ore"];
  let k = 0;
  for (let layer = 1; layer < sizeMult; layer++) {
    const xf = 0.30 + (layer / sizeMult) * 0.18;
    for (const yf of [0.30, 0.50, 0.70]) specs.push([xf, yf, coms[k++ % coms.length], true]);
  }
  return specs;
}

/* ---------- per-planet rule modifiers ---------- */

// Per-planet RTS-only combat/economy tweaks, keyed by planet id. These live
// engine-side (data.js is carried over verbatim from the turn-based game and
// stays pure flavor data) and get threaded into movement/fog/combat/production
// as `state.map.modifiers`. A world with no entry here plays by the defaults —
// which is why ferros/korrath/vesper (the original three) deliberately carry
// none, keeping their long-established sim behavior unchanged.
export const PLANET_MODIFIERS = {
  glacius: { speedMult: 0.9,                 label: "Frozen ground: all units 10% slower" },
  nimbus:  { sightMult: 0.75,                label: "Storm bands: sight and aggro ranges 25% shorter" },
  pyralis: { sightMult: 1.15,                label: "Open dunes: sight and aggro ranges 15% longer" },
  helix:   { extraClusters: { crystals: 1 }, label: "Dense belt: one extra crystal cluster per side" },
  oort:    { nodeAmountMult: 1.3,            label: "Rich frontier: deposits hold 30% more" },
  forge:   { buildTimeMult: 0.85,            label: "Factory world: construction and production 15% faster" },
};

// Each commodity picks its cluster spots independently, so two different
// deposit types can land on (or right next to) the same point — same
// stacking problem as units, just at generation time instead of every
// tick. A fixed number of relaxation passes nudges every overlapping pair
// apart regardless of what they are, until none are left (or the budget
// runs out on a pathological case rather than looping forever).
// Matches drawNodes' max render radius (7 + 9) in render.js. Exported
// because colliders.js treats it as the node's physical footprint too —
// what the map draws and what a building must keep clear of stay one number.
export const NODE_RADIUS = 16;
const RESOLVE_ITERATIONS = 40;

function resolveNodeOverlaps(nodes, width, height) {
  const minDist = NODE_RADIUS * 2;
  for (let iter = 0; iter < RESOLVE_ITERATIONS; iter++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);
        if (dist >= minDist) continue;
        moved = true;
        if (dist < 1e-4) { dx = 1; dy = 0; dist = 1; }
        const push = (minDist - dist) / 2;
        const nx = dx / dist, ny = dy / dist;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
      }
    }
    if (!moved) break;
  }
  for (const n of nodes) {
    n.x = Math.min(Math.max(n.x, 20), width - 20);
    n.y = Math.min(Math.max(n.y, 20), height - 20);
  }
}
