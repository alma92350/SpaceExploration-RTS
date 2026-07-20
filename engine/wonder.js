/* ============================================================
   The Antimatter Gate — Odyssey's endgame wonder (Phase 3). A `wonder:true`
   building that CHARGES by consuming strategic goods over time; at full charge the
   player wins the galaxy (engine/victory.js checkEndlessWin). This gives the
   endless Odyssey sandbox its first WIN condition — until now it could only be
   lost (checkEndlessLoss).

   Charging is a structural twin of industry.js updateProduction: throttled by the
   player's spare Power (so a Gate charging while your factories run competes with
   them for the grid) and clamped to the strategic goods actually in stock (so a
   starved Gate stalls and waits rather than charging on nothing, and the stockpile
   never goes negative). Goods are spent as they're fed, so a Gate razed mid-charge
   costs the whole investment — a fat, defendable objective, not a fire-and-forget.

   Odyssey-only and inert-by-construction: the Gate is `odysseyOnly`, the skirmish
   AI never builds it, and updateWonder is a no-op for any building without the
   `wonder` flag — so the byte-identical skirmish path is untouched. Deterministic
   and DOM-free: dt-driven float math, no wall-clock, no unseeded randomness.
   ============================================================ */

"use strict";

import { BUILDINGS } from "./entities.js";
import { powerThrottle } from "./industry.js";

// Advance a charging wonder by dt — a no-op for any building that isn't a completed
// wonder. `charge` is a 0..1 float on the building (persists for free — serPlanet
// serializes whole building objects), so a save mid-charge round-trips and
// continues identically. Reads only building/player state — deterministic.
export function updateWonder(state, building, dt) {
  if (building.constructing) return;
  const def = BUILDINGS[building.type];
  if (!def || !def.wonder) return;
  const feed = def.feed || {};
  const res = state.players[building.owner].resources;

  // Charge fraction this tick: the power-throttled target, clamped by the scarcest
  // fed good in stock (measured in "full charges' worth", so we never overspend).
  let p = (dt * powerThrottle(state, building.owner)) / def.chargeTime;
  for (const com in feed) {
    const perCharge = feed[com] * def.chargeTime;
    if (perCharge > 0) p = Math.min(p, (res[com] || 0) / perCharge);
  }
  if (!(p > 0)) return;

  for (const com in feed) res[com] = (res[com] || 0) - p * feed[com] * def.chargeTime;
  building.charge = Math.min(1, (building.charge || 0) + p);
  state.events.push({ type: "wonderCharging", charge: building.charge, x: building.x, y: building.y, owner: building.owner });
}
