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

import { chargingPlayerWonder } from "./wonder.js";

// Above this stance the neighbour holds its fire (peace); at or below it, war.
export const PEACE_THRESHOLD = -0.15;

const START_STANCE = 0.35;        // a new neighbour starts Cordial
const DRIFT_RATE = 0.05;          // how fast stance chases its scarcity target (per second)
const GRIEVANCE_PER_KILL = 0.04;  // stance lost per enemy ship you destroy on this world

// LATE-GAME CREEP (Tier 4): after the opening grace, a slow time-based resentment
// that grows without bound, so hostility never plateaus — overstay anywhere and the
// neighbour eventually turns, and a partly-mined world keeps sinking instead of
// parking at a mild "Wary". Tuned so war ONSET stays scarcity-driven (negligible at
// grace-end) and only the true late game bites; validated by a defended-base probe.
const CREEP_RATE = 0.0004;        // stance-target lost per second past grace

// THE FINALE (Tier 4): a charging player Gate is a bid to win the whole galaxy, so
// the neighbour drops diplomacy and mobilises — harder the closer the Gate is to
// firing. This only ever LOWERS the target and is applied LAST (below), so it
// overrides even a paid truce: you cannot buy your way out of the endgame.
const GATE_WAR_TARGET = -0.3;     // a charging Gate floors the target at war (h≈0.18) the moment it starts...
const GATE_WAR_SLOPE  = 0.7;      // ...sinking to fully hostile (-1.0, h=1) at full charge

// TRIBUTE (Tier 4): spend universal credits to appease the neighbour for a while.
// A stopgap, never a subscription — the truce window decays and each tribute costs
// geometrically more, so permanent bought peace is arithmetically impossible.
export const APPEASE_TIME = 120;      // seconds a tribute holds the neighbour's fire (~one wave cadence)
const APPEASE_FLOOR = 0.0;            // the truce target: holds fire (Neutral), stops short of friendship
export const TRIBUTE_BASE_COST = 200; // credits for the first appeasement
const TRIBUTE_COST_GROWTH = 1.55;     // each further tribute costs 1.55× more

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
  return { stance: START_STANCE, depletion: 0, tributes: 0 };
}

// Cost of the NEXT tribute, escalating geometrically with how many you've already
// paid — so appeasement is a stopgap that gets prohibitively expensive, never a
// permanent peace you can afford to renew forever.
export function tributeCost(dip) {
  return Math.round(TRIBUTE_BASE_COST * Math.pow(TRIBUTE_COST_GROWTH, (dip && dip.tributes) || 0));
}

// Spend universal credits (galaxy.credits — NOT the local economy) to appease this
// world's neighbour: snap the stance up to the truce line and open a decaying window
// during which the drift target can't fall below it (see updateDiplomacy), so the
// drift won't instantly claw back what you paid for. Odyssey-only and a no-op without
// funds. Pure and deterministic given (galaxy, state) + state.time — no wall-clock,
// no RNG — so it's replay-safe as a player input. Returns whether it happened.
export function offerTribute(galaxy, state) {
  const dip = state && state.diplomacy;
  if (!dip || !galaxy) return false;                 // skirmish / no galaxy ⇒ no-op
  const cost = tributeCost(dip);
  if (galaxy.credits < cost) return false;           // can't afford ⇒ no spend, no-op
  galaxy.credits -= cost;
  dip.tributes = (dip.tributes || 0) + 1;
  dip.stance = clamp(Math.max(dip.stance, APPEASE_FLOOR), -1, 1);   // instant stand-down to the truce line
  dip.appeaseUntil = state.time + APPEASE_TIME;       // the floor that decays — bought peace is temporary
  dip.warAnnounced = false;                           // so a later relapse re-fires the war toast
  return true;
}

// Recompute the world's depletion, apply grievance for the neighbour's fresh
// losses, then drift the stance toward the scarcity target: full deposits →
// +0.45 (cordial), ~30% mined out → hostile.
export function updateDiplomacy(state, dt) {
  const dip = state.diplomacy;
  const wasPeaceful = dip.stance > PEACE_THRESHOLD;

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

  // LATE-GAME CREEP: past grace, resentment grows linearly and without bound, so the
  // hostility curve never plateaus. Zero at grace-end (onset stays scarcity-driven),
  // it only bites deep into a long game — an overstay turns lethal, a mined-out world
  // is already at -1 so this can't worsen the worst case, only the mild middle band.
  if (state.time > GRACE_TIME) target -= CREEP_RATE * (state.time - GRACE_TIME);

  // Opening grace: floor the target at cordial for the first 7 minutes so a fresh
  // world (incl. a Gate briefly charging on a new background colony) can't be dragged
  // to war before the player has established.
  if (state.time < GRACE_TIME) target = Math.max(target, GRACE_FLOOR);

  // PAID TRUCE (tribute): a decaying window in which the target can't fall below the
  // truce line, so the drift doesn't instantly undo an appeasement. Overridden by the
  // finale clause below — a tribute buys peace against scarcity/creep, never against a
  // galaxy-winning Gate.
  if (dip.appeaseUntil !== undefined && state.time < dip.appeaseUntil)
    target = Math.max(target, APPEASE_FLOOR);

  // THE FINALE, applied LAST so it overrides the paid truce (unappeasable) — but only
  // past grace, so it never provokes during the opening. A charging player Gate sinks
  // the target from just-past-war (charge→0) to fully hostile (charge→1). Math.min:
  // on an already-hostile world it changes nothing; on a still-rich world where the
  // player rushed a Gate, it's what guarantees the finale is fought, not waited out.
  const gate = chargingPlayerWonder(state);
  if (gate && state.time >= GRACE_TIME)
    target = Math.min(target, GATE_WAR_TARGET - GATE_WAR_SLOPE * gate.charge);

  dip.stance = clamp(dip.stance + (target - dip.stance) * Math.min(1, dt * DRIFT_RATE), -1, 1);

  // The moment the neighbour crosses from peace into war, fire a one-time heads-up
  // (boot.js turns it into a toast) — the offensive ramp is silent otherwise, so a
  // first attack can land with no warning. Fires once per world (survives save/load
  // via the persisted flag); on a background colony the event is drained unused.
  if (wasPeaceful && dip.stance <= PEACE_THRESHOLD && !dip.warAnnounced) {
    dip.warAnnounced = true;
    state.events.push({ type: "neighbourHostile", owner: "player" });
  }
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
