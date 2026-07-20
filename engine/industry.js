/* ============================================================
   INDUSTRY (Odyssey) — the production chain. A production building (Smelter,
   Assembly Plant, …) runs one `recipe` from data.js RECIPES, continuously
   converting raw hauls into refined goods worth real credits at the market.

   Power is a per-tick FLOW, not a stockpiled good — modelled exactly like
   engine/supply.js: Reactors grant capacity (`energyGrants`), running factories
   draw it (a recipe's `in.energy`, scaled by the building's `prodRate`). Both
   totals are recomputed on demand from state, never cached, so a razed Reactor
   throttles industry with zero bookkeeping and drift is impossible. When draw
   exceeds cap, EVERY recipe scales by the same throttle factor (order-independent
   → deterministic) rather than some running and some stalling.

   Intermediate goods are just more float keys in the player's `resources` map —
   no new storage structure — so production banks fractional output the same way
   gather.js banks fractional hauls. Deterministic and DOM-free like the rest of
   the engine: no wall-clock, no unseeded randomness — pure dt-driven float math.

   Quarantined to Odyssey: production buildings are `odysseyOnly`, so a skirmish
   never instantiates one and updateProduction is a no-op for any building without
   a `recipe` — the byte-identical skirmish replay is untouched.
   ============================================================ */

"use strict";

import { BUILDINGS } from "./entities.js";
import { RECIPES } from "../data.js";
import { techMult } from "./techtree.js";

// data.js RECIPES is an array; index it by id once for O(1) lookup.
const RECIPE_BY_ID = Object.fromEntries(RECIPES.map(r => [r.id, r]));

// The recipe a building runs, or null for anything that isn't a factory.
export function recipeOf(building) {
  const def = BUILDINGS[building.type];
  return def && def.recipe ? RECIPE_BY_ID[def.recipe] : null;
}

// Total industrial Power a player's completed buildings grant (Reactors), lifted
// by the Fusion Containment tech (techtree.js `reactors` node, +50%) if researched.
export function powerCap(state, owner) {
  let cap = 0;
  for (const b of state.buildings.values())
    if (b.owner === owner && !b.constructing) cap += BUILDINGS[b.type].energyGrants || 0;
  return cap * techMult(state.players[owner]?.upgrades, "powerMult");
}

// Total Power a player's completed factories draw at full rate — a factory
// reserves its draw by existing, the same way a queued unit reserves supply
// (so the gauge is steady and predictable, not flickering with input stock).
export function powerDraw(state, owner) {
  let draw = 0;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    const r = def.recipe ? RECIPE_BY_ID[def.recipe] : null;
    if (r) draw += (r.in.energy || 0) * (def.prodRate || 1);
  }
  return draw;
}

// 1 = full speed, 0 = no power at all. Under-powered, every factory scales by the
// same fraction — a single player-wide number, so it's order-independent.
export function powerThrottle(state, owner) {
  const draw = powerDraw(state, owner);
  if (draw <= 0) return 1;
  const cap = powerCap(state, owner);
  if (cap <= 0) return 0;
  return Math.min(1, cap / draw);
}

// Advance one factory's recipe by dt: draw its inputs from the owner's global
// stockpile (energy is the Power flow, handled by the throttle — NOT a consumed
// good) and bank its output. Continuous & fractional (resources hold floats),
// throttled by available power, and clamped to whatever inputs are actually in
// stock so the stockpile can never go negative. A no-op for any building without
// a recipe → the skirmish tick mutates nothing new.
export function updateProduction(state, building, dt) {
  if (building.constructing) return;
  const recipe = recipeOf(building);
  if (!recipe) return;
  const throttle = powerThrottle(state, building.owner);
  if (throttle <= 0) return;
  const player = state.players[building.owner];
  const res = player.resources;
  const ups = player.upgrades;

  // How much of a batch we can run this tick: the power-throttled target — sped up
  // by the Factory Automation tech (techtree.js `automation`) — capped by the
  // scarcest input in stock.
  let frac = (BUILDINGS[building.type].prodRate || 1) * techMult(ups, "rateMult") * throttle * dt;
  for (const com in recipe.in) {
    if (com === "energy") continue;
    frac = Math.min(frac, (res[com] || 0) / recipe.in[com]);
  }
  if (!(frac > 0)) return;

  for (const com in recipe.in) {
    if (com === "energy") continue;
    res[com] = (res[com] || 0) - frac * recipe.in[com];
  }
  // Heavy Alloys (techtree.js `heavyalloys`) lifts output per batch — same inputs,
  // more goods out.
  res[recipe.out] = (res[recipe.out] || 0) + frac * recipe.qty * techMult(ups, "yieldMult");
}
