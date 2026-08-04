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
import { difficultyFor } from "./aiDifficulty.js";

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
/** @returns {number} */
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
 * Build a fresh AI controller's runtime bookkeeping — the exact shape shared by state.ai (owner
 * "ai", always present) and state.playerAi (owner "player", present only when self-play is active
 * — see tools/selfplay.js). Kept as one factory so the two controllers can never structurally
 * drift apart; engine/ai.js's runAI(state, dt, owner) and engine/aiCommon.js's controllerFor read
 * either one the same way. Every field here matches state.ai's own inline literal below field for
 * field, in the same order, so createGameState's construction of state.ai stays byte-identical.
 * @param {string} planetId
 * @param {{ apm?: number, micro?: boolean, strategy?: string, difficulty?: string }} [opts]
 */
export function createAiController(planetId, opts = {}) {
  return {
    think: 0,               // countdown to this controller's next decision pass (engine/ai.js THINK_INTERVAL)
    scoutId: null,           // the unit currently out scouting for this controller, if any
    colonyTarget: null,      // Odyssey: the committed {x,y} deploy spot of this controller's in-flight colony ship (ai.js)
    apm: opts.apm ?? null,      // actions-per-minute cap; null = unthrottled (default/tests)
    micro: opts.micro ?? false, // Tactical AI: unit-level micro (focus-fire, kiting). Off by default (and in tests).
    strategy: opts.strategy || "default",   // player-picked AI strategy (engine/aiStrategy.js) — "default" ⇒ byte-identical to today
    difficulty: opts.difficulty || "medium",  // splash-screen Easy/Medium/Hard pick (engine/aiDifficulty.js) — read via difficultyFor(state, owner)
    lastThreatAt: null,     // sim-time of the last seen threat near home — drives the Economic strategy's war-footing window (engine/ai.js)
    actionBudget: 0,         // accumulated action credits (see engine/aiCommon.js's accrueActionBudget)
    attackForce: 0,           // size of the current committed attack at its peak — drives the retreat check (ai.js)
    attackDesperate: false,   // whether the current attack is a fight-to-death timeout commit (never retreats)
    nextAttackAt: null,      // scheduled time of the next attack commit; null ⇒ use the archetype timeout
    unitsBuilt: 0,            // total combat units this controller has produced (drives its build cadence)
    waveCount: 0,             // committed-wave counter — drives the economy-raid cadence (waveCount % RAID_EVERY)
    nextWaveAt: null,        // Odyssey: scheduled time of the next offensive wave; null ⇒ wave-ready
    archetype: archetypeFor(planetId),   // this world's opponent temperament — see engine/aiArchetypes.js
  };
}

