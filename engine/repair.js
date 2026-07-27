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
import { onPowerGrid } from "./industry.js";
import { stepToward } from "./movement.js";
import { zoneFirst } from "./gather.js";

const OFFGRID_HEAL = 0.3;   // an Odyssey Mender off the powered grid limps on reserves at this fraction

// Shared "does this need repair" thresholds — hysteresis for whoever's roaming to fix things
// (the auto-repair Mender, engine/sim.js; the worker repair job below): only get ATTRACTED to a
// friendly once it's worn past NEEDS_REPAIR, and once committed, keep servicing it until it's back
// above HEALED — so a full building nicked by a hair of wear can't yank a repairer back and forth.
export const NEEDS_REPAIR = 0.85;   // only chase a friendly once it's dropped below this share of max HP
export const HEALED = 0.985;        // …and keep servicing it until it's back above this — the release point

/**
 * Pick the friendly most in need of repair for a repairer standing at (x,y) — preferring one in
 * the REPAIRER's OWN Command Center zone first (engine/gather.js zoneFirst), and only widening to
 * the whole empire once its own zone has nothing eligible. Within a pass, priority is most-worn-
 * first (lowest hp fraction), distance breaks ties — shared shape for the auto-repair Mender
 * (which also considers wounded UNITS) and the worker repair job below (buildings only — see
 * assignRepair). `isClaimed` lets each caller enforce its OWN per-target cap (Mender: one
 * auto-repair drone per building; a worker: MAX_REPAIRERS) without this needing to know which kind
 * of caller it is; `exclude` keeps a mender from ever picking itself.
 * @param {State} state @param {string} owner @param {number} x @param {number} y
 * @param {{includeUnits?: boolean, isClaimed?: (e:*) => boolean, exclude?: *, threshold?: number}} [opts]
 * @returns {Building|Unit|null}
 */
export function pickRepairTarget(state, owner, x, y, opts = {}) {
  const { includeUnits = true, isClaimed = () => false, exclude = null, threshold = NEEDS_REPAIR } = opts;
  const scanFor = (inZone) => {
    let best = null, bestFrac = threshold, bestD = Infinity;
    const consider = (e) => {
      if (!e || e === exclude || e.owner !== owner) return;
      if (e.hp <= 0 || e.hp >= e.maxHp || e.constructing) return;
      if (isClaimed(e)) return;
      const frac = e.hp / e.maxHp;
      if (frac >= threshold) return;
      if (inZone && !inZone(e.x, e.y)) return;
      const d = Math.hypot(e.x - x, e.y - y);
      if (frac < bestFrac - 1e-9 || (Math.abs(frac - bestFrac) <= 1e-9 && d < bestD)) { bestFrac = frac; bestD = d; best = e; }
    };
    for (const b of state.buildings.values()) consider(b);
    if (includeUnits) for (const u of state.units.values()) consider(u);
    return best;
  };
  return zoneFirst(state, owner, x, y, scanFor);
}

// ---- Worker REPAIR job: a generalist worker patching its own base's structures — the buildings-
// only counterpart to the Mender's roam above, discovered/dispatched the SAME zone-first way as a
// haul/service job (engine/haul.js), so it competes for the same idle labour pool and stays loyal
// to its own base first. Free, like a Mender's heal — a worker spends time, not resources.
const MAX_REPAIRERS = 2;        // workers auto-assigned to repair the same building, so labour spreads
const REPAIR_REACH = 24;        // matches production.js's BUILD_REACH — a worker patches on-site, like construction
const WORKER_REPAIR_RATE = 4;   // hp/sec a lone worker patches at — gentler than a Mender's dedicated 6

/**
 * Per-building tally of workers already assigned to repair it THIS TICK — frozen before any new
 * assignment (same "count first, then assign" shape as engine/haul.js countLogistics) so the
 * ≤MAX_REPAIRERS cap reads the same regardless of Map iteration order. Transient (stripped on
 * serialize, engine/persist.js).
 * @param {State} state
 */
export function countRepairJobs(state) {
  for (const b of state.buildings.values()) b.repairers = 0;
  for (const u of state.units.values()) {
    const o = u.order;
    if (o && o.type === "repair" && o.buildingId) {
      const b = state.buildings.get(o.buildingId);
      if (b) b.repairers = (b.repairers || 0) + 1;
    }
  }
}

/**
 * Give an idle worker a REPAIR job on the own building most in need (buildings only — a Mender
 * already covers wounded mobile units; see the entities.js canLogistics doc comment on why repair
 * is otherwise ungated). Claims a slot for the tick.
 * @param {State} state @param {Unit} unit
 */
export function assignRepair(state, unit) {
  const best = pickRepairTarget(state, unit.owner, unit.x, unit.y, {
    includeUnits: false,
    isClaimed: (b) => (b.repairers || 0) >= MAX_REPAIRERS,
  });
  if (!best) return;
  best.repairers = (best.repairers || 0) + 1;
  unit.order = { type: "repair", buildingId: best.id, phase: "toSite" };
}

/**
 * Advance a REPAIR job: walk to the damaged building and patch it at WORKER_REPAIR_RATE hp/sec
 * once in reach. An auto-assigned worker frees up the instant it's topped off; a manually-assigned
 * one (`order.manual`, engine/commands.js issueRepairBuilding) stays parked there instead, ready the
 * moment it takes damage again — same auto-vs-manual split haul/service already use. Salvages
 * gracefully if the target is razed or still under construction (nothing to mend yet).
 * @param {State} state @param {Unit} unit @param {number} dt
 */
export function updateRepairJob(state, unit, dt) {
  const def = UNITS[unit.type];
  const order = unit.order;
  const b = order.buildingId ? state.buildings.get(order.buildingId) : null;
  if (!b || b.constructing) { unit.order = null; return; }
  if (Math.hypot(b.x - unit.x, b.y - unit.y) > REPAIR_REACH) {
    stepToward(state, unit, b.x, b.y, def.speed, dt);
    return;
  }
  b.hp = Math.min(b.maxHp, b.hp + WORKER_REPAIR_RATE * dt);
  if (b.hp >= b.maxHp && !order.manual) unit.order = null;
}

// A Mender recharges from power stations: on an Odyssey world it heals at full rate only while it's
// on the powered grid (near an active Reactor/Generator — engine/industry.js), and drops to reserves
// off-grid. A skirmish has no power economy, so its Menders always heal at full rate (unchanged).
function menderHealScale(state, mender) {
  if (!state.endless) return 1;
  return onPowerGrid(state, mender.owner, mender.x, mender.y) ? 1 : OFFGRID_HEAL;
}

export function updateRepair(state, dt) {
  for (const mender of state.units.values()) {
    const def = UNITS[mender.type];
    if (!def || def.role !== "support") continue;
    const heal = def.repairRate * dt * menderHealScale(state, mender);
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
