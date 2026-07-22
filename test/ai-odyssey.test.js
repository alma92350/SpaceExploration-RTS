/* ============================================================
   Odyssey AI temperament (Tier 2 review fix): in the play-forever meta the three
   archetypes had converged (the skirmish desperation path never fires and a long peace
   is guaranteed, so everyone probed in the same 3-unit dribble on a frozen economy).
   Each archetype now carries an `odyssey` overlay, read ONLY when state.diplomacy exists,
   so a "Warlord World" plays differently from a patient research capital — while the
   skirmish path (no diplomacy) stays byte-identical (covered by determinism.test.js).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { createDiplomacy, updateDiplomacy } from "../engine/diplomacy.js";
import { ARCHETYPES, archetypeFor } from "../engine/aiArchetypes.js";

function odysseyWorld(planetId) {
  const s = createGameState({ planetId, rng: () => 0.5 });
  s.diplomacy = createDiplomacy();
  s.endless = true;
  return s;
}

test("the Rusher archetype carries an aggressive Odyssey overlay; the Economist a patient-but-scaling one", () => {
  const r = ARCHETYPES.rusher.odyssey, e = ARCHETYPES.economist.odyssey;
  assert.ok(r && r.graceMult < 1, "the Rusher turns hostile in a shorter grace window");
  assert.ok(r.workerTarget > ARCHETYPES.rusher.workerTarget, "…and sustains a bigger economy than its skirmish self");
  assert.ok(r.expandWhenNodesBelow > 0, "…and actually expands in the endless mode");
  assert.ok(e && (e.graceMult ?? 1) === 1, "the Economist keeps full grace (patient)");
  assert.ok(e.workerTarget > ARCHETYPES.economist.workerTarget, "…but out-scales even harder in Odyssey");
});

test("Odyssey archetypes diverge: a Rusher world turns hostile sooner than a patient Economist at the same time & scarcity", () => {
  const rusher = odysseyWorld("korrath");   // PLANET_ARCHETYPE korrath → rusher (graceMult 0.5)
  const econ = odysseyWorld("ferros");      // ferros → economist (full grace)
  assert.equal(archetypeFor("korrath").name, "Rusher");
  assert.equal(archetypeFor("ferros").name, "Economist");

  for (const s of [rusher, econ]) {
    s.time = 300;                            // past the Rusher's shortened grace (~210), still inside the Economist's (420)
    for (const n of s.map.nodes) n.amount = n.max * 0.5;   // identical scarcity, so grace/creep is the only differentiator
    for (let i = 0; i < 60; i++) updateDiplomacy(s, 0.5);
  }
  assert.ok(rusher.diplomacy.stance < econ.diplomacy.stance,
    `the Rusher world is more hostile at the same time & scarcity (rusher ${rusher.diplomacy.stance.toFixed(3)} vs econ ${econ.diplomacy.stance.toFixed(3)})`);
});

test("a bare (skirmish) state with no aiArchetype overlay drifts on the stock diplomacy constants", () => {
  // The overlay is guarded, so a diplomacy state without an archetype (or without an
  // odyssey overlay) is unaffected — nothing throws and the drift still runs.
  const s = createGameState({ planetId: "vesper", rng: () => 0.5 });   // balanced: no odyssey overlay
  s.diplomacy = createDiplomacy();
  s.time = 500;
  assert.doesNotThrow(() => { for (let i = 0; i < 10; i++) updateDiplomacy(s, 0.5); });
});
