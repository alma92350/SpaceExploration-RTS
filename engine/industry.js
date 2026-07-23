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
import { RECIPES, PLANETS } from "../data.js";
import { techMult } from "./techtree.js";

// A world's `industry` rating (data.js PLANETS, 1..10) scales how fast its
// factories run — the RATE twin of techtree.js researchTimeScale (which scales
// research TIME). Same clamp band [0.5, 2], pivot 5 → 1.0×, so an industrial world
// (Forge, 10 → 2×) out-manufactures a frontier rock (Oort, 2 → 0.5×) without any
// world grinding to a halt. Pure data lookup — deterministic, DOM-free. Used only
// inside updateProduction (below), which never runs on the skirmish path.
export function planetIndustryScale(state) {
  const i = PLANETS.find(p => p.id === state.planetId)?.industry ?? 5;
  const s = i / 5;
  return s < 0.5 ? 0.5 : s > 2 ? 2 : s;
}

// GRID EFFICIENCY — the further a power consumer sits from its nearest Reactor,
// the MORE grid capacity the same job draws (transmission loss down a long line),
// so clustering factories/rigs around a Reactor lets the same Reactors run more of
// them. A per-consumer DRAW multiplier (≥1), keyed on distance to the nearest own
// Reactor. `max` is the outer edge of each band (centre-to-centre px); `mult` is the
// draw penalty; `label` is the HUD/placement tag. Pure distance math — deterministic,
// DOM-free — and it needs no workers (energy is a flow, not a hauled good). Shared by
// powerDraw (below), the HUD's selected-building panel, and the placement cue (render.js).
export const POWER_TIERS = [
  { name: "linked",   max: 190,      mult: 1.0, label: "On-grid" },
  { name: "near",     max: 320,      mult: 1.3, label: "Near-grid" },
  { name: "far",      max: 470,      mult: 1.7, label: "Far" },
  { name: "isolated", max: Infinity, mult: 2.3, label: "Isolated" },
];

// The nearest COMPLETED own Reactor's distance from (x,y), or Infinity if the owner
// has none. Guards non-finite coordinates (the industry unit-test stubs omit x/y) so
// they read as co-located rather than NaN-poisoning the scan.
function nearestReactorDist(state, owner, x, y) {
  let best = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    if (!(BUILDINGS[b.type]?.energyGrants > 0)) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (Number.isFinite(d) && d < best) best = d;
  }
  return best;
}

// The grid-efficiency tier of a spot for `owner`: the band its distance to the nearest
// Reactor falls in. No Reactor (or a non-positional stub) → the neutral 'linked' tier
// (×1): there's no grid to lose against, and powerThrottle already zeroes an unpowered
// consumer, so an isolated penalty would be moot there anyway.
export function powerEfficiency(state, owner, x, y) {
  const d = nearestReactorDist(state, owner, x, y);
  if (!Number.isFinite(d)) return POWER_TIERS[0];
  for (const t of POWER_TIERS) if (d <= t.max) return t;
  return POWER_TIERS[POWER_TIERS.length - 1];
}

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
// Each consumer's base draw is scaled by its GRID-EFFICIENCY tier: a consumer
// far from any Reactor draws MORE capacity for the same job (transmission loss),
// so where you place it — not just that you power it — moves the gauge.
export function powerDraw(state, owner) {
  let draw = 0;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    const r = def.recipe ? RECIPE_BY_ID[def.recipe] : null;
    const eff = powerEfficiency(state, owner, b.x, b.y).mult;   // ≥1: distance-to-Reactor line loss
    if (r && !b.paused) draw += (r.in.energy || 0) * (def.prodRate || 1) * eff;   // a paused factory frees its reserved Power
    // A wonder still charging loads the grid too, so the Antimatter Gate competes
    // with the factories for Reactor Power (engine/wonder.js) — making the finale a
    // real "feed the factories vs charge the Gate" call, and Fusion Containment worth it.
    else if (def.wonder && (b.charge || 0) < 1) draw += (def.powerDraw || 0) * eff;
    // A Plasma Rig's arc is a heavy draw too (engine/rig.js) — so it competes with the factories
    // for Power and its digs slow when the grid is short. A paused rig frees its reserved Power.
    else if (def.rig && !b.paused) draw += (def.rig.power || 0) * eff;
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
  if (building.paused) return;   // player-paused to conserve its inputs — banks nothing, draws nothing (see hud.js)
  const throttle = powerThrottle(state, building.owner);
  if (throttle <= 0) return;
  const player = state.players[building.owner];
  const res = player.resources;
  const ups = player.upgrades;

  // How much of a batch we can run this tick: the power-throttled target — sped up
  // by the Factory Automation tech (techtree.js `automation`) and by the world's
  // industry rating — capped by the scarcest input in stock.
  let frac = (BUILDINGS[building.type].prodRate || 1) * techMult(ups, "rateMult")
    * planetIndustryScale(state) * throttle * dt;
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
