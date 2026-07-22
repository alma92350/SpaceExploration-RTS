import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, addPlanet, stepGalaxy, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { mulberry32, entitySnapshot, galaxySnapshot } from "./_helpers.js";

// The headline determinism test (determinism.test.js) proves same-seed replays match on ONE
// world (ferros). But each world has its own map archetype, terrain, node layout and AI
// faction — a nondeterminism bug could hide on a world ferros doesn't exercise (say Glacius's
// ice terrain or the Odyssey-only research/agri worlds). This sweeps EVERY settleable world.
test("same-seed replays are byte-identical on every Odyssey world (full roster sweep)", () => {
  assert.ok(ODYSSEY_WORLDS.length >= 11, "sanity: the roster is the nine skirmish worlds + Odyssey extras");
  for (const planetId of ODYSSEY_WORLDS) {
    const run = () => {
      const s = createGameState({ planetId, seed: 24680, rng: mulberry32(24680), endless: true });
      for (let i = 0; i < 400 && !s.over; i++) tick(s, 0.1);
      return s;
    };
    const a = run(), b = run();
    assert.equal(entitySnapshot(a), entitySnapshot(b), `${planetId}: same seed must replay identically`);
    assert.ok(a.tick >= 400, `${planetId}: the run must actually have progressed`);
  }
});

// A stronger sibling of galaxy-persist's "continues identically": that one compares a LOSSY
// fingerprint (rounded credits, entity COUNTS). This compares the FULL-PRECISION galaxy
// fingerprint — every unit's exact position/hp/order, both economies, diplomacy stance and
// market pressure to the last float — so an un-persisted transient that shifts the sim by an
// epsilon (and the rounded test would sail past) surfaces here.
test("a reloaded galaxy continues identically at full precision (not just rounded counts)", () => {
  const evolve = seed => {
    const g = createGalaxy({ seed });
    const w = g.worlds.find(x => x !== g.activeId);
    addPlanet(g, w, { unsettled: true });          // a second, background world so the BG scheduler runs
    for (let i = 0; i < 50; i++) stepGalaxy(g, 0.1);
    return g;
  };

  const g1 = evolve(31415);
  const saved = JSON.parse(JSON.stringify(serializeGalaxy(g1)));
  for (let i = 0; i < 40; i++) stepGalaxy(g1, 0.1);   // run the original on
  const originalContinued = galaxySnapshot(g1);

  const g2 = deserializeGalaxy(saved);                // restore (also restores the shared id counter)
  for (let i = 0; i < 40; i++) stepGalaxy(g2, 0.1);   // same steps from the same point
  assert.equal(galaxySnapshot(g2), originalContinued);
});
