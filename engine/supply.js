/* ============================================================
   Supply accounting: a soft population cap that gates production.
   Every live unit and every queued job costs supply; Command Centers
   and Habitats grant it. Both totals are recomputed on demand from
   state — never cached anywhere — so a dying building's queue frees its
   reservation with no bookkeeping, and drift is impossible by
   construction (state already holds the whole truth).
   ============================================================ */

"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { electrifyBoost } from "./industry.js";

// Live units + every queued job, per owner. Counting all queue entries
// (not just index 0) makes the reservation happen at queue time, so a
// player can't stuff a barracks past the cap.
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
export function supplyCap(state, owner) {
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
