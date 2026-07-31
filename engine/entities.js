/* ============================================================
   Unit & building definitions for the first skirmish slice.
   Costs are in the planet's own deposit commodities (see engine/map.js)
   so the resources you gather are the resources you spend — no separate
   RTS-only currency.
   ============================================================ */

"use strict";

import { RECIPES } from "../data.js";

export const BUILDINGS = {
  command: {
    id: "command", name: "Command Center", hp: 1000, radius: 26,
    cost: { ore: 400 }, buildTime: 30,   // steep + slow: an expansion is a long-game commitment
    // The starting CC is still seeded finished by state.js's seedPlayer —
    // makeBuilding without { constructing: true } spawns complete regardless
    // of buildTime. cost/buildTime only gate the issueBuild path.
    produces: ["worker", "ranger", "colonyship", "hauler", "heavyhauler", "bulkfreighter"],   // the Odyssey-only ones are gated by queueProduction (def.odysseyOnly)
    isCommandCenter: true,
    supplyGrants: 10,   // the seeded CC already houses the starting 3 workers with room to grow
    sight: 220,
    category: "infrastructure",
  },
  barracks: {
    id: "barracks", name: "Barracks", hp: 500, radius: 20,
    cost: { ore: 150 }, buildTime: 20,
    produces: ["skiff", "bastion", "lancer", "breacher", "dreadnought", "mender", "wraith", "aegis", "colossus"],
    sight: 150,
    category: "military",
  },
  refinery: {
    id: "refinery", name: "Refinery", hp: 400, radius: 18,
    cost: { ore: 200 }, buildTime: 16,
    sight: 140,
    // No `produces` — it researches upgrades instead of building units,
    // which is also what keeps it out of the rally-point UI (input.js
    // only offers that for buildings with a `produces` list).
    category: "industrial",
  },
  turret: {
    id: "turret", name: "Sentinel Turret", hp: 350, radius: 12,
    cost: { ore: 150, crystals: 100 }, buildTime: 12,
    sight: 170,
    // Static defense: same combat stat names units use, so combat.js's
    // acquireTarget/attackDamage apply verbatim. aggroRange === range on
    // purpose — a turret can't chase, so acquiring beyond range is useless.
    attack: 20, range: 130, cooldown: 1, aggroRange: 130,
    category: "military",
  },
  habitat: {
    id: "habitat", name: "Habitat", hp: 250, radius: 14,
    cost: { ore: 75 }, buildTime: 10,
    supplyGrants: 8,   // ~one economist mix cycle's worth of headroom per dome
    sight: 100,
    // No `produces` — like the Refinery, this keeps it out of the
    // rally-point UI and rally rendering automatically. Softest building
    // on the roster (hp 250): a legitimate raid target to choke supply.
    category: "infrastructure",
  },
  foundry: {
    id: "foundry", name: "Foundry", hp: 450, radius: 18,
    cost: { ore: 175 }, buildTime: 22, sight: 140,
    // The military tech gate: a pure prerequisite building (no `produces`, so
    // it stays out of the rally UI). It unlocks the Tier-2 combat units
    // (Lancer, Breacher) — the Barracks still trains them. Ore-only on purpose,
    // so the Tier-2 units stay reachable on every world (ore is guaranteed near
    // every base) rather than being walled off on a crystal-poor map.
    requires: ["barracks"],
    // Category is "industrial" (not "military") despite gating Tier-2 combat units —
    // it groups with the other production-tech buildings in the build menu.
    category: "industrial",
  },
  arsenal: {
    id: "arsenal", name: "Arsenal", hp: 550, radius: 18,
    cost: { ore: 220 }, buildTime: 26, sight: 140,
    // The Tier-3 gate, one step past the Foundry: unlocks the Dreadnought
    // capital unit. Also a pure gate (no `produces`), ore-only so the tech path
    // stays reachable on every world.
    requires: ["foundry"],
    category: "industrial",   // same reasoning as the Foundry above
  },
  spaceport: {
    id: "spaceport", name: "Spaceport", hp: 600, radius: 22,
    cost: { ore: 300 }, buildTime: 30, sight: 160,
    // Odyssey only (offered in the Odyssey build menu): the interplanetary launch
    // pad. Selecting a finished Spaceport lets you relocate your single Command
    // Center — plus the units staged nearby — to another world (engine/galaxy.js).
    // Gated behind the Foundry so leaving the planet is a mid-game milestone.
    requires: ["foundry"],
    category: "infrastructure",
  },
  market: {
    id: "market", name: "Market", hp: 150, radius: 12,
    cost: { ore: 40 }, buildTime: 6, sight: 90,
    // The cheapest, fastest building on the roster — Odyssey's on-ramp into trading, and
    // meant to be the first thing a worker raises. A finished Market opens the commodity
    // trade panel (hudSelection.js renderMarket) — buy/sell local goods for galaxy credits
    // (engine/market.js) — which used to sit on the Command Center; it's moved here so a
    // destroyed/absent CC doesn't strand a colony without a market. No `produces`/`recipe`:
    // a pure UI gate, so it stays out of the rally-point UI and updateProduction
    // (engine/industry.js) skips it like any other non-recipe building.
    odysseyOnly: true,
    category: "infrastructure",
  },

  /* ---- INDUSTRY (Odyssey only) — the production chain that turns raw hauls into
     refined goods worth real credits. All ore-costed (ore is guaranteed near every
     base, so the chain is reachable on any world) and flagged `odysseyOnly`: they
     never appear in a skirmish build menu, the skirmish AI never builds one, and
     engine/industry.js's updateProduction is a no-op for any building without a
     `recipe` — so a skirmish match never instantiates one and its byte-identical
     replay is untouched. A building's `recipe` names an entry in data.js RECIPES;
     `prodRate` is how many batches/sec it runs at full power. `energyGrants` is
     industrial Power capacity (a per-tick flow, like supply — see engine/industry.js). ---- */
  reactor: {
    id: "reactor", name: "Reactor", hp: 400, radius: 16,
    cost: { ore: 120 }, buildTime: 16, sight: 130,
    energyGrants: 30,   // the power that runs the factories below; short power throttles them all
    powerRange: 1,      // the reference grid reach — a consumer's efficiency tier is its distance / this (industry.js)
    // The original power station burns radioactives too — a real fission reactor runs on fissile
    // material, not free once built. Its own local fuel larder (entities.js inputCapOf), filled by
    // a worker SERVICE run (engine/haul.js), same mechanism as its smaller combust siblings below —
    // just at double their burn rate (0.12/s vs 0.06/s), matching its double energyGrants and reach.
    // Out of fuel (or paused) it grants nothing, same as them. See engine/industry.js updateCombustors.
    combust: { fuels: ["radioactives"], rate: 0.12 },
    odysseyOnly: true,
    category: "industrial",
  },
  combustor: {
    id: "combustor", name: "Combustion Generator", hp: 300, radius: 13,
    cost: { ore: 70 }, buildTime: 12, sight: 110,
    // A cheap, fuel-burning alternative to the Reactor: it GRANTS less Power (energyGrants 15 vs 30)
    // over a SMALLER grid (powerRange 0.55 shrinks its efficiency zones — industry.js) and burns fuel
    // at half the Reactor's rate too — cheaper to raise and run, just less of a grid. It burns gas
    // (Helium-3) from its own local fuel buffer — a real WORKER hauls it in from the treasury, same
    // as a factory's input larder (engine/haul.js SERVICE), same mechanism the Reactor now uses. Out
    // of fuel (or paused) it grants nothing. See engine/industry.js updateCombustors. Its
    // biomass-burning sibling is the Biomass Reactor below.
    energyGrants: 15, powerRange: 0.55,
    combust: { fuels: ["gas"], rate: 0.06 },
    odysseyOnly: true,
    category: "industrial",
  },
  biomassreactor: {
    id: "biomassreactor", name: "Biomass Reactor", hp: 300, radius: 13,
    cost: { ore: 70 }, buildTime: 12, sight: 110,
    // The Combustion Generator's sibling, for a claim rich in biomass instead of Helium-3 — same
    // cheap-but-fed deal (energyGrants/powerRange/rate all match), just its own single fuel and a
    // worker hauling it in the same way (engine/haul.js SERVICE, engine/industry.js updateCombustors).
    energyGrants: 15, powerRange: 0.55,
    combust: { fuels: ["biomass"], rate: 0.06 },
    odysseyOnly: true,
    category: "industrial",
  },
  smelter: {
    id: "smelter", name: "Smelter", hp: 420, radius: 16,
    cost: { ore: 160 }, buildTime: 18, sight: 140,
    dropOff: true,               // an industrial building doubles as a resource drop-off
    recipe: "smelt", prodRate: 2, // ore + power → metals (data.js RECIPES.smelt)
    odysseyOnly: true,
    category: "industrial",
  },
  assembler: {
    id: "assembler", name: "Assembly Plant", hp: 440, radius: 17,
    cost: { ore: 180 }, buildTime: 20, sight: 140,
    dropOff: true,
    recipe: "alloy", prodRate: 1.5,   // metals + power → alloys (data.js RECIPES.alloy)
    // The chain reads as a chain (needs a Smelter for metals) AND is the first
    // thing the tech tree gates: Metallurgy research (engine/techtree.js) unlocks
    // it, so the free tier (Smelter → metals) gives an immediate payoff while
    // deeper refining is an investment. `metallurgy` is a tech-node token that
    // prereqsMet resolves out of player.upgrades, exactly like a building token.
    requires: ["smelter", "metallurgy"],
    odysseyOnly: true,
    category: "industrial",
  },

  /* ---- Phase 2 research + deeper industry (Odyssey only). The Datacenter hosts
     the tech tree (engine/techtree.js); the Chip Fab and Machine Works are the
     next two hops of the chain, each gated behind a research node so unlocking a
     node visibly unlocks new production. All ore-costed and odysseyOnly, like the
     Phase-1 factories. ---- */
  datacenter: {
    id: "datacenter", name: "Datacenter", hp: 420, radius: 17,
    cost: { ore: 200 }, buildTime: 22, sight: 140,
    odysseyOnly: true,
    // Hosts research — no `recipe` (updateProduction ignores it) and no `produces`
    // (stays out of the rally UI). Selecting it opens the research panel (hud.js).
    category: "infrastructure",
  },
  chipfab: {
    id: "chipfab", name: "Chip Fab", hp: 440, radius: 17,
    cost: { ore: 190 }, buildTime: 20, sight: 140, dropOff: true,
    recipe: "chipfab", prodRate: 1.5,        // crystals + metals + power → electronics
    requires: ["smelter", "electronics"],    // needs the metals chain + Microelectronics research
    odysseyOnly: true,
    category: "industrial",
  },
  machineworks: {
    id: "machineworks", name: "Machine Works", hp: 460, radius: 18,
    cost: { ore: 220 }, buildTime: 24, sight: 140, dropOff: true,
    recipe: "machine", prodRate: 1,          // alloys + electronics + power → machinery
    requires: ["assembler", "chipfab", "machining"],   // the capstone: the whole chain + Precision Machining
    odysseyOnly: true,
    category: "industrial",
  },

  /* ---- Phase 3: the Strategic tier + the endgame (Odyssey only). The Antimatter
     Forge tops the chain (machinery → antimatter), and the Antimatter Gate is the
     WONDER that consumes antimatter to WIN the galaxy — Odyssey's first victory
     condition (engine/wonder.js + engine/victory.js checkEndlessWin). ---- */
  antimatterforge: {
    id: "antimatterforge", name: "Antimatter Forge", hp: 460, radius: 18,
    cost: { ore: 240 }, buildTime: 26, sight: 140, dropOff: true,
    recipe: "antifab", prodRate: 0.7,        // machinery + radioactives + power → antimatter (RTS-recost recipe)
    requires: ["machineworks", "antimatter"],   // needs the full chain + Antimatter Containment research
    odysseyOnly: true,
    category: "industrial",
  },
  aifoundry: {
    id: "aifoundry", name: "AI Foundry", hp: 460, radius: 18,
    cost: { ore: 240 }, buildTime: 26, sight: 140, dropOff: true,
    recipe: "aifab", prodRate: 0.7,          // electronics + crystals + power → AI Cores
    requires: ["chipfab", "aicores"],
    odysseyOnly: true,
    category: "industrial",
  },
  torpedoworks: {
    id: "torpedoworks", name: "Torpedo Works", hp: 460, radius: 18,
    cost: { ore: 240 }, buildTime: 26, sight: 140, dropOff: true,
    recipe: "plasmafab", prodRate: 0.7,      // antimatter + alloys + radioactives + power → Plasma Torpedoes
    requires: ["antimatterforge", "aicores"],
    odysseyOnly: true,
    category: "industrial",
  },
  plasmarig: {
    id: "plasmarig", name: "Plasma Rig", hp: 560, radius: 18,
    // Expensive and high-tech: MANUFACTURED materials to build (machinery + electronics) and an
    // installed AI to pilot it (ai cores), on top of a big ore frame.
    cost: { ore: 500, machinery: 8, electronics: 5, ai: 3 },
    buildTime: 46, sight: 130,
    requires: ["aifoundry", "reactor"],   // needs the AI (pilot) and a Reactor (the plasma/power grid)
    odysseyOnly: true,
    // Deep-core extraction: an UNLIMITED source of one raw commodity (its "vein", fixed by where
    // you place it), dug in cycles at a PROBABILISTIC yield tier (low → overwhelming) whose odds
    // rise with the spot's + planet's richness. Draws heavy Power (the plasma arc — taxes the grid
    // like a factory, so digs slow when power is short) and burns radioactives per dig ("nuclear to
    // exploit"). See engine/rig.js.
    rig: { power: 16, nuclear: 1.4, digTime: 6, base: 6 },
    // Its dug ore doesn't teleport into your treasury: it piles up in a FINITE output buffer
    // (storeCap) that workers must haul to a Command Center. Full buffer → the rig stalls until
    // it's cleared — logistics, not free money. See engine/haul.js.
    storeCap: 120,
    category: "industrial",
  },
  stardock: {
    id: "stardock", name: "Star Dock", hp: 600, radius: 22,
    cost: { ore: 350 }, buildTime: 40, sight: 160,
    produces: ["leviathan", "heliumbomb"],   // the strategic-good capital ship, and the doomsday device beside it
    requires: ["aifoundry", "torpedoworks"], // building it proves you've teched the whole Strategic tree
    odysseyOnly: true,
    category: "military",
  },
  antimatter_gate: {
    id: "antimatter_gate", name: "Antimatter Gate", hp: 1200, radius: 28,
    cost: { ore: 800 }, buildTime: 60, sight: 200,
    requires: ["antimatterforge", "aifoundry", "torpedoworks"],   // the true capstone: the whole Strategic tier
    odysseyOnly: true,
    // The wonder: charges by consuming `feed` goods over `chargeTime` seconds of
    // full-power charging (engine/wonder.js), clamped to the scarcest one — so the
    // win demands the WHOLE Strategic tier flowing, not just antimatter. At full
    // charge the player wins the galaxy. Razed mid-charge, the whole investment is
    // lost with it. The Leviathan (below) draws on the same strategic goods — feed
    // the Gate or build the fleet.
    wonder: true, feed: { ai: 0.2, antimatter: 0.3, plasmatorp: 0.1 }, chargeTime: 150,
    powerDraw: 8,   // a charging Gate loads the grid — it competes with your factories for Reactor Power
    category: "infrastructure",
  },
};

