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

import { BUILDINGS, storeTotal, storeRoom, storeCapOf } from "./entities.js";
import { hashStr } from "./rng.js";
import { powerThrottle, planetIndustryScale } from "./industry.js";

// The raw commodities a rig can strike. Which one a given rig mines — its VEIN — is chosen by WHERE
// it's built: the SURFACE deposits nearby bias what lies below (a rig among ore fields usually
// strikes ore), so late-game placement is an educated guess off the visible map rather than a blind
// gamble. A barren spot falls back to a position hash, so it always strikes SOMETHING.
export const PLASMA_VEINS = ["ore", "crystals", "radioactives", "ice", "gas", "biomass"];
const VEIN_SET = new Set(PLASMA_VEINS);

// How far out a rig "reads" the surface. Deposits within this radius hint at the seam below; the
// hint fades linearly with distance. Nudged with placement, not the sim, so it's a UX-scale number.
export const SURVEY_RADIUS = 280;
const BASE_VEIN_WEIGHT = 0.05;    // every vein's hashed floor — keeps a barren spot a gamble and leaves room for a surprise
const RICH_DENSITY_SCALE = 600;   // node.max is ~hundreds; this soft-caps surface density into [0,1)

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

// Read the surface at (x, y): a proximity-weighted tally of nearby PLASMA-vein deposits. `weights`
// is per-commodity (which raws are nearby, and how close), `density` folds in each deposit's SIZE
// (node.max — the ORIGINAL amount, which never depletes, so the reading is STABLE as nodes are mined
// out). Pure over the given node list, so the sim can survey ALL nodes (deterministic) while the UI
// surveys only the ones the player can see (an honest guess — a hidden cache stays a surprise).
function surfaceSurvey(nodes, x, y) {
  const weights = {};
  let density = 0;
  for (const n of nodes) {
    if (!VEIN_SET.has(n.com)) continue;
    const d = Math.hypot(n.x - x, n.y - y);
    if (d >= SURVEY_RADIUS) continue;
    const prox = 1 - d / SURVEY_RADIUS;              // 1 right on top of it, 0 at the survey edge
    weights[n.com] = (weights[n.com] || 0) + prox;
    density += prox * (n.max || 0);
  }
  return { weights, density };
}

// Seam richness in [0,1) from surface density blended with the old per-TILE / per-PLANET hash — so a
// resource-dense spot digs richer, but two dense spots still differ (luck) and some worlds run richer
// all over (the core). Shared by the sim and the placement survey.
function richnessFrom(density, planetId, x, y) {
  const surface = density / (density + RICH_DENSITY_SCALE);   // soft-cap to [0,1)
  const tile = frac01(`${planetId}:${Math.floor(x / RICH_CELL)}:${Math.floor(y / RICH_CELL)}`);
  const core = frac01(`core:${planetId}`);
  return Math.min(1, 0.6 * surface + 0.4 * (0.55 * tile + 0.45 * core));
}

function richLabelFor(r) {
  return r < 0.35 ? "poor" : r < 0.6 ? "fair" : r < 0.82 ? "rich" : "mother lode";
}

/**
 * Which raw a rig strikes — a deterministic weighted-random pick BIASED by the surface: nearby
 * deposits weight their own commodity, so a rig among ore fields usually strikes ore, but a hashed
 * floor on every vein leaves room for a surprise (and makes a barren spot a genuine gamble). Stable
 * for a given rig: the weights come from node positions/sizes, which never move or deplete.
 */
export function rigVein(state, building) {
  const { weights } = surfaceSurvey(state.map?.nodes || [], building.x, building.y);
  const key = `${Math.round(building.x)},${Math.round(building.y)}`;
  let total = 0;
  const scored = PLASMA_VEINS.map(com => {
    const w = (weights[com] || 0) + BASE_VEIN_WEIGHT * (0.5 + frac01(`${key}:${com}`));
    total += w;
    return { com, w };
  });
  let roll = frac01(key) * total;
  for (const e of scored) { roll -= e.w; if (roll <= 0) return e.com; }
  return scored[scored.length - 1].com;
}

