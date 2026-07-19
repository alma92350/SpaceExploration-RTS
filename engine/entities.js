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
  foundry: {
    id: "foundry", name: "Foundry", hp: 450, radius: 18,
    cost: { ore: 175 }, buildTime: 22, sight: 140,
    // The military tech gate: a pure prerequisite building (no `produces`, so
    // it stays out of the rally UI). It unlocks the Tier-2 combat units
    // (Lancer, Breacher) — the Barracks still trains them. Ore-only on purpose,
    // so the Tier-2 units stay reachable on every world (ore is guaranteed near
    // every base) rather than being walled off on a crystal-poor map.
    requires: ["barracks"],
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

// One-time, player-wide Refinery upgrades, arranged as two MUTUALLY EXCLUSIVE
// doctrines of two tiers each. You commit to Assault (offense) OR Bulwark
// (defense) — researching any upgrade of one doctrine locks the other — and can
// then deepen your chosen path with its Tier-2 upgrade (which requires the
// Tier-1, via the same prereqsMet machinery the tech tree uses). So "which
// upgrade" is a real strategic fork with an opportunity cost, not a buy-both
// no-brainer. Multipliers stack multiplicatively in combat.js and apply live to
// the whole army. Assault costs radioactives, Bulwark crystals — so a world's
// deposit specialty tilts which doctrine comes easier.
export const UPGRADES = {
  overchargedWeapons: {
    id: "overchargedWeapons", name: "Overcharged Weapons", doctrine: "assault", tier: 1,
    cost: { radioactives: 150 }, desc: "+15% damage dealt by all combat units", damageDealtMult: 1.15,
  },
  overchargedCore: {
    id: "overchargedCore", name: "Overcharged Core", doctrine: "assault", tier: 2,
    cost: { radioactives: 200, ore: 120 }, requires: ["overchargedWeapons"],
    desc: "+15% more damage dealt (stacks with Overcharged Weapons)", damageDealtMult: 1.15,
  },
  reinforcedPlating: {
    id: "reinforcedPlating", name: "Reinforced Plating", doctrine: "bulwark", tier: 1,
    cost: { crystals: 150 }, desc: "-12% damage taken by all combat units", damageTakenMult: 0.88,
  },
  reinforcedBulwark: {
    id: "reinforcedBulwark", name: "Reinforced Bulwark", doctrine: "bulwark", tier: 2,
    cost: { crystals: 200, ore: 120 }, requires: ["reinforcedPlating"],
    desc: "-12% more damage taken (stacks with Reinforced Plating)", damageTakenMult: 0.88,
  },
};

// The doctrine a player has committed to — the doctrine of any upgrade they've
// researched — or null if they haven't picked one yet. Researching an upgrade of
// the other doctrine is then locked out (see production.js's researchUpgrade).
export function committedDoctrine(state, owner) {
  const ups = state.players[owner].upgrades;
  for (const id of Object.keys(ups)) if (ups[id] && UPGRADES[id]) return UPGRADES[id].doctrine;
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
    cost: { ore: 50 }, buildTime: 8, supplyCost: 1,
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
    role: "combat", attack: 10, range: 24, cooldown: 1.2,
    sight: 130, aggroRange: 100,
    // Its job is to catch and crush Skiffs, so it's a bit quicker (68) and
    // longer-reaching (24) than before — a kiting Skiff can no longer simply
    // outrun and outrange the very unit built to hard-counter it.
    bonusVs: { skiff: 14 },
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
};

export function canAfford(resources, cost) {
  return Object.entries(cost).every(([com, qty]) => (resources[com] || 0) >= qty);
}

export function payCost(resources, cost) {
  Object.entries(cost).forEach(([com, qty]) => { resources[com] = (resources[com] || 0) - qty; });
}
