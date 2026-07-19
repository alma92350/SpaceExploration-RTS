/* ============================================================
   Odyssey diplomacy — a neighbour's stance toward you, driven by scarcity. Each
   world's AI holds a stance from -1 (hostile) to +1 (allied). It drifts toward a
   target set by how depleted the world's deposits are: while the ground is rich
   the neighbour stays cordial and coexists; as the world mines out, competition
   for what's left turns it hostile and it comes for you.

   The stance gates the AI's OFFENSE only (engine/ai.js): at peace the neighbour
   still builds its economy and army and still defends itself, it just doesn't
   launch attacks on you. So a world can be shared in harmony for a long while and
   then turn — exactly as its resources run short. Odyssey-only: a skirmish AI has
   no `state.diplomacy` and fights as before. Pure and deterministic.
   ============================================================ */

"use strict";

// Above this stance the neighbour holds its fire (peace); at or below it, war.
export const PEACE_THRESHOLD = -0.15;

const START_STANCE = 0.35;   // a new neighbour starts Cordial
const DRIFT_RATE = 0.03;     // how fast stance chases its scarcity target (per second)

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function createDiplomacy() {
  return { stance: START_STANCE, depletion: 0 };
}

// Recompute the world's depletion and drift the stance toward the scarcity
// target: full deposits → +0.4 (cordial), mined out → -1.0 (hostile).
export function updateDiplomacy(state, dt) {
  const dip = state.diplomacy;
  let cur = 0, max = 0;
  for (const n of state.map.nodes) { cur += n.amount; max += n.max; }
  dip.depletion = max > 0 ? clamp(1 - cur / max, 0, 1) : 0;

  const target = 0.4 - dip.depletion * 1.4;
  dip.stance = clamp(dip.stance + (target - dip.stance) * Math.min(1, dt * DRIFT_RATE), -1, 1);
}

// True while the neighbour is holding its fire — read by the AI's offense gate.
export function atPeace(state) {
  return !!state.diplomacy && state.diplomacy.stance > PEACE_THRESHOLD;
}

// A human-readable band for the HUD.
export function stanceLabel(stance) {
  if (stance <= -0.5) return "Hostile";
  if (stance <= PEACE_THRESHOLD) return "Wary";
  if (stance < 0.25) return "Neutral";
  if (stance < 0.6) return "Cordial";
  return "Allied";
}
