// @ts-check
/* ============================================================
   AI INTEL — what the AI BELIEVES about its opponent (docs/ai-adaptive-opponent.md)

   Every other reactive read in the AI answers a question about right now: are there enemies at my
   base (visibleThreatsNearHome), how many can I see (visibleEnemyForceCount), what do they field
   most (counterToPlayerArmy). Each drives one hardcoded reaction, and none of them survives losing
   sight of the enemy — entity sighting goes through the LIVE fog layer (isVisibleAt), so the
   instant a scout dies the AI's picture of its opponent is empty and it has no way to know it.

   This module holds the other kind of knowledge: a BELIEF about what sort of game the opponent is
   playing, which persists between sightings and decays when it goes unrefreshed. It is the first
   piece of AI state that can be WRONG — every other read is a fact about the current frame — and
   that is the point. An opponent model you can deceive is what makes scouting worth its cost and
   what makes killing the scout a real counter-play.

   THREE THINGS IT REPORTS, and why they are three and not one:

     mil / eco    Ore-value of the enemy's military and economic assets, as far as `owner` has seen.
     posture      mil / (mil + eco) — 0 is a pure economy game, 1 is a pure war game. THE read.
     confidence   How much has been seen, and how recently.

   Confidence is separate from posture on purpose. "I have seen nothing" and "I have seen an empty
   base" are completely different situations, and a single number cannot tell them apart —
   collapsing them is exactly how an AI ends up confidently raiding into an army it never scouted.
   Low confidence means hedge and go look, not "the enemy is weak".

   THE BELIEF IS A FADING HIGH-WATER MARK, not an average of sightings. Seeing two units near my
   base tells me the enemy has AT LEAST that much; it says nothing about the army parked at home.
   So a sighting can only ever raise the estimate, and time is the only thing that lowers it. That
   also makes the read stable under the thing that would otherwise wreck it — an army walking in and
   out of vision — while still letting a genuinely disbanded force fade away.

   PURE AND FOG-LIMITED. No clock beyond state.time, no randomness, no reach into the other side's
   fog: every read resolves from `owner`'s own state.fogs[owner] and otherOwner(owner), so it drives
   either seat in self-play (see engine/ai.js's runAI header). The engine-purity and determinism
   guards cover this file like any other.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { isVisibleAt } from "./fog.js";
import { otherOwner } from "./aiCommon.js";

// How long an unrefreshed belief takes to fade to nothing, in sim seconds. Four minutes: long
// enough that an army stepping out of vision for a fight doesn't erase itself, short enough that
// an AI still acting on five-minute-old intel is making a mistake the player earned by hiding.
export const INTEL_FADE = 240;

// Total ore-value of enemy assets at which the AI considers itself fully informed. Deliberately
// modest — this is "have I seen enough to have an opinion", not "have I seen everything", and an
// AI that refuses to act until it has scouted a whole base never acts at all.
export const INTEL_FULL = 900;

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Sum of a cost object's commodities — the same flat ore-value engine/victory.js's own
 * costValue uses, kept local so this file stays a leaf of entities/fog/aiCommon only.
 * @param {Object} [cost] @returns {number} */
function costValue(cost) {
  if (!cost) return 0;
  let v = 0;
  for (const com of Object.keys(cost)) v += cost[com] || 0;
  return v;
}

/**
 * Is this building a MILITARY investment? Derived from the definition itself rather than a
 * hardcoded id list, so a building added later classifies itself: anything that shoots (turret,
 * bastille, torpedobattery), projects a defensive aura (aegisbastion), or produces a combat unit
 * (barracks, stardock) is military; everything else — refineries, habitats, the whole industry
 * chain — is economy. A Command Center produces only workers and support, so it reads as economy,
 * which is right: it is the thing a greedy player is protecting, not the thing they are threatening
 * you with.
 * @param {Object} def   a BUILDINGS entry
 * @returns {boolean}
 */
export function isMilitaryBuilding(def) {
  if (!def) return false;
  if (def.attack > 0 || def.guardAura) return true;
  return (def.produces || []).some(t => UNITS[t] && UNITS[t].role === "combat");
}

/**
 * What `owner` can SEE of its enemy this instant, valued in ore. The live half of the belief —
 * updateIntel folds this into the persistent estimate below.
 * @param {State} state @param {string} [owner]
 * @returns {{ mil: number, eco: number }}
 */
