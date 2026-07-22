/* ============================================================
   PLASMA RIG (Odyssey) — deep-core extraction. Unlike a resource node (which is
   a finite deposit workers haul from), a Plasma Rig is an UNLIMITED, perpetual
   source of one raw commodity, banked straight into the owner's stockpile.

   It digs in cycles at a PROBABILISTIC yield tier — low, medium, good, or
   overwhelming — whose odds rise with how rich the rig's spot (and the planet)
   are, so WHERE you build it matters. The "randomness" is fully deterministic:
   every roll is a hash of the rig's id + its dig counter (engine/rng.js hashStr),
   so a same-seed galaxy strikes the same seams on a replay — the engine's
   determinism law holds (no unseeded RNG, no wall clock).

   Costs, so it's an engine, not free money: it draws heavy Power (the plasma arc
   — routed through industry.js's grid, so it competes with factories and the Gate
   and its digs slow when power is short), and it burns radioactives per dig
   ("nuclear to exploit"). Odyssey-only: updatePlasmaRig is a no-op for any
   building without a `rig` def, so the skirmish tick is untouched.
   ============================================================ */

"use strict";

import { BUILDINGS } from "./entities.js";
import { hashStr } from "./rng.js";
import { powerThrottle, planetIndustryScale } from "./industry.js";

// The raw commodities a rig can strike. Which one a given rig mines — its VEIN — is fixed by WHERE
// it's built (a deterministic hash of its tile), so placement chooses the resource.
export const PLASMA_VEINS = ["ore", "crystals", "radioactives", "ice", "gas", "biomass"];

// Yield tiers: each dig strikes one, its multiplier over the rig's base yield, and the cumulative
// probability boundary a richness-biased roll must fall under. Richer ground reaches the fat tiers.
export const YIELD_TIERS = [
  { name: "low", mult: 1, p: 0.44 },
  { name: "medium", mult: 2.4, p: 0.74 },
  { name: "good", mult: 4.5, p: 0.93 },
  { name: "overwhelming", mult: 9, p: 1 },
];

const RICH_CELL = 96;            // richness varies on this grid — a rig's tile has its own luck
const MAX_CYCLES_PER_TICK = 4;   // a real tick advances <1 cycle; a cap guards a huge dt or a tampered save

const frac01 = s => (hashStr(s) % 100000) / 100000;   // a stable pseudo-random [0,1) from a string

/** Which raw a rig at its tile mines — deterministic from position, so placement is the choice. */
export function rigVein(building) {
  return PLASMA_VEINS[hashStr(`${Math.round(building.x)},${Math.round(building.y)}`) % PLASMA_VEINS.length];
}

/**
 * The richness of a rig's spot in [0,1): part per-TILE luck (some ground hides a rich seam), part
 * per-PLANET core (some worlds run richer all over). Pure hashes of the world id + tile — no clock,
 * no unseeded RNG — so a replay strikes the same seams.
 */
export function locationRichness(planetId, x, y) {
  const tile = frac01(`${planetId}:${Math.floor(x / RICH_CELL)}:${Math.floor(y / RICH_CELL)}`);
  const core = frac01(`core:${planetId}`);
  return Math.min(1, 0.55 * tile + 0.45 * core);
}

/** The tier a given dig strikes — a per-dig roll (stable from the rig id + dig counter) biased up by richness. */
export function rollTier(building, richness) {
  const roll = frac01(`${building.id}:${building.digCount || 0}`);
  const score = Math.min(0.99999, roll * (0.6 + 0.4 * richness) + 0.35 * richness);
  for (const t of YIELD_TIERS) if (score < t.p) return t;
  return YIELD_TIERS[YIELD_TIERS.length - 1];
}

/**
 * Advance one Plasma Rig by dt. The plasma arc's Power draw (industry.js powerDraw) throttles the
 * dig speed; each completed cycle burns radioactives and banks a probabilistic tier of the rig's
 * vein into the owner's stockpile. UNLIMITED — no node, no depletion. Deterministic. A no-op for
 * any building without a `rig` def.
 */
export function updatePlasmaRig(state, building, dt) {
  const def = BUILDINGS[building.type];
  if (building.constructing || !def || !def.rig || building.paused) return;
  const rig = def.rig;
  const throttle = powerThrottle(state, building.owner);   // short power → slower digs
  if (throttle <= 0) return;
  const res = state.players[building.owner].resources;

  building.digProgress = (building.digProgress || 0) + (dt / rig.digTime) * planetIndustryScale(state) * throttle;

  const vein = rigVein(building);
  const richness = locationRichness(state.planetId, building.x, building.y);
  let cycles = 0;
  while (building.digProgress >= 1 && cycles < MAX_CYCLES_PER_TICK) {
    if ((res.radioactives || 0) < rig.nuclear) { building.digProgress = 1; break; }   // out of nuclear → stall at the brink
    res.radioactives -= rig.nuclear;
    building.digProgress -= 1;
    building.digCount = (building.digCount || 0) + 1;
    const tier = rollTier(building, richness);
    const amount = rig.base * tier.mult;
    res[vein] = (res[vein] || 0) + amount;
    building.lastTier = tier.name;   // transient display state, for the HUD
    building.lastYield = amount;
    state.events.push({ type: "rigDig", com: vein, amount, tier: tier.name, x: building.x, y: building.y, owner: building.owner });
    cycles++;
  }
}

/** A read-only snapshot of a rig's state for the HUD: what it mines, how rich the spot is, progress, last strike. */
export function rigInfo(state, building) {
  const def = BUILDINGS[building.type];
  if (!def || !def.rig) return null;
  const richness = locationRichness(state.planetId, building.x, building.y);
  const richLabel = richness < 0.35 ? "poor" : richness < 0.6 ? "fair" : richness < 0.82 ? "rich" : "mother lode";
  const res = state.players[building.owner].resources;
  return {
    vein: rigVein(building),
    richness, richLabel,
    progress: Math.min(1, building.digProgress || 0),
    lastTier: building.lastTier || null,
    lastYield: building.lastYield || 0,
    nuclearOk: (res.radioactives || 0) >= def.rig.nuclear,
    throttle: powerThrottle(state, building.owner),
  };
}