// Prerequisites are satisfied for `owner` when: every building-type token in
// `def.requires` has a COMPLETED (non-constructing) building of that type, and
// every other token is a researched upgrade id. No `requires` field ⇒ always
// available. Pure and state-reading — the single source of truth shared by the
// production gate, the build gate, the AI, and the UI's locked buttons.
export function prereqsMet(state, owner, def) {
  const reqs = def.requires;
  if (!reqs || reqs.length === 0) return true;
  const player = state.players[owner];
  return reqs.every(req => {
    if (BUILDINGS[req]) {
      for (const b of state.buildings.values())
        if (b.owner === owner && b.type === req && !b.constructing) return true;
      return false;
    }
    return !!(player && player.upgrades && player.upgrades[req]);
  });
}

// A building is a resource drop-off if it's the Command Center or a building flagged
// `dropOff` in its def (the Odyssey-only factory chain — smelter, assembler, chipfab,
// etc. — flags this; no skirmish building besides the Command Center does). Workers
// deposit their haul at the NEAREST drop-off (see gather.js). Single source of truth
// for the routing, tests, and any future UI.
export function isDropOff(type) {
  const def = BUILDINGS[type];
  return !!(def && (def.isCommandCenter || def.dropOff));
}

// Where a gatherer may DEPOSIT a raw haul: the Command Center, or a `dropOff` building
// with no `recipe` — NOT a factory, which drops its raws-as-inputs elsewhere and whose
// `store` is its refined OUTPUT buffer, not a raw-intake bin. In practice every `dropOff`
// building in the roster carries a `recipe` (the Odyssey factory chain), so this resolves
// to the Command Center alone — there is no forward/decentralized collection point.
export function isGatherDropOff(type) {
  const def = BUILDINGS[type];
  return !!(def && (def.isCommandCenter || (def.dropOff && !def.recipe)));
}

