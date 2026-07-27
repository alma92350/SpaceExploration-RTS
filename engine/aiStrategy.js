/* ============================================================
   AI STRATEGY — a player-picked overlay, orthogonal to the archetype
   (engine/aiArchetypes.js). The archetype comes from the world/opponent and
   sets FLAVOR: faction, unit mix, which doctrine it researches. Strategy sets
   AGGRESSION: whether and when the AI voluntarily attacks, how big a standing
   army it bothers to keep, and how it reacts to being attacked. Picked once at
   setup (setup.js "AI Strategy" row) alongside difficulty, and applies in BOTH
   skirmish and Odyssey — see engine/ai.js (aiContext.strategy), engine/
   aiMilitary.js (offense timing), engine/aiEconomy.js (standing-army throttle),
   engine/aiIndustry.js (Helium Bomb) and engine/diplomacy.js (Odyssey grace).

   "default" carries no overrides at all, so a match that never picks a
   strategy — every save/test predating this feature, and the legacy call
   sites that still don't pass one — plays exactly as before: every field
   below is read with a `|| 1` (multipliers) or falsy-default (flags), so an
   absent strategy or an absent field is always a no-op.

   Multipliers COMPOSE with the archetype's own numbers rather than replacing
   them, the same way the archetype's own Odyssey overlay composes with its
   skirmish base (aiArchetypes.js) — so "an Aggressive Rusher" is even more
   aggressive than either alone, and "an Economic Economist" out-turtles a
   default one, instead of every archetype flattening into one strategy's
   numbers.
   ============================================================ */

"use strict";

export const STRATEGIES = {
  default: {
    name: "Adaptive",
    desc: "Plays true to its archetype — no extra aggression or restraint.",
  },
  aggressive: {
    name: "Aggressive",
    desc: "Attacks earlier and with less, and in Odyssey forces the issue instead of waiting out diplomacy.",
    // OFFENSE (both modes): commits sooner (attackTimeoutMult), with a smaller
    // muster (armyAttackSizeMult), and holds less back at home (garrisonMult) —
    // see engine/aiMilitary.js aiOffense, which multiplies these onto the
    // archetype's own attackTimeout/armyAttackSize/garrison.
    attackTimeoutMult: 0.55,
    armyAttackSizeMult: 0.6,
    garrisonMult: 0.4,
    // ODYSSEY DIPLOMACY: composes with the archetype's own odyssey overlay
    // (aiArchetypes.js graceMult/grievanceMult) — see engine/diplomacy.js.
    // Shrinks the opening grace window hard and sours faster on losses, so an
    // Aggressive neighbour turns hostile — and presses first — well before a
    // default one would, on ANY world, not just a Rusher's.
    graceMult: 0.2,
    grievanceMult: 1.6,
    // SUPERWEAPON (engine/aiSuperweapon.js): once a Helium Bomb is built, walk
    // it to the current attack target and trigger it there, rather than
    // leaving it as a purely defensive home trap (every strategy gets that
    // much for free — see aiSuperweapon.js).
    useBombOffensively: true,
  },
  economic: {
    name: "Economic",
    desc: "Keeps a minimal standing defense while it builds its economy — but rearms fast the instant it's attacked.",
    // STANDING ARMY (engine/aiEconomy.js aiProduceAndFortify): stop feeding the
    // unit-mix cycle once the home-army headcount reaches this — a token guard,
    // not a real force — freeing that ore for economy/industry instead.
    standingArmyCap: 3,
    // WAR FOOTING: the instant the AI can SEE enemy combat units pressing its
    // base (the same signal aiMilitary's recall already reacts to), the cap
    // above is lifted by this multiplier for warFootingTime seconds — so being
    // attacked is what turns "minimal defense" into a real production push,
    // exactly the brief. Decays back to the minimal cap once the threat's been
    // gone this long.
    warFootingMult: 5,
    warFootingTime: 75,
    // OFFENSE: never volunteers into a fight on its own (neverInitiates guards
    // both the skirmish threshold-commit and the Odyssey hostility-muster in
    // aiMilitary.js) — it only ever fights defensively. attackTimeoutMult still
    // stretches the skirmish desperation-timeout (the one commit neverInitiates
    // does NOT suppress) far out, so an all-turtle mirror match still resolves
    // eventually rather than relying solely on the score-based time limit.
    neverInitiates: true,
    attackTimeoutMult: 7,
    // A lighter static defense to match "minimal" (still real — cheap and
    // passive, unlike the standing army above).
    turretCountMult: 0.6,
    // Leans further into economy than its archetype might on its own.
    workerTargetMult: 1.25,
    // INDUSTRY (engine/aiIndustry.js): always climbs the deep factory chain —
    // Plasma Rig included — once teched for it, even paired with a Rusher/
    // Balanced archetype that wouldn't normally bother (archetype.wantsRefinery
    // false). Pure economy means using every economic capability in the game.
    wantsIndustryAlways: true,
  },
  matching: {
    name: "Force Parity",
    desc: "Sizes its army to mirror whatever it's seen of the enemy's, so no attack catches it outmatched.",
    // STANDING ARMY: instead of a fixed cap, the target continuously tracks
    // the enemy combat units the AI can actually SEE right now (its own fog —
    // engine/aiMilitary.js visibleEnemyForceCount), with a buffer above parity
    // and a floor so a yet-unscouted enemy still gets a minimal home guard.
    matchEnemyForce: true,
    matchBuffer: 1.15,
    matchFloor: 3,
    // OFFENSE: purely reactive, like Economic — parity is a deterrent/defense
    // plan, not a wind-up to attack. Same long desperation-timeout safety net.
    neverInitiates: true,
    attackTimeoutMult: 7,
  },
};

/** The active strategy for this match — STRATEGIES.default if unset/unknown, so every existing
 * save, test, and call site that predates this feature (or just leaves it unset) is unaffected. */
export function strategyFor(state) {
  return STRATEGIES[state.ai.strategy] || STRATEGIES.default;
}
