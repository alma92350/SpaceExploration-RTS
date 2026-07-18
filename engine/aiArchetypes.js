/* ============================================================
   AI behavior profiles, tied to which planet is chosen — the map
   picker also picks the opponent's temperament. See engine/ai.js for
   how each field is actually used.
   ============================================================ */

"use strict";

export const ARCHETYPES = {
  rusher: {
    name: "Rusher",
    workerTarget: 4,       // invests less in economy...
    armyAttackSize: 4,     // ...to throw a small army in early...
    attackTimeout: 90,     // ...and commits sooner even if it isn't ready.
    bastionRatio: 5,       // mostly cheap, fast Skiffs
  },
  economist: {
    name: "Economist",
    workerTarget: 8,       // builds up a bigger economy first...
    armyAttackSize: 9,     // ...for a much larger attacking force...
    attackTimeout: 200,    // ...and is patient about it.
    bastionRatio: 3,
  },
  balanced: {
    name: "Balanced",
    workerTarget: 6,
    armyAttackSize: 6,
    attackTimeout: 150,
    bastionRatio: 3,
  },
};

// Korrath: lawless "Warlord World" -> aggressive rush.
// Ferros: industrious "Mining World" -> economic buildup.
// Vesper: "Twilight World" -> balanced.
const PLANET_ARCHETYPE = {
  korrath: "rusher",
  ferros: "economist",
  vesper: "balanced",
};

export function archetypeFor(planetId) {
  return ARCHETYPES[PLANET_ARCHETYPE[planetId]] || ARCHETYPES.balanced;
}
