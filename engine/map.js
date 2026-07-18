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

  return { planet, width: MAP_WIDTH, height: MAP_HEIGHT, bases, nodes };
}
