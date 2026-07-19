/* ============================================================
   The Odyssey galaxy — the open-world meta-layer over the per-planet sim. A
   galaxy holds one engine game state per planet (each a normal createGameState);
   one is "active" (rendered + controlled by the player), and — from Phase 2 on —
   the rest keep evolving in the background. The player has a single, relocatable
   Command Center: their capital seat travels with them via a Spaceport, and a
   world they leave stays theirs, tended on autopilot.

   Phase 1 stands up the structure with a single planet: the player settles a
   random world, develops endlessly (no victory, no clock — see the `endless`
   flag on each state), and can only ever hold one Command Center. Credits and
   the multi-planet map / jump machinery live here so the later phases slot in
   without touching the per-planet engine.

   Determinism: the start world and every planet's map are derived from the
   galaxy seed, so the same seed replays the same galaxy — same guarantee as the
   skirmish sim.
   ============================================================ */

"use strict";

import { createGameState } from "./state.js";
import { mulberry32 } from "./rng.js";
import { PLANET_ARCHETYPE, archetypeFor } from "./aiArchetypes.js";

// The worlds an Odyssey can settle — the same curated roster the skirmish picker
// and the scenarios draw from (one entry per AI archetype).
export const ODYSSEY_WORLDS = Object.keys(PLANET_ARCHETYPE);

// A stable per-planet seed derived from the galaxy seed + the world id, so every
// world generates its own deterministic map and two galaxies with the same seed
// are byte-identical.
function planetSeed(seed, planetId) {
  let h = seed >>> 0;
  for (let i = 0; i < planetId.length; i++) h = (Math.imul(h ^ planetId.charCodeAt(i), 0x01000193)) >>> 0;
  return h >>> 0;
}

// Create an Odyssey galaxy. Phase 1: a single active planet (the player's
// randomly-chosen starting world) plus the meta-fields (credits, activeId, the
// world roster) the later phases grow into.
export function createGalaxy({ seed = 1, difficulty = "medium", sizeMult = 1,
  resourceMult = 1, playerFaction = "frontier", aiApm, aiMicro } = {}) {
  seed = seed >>> 0;
  const pick = mulberry32(seed);
  const startId = ODYSSEY_WORLDS[Math.floor(pick() * ODYSSEY_WORLDS.length)];

  const galaxy = {
    seed,
    credits: 0,                 // universal credits — galaxy-wide, transportable (Phase 3 spends them)
    activeId: startId,          // the world the player is currently on
    homeId: startId,            // where the Odyssey began
    worlds: ODYSSEY_WORLDS.slice(),
    planets: new Map(),         // planetId -> engine game state
    settings: { difficulty, sizeMult, resourceMult, playerFaction, aiApm, aiMicro },
  };
  addPlanet(galaxy, startId);
  return galaxy;
}

// Build (or rebuild) a planet's engine state into the galaxy. Reuses the exact
// skirmish scaffold — economy, both players' bases, fog — but flagged `endless`
// so it never resolves by conquest or clock (see engine/victory.js).
export function addPlanet(galaxy, planetId) {
  const s = galaxy.settings;
  const seed = planetSeed(galaxy.seed, planetId);
  const aiFaction = archetypeFor(planetId).faction || "neutral";
  const state = createGameState({
    planetId, seed, rng: mulberry32(seed),
    aiApm: s.aiApm, aiMicro: s.aiMicro, sizeMult: s.sizeMult, resourceMult: s.resourceMult,
    playerFaction: s.playerFaction, aiFaction, endless: true,
  });
  galaxy.planets.set(planetId, state);
  return state;
}

// The game state the player is currently on — what boot.js renders and drives.
export function activeState(galaxy) {
  return galaxy.planets.get(galaxy.activeId);
}
