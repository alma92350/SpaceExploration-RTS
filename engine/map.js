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

// A guaranteed ore cluster right on the doorstep of each Command Center, at a
// FIXED absolute distance regardless of map size. The deposit clusters sit at
// fractions of the map width, so on a Gigantic (4x) map they drift far from the
// base and the opening economy crawls. These home nodes never move: whatever the
// map size, every base opens onto ore it can reach in seconds — enough to fund a
// second Command Center (400 ore) and push out toward the contested deposits and
// the enemy. Offsets face the map interior (mirrored for the AI) so they never
// fall off the edge, and carry NO rng draw, so the deposit/cache layout and map
// determinism are byte-for-byte untouched. Flagged `home` so the deposit-count
// tests can tell them apart from the surface deposit table.
const HOME_ORE_AMOUNT = 350;                       // per node; 3 nodes ⇒ ~1050 ore on the doorstep
const HOME_ORE_OFFSETS = [                          // absolute px from the base, interior-facing
  { dx: 130, dy: -95 },
  { dx: 165, dy: 0 },
  { dx: 130, dy: 95 },
];

/* ---------- terrain ---------- */

// A coarse per-cell terrain field (a flat Uint8Array of type codes, same idiom
// as the fog grid), sampled O(1) by movement/fog/combat/colliders. Deliberately
// NOT impassable — a slow cell still has speed > 0, so no unit can ever be
// trapped (the engine has no pathfinding) and a wave can never deadlock. Rough
// fields flanking an open lane read as a soft choke; high ground is a strong
// point worth holding. Terrain is static for the whole match and drawn from
// fixed fractional specs, so it consumes ZERO rng draws — map determinism and
// the byte-identical node layout are untouched.
export const TERRAIN_CELL_SIZE = 40;   // aligned with FOG_CELL_SIZE so a future LOS pass can share cell coords
export const TERRAIN = {
  0: { name: "open",  speedMult: 1,   sightMult: 1,    buildable: true,  combatMult: 1 },
  1: { name: "rough", speedMult: 0.6, sightMult: 1,    buildable: false, combatMult: 1 },     // slow, unbuildable field
  2: { name: "high",  speedMult: 1,   sightMult: 1.25, buildable: true,  combatMult: 1.15 },  // high ground: sees + hits farther/harder
};

// Feature specs are [xFrac, yFrac, wFrac, hFrac, code, mirror?] — a rectangular
// blob centred at (xFrac,yFrac) in fractions of the scaled map, stamped into the
// grid. `mirror` reflects it across the vertical centreline for fairness (both
// sides face the same ground). Scales self-similarly with sizeMult.
function generateTerrain(width, height, specs) {
  const cols = Math.ceil(width / TERRAIN_CELL_SIZE);
  const rows = Math.ceil(height / TERRAIN_CELL_SIZE);
  const type = new Uint8Array(cols * rows);   // 0 = open everywhere by default
  const stamp = (xf, yf, wf, hf, code) => {
    const cx0 = Math.floor(((xf - wf / 2) * width) / TERRAIN_CELL_SIZE);
    const cx1 = Math.floor(((xf + wf / 2) * width) / TERRAIN_CELL_SIZE);
    const cy0 = Math.floor(((yf - hf / 2) * height) / TERRAIN_CELL_SIZE);
    const cy1 = Math.floor(((yf + hf / 2) * height) / TERRAIN_CELL_SIZE);
    for (let gy = Math.max(0, cy0); gy <= Math.min(rows - 1, cy1); gy++)
      for (let gx = Math.max(0, cx0); gx <= Math.min(cols - 1, cx1); gx++)
        type[gy * cols + gx] = code;
  };
  for (const [xf, yf, wf, hf, code, mirror] of specs) {
    stamp(xf, yf, wf, hf, code);
    if (mirror) stamp(1 - xf, yf, wf, hf, code);
  }
  return { cols, rows, cell: TERRAIN_CELL_SIZE, type };
}

// A world modifier as seen by ONE side. Most worlds tilt both sides equally
// (a plain `modifiers[key]`), but a world may carry an `asym: { player, ai }`
// block that overrides a key for just one owner — an asymmetric matchup where
// the two starts differ. Lookup order: the owner's asym override, then the
// shared modifier, then the default. Owner-less / map-less test stubs read the
// shared value (or the default), so existing symmetric behaviour is unchanged.
export function sideMod(state, owner, key, dflt = 1) {
  const m = state && state.map && state.map.modifiers;
  if (!m) return dflt;
  const a = m.asym && m.asym[owner];
  if (a && a[key] != null) return a[key];
  return m[key] ?? dflt;
}

// The TERRAIN entry at a world point. Returns OPEN for a missing grid or an
// out-of-bounds point, so every consumer degrades to "no terrain effect"
// safely (map-less test stubs, off-map coords).
export function sampleTerrain(terrain, x, y) {
  if (!terrain) return TERRAIN[0];
  const gx = Math.floor(x / terrain.cell), gy = Math.floor(y / terrain.cell);
  if (gx < 0 || gy < 0 || gx >= terrain.cols || gy >= terrain.rows) return TERRAIN[0];
  return TERRAIN[terrain.type[gy * terrain.cols + gx]] || TERRAIN[0];
}

