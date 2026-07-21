/* ============================================================
   COLONY SHIP (Odyssey) — the mobile seed of a base. In the open world both sides
   START with a colony ship instead of a placed Command Center, and found every new
   base by building a ship, moving it to the site, and DEPLOYING it in place. Deploy
   is an instant, pure state mutation (like engine/galaxy.js upgradeToCapital): it
   validates the footprint, consumes the ship, and mints a COMPLETED Command Center
   plus the colonists that ride in — so ship→CC is atomic (no "foothold gap" for the
   loss/domination checks, engine/victory.js + engine/galaxy.js).

   Odyssey-only by construction: the colonyship unit is `odysseyOnly` and never
   instantiated in a skirmish, so this module is inert there. Deterministic and
   DOM-free — no wall-clock, no unseeded randomness.
   ============================================================ */

"use strict";

import { makeBuilding, makeUnit, removeEntity } from "./state.js";
import { canPlaceBuilding } from "./colliders.js";

// Colonists that disembark when a colony ship deploys — matches the classic opening
// crew, and gives every founded base an immediate starter economy. A balance knob.
export const COLONY_SHIP_WORKERS = 3;

// Deploy a colony ship into a COMPLETED Command Center at its current position:
// validate the footprint (strictly — the CC lands exactly where the ship is parked,
// so move to clear ground and retry rather than sliding), consume the ship, spawn the
// finished CC (fresh id) and its disembarking workers. Instant + pure — no clock/RNG,
// so it replays identically. Returns the new CC's id, or null if it couldn't deploy.
export function deployColonyShip(state, shipId) {
  const ship = state.units.get(shipId);
  if (!ship || ship.type !== "colonyship") return null;
  const { owner, x, y } = ship;
  // canPlaceBuilding ignores units, so the parked ship never blocks its own footprint.
  if (!canPlaceBuilding(state, "command", x, y)) {
    state.events.push({ type: "deployBlocked", x, y, owner });
    return null;
  }
  removeEntity(state, shipId);                        // consume the ship (also drops it from selection)
  const cc = makeBuilding("command", owner, x, y);    // no { constructing } ⇒ spawns COMPLETE
  state.buildings.set(cc.id, cc);
  for (let i = 0; i < COLONY_SHIP_WORKERS; i++) {     // colonists disembark — no cost, they rode in
    const w = makeUnit("worker", owner, x + 40 + i * 14, y + 40);   // same offsets as state.js seedPlayer
    state.units.set(w.id, w);
  }
  state.events.push({ type: "buildingComplete", x, y, owner });   // reuse the CC-finished sound/vfx
  return cc.id;
}

// Does this owner still hold a colony ship? The single source of truth for the
// "a side with only an undeployed colony ship still has a foothold" rule shared by
// checkEndlessLoss (engine/victory.js) and checkDomination (engine/galaxy.js).
export function hasColonyShip(state, owner) {
  for (const u of state.units.values())
    if (u.owner === owner && u.type === "colonyship") return true;
  return false;
}
