/* ============================================================
   Skirmish map generation.
   Picks one charted world from data.js and scatters resource nodes
   mirrored across the map, sized by that world's own deposit yields —
   so which planet you fight over changes what the map plays like.
   ============================================================ */

"use strict";

import { PLANETS } from "../data.js";

export const MAP_WIDTH = 1600;
export const MAP_HEIGHT = 1000;

const ORE_GUARANTEE_RADIUS = 500;   // never triggers on a planet whose deposit table already yields ore
const GUARANTEED_ORE_AMOUNT = 480;  // a lean seam (0.8x the 600 baseline)

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

export function generateMap(planetId = "ferros", rng = Math.random) {
  const planet = PLANETS.find(p => p.id === planetId);
  if (!planet) throw new Error(`Unknown planet: ${planetId}`);
  const modifiers = PLANET_MODIFIERS[planetId] || {};

  const bases = {
    player: { x: 160, y: MAP_HEIGHT / 2 },
    ai: { x: MAP_WIDTH - 160, y: MAP_HEIGHT / 2 },
  };

  const nodes = [];
  let nid = 0;
  Object.entries(planet.deposits).forEach(([com, yieldMult]) => {
    const clusters = Math.max(1, Math.round(yieldMult * 1.5));
    for (let i = 0; i < clusters; i++) {
      const t = (i + 1) / (clusters + 1);
      const y = 120 + t * (MAP_HEIGHT - 240);
      const amount = Math.round(600 * yieldMult * (modifiers.nodeAmountMult || 1));
      // One cluster near each base, mirrored left/right, so both sides
      // start with comparable access to every deposit type on the map.
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: 320 + rng() * 160, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: MAP_WIDTH - 320 - rng() * 160, y });
    }
  });

  // Every unit costs ore, but several charted worlds deposit none — a map
  // without ore is unwinnable no matter what the planet's economy says.
  // Guarantee one lean ore cluster near each base; the deposit table
  // still shapes everything else. The seam honors nodeAmountMult too, so a
  // "richer deposits" world's label stays true even for the guaranteed ore.
  const nearPlayerOre = nodes.some(n => n.com === "ore" &&
    Math.hypot(n.x - bases.player.x, n.y - bases.player.y) <= ORE_GUARANTEE_RADIUS);
  if (!nearPlayerOre) {
    const y = MAP_HEIGHT / 2;
    const amount = Math.round(GUARANTEED_ORE_AMOUNT * (modifiers.nodeAmountMult || 1));
    nodes.push({ id: `n${nid++}`, com: "ore", amount, max: amount, x: 320 + rng() * 160, y });
    nodes.push({ id: `n${nid++}`, com: "ore", amount, max: amount, x: MAP_WIDTH - 320 - rng() * 160, y });
  }

  // A world can seed extra deposit clusters (helix's dense crystal belt),
  // mirrored per side like everything else, stacked vertically around
  // mid-map. Pushed before resolveNodeOverlaps so the newcomers get spread
  // apart from the deposit-table nodes just the same.
  Object.entries(modifiers.extraClusters || {}).forEach(([com, extra]) => {
    for (let i = 0; i < extra; i++) {
      const y = MAP_HEIGHT / 2 + (i - (extra - 1) / 2) * 120;
      const amount = Math.round(600 * (planet.deposits[com] || 1) * (modifiers.nodeAmountMult || 1));
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: 320 + rng() * 160, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: MAP_WIDTH - 320 - rng() * 160, y });
    }
  });

  // Hidden resource caches: extra deposits the initial survey missed, out in
  // the contested middle and along the vertical extremes, well away from
  // either base. They stay invisible until a unit scouts their cell — the
  // fog's permanent "explored" memory is the discovery record (see fog.js's
  // isNodeDiscovered), so pushing out to explore is rewarded with resources,
  // often the crystals or radioactives a world's surface deposits lack. Added
  // AFTER the ore guarantee (so a hidden cache can never satisfy it and rob a
  // no-ore world of its near-base seam) and before resolveNodeOverlaps, so
  // they get spread apart like everything else. Fixed positions — the find is
  // gated by fog, not by placement luck — mirrored left/right for fairness.
  const cacheAmount = Math.round(CACHE_BASE_AMOUNT * (modifiers.nodeAmountMult || 1));
  for (const [cx, cy, com, mirror] of HIDDEN_CACHES) {
    nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: cx, y: cy, hidden: true });
    if (mirror) nodes.push({ id: `n${nid++}`, com, amount: cacheAmount, max: cacheAmount, x: MAP_WIDTH - cx, y: cy, hidden: true });
  }

  resolveNodeOverlaps(nodes);
  return { planet, width: MAP_WIDTH, height: MAP_HEIGHT, bases, nodes, modifiers };
}

// Scattered hidden caches, the same on every world (the reward for scouting is
// baked in regardless of the planet's surface economy). [x, y, commodity,
// mirror?]: mirror pairs the spot across the map's vertical centerline for
// fairness; centerline spots (x = MAP_WIDTH/2) are left single (equidistant
// from both bases). All sit clear of the base-side deposit clusters (~x 320-480
// and 1120-1280), out where you have to explore to find them.
const CACHE_BASE_AMOUNT = 360;   // ~0.6x a normal 600 cluster — a real bonus, not a second economy
const HIDDEN_CACHES = [
  [600, 200, "crystals",     true],   // upper flanks
  [600, 800, "radioactives", true],   // lower flanks
  [700, 500, "ore",          true],   // the contested centre lane
  [800, 150, "radioactives", false],  // top centre, equidistant
  [800, 850, "crystals",     false],  // bottom centre, equidistant
];

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

function resolveNodeOverlaps(nodes) {
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
    n.x = Math.min(Math.max(n.x, 20), MAP_WIDTH - 20);
    n.y = Math.min(Math.max(n.y, 20), MAP_HEIGHT - 20);
  }
}