// ---- Worker capability: which unit types may found/assist-build a building category, gather a
// raw node, or run a haul/service/ferry job — end to end through recycling (recycling itself
// stays universal, see recycle.js: it's the target tearing itself down, not a worker action, so
// it needs no gate here). Mirrors isDropOff/isGatherDropOff's shape: a small pure predicate over a
// def flag. `UNITS[type].buildCategories` lists which of BUILDINGS[type].category values that
// unit may found/assist-build; `canGather`/`canLogistics` gate gathering and haul/service/ferry
// the same way. Worker is the one generalist that carries all three (every category, gather,
// logistics). Repair (Mender, role:"support") is intentionally untouched by all of this — it's
// its own separate specialist, ungated by any of these three.
export function canBuildCategory(unitType, category) {
  return !!category && !!UNITS[unitType]?.buildCategories?.includes(category);
}

/** Whether `unitType` may found/assist-build `buildingType` (its BUILDINGS[type].category). */
export function canBuildType(unitType, buildingType) {
  return canBuildCategory(unitType, BUILDINGS[buildingType]?.category);
}

/** Whether `unitType` may be issued a gather order (mine a raw resource node). */
export function canGatherType(unitType) {
  return !!UNITS[unitType]?.canGather;
}

/** Whether `unitType` may be offered/issued a haul, service, or ferry job (engine/haul.js). */
export function canLogisticsType(unitType) {
  return !!UNITS[unitType]?.canLogistics;
}

