/* ============================================================
   Support-role healing. Once per tick (after all this tick's combat has
   resolved), every Mender mends the friendly units and buildings around it.

   A single global pass — not a per-unit order — because the Mender's healing
   is passive and area-based: wherever it stands, it patches whatever friendly
   damage is in reach, no target-picking or micro required. Keeping it out of
   the order pipeline means a Mender can be moving, holding, or idle and still
   heal, exactly like a real support drone.

   Determinism: the amount each Mender adds is a fixed repairRate*dt, and every
   target is clamped to its own maxHp after each contribution. min(maxHp, ...)
   makes overlapping heals order-independent (two Menders on one unit reach the
   same capped hp regardless of Map iteration order), so this pass is safe for
   the same-seed replay guarantee.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { queryNeighbors } from "./grid.js";

export function updateRepair(state, dt) {
  for (const mender of state.units.values()) {
    const def = UNITS[mender.type];
    if (!def || def.role !== "support") continue;
    const heal = def.repairRate * dt;
    const range = def.repairRange;

    // Friendly damaged UNITS in range. Units go through the broad-phase grid
    // (there can be hundreds); a straight scan is the fallback for the many
    // tests that drive repair without building a per-tick grid.
    const cands = state.unitGrid
      ? queryNeighbors(state.unitGrid, mender.x, mender.y, range)
      : state.units.values();
    for (const u of cands) {
      if (u === mender) continue;               // a Mender never heals itself — it's meant to be a fragile, escorted asset
      if (u.owner !== mender.owner) continue;   // friendlies only
      if (u.hp <= 0 || u.hp >= u.maxHp) continue;
      if (Math.hypot(u.x - mender.x, u.y - mender.y) > range) continue;
      u.hp = Math.min(u.maxHp, u.hp + heal);
    }

    // Friendly damaged BUILDINGS in range. Buildings aren't in the unit grid,
    // but there are only ever a handful, so a direct scan is cheap. A building
    // still under construction is skipped — a half-built shell has no battle
    // damage to mend, and the builder owns that progress.
    for (const b of state.buildings.values()) {
      if (b.owner !== mender.owner || b.constructing) continue;
      if (b.hp <= 0 || b.hp >= b.maxHp) continue;
      if (Math.hypot(b.x - mender.x, b.y - mender.y) > range) continue;
      b.hp = Math.min(b.maxHp, b.hp + heal);
    }
  }
}
