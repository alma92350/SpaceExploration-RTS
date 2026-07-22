// @ts-check
/* ============================================================
   Game state: the mutable simulation world. No rendering, no input,
   no DOM — engine/sim.js mutates this each fixed tick, render.js only
   reads it. Core shapes (State/Unit/Building/…) are defined in
   engine/types.js; this file is `// @ts-check`ed against them.
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
/** @param {number} n */
export function restoreEntityId(n) { nextEntityId = n; }

/**
 * @param {string} type   a key of UNITS (engine/entities.js)
 * @param {string} owner  "player" | "ai"
 * @param {number} x
 * @param {number} y
 * @returns {Unit}
 */
export function makeUnit(type, owner, x, y) {
  const def = UNITS[type];
  /** @type {Unit} */
  const u = {
    kind: "unit", id: newId("u"), type, owner,
    x, y, hp: def.hp, maxHp: def.hp,
    order: null,          // { type: 'move'|'gather'|'attack'|'attack-move'|'build', ... } — the active order
    orderQueue: [],       // queued waypoints (Ctrl+command); sim.js pulls the next in whenever `order` clears
    cargo: def.role === "worker" ? { com: null, qty: 0 } : null,
    attackTimer: 0,
    autoTarget: null,     // sticky auto-acquired target id (combat.js) — commit to a foe, don't re-dogpile the nearest each tick
  };
  // A freighter (Odyssey cargo ship) carries `freight` — a player-managed, multi-commodity hold,
  // filled and emptied by hand at a world (engine/galaxy.js load/unloadFreighter) and shipped on a
  // jump. Named `freight`, not `hold`, to stay clear of the combat hold-stance flag (unit.hold).
  if (def.cargoHold) u.freight = {};
  return u;
}

/**
 * @param {string} type   a key of BUILDINGS (engine/entities.js)
 * @param {string} owner  "player" | "ai"
 * @param {number} x
 * @param {number} y
 * @param {{ hp?: number, constructing?: boolean }} [opts]
 * @returns {Building}
 */
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

/**
 * Build a fresh simulation world. A pure function of its inputs (seed + options): the map
 * regenerates deterministically from the seed, so two same-option runs are identical.
 * @param {{ planetId?: string, rng?: () => number, seed?: number, sizeMult?: number,
 *   resourceMult?: number, endless?: boolean, aiApm?: number, aiMicro?: boolean,
 *   playerFaction?: string, aiFaction?: string }} [opts]
 * @returns {State}
 */
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
    // Odyssey (open-world) mode: no skirmish victory — the match never ends by
    // razing the enemy, only when the player loses their single Command Center
    // (see engine/victory.js checkEndlessLoss + engine/galaxy.js).
    endless: !!opts.endless,
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
    // The AI OPPONENT's runtime bookkeeping, grouped under one key so it doesn't clutter the
    // top-level state (which is the shared sim world). This is the AI *controller's* scratch
    // state — distinct from state.players.ai, which is the AI's economy/faction. Serialized under
    // the save's `ai:` key (engine/persist.js). The think/wave/attack-schedule fields used to be
    // set lazily by ai.js on first tick; initialising them here keeps the shape complete and
    // self-documenting, and is behaviourally identical (they were read `|| 0` / `?? …` anyway).
    ai: {
      think: 0,               // countdown to the AI's next decision pass (engine/ai.js THINK_INTERVAL)
      scoutId: null,          // the unit currently out scouting for the AI, if any
      colonyTarget: null,     // Odyssey: the committed {x,y} deploy spot of the AI's in-flight colony ship (ai.js)
      apm: opts.aiApm ?? null,      // AI actions-per-minute cap from the splash screen; null = unthrottled (default/tests)
      micro: opts.aiMicro ?? false, // Tactical AI: unit-level micro (focus-fire, kiting). Off by default (and in tests).
      actionBudget: 0,        // accumulated action credits (see engine/ai.js's accrueActionBudget)
      attackForce: 0,         // size of the current committed attack at its peak — drives the retreat check (ai.js)
      attackDesperate: false, // whether the current attack is a fight-to-death timeout commit (never retreats)
      nextAttackAt: null,     // scheduled time of the next attack commit; null ⇒ use the archetype timeout
      unitsBuilt: 0,          // total combat units the AI has produced (drives its build cadence)
      waveCount: 0,           // committed-wave counter — drives the economy-raid cadence (waveCount % RAID_EVERY)
      nextWaveAt: null,       // Odyssey: scheduled time of the next offensive wave; null ⇒ wave-ready
      archetype: archetypeFor(planetId),   // this world's opponent temperament — see engine/aiArchetypes.js
    },
    events: [],              // sim events this tick (unitSpawned/attackHit/entityKilled/buildingComplete) — pushed by
                              // production.js/combat.js, drained and turned into sound by main.js each render frame
  };

  seedPlayer(state, "player", map.bases.player);
  seedPlayer(state, "ai", map.bases.ai);
  updateFog(state, state.fog, "player");   // so the starting base's vision is correct before the first render
  updateFog(state, state.fogAI, "ai");     // ...and the AI likewise starts only knowing its own corner

  return state;
}

/** @returns {Resources} */
function startingResources() {
  return { ore: 300, crystals: 0, radioactives: 0 };
}

/**
 * @param {State} state
 * @param {string} ownerId
 * @param {{ x: number, y: number }} basePos
 */
function seedPlayer(state, ownerId, basePos) {
  if (state.endless) {
    // Odyssey: both sides START with a mobile colony ship instead of a built base —
    // deploy it (engine/colony.js) to found the first Command Center; the colonists
    // (opening workers) disembark then. Seeding workers now would strand them: with
    // no drop-off yet they can't bank ore (engine/gather.js).
    const ship = makeUnit("colonyship", ownerId, basePos.x, basePos.y);
    state.units.set(ship.id, ship);
    return;
  }
  // Skirmish — BYTE-IDENTICAL to before: a finished Command Center + 3 workers.
  const cc = makeBuilding("command", ownerId, basePos.x, basePos.y);
  state.buildings.set(cc.id, cc);
  for (let i = 0; i < 3; i++) {
    const w = makeUnit("worker", ownerId, basePos.x + 40 + i * 14, basePos.y + 40);
    state.units.set(w.id, w);
  }
}

/**
 * @param {State} state
 * @returns {(Unit|Building)[]}
 */
export function allEntities(state) {
  return [...state.units.values(), ...state.buildings.values()];
}

/**
 * @param {State} state
 * @param {string} id
 * @returns {Unit|Building|undefined}
 */
export function getEntity(state, id) {
  return state.units.get(id) || state.buildings.get(id);
}

/**
 * @param {State} state
 * @param {string} id
 */
export function removeEntity(state, id) {
  state.units.delete(id) || state.buildings.delete(id);
  state.selection = state.selection.filter(sid => sid !== id);
}

/**
 * @param {State} state
 * @param {string} owner
 * @returns {Building[]}
 */
export function playerBuildings(state, owner) {
  return [...state.buildings.values()].filter(b => b.owner === owner);
}

/**
 * @param {State} state
 * @param {string} owner
 * @returns {Unit[]}
 */
export function playerUnits(state, owner) {
  return [...state.units.values()].filter(u => u.owner === owner);
}