// Whether a building type can be ELECTRIFIED (Odyssey): wired into the power grid to run 30%
// better — a producer (Command Center / Barracks / Star Dock) trains faster, a Habitat houses
// more (engine/industry.js electrifyBoost; production.js, supply.js apply it). Eligible = a
// building that doesn't ALREADY live on the power economy (no recipe to run, no Power to grant,
// no rig/wonder draw) and has something worth boosting (`produces` a unit, or `supplyGrants`).
// So the factories (already power-hungry), Reactors/Generators (they GRANT power), turrets and
// other non-producers (Refinery, Foundry, Arsenal, Datacenter) are all excluded. Pure def
// predicate — deterministic, shared by the draw math, the boost application, and the HUD toggle.
export function isElectrifiable(type) {
  const def = BUILDINGS[type];
  if (!def) return false;
  if (def.recipe || def.energyGrants || def.rig || def.wonder || def.combust) return false;
  return !!(def.produces || def.supplyGrants);
}

// ---- Finite storage (Odyssey logistics) ---------------------------------------
// A producing building banks its OUTPUT into a finite `building.store` buffer, and a
// factory OR a fuel-burning power station draws its INPUTS (a recipe's ingredients, or a
// Combustion Generator's / Biomass Reactor's fuel) from a finite `building.input` buffer —
// both commodity→qty maps, capped by the def. Goods aren't spendable (or consumable) until a
// worker moves them (engine/haul.js): output is hauled to a Command Center, inputs are
// carried in from the treasury. So storage is a real, mindful constraint, not an infinite sink.
//
// Caps: a def can pin `storeCap` / `inputCap` explicitly (the Plasma Rig pins a big storeCap
// and has no input buffer — it digs its own raw ore, nothing to feed it); any building with a
// `recipe` (the factories) OR a `combust` (the fuel-burning power stations) otherwise gets the
// shared default. Everything else has no buffer (cap 0), so these helpers are no-ops for the
// whole skirmish roster.
const DEFAULT_FACTORY_STORE = 80;   // a factory's output backlog before it stalls, ~tens of batches
const DEFAULT_FACTORY_INPUT = 80;   // a factory's WHOLE input larder before it starves — split evenly
                                     // per real input commodity below, NOT one pool every commodity races for

const RECIPE_BY_ID = Object.fromEntries(RECIPES.map(r => [r.id, r]));

/** The output-buffer capacity of a building type, or 0 if it has no buffer. */
export function storeCapOf(type) {
  const def = BUILDINGS[type];
  if (!def) return 0;
  if (def.storeCap != null) return def.storeCap;
  return def.recipe ? DEFAULT_FACTORY_STORE : 0;
}

// The REAL (haulable) input commodities a building needs hauled in — a recipe's ingredients
// (every key but "energy", which is a live per-tick Power draw, engine/industry.js, never a
// hauled/stored good), or a fuel-burning power station's acceptable fuels (def.combust.fuels —
// gas for the Combustion Generator, biomass for the Biomass Reactor; a building CAN accept more
// than one — ANY ONE of them keeps it running, not all at once — see haul.js inputNeedsOf/
// neededInput, which already treats "pick whichever's neediest" the same way for both an
// AND-recipe and an OR-fuel-choice). Empty for a building with neither (or an unknown recipe id —
// belt-and-suspenders for stale data).
function realInputComs(type) {
  const def = BUILDINGS[type];
  const recipe = RECIPE_BY_ID[def?.recipe];
  if (recipe) return Object.keys(recipe.in).filter(c => c !== "energy");
  if (def?.combust) return def.combust.fuels;
  return [];
}

// The input larder's total capacity is split EVENLY across however many real commodities the
// recipe needs, so each gets its OWN guaranteed slice — a 2-input recipe (e.g. chipfab: crystals +
// metals) gets 40 each of an 80 total, a 3-input one (e.g. plasmafab) gets ~26.7 each. Without
// this a single over-supplied input (workers keep bringing whichever the treasury happens to have
// plenty of) can fill the WHOLE shared pool on its own, leaving zero room for whichever OTHER
// input the recipe is actually starved of — the factory then sits stalled forever on a "Starved"
// input it can never actually receive, since haul.js's inputRoom check (below) always reads 0.
/** The per-commodity input-buffer capacity of a building type (a factory OR a fuel-burning power
 * station), or 0 if it has none. */
export function inputCapOf(type) {
  const def = BUILDINGS[type];
  if (!def) return 0;
  const total = def.inputCap != null ? def.inputCap : ((def.recipe || def.combust) ? DEFAULT_FACTORY_INPUT : 0);
  if (total <= 0) return 0;
  const n = realInputComs(type).length;
  return n > 0 ? total / n : total;
}

/** Sum a commodity→qty buffer (order-independent → deterministic); 0 for a missing buffer. */
function bufTotal(buf) {
  let t = 0;
  if (buf) for (const c in buf) t += buf[c] || 0;
  return t;
}

/** How much is currently sitting in a building's output buffer (0 if none). */
export function storeTotal(building) { return bufTotal(building.store); }

/** The free room left in a building's output buffer (clamped ≥ 0). */
export function storeRoom(building) {
  return Math.max(0, storeCapOf(building.type) - storeTotal(building));
}

/** How much (of every commodity combined) is currently sitting in a factory's input buffer. */
export function inputTotal(building) { return bufTotal(building.input); }

/** The free room left for ONE SPECIFIC input commodity (clamped ≥ 0) — each real input commodity
 * gets its own independent slice of the larder (inputCapOf), so one oversupplied input can never
 * crowd out room for another the recipe still needs. @param {Building} building @param {string} com */
export function inputRoom(building, com) {
  return Math.max(0, inputCapOf(building.type) - (building.input?.[com] || 0));
}

// ---- Freighter cargo hold (Odyssey freight) ------------------------------------
// A freighter's `freight` is a multi-commodity hold (unlike a worker's single-slot `cargo`),
// capped by `def.cargoHold`. Lives here (not engine/galaxy.js, where the player-manual
// load/unload panel logic lives) so engine/haul.js can read a freighter's room/fill too — the
// worker↔freighter physical loading path — without importing galaxy.js, which itself imports
// engine/sim.js -> engine/haul.js and would otherwise be a cycle. galaxy.js re-exports both.

