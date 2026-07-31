/* ============================================================
   AI — the Helium Bomb (Odyssey only — engine/entities.js UNITS.heliumbomb is
   odysseyOnly). Building one is handled where the rest of the Star Dock's
   output is (engine/aiIndustry.js, alongside the Leviathan); this module
   decides what the AI does with it once it exists, mirroring exactly what a
   player can do from the HUD (hudSelection.js) and nothing more:
     - arm it (a plain `armed = true` field flip — engine/bomb.js), and
     - trigger its fuse early (lightFuse(), the same call "Detonate Now" makes).
   Everything else — the proximity fuse, an attack detonating it instantly, the
   crater it leaves — is engine/bomb.js machinery that already runs per-tick
   for ANY role:"bomb" unit regardless of owner (engine/sim.js), so nothing
   here has to reimplement it.

   Every strategy gets the same baseline use for free: a built bomb left home
   becomes a live minefield the instant the base is under real pressure — a
   great, low-upkeep payoff for exactly the "minimal defense" a turtling
   Economic strategy wants (engine/aiStrategy.js), not just an Aggressive
   flourish. Aggressive strategy is the only one that also spends it
   offensively: walked unarmed (risk-free in transit) to the AI's current
   attack target, then armed and triggered right at the doorstep.
   ============================================================ */

"use strict";

import { issueMove } from "./commands.js";
import { lightFuse, BOMB_CORE_RADIUS } from "./bomb.js";
import { chooseAttackTarget, DEFEND_RADIUS } from "./aiMilitary.js";
import { canAct, spend } from "./aiCommon.js";
import { UNITS } from "./entities.js";

// The target's own radius, so the walk-in arm/trigger threshold scales to what it's actually
// closing on (a squat Sentinel Turret vs a broad Command Center or Gate) instead of one flat
// guess for every target — a building carries `.radius` on the instance (state.js's
// makeBuilding); a unit's lives on its UNITS definition instead (makeUnit never copies it over,
// same asymmetry engine/bomb.js's own radius lookup deals with); the plain-{x,y}-point fallback
// chooseAttackTarget hands back when nothing is in sight yet (state.map.bases.player, or a raw
// unexplored point) has neither, so 0 — arriving at all is "close enough" to a bare point.
function targetRadius(target) {
  return UNITS[target.type]?.radius ?? target.radius ?? 0;
}

/** @param {State} state @param {AiContext} ctx */
export function aiSuperweapon(state, ctx) {
  if (!state.endless) return;   // heliumbomb is odysseyOnly — never exists in a skirmish, so this is a pure no-op there
  const bomb = ctx.bombs[0];
  if (!bomb || bomb.armed) return;   // none built yet, or already armed/fusing — engine/bomb.js owns it from here

  // DEFENSIVE TRAP (every strategy): the base is under real, seen pressure and the bomb
  // is still sitting near home — arm it right where it stands. Unarmed, it's dead weight
  // in a fight (role:"bomb" never auto-acquires or gets auto-armed); armed, ANY hit
  // detonates it on the spot (engine/bomb.js detonateIfAttacked), and the proximity fuse
  // lights on its own if the attacker doesn't oblige — either way, a minefield the
  // attacker just walked into.
  const nearHome = ctx.cc && Math.hypot(bomb.x - ctx.cc.x, bomb.y - ctx.cc.y) <= DEFEND_RADIUS;
  if (ctx.threats.length > 0 && nearHome) {
    if (canAct(state)) { bomb.armed = true; spend(state); }
    return;
  }

  // OFFENSIVE DELIVERY (Aggressive strategy only — aiStrategy.js useBombOffensively):
  // walk it, UNARMED (free to move without risk — engine/bomb.js), toward the same
  // target the next attack wave would go for, then arm it and light the fuse the
  // instant it's close enough to matter: the identical lightFuse() call the player's
  // own "Detonate Now" HUD button makes, so the AI reaches for the mechanic exactly
  // the way a human would.
  if (!ctx.strategy.useBombOffensively) return;
  const target = chooseAttackTarget(state, ctx.cc);
  if (!target) return;
  // Per-target threshold, not one flat guess: the target's own radius plus BOMB_CORE_RADIUS (the
  // blast's peak-damage band, measured to the RIM — engine/bomb.js) so arming here is geometrically
  // guaranteed to land the peak hit, instead of the old flat 70 that left the bomb well short of
  // the peak band against anything bigger than a bare point (bombDamageAt(70) is only ~138hp).
  const arriveRadius = targetRadius(target) + BOMB_CORE_RADIUS;
  const d = Math.hypot(bomb.x - target.x, bomb.y - target.y);
  if (d <= arriveRadius) {
    if (canAct(state)) { bomb.armed = true; lightFuse(state, bomb); spend(state); }
  } else if (!bomb.order && canAct(state)) {
    issueMove([bomb], target.x, target.y);
    spend(state);
  }
}