export function sightEnemy(state, owner = "ai") {
  const enemyOwner = otherOwner(owner);
  const fog = state.fogs[owner];
  let mil = 0, eco = 0;
  for (const u of state.units.values()) {
    if (u.owner !== enemyOwner || !isVisibleAt(fog, u.x, u.y)) continue;
    const def = UNITS[u.type];
    if (!def) continue;
    if (def.role === "combat") mil += costValue(def.cost); else eco += costValue(def.cost);
  }
  for (const b of state.buildings.values()) {
    if (b.owner !== enemyOwner || !isVisibleAt(fog, b.x, b.y)) continue;
    const def = BUILDINGS[b.type];
    if (!def) continue;
    if (isMilitaryBuilding(def)) mil += costValue(def.cost); else eco += costValue(def.cost);
  }
  return { mil, eco };
}

/**
 * Fold this cycle's sighting into `owner`'s persistent belief. Called once per think cycle from
 * engine/ai.js's aiContext, before any phase reads it, so every phase in a cycle sees the same
 * picture.
 *
 * The update is `max(live, faded stored)` per channel — see the high-water-mark note in this
 * file's header. Only a sighting raises it; only time lowers it. `intelAt` is stamped whenever
 * ANYTHING enemy is in sight, including nothing-but-workers, because "I looked and saw a worker
 * line" is a genuine refresh of the belief, not a gap in it.
 *
 * @param {State} state @param {string} [owner] @returns {void}
 */
export function updateIntel(state, owner = "ai") {
  const controller = owner === "ai" ? state.ai : state.playerAi;
  if (!controller) return;
  const live = sightEnemy(state, owner);
  const last = controller.intelAt;
  // Linear fade rather than an exponential one: subtraction and division only, so it carries no
  // cross-engine float question the way a pow() would, and "how stale is this" stays something a
  // reader can do in their head.
  const age = last == null ? Infinity : Math.max(0, state.time - last);
  const keep = age >= INTEL_FADE ? 0 : 1 - age / INTEL_FADE;
  const mil = Math.max(live.mil, (controller.intelMil || 0) * keep);
  const eco = Math.max(live.eco, (controller.intelEco || 0) * keep);
  controller.intelMil = mil;
  controller.intelEco = eco;
  if (live.mil > 0 || live.eco > 0) controller.intelAt = state.time;
  else if (last == null) controller.intelAt = null;   // never seen anything yet — stay honestly blind
}

/**
 * `owner`'s current read of its enemy. `posture` is null when nothing has ever been seen — the
 * caller must handle "I do not know" separately from "they are peaceful", which is the whole reason
 * confidence exists (see the header).
 *
 * @param {State} state @param {string} [owner]
 * @returns {{ posture: number|null, confidence: number, mil: number, eco: number, age: number|null }}
 */
export function readEnemy(state, owner = "ai") {
  const controller = owner === "ai" ? state.ai : state.playerAi;
  if (!controller) return { posture: null, confidence: 0, mil: 0, eco: 0, age: null };
  const mil = controller.intelMil || 0, eco = controller.intelEco || 0;
  const total = mil + eco;
  const age = controller.intelAt == null ? null : Math.max(0, state.time - controller.intelAt);
  const freshness = age == null ? 0 : (age >= INTEL_FADE ? 0 : 1 - age / INTEL_FADE);
  return {
    posture: total > 0 ? mil / total : null,
    // Both halves must hold: a stale look at a whole base is as uninformative as a fresh glimpse
    // of one worker, and multiplying is what makes either one alone insufficient.
    confidence: clamp01(total / INTEL_FULL) * freshness,
    mil, eco, age,
  };
}

/**
 * Is the enemy GREEDY and worth punishing — visibly investing in economy over defence, with enough
 * seen to justify acting on it? The question Phase 2's raid trigger asks (docs/ai-adaptive-opponent.md).
 * Deliberately a named predicate rather than two inequalities at the call site: "when do we punish
 * greed" is a design decision that should be readable in one place and testable on its own.
 *
 * @param {State} state @param {string} [owner]
 * @param {{ maxPosture?: number, minConfidence?: number }} [opts]
 * @returns {boolean}
 */
export function enemyIsGreedy(state, owner = "ai", { maxPosture = 0.35, minConfidence = 0.25 } = {}) {
  const r = readEnemy(state, owner);
  if (r.posture == null) return false;   // never seen them — hedge and scout, never assume weakness
  return r.posture <= maxPosture && r.confidence >= minConfidence;
}
