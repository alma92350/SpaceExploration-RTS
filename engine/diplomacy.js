/* ============================================================
   Odyssey diplomacy — a neighbour's stance toward you, driven by scarcity AND by
   your own aggression. Each world's AI holds a stance from -1 (hostile) to +1
   (allied). It drifts toward a target set by how depleted the world's deposits
   are: while the ground is rich the neighbour stays cordial and coexists; as the
   world mines out, competition for what's left pulls it toward hostility. On top
   of that, every ship of theirs you destroy sours the stance immediately — so you
   can break the peace yourself, and a mined-out world tips into war on its own.

   The stance gates the AI's OFFENSE only (engine/ai.js): at peace the neighbour
   still builds its economy and army and still defends itself, it just doesn't
   launch attacks on you. So a world can be shared in harmony for a while and then
   turn — as its resources run short, or as you draw first blood. Odyssey-only: a
   skirmish AI has no `state.diplomacy` and fights as before. Pure and
   deterministic (grievance is read from the change in the neighbour's unit count,
   so it's substep-safe — no double counting across catch-up ticks).
   ============================================================ */

"use strict";

// Above this stance the neighbour holds its fire (peace); at or below it, war.
export const PEACE_THRESHOLD = -0.15;

const START_STANCE = 0.35;        // a new neighbour starts Cordial
const DRIFT_RATE = 0.05;          // how fast stance chases its scarcity target (per second)
const GRIEVANCE_PER_KILL = 0.04;  // stance lost per enemy ship you destroy on this world

// Odyssey is an economy-builder: the win path is ~25–35 minutes, so the neighbour
// must give you room to establish before it can turn. A GRACE window floors the
// scarcity target at cordial for the opening (empirically, two economies sharing a
// world mine it to the old ~23%-depletion war threshold in ~4 minutes — far too
// soon), and the target slope below is much gentler, so war arrives in the mid-game
// and escalates toward the endgame instead of ending the run before it starts.
const GRACE_TIME = 420;           // 7 minutes of guaranteed cordiality to establish an economy + defence
const GRACE_FLOOR = 0.2;          // the stance target can't fall below this during grace

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function createDiplomacy() {
  return { stance: START_STANCE, depletion: 0 };
}

// Recompute the world's depletion, apply grievance for the neighbour's fresh
// losses, then drift the stance toward the scarcity target: full deposits →
// +0.45 (cordial), ~30% mined out → hostile.
export function updateDiplomacy(state, dt) {
  const dip = state.diplomacy;

  let cur = 0, max = 0;
  for (const n of state.map.nodes) { cur += n.amount; max += n.max; }
  dip.depletion = max > 0 ? clamp(1 - cur / max, 0, 1) : 0;

  // Aggression: a drop in the neighbour's unit count since last tick is your
  // doing (only two sides fight), and each loss sours the stance at once. Read
  // from the count delta rather than kill events so multiple catch-up substeps
  // in one frame can't double-count. Rebuilding (count rising) grants nothing —
  // forgiveness comes only from the drift below.
  let ai = 0;
  for (const u of state.units.values()) if (u.owner === "ai") ai++;
  if (dip.lastAiUnits !== undefined && ai < dip.lastAiUnits) {
    dip.stance = clamp(dip.stance - (dip.lastAiUnits - ai) * GRIEVANCE_PER_KILL, -1, 1);
  }
  dip.lastAiUnits = ai;

  // Scarcity target: full deposits → +0.6 (cordial); war (below PEACE_THRESHOLD)
  // only once the world is ~47% mined out, and full hostility only near total
  // depletion — a gentle mid-to-late-game slide, not a minute-4 cliff. Floored to
  // cordial during the opening grace window regardless of how fast you strip-mine.
  let target = 0.6 - dip.depletion * 1.6;
  if (state.time < GRACE_TIME) target = Math.max(target, GRACE_FLOOR);
  dip.stance = clamp(dip.stance + (target - dip.stance) * Math.min(1, dt * DRIFT_RATE), -1, 1);
}

// True while the neighbour is holding its fire — read by tests / the HUD.
export function atPeace(state) {
  return !!state.diplomacy && state.diplomacy.stance > PEACE_THRESHOLD;
}

// Offensive intensity, 0..1, read by the AI's offense ramp (engine/ai.js): 0 while
// the neighbour is at peace, climbing linearly to 1 as the stance falls from the
// peace line to fully hostile (-1). Scales the AI's muster threshold, committed
// fraction, and wave cadence, so a peaceful world doesn't unleash a banked
// doomstack the instant it turns — it probes, then escalates. A skirmish has no
// state.diplomacy, so this returns 1 (full intensity) and the offense block
// collapses to its original size/timeout logic, leaving skirmish play unchanged.
export function hostility(state) {
  if (!state.diplomacy) return 1;
  const s = state.diplomacy.stance;
  if (s > PEACE_THRESHOLD) return 0;                                   // at peace: holds fire
  return clamp((PEACE_THRESHOLD - s) / (PEACE_THRESHOLD + 1), 0, 1);   // -0.15→0, -0.5→~0.41, -1→1
}

// A human-readable band for the HUD.
export function stanceLabel(stance) {
  if (stance <= -0.5) return "Hostile";
  if (stance <= PEACE_THRESHOLD) return "Wary";
  if (stance < 0.25) return "Neutral";
  if (stance < 0.6) return "Cordial";
  return "Allied";
}
