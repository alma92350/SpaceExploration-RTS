/* ============================================================
   AI DIFFICULTY (engine/aiDifficulty.js): the Easy/Medium/Hard pick from the splash
   screen, orthogonal to the archetype and the player-picked strategy — see the
   module header for the full design. This is Tier 0 of the section-08 economic-
   dial proposal: pure scaffold, so every test here proves a NO-OP — the same
   dials as before, now resolvable off a live state the same way strategyFor already
   resolves engine/aiStrategy.js's STRATEGIES. Round-trip coverage lives here too
   (engine/persist.js's serPlanet/rehydratePlanet), since nothing else exercises it.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { createGalaxy, activeState } from "../engine/galaxy.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { DIFFICULTY_OPTIONS, difficultyFor } from "../engine/aiDifficulty.js";

test("DIFFICULTY_OPTIONS carries no economic fields yet — a genuine no-op scaffold", () => {
  for (const opt of DIFFICULTY_OPTIONS) {
    for (const field of ["workerTargetMult", "graceMult", "grievanceMult", "economicEdge",
                          "researchPaceMult", "marketAccess"]) {
      assert.equal(opt[field], undefined, `${opt.mult}.${field} should be unset — Tier 0 adds no dial yet`);
    }
  }
});

test("every difficulty option still names its two original dials (aiApm, aiMicro) and its key", () => {
  for (const key of ["easy", "medium", "hard"]) {
    const opt = DIFFICULTY_OPTIONS.find(o => o.mult === key);
    assert.ok(opt, `expected a "${key}" entry`);
    assert.equal(typeof opt.aiApm, "number");
    assert.equal(typeof opt.aiMicro, "boolean");
  }
});

test("difficultyFor resolves each real key to its matching DIFFICULTY_OPTIONS entry", () => {
  for (const key of ["easy", "medium", "hard"]) {
    const s = createGameState({ planetId: "ferros", difficulty: key });
    assert.equal(difficultyFor(s), DIFFICULTY_OPTIONS.find(o => o.mult === key));
  }
});

test("difficultyFor falls back to medium for an unset or unrecognised state.ai.difficulty", () => {
  const s = createGameState({ planetId: "ferros" });
  assert.equal(s.ai.difficulty, "medium", "createGameState's own default, unprompted");
  assert.equal(difficultyFor(s), DIFFICULTY_OPTIONS.find(o => o.mult === "medium"));
  s.ai.difficulty = "not-a-real-difficulty";
  assert.equal(difficultyFor(s), DIFFICULTY_OPTIONS.find(o => o.mult === "medium"), "unrecognised ⇒ medium, never throws");
});

test("createGameState wires opts.difficulty onto state.ai.difficulty", () => {
  const s = createGameState({ planetId: "ferros", difficulty: "hard" });
  assert.equal(s.ai.difficulty, "hard");
  assert.equal(difficultyFor(s), DIFFICULTY_OPTIONS.find(o => o.mult === "hard"));
});

test("createGalaxy threads settings.difficulty down into every planet's state.ai.difficulty, not just the active one", () => {
  const g = createGalaxy({ seed: 11, difficulty: "hard" });
  assert.equal(g.settings.difficulty, "hard");
  for (const state of g.planets.values()) {
    assert.equal(state.ai.difficulty, "hard", `world ${state.planetId} should inherit the galaxy's difficulty`);
  }
  assert.equal(activeState(g).ai.difficulty, "hard");
});

test("a saved game round-trips state.ai.difficulty through JSON", () => {
  const a = createGameState({ planetId: "ferros", difficulty: "hard" });
  const b = deserializeGame(JSON.parse(JSON.stringify(serializeGame(a))));
  assert.equal(b.ai.difficulty, "hard");
});

test("an old save with no aiDifficulty field loads as medium — the same defaulting every other additive ai.* field already gets", () => {
  const a = createGameState({ planetId: "ferros", difficulty: "hard" });
  const save = serializeGame(a);
  delete save.ai.aiDifficulty;   // simulate a save written before this field existed
  const b = deserializeGame(JSON.parse(JSON.stringify(save)));
  assert.equal(b.ai.difficulty, "medium");
});
