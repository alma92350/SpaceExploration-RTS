/* ============================================================
   Save / load. Because the sim is deterministic and seed-driven (see
   engine/rng.js), a save doesn't need the whole world — the map (terrain,
   node positions) regenerates from the seed, so we persist only the seed +
   the DYNAMIC state: entities, economies, fog memory, and the AI's bookkeeping.
   deserializeGame rebuilds a state that ticks on exactly where it was saved
   (round-trip and continue-identically are covered by test/persist.test.js).
   ============================================================ */

"use strict";

import { generateMap } from "./map.js";
import { mulberry32 } from "./rng.js";
import { createFog, updateFog } from "./fog.js";
import { archetypeFor } from "./aiArchetypes.js";
import { peekEntityId, restoreEntityId } from "./state.js";

export const SAVE_VERSION = 1;

function serPlayer(p) {
  return { id: p.id, faction: p.faction, isAI: p.isAI, color: p.color,
    resources: { ...p.resources }, upgrades: { ...p.upgrades } };
}

// A plain, JSON-safe, DETACHED snapshot (deep-copied, so ticking the live game on
// after a save doesn't mutate it out from under the caller). Callers JSON.stringify
// it to localStorage or a file. visible fog is NOT stored — it's recomputed from
// the loaded entities on load; only `explored` (permanent scouted memory) persists.
export function serializeGame(state) {
  return JSON.parse(JSON.stringify({
    v: SAVE_VERSION,
    seed: state.seed, planetId: state.planetId,
    sizeMult: state.sizeMult, resourceMult: state.resourceMult,
    time: state.time, tick: state.tick, over: state.over, winner: state.winner,
    nextEntityId: peekEntityId(),
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
    },
  }));
}

export function deserializeGame(input) {
  // Normalise to detached plain data (a live serializeGame() output would still
  // share entity references otherwise) and guard the format version.
  const save = JSON.parse(JSON.stringify(input));
  if (save.v !== SAVE_VERSION) throw new Error(`unsupported save version ${save.v}`);

  // Regenerate the deterministic map from the seed, then overlay the saved
  // (dynamic) node amounts by id — positions/terrain are reproduced exactly.
  const map = generateMap(save.planetId, mulberry32((save.seed ?? 0) >>> 0),
    { sizeMult: save.sizeMult, resourceMult: save.resourceMult });
  const amounts = new Map(save.nodes.map(n => [n.id, n.amount]));
  for (const n of map.nodes) if (amounts.has(n.id)) n.amount = amounts.get(n.id);

  const fog = createFog(map); fog.explored = Uint8Array.from(save.fog);
  const fogAI = createFog(map); fogAI.explored = Uint8Array.from(save.fogAI);

  const state = {
    time: save.time, tick: save.tick, over: save.over, winner: save.winner,
    seed: save.seed, planetId: save.planetId, sizeMult: save.sizeMult, resourceMult: save.resourceMult,
    map,
    players: { player: save.players.player, ai: save.players.ai },
    units: new Map(save.units.map(u => [u.id, u])),
    buildings: new Map(save.buildings.map(b => [b.id, b])),
    selection: [],
    fog, fogAI,
    aiScoutId: save.ai.aiScoutId, aiThink: save.ai.aiThink,
    aiApm: save.ai.aiApm, aiMicro: save.ai.aiMicro,
    aiActionBudget: save.ai.aiActionBudget,
    aiAttackForce: save.ai.aiAttackForce, aiAttackDesperate: save.ai.aiAttackDesperate,
    aiNextAttackAt: save.ai.aiNextAttackAt, aiUnitsBuilt: save.ai.aiUnitsBuilt,
    aiArchetype: archetypeFor(save.planetId),
    events: [],
  };
  restoreEntityId(save.nextEntityId);
  // Recompute current visibility from the loaded entities so the first rendered
  // frame (and the AI's very next think) sees correctly right away.
  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}
