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

import { BUILDINGS, storeRoom, isElectrifiable } from "./entities.js";
import { RECIPES, PLANETS } from "../data.js";
import { techMult } from "./techtree.js";

// ELECTRIFICATION (Odyssey) — a non-power building (Command Center, Barracks, Star Dock, Habitat)
// can be wired into the grid to run 30% better: a producer trains faster, a Habitat houses more.
// The upgrade isn't free — an electrified building adds a steady ELECTRIFY_POWER draw to the grid
// (scaled by grid efficiency like any consumer, so a far-flung one loads it more), competing with
// the factories. And the payoff scales with how well the grid can actually feed the load: the boost
// is ELECTRIFY_BOOST × the player-wide power throttle, so it's the full +30% only while there's Power to
// spare and 0 with no grid at all — lighting up the whole base without building Reactors to match
// just throttles everything. Not player-only: the Odyssey AI electrifies its own base too (see
// engine/aiIndustry.js, which flips `electrified` on its buildings the same way the HUD does for
// the player), so both sides run these helpers identically. It's Odyssey-only, not player-only — a
// skirmish never sets `electrified` at all (its economy AI doesn't run this code), so the skirmish
// path never touches these helpers and its replay stays untouched.
export const ELECTRIFY_POWER = 4;   // grid draw per electrified building (grid-efficiency scaled, like a factory)
const ELECTRIFY_BOOST = 0.3;        // the headline "+30% with power"

// ICE COOLANT (Odyssey) — banked ice works as a coolant for the whole industrial base: an owner
// with ANY ice in this world's treasury runs every recipe-based factory, the Plasma Rig
// (engine/rig.js), and the fuel-burning power stations (Reactor / Combustion Generator / Biomass
// Reactor, below) at half their normal appetite — half of each recipe's non-energy inputs, half
// the Rig's nuclear burn per dig, half a power station's fuel burn, and half the grid Power a
// factory or the Rig draws to run. Eligibility is a flat stockpile check, like the Rig's own
// nuclearOk gate — but running the discount is NOT free: chargeIceUpkeep below drains the treasury
// for as long as a building keeps actually benefiting, so sustaining it across a base needs a real,
// ongoing ice supply, not a single unit banked once and forgotten. Deliberately NOT read by the
// wonder's charge draw or by ELECTRIFY_POWER — neither is "industry", so ice coolant leaves them
// untouched.
const ICE_COOLANT_MULT = 0.5;

/** Whether `owner` currently has ice banked (in THIS state's treasury) to run as coolant. */
export function hasIceCoolant(state, owner) {
  return (state.players[owner]?.resources?.ice || 0) > 0;
}

/** ICE_COOLANT_MULT with ice banked, else 1 — the one multiplier every fuel/input burn and Power
 * draw below applies, so "keep some ice banked" reads as a single flat efficiency bonus across the
 * whole industrial base rather than a per-building rule to remember. */
export function iceCoolantMult(state, owner) {
  return hasIceCoolant(state, owner) ? ICE_COOLANT_MULT : 1;
}

// ICE UPKEEP — the coolant is a real, ongoing cost, not a one-time banked freebie: whenever a
// building actually REALIZES the discount this tick (a factory that ran a batch, a power station
// that burned fuel, a Rig that completed a dig), it drains a small, flat ice/sec from the treasury
// for as long as it keeps benefiting. A building that ISN'T actually benefiting this tick (starved,
// stalled, no dig completed) is charged nothing — there's nothing to charge for. Charged straight
// from the treasury, the same way the Rig's own nuclear cost is (not a hauled/local input), clamped
// so it can never go negative — the instant it hits zero, hasIceCoolant reads "no coolant" on the
// very next check, so the discount (and the charge) both switch off together.
const ICE_UPKEEP_PER_SEC = 0.1;

/** Charge dt seconds of ice upkeep against `owner`'s treasury — called only where a building has
 * just actually used the coolant discount this tick (see updateCombustors/updateProduction below,
 * and engine/rig.js's updatePlasmaRig). */
export function chargeIceUpkeep(state, owner, dt) {
  const res = state.players[owner]?.resources;
  if (!res) return;
  res.ice = Math.max(0, (res.ice || 0) - ICE_UPKEEP_PER_SEC * dt);
}