/** How much is currently aboard a freighter's hold (0 for a non-freighter unit). */
export function freightUsed(unit) { return unit ? bufTotal(unit.freight) : 0; }

/** A freighter's remaining hold room = its cargoHold minus what's aboard (0 for a non-freighter). */
export function freightRoom(unit) {
  const cap = unit ? (UNITS[unit.type]?.cargoHold || 0) : 0;
  return Math.max(0, cap - freightUsed(unit));
}

// Player-wide Refinery upgrades, arranged as two MUTUALLY EXCLUSIVE doctrines of
// two tiers each. You commit to Assault (offense) OR Bulwark (defense) —
// researching any upgrade of one doctrine locks the other — and can then deepen
// your chosen path with its Tier-2 upgrade (which requires the Tier-1, via the
// same prereqsMet machinery the tech tree uses). So "which upgrade" is a real
// strategic fork with an opportunity cost, not a buy-both no-brainer. Like the
// Odyssey tech tree's TECHS (engine/techtree.js), each entry is PAID ON ENQUEUE
// and DEVELOPED OVER TIME — `time` is seconds to develop at a tech-5 world,
// scaled by researchTimeScale — queued at a Refinery via production.js's
// researchUpgrade and ticked by the SAME updateResearch loop the Datacenter
// uses (it resolves TECHS or UPGRADES by building.type). Effects apply live,
// army-wide (and base-wide — see reinforcedPlating/reinforcedBulwark below), the
// instant a queued upgrade completes; multipliers stack multiplicatively in
// combat.js. Assault costs radioactives, Bulwark crystals — so a world's deposit
// specialty tilts which doctrine comes easier.
// `ico` is the doctrine's emblem (assault ⚔️, bulwark 🛡️, logistics 📦), reused on the Refinery
// research buttons so the doctrine reads at a glance — same iconography as the rest of the HUD.
export const UPGRADES = {
  overchargedWeapons: {
    id: "overchargedWeapons", name: "Overcharged Weapons", doctrine: "assault", tier: 1, ico: "⚔️",
    cost: { radioactives: 150 }, time: 25, desc: "+15% damage dealt by all combat units", damageDealtMult: 1.15,
  },
  overchargedCore: {
    id: "overchargedCore", name: "Overcharged Core", doctrine: "assault", tier: 2, ico: "⚔️",
    cost: { radioactives: 200, ore: 120 }, time: 32, requires: ["overchargedWeapons"],
    desc: "+15% more damage dealt (stacks with Overcharged Weapons)", damageDealtMult: 1.15,
  },
  // "all units and structures", not just combat units: attackDamage (engine/combat.js) applies
  // damageTakenMult to EVERY target it computes damage for — units AND buildings alike, with no
  // kind/role filter — so Bulwark already shields turrets, the Command Center, and Habitats too.
  // Bulwark is the defense doctrine for the army AND the base.
  reinforcedPlating: {
    id: "reinforcedPlating", name: "Reinforced Plating", doctrine: "bulwark", tier: 1, ico: "🛡️",
    cost: { crystals: 150 }, time: 25, desc: "-12% damage taken by all units and structures", damageTakenMult: 0.88,
  },
  reinforcedBulwark: {
    id: "reinforcedBulwark", name: "Reinforced Bulwark", doctrine: "bulwark", tier: 2, ico: "🛡️",
    cost: { crystals: 200, ore: 120 }, time: 32, requires: ["reinforcedPlating"],
    desc: "-12% more damage taken by all units and structures (stacks with Reinforced Plating)", damageTakenMult: 0.88,
  },
  // A third doctrine that isn't about the fight at all: Logistics trades combat
  // upgrades for economy and tempo. Committing to it locks Assault AND Bulwark
  // (and vice-versa) through the same committedDoctrine machinery, so "out-macro
  // them" is a real, mutually-exclusive plan against "out-fight them" — not a
  // free third buy. gatherYieldMult/produceTimeMult are read by gather.js and
  // production.js the same data-driven way the damage mults are read by combat.js.
  logisticsNetwork: {
    id: "logisticsNetwork", name: "Logistics Network", doctrine: "logistics", tier: 1, ico: "📦",
    cost: { crystals: 140 }, time: 25, desc: "+25% resource yield from every haul", gatherYieldMult: 1.25,
  },
  rapidFabrication: {
    id: "rapidFabrication", name: "Rapid Fabrication", doctrine: "logistics", tier: 2, ico: "📦",
    cost: { crystals: 160, ore: 120 }, time: 32, requires: ["logisticsNetwork"],
    desc: "-20% unit & building production time", produceTimeMult: 0.8,
  },
  // No multiplier field: unlike its two Logistics siblings above, this GATES a capability
  // (raises the recycling refund cap) rather than feeding the generic upgradeMult product — read
  // directly by id, the same way FREIGHTER_AI_TECH is (engine/recycle.js RECYCLE_TECH). Shares
  // that exact id with the Odyssey tech tree's own "recycling" node (engine/techtree.js) — only
  // one of the two trees is ever active in a given match, so the shared key is safe and lets
  // engine/recycle.js check a single flag regardless of mode.
  recycling: {
    id: "recycling", name: "Field Recycling", doctrine: "logistics", tier: 3, ico: "♻️",
    cost: { crystals: 180, ore: 140 }, time: 38, requires: ["rapidFabrication"],
    desc: "+30% of a recycled unit/building's cost reclaimed (up to an 80% cap)",
  },
  // Hard difficulty's economic edge (engine/aiDifficulty.js) — seeded straight onto
  // state.players.ai.upgrades at creation (engine/state.js), never researched, so it needs
  // none of a real entry's machinery: no cost, no time, no doctrine, no tier/requires. It rides
  // the exact same gatherYieldMult/produceTimeMult fields logisticsNetwork/rapidFabrication use —
  // gather.js/production.js need no changes at all to pick it up. `aiOnly` keeps it out of the
  // player-facing Refinery research panel and its cost fingerprint (hudSelection.js); having no
  // `doctrine` keeps it invisible to committedDoctrine (which now guards on `.doctrine`
  // explicitly — see below) and to aiEconomy.js's per-doctrine research path.
  hardEdge: {
    id: "hardEdge", name: "Hard Edge", aiOnly: true,
    gatherYieldMult: 1.1, produceTimeMult: 0.9,
  },
};

