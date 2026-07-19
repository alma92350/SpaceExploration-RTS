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
    produces: ["worker", "ranger"],
    isCommandCenter: true,
    supplyGrants: 10,   // the seeded CC already houses the starting 3 workers with room to grow
    sight: 220,
  },
  barracks: {
    id: "barracks", name: "Barracks", hp: 500, radius: 20,
    cost: { ore: 150 }, buildTime: 20,
    produces: ["skiff", "bastion", "lancer", "breacher", "dreadnought", "mender"],
    sight: 150,
  },
  refinery: {
    id: "refinery", name: "Refinery", hp: 400, radius: 18,
    cost: { ore: 200 }, buildTime: 16,
    sight: 140,
    dropOff: true,   // doubles as a resource drop-off — see the dropOff note below
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
    dropOff: true,   // an industrial building doubles as a resource drop-off
    // The military tech gate: a pure prerequisite building (no `produces`, so
    // it stays out of the rally UI). It unlocks the Tier-2 combat units
    // (Lancer, Breacher) — the Barracks still trains them. Ore-only on purpose,
    // so the Tier-2 units stay reachable on every world (ore is guaranteed near
    // every base) rather than being walled off on a crystal-poor map.
    requires: ["barracks"],
  },
  arsenal: {
    id: "arsenal", name: "Arsenal", hp: 550, radius: 18,
    cost: { ore: 220 }, buildTime: 26, sight: 140,
    dropOff: true,   // an industrial building doubles as a resource drop-off
    // The Tier-3 gate, one step past the Foundry: unlocks the Dreadnought
    // capital unit. Also a pure gate (no `produces`), ore-only so the tech path
    // stays reachable on every world.
    requires: ["foundry"],
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

// A building is a resource drop-off if it's the Command Center or an industrial
// building flagged `dropOff` (Refinery, Foundry, Arsenal). Workers deposit their
// haul at the NEAREST drop-off (see gather.js), so planting one of these cheaper,
// faster industrial buildings forward shortens a distant mining run without the
// cost of a whole second Command Center — a decentralized economy where the CC
// still keeps its unique roles (training workers, granting supply). Single source
// of truth for the routing, tests, and any future UI.
export function isDropOff(type) {
  const def = BUILDINGS[type];
  return !!(def && (def.isCommandCenter || def.dropOff));
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
  // A third doctrine that isn't about the fight at all: Logistics trades combat
  // upgrades for economy and tempo. Committing to it locks Assault AND Bulwark
  // (and vice-versa) through the same committedDoctrine machinery, so "out-macro
  // them" is a real, mutually-exclusive plan against "out-fight them" — not a
  // free third buy. gatherYieldMult/produceTimeMult are read by gather.js and
  // production.js the same data-driven way the damage mults are read by combat.js.
  logisticsNetwork: {
    id: "logisticsNetwork", name: "Logistics Network", doctrine: "logistics", tier: 1,
    cost: { crystals: 140 }, desc: "+25% resource yield from every haul", gatherYieldMult: 1.25,
  },
  rapidFabrication: {
    id: "rapidFabrication", name: "Rapid Fabrication", doctrine: "logistics", tier: 2,
    cost: { crystals: 160, ore: 120 }, requires: ["logisticsNetwork"],
    desc: "-20% unit & building production time", produceTimeMult: 0.8,
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
};

export function canAfford(resources, cost) {
  return Object.entries(cost).every(([com, qty]) => (resources[com] || 0) >= qty);
}

export function payCost(resources, cost) {
  Object.entries(cost).forEach(([com, qty]) => { resources[com] = (resources[com] || 0) - qty; });
}
