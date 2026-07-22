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

import { COM, PLANETS } from "../data.js";

// The RTS deposit commodities you can actually hold and trade. Equilibrium base
// prices come straight from the commodity table (data.js COM.base) — the single
// source of truth — so the two can never drift (data.js is pure data; engine/map.js
// already imports it). biomass/spice are included so Verdani (the agri-world, whose
// mineable wealth is almost entirely those two — data.js) can sell its surplus for
// credits instead of mining into a dead counter nothing reads.
// The refined goods (metals, alloys) the Odyssey production chain manufactures
// (engine/industry.js) are tradeable too — and since no world DEPOSITS them,
// createMarket prices them at the "scarce" ceiling everywhere, so refining a raw
// haul into them and selling is the whole point of building a factory.
const TRADEABLE = ["ore", "crystals", "radioactives", "gas", "ice", "relics", "biomass", "spice", "metals", "alloys", "electronics", "machinery"];
const BASE = Object.fromEntries(TRADEABLE.map(id => [id, COM[id].base]));

export const TRADE_LOT = 25;      // units bought/sold per click
const SPREAD = 1.15;              // a buy costs 15% more than the matching sell — the market's cut on refined goods
// Raw inputs cost MUCH more to buy than to sell. The game's law is "the resources you
// gather are the resources you spend" (entities.js) — you're meant to mine ore, not buy
// it. A tight spread let credits→ore→refine→metals→credits round-trip for free on a
// single world (the "credit printer"); a wide raw spread means a local buy-refine-sell
// loop loses money, so profit only comes from a real inter-world price gap (haul-and-sell).
const RAW_SPREAD = 1.5;
const RAW = new Set(["ore", "crystals", "radioactives", "gas", "ice", "relics", "biomass", "spice"]);
const SLIP_PER_LOT = 0.05;        // each lot traded moves the (fast) price pressure this much
const PRESSURE_FLOOR = -0.6, PRESSURE_CEIL = 0.6;   // price swings within 40%..160% of equilibrium
const RECOVERY = 0.06;            // pressure relaxes toward equilibrium at this rate per second (~17s constant)
// A SLOW, deep saturation term on FACTORY OUTPUT only: dumping produced goods on one
// world builds a cumulative glut that decays over minutes, not the ~17s of pressure. So
// a run of production genuinely floods its local market and pushes you to the intended
// make-here / sell-there loop (cargoManifest/freightCapacity exist for exactly this),
// instead of letting one world absorb unlimited output at a near-flat price.
const GLUT_PER_LOT = 0.05;        // each lot of produced output sold deepens the local glut this much
const GLUT_CEIL = 0.85;           // a fully-saturated local market pays as little as 15% of equilibrium
const GLUT_RECOVERY = 1 / 480;    // glut relaxes over ~8 min — far slower than pressure

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function buySpread(com) { return RAW.has(com) ? RAW_SPREAD : SPREAD; }

// Build a planet's price book: equilibrium price per tradeable commodity, scaled
// by how abundant that commodity is in the planet's own deposits.
// Manufactured goods (engine/industry.js) that no world deposits — priced by the
// world's INDUSTRY rating instead of by local ore: an industrial world floods its
// own finished-goods market (cheap, pays little), a frontier world can't make them
// so pays dear. This is what gives a low-industry world an economic niche.
const PRODUCED = new Set(["metals", "alloys", "electronics", "machinery"]);

export function createMarket(state) {
  const total = {}; let sum = 0;
  for (const n of state.map.nodes) { total[n.com] = (total[n.com] || 0) + n.max; sum += n.max; }
  const industry = PLANETS.find(p => p.id === state.planetId)?.industry ?? 5;
  const base = {}, pressure = {}, glut = {};
  for (const com of TRADEABLE) {
    let mult;
    if (PRODUCED.has(com)) {
      // Pivot at industry 5 → 1.5× (today's flat ceiling, so this is continuous):
      // Forge (10) → ~1.05×, Vesper (5) → 1.5×, Oort (2) → ~1.77×. A moderate slope
      // so industrializing still out-earns overall (Forge's speed edge dominates) —
      // this only narrows the gap and keeps frontier factories worth running.
      mult = clamp(1.5 - (industry - 5) * 0.09, 0.9, 1.9);
    } else {
      const share = sum ? (total[com] || 0) / sum : 0;         // 0..1 local abundance
      mult = clamp(1.5 - share * 3.2, 0.6, 1.5);               // abundant → 0.6x, absent → 1.5x
    }
    base[com] = Math.max(1, Math.round(BASE[com] * mult));
    pressure[com] = 0;
    glut[com] = 0;
  }
  return { base, pressure, glut };
}

