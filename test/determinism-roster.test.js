import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createGalaxy, addPlanet, stepGalaxy, ODYSSEY_WORLDS, createLane, assignShipToLane, LANE_PERIOD } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { setColonyPolicy } from "../engine/colonyPolicy.js";
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

// P6 colony-economy rework: Freight Lanes (runLanes) and colony standing orders
// (colonyPolicy.js's runColonyPolicies) both run out of stepGalaxy's own scheduling —
// exactly the kind of background machinery a determinism bug (wall-clock, unseeded order,
// Map-iteration dependence) most easily hides in. Build two byte-identical galaxies from the
// same seed, wire up an active lane AND an active colony policy on each the SAME way, run them
// forward, and require the full-precision fingerprints to match exactly.
test("two galaxies from the same seed, with an active Freight Lane and colony standing orders, replay byte-identical", () => {
  const build = seed => {
    const g = createGalaxy({ seed });
    const from = g.planets.get(g.activeId);
    const sp = makeBuilding("spaceport", "player", from.map.bases.player.x + 40, from.map.bases.player.y);
    from.buildings.set(sp.id, sp);
    const hauler = makeUnit("hauler", "player", sp.x + 10, sp.y);
    from.units.set(hauler.id, hauler);
    from.players.player.resources.metals = 400;

    const destId = g.worlds.find(w => w !== g.activeId);
    const to = addPlanet(g, destId, { unsettled: true });
    to.background = true;
    const cc = makeBuilding("command", "player", to.map.bases.player.x, to.map.bases.player.y);
    to.buildings.set(cc.id, cc);
    to.players.player.resources.ore = 1000;
    to.players.player.resources.alloys = 300;
    g.discovered.add(destId);

    const lane = createLane(g, g.activeId, destId, ["metals"]);
    assignShipToLane(g, lane.id, hauler.id);
    setColonyPolicy(g, destId, { autoSell: { enabled: true, floors: { alloys: 50 } }, workerTarget: 2 });

    for (let i = 0; i < LANE_PERIOD * 2 + 25; i++) stepGalaxy(g, 0.05);   // several lane cycles + several policy scans
    return g;
  };

  const a = build(271828), b = build(271828);
  // Sanity FIRST: both mechanisms actually did something, so the equality below is a real
  // replay comparison, not two untouched galaxies trivially matching.
  const fromA = a.planets.get(a.activeId), destA = a.planets.get(a.worlds.find(w => w !== a.activeId));
  assert.ok(fromA.players.player.resources.metals < 400, "the lane actually shipped metals out");
  assert.ok(destA.players.player.resources.ore > 700, "worker-sustain actually spent ore at the CC");

  assert.equal(galaxySnapshot(a), galaxySnapshot(b), "same seed + same setup ⇒ byte-identical galaxies, lanes/policies included");
});
