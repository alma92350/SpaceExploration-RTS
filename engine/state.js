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

let nextEntityId = 1;
function newId(prefix) { return `${prefix}${nextEntityId++}`; }

export function makeUnit(type, owner, x, y) {
  const def = UNITS[type];
  return {
    kind: "unit", id: newId("u"), type, owner,
    x, y, hp: def.hp, maxHp: def.hp,
    order: null,          // { type: 'move'|'gather'|'attack'|'attack-move'|'build', ... } — the active order
    orderQueue: [],       // queued waypoints (Ctrl+command); sim.js pulls the next in whenever `order` clears
    cargo: def.role === "worker" ? { com: null, qty: 0 } : null,
    attackTimer: 0,
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
  const planetId = opts.planetId || "ferros";
  const map = generateMap(planetId, opts.rng || Math.random);

  const state = {
    time: 0,
    tick: 0,
    over: false,
    winner: null,
    map,
    players: {
      player: { id: "player", faction: "frontier", isAI: false, resources: startingResources(), color: "#4fd1ff", upgrades: {} },
      ai: { id: "ai", faction: "miners", isAI: true, resources: startingResources(), color: "#f87171", upgrades: {} },
    },
    units: new Map(),
    buildings: new Map(),
    selection: [],          // unit/building ids currently selected by the human player
    fog: createFog(map),    // the player's fog of war — see engine/fog.js
    aiArchetype: archetypeFor(planetId),   // this world's opponent temperament — see engine/aiArchetypes.js
    events: [],              // sim events this tick (unitSpawned/attackHit/entityKilled/buildingComplete) — pushed by
                              // production.js/combat.js, drained and turned into sound by main.js each render frame
  };

  seedPlayer(state, "player", map.bases.player);
  seedPlayer(state, "ai", map.bases.ai);
  updateFog(state, state.fog, "player");   // so the starting base's vision is correct before the first render

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