/** The richness of a rig's spot in [0,1), surface-biased. Pure — no clock, no unseeded RNG. */
export function locationRichness(state, x, y) {
  const { density } = surfaceSurvey(state.map?.nodes || [], x, y);
  return richnessFrom(density, state.planetId, x, y);
}

/**
 * A placement-time READING of the surface for the player: from a given node list (pass the VISIBLE
 * ones), the most-likely vein below, how confident that read is, and the seam richness. `likelyVein`
 * is null when no deposits are in range — a blind spot. Distinct from rigVein: this is the best guess
 * off the visible map; the actual strike is the weighted roll over ALL nodes, so it can still surprise.
 */
export function rigSurvey(nodes, planetId, x, y) {
  const { weights, density } = surfaceSurvey(nodes, x, y);
  let likelyVein = null, best = 0, sum = 0;
  for (const com of PLASMA_VEINS) { const w = weights[com] || 0; sum += w; if (w > best) { best = w; likelyVein = com; } }
  const richness = richnessFrom(density, planetId, x, y);
  return { likelyVein, confidence: sum > 0 ? best / sum : 0, richness, richLabel: richLabelFor(richness) };
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
 * vein into its FINITE output buffer (building.store, capped at storeCap). When the buffer is full
 * the rig stalls at the brink until a worker hauls it to a Command Center (engine/haul.js) — it's
 * an unlimited SOURCE, not an unlimited SINK. Deterministic. A no-op for any building without a
 * `rig` def.
 */
export function updatePlasmaRig(state, building, dt) {
  const def = BUILDINGS[building.type];
  if (building.constructing || !def || !def.rig || building.paused) return;
  const rig = def.rig;
  const throttle = powerThrottle(state, building.owner);   // short power → slower digs
  if (throttle <= 0) return;
  const res = state.players[building.owner].resources;

  building.digProgress = (building.digProgress || 0) + (dt / rig.digTime) * planetIndustryScale(state) * throttle;

  const vein = rigVein(state, building);
  const richness = locationRichness(state, building.x, building.y);
  // ABSTRACTED AI LOGISTICS (Odyssey): the player's rig piles its dig into a FINITE output buffer
  // that workers must haul off (it stalls at the brink when full); the AI's logistics are abstracted
  // (haul auto-assign is player-only, sim.js), so its rig banks straight into the treasury with no
  // buffer to fill and stall on. Gated on owner==="ai" — the player rig and the skirmish are untouched.
  const abstract = building.owner === "ai";
  let cycles = 0;
  while (building.digProgress >= 1 && cycles < MAX_CYCLES_PER_TICK) {
    if ((res.radioactives || 0) < rig.nuclear) { building.digProgress = 1; break; }   // out of nuclear → stall at the brink
    const room = abstract ? Infinity : storeRoom(building);
    if (room <= 1e-9) { building.digProgress = 1; break; }   // output buffer full → stall until hauled
    const tier = rollTier(building, richness);
    const amount = Math.min(rig.base * tier.mult, room);   // top off to exactly full on the last dig (overflow spills)
    res.radioactives -= rig.nuclear;
    building.digProgress -= 1;
    building.digCount = (building.digCount || 0) + 1;
    if (abstract) {
      res[vein] = (res[vein] || 0) + amount;   // AI: straight into the treasury
    } else {
      building.store = building.store || {};
      building.store[vein] = (building.store[vein] || 0) + amount;   // player: into the finite buffer, hauled later
    }
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
  const richness = locationRichness(state, building.x, building.y);
  const richLabel = richLabelFor(richness);
  const res = state.players[building.owner].resources;
  const cap = storeCapOf(building.type);
  const stored = storeTotal(building);
  return {
    vein: rigVein(state, building),
    richness, richLabel,
    progress: Math.min(1, building.digProgress || 0),
    lastTier: building.lastTier || null,
    lastYield: building.lastYield || 0,
    nuclearOk: (res.radioactives || 0) >= def.rig.nuclear,
    throttle: powerThrottle(state, building.owner),
    stored, storeCap: cap,
    storeFull: cap > 0 && stored >= cap - 1e-6,   // buffer full → the rig is stalled until it's hauled off
  };
}
