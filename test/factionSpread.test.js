import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, checkExpansion, galaxyStatus, CLAIM_DEV, EXPAND_DEV, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding } from "../engine/state.js";

// Stand up an AI base with `n` industrial buildings on a world so aiDevelopment(s) === n.
function developWorld(g, id, n) {
  const s = g.planets.get(id);
  const cc = makeBuilding("command", "ai", 500, 500); s.buildings.set(cc.id, cc);
  const kit = ["reactor", "smelter", "assembler", "chipfab", "machineworks", "datacenter", "plasmarig", "antimatterforge"];
  for (let i = 0; i < n; i++) { const b = makeBuilding(kit[i], "ai", 520 + i * 28, 500); s.buildings.set(b.id, b); }
  return s;
}

test("a developed world claims its homeworld for its faction", () => {
  const g = createGalaxy({ seed: 12 });
  const id = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s = developWorld(g, id, CLAIM_DEV);
  const faction = s.players.ai.faction;
  checkExpansion(g);
  assert.equal(g.claims.get(id), faction, "the world flies its own faction's flag once developed");
});

test("a bare world stays unclaimed (development gates the claim)", () => {
  const g = createGalaxy({ seed: 13 });
  checkExpansion(g);
  assert.equal(g.claims.size, 0, "nothing is claimed while every world is undeveloped");
});

test("a thriving world colonises the nearest unclaimed world (it adopts the expander's colours)", () => {
  const g = createGalaxy({ seed: 20 });
  const home = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s = developWorld(g, home, EXPAND_DEV);   // one world thrives; the rest stay bare/unclaimed
  const faction = s.players.ai.faction;
  for (let i = 0; i < 3; i++) checkExpansion(g);   // self-claim home, then reach out
  assert.equal(g.claims.get(home), faction, "home self-claimed");
  const grabbed = [...g.claims.entries()].find(([w, f]) => w !== home && f === faction);
  assert.ok(grabbed, "it colonised another world for its faction (territory spread)");
  assert.equal(g.planets.get(grabbed[0]).players.ai.faction, faction, "the colonised world's AI flies the expander's colours");
});

test("faction claims survive a save/load", () => {
  const g = createGalaxy({ seed: 7 });
  const id = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  developWorld(g, id, CLAIM_DEV);
  checkExpansion(g);
  assert.ok(g.claims.size >= 1, "something got claimed");
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.deepEqual([...g2.claims.entries()].sort(), [...g.claims.entries()].sort(), "claims round-trip");
});

test("galaxyStatus surfaces the controlling faction for the starmap", () => {
  const g = createGalaxy({ seed: 9 });
  const id = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s = developWorld(g, id, CLAIM_DEV);
  checkExpansion(g);
  const w = galaxyStatus(g).worlds.find(x => x.id === id);
  assert.equal(w.controlledBy, s.players.ai.faction, "the starmap shows who controls the world");
});
