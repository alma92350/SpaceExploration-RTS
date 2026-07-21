import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, jumpCapital, JUMP_COST } from "../engine/galaxy.js";
import { createMarket, sell, buy, unitPrice, updateMarket, TRADE_LOT } from "../engine/market.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";

test("createGalaxy hands every world its own price book", () => {
  const g = createGalaxy({ seed: 5 });
  const s = activeState(g);
  assert.ok(s.market && s.market.base && s.market.pressure, "the active world has a market");
  assert.ok(s.market.base.ore > 0, "ore has an equilibrium price");
});

test("a commodity is priced cheaper where it's abundant than where it's absent", () => {
  const rich = createMarket({ map: { nodes: [{ com: "ore", max: 400 }] } });        // ore is the whole supply
  const lean = createMarket({ map: { nodes: [{ com: "crystals", max: 400 }] } });    // no ore deposits at all
  assert.ok(rich.base.ore < lean.base.ore, "ore costs less on an ore-rich world");
});

test("selling banks credits, spends stock, and pushes the price down", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 500;
  const before = g.credits, price0 = unitPrice(s.market, "ore", "sell");
  const proceeds = sell(g, s, "ore", 100);
  assert.ok(proceeds > 0, "credits earned");
  assert.equal(g.credits, before + proceeds, "credits went up by the proceeds");
  assert.equal(Math.floor(s.players.player.resources.ore), 400, "stock went down");
  assert.ok(unitPrice(s.market, "ore", "sell") < price0, "dumping stock drops the price");
});

test("buying spends credits, adds stock, and pushes the price up", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  g.credits = 5000;
  const price0 = unitPrice(s.market, "ore", "buy");
  const before = Math.floor(s.players.player.resources.ore || 0);
  const cost = buy(g, s, "ore", 50);
  assert.ok(cost > 0, "credits spent");
  assert.equal(g.credits, 5000 - cost, "credits went down by the cost");
  assert.equal(Math.floor(s.players.player.resources.ore), before + 50, "stock went up");
  assert.ok(unitPrice(s.market, "ore", "buy") > price0, "buying pushes the price up");
});

test("a buy costs more than the matching sell (the market spread)", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  assert.ok(unitPrice(s.market, "ore", "buy") > unitPrice(s.market, "ore", "sell"), "buy > sell");
});

test("trade pressure recovers toward equilibrium over time", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 1000;
  sell(g, s, "ore", 300);                                 // crash the price
  const crashed = s.market.pressure.ore;
  assert.ok(crashed < 0, "price is depressed after a big sale");
  for (let i = 0; i < 300; i++) updateMarket(s, 0.1);     // 30s of recovery
  assert.ok(s.market.pressure.ore > crashed, "the price recovers");
  assert.ok(Math.abs(s.market.pressure.ore) < Math.abs(crashed) / 2, "it relaxes well back toward equilibrium");
});

test("you can only sell what you hold and only buy what you can afford", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 10;
  const proceeds = sell(g, s, "ore", 100);                // only 10 in stock
  assert.ok(proceeds > 0, "sold the little there was");
  assert.equal(Math.floor(s.players.player.resources.ore), 0, "stock emptied, never negative");
  g.credits = 1;
  assert.equal(buy(g, s, "ore", 100), 0, "buys nothing when you can't afford a single unit");
});

test("a jump spends its fuel cost in credits and is refused when you can't pay", () => {
  const g = createGalaxy({ seed: 9 });
  const s = activeState(g);
  for (const u of [...s.units.values()]) if (u.type === "colonyship") deployColonyShip(s, u.id);   // deploy start ships → CCs
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  s.buildings.set(sp.id, sp);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y); s.units.set(ship.id, ship);   // vessel on the pad
  const dest = g.worlds.find(w => w !== g.activeId);

  g.credits = JUMP_COST - 1;
  assert.equal(jumpCapital(g, dest), null, "a jump you can't fund is refused");
  assert.equal(g.activeId, s.planetId, "and you stay put");

  g.credits = JUMP_COST + 250;
  const res = jumpCapital(g, dest);
  assert.ok(res, "a funded jump runs");
  assert.equal(g.credits, 250, "the fuel cost came out of credits");
});

test("TRADE_LOT is a sane positive lot size", () => {
  assert.ok(Number.isInteger(TRADE_LOT) && TRADE_LOT > 0);
});

test("finished goods are dearer on a low-industry world than a high-industry one", () => {
  const forge = createMarket({ planetId: "forge", map: { nodes: [] } });   // industry 10 — floods its own market
  const oort = createMarket({ planetId: "oort", map: { nodes: [] } });      // industry 2 — can't make them
  assert.ok(oort.base.alloys > forge.base.alloys, "a frontier world pays more for the alloys it can't make");
  assert.ok(oort.base.machinery > forge.base.machinery, "…and for machinery");
});

test("a produced good at an industry-5 world matches the old flat 1.5× ceiling (continuity)", () => {
  const m = createMarket({ planetId: "vesper", map: { nodes: [] } });   // industry 5 pivot
  assert.equal(m.base.alloys, 120, "alloys base 80 × 1.5 = 120 — continuous with the pre-Phase-4 flat price");
});
