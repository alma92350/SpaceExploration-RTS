/* ============================================================
   Central JSDoc type definitions for the core sim shapes.

   This file has NO runtime code — it is never imported and never loaded by the
   browser or by node. It exists purely so `// @ts-check` files (and any editor
   with the bundled TypeScript language service) can type-check against a shared,
   accurate model of the game state instead of an untyped `any` bag. Because the
   file declares no imports/exports it is a *script*, so these @typedefs are
   GLOBAL — every file in the project can refer to `State`, `Unit`, `Building`,
   … by name without importing anything.

   The shapes here mirror the real runtime literals (engine/state.js factories,
   engine/galaxy.js, engine/map.js). Keep them in sync: when a factory grows a
   field, add it here. Fields attached dynamically after construction (the
   broad-phase grid, the Odyssey market/diplomacy, transient flags) are marked
   optional so both the constructing literal and the later-attaching code check.
   ============================================================ */

"use strict";

// ---- primitives / small records -------------------------------------------------

/**
 * A commodity ledger: commodity id → amount. Always carries ore/crystals/radioactives;
 * an Odyssey world's market adds the tradeable goods (gas, ice, biomass, spice, …).
 * @typedef {Object.<string, number>} Resources
 */

/**
 * A worker's carried load.
 * @typedef {Object} Cargo
 * @property {string|null} com   commodity id being carried, or null when empty
 * @property {number} qty        amount carried
 */

/**
 * A unit order. `type` is always present; the rest depend on the order kind
 * (move/gather/attack/attack-move/build/escort/scout).
 * @typedef {Object} Order
 * @property {string} type
 * @property {number} [x]
 * @property {number} [y]
 * @property {string} [targetId]
 * @property {string} [nodeId]
 * @property {string} [buildingId]
 * @property {string} [com]
 * @property {number} [slot]
 * @property {number} [slots]
 * @property {string} [phase]
 * @property {boolean} [manual]   a player-assigned service order sticks to its building (engine/haul.js)
 */

/**
 * A world's opponent temperament (engine/aiArchetypes.js). Loosely typed — only the
 * fields the sim actually reads are pinned.
 * @typedef {Object} Archetype
 * @property {string} [name]
 * @property {string[]} [unitMix]
 * @property {number} [attackTimeout]
 * @property {number} [workerTarget]
 * @property {number} [armyAttackSize]
 * @property {string} [faction]
 * @property {Object} [odyssey]
 */

// ---- entities -------------------------------------------------------------------

/**
 * A mobile unit (engine/state.js makeUnit). The first block is the constructed shape;
 * the optional tail is state attached later by the sim (grid index, combat targeting).
 * @typedef {Object} Unit
 * @property {"unit"} kind
 * @property {string} id
 * @property {string} type
 * @property {string} owner
 * @property {number} x
 * @property {number} y
 * @property {number} hp
 * @property {number} maxHp
 * @property {Order|null} order
 * @property {Order[]} orderQueue
 * @property {Cargo|null} cargo
 * @property {number} attackTimer
 * @property {string|null} autoTarget
 * @property {number} [_gi]           transient broad-phase index, re-stamped each tick (grid.js)
 * @property {string|null} [focusId]  AI focus-fire target (ai.js / combat.js)
 * @property {boolean} [hold]         hold-stance flag (combat.js)
 * @property {string|null} [targetId] aim target (combat.js / render.js)
 * @property {Object.<string, number>} [freight]  a freighter's player-managed cargo hold, commodity → qty (engine/galaxy.js)
 */