// Product of a multiplier field across a player's RESEARCHED upgrades (1 when
// none apply) — the single place combat/gather/production read upgrade effects.
// A new upgrade is then pure data: give it a field, and its multiplier is picked
// up wherever that field is consumed (damageDealtMult, damageTakenMult,
// gatherYieldMult, produceTimeMult, ...).
export function upgradeMult(upgrades, field) {
  let m = 1;
  if (!upgrades) return m;
  for (const id of Object.keys(upgrades)) {
    if (upgrades[id] && UPGRADES[id] && UPGRADES[id][field]) m *= UPGRADES[id][field];
  }
  return m;
}

// The doctrine a player has committed to — the doctrine of any upgrade they've
// researched, OR is still developing (queued at a Refinery, not yet complete) — or
// null if neither. Researching (or queuing) an upgrade of the other doctrine is
// then locked out (see production.js's researchUpgrade). The queued half matters
// because doctrine research now DEVELOPS OVER TIME instead of landing instantly
// (engine/techtree.js updateResearch): the cost is paid up front on enqueue, so the
// commitment has to bite the instant it's queued, not only once the timer finishes
// — otherwise both doctrines could sit queued side-by-side during the development
// window, defeating the whole "real commitment" point above. Scoped to `type ===
// "refinery"` specifically (not just "any researchQueue"): a Datacenter's OWN queue
// uses the SAME field name but resolves against TECHS, which shares no doctrine
// tokens with UPGRADES except the deliberately-overlapping "recycling" id — cross-
// checking a Datacenter job against UPGRADES here would misread that shared id as a
// Logistics commitment. `state.buildings` is optional-chained so a bare test state
// (no buildings map at all) reads as "nothing queued", identical to before this queued
// half existed.
// Guards on `.doctrine` itself, not just UPGRADES membership: a non-doctrine entry
// (hardEdge, Hard difficulty's seeded economic edge) must stay invisible here, the same
// way researchUpgrade's own doctrine-lock check already reads `def.doctrine` rather than
// just `UPGRADES[id]` — without this, hardEdge being seeded before any real research would
// make this return `undefined` forever, silently disabling the doctrine lock entirely.
export function committedDoctrine(state, owner) {
  const ups = state.players[owner].upgrades;
  for (const id of Object.keys(ups)) if (ups[id] && UPGRADES[id]?.doctrine) return UPGRADES[id].doctrine;
  for (const b of state.buildings?.values() || []) {
    if (b.owner !== owner || b.type !== "refinery" || !b.researchQueue) continue;
    for (const job of b.researchQueue) { const def = UPGRADES[job.techId]; if (def?.doctrine) return def.doctrine; }
  }
  return null;
}

