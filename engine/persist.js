/* ============================================================
   Save / load. Because the sim is deterministic and seed-driven (see
   engine/rng.js), a save doesn't need the whole world — the map (terrain,
   node positions) regenerates from the seed, so we persist only the seed +
   the DYNAMIC state: entities, economies, fog memory, and the AI's bookkeeping.
   The per-planet payload (serPlanet / rehydratePlanet) is shared by two savers:
   a single skirmish (serializeGame) and a whole Odyssey galaxy of N planets
   (serializeGalaxy), which additionally carries each world's market pressure,
   diplomacy stance, and colony flag, plus the galaxy meta (credits, active
   world, schedule counter). Round-trip and continue-identically are covered by
   test/persist.test.js and test/odyssey.test.js.
   ============================================================ */

"use strict";

import { generateMap } from "./map.js";
import { mulberry32 } from "./rng.js";
import { createFog, updateFog } from "./fog.js";
import { archetypeFor } from "./aiArchetypes.js";
import { peekEntityId, restoreEntityId } from "./state.js";
import { createMarket } from "./market.js";
import { createDiplomacy } from "./diplomacy.js";

export const SAVE_VERSION = 1;
export const GALAXY_SAVE_VERSION = 1;

function serPlayer(p) {
  return { id: p.id, faction: p.faction, isAI: p.isAI, color: p.color,
    resources: { ...p.resources }, upgrades: { ...p.upgrades } };
}

// The DYNAMIC per-planet payload — everything the seed can't regenerate. Shared by
// the skirmish save and every planet of a galaxy save. visible fog is NOT stored
// (recomputed on load); only `explored` (permanent scouted memory) persists. The
// global entity-id counter is NOT here — it's saved once by the caller.
function serPlanet(state) {
  return {
    seed: state.seed, planetId: state.planetId,
    sizeMult: state.sizeMult, resourceMult: state.resourceMult, endless: !!state.endless,
    time: state.time, tick: state.tick, over: state.over, winner: state.winner,
    players: { player: serPlayer(state.players.player), ai: serPlayer(state.players.ai) },
    units: [...state.units.values()],
    buildings: [...state.buildings.values()],
    nodes: state.map.nodes.map(n => ({ id: n.id, amount: n.amount })),
    fog: [...state.fog.explored],
    fogAI: [...state.fogAI.explored],
    ai: {
      aiThink: state.aiThink ?? 0, aiScoutId: state.aiScoutId ?? null,
      aiApm: state.aiApm ?? null, aiMicro: !!state.aiMicro,
      aiActionBudget: state.aiActionBudget ?? 0,
      aiAttackForce: state.aiAttackForce ?? 0, aiAttackDesperate: !!state.aiAttackDesperate,
      aiNextAttackAt: state.aiNextAttackAt ?? null, aiUnitsBuilt: state.aiUnitsBuilt ?? 0,
      // Odyssey offense cadence (engine/ai.js) — a scheduled future time. Must be
      // persisted or a reloaded hostile world fires its next probe a full cadence
      // early (undefined ?? 0 ⇒ immediately wave-ready), breaking continue-identically.
      aiNextWaveAt: state.aiNextWaveAt ?? null,
    },
  };
}