/**
 * A structure (engine/state.js makeBuilding). Optional tail: fields only some building
 * types carry (a Spaceport's tier, a Datacenter's research queue).
 * @typedef {Object} Building
 * @property {"building"} kind
 * @property {string} id
 * @property {string} type
 * @property {string} owner
 * @property {number} x
 * @property {number} y
 * @property {number} radius
 * @property {number} hp
 * @property {number} maxHp
 * @property {boolean} constructing
 * @property {number} buildProgress
 * @property {Array<{unitType:string, progress:number}>} queue
 * @property {number} attackTimer
 * @property {string|null} targetId
 * @property {{x:number, y:number}} rally
 * @property {number} [tier]          Spaceport upgrade tier (engine/galaxy.js)
 * @property {Array<{techId:string, progress:number}>} [researchQueue]  Datacenter (engine/techtree.js)
 * @property {boolean} [paused]       player-paused factory / rig (frees its Power)
 * @property {number} [charge]        wonder charge 0..1 (engine/wonder.js)
 * @property {number} [digProgress]   Plasma Rig dig-cycle progress (engine/rig.js)
 * @property {number} [digCount]      Plasma Rig completed digs (drives the deterministic yield roll)
 * @property {string} [lastTier]      Plasma Rig last strike tier (HUD)
 * @property {number} [lastYield]     Plasma Rig last strike amount (HUD)
 * @property {Object.<string, number>} [store]  a producer's finite output buffer, commodity → qty (engine/haul.js)
 * @property {Object.<string, number>} [input]  a factory's finite input larder, commodity → qty (engine/haul.js)
 * @property {number} [haulers]       transient per-tick count of workers hauling from this producer (engine/haul.js)
 * @property {number} [servers]       transient per-tick count of workers servicing this factory (engine/haul.js)
 * @property {boolean} [powered]      transient: a Combustion Generator is fed & granting Power this tick (engine/industry.js)
 * @property {string} [fuel]          transient: which fuel the Generator burned this tick (HUD)
 */

/**
 * A resource deposit on the map (engine/map.js).
 * @typedef {Object} ResourceNode
 * @property {string} id
 * @property {string} com
 * @property {number} amount
 * @property {number} max
 * @property {number} x
 * @property {number} y
 * @property {boolean} [hidden]   a cache, invisible until scouted
 * @property {number} [miners]    workers currently assigned (engine/gather.js saturation)
 */

// ---- players / AI ---------------------------------------------------------------

/**
 * One side's economy + identity (engine/state.js).
 * @typedef {Object} Player
 * @property {string} id
 * @property {string} faction
 * @property {boolean} isAI
 * @property {Resources} resources
 * @property {string} color
 * @property {Object.<string, boolean>} upgrades
 */

/**
 * The AI opponent's runtime bookkeeping — state.ai (engine/state.js). Distinct from
 * state.players.ai (that's the AI's economy). Serialized under the save's `ai:` key.
 * @typedef {Object} AiState
 * @property {number} think
 * @property {string|null} scoutId
 * @property {{x:number, y:number}|null} colonyTarget
 * @property {number|null} apm
 * @property {boolean} micro
 * @property {number} actionBudget
 * @property {number} attackForce
 * @property {boolean} attackDesperate
 * @property {number|null} nextAttackAt
 * @property {number} unitsBuilt
 * @property {number} waveCount
 * @property {number|null} nextWaveAt
 * @property {Archetype} archetype
 */

// ---- map / world state ----------------------------------------------------------

/**
 * A fog grid (engine/fog.js) — one byte per cell, per side.
 * @typedef {Object} Fog
 * @property {number} cols
 * @property {number} rows
 * @property {Uint8Array} explored
 * @property {Uint8Array} visible
 */

/**
 * The generated map (engine/map.js) — regenerated deterministically from the seed.
 * @typedef {Object} GameMap
 * @property {Object} planet   the world's archetype record from data.js (NOT the id string — that's state.planetId)
 * @property {number} width
 * @property {number} height
 * @property {{player:{x:number,y:number}, ai:{x:number,y:number}}} bases
 * @property {ResourceNode[]} nodes
 * @property {Map<string, ResourceNode>} nodesById
 * @property {*} [terrain]
 * @property {Object} [modifiers]
 */

/**
 * An Odyssey world's price book (engine/market.js).
 * @typedef {Object} Market
 * @property {Resources} base
 * @property {Resources} pressure
 * @property {Resources} [glut]
 */