// Current unit price for a side of the trade. The (fast) pressure and the (slow) glut
// both push the equilibrium price down as you sell; the buy side pays the tier spread
// on top. Glut applies only to produced goods (it's zero for raws), so it's the lever
// that saturates a factory-output market without touching raw-commodity pricing.
export function unitPrice(market, com, side = "sell") {
  const glut = PRODUCED.has(com) ? (market.glut?.[com] || 0) : 0;
  const p = market.base[com] * (1 + (market.pressure[com] || 0)) * (1 - glut);
  return side === "buy" ? p * buySpread(com) : p;
}

// Move `com`'s pressure (and, for produced goods, its glut) by one lot's worth of trade,
// signed +1 for a buy, -1 for a sell. Fractional lots (a partial final lot) scale it.
function applySlippage(market, com, lots, sign) {
  market.pressure[com] = clamp((market.pressure[com] || 0) + sign * lots * SLIP_PER_LOT, PRESSURE_FLOOR, PRESSURE_CEIL);
  if (sign < 0 && PRODUCED.has(com))   // only SELLING produced output deepens the glut
    market.glut[com] = clamp((market.glut[com] || 0) + lots * GLUT_PER_LOT, 0, GLUT_CEIL);
}

// Sell up to `qty` of `com` from the player's local stock for galaxy credits, walking the
// price DOWN across the trade in TRADE_LOT chunks so a big sell is priced marginally (each
// lot at the price after the previous lot's slippage) instead of the whole quantity at the
// pre-trade price. That makes bulk trades self-limiting by construction — a future "Sell
// All" can't dump 1000 units at full price. The 25-per-click UI trades exactly one lot, so
// its numbers are unchanged. Returns the credits earned (0 if nothing sold).
export function sell(galaxy, state, com, qty) {
  const res = state.players.player.resources;
  let remaining = Math.min(qty, Math.floor(res[com] || 0));
  if (remaining <= 0) return 0;
  let proceeds = 0;
  while (remaining > 0) {
    const lot = Math.min(TRADE_LOT, remaining);
    proceeds += Math.round(unitPrice(state.market, com, "sell") * lot);
    res[com] -= lot;
    applySlippage(state.market, com, lot / TRADE_LOT, -1);
    remaining -= lot;
  }
  galaxy.credits += proceeds;
  return proceeds;
}

// Buy up to `qty` of `com` with galaxy credits (capped by what you can afford), walking the
// price UP across the trade in lots — the buy-side mirror of sell(). Each lot is priced and
// afford-checked at the current (rising) price; the trade stops at the first lot the player
// can't cover. Returns the credits spent (0 if nothing bought).
export function buy(galaxy, state, com, qty) {
  const res = state.players.player.resources;
  let remaining = qty, cost = 0, bought = 0;
  while (remaining > 0) {
    const price = unitPrice(state.market, com, "buy");
    const lot = Math.min(TRADE_LOT, remaining);
    const affordable = Math.min(lot, Math.floor((galaxy.credits - cost) / price));
    if (affordable <= 0) break;
    cost += Math.round(price * affordable);
    res[com] = (res[com] || 0) + affordable;
    bought += affordable;
    applySlippage(state.market, com, affordable / TRADE_LOT, +1);
    if (affordable < lot) break;   // ran out of credits mid-lot
    remaining -= lot;
  }
  galaxy.credits -= cost;
  return cost;
}

// Relax every commodity's trade pressure back toward equilibrium (called per tick
// for a planet that has a market — see sim.js). The slow glut on produced goods relaxes
// on its own, much longer, time constant, so a saturated market takes minutes to recover.
export function updateMarket(state, dt) {
  const p = state.market.pressure;
  const k = Math.min(1, dt * RECOVERY);
  for (const com in p) p[com] -= p[com] * k;
  const g = state.market.glut;
  if (g) { const kg = Math.min(1, dt * GLUT_RECOVERY); for (const com in g) g[com] -= g[com] * kg; }
}

// Commodities worth showing on this world's market: those it deposits, plus any
// the player is currently carrying (so you can always offload what you hold).
export function tradeables(state) {
  const present = new Set(state.map.nodes.map(n => n.com));
  const res = state.players.player.resources;
  return TRADEABLE.filter(c => present.has(c) || (res[c] || 0) > 0);
}