// PAUSED STANDBY DRAW (Odyssey) — a paused factory or Plasma Rig no longer frees its WHOLE
// reserved Power when parked: it idles at a small standby trickle instead, the same way real
// hardware left in standby still sips power. Applied only inside powerDraw's recipe/rig branches
// below — a paused power STATION (Reactor/Generator/Biomass Reactor) has no draw of its own to
// trickle (it only ever GRANTS Power, and already grants none while paused — see sourceActive), so
// it's untouched by this constant.
const PAUSED_POWER_FRACTION = 0.05;

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

// Whether a power SOURCE is actually feeding the grid right now: a fuel-burning Generator only
// while it's fed (engine/industry.js updateCombustors sets `powered`); any source (Reactor
// included) can also be taken off the grid by hand — the HUD's Pause/Resume toggle, same idiom as
// pausing a factory or a Plasma Rig — so a player can run purely on Generators (or vice versa)
// without demolishing the building they're not using right now.
function sourceActive(building, def) {
  if (building.paused) return false;
  return def.combust ? !!building.powered : true;
}

// The best (smallest) grid-distance from (x,y) to any ACTIVE own power source (a fuelled Reactor/
// Generator — NOT a Substation relay, see bestGridDist below), each source's distance divided by
// its `powerRange` — so a short-range Generator's efficiency zones shrink and a consumer must
// huddle much closer to it than to a Reactor. Infinity if the owner has no active source in reach.
// Guards non-finite coordinates (the industry unit-test stubs omit x/y) so they read as co-located
// rather than NaN-poisoning the scan. Kept separate from bestGridDist's own relay pass so a
// Substation's OWN "am I linked?" qualification check (below) can never be satisfied by another
// relay — one hop only, no chaining.
function bestSourceDist(state, owner, x, y) {
  let best = Infinity;
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    if (!(def?.energyGrants > 0) || !sourceActive(b, def)) continue;
    const d = Math.hypot(b.x - x, b.y - y) / (def.powerRange || 1);
    if (Number.isFinite(d) && d < best) best = d;
  }
  return best;
}

// The best (smallest) grid-distance from (x,y) to any ACTIVE own power source OR qualifying
// Substation relay (engine/entities.js BUILDINGS.substation, `powerRelay: true`). A relay
// QUALIFIES as a virtual source point only while it stands within POWER_TIERS[0].max ("linked") of
// a REAL active source — bestSourceDist just above, which only ever looks at real sources, is
// exactly the same distance math bestGridDist itself uses, so "linked" means the identical band
// either way. A relay that doesn't qualify contributes nothing, same as if it didn't exist. One
// hop only: qualification is checked against bestSourceDist (real sources alone), never against
// another relay, so a relay can never extend the grid through a second relay — the scan stays
// O(sources × relays), not an open-ended chain. A qualifying relay is then just another candidate
// source point for (x,y), scaled by its OWN (shorter) powerRange, same shape as a real source.
function bestGridDist(state, owner, x, y) {
  let best = bestSourceDist(state, owner, x, y);
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    if (!def?.powerRelay) continue;
    if (bestSourceDist(state, owner, b.x, b.y) > POWER_TIERS[0].max) continue;   // not linked to a real source → relays nothing
    const d = Math.hypot(b.x - x, b.y - y) / (def.powerRange || 1);
    if (Number.isFinite(d) && d < best) best = d;
  }
  return best;
}

// The grid-efficiency tier of a spot for `owner`: the band its (range-scaled) distance to the
// nearest active power source falls in. No source (or a non-positional stub) → the neutral 'linked'
// tier (×1): there's no grid to lose against, and powerThrottle already zeroes an unpowered
// consumer, so an isolated penalty would be moot there anyway.
export function powerEfficiency(state, owner, x, y) {
  const d = bestGridDist(state, owner, x, y);
  if (!Number.isFinite(d)) return POWER_TIERS[0];
  for (const t of POWER_TIERS) if (d <= t.max) return t;
  return POWER_TIERS[POWER_TIERS.length - 1];
}

// Is (x,y) within reach of one of `owner`'s ACTIVE power sources — i.e. on the powered grid? True
// out to the outermost finite efficiency band (range-scaled per source). Used to power a Mender's
// repairs off the nearest station (engine/repair.js): on-grid it works at full rate, off-grid it
// limps on reserves. False when the owner has no active source at all.
export function onPowerGrid(state, owner, x, y) {
  const d = bestGridDist(state, owner, x, y);
  return Number.isFinite(d) && d <= POWER_TIERS[POWER_TIERS.length - 2].max;
}

