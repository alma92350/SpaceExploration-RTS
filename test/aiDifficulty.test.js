/* ============================================================
   AI DIFFICULTY (engine/aiDifficulty.js): the Easy/Medium/Hard pick from the splash
   screen, orthogonal to the archetype and the player-picked strategy — see the
   module header for the full design. Tier 0 (scaffold: state.ai.difficulty,
   difficultyFor, round-trip) and Tier 1 (the first three economic dials — worker
   target, war patience, the seeded economic edge) both land here.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { createGalaxy, activeState } from "../engine/galaxy.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { runAI } from "../engine/ai.js";
import { createDiplomacy, updateDiplomacy } from "../engine/diplomacy.js";
import { UPGRADES } from "../engine/entities.js";
import { DIFFICULTY_OPTIONS, difficultyFor } from "../engine/aiDifficulty.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle

/* ---------- the table + resolution (Tier 0) ---------- */

test("Medium carries no economic dial fields — the baseline every dial is relative to", () => {
  const medium = DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  for (const field of ["workerTargetMult", "graceMult", "grievanceMult", "economicEdge",
                        "researchPaceMult", "marketAccess"]) {
    assert.equal(medium[field], undefined, `medium.${field} should be unset`);
  }
});

test("researchPaceMult and marketAccess are still unset on every tier — reserved for a later tier", () => {
  for (const opt of DIFFICULTY_OPTIONS) {
    assert.equal(opt.researchPaceMult, undefined, `${opt.mult}.researchPaceMult not landed yet`);
    assert.equal(opt.marketAccess, undefined, `${opt.mult}.marketAccess not landed yet`);
  }
});

test("Easy softens worker target and war patience; Hard sharpens both, plus the economic edge", () => {
  const easy = DIFFICULTY_OPTIONS.find(o => o.mult === "easy");
  const hard = DIFFICULTY_OPTIONS.find(o => o.mult === "hard");
  assert.ok(easy.workerTargetMult < 1 && easy.graceMult > 1 && easy.grievanceMult < 1,
    "Easy: a smaller economy and a longer diplomatic fuse");
  assert.ok(hard.workerTargetMult > 1 && hard.graceMult < 1 && hard.grievanceMult > 1,
    "Hard: a bigger economy and a shorter diplomatic fuse");
  assert.equal(hard.economicEdge, true);
  assert.equal(easy.economicEdge, undefined, "Easy gets no economic edge");
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

/* ---------- Tier 1: worker target ---------- */

test("workerTargetMult composes onto the archetype's workerTarget: Hard queues a worker Easy wouldn't, at the identical headcount", () => {
  const mk = difficulty => {
    const s = createGameState({ planetId: "ferros", rng: () => 0.5, difficulty });
    // A fixed, easy-to-reason-about archetype (mirrors ai.test.js's "legacy archetype" fixture) —
    // isolates the difficulty multiplier from any archetype-specific workerTarget value.
    s.ai.archetype = { name: "Test", workerTarget: 10, armyAttackSize: 4, attackTimeout: 90, unitMix: ["skiff"] };
    s.players.ai.resources.ore = 100000;
    // Pin the AI's worker headcount at exactly 9 — the boundary between Easy's 10*0.8=8
    // (9 already meets/exceeds it, so it must NOT queue another) and Hard's 10*1.25=12.5
    // (9 is still short, so it MUST queue one).
    for (const [id, u] of [...s.units]) if (u.owner === "ai" && u.type === "worker") s.units.delete(id);
    for (let i = 0; i < 9; i++) {
      const w = makeUnit("worker", "ai", s.map.bases.ai.x + i, s.map.bases.ai.y);
      s.units.set(w.id, w);
    }
    return s;
  };
  const cc = s => [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "command");

  const easy = mk("easy");
  runAI(easy, THINK_INTERVAL);
  assert.equal(cc(easy).queue.length, 0, "Easy's target (8) is already met by 9 workers — no new one queued");

  const hard = mk("hard");
  runAI(hard, THINK_INTERVAL);
  assert.equal(cc(hard).queue.length, 1, "Hard's target (12.5) is still short at 9 workers — queues one more");
});

/* ---------- Tier 1: war patience ---------- */

test("Hard sours an Odyssey neighbour faster than Easy, at identical time & scarcity, on the identical archetype", () => {
  // vesper -> Balanced, which carries no odyssey overlay of its own (ai-odyssey.test.js), isolating
  // the difficulty effect from any archetype-driven grace/grievance difference — the same isolation
  // aiStrategy.test.js's own Aggressive-vs-Adaptive diplomacy test uses.
  const mk = difficulty => {
    const s = createGameState({ planetId: "vesper", rng: () => 0.5, difficulty });
    s.diplomacy = createDiplomacy();
    s.endless = true;
    return s;
  };
  const hard = mk("hard"), easy = mk("easy");
  for (const s of [hard, easy]) {
    // Past BOTH difficulties' grace window (420s * graceMult: ~378 for Hard, ~483 for Easy) —
    // difficulty's own multiplier is deliberately mild (unlike Aggressive's 0.2), so a time still
    // inside either grace window floors both to the identical GRACE_FLOOR and hides the difference.
    s.time = 600;
    for (const n of s.map.nodes) n.amount = n.max * 0.5;   // identical scarcity on both worlds
    for (let i = 0; i < 60; i++) updateDiplomacy(s, 0.5);
  }
  assert.ok(hard.diplomacy.stance < easy.diplomacy.stance,
    `Hard is more hostile than Easy at identical time & scarcity (hard ${hard.diplomacy.stance.toFixed(3)} vs easy ${easy.diplomacy.stance.toFixed(3)})`);
});

/* ---------- Tier 1: economic edge ---------- */

test("Hard seeds the synthetic hardEdge upgrade onto the AI (and only the AI) at creation; every other tier leaves it unset", () => {
  const hard = createGameState({ planetId: "ferros", difficulty: "hard" });
  assert.equal(hard.players.ai.upgrades.hardEdge, true);
  assert.equal(hard.players.player.upgrades.hardEdge, undefined, "never the player's — this is a difficulty artifact, not a real pick");

  for (const difficulty of ["easy", "medium", undefined]) {
    const s = createGameState({ planetId: "ferros", difficulty });
    assert.equal(s.players.ai.upgrades.hardEdge, undefined, `${difficulty ?? "(default)"} seeds no economic edge`);
  }
});

test("hardEdge is doctrine-less and excluded from the player-facing Refinery panel by design (see entities.js committedDoctrine)", () => {
  assert.equal(UPGRADES.hardEdge.doctrine, undefined);
  assert.equal(UPGRADES.hardEdge.aiOnly, true);
  assert.equal(typeof UPGRADES.hardEdge.gatherYieldMult, "number");
  assert.equal(typeof UPGRADES.hardEdge.produceTimeMult, "number");
});
