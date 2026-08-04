// @ts-check
/* ============================================================
   AI behavior profiles, tied to which planet is chosen — the map
   picker also picks the opponent's temperament. See engine/ai.js for
   how each field is actually used.
   ============================================================ */

"use strict";

// ODYSSEY LABOUR (2026-08-04, docs/odyssey-ai-review.md §2.11 and its ledger rows). Every
// `odyssey.workerTarget` below is deliberately ~1.5x its archetype's skirmish crew, because the
// bench found the Odyssey worker economy could not BOOTSTRAP itself: aiEconomy.js's target is
// `archetype.workerTarget × strategy × difficulty + industryCount × 2`, so the only term that ever
// grows is a reward for industry the AI cannot afford to build until its income grows. On a
// strategy that also spends freely on units (default/aggressive — half the galaxy, since
// galaxy.js's neighbourAiProfile picks uniformly among four), the loop never starts: ferros/default
// sat at development 3 and thirteen workers for a full 40 minutes while ferros/economic, the SAME
// archetype behind an army cap, reached 27 and thirty-four. Raising the opening crew is what
// starts the loop — measured, on 176 runs across the full 11-world roster at Medium and Hard:
// mean score 0.690 -> 0.718, `dev-flatline` 25/176 -> 12/176, `hostile-but-idle` 9/176 -> 3/176,
// every strategy and both difficulties positive. Odyssey-only by construction (engine/ai.js's
// `arch` reader only consults this overlay when state.diplomacy exists), so the skirmish game is
// byte-identical — determinism.test.js covers that.
//
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
    // …and it NURSES the grudge: `forgiveness` halves the rate its stance recovers once you've
    // bled it, and doubles how long it keeps treating you as an active aggressor
    // (engine/diplomacy.js). A Warlord world should be the one that doesn't let it go.
    // workerTarget 9 (not the 6 this overlay originally carried) — see the LABOUR note above
    // ARCHETYPES: 6 was still a rush crew, and a Rusher that never banks past its next Skiff never
    // reaches the industry its own graduation is supposed to unlock. Lean by roster standards, and
    // still the smallest economy of the four.
    odyssey: { graceMult: 0.5, grievanceMult: 2, probeMin: 5, workerTarget: 9,
               expandWhenNodesBelow: 0.3, forgiveness: 0.5 },
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
    // …and forgives FAST: a trading world has a business reason to get back to coexistence, so its
    // stance recovers half again as quickly and it forgets a skirmish sooner (engine/diplomacy.js).
    // workerTarget 17 (not the 11 this overlay originally carried) — the LABOUR note above, at its
    // sharpest: ferros/default was the roster's worst development row (dev 3 after 40 minutes,
    // against dev 27 for the SAME archetype under Economic), purely because 11 miners cannot feed a
    // Barracks and bank a Smelter at once. The archetype whose whole identity is out-scaling has to
    // afford the scaling.
    odyssey: { workerTarget: 17, expandWhenNodesBelow: 0.55, probeMin: 4, forgiveness: 1.5 },
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
    // ODYSSEY overlay: the LABOUR line only. Balanced had NO overlay at all — it and the
    // Technologist were the two archetypes that never got one when the Rusher and the Economist
    // did — so vesper/glacius/pyralis/verdani mined an hours-long Odyssey on a six-worker skirmish
    // crew. Temperament is deliberately left absent (no graceMult/grievanceMult/forgiveness): an
    // even-handed neighbour SHOULD drift on the stock diplomacy constants, and that stays true —
    // every one of those fields is read with a `|| 1`, so adding this block changes labour and
    // nothing else.
    odyssey: { workerTarget: 9 },
  },
  // A FOURTH archetype (docs/improvement-proposals.md "A fourth archetype: the Technologist on
  // Kybernet"): eleven Odyssey worlds shared only rusher/economist/balanced, so a full session met
  // the same three temperaments over and over, and Kybernet — tech 10 (fastest research,
  // engine/techtree.js researchTimeScale) and industry 8 (fastest factories) — played as a generic
  // Economist despite being the roster's one dedicated tech-race world. No archetype ever fielded
  // the Colossus either, leaving one of the four Arsenal specialists dead content on the AI side.
  technologist: {
    name: "Technologist",
    workerTarget: 7,
    armyAttackSize: 7,
    attackTimeout: 220,
    // A SMALL, elite roster that skips straight up the tech ladder rather than the wide Tier-1
    // spam of a Rusher or the big even mix of an Economist/Balanced: one Tier-1 opener (Skiff),
    // then everything past it is Foundry- or Arsenal-gated. The Colossus is the point of the whole
    // archetype — no other mix in the game fields it, so the ancient relic-fuelled siege engine
    // finally sees play on a world with relics; the Wraith rounds out its other Arsenal option on a
    // gas world. effectiveMix's own surface-affordability filter drops whichever of the two a given
    // world can't pay for, exactly like it already does for Balanced's Wraith/Aegis pair — no extra
    // gating needed here.
    unitMix: ["skiff", "lancer", "lancer", "dreadnought", "colossus", "wraith"],
    turretCount: 2,
    maxBarracks: 2,
    expandWhenNodesBelow: 0.3,   // teches deep and needs the ore to fund it, but a small army needs less territory than an Economist's
    garrison: 2,            // a modest home guard — not all-in like a Rusher, not a big turtle like an Economist.
    doctrine: "assault",    // its elite units (Lancer/Dreadnought/Colossus) hit hard; leans offensive once teched.
    wantsRefinery: true,    // the deep-industry signal — Kybernet's whole identity is fastest research + fastest factories.
    faction: "syndicate",   // elite firepower on a lean economy — a small, teched-up roster over a wide one.
    // ODYSSEY overlay: a research capital wants STABILITY to protect its tech lead, not a prolonged
    // war — a longer opening peace than the stock 7 minutes (graceMult > 1, patient), and it lets go
    // of a grudge fast (forgiveness higher than even the already-fast-forgiving Economist's 1.5), so
    // a skirmish with it never calcifies into the permanent hostility a Rusher nurses.
    // …and workerTarget 11, which this overlay carried no value for at all until the LABOUR note
    // above: a research capital runs the roster's deepest factory chain, and every factory it
    // raises needs haulers (aiEconomy.js adds 2 per factory on TOP of this crew) — on 7 miners it
    // never got far enough up the chain to earn them.
    odyssey: { graceMult: 1.3, forgiveness: 1.75, workerTarget: 11 },
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
  kybernet: "technologist",   // the research capital fields its own small-elite, teched-up rival
  verdani: "balanced",        // a calm, map-controlling neighbour on the farm world
};

const ALL_ARCHETYPE = { ...PLANET_ARCHETYPE, ...ODYSSEY_EXTRA_ARCHETYPE };

/** @param {string} planetId @returns {Archetype} */
export function archetypeFor(planetId) {
  return ARCHETYPES[ALL_ARCHETYPE[planetId]] || ARCHETYPES.balanced;
}
