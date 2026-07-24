/* ============================================================
   AI — shared primitives used by every decision phase (engine/ai.js and the
   aiEconomy / aiMilitary / aiIndustry phase modules). Kept in one leaf module
   with no engine imports so the phase modules can share them without a cycle:
   the APM action budget (the configurable AI speed), the reserve-aware
   affordability check, and the "which idle worker founds this building" pick.
   ============================================================ */

"use strict";

const APM_BURST_FRAC = 1 / 15;   // a busy AI can bank at most ~4 seconds' worth of unspent actions

/* ---------- action budget (the configurable AI speed / APM) ---------- */

// The AI's "speed" is an actions-per-minute allowance, set from the splash
// screen (state.ai.apm). Every command it issues — produce, build, expand,
// research, send the scout — costs one action; the attack commit is the one
// exemption, so a slow AI still throws whatever it has at you and the game
// always resolves. Credits accrue continuously and cap at a few seconds' worth,
// so a busy AI can't hoard a giant burst. When aiApm is null (the default, and
// every headless test) the AI is unthrottled — behaviour is exactly as before.
export function accrueActionBudget(state, dt) {
  if (state.ai.apm == null) return;
  const cap = Math.max(2, state.ai.apm * APM_BURST_FRAC);
  state.ai.actionBudget = Math.min((state.ai.actionBudget || 0) + (state.ai.apm / 60) * dt, cap);
}

export function canAct(state) {
  return state.ai.apm == null || (state.ai.actionBudget || 0) >= 1;
}

export function spend(state) {
  if (state.ai.apm != null) state.ai.actionBudget -= 1;
}

// canAfford, but treating `oreReserve` ore as untouchable — used to bank for
// an expansion Command Center without letting the unit mix or a second
// barracks spend the ore out from under it.
export function canAffordKeeping(resources, cost, oreReserve) {
  return Object.entries(cost).every(([com, qty]) =>
    (resources[com] || 0) - (com === "ore" ? oreReserve : 0) >= qty);
}

// Nearest free worker to (x, y) to found a building, skipping any already mid-build (so an in-progress
// site keeps its founder) AND any on a logistics run (service/haul) — pulling a worker off feeding a
// factory to lay a foundation would thrash the industry it's trying to grow. Prefers a gatherer/idle
// worker; falls back to workers[0] only if every worker is busy building or hauling — buildings
// self-construct at rate 1 even with nobody on-site, so a slightly-worse pick is never a stall.
export function pickBuilder(workers, x, y) {
  let best = null, bestD = Infinity;
  for (const w of workers) {
    if (w.order && (w.order.type === "build" || w.order.type === "service" || w.order.type === "haul")) continue;
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best || workers[0];
}
