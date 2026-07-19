/* ============================================================
   AI behavior profiles, tied to which planet is chosen — the map
   picker also picks the opponent's temperament. See engine/ai.js for
   how each field is actually used.
   ============================================================ */

"use strict";

// unitMix is a repeating production cycle (see ai.js) — not a random
// weighting, so a profile's composition is exact and testable.
export const ARCHETYPES = {
  rusher: {
    name: "Rusher",
    workerTarget: 4,       // invests less in economy...
    armyAttackSize: 4,     // ...to throw a small army in early...
    attackTimeout: 90,     // ...and commits sooner even if it isn't ready.
    unitMix: ["skiff", "skiff", "skiff", "bastion"],   // pure Tier-1 aggression — no teching, so the rush isn't delayed by a Foundry
    turretCount: 0,        // no time or crystals to spare on static defense...
    maxBarracks: 1,        // ...and 4 workers can't even feed a second one;
    expandWhenNodesBelow: 0,   // its plan resolves long before home ore runs dry, so it never expands.
    garrison: 0,           // all-in: keeps nothing back, every unit joins the push.
    doctrine: "assault",   // all-in aggression favours the offensive upgrade path.
    faction: "syndicate",  // all-in firepower on a lean economy — the rush hits harder (factions.js)
  },
  economist: {
    name: "Economist",
    workerTarget: 8,       // builds up a bigger economy first...
    armyAttackSize: 9,     // ...for a much larger attacking force...
    attackTimeout: 200,    // ...and is patient about it.
    // Its out-scale identity spelled out: siege in the mix, proactive
    // expansion, two barracks feeding one cycle, and two turrets to hold home.
    unitMix: ["skiff", "skiff", "bastion", "skiff", "lancer", "bastion", "breacher", "dreadnought"],
    turretCount: 2,
    maxBarracks: 2,
    expandWhenNodesBelow: 0.4,   // grabs a second field while the first still has 40% left
    garrison: 3,           // turtles: holds three back to defend home while the surplus attacks.
    doctrine: "bulwark",   // out-scales and turtles behind turrets — the defensive path suits it.
    wantsRefinery: true,   // patient enough to bank for a Refinery and research its doctrine.
    faction: "miners",     // industry to reinforce the out-scale plan (factions.js)
  },
  balanced: {
    name: "Balanced",
    workerTarget: 6,
    armyAttackSize: 6,
    attackTimeout: 150,
    unitMix: ["skiff", "bastion", "lancer", "breacher"],   // even split, plus siege where the map allows it
    turretCount: 1,
    maxBarracks: 2,
    expandWhenNodesBelow: 0.25,   // expands later than the Economist, but still does
    garrison: 2,           // keeps a small home guard back on a massed attack.
    doctrine: "assault",   // leans aggressive once its army is up.
    wantsRefinery: true,   // builds a Refinery and researches its doctrine once teched.
    faction: "frontier",   // mobility & vision for even, map-controlling play (factions.js)
  },
};

// Which temperament each playable world hands the AI. Key order drives the
// map-picker's card order (main.js derives MAP_CHOICES from this), so the
// original three stay first and in their long-standing order; the rest of the
// curated roster follows. Every id is a real planet in data.js and every value
// a real ARCHETYPES key (aiArchetypes.test asserts both).
//   Korrath: lawless "Warlord World"    -> aggressive rush.
//   Ferros:  industrious "Mining World"  -> economic buildup.
//   Vesper:  "Twilight World"            -> balanced.
export const PLANET_ARCHETYPE = {
  korrath: "rusher",
  ferros: "economist",
  vesper: "balanced",
  glacius: "balanced",     // frozen ground slows everyone; a steady build suits it
  nimbus: "rusher",        // storm-shortened sight rewards closing fast
  pyralis: "balanced",     // long sightlines, even-handed play
  helix: "economist",      // a crystal-dense belt to out-scale on
  oort: "rusher",          // rich but lawless — grab and hit
  forge: "economist",      // a factory world begs to out-produce
};

export function archetypeFor(planetId) {
  return ARCHETYPES[PLANET_ARCHETYPE[planetId]] || ARCHETYPES.balanced;
}
