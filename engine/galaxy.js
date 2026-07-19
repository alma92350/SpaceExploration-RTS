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
import { updateFog } from "./fog.js";
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

// Units staged within this radius of a Spaceport ride along with the capital on
// a jump — you assemble your expedition at the pad, then launch.
export const JUMP_LOAD_RADIUS = 150;

// Build (or rebuild) a planet's engine state into the galaxy. Reuses the exact
// skirmish scaffold — economy, both players' bases, fog — but flagged `endless`
// so it never resolves by conquest or clock (see engine/victory.js).
//
// `unsettled` strips the auto-seeded player presence: a jump DESTINATION you
// haven't settled yet has only its neighbour — your capital + forces arrive via
// the jump, not from map generation.
export function addPlanet(galaxy, planetId, { unsettled = false } = {}) {
  const s = galaxy.settings;
  const seed = planetSeed(galaxy.seed, planetId);
  const aiFaction = archetypeFor(planetId).faction || "neutral";
  const state = createGameState({
    planetId, seed, rng: mulberry32(seed),
    aiApm: s.aiApm, aiMicro: s.aiMicro, sizeMult: s.sizeMult, resourceMult: s.resourceMult,
    playerFaction: s.playerFaction, aiFaction, endless: true,
  });
  if (unsettled) {
    for (const [id, u] of [...state.units]) if (u.owner === "player") state.units.delete(id);
    for (const [id, b] of [...state.buildings]) if (b.owner === "player") state.buildings.delete(id);
    state.background = true;   // not the active seat until you land here
    updateFog(state, state.fog, "player");
  }
  galaxy.planets.set(planetId, state);
  return state;
}

// The game state the player is currently on — what boot.js renders and drives.
export function activeState(galaxy) {
  return galaxy.planets.get(galaxy.activeId);
}

// Can the player launch a jump from this world? — a completed player Spaceport.
export function canJump(state) {
  for (const b of state.buildings.values())
    if (b.owner === "player" && b.type === "spaceport" && !b.constructing) return true;
  return false;
}

// Relocate the capital to `destId`: the Command Center plus every player unit
// staged near the Spaceport move to the destination's landing zone; the origin
// keeps its other buildings and units and becomes a background colony that goes
// on evolving. Creates the destination (unsettled) on first visit. Returns a
// small summary, or null if the jump can't run (no Spaceport, or same world).
export function jumpCapital(galaxy, destId) {
  const from = activeState(galaxy);
  const spaceport = [...from.buildings.values()]
    .find(b => b.owner === "player" && b.type === "spaceport" && !b.constructing);
  if (!spaceport || destId === galaxy.activeId) return null;

  const dest = galaxy.planets.get(destId) || addPlanet(galaxy, destId, { unsettled: true });
  const lz = dest.map.bases.player;
  const nextId = () => "g" + (galaxy.entitySeq = (galaxy.entitySeq || 0) + 1);   // fresh ids: no cross-state collision

  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const riders = [...from.units.values()].filter(u => u.owner === "player"
    && Math.hypot(u.x - spaceport.x, u.y - spaceport.y) <= JUMP_LOAD_RADIUS);

  if (cc) {
    from.buildings.delete(cc.id);
    cc.id = nextId(); cc.x = lz.x; cc.y = lz.y; cc.rally = { x: lz.x + 60, y: lz.y + 60 };
    dest.buildings.set(cc.id, cc);
  }
  riders.forEach((u, i) => {
    from.units.delete(u.id);
    const a = (i / Math.max(1, riders.length)) * Math.PI * 2, ring = 46 + (i % 3) * 18;
    u.id = nextId(); u.x = lz.x + Math.cos(a) * ring; u.y = lz.y + Math.sin(a) * ring;
    u.order = null; u.orderQueue = [];
    dest.units.set(u.id, u);
  });

  from.selection = []; dest.selection = [];
  from.background = true;    // the world you left keeps evolving on its own
  dest.background = false;   // the destination is now your active seat
  galaxy.activeId = destId;
  updateFog(dest, dest.fog, "player");
  updateFog(dest, dest.fogAI, "ai");
  updateFog(from, from.fog, "player");
  return { destId, riders: riders.length };
}