// Skiff, Bastion and Lancer form a deliberate rock-paper-scissors: each
// one's bonusVs targets exactly the unit that would otherwise be its
// hardest matchup, and nothing beats all three at once.
//   Skiff   -> beats Lancer  (fast raiders shred a lightly-armored gun platform before it can find its range)
//   Bastion -> beats Skiff   (heavy armor shrugs off skiff fire and tears through light hulls up close)
//   Lancer  -> beats Bastion (armor-piercing rounds built specifically to punch through heavy plating)
export const UNITS = {
  worker: {
    id: "worker", name: "Worker", hp: 40, radius: 6, speed: 60,
    cost: { ore: 50 }, altCost: { biomass: 50 }, buildTime: 8, supplyCost: 1,
    // `altCost` is an EITHER/OR price: a worker can be trained on ore (the default) or on
    // biomass instead (engine/production.js queueProduction's `alt` flag) — so a crystal/ore-poor,
    // biomass-rich claim can still grow its workforce. The queued job remembers which it paid, so a
    // cancel refunds the right commodity.
    role: "worker", gatherRate: 10, cargoCap: 10,
    // Saturation: the first `minerSoftCap` workers on a deposit mine at full
    // rate; each one past that pulls only `minerFalloff` of a full share (see
    // gather.js's miningEfficiency), so over-piling a node has diminishing
    // returns and spreading out / expanding to a fresh field is a real call.
    // The cap matches the ~3 home seams and the 3 starting workers, so the
    // opening economy is never penalised.
    minerSoftCap: 3, minerFalloff: 0.4,
    sight: 110,
    // Can defend itself in a pinch — a weak short-range strike — but only when
    // explicitly ordered to attack. Workers never auto-acquire, so they don't
    // abandon the economy to go pick fights; a handful ganging up can drive off
    // a lone raider, but they're no substitute for real military units.
    attack: 4, range: 15, cooldown: 1.4,
    // The one economy unit, and it does everything: every build category, gather, AND
    // logistics — no specialization, no gate.
    buildCategories: ["infrastructure", "military", "industrial"], canGather: true, canLogistics: true,
  },
  ranger: {
    id: "ranger", name: "Ranger", hp: 50, radius: 6, speed: 115,
    cost: { ore: 45 }, buildTime: 10, supplyCost: 1,
    // A dedicated recon unit, built at the Command Center like a Worker. Cheap
    // and fragile — it scouts, it doesn't fight — with a token bite for
    // self-defence only (role "scout" ⇒ it never auto-acquires, so it won't wander
    // into a fight on its own; the attack fires only when explicitly ordered, like
    // a Worker's). Its edges are the three things a scout wants:
    role: "scout", attack: 6, range: 22, cooldown: 1.3,
    sight: 340,          // sees far — vision is the whole point of the unit
    allTerrain: true,    // ice fields and rough ground never slow it (movement.js honours this flag)
    // ...and a "scout mode" (issueScout / order type "scout") where it ranges the
    // map on its own, heading for the nearest unexplored ground — see scout.js.
  },
  colonyship: {
    id: "colonyship", name: "Colony Ship", hp: 600, radius: 13, speed: 48,
    cost: { ore: 500 }, buildTime: 40, supplyCost: 3,
    // The mobile seed of a base (Odyssey only): move it to a site and DEPLOY it
    // (engine/colony.js) into a Command Center; its colonists — the opening workers
    // — disembark on deploy. Its own non-combat role: unarmed (no `attack`, so it
    // can never be ordered to fight), never auto-acquires, and is transparent to the
    // army/threat scans — but the main-acquire still lets enemies shoot it, so it's a
    // real escort risk on the trek, not incidentally invincible. Pricier than the CC
    // (400) it replaces: the mobility premium.
    role: "colony", sight: 200,
    odysseyOnly: true,
  },
  skiff: {
    id: "skiff", name: "Skiff", hp: 72, radius: 7, speed: 90,
    cost: { ore: 100 }, buildTime: 12, supplyCost: 1,
    role: "combat", attack: 12, range: 40, cooldown: 1,
    sight: 160, aggroRange: 120,
    // Fast and cheap, but a touch fragile (72 hp): it wins by harassment and
    // numbers, not by trading blows, so its counters punish it faster now.
    bonusVs: { lancer: 10 },
  },
  bastion: {
    id: "bastion", name: "Bastion", hp: 160, radius: 9, speed: 68,
    cost: { ore: 160 }, buildTime: 18, supplyCost: 2,
    role: "combat", attack: 10, range: 44, cooldown: 1.2,
    sight: 130, aggroRange: 110,
    // Its job is to catch and crush Skiffs. It now OUT-RANGES the Skiff (44 vs 40) —
    // just barely, still under the AI's KITE_MIN_RANGE 50 so it stands and trades rather
    // than kiting — so a player-microed Skiff can no longer sit at 40 and orbit forever
    // outside the reach of the very unit built to hard-counter it. bonusVs trimmed to 10
    // (from 14) so the head-on time-to-kill stays close to before despite the extra reach.
    bonusVs: { skiff: 10 },
  },
  lancer: {
    id: "lancer", name: "Lancer", hp: 70, radius: 8, speed: 75,
    cost: { ore: 150 }, buildTime: 16, supplyCost: 2,
    role: "combat", attack: 16, range: 55, cooldown: 1.4,
    sight: 170, aggroRange: 130,
    bonusVs: { bastion: 20 },
    requires: ["foundry"],   // Tier-2: the answer to a massed Bastion ball, but you must tech to it
  },
  breacher: {
    id: "breacher", name: "Breacher", hp: 130, radius: 10, speed: 50,
    cost: { ore: 100, radioactives: 60 }, buildTime: 20, supplyCost: 2,
    role: "combat", attack: 10, range: 150, cooldown: 2,
    sight: 180, aggroRange: 150,
    // Deliberately OUTSIDE the Skiff/Lancer/Bastion triangle: no bonusVs
    // any unit type, and no unit gets bonusVs breacher. Its whole identity
    // is the class-wide structure bonus below plus outranging the turret.
    bonusVsBuildings: 30,
    prefersBuildings: true,
    requires: ["foundry"],   // Tier-2 siege: a tech investment, not a turn-one option
  },
  dreadnought: {
    id: "dreadnought", name: "Dreadnought", hp: 340, radius: 12, speed: 42,
    cost: { ore: 240, radioactives: 100 }, buildTime: 30, supplyCost: 4,
    role: "combat", attack: 26, range: 68, cooldown: 1.6,
    sight: 190, aggroRange: 150,
    // Tier-3 capital platform: tanky, long-reaching, heavy-hitting — a real
    // power spike you tech to (Barracks -> Foundry -> Arsenal). Deliberately
    // OUTSIDE the rock-paper-scissors triangle, like the Breacher: no bonusVs
    // any type and nothing bonuses against it, and its steep cost + 4 supply
    // mean cheaper massed units still trade cost-effectively into it — so it
    // anchors an army rather than hard-countering it.
    requires: ["arsenal"],
  },
  mender: {
    id: "mender", name: "Mender", hp: 70, radius: 8, speed: 78,
    cost: { ore: 90, crystals: 60 }, buildTime: 16, supplyCost: 2,
    // A pure-support drone: no attack of any kind (role "support" ⇒ it never
    // auto-acquires and combat.js never gives it a weapon). It closes a real
    // gap in the roster — until now every hp lost was permanent, so attrition
    // always favoured whoever could out-produce. A Mender lets a bruised army
    // heal between fights and lets a besieged base patch its buildings, so
    // *keeping* an army alive becomes a strategy, not just re-buying it.
    role: "support", requires: ["foundry"], sight: 130,
    // Heals every damaged friendly unit AND building within repairRange at
    // repairRate hp/sec each (see repair.js) — capped at each target's maxHp,
    // never itself, never something still under construction. Fragile and
    // unarmed, so it's a priority kill: escort it or lose it.
    repairRate: 6, repairRange: 110,
  },

  // The convoy freighter — a defenceless cargo hauler used only by the scenario
  // modes (engine/scenarios.js), never trained at a building. Slow, no weapon
  // (role "freighter" ⇒ it never auto-acquires and combat.js never arms it), but
  // a big hull so it can survive a raid long enough for its escort to answer.
  // supplyCost/sight satisfy the roster invariants; cost is empty (it's spawned,
  // not bought).
  freighter: {
    id: "freighter", name: "Freighter", hp: 220, radius: 11, speed: 46,
    cost: {}, buildTime: 0, supplyCost: 1,
    role: "freighter", sight: 130,
  },

  /* ---- ODYSSEY FREIGHT — cargo ships in three sizes. A jump's cargo hold is the combined
     `cargoHold` of the cargo ships staged for it (engine/galaxy.js freightCapacity), so hauling
     manufactured goods between worlds means building and staging shipping: a bigger fleet, or
     bigger ships, moves more per trip. Role "freighter" ⇒ they carry no weapon (combat.js never
     arms them), so they need escorting. Gated behind the Spaceport (no point shipping without a
     jump pad) and Odyssey-only, so the skirmish roster + its byte-identical replay are untouched.
     Their supplyCost also draws on the Spaceport's per-jump capacity, so a Bulk Freighter needs a
     bigger pad to lift alongside an army. ---- */
  hauler: {
    id: "hauler", name: "Hauler", hp: 180, radius: 9, speed: 58,
    cost: { ore: 90 }, buildTime: 12, supplyCost: 1,
    role: "freighter", sight: 130, cargoHold: 250, odysseyOnly: true, requires: ["spaceport"],
  },
  heavyhauler: {
    id: "heavyhauler", name: "Heavy Hauler", hp: 350, radius: 12, speed: 44,
    cost: { ore: 220 }, buildTime: 24, supplyCost: 3,
    role: "freighter", sight: 140, cargoHold: 650, odysseyOnly: true, requires: ["spaceport"],
  },
  bulkfreighter: {
    id: "bulkfreighter", name: "Bulk Freighter", hp: 600, radius: 15, speed: 32,
    cost: { ore: 480 }, buildTime: 42, supplyCost: 6,
    role: "freighter", sight: 150, cargoHold: 1600, odysseyOnly: true, requires: ["spaceport"],
  },

  /* ---- Tier-3 SPECIALTY units: one per "rare" surface commodity, so a world's
     deposit specialty shapes which elite you can field (radioactives already
     give the balanced Dreadnought above). All Arsenal-gated, all deliberately
     OUTSIDE the Skiff/Bastion/Lancer triangle — situational power, not a hard
     counter — and each pays in a commodity that was otherwise never spent (gas
     on Vesper/Glacius/Nimbus, ice on Glacius, relics on Korrath/Oort). ---- */
  wraith: {
    id: "wraith", name: "Wraith", hp: 84, radius: 8, speed: 104,
    cost: { ore: 120, gas: 60 }, buildTime: 18, supplyCost: 2,
    role: "combat", attack: 22, range: 58, cooldown: 0.85,
    sight: 175, aggroRange: 150,
    // Helium-3-fuelled strike craft: the roster's fastest combatant and its
    // hardest hitter per shot, but paper-thin — a glass cannon that shreds a
    // line and then melts to any focused fire. Gas turns a dead deposit into
    // the fuel for raids.
    requires: ["arsenal"],
  },
  aegis: {
    id: "aegis", name: "Aegis", hp: 360, radius: 11, speed: 48,
    cost: { ore: 160, ice: 90 }, buildTime: 26, supplyCost: 4,
    role: "combat", attack: 11, range: 26, cooldown: 1.3,
    sight: 140, aggroRange: 110,
    // A cryo-armoured wall: the tankiest hull in the game with an almost token gun. It
    // doesn't kill things — it projects a cryo-armour bubble that REDUCES the damage its
    // nearby allies take (guardAura, read in combat.js attackDamage), so the army fighting
    // around it lives longer wherever it stands — no need to pre-position it as a literal
    // wall, and enemy targeting doesn't have to cooperate. The anvil to the Wraith's hammer.
    // Faster now (48) so it can keep formation with the line it shields. Ice is its armour.
    guardAura: { range: 96, damageTakenMult: 0.82 },
    requires: ["arsenal"],
  },
  colossus: {
    id: "colossus", name: "Colossus", hp: 150, radius: 12, speed: 32,
    cost: { ore: 180, relics: 80 }, buildTime: 30, supplyCost: 4,
    role: "combat", attack: 42, range: 185, cooldown: 2.6,
    sight: 210, aggroRange: 185,
    // A reactivated ancient siege engine: out-ranges everything on the field —
    // the Sentinel Turret (130) and even the Breacher (150) — and hits like a
    // truck, but fires slowly, crawls, and is fragile for its cost, so it must
    // be screened or it's sniped/rushed down. A flat structure bonus makes it a
    // base-cracker. Relics (ancient tech) are its ammunition.
    bonusVsBuildings: 25,
    requires: ["arsenal"],
  },
  leviathan: {
    id: "leviathan", name: "Leviathan", hp: 900, radius: 14, speed: 34,
    cost: { ore: 300, ai: 3, plasmatorp: 4 }, buildTime: 60, supplyCost: 8,
    role: "combat", attack: 70, range: 200, cooldown: 2.4,
    sight: 220, aggroRange: 190,
    // The Strategic-tier capital ship: built only at a Star Dock (Odyssey-only),
    // costed in AI Cores + Plasma Torpedoes you must MANUFACTURE — the military
    // half of the endgame. Huge hull, long reach, a base-cracker's structure
    // bonus. Deliberately OUTSIDE the rock-paper-scissors triangle (no bonusVs,
    // nothing hard-counters it) — but 8 supply and a strategic-good price mean a
    // swarm of cheap units still trades into it, and every good spent on a
    // Leviathan is one not fed to the Antimatter Gate.
    bonusVsBuildings: 40,
    requires: ["stardock"],
    odysseyOnly: true,   // the endgame capital ship deliberately exceeds the skirmish specialists (see entities.test)
  },
  heliumbomb: {
    id: "heliumbomb", name: "Helium Bomb", hp: 80, radius: 10, speed: 60,
    cost: { gas: 150, antimatter: 3, plasmatorp: 3 }, buildTime: 45, supplyCost: 3,
    // A doomsday device, not a combatant: no `attack`, and role "bomb" (not
    // "combat") means it never auto-fights and the AI's army/threat scans
    // (which filter role === "combat") skip right past it, the same way they
    // skip the Colony Ship. It's still a perfectly legal target for an ENEMY's
    // own auto-acquire — combat.js's targeting picks the nearest live enemy of
    // any role, not just role:"combat" — so shooting an armed one is the worst
    // possible move (see engine/bomb.js: any hit on an armed bomb detonates it
    // instead of just damaging it).
    role: "bomb", sight: 150,
    requires: ["stardock"],
    odysseyOnly: true,
  },
};

// Every commodity that anything (a unit, a building, an upgrade) actually costs — computed
// once. Shared by aiWorkers.js's assignIdleWorkers (so a poor-economy world's AI, e.g. Glacius'
// ice/gas it can never spend, prefers nodes it can actually use) and market.js's AI barter (so
// it never treats an already-dead-end commodity as a real "bottleneck" to trade toward).
export const SPENDABLE = (() => {
  const coms = new Set();
  for (const d of [...Object.values(UNITS), ...Object.values(BUILDINGS), ...Object.values(UPGRADES)])
    for (const com of Object.keys(d.cost || {})) coms.add(com);
  return coms;
})();

export function canAfford(resources, cost) {
  return Object.entries(cost).every(([com, qty]) => (resources[com] || 0) >= qty);
}

export function payCost(resources, cost) {
  Object.entries(cost).forEach(([com, qty]) => { resources[com] = (resources[com] || 0) - qty; });
}
