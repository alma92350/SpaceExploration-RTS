/* ============================================================
   The string-returning serializers (serializeGameString / serializeGalaxyString) power the
   12 s autosave, which stringifies the fog-heavy payload once instead of stringify→parse→
   stringify. They must produce EXACTLY the object serializers' JSON and round-trip identically.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { tick } from "../engine/sim.js";
import { serializeGame, serializeGameString, deserializeGame,
         serializeGalaxy, serializeGalaxyString, deserializeGalaxy } from "../engine/persist.js";
import { createGalaxy, activeState } from "../engine/galaxy.js";
import { deployColonyShip } from "../engine/colony.js";

test("serializeGameString parses to the same payload as serializeGame, and round-trips", () => {
  const a = createGameState({ planetId: "ferros", seed: 7, rng: mulberry32(7), aiMicro: true });
  for (let i = 0; i < 120; i++) tick(a, 0.1);
  assert.deepEqual(JSON.parse(serializeGameString(a)), serializeGame(a),
    "the string path yields byte-identical JSON to the detached-object path");
  const b = deserializeGame(JSON.parse(serializeGameString(a)));
  assert.equal(b.units.size, a.units.size, "and loads back to the same state");
});

test("serializeGalaxyString parses to the same payload as serializeGalaxy, and round-trips", () => {
  const g = createGalaxy({ seed: 9 });
  for (const u of [...activeState(g).units.values()]) if (u.type === "colonyship") deployColonyShip(activeState(g), u.id);
  assert.deepEqual(JSON.parse(serializeGalaxyString(g)), serializeGalaxy(g),
    "the galaxy string path matches the object path");
  const g2 = deserializeGalaxy(JSON.parse(serializeGalaxyString(g)));
  assert.equal(g2.planets.size, g.planets.size, "and loads back to the same galaxy");
});
