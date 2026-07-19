/* ============================================================
   The Odyssey market — universal credits and per-planet commodity trading. Each
   world has its own price book: a commodity's equilibrium price is its global
   base value nudged by LOCAL abundance (a world rich in ore sells it cheap, a
   world short on it pays more), so moving goods between worlds is what turns a
   local surplus into portable, galaxy-wide credits.

   Prices react to your trades: dumping stock pushes a commodity's price down
   (and buying pushes it up), then the pressure decays back toward equilibrium
   over time — so a big trade is worth spreading across worlds and cycles rather
   than firing off all at once. Credits live on the galaxy (engine/galaxy.js),
   not the planet, so they carry with you when you jump.

   Deterministic and DOM-free like the rest of the engine: prices are a pure
   function of the map's deposits and the running trade pressure.
   ============================================================ */

"use strict";

// The RTS deposit commodities you can actually hold and trade. Base prices match
// the commodity table (data.js COM.base), inlined so the engine stays decoupled
// from the UI-layer data.
const BASE = { ore: 9, crystals: 30, radioactives: 36, gas: 18, ice: 8, relics: 52 };
const TRADEABLE = Object.keys(BASE);

export const TRADE_LOT = 25;      // units bought/sold per click
const SPREAD = 1.15;              // a buy costs 15% more than the matching sell — the market's cut
const SLIP_PER_LOT = 0.05;        // each lot traded moves the price pressure this much
const PRESSURE_FLOOR = -0.6, PRESSURE_CEIL = 0.6;   // price swings within 40%..160% of equilibrium
const RECOVERY = 0.06;            // pressure relaxes toward equilibrium at this rate per second

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Build a planet's price book: equilibrium price per tradeable commodity, scaled
// by how abundant that commodity is in the planet's own deposits.
export function createMarket(state) {
  const total = {}; let sum = 0;
  for (const n of state.map.nodes) { total[n.com] = (total[n.com] || 0) + n.max; sum += n.max; }
  const base = {}, pressure = {};
  for (const com of TRADEABLE) {
    const share = sum ? (total[com] || 0) / sum : 0;         // 0..1 local abundance
    const mult = clamp(1.5 - share * 3.2, 0.6, 1.5);          // abundant → 0.6x, absent → 1.5x
    base[com] = Math.max(1, Math.round(BASE[com] * mult));
    pressure[com] = 0;
  }
  return { base, pressure };
}

// Current unit price for a side of the trade (buy pays the spread over sell).
export function unitPrice(market, com, side = "sell") {
  const p = market.base[com] * (1 + (market.pressure[com] || 0));
  return side === "buy" ? p * SPREAD : p;
}

// Sell up to `qty` of `com` from the player's local stock for galaxy credits;
// pushes the local price down. Returns the credits earned (0 if nothing sold).
export function sell(galaxy, state, com, qty) {
  const res = state.players.player.resources;
  const q = Math.min(qty, Math.floor(res[com] || 0));
  if (q <= 0) return 0;
  const proceeds = Math.round(unitPrice(state.market, com, "sell") * q);
  res[com] = (res[com] || 0) - q;
  galaxy.credits += proceeds;
  state.market.pressure[com] = clamp(state.market.pressure[com] - (q / TRADE_LOT) * SLIP_PER_LOT, PRESSURE_FLOOR, PRESSURE_CEIL);
  return proceeds;
}

// Buy up to `qty` of `com` with galaxy credits (capped by what you can afford);
// pushes the local price up. Returns the credits spent (0 if nothing bought).
export function buy(galaxy, state, com, qty) {
  const price = unitPrice(state.market, com, "buy");
  const q = Math.min(qty, Math.floor(galaxy.credits / price));
  if (q <= 0) return 0;
  const cost = Math.round(price * q);
  galaxy.credits -= cost;
  const res = state.players.player.resources;
  res[com] = (res[com] || 0) + q;
  state.market.pressure[com] = clamp(state.market.pressure[com] + (q / TRADE_LOT) * SLIP_PER_LOT, PRESSURE_FLOOR, PRESSURE_CEIL);
  return cost;
}

// Relax every commodity's trade pressure back toward equilibrium (called per tick
// for a planet that has a market — see sim.js).
export function updateMarket(state, dt) {
  const p = state.market.pressure;
  const k = Math.min(1, dt * RECOVERY);
  for (const com in p) p[com] -= p[com] * k;
}

// Commodities worth showing on this world's market: those it deposits, plus any
// the player is currently carrying (so you can always offload what you hold).
export function tradeables(state) {
  const present = new Set(state.map.nodes.map(n => n.com));
  const res = state.players.player.resources;
  return TRADEABLE.filter(c => present.has(c) || (res[c] || 0) > 0);
}
