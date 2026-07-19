/* ============================================================
   Unit & building definitions for the first skirmish slice.
   Costs are in the planet's own deposit commodities (see engine/map.js)
   so the resources you gather are the resources you spend — no separate
   RTS-only currency.
   ============================================================ */

"use strict";

export const BUILDINGS = {
  command: {
    id: "command", name: "Command Center", hp: 1000, radius: 26,
    cost: { ore: 400 }, buildTime: 30,   // steep + slow: an expansion is a long-game commitment
    // The starting CC is still seeded finished by state.js's seedPlayer —
    // makeBuilding without { constructing: true } spawns complete regardless
    // of buildTime. cost/buildTime only gate the issueBuild path.
    produces: ["worker"],
    isCommandCenter: true,
    supplyGrants: 10,   // the seeded CC already houses the starting 3 workers with room to grow
    sight: 220,
  },
  barracks: {
    id: "barracks", name: "Barracks", hp: 500, radius: 20,
    cost: { ore: 150 }, buildTime: 20,
    produces: ["skiff", "bastion", "lancer", "breacher"],
    sight: 150,
  },
  refinery: {
    id: "refinery", name: "Refinery", hp: 400, radius: 18,
    cost: { ore: 200 }, buildTime: 16,
    sight: 140,
    // No `produces` — it researches upgrades instead of building units,
    // which is also what keeps it out of the rally-point UI (input.js
    // only offers that for buildings with a `produces` list).
  },
  turret: {
    id: "turret", name: "Sentinel Turret", hp: 350, radius: 12,
    cost: { ore: 150, crystals: 100 }, buildTime: 12,
    sight: 170,
    // Static defense: same combat stat names units use, so combat.js's
    // acquireTarget/attackDamage apply verbatim. aggroRange === range on
    // purpose — a turret can't chase, so acquiring beyond range is useless.
    attack: 20, range: 130, cooldown: 1, aggroRange: 130,
  },
  habitat: {
    id: "habitat", name: "Habitat", hp: 250, radius: 14,
    cost: { ore: 75 }, buildTime: 10,
    supplyGrants: 8,   // ~one economist mix cycle's worth of headroom per dome
    sight: 100,
    // No `produces` — like the Refinery, this keeps it out of the
    // rally-point UI and rally rendering automatically. Softest building
    // on the roster (hp 250): a legitimate raid target to choke supply.
  },
};

// One-time, player-wide purchases from a completed Refinery. Applied as
// live multipliers in combat.js rather than baked into unit stats at
// spawn, so they affect a player's whole army immediately — including
// units already on the field — not just future production.
export const UPGRADES = {
  reinforcedPlating: {
    id: "reinforcedPlating", name: "Reinforced Plating", cost: { crystals: 150 },
    desc: "-15% damage taken by all combat units", damageTakenMult: 0.85,
  },
  overchargedWeapons: {
    id: "overchargedWeapons", name: "Overcharged Weapons", cost: { radioactives: 150 },
    desc: "+20% damage dealt by all combat units", damageDealtMult: 1.2,
  },
};

// Skiff, Bastion and Lancer form a deliberate rock-paper-scissors: each
// one's bonusVs targets exactly the unit that would otherwise be its
// hardest matchup, and nothing beats all three at once.
//   Skiff   -> beats Lancer  (fast raiders shred a lightly-armored gun platform before it can find its range)
//   Bastion -> beats Skiff   (heavy armor shrugs off skiff fire and tears through light hulls up close)
//   Lancer  -> beats Bastion (armor-piercing rounds built specifically to punch through heavy plating)
export const UNITS = {
  worker: {
    id: "worker", name: "Worker", hp: 40, radius: 6, speed: 60,
    cost: { ore: 50 }, buildTime: 8, supplyCost: 1,
    role: "worker", gatherRate: 10, cargoCap: 10,
    sight: 110,
    // Can defend itself in a pinch — a weak short-range strike — but only when
    // explicitly ordered to attack. Workers never auto-acquire, so they don't
    // abandon the economy to go pick fights; a handful ganging up can drive off
    // a lone raider, but they're no substitute for real military units.
    attack: 4, range: 15, cooldown: 1.4,
  },
  skiff: {
    id: "skiff", name: "Skiff", hp: 80, radius: 7, speed: 90,
    cost: { ore: 100 }, buildTime: 12, supplyCost: 1,
    role: "combat", attack: 12, range: 40, cooldown: 1,
    sight: 160, aggroRange: 120,
    bonusVs: { lancer: 10 },
  },
  bastion: {
    id: "bastion", name: "Bastion", hp: 160, radius: 9, speed: 60,
    cost: { ore: 160 }, buildTime: 18, supplyCost: 2,
    role: "combat", attack: 10, range: 18, cooldown: 1.2,
    sight: 130, aggroRange: 100,
    bonusVs: { skiff: 14 },
  },
  lancer: {
    id: "lancer", name: "Lancer", hp: 70, radius: 8, speed: 75,
    cost: { ore: 150 }, buildTime: 16, supplyCost: 2,
    role: "combat", attack: 16, range: 55, cooldown: 1.4,
    sight: 170, aggroRange: 130,
    bonusVs: { bastion: 20 },
  },
  breacher: {
    id: "breacher", name: "Breacher", hp: 100, radius: 10, speed: 50,
    cost: { ore: 100, radioactives: 100 }, buildTime: 20, supplyCost: 2,
    role: "combat", attack: 10, range: 150, cooldown: 2,
    sight: 180, aggroRange: 150,
    // Deliberately OUTSIDE the Skiff/Lancer/Bastion triangle: no bonusVs
    // any unit type, and no unit gets bonusVs breacher. Its whole identity
    // is the class-wide structure bonus below plus outranging the turret.
    bonusVsBuildings: 30,
    prefersBuildings: true,
  },
};

export function canAfford(resources, cost) {
  return Object.entries(cost).every(([com, qty]) => (resources[com] || 0) >= qty);
}

export function payCost(resources, cost) {
  Object.entries(cost).forEach(([com, qty]) => { resources[com] = (resources[com] || 0) - qty; });
}
