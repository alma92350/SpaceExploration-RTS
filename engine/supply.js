// @ts-check
/* ============================================================
   Supply accounting: a soft population cap that gates production.
   Every live unit and every queued job costs supply; Command Centers
   and Habitats grant it. Both totals are recomputed on demand from
   state — never cached anywhere — so a dying building's queue frees its
   reservation with no bookkeeping, and drift is impossible by
   construction (state already holds the whole truth).

   A match can ALSO set a hard ceiling on top of that (state.popCap — setup.js's Population cap
   option, 200/250/300/Max, null/Max meaning uncapped): supplyCap clamps the building-derived total
   to it, identically for both owners (it's a shared match rule, not a per-side or AI-temperament
   dial like difficulty/aiStrategy). buildingSupplyCap exposes the pre-clamp raw total for the one
   caller that needs to tell "still-blocked" apart from "no housing would help" — engine/aiEconomy.js's
   own Habitat-build trigger, which would otherwise keep raising a cap a hard ceiling has already
   overtaken, forever.
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { electrifyBoost } from "./industry.js";

// Live units + every queued job, per owner. Counting all queue entries
// (not just index 0) makes the reservation happen at queue time, so a
// player can't stuff a barracks past the cap.
/** @param {State} state @param {string} owner @returns {number} */
export function supplyUsed(state, owner) {
  let used = 0;
  for (const u of state.units.values())
    if (u.owner === owner) used += UNITS[u.type].supplyCost || 0;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner) continue;
    for (const job of b.queue) used += UNITS[job.unitType].supplyCost || 0;
  }
  return used;
}

// Completed buildings only — a Habitat still going up grants nothing
// until it finishes, so you can't produce against supply you haven't
// built yet. Losing a Habitat can leave a player legally over cap
// (nothing dies; production simply blocks until they rebuild).
/** @param {State} state @param {string} owner @returns {number} */
export function buildingSupplyCap(state, owner) {
  let cap = 0;
  let boost = null;   // the electrify bonus, computed lazily and once — only if a grant building is wired in
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const grant = BUILDINGS[b.type].supplyGrants || 0;
    if (!grant) continue;
    // Electrification (Odyssey): a Habitat wired into the power grid houses 30% more — scaled by the
    // grid throttle (engine/industry.js). The flag is never set on the skirmish path, so `boost` stays
    // null there and the arithmetic is byte-identical to the old `cap += grant`.
    if (b.electrified) {
      if (boost === null) boost = electrifyBoost(state, owner);
      cap += grant * (1 + boost);
    } else cap += grant;
  }
  return cap;
}

// The cap production.js/hud.js actually enforce/display: the building-derived total above, clamped
// to the match's configured population cap (state.popCap — null/unset means Max, i.e. today's
// always-uncapped behaviour, byte-identical to before this setting existed). Never the other way
// round — a LOWER building-derived total than the configured cap is unaffected (Math.min).
/** @param {State} state @param {string} owner @returns {number} */
export function supplyCap(state, owner) {
  const raw = buildingSupplyCap(state, owner);
  return (state.popCap != null && state.popCap < raw) ? state.popCap : raw;
}
