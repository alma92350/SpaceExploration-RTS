/* ============================================================
   AI DIFFICULTY — the Easy/Medium/Hard pick from the splash screen, orthogonal to
   both the archetype (engine/aiArchetypes.js — which planet/temperament) and the
   player-picked strategy (engine/aiStrategy.js — whether/when it voluntarily
   attacks). Bundles the two original dials — how FAST the opponent acts (aiApm)
   and whether it MICROS its army (aiMicro) — plus the picker's own label/note.
   This is the ONE list of valid difficulty keys: it drives the Easy/Medium/Hard
   buttons in setup.js AND (via boot.js's difficultyDials, which looks a key up in
   this same array) the AI dials a match actually runs with — so a key can never
   exist in one place and not the other, which used to let a mismatched difficulty
   silently downgrade to Medium instead of erroring.

   Economic dials land here as more fields on an entry, read through
   difficultyFor(state) the same defensive way engine/aiStrategy.js's
   strategyFor(state) already reads STRATEGIES — a multiplier field with `|| 1`
   at its use site, a flag read falsy — so an absent field or a legacy/unknown key
   composes as a no-op. Medium carries none of them at all (byte-identical to
   unset), same as STRATEGIES.default — it's the baseline every dial is relative to.

   Tier 1 dials (worker target, war patience, economic edge) compose
   MULTIPLICATIVELY on top of whatever the archetype and player-picked strategy
   already contribute — the same relationship Aggressive/Economic/Force Parity
   already have with the archetype's own Odyssey overlay (aiArchetypes.js) — so
   this is one more layer, not a replacement:
     • workerTargetMult   — aiEconomy.js's workerTarget formula.
     • graceMult/grievanceMult — diplomacy.js's updateDiplomacy war-onset composition.
     • economicEdge       — seeds the synthetic `hardEdge` UPGRADES entry
       (entities.js) onto the AI's own upgrades at creation (engine/state.js), which
       gather.js/production.js already pick up via the existing generic upgradeMult
       — no plumbing changes needed there at all.
   ============================================================ */

"use strict";

export const DIFFICULTY_OPTIONS = [
  { label: "Easy", mult: "easy", note: "slow · no micro", aiApm: 20, aiMicro: false,
    workerTargetMult: 0.8, graceMult: 1.15, grievanceMult: 0.85 },
  { label: "Medium", mult: "medium", note: "a fair fight", aiApm: 65, aiMicro: false },
  { label: "Hard", mult: "hard", note: "fast · focus-fire · kite", aiApm: 140, aiMicro: true,
    workerTargetMult: 1.25, graceMult: 0.9, grievanceMult: 1.15, economicEdge: true },
];

/** The active difficulty entry for this match — DIFFICULTY_OPTIONS' medium entry when
 * state.ai.difficulty is unset or names a key that isn't in the list, the same fallback
 * boot.js's difficultyDials already applies before a match even starts. */
export function difficultyFor(state) {
  return DIFFICULTY_OPTIONS.find(o => o.mult === state.ai.difficulty)
      || DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
}
