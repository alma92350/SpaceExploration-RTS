import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, jumpCapital, stepGalaxy } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip, hasColonyShip } from "../engine/colony.js";
import { sell } from "../engine/market.js";

// A comparable fingerprint of a whole galaxy (rounded to dodge FP noise).
function snapshot(g) {
  return {
    credits: Math.round(g.credits), activeId: g.activeId, tick: g.tick, entitySeq: g.entitySeq,
    planets: [...g.planets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([id, s]) => ({
      id, tick: s.tick, time: Math.round(s.time * 10), background: !!s.background,
      units: s.units.size, buildings: s.buildings.size,
      ore: Math.round(s.players.player.resources.ore || 0),
      stance: +s.diplomacy.stance.toFixed(4),
      pressure: +(s.market.pressure.ore || 0).toFixed(4),
      fog: [...s.fog.explored].reduce((a, b) => a + b, 0),
    })),
  };
}

// Build a galaxy with a background colony and some evolution, ready to save.
function evolved(seed) {
  const g = createGalaxy({ seed });
  const w = g.worlds.find(x => x !== g.activeId);
  addPlanet(g, w, { unsettled: true });
  for (let i = 0; i < 30; i++) stepGalaxy(g, 0.1);
  return g;
}

test("a galaxy round-trips through serialize → JSON → deserialize", () => {
  const g = evolved(5);
  const before = snapshot(g);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.deepEqual(snapshot(restored), before);
});

test("a reloaded galaxy continues identically", () => {
  const g1 = evolved(99);
  const saved = JSON.parse(JSON.stringify(serializeGalaxy(g1)));
  for (let i = 0; i < 25; i++) stepGalaxy(g1, 0.1);      // run the original on
  const continued = snapshot(g1);
  const g2 = deserializeGalaxy(saved);                    // restores the shared id counter
  for (let i = 0; i < 25; i++) stepGalaxy(g2, 0.1);      // same steps from the same point
  assert.deepEqual(snapshot(g2), continued);
});

test("market pressure and diplomacy stance survive a save/load", () => {
  const g = createGalaxy({ seed: 7 });
  const s = activeState(g);
  s.players.player.resources.ore = 500;
  sell(g, s, "ore", 200);                                 // move the price down
  s.diplomacy.stance = -0.42;                             // and sour relations
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rs = activeState(restored);
  assert.ok(rs.market.pressure.ore < 0, "trade pressure preserved");
  assert.equal(+rs.diplomacy.stance.toFixed(4), -0.42, "stance preserved");
  assert.ok(rs.market.base.ore > 0, "base price recomputed from the regenerated nodes");
});

test("entity ids continue past the save with no collision", () => {
  const g = evolved(3);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const existing = new Set();
  for (const s of restored.planets.values()) {
    for (const id of s.units.keys()) existing.add(id);
    for (const id of s.buildings.keys()) existing.add(id);
  }
  const fresh = makeUnit("skiff", "player", 0, 0);        // mints from the restored global counter
  assert.ok(!existing.has(fresh.id), "a newly minted id collides with nothing in the galaxy");
});

test("a colony-ship jump to a new seat survives a save/load", () => {
  const g = createGalaxy({ seed: 12 });
  const from = activeState(g);
  for (const u of [...from.units.values()]) if (u.type === "colonyship") deployColonyShip(from, u.id);   // deploy start ships → CCs
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  from.buildings.set(sp.id, sp);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y); from.units.set(ship.id, ship);   // the jump vessel
  g.credits = 2000;
  jumpCapital(g, g.worlds.find(w => w !== g.activeId));   // sail the ship to a new seat; the base stays a colony
  const before = snapshot(g);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.deepEqual(snapshot(restored), before);
  assert.equal(activeState(restored).background, false, "the reloaded seat is not a background world");
  assert.ok(hasColonyShip(activeState(restored), "player"), "the colony ship is at the new seat it jumped to");
});

test("the Odyssey AI wave-cadence clock survives a save/load (continue-identically)", () => {
  const g = createGalaxy({ seed: 4 });
  const s = activeState(g);
  s.diplomacy.stance = -0.4;     // a hostile world that has scheduled its next probe
  s.aiNextWaveAt = 123.5;        // a future cadence time — must not reset to 0 on reload
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.equal(activeState(restored).aiNextWaveAt, 123.5, "the next-wave clock is preserved, not reset to wave-ready");
});

test("researched tech and an in-progress Datacenter project survive a save/load", () => {
  const g = createGalaxy({ seed: 8 });
  const s = activeState(g);
  s.players.player.upgrades.metallurgy = true;              // a completed research node
  const dc = makeBuilding("datacenter", "player", 600, 500);
  dc.researchQueue = [{ techId: "electronics", progress: 0.4 }, { techId: "machining", progress: 0 }];   // mid-flight + a queued node
  s.buildings.set(dc.id, dc);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rs = activeState(restored);
  assert.equal(rs.players.player.upgrades.metallurgy, true, "the researched node persists (rides in player.upgrades)");
  const rdc = [...rs.buildings.values()].find(b => b.type === "datacenter");
  assert.ok(rdc && rdc.researchQueue && rdc.researchQueue[0].techId === "electronics", "the in-progress project persists on the building");
  assert.ok(Math.abs(rdc.researchQueue[0].progress - 0.4) < 1e-9, "…with its progress intact");
  assert.equal(rdc.researchQueue.length, 2, "…and the rest of the queue survives too");
});

test("the galaxy save is seed+delta (no terrain), and guards its version", () => {
  const json = JSON.stringify(serializeGalaxy(evolved(1)));
  assert.ok(!/"terrain"/.test(json), "terrain arrays regenerate from the seed, not stored");
  assert.throws(() => deserializeGalaxy({ v: 999, planets: [] }), /unsupported galaxy save/);
});
