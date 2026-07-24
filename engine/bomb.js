/* ============================================================
   The Helium Bomb (engine/entities.js UNITS.heliumbomb): a mobile doomsday
   device, built unarmed — free to move without risk. Once the player ARMS it
   (a direct field flip, `bomb.armed = true`, the same pattern hudSelection.js
   already uses for the Mender's auto-repair toggle), it detonates the instant
   any of three triggers fires:
     - it takes a hit at all (combat.js's performAttack calls detonateIfAttacked
       before applying normal damage),
     - a live enemy unit or building comes within BOMB_DETECT_RANGE (checked
       once per tick from engine/sim.js),
     - the player manually triggers it (detonateBomb, called directly from the
       HUD's "Detonate Now" button).
   All three funnel through detonateBomb() so they can never disagree about
   what the blast actually does. An UNARMED bomb ignores all three — it can be
   shot, stood next to, or driven right up to a base with no effect, exactly
   like any other unit — so arming is a deliberate, reversible (see disarm in
   hudSelection.js) commitment, not an inherent property of the unit.

   The blast radius is deliberately tied to POWER_TIERS[0] (engine/industry.js)
   — the same "on-grid" ring every Reactor/Generator projects — rather than an
   independent magic number: the bomb erases everything inside the reach of a
   power station's innermost efficiency zone, so the number on the tooltip can
   never silently drift from what the power-grid UI already shows the player.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { POWER_TIERS } from "./industry.js";
import { removeEntity } from "./state.js";

// The power station's "first circle": POWER_TIERS[0] is the innermost,
// on-grid efficiency band every Reactor/Generator projects.
export const BOMB_BLAST_RADIUS = POWER_TIERS[0].max;

// How close a live enemy has to come before an ARMED bomb detonates on its
// own — a little past the blast itself, so "I can see it" distance is
// already too late to back out of the blast.
export const BOMB_DETECT_RANGE = BOMB_BLAST_RADIUS + 30;

function isBomb(e) {
  return !!e && e.kind === "unit" && UNITS[e.type]?.role === "bomb";
}

// Detonate `bomb` right now, unconditionally — the ONE place the blast itself
// happens, so every trigger produces the exact same result. Erases (outright
// removes — no salvage, no partial hp, no survivors) every unit and building
// within BOMB_BLAST_RADIUS, ANY owner included: the bomb's own side's units
// and buildings, and the bomb itself, are not exempt. Snapshots the caught
// set before removing anything, so the sweep can't be thrown off by entities
// disappearing mid-scan. One bombDetonated event drives the explosion VFX +
// sound (boot.js/effects.js/sound.js); each erased entity still gets its own
// entityKilled event so the ordinary death-flash plays across the whole blast.
export function detonateBomb(state, bomb) {
  if (!bomb || bomb.hp <= 0) return;   // already gone — e.g. two triggers fired the same tick

  const caught = [];
  for (const u of state.units.values())
    if (Math.hypot(u.x - bomb.x, u.y - bomb.y) <= BOMB_BLAST_RADIUS) caught.push(u);
  for (const b of state.buildings.values())
    if (Math.hypot(b.x - bomb.x, b.y - bomb.y) <= BOMB_BLAST_RADIUS) caught.push(b);

  for (const e of caught) {
    removeEntity(state, e.id);
    state.events.push({ type: "entityKilled", x: e.x, y: e.y, owner: e.owner });
  }
  state.events.push({ type: "bombDetonated", x: bomb.x, y: bomb.y, radius: BOMB_BLAST_RADIUS, owner: bomb.owner });
}

// If `target` is an ARMED Helium Bomb, being hit AT ALL — regardless of how
// much damage the shot would have dealt — sets it off instead of chipping
// its hp. Called from combat.js's performAttack before the normal damage/
// death path runs. Returns whether it detonated, so the caller can
// short-circuit (the normal hp/salvage/entityKilled bookkeeping doesn't
// apply — detonateBomb already erased it, along with everything else caught).
export function detonateIfAttacked(state, target) {
  if (!isBomb(target) || !target.armed) return false;
  detonateBomb(state, target);
  return true;
}

// Per-tick check for an ARMED bomb: is any live enemy unit or building within
// BOMB_DETECT_RANGE? Called from sim.js for every role:"bomb" unit, before its
// normal per-tick update. Returns whether it detonated, so sim.js can skip the
// rest of this tick's update for it (there's nothing left to update).
export function checkBombProximity(state, bomb) {
  if (!bomb.armed) return false;
  for (const u of state.units.values()) {
    if (u.owner === bomb.owner || u.hp <= 0) continue;
    if (Math.hypot(u.x - bomb.x, u.y - bomb.y) <= BOMB_DETECT_RANGE) { detonateBomb(state, bomb); return true; }
  }
  for (const b of state.buildings.values()) {
    if (b.owner === bomb.owner || b.constructing) continue;
    if (Math.hypot(b.x - bomb.x, b.y - bomb.y) <= BOMB_DETECT_RANGE) { detonateBomb(state, bomb); return true; }
  }
  return false;
}