export function generateMap(planetId = "ferros", rng = Math.random, opts = {}) {   // deterministic-exempt: unseeded default rng
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

  // Home ore, on every base's doorstep at a fixed absolute distance (see
  // HOME_ORE_OFFSETS). Fractional offsets from each base, mirrored across the
  // centreline so both starts open onto the same head start. No rng — added
  // before the rng-driven clusters so the draw sequence, and thus the rest of
  // the map, is untouched. `home` marks them out from the deposit table.
  const homeAmount = amountOf(HOME_ORE_AMOUNT);
  for (const { dx, dy } of HOME_ORE_OFFSETS) {
    nodes.push({ id: `n${nid++}`, com: "ore", amount: homeAmount, max: homeAmount,
      x: bases.player.x + dx, y: bases.player.y + dy, home: true });
    nodes.push({ id: `n${nid++}`, com: "ore", amount: homeAmount, max: homeAmount,
      x: bases.ai.x - dx, y: bases.ai.y + dy, home: true });
  }

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
    // Home ore is excluded here so the seam logic is exactly as it always was:
    // the deposit table alone decides whether a world needs a guaranteed seam,
    // keeping the rng draw sequence and node layout byte-identical.
    const has = nodes.some(n => n.com === com && !n.home &&
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
  // Static terrain field from this world's fixed specs (none ⇒ an all-open
  // grid). Built after nodes, consumes no rng — determinism unaffected.
  const terrain = generateTerrain(width, height, modifiers.terrain || []);
  return { planet, width, height, bases, nodes, nodesById, terrain, modifiers };
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
  // `terrain` (optional) is a list of feature specs (see generateTerrain):
  // [xFrac, yFrac, wFrac, hFrac, code, mirror?], code 1=rough, 2=high ground.
  glacius: {
    speedMult: 0.9, label: "Frozen ground: all units 10% slower; ice fields flank a central lane",
    // Rough ice fields top and bottom of the midline pinch armies through an
    // open central corridor — a soft choke on top of the world's global slow.
    terrain: [[0.5, 0.13, 0.34, 0.2, 1, false], [0.5, 0.87, 0.34, 0.2, 1, false]],
  },
  nimbus:  {
    sightMult: 0.75, label: "Storm front (asymmetric): your skies are clearer; the enemy surges out of the murk",
    // On a short-sight world, high ground (which extends sight) is doubly worth
    // taking — a way to see over the storm. Two vantages, north and south of
    // the midline, kept off the centre so neither base overlooks the field.
    terrain: [[0.5, 0.28, 0.12, 0.14, 2, false], [0.5, 0.72, 0.12, 0.14, 2, false]],
    // Asymmetric matchup: the storm has half-cleared YOUR side (you see almost
    // normally, 0.95 vs the enemy's 0.75), but the enemy strikes fast out of it
    // (units 12% quicker). You out-scout; they out-tempo.
    asym: { player: { sightMult: 0.95 }, ai: { speedMult: 1.12 } },
  },
  pyralis: {
    sightMult: 1.15, label: "Open dunes: long sightlines, and a central mesa worth holding",
    // High-ground mesa in the contested middle: extra sight and a damage edge
    // for whoever seizes it — a real objective on an otherwise open field.
    terrain: [[0.5, 0.5, 0.16, 0.26, 2, false]],
  },
  helix:   {
    extraClusters: { crystals: 1 }, label: "Dense belt: an extra crystal field per side, and a central ridge to hold",
    // A crystalline high-ground ridge down the centreline — the contested spine
    // of the belt, giving sight and a combat edge to whoever seizes the middle.
    terrain: [[0.5, 0.5, 0.1, 0.38, 2, false]],
  },
  oort:    {
    nodeAmountMult: 1.3, label: "Contested frontier (asymmetric): your claim is richer; the enemy's foundry runs hotter",
    // Rugged rough ground on the flanks funnels the fight through the open
    // centre — the price of the world's rich but broken frontier.
    terrain: [[0.4, 0.28, 0.12, 0.18, 1, true], [0.4, 0.72, 0.12, 0.18, 1, true]],
    // Asymmetric matchup: YOUR claim struck a rich vein (every haul banks 20%
    // more), while the enemy's forward base is a war factory (18% faster
    // construction and production). You out-mine; they out-build.
    asym: { player: { gatherMult: 1.2 }, ai: { buildTimeMult: 0.82 } },
  },
  forge:   {
    buildTimeMult: 0.85, label: "Factory world: 15% faster construction; rough industrial sprawl midfield",
    // Scattered rough ground on the approach makes the flanks slow going and
    // the direct centre the fast lane.
    terrain: [[0.4, 0.32, 0.13, 0.18, 1, true], [0.4, 0.68, 0.13, 0.18, 1, true]],
  },
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
