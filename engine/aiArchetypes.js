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
    // ODYSSEY overlay (read only when state.diplomacy exists, so the skirmish path stays
    // byte-identical). In the play-forever meta the skirmish desperation-timeout never
    // fires and diplomacy guarantees a long peace, so the Rusher's identity vanished —
    // it sat on 4 workers forever and probed in the same 3-unit dribble as everyone else.
    // Here it turns hostile in HALF the grace window, sours faster when you bleed it, sends
    // BIGGER early probes, and — crucially for a mode with no end — sustains an economy and
    // expands, so a "Warlord World" actually plays like the galaxy's most dangerous neighbour.
    odyssey: { graceMult: 0.5, grievanceMult: 2, probeMin: 5, workerTarget: 6, expandWhenNodesBelow: 0.3 },
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
    // ODYSSEY overlay: stays patient (full grace, no extra grievance) but leans into the
    // long game — a fatter worker economy, earlier/greedier expansion, and probes that
    // start a touch larger, so a settled Economist neighbour steadily out-scales into a
    // real threat rather than sending the same 3-unit probe forever.
    odyssey: { workerTarget: 11, expandWhenNodesBelow: 0.55, probeMin: 4 },
  },
  balanced: {
    name: "Balanced",
    workerTarget: 6,
    armyAttackSize: 6,
    attackTimeout: 150,
    // Even split, plus siege where the map allows it — and, on a world that
    // deposits gas or ice, its specialty Tier-3 unit (Wraith / Aegis). Those
    // entries are dropped by effectiveMix on worlds that can't pay for them
    // (every economist/rusher world, and pyralis), so the cycle is unchanged
    // there; only Vesper and Glacius actually fold them in.
    unitMix: ["skiff", "bastion", "lancer", "breacher", "wraith", "aegis"],
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

// Extra worlds the ODYSSEY roster can settle, beyond the skirmish nine. Kept in a
// SEPARATE table (not folded into PLANET_ARCHETYPE) on purpose: the skirmish map
// picker and its full-resolve tests iterate Object.keys(PLANET_ARCHETYPE), so
// freezing that at nine keeps every skirmish match byte-identical and adds no new
// resolve tests, while archetypeFor still resolves these Odyssey-only worlds.
// Their whole point is economic identity from data.js stats the engine already
// reads — Kybernet's tech 10 (fastest research, engine/techtree.js) and industry 8
// (fastest factories, engine/industry.js), Verdani the low-industry agri contrast
// where finished goods sell dear (engine/market.js). Temperament only sets the
// neighbour's combat style, exactly as for the skirmish nine.
export const ODYSSEY_EXTRA_ARCHETYPE = {
  kybernet: "economist",   // a patient tech-race rival on the research capital
  verdani: "balanced",     // a calm, map-controlling neighbour on the farm world
};

const ALL_ARCHETYPE = { ...PLANET_ARCHETYPE, ...ODYSSEY_EXTRA_ARCHETYPE };

export function archetypeFor(planetId) {
  return ARCHETYPES[ALL_ARCHETYPE[planetId]] || ARCHETYPES.balanced;
}
