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

export function generateMap(planetId = "ferros", rng = Math.random) {
  const planet = PLANETS.find(p => p.id === planetId);
  if (!planet) throw new Error(`Unknown planet: ${planetId}`);

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
      const amount = Math.round(600 * yieldMult);
      // One cluster near each base, mirrored left/right, so both sides
      // start with comparable access to every deposit type on the map.
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: 320 + rng() * 160, y });
      nodes.push({ id: `n${nid++}`, com, amount, max: amount, x: MAP_WIDTH - 320 - rng() * 160, y });
    }
  });

  resolveNodeOverlaps(nodes);
  return { planet, width: MAP_WIDTH, height: MAP_HEIGHT, bases, nodes };
}

// Each commodity picks its cluster spots independently, so two different
// deposit types can land on (or right next to) the same point — same
// stacking problem as units, just at generation time instead of every
// tick. A fixed number of relaxation passes nudges every overlapping pair
// apart regardless of what they are, until none are left (or the budget
// runs out on a pathological case rather than looping forever).
const NODE_VISUAL_RADIUS = 16;   // matches drawNodes' max render radius (7 + 9) in render.js
const RESOLVE_ITERATIONS = 40;

function resolveNodeOverlaps(nodes) {
  const minDist = NODE_VISUAL_RADIUS * 2;
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
