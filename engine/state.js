/* ============================================================
   Game state: the mutable simulation world. No rendering, no input,
   no DOM — engine/sim.js mutates this each fixed tick, render.js only
   reads it.
   ============================================================ */

"use strict";

import { generateMap } from "./map.js";
import { BUILDINGS, UNITS } from "./entities.js";
import { createFog, updateFog } from "./fog.js";
import { archetypeFor } from "./aiArchetypes.js";

// Entity-id counter. Reset to 1 at the start of every createGameState (below)
// so a fresh game is a pure function of its seed: two same-seed runs mint the
// same ids, and since ids feed the deterministic tie-breaks in movement /
// separation / gather, the whole sim replays identically. IDs are only ever
// compared within one state's own Maps, so two live games sharing id strings
// is harmless.
let nextEntityId = 1;
function newId(prefix) { return `${prefix}${nextEntityId++}`; }

// Save/load (engine/persist.js) needs to snapshot and restore the id counter so a
// loaded game keeps minting fresh, non-colliding ids from where it left off.
export function peekEntityId() { return nextEntityId; }
export function restoreEntityId(n) { nextEntityId = n; }

export function makeUnit(type, owner, x, y) {
  const def = UNITS[type];
  return {
    kind: "unit", id: newId("u"), type, owner,
    x, y, hp: def.hp, maxHp: def.hp,
    order: null,          // { type: 'move'|'gather'|'attack'|'attack-move'|'build', ... } — the active order
    orderQueue: [],       // queued waypoints (Ctrl+command); sim.js pulls the next in whenever `order` clears
    cargo: def.role === "worker" ? { com: null, qty: 0 } : null,
    attackTimer: 0,
    autoTarget: null,     // sticky auto-acquired target id (combat.js) — commit to a foe, don't re-dogpile the nearest each tick
  };
}

export function makeBuilding(type, owner, x, y, opts = {}) {
  const def = BUILDINGS[type];
  return {
    kind: "building", id: newId("b"), type, owner,
    x, y, radius: def.radius, hp: opts.hp ?? def.hp, maxHp: def.hp,
    constructing: !!opts.constructing, buildProgress: opts.constructing ? 0 : 1,
    queue: [],             // [{ unitType, progress }]
    attackTimer: 0,        // combat.js decrements this for buildings with an attack stat (turret)
    targetId: null,        // current auto-acquired target; render.js reads it to aim the turret barrel
    rally: { x: x + 60, y: y + 60 },
  };
}

export function createGameState(opts = {}) {
  nextEntityId = 1;   // fresh game -> deterministic ids from the seed (see newId above)
  const planetId = opts.planetId || "ferros";
  // The one sanctioned fallback: an UNSEEDED caller (a direct test, or a call
  // that predates seeding) uses the platform PRNG for map generation only.
  // Production always passes a seeded rng (see main.js), so this branch never
  // runs in a real match — the engine-purity guard whitelists the marked line.
  const map = generateMap(planetId, opts.rng || Math.random, {   // deterministic-exempt: unseeded default rng
    sizeMult: opts.sizeMult || 1,
    resourceMult: opts.resourceMult || 1,
  });

  const state = {
    time: 0,
    tick: 0,
    over: false,
    winner: null,
    seed: opts.seed ?? null,   // the match seed, if one was supplied — reproduces this whole game
    // The generation inputs, kept so a save can regenerate the (deterministic)
    // map from the seed instead of serialising the whole terrain/node table.
    planetId,
    sizeMult: opts.sizeMult || 1,
    resourceMult: opts.resourceMult || 1,
    map,
    players: {
      // Faction is a passive-trait bundle (engine/factions.js). It defaults to
      // "neutral" (no traits) so a bare createGameState — every engine test —
      // behaves exactly as before; the setup screen (main.js) passes the real
      // pick for the player and the archetype's faction for the AI.
      player: { id: "player", faction: opts.playerFaction || "neutral", isAI: false, resources: startingResources(), color: "#4fd1ff", upgrades: {} },
      ai: { id: "ai", faction: opts.aiFaction || "neutral", isAI: true, resources: startingResources(), color: "#f87171", upgrades: {} },
    },
    units: new Map(),
    buildings: new Map(),
    selection: [],          // unit/building ids currently selected by the human player
    fog: createFog(map),    // the player's fog of war — see engine/fog.js
    fogAI: createFog(map),  // the AI's own fog: it must scout for intel too, it's no longer omniscient (see engine/ai.js)
    aiScoutId: null,        // the unit currently out scouting for the AI, if any
    aiApm: opts.aiApm ?? null,   // AI actions-per-minute cap from the splash screen; null = unthrottled (default/tests)
    aiMicro: opts.aiMicro ?? false,   // Tactical AI: unit-level micro (focus-fire, kiting). Off by default (and in tests).
    aiActionBudget: 0,      // accumulated action credits (see engine/ai.js's accrueActionBudget)
    aiAttackForce: 0,       // size of the current committed attack at its peak — drives the retreat check (ai.js)
    aiAttackDesperate: false, // whether the current attack is a fight-to-death timeout commit (never retreats)
    aiArchetype: archetypeFor(planetId),   // this world's opponent temperament — see engine/aiArchetypes.js
    events: [],              // sim events this tick (unitSpawned/attackHit/entityKilled/buildingComplete) — pushed by
                              // production.js/combat.js, drained and turned into sound by main.js each render frame
  };

  seedPlayer(state, "player", map.bases.player);
  seedPlayer(state, "ai", map.bases.ai);
  updateFog(state, state.fog, "player");   // so the starting base's vision is correct before the first render
  updateFog(state, state.fogAI, "ai");     // ...and the AI likewise starts only knowing its own corner

  return state;
}

function startingResources() {
  return { ore: 300, crystals: 0, radioactives: 0 };
}

function seedPlayer(state, ownerId, basePos) {
  const cc = makeBuilding("command", ownerId, basePos.x, basePos.y);
  state.buildings.set(cc.id, cc);
  for (let i = 0; i < 3; i++) {
    const w = makeUnit("worker", ownerId, basePos.x + 40 + i * 14, basePos.y + 40);
    state.units.set(w.id, w);
  }
}

export function allEntities(state) {
  return [...state.units.values(), ...state.buildings.values()];
}

export function getEntity(state, id) {
  return state.units.get(id) || state.buildings.get(id);
}

export function removeEntity(state, id) {
  state.units.delete(id) || state.buildings.delete(id);
  state.selection = state.selection.filter(sid => sid !== id);
}

export function playerBuildings(state, owner) {
  return [...state.buildings.values()].filter(b => b.owner === owner);
}

export function playerUnits(state, owner) {
  return [...state.units.values()].filter(u => u.owner === owner);
}