/**
 * An Odyssey world's neighbour stance (engine/diplomacy.js).
 * @typedef {Object} Diplomacy
 * @property {number} stance
 * @property {number} [depletion]
 * @property {number} [tributes]
 * @property {number} [lastAiUnits]
 */

/**
 * The mutable simulation world (engine/state.js createGameState). The required block is
 * the constructed shape; the optional tail is attached later — the per-tick broad-phase
 * grid, the Odyssey per-world layers, and transient scenario/flag fields.
 * @typedef {Object} State
 * @property {number} time
 * @property {number} tick
 * @property {boolean} over
 * @property {string|null} winner
 * @property {number|null} seed
 * @property {string} planetId
 * @property {number} sizeMult
 * @property {number} resourceMult
 * @property {boolean} endless
 * @property {GameMap} map
 * @property {Object.<string, Player>} players   keyed "player"/"ai"; index-signature so state.players[unit.owner] checks
 * @property {Map<string, Unit>} units
 * @property {Map<string, Building>} buildings
 * @property {string[]} selection
 * @property {Fog} fog
 * @property {Fog} fogAI
 * @property {AiState} ai
 * @property {Array<Object>} events
 * @property {Object} [unitGrid]     broad-phase index, rebuilt each tick (engine/grid.js)
 * @property {Market} [market]       Odyssey per-world price book (engine/galaxy.js)
 * @property {Diplomacy} [diplomacy] Odyssey neighbour stance (engine/galaxy.js)
 * @property {boolean} [inGalaxy]    part of an Odyssey galaxy → per-world defeat off
 * @property {boolean} [background]  a held colony the player isn't currently on
 * @property {*} [scenario]          scripted-scenario bookkeeping (engine/scenarios.js)
 * @property {*} [anvils]            per-tick Aegis anvil index (engine/sim.js collectAnvils)
 */

// ---- AI ------------------------------------------------------------------------

/**
 * The per-think-cycle snapshot the AI's decision phases share (engine/ai.js). Built once by
 * aiContext(); the three *Reserve fields are running ore holdbacks one phase passes to the next
 * (an expansion banks ore that the infrastructure phases then leave alone).
 * @typedef {Object} AiContext
 * @property {Archetype} archetype
 * @property {(field: string) => *} arch   reads the archetype field, letting its Odyssey overlay win
 * @property {Player} ai
 * @property {Unit[]} workers
 * @property {Unit[]} army
 * @property {Unit[]} rangers
 * @property {Building[]} buildings
 * @property {Building|undefined} cc
 * @property {Unit|null} colonyShip
 * @property {Building|undefined} barracks
 * @property {Building|undefined} refinery
 * @property {Building[]} allBarracks
 * @property {Object[]} threats
 * @property {number} oreReserve
 * @property {number} foundryReserve
 * @property {number} refineryReserve
 */

// ---- Odyssey galaxy -------------------------------------------------------------

/**
 * Galaxy construction settings, carried on the galaxy and reused per planet.
 * @typedef {Object} GalaxySettings
 * @property {string} difficulty
 * @property {number} sizeMult
 * @property {number} resourceMult
 * @property {string} playerFaction
 * @property {number} [aiApm]
 * @property {boolean} [aiMicro]
 */

/**
 * The Odyssey open-world meta-state (engine/galaxy.js createGalaxy). `planets` maps a
 * world id to its full engine State; the active world's State is game.state.
 * @typedef {Object} Galaxy
 * @property {number} seed
 * @property {number} credits
 * @property {string} activeId
 * @property {string[]} worlds
 * @property {Map<string, State>} planets
 * @property {GalaxySettings} settings
 * @property {number} tick
 * @property {number} time
 * @property {number} entitySeq
 * @property {Map<string, Object>} colonyNotes
 * @property {Set<string>} pacified
 * @property {string[]} pacifyNotes
 * @property {Set<string>} reached
 * @property {string[]} milestones
 * @property {string|null} wonBy
 * @property {number} [lastReliefTime]
 */