/**
 * Build a fresh simulation world. A pure function of its inputs (seed + options): the map
 * regenerates deterministically from the seed, so two same-option runs are identical.
 * @param {{ planetId?: string, rng?: () => number, seed?: number, sizeMult?: number,
 *   resourceMult?: number, swapAsym?: boolean, matchTimeLimit?: number, popCap?: number, endless?: boolean,
 *   aiApm?: number, aiMicro?: boolean,
 *   aiStrategy?: string, difficulty?: string, playerFaction?: string, aiFaction?: string }} [opts]
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
    swapAsym: !!opts.swapAsym,
  });

  // The sides in this world. Today always exactly the human "player" and the AI
  // opponent, but the SCAFFOLD is owner-generic: state.owners is the canonical
  // side list, and the player map, per-owner fog, seeding, persistence and the
  // victory check are all driven by ITERATING it — not by two hardcoded names.
  // So a future N-faction world is a change to this list, not a sweep across the
  // engine. (state.fog / state.fogAI stay as aliases into state.fogs so the many
  // existing fog consumers keep working unchanged.)
  const ownerDefs = [
    // Faction is a passive-trait bundle (engine/factions.js). It defaults to
    // "neutral" (no traits) so a bare createGameState — every engine test —
    // behaves exactly as before; the setup screen (main.js) passes the real
    // pick for the player and the archetype's faction for the AI.
    { id: "player", faction: opts.playerFaction || "neutral", isAI: false, color: "#4fd1ff" },
    { id: "ai", faction: opts.aiFaction || "neutral", isAI: true, color: "#f87171" },
  ];
  const owners = ownerDefs.map(d => d.id);
  /** @type {Object.<string, Player>} */
  const players = {};
  for (const d of ownerDefs)
    players[d.id] = { id: d.id, faction: d.faction, isAI: d.isAI, resources: startingResources(), color: d.color, upgrades: {} };
  /** @type {Object.<string, Fog>} */
  const fogs = {};
  for (const id of owners) fogs[id] = createFog(map);   // one fog grid per side — the AI scouts for its own intel too (engine/ai.js)

  const state = {
    time: 0,
    tick: 0,
    over: false,
    winner: null,
    winReason: null,   // set by engine/victory.js finish() — why the match ended, once it does
    seed: opts.seed ?? null,   // the match seed, if one was supplied — reproduces this whole game
    // The generation inputs, kept so a save can regenerate the (deterministic)
    // map from the seed instead of serialising the whole terrain/node table.
    planetId,
    sizeMult: opts.sizeMult || 1,
    resourceMult: opts.resourceMult || 1,
    // Pick your side of an asymmetric matchup (Oort, Nimbus, engine/map.js): additive, next to
    // sizeMult/resourceMult — a generation input kept so a save can regenerate the map with the
    // same swap honored, not just replay the bare boolean. Defaults false (unswapped, today's
    // long-standing assignment).
    swapAsym: !!opts.swapAsym,
    // setup.js's Match length row (Quick 20 / Standard 40 / Marathon 60 — never "unlimited"):
    // an explicit override of engine/victory.js's DEFAULT_MATCH_TIME_LIMIT, in seconds. Defaults
    // to null (not DEFAULT_MATCH_TIME_LIMIT's own 2400) so checkWinCondition's own `??` fallback
    // stays the single source of truth for "no override requested" — this field only ever carries
    // a REAL, deliberately-chosen override, never a copy of the default it would fall back to
    // anyway.
    matchTimeLimit: opts.matchTimeLimit ?? null,
    // setup.js's Population cap row (200 / 250 / 300 / Max): a hard ceiling supplyCap
    // (engine/supply.js) clamps the building-derived total to, shared by both owners alike (it's
    // a match rule, not a per-side or AI-temperament dial like difficulty/aiStrategy — see
    // engine/state.js's `ai:` block below for that distinction). Defaults to null — Max, i.e.
    // today's always-uncapped-by-anything-but-buildings behaviour, byte-identical to before this
    // setting existed.
    popCap: opts.popCap ?? null,
    // Odyssey (open-world) mode: no skirmish victory — the match never ends by
    // razing the enemy, only when the player loses their single Command Center
    // (see engine/victory.js checkEndlessLoss + engine/galaxy.js).
    endless: !!opts.endless,
    map,
    owners,                 // the world's side ids, in canonical iteration order (["player","ai"])
    players,
    units: new Map(),
    buildings: new Map(),
    selection: [],          // unit/building ids currently selected by the human player
    fogs,                   // per-owner fog of war, keyed by owner id — see engine/fog.js
    fog: fogs.player,       // alias: the human player's fog (=== state.fogs.player)
    fogAI: fogs.ai,         // alias: the AI's own fog, no longer omniscient (=== state.fogs.ai)
    // The AI OPPONENT's runtime bookkeeping, grouped under one key so it doesn't clutter the
    // top-level state (which is the shared sim world). This is the AI *controller's* scratch
    // state — distinct from state.players.ai, which is the AI's economy/faction. Serialized under
    // the save's `ai:` key (engine/persist.js). The think/wave/attack-schedule fields used to be
    // set lazily by ai.js on first tick; initialising them here keeps the shape complete and
    // self-documenting, and is behaviourally identical (they were read `|| 0` / `?? …` anyway).
    ai: createAiController(planetId, {
      apm: opts.aiApm, micro: opts.aiMicro, strategy: opts.aiStrategy, difficulty: opts.difficulty,
    }),
    // A second, parallel AI controller for owner "player" — same shape as `ai` above (see
    // createAiController), but null for every match that exists today. Tier 1 self-play
    // (tools/selfplay.js, a headless bench — never setup.js/boot.js/the shipped game) is the only
    // thing that ever populates it, by assigning a controller object here directly; every other
    // caller leaves it null, so playerBuildings/playerUnits/runAI's single-owner default path is
    // completely untouched. Kept OUTSIDE `players` (state.players.player is the human's economy/
    // faction, unrelated) and outside `ai` itself, exactly parallel to it — see engine/ai.js's
    // runAI(state, dt, owner) and engine/aiCommon.js's controllerFor.
    playerAi: null,
    events: [],              // sim events this tick (unitSpawned/attackHit/entityKilled/buildingComplete) — pushed by
                              // production.js/combat.js, drained and turned into sound by main.js each render frame
    craters: [],              // pending Helium Bomb craters awaiting maturity into a real node (engine/bomb.js)
    wrecks: [],                // pending battle-wreckage sites awaiting maturity into real nodes (engine/wreckage.js)
  };

  // Seed each side's opening (a colony ship in Odyssey, a Command Center + workers in
  // skirmish) and prime its vision before the first render — both by iterating owners,
  // so the id-minting order and fog state are byte-identical to the old player-then-ai
  // pair. map.bases is keyed by owner id (engine/map.js).
  for (const id of owners) seedPlayer(state, id, map.bases[id]);
  for (const id of owners) updateFog(state, state.fogs[id], id);

  // Hard difficulty's economic edge (engine/aiDifficulty.js): seed the synthetic hardEdge
  // upgrade (entities.js) straight onto the AI's own upgrades, once, at creation — never
  // researched, so it needs no Refinery/Datacenter and survives save/load via the ordinary
  // player.upgrades round-trip (engine/persist.js) with no special-casing. state.playerAi is
  // always null at this point (Tier 1 self-play populates it AFTER createGameState returns — see
  // tools/selfplay.js), so seedDifficultyEdge(state, "player") only ever fires there, once
  // self-play has actually configured a difficulty for it — see that call site.
  seedDifficultyEdge(state, "ai");

  return state;
}

/**
 * Seed Hard difficulty's synthetic `hardEdge` economic-edge upgrade (engine/aiDifficulty.js
 * economicEdge — +10% gather yield, -10% production time) onto `owner`'s own upgrades, once, if
 * that owner's OWN configured difficulty (difficultyFor(state, owner)) grants it. Exported so a
 * caller can apply the exact same rule to a second controller after the fact — Tier 1 self-play
 * (tools/selfplay.js's createSelfPlayState) populates state.playerAi only AFTER createGameState
 * has already returned, so owner "player" can never be seeded inline above; without this, a
 * self-play "player" controller configured with Hard difficulty would fight at a permanent,
 * un-researchable economic disadvantage against a Hard "ai" — the fairness guarantee (independent
 * fog, independent action budgets, no double-spend) this whole tier otherwise holds to. A no-op
 * for any owner whose difficulty doesn't grant the edge (Easy/Medium, or no controller at all yet
 * — difficultyFor falls back to Medium's defaults either way).
 * @param {State} state
 * @param {string} owner
 */
export function seedDifficultyEdge(state, owner) {
  if (difficultyFor(state, owner).economicEdge) state.players[owner].upgrades.hardEdge = true;
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
