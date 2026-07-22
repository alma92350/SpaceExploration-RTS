/* ============================================================
   Economy balance (Tier 2 review fixes): the credit printer is closed, the passive
   colony-income annuity is capped, and Verdani's agri deposits are tradeable.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, sweepColonies, addPlanet, COLONY_INCOME_PER_BUILDING, COLONY_INCOME_CAP } from "../engine/galaxy.js";
import { createMarket, sell, buy, unitPrice, updateMarket, TRADE_LOT } from "../engine/market.js";
import { makeBuilding } from "../engine/state.js";

function marketState(planetId = "vesper", nodes = [{ com: "ore", max: 400 }]) {
  const s = { planetId, map: { nodes }, players: { player: { resources: {} } } };
  s.market = createMarket(s);
  return s;
}

test("raw inputs cost much more to BUY than the refined-goods spread — no free local round-trip", () => {
  const s = marketState();
  const rawSpread = unitPrice(s.market, "ore", "buy") / unitPrice(s.market, "ore", "sell");
  const goodSpread = unitPrice(s.market, "metals", "buy") / unitPrice(s.market, "metals", "sell");
  assert.ok(rawSpread > goodSpread + 0.2, "the raw buy spread is materially wider than the refined-goods spread");
  assert.ok(rawSpread >= 1.45, "raw inputs cost ~1.5x to buy");
});

test("the credit printer saturates: once a world's metals market is glutted, another local cycle isn't profitable", () => {
  // The old exploit ran buy-ore → refine → sell-metals forever on ONE world for free
  // credits. It's no longer infinite: dumping output builds a slow glut, so after the
  // local market saturates, one more buy-refine-sell cycle is net-negative — you're forced
  // to haul the goods to a fresh world instead. Worst case for the exploit: cheap ore +
  // high metals price (an ore-rich, industry-5 world).
  const s = marketState("vesper", [{ com: "ore", max: 400 }]);
  const g = { credits: 100000 };
  const res = s.players.player.resources;
  res.metals = 6000;
  sell(g, s, "metals", 6000);                              // a long run of dumped output saturates the local price

  const before = g.credits;                                // now measure ONE marginal cycle at saturation
  buy(g, s, "ore", 2);
  if ((res.ore || 0) >= 2) { res.ore -= 2; res.metals = (res.metals || 0) + 2; }   // Smelter: 2 ore → 2 metals
  sell(g, s, "metals", 2);
  assert.ok(g.credits - before <= 0, `at saturation another local cycle is not a credit source (marginal ${g.credits - before})`);
});

test("dumping factory output on one world saturates its price (slow glut), forcing the haul-elsewhere loop", () => {
  const s = marketState("vesper", []);                     // industry-5, produced goods at the 1.5x ceiling
  s.players.player.resources.metals = 5000;
  const first = unitPrice(s.market, "metals", "sell");
  sell({ credits: 0 }, s, "metals", 2000);                 // dump a big run of output
  const saturated = unitPrice(s.market, "metals", "sell");
  assert.ok(saturated < first * 0.5, "a saturated local market pays far less for more of the same good");

  // Glut is SLOW: a short pressure-timescale recovery barely lifts it back.
  for (let i = 0; i < 300; i++) updateMarket(s, 0.1);      // 30s — enough for pressure, not for glut
  assert.ok(unitPrice(s.market, "metals", "sell") < first * 0.75, "the glut is still depressing the price 30s later");
});

test("a big sell is priced marginally across lots, not the whole quantity at the pre-trade price", () => {
  const s = marketState("vesper", []);
  s.players.player.resources.metals = 10000;
  const p0 = unitPrice(s.market, "metals", "sell");
  const proceeds = sell({ credits: 0 }, s, "metals", 100 * TRADE_LOT);   // 100 lots at once
  assert.ok(proceeds < p0 * 100 * TRADE_LOT, "the bulk sale earns less than the whole quantity at the pre-trade price (slippage applied per lot)");
});

test("Verdani's agri deposits are tradeable — biomass and spice can be sold for credits", () => {
  const g = createGalaxy({ seed: 1 });
  const s = activeState(g);
  s.players.player.resources.biomass = 200;
  s.players.player.resources.spice = 200;
  assert.ok(sell(g, s, "biomass", 100) > 0, "biomass sells for credits");
  assert.ok(sell(g, s, "spice", 100) > 0, "spice sells for credits");
});

test("passive colony income is capped per world — cheap-building spam is no longer an annuity", () => {
  const g = createGalaxy({ seed: 2 });
  const colonyId = g.worlds.find(w => w !== g.activeId);
  const colony = addPlanet(g, colonyId, { unsettled: true });
  colony.background = true;
  const cc = colony.map.bases.player;
  // Spam far more than the cap's worth of the cheapest income building.
  for (let i = 0; i < COLONY_INCOME_CAP + 20; i++) {
    const b = makeBuilding("habitat", "player", cc.x + i, cc.y);
    colony.buildings.set(b.id, b);
  }
  g.credits = 0;
  sweepColonies(g, 1);   // one second of income
  const cap = COLONY_INCOME_CAP * COLONY_INCOME_PER_BUILDING;
  assert.ok(g.credits <= cap + 1e-6, `income is capped at ${cap}/s regardless of building count (got ${g.credits})`);
  assert.ok(g.credits > 0, "a real colony still earns");
});

test("turret walls don't pay income (only economy buildings do)", () => {
  const g = createGalaxy({ seed: 2 });
  const colonyId = g.worlds.find(w => w !== g.activeId);
  const colony = addPlanet(g, colonyId, { unsettled: true });
  colony.background = true;
  const cc = colony.map.bases.player;
  for (let i = 0; i < 5; i++) {
    const t = makeBuilding("turret", "player", cc.x + i, cc.y);
    colony.buildings.set(t.id, t);
  }
  g.credits = 0;
  sweepColonies(g, 1);
  assert.equal(g.credits, 0, "a turret-only colony earns nothing — turrets aren't an economy");
});