// Rebuild a single engine state from a per-planet payload: regenerate the
// deterministic map from the seed, overlay saved node amounts by id, restore
// entities/economies/AI bookkeeping, and recompute current visibility. Does NOT
// touch the global entity-id counter (the caller restores it once, last).
function rehydratePlanet(P) {
  const map = generateMap(P.planetId, mulberry32((P.seed ?? 0) >>> 0),
    { sizeMult: P.sizeMult, resourceMult: P.resourceMult });
  const amounts = new Map(P.nodes.map(n => [n.id, n.amount]));
  for (const n of map.nodes) if (amounts.has(n.id)) n.amount = amounts.get(n.id);

  const fog = createFog(map); fog.explored = Uint8Array.from(P.fog);
  const fogAI = createFog(map); fogAI.explored = Uint8Array.from(P.fogAI);

  const state = {
    time: P.time, tick: P.tick, over: P.over, winner: P.winner,
    seed: P.seed, planetId: P.planetId, sizeMult: P.sizeMult, resourceMult: P.resourceMult,
    endless: !!P.endless,
    map,
    players: { player: P.players.player, ai: P.players.ai },
    units: new Map(P.units.map(u => [u.id, u])),
    buildings: new Map(P.buildings.map(b => [b.id, b])),
    selection: [],
    fog, fogAI,
    aiScoutId: P.ai.aiScoutId, aiThink: P.ai.aiThink,
    aiApm: P.ai.aiApm, aiMicro: P.ai.aiMicro,
    aiActionBudget: P.ai.aiActionBudget,
    aiAttackForce: P.ai.aiAttackForce, aiAttackDesperate: P.ai.aiAttackDesperate,
    aiNextAttackAt: P.ai.aiNextAttackAt, aiUnitsBuilt: P.ai.aiUnitsBuilt,
    aiNextWaveAt: P.ai.aiNextWaveAt ?? undefined,
    aiArchetype: archetypeFor(P.planetId),
    events: [],
  };
  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}

/* ---------- single skirmish ---------- */

// A plain, JSON-safe, DETACHED snapshot (deep-copied via stringify/parse, so
// ticking the live game on after a save doesn't mutate it out from under the
// caller). Callers JSON.stringify it to localStorage or a file.
export function serializeGame(state) {
  return JSON.parse(JSON.stringify({ v: SAVE_VERSION, nextEntityId: peekEntityId(), ...serPlanet(state) }));
}

export function deserializeGame(input) {
  const save = JSON.parse(JSON.stringify(input));   // detach + normalise
  if (save.v !== SAVE_VERSION) throw new Error(`unsupported save version ${save.v}`);
  const state = rehydratePlanet(save);
  restoreEntityId(save.nextEntityId);
  return state;
}

/* ---------- whole Odyssey galaxy ---------- */

export function serializeGalaxy(galaxy) {
  return JSON.parse(JSON.stringify({
    v: GALAXY_SAVE_VERSION,
    seed: galaxy.seed, credits: galaxy.credits, activeId: galaxy.activeId, worlds: galaxy.worlds,
    settings: galaxy.settings,
    entitySeq: galaxy.entitySeq ?? 0, galaxyTick: galaxy.tick ?? 0,
    pacified: [...(galaxy.pacified || [])], wonBy: galaxy.wonBy ?? null,   // Domination win progress (additive; old saves default to none)
    nextEntityId: peekEntityId(),                 // the ONE global entity counter, saved once
    planets: [...galaxy.planets.values()].map(state => ({
      ...serPlanet(state),
      background: !!state.background,
      market: { pressure: { ...state.market.pressure } },
      diplomacy: { ...state.diplomacy },          // stance, depletion, lastAiUnits
    })),
  }));
}

export function deserializeGalaxy(input) {
  const save = JSON.parse(JSON.stringify(input));
  if (save.v !== GALAXY_SAVE_VERSION) throw new Error(`unsupported galaxy save version ${save.v}`);

  const galaxy = {
    seed: save.seed, credits: save.credits, activeId: save.activeId, worlds: save.worlds,
    planets: new Map(), settings: save.settings,
    tick: save.galaxyTick ?? 0, entitySeq: save.entitySeq ?? 0,
    colonyNotes: new Map(),   // transient UI bookkeeping — re-derived, never persisted
    pacified: new Set(save.pacified || []), pacifyNotes: [], wonBy: save.wonBy ?? null,
  };
  for (const P of save.planets) {
    const state = rehydratePlanet(P);
    state.market = createMarket(state);                    // base recomputed from the (regenerated) nodes...
    Object.assign(state.market.pressure, P.market.pressure); // ...then overlay the saved running pressure
    state.diplomacy = { ...createDiplomacy(), ...P.diplomacy };
    state.background = !!P.background;
    galaxy.planets.set(P.planetId, state);
  }
  const active = galaxy.planets.get(galaxy.activeId);
  if (active) active.background = false;                    // the seat is never a background world
  restoreEntityId(save.nextEntityId);                       // last: after all rehydration, so future mints continue past every id
  return galaxy;
}