// Burn one tick of fuel for every fuel-burning power station (the Combustion Generator: gas or
// radioactives; the Biomass Reactor: biomass) — it draws combust.rate/sec from its OWN local fuel
// buffer (`b.input`, whichever accepted fuel it has more of), the SAME finite larder a factory's
// input larder is, kept fed by a worker SERVICE run (engine/haul.js inputNeedsOf/updateService) —
// never straight from the treasury. `powered` only while actually fed — paused or dry (nobody's
// hauled fuel in yet, or the larder ran out), it grants no Power. Runs at tick start, before
// anything reads powerCap, so the grid it provides is settled for the tick. Deterministic
// (fuel-gated); a no-op for any building without a `combust` def.
export function updateCombustors(state, dt) {
  for (const b of state.buildings.values()) {
    const def = BUILDINGS[b.type];
    if (!def?.combust || b.constructing) continue;
    if (b.paused) { b.powered = false; continue; }
    const iceMult = iceCoolantMult(state, b.owner);
    const need = def.combust.rate * dt * iceMult;   // banked ice halves the fuel burn
    let fuel = null, most = 0;
    for (const f of def.combust.fuels) { const have = b.input?.[f] || 0; if (have > most) { most = have; fuel = f; } }
    if (fuel && (b.input[fuel] || 0) >= need) {
      b.input[fuel] -= need;
      b.powered = true;
      b.fuel = fuel;
      if (iceMult < 1) chargeIceUpkeep(state, b.owner, dt);   // the coolant itself costs ice while it's running
    } else b.powered = false;
  }
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
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    if (!(def?.energyGrants > 0) || !sourceActive(b, def)) continue;   // an unfueled Generator grants nothing
    cap += def.energyGrants;
  }
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
  const iceMult = iceCoolantMult(state, owner);   // banked ice halves a recipe's/Rig's Power draw too
  for (const b of state.buildings.values()) {
    if (b.owner !== owner || b.constructing) continue;
    const def = BUILDINGS[b.type];
    const r = def?.recipe ? RECIPE_BY_ID[def.recipe] : null;
    const eff = powerEfficiency(state, owner, b.x, b.y).mult;   // ≥1: distance-to-Reactor line loss
    // A paused factory no longer frees its WHOLE reserved Power — it idles at a
    // PAUSED_POWER_FRACTION standby trickle instead (see that constant's note above).
    if (r) draw += (r.in.energy || 0) * (def.prodRate || 1) * eff * iceMult * (b.paused ? PAUSED_POWER_FRACTION : 1);
    // A wonder still charging loads the grid too, so the Antimatter Gate competes
    // with the factories for Reactor Power (engine/wonder.js) — making the finale a
    // real "feed the factories vs charge the Gate" call, and Fusion Containment worth it.
    else if (def?.wonder && (b.charge || 0) < 1) draw += (def.powerDraw || 0) * eff;
    // A Plasma Rig's arc is a heavy draw too (engine/rig.js) — so it competes with the factories
    // for Power and its digs slow when the grid is short. Paused, it idles at the same standby
    // trickle a paused factory does, rather than freeing its whole reserved Power.
    else if (def?.rig) draw += (def.rig.power || 0) * eff * iceMult * (b.paused ? PAUSED_POWER_FRACTION : 1);
    // An electrified non-power building (Odyssey) adds its own modest, grid-scaled load — the
    // upgrade's running cost, so wiring up the whole base actually competes for Reactor Power.
    else if (b.electrified && isElectrifiable(b.type)) draw += ELECTRIFY_POWER * eff;
    // A Substation relay (engine/entities.js) grants no Power of its own, but running its
    // transceiver still loads the grid a little — the same flat-draw idiom as an electrified
    // building (ELECTRIFY_POWER) — so extending the grid's reach with relays still costs capacity,
    // whether or not this particular relay is currently linked to a real source (bestGridDist).
    else if (def?.powerRelay) draw += ELECTRIFY_POWER * eff;
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

// PER-TICK THROTTLE CACHE — powerThrottle is owner-wide (it never depends on which building is
// asking), but updateProduction and updatePlasmaRig each call it once per BUILDING, so every factory
// and every rig an owner has was redoing the identical draw/cap scan — including bestGridDist's O(B)
// grid-distance search inside powerDraw, for EVERY building — from scratch, every tick. That's the
// O(B²) recompute this cache kills: modelled on engine/supply.js's lazy-once `boost` and engine/
// sim.js's countMiners/countLogistics/countMenderTargets ("freeze it once per tick, reuse it"), the
// real computation now runs at most once per owner per tick no matter how many factories/rigs ask.
// Keyed on state.tick, so it self-invalidates the instant a real tick advances — and any caller that
// never goes through updateProduction/updatePlasmaRig (powerThrottle itself, repair.js,
// aiIndustry.js, a direct test call…) never touches this cache and stays exactly as fresh as
// before. NOTE: the HUD is NOT in that list — buildingConcern, ninety lines below in this very
// file, calls cachedPowerThrottle, and renderBuildings.js calls buildingConcern every frame.
function ownerPowerCache(state) {
  // A state with NO tick counter can't be keyed safely: storing `_powerCacheTick = undefined` makes
  // the invalidation test `undefined !== undefined` false forever, freezing the very first result
  // for the life of the state. That's reachable from the hand-built stubs in test/industry.test.js
  // and from any caller that doesn't come through tick(). Such a state simply doesn't get a cache.
  if (!Number.isFinite(state.tick)) return null;
  if (!state._powerCache || state._powerCacheTick !== state.tick) {
    state._powerCache = Object.create(null);
    state._powerCacheTick = state.tick;
  }
  return state._powerCache;
}

/** powerThrottle, memoized per owner for the current state.tick. Byte-identical to calling
 * powerThrottle fresh — same formula, same inputs — just computed at most once per owner per tick. */
export function cachedPowerThrottle(state, owner) {
  const cache = ownerPowerCache(state);
  if (!cache) return powerThrottle(state, owner);
  const cached = cache[owner];
  if (cached !== undefined) return cached;
  return cache[owner] = powerThrottle(state, owner);
}

// The bonus an electrified building earns right now: the headline +30%, scaled by the same
// player-wide power throttle the factories feel — so it's the full 0.30 only while the grid can
// carry its load, tapers as the grid runs short, and is 0 with no active source at all (throttle 0).
// A single owner-wide number (order-independent → deterministic). Callers multiply the thing being
// boosted by (1 + electrifyBoost): production SPEED (engine/production.js) and a Habitat's supply
// grant (engine/supply.js). Only ever invoked for a building whose `electrified` flag is set — which
// the skirmish path never sets — so the byte-identical replay never reaches this.
export function electrifyBoost(state, owner) {
  return ELECTRIFY_BOOST * powerThrottle(state, owner);
}

// Advance one factory's recipe by dt: draw its inputs from the factory's LOCAL input
// buffer (building.input, filled by worker supply runs — engine/haul.js) and bank its
// output into its LOCAL output buffer (building.store, drained by worker haul runs).
// Energy is the Power flow, handled by the throttle — NOT a consumed good. Continuous &
// fractional (buffers hold floats), throttled by power, clamped so it never runs on
// inputs it lacks (buffers never go negative) and never overfills the output buffer —
// when that buffer is full the factory STALLS until it's hauled off. So a factory only
// runs while it's been supplied AND has room: logistics feeds it and clears it, exactly
// like the Plasma Rig. A no-op for any building without a recipe → the skirmish tick
// mutates nothing new.
export function updateProduction(state, building, dt) {
  if (building.constructing) return;
  const recipe = recipeOf(building);
  if (!recipe) return;
  if (building.paused) return;   // player-paused to conserve its inputs — banks nothing, consumes nothing (its grid Power draw drops to a trickle instead — see powerDraw)
  const throttle = cachedPowerThrottle(state, building.owner);   // owner-wide — same number every factory reads this tick
  if (throttle <= 0) return;
  const ups = state.players[building.owner].upgrades;
  const input = building.input || (building.input = {});
  const iceMult = iceCoolantMult(state, building.owner);   // banked ice halves every non-energy input's cost per batch

  // BOTH sides run the SAME finite-buffer model. A factory draws its inputs from its LOCAL input
  // larder (building.input, filled by worker supply runs — engine/haul.js) and banks its output into
  // its LOCAL output buffer (building.store, drained by worker haul runs). It only runs while workers
  // have kept the larder fed AND the output buffer clear — short either way, it STALLS. The AI's
  // workers service its factories exactly like the player's (engine/ai.js assignAiLogistics), so its
  // industry pays the same labour cost; there is no owner special-case. Skirmish never instantiates a
  // factory (odysseyOnly), so its byte-identical replay is untouched.

  // How much of a batch we can run this tick: the power-throttled target — sped up by the Factory
  // Automation tech (techtree.js `automation`) and by the world's industry rating — then capped by the
  // scarcest input BUFFERED locally and by the room left in the output buffer.
  let frac = (BUILDINGS[building.type].prodRate || 1) * techMult(ups, "rateMult")
    * planetIndustryScale(state) * throttle * dt;
  for (const com in recipe.in) {
    if (com === "energy") continue;
    frac = Math.min(frac, (input[com] || 0) / (recipe.in[com] * iceMult));   // only what's in the larder
  }
  // Heavy Alloys (techtree.js `heavyalloys`) lifts output per batch — same inputs, more out — but
  // ONLY for the Smelter/Assembly Plant its tooltip names (appliesTo); building.type is what scopes
  // it, same as techMult's own doc comment describes.
  const outPerBatch = recipe.qty * techMult(ups, "yieldMult", building.type);
  if (outPerBatch > 0) frac = Math.min(frac, storeRoom(building) / outPerBatch);   // don't overfill the output buffer
  if (!(frac > 0)) return;
  if (iceMult < 1) chargeIceUpkeep(state, building.owner, dt);   // the coolant itself costs ice while it's running

  for (const com in recipe.in) {
    if (com === "energy") continue;
    input[com] = (input[com] || 0) - frac * recipe.in[com] * iceMult;
  }
  building.store = building.store || {};
  building.store[recipe.out] = (building.store[recipe.out] || 0) + frac * outPerBatch;
}

// A glanceable "is this building actually doing its job right now?" read for any factory,
// Plasma Rig, or fuel-burning power station — the map-level counterpart to hudSelection.js's
// per-building status text, so a player scanning the whole base sees a paused/stalled/throttled
// producer without opening its panel. Priority mirrors updateProduction/updatePlasmaRig/
// updateCombustors' own gating exactly (paused → no power → starved of an input/fuel → output
// buffer full → power-throttled), so the badge never disagrees with what's actually happening in
// the sim. Returns null for anything else — a healthy producer, or a building that isn't one
// (nothing to flag). `level` is one of "paused" | "bad" | "warn", for a caller to colour/pick a glyph.
export function buildingConcern(state, b) {
  if (b.constructing || b.recycling) return null;
  const def = BUILDINGS[b.type];
  if (!def) return null;

  if (def.combust) {
    if (b.paused) return { level: "paused" };
    return b.powered ? null : { level: "bad", code: "noFuel" };
  }

  const recipe = recipeOf(b);
  if (!recipe && !def.rig) return null;
  if (b.paused) return { level: "paused" };

  const throttle = cachedPowerThrottle(state, b.owner);
  if (throttle <= 0) return { level: "bad", code: "noPower" };
  const iceMult = iceCoolantMult(state, b.owner);

  if (def.rig) {
    const res = state.players[b.owner].resources;
    if ((res.radioactives || 0) < def.rig.nuclear * iceMult) return { level: "bad", code: "noFuel" };
    if (storeRoom(b) <= 1e-9) return { level: "bad", code: "bufferFull" };
    return throttle < 0.995 ? { level: "warn", code: "throttled" } : null;
  }

  const input = b.input || {};
  for (const com in recipe.in) {
    if (com === "energy") continue;
    if ((input[com] || 0) < recipe.in[com] * iceMult) return { level: "bad", code: "starved" };
  }
  // Match updateProduction's own gate EXACTLY: it caps frac by storeRoom/outPerBatch and produces
  // whenever `frac > 0`, i.e. for ANY positive room. A 1e-6 epsilon here read "bufferFull" while the
  // sim was still banking output, which is precisely the badge/sim disagreement the comment above
  // promises can't happen. (The rig branch's 1e-9 is right — it mirrors rig.js's own threshold.)
  if (storeRoom(b) <= 0) return { level: "bad", code: "bufferFull" };
  return throttle < 0.995 ? { level: "warn", code: "throttled" } : null;
}
