/* ============================================================
   AI — shared primitives used by every decision phase (engine/ai.js and the
   aiEconomy / aiMilitary / aiIndustry phase modules). Kept in one leaf module
   with no engine imports so the phase modules can share them without a cycle:
   owner resolution (controllerFor/otherOwner), the APM action budget (the
   configurable AI speed), the reserve-aware affordability check, and the
   "which idle worker founds this building" pick.
   ============================================================ */

"use strict";

const APM_BURST_FRAC = 1 / 15;   // a busy AI can bank at most ~4 seconds' worth of unspent actions

/* ---------- owner resolution (Tier 1 self-play) ---------- */

// Which controller object is driving `owner` this match — state.ai for "ai" (always present,
// every match ever created), or state.playerAi for "player" (present only when self-play —
// tools/selfplay.js — has populated it; null otherwise). Every AI phase module threads its
// ctx.owner through this instead of ever reaching for state.ai directly, so the two controllers'
// action budgets, scout ids, wave timers etc. can never collide or leak into one shared object —
// see the header comment on engine/ai.js's runAI(state, dt, owner) for why that matters.
export function controllerFor(state, owner) {
  if (owner === "ai") return state.ai;
  if (owner === "player") return state.playerAi;
  return null;
}

// The other side in a two-owner skirmish/self-play match — the only two owners this engine models
// today (state.owners). Centralised here so every AI phase module resolves "my opponent" the same
// way, instead of each hardcoding "ai"/"player" itself.
export function otherOwner(owner) {
  return owner === "ai" ? "player" : "ai";
}

/* ---------- action budget (the configurable AI speed / APM) ---------- */

// This controller's "speed" is an actions-per-minute allowance, set from the splash screen
// (state.ai.apm — or, for a self-play "player" controller, state.playerAi.apm). Every command it
// issues — produce, build, expand, research, send the scout — costs one action; the attack commit
// is the one exemption, so a slow AI still throws whatever it has at you and the game always
// resolves. Credits accrue continuously and cap at a few seconds' worth, so a busy AI can't hoard a
// giant burst. When apm is null (the default, and every headless test) the AI is unthrottled —
// behaviour is exactly as before. `owner` defaults to "ai" so every pre-existing call site
// (accrueActionBudget(state, dt), canAct(state), spend(state)) keeps reading/writing state.ai
// exactly as before; a self-play caller passes ctx.owner explicitly so the "player" controller
// spends from ITS OWN budget, never state.ai's — see engine/ai.js/aiMilitary.js/aiEconomy.js.
//
// A BACKGROUND colony (state.background, engine/galaxy.js — a world that isn't the player's
// current seat) accrues at HALF its configured apm: nobody's actively watching it, so it manages
// its economy at half pace rather than as briskly as the seat you're actually on. This halves only
// the accrual rate (and, since the burst cap below is derived from the same value, its burst
// reserve too) — never the controller's apm itself, which stays exactly what difficulty picked for
// every other reader (display, save/load, the neighbour-profile tests) — and never the attack/
// defense commit exemption (canAct/spend below), so a background world under attack still always
// throws whatever it has and the game still always resolves.
export function accrueActionBudget(state, dt, owner = "ai") {
  const controller = controllerFor(state, owner);
  if (!controller || controller.apm == null) return;
  const apm = state.background ? controller.apm / 2 : controller.apm;
  const cap = Math.max(2, apm * APM_BURST_FRAC);
  controller.actionBudget = Math.min((controller.actionBudget || 0) + (apm / 60) * dt, cap);
}

export function canAct(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  return !controller || controller.apm == null || (controller.actionBudget || 0) >= 1;
}

export function spend(state, owner = "ai") {
  const controller = controllerFor(state, owner);
  if (controller && controller.apm != null) controller.actionBudget -= 1;
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
