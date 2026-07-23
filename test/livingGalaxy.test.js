import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, stepGalaxy, galaxyStatus, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";

test("the living galaxy instantiates every world, but the player has reached only the start seat", () => {
  const g = createGalaxy({ seed: 12 });
  assert.equal(g.planets.size, ODYSSEY_WORLDS.length, "every world exists and simulates in the background");
  assert.equal(g.discovered.size, 1, "the player has reached only the start world");
  const st = galaxyStatus(g);
  assert.equal(st.visited, 1, "starmap shows one world visited");
  assert.equal(st.worlds.filter(w => w.status === "unexplored").length, ODYSSEY_WORLDS.length - 1, "the rest read unexplored");
  for (const w of st.worlds) if (w.status === "unexplored") assert.equal(w.stance, null, "an unexplored world hides its neighbour's stance");
});

test("background AI factions develop on their own worlds over time (the galaxy is alive unseen)", () => {
  const g = createGalaxy({ seed: 8 });
  const other = ODYSSEY_WORLDS.find(id => id !== g.activeId);
  const s = g.planets.get(other);
  assert.ok(s.background, "a non-seat world runs in the background");
  assert.equal([...s.buildings.values()].filter(b => b.owner === "ai").length, 0, "it starts with just a colony ship — no buildings");
  for (let i = 0; i < 4000; i++) stepGalaxy(g, 0.05);   // ~200s of galaxy time
  const aiBuildings = [...s.buildings.values()].filter(b => b.owner === "ai");
  assert.ok(aiBuildings.length > 0, `the neighbour built up its base unseen (${aiBuildings.length} buildings)`);
  assert.ok(aiBuildings.some(b => b.type === "command"), "its faction founded a Command Center from the colony ship");
});

test("the reached-world set survives a save/load", () => {
  const g = createGalaxy({ seed: 5 });
  g.discovered.add(ODYSSEY_WORLDS.find(id => id !== g.activeId));   // the player has reached a second world
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.equal(g2.discovered.size, 2, "discovered round-trips");
  assert.ok(g2.discovered.has(g.activeId), "…including the seat");
});
