import { test } from "node:test";
import assert from "node:assert/strict";
import { archetypeFor, ARCHETYPES, PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE } from "../engine/aiArchetypes.js";
import { createGameState } from "../engine/state.js";
import { PLANETS } from "../data.js";

test("each of the three playable planets maps to a distinct archetype", () => {
  const korrath = archetypeFor("korrath");
  const ferros = archetypeFor("ferros");
  const vesper = archetypeFor("vesper");

  assert.equal(korrath.name, "Rusher");
  assert.equal(ferros.name, "Economist");
  assert.equal(vesper.name, "Balanced");
});

test("an unknown planet id falls back to Balanced instead of throwing", () => {
  const result = archetypeFor("not-a-real-planet");
  assert.equal(result, ARCHETYPES.balanced);
});

test("Rusher attacks sooner and with less economy than Economist", () => {
  assert.ok(ARCHETYPES.rusher.attackTimeout < ARCHETYPES.economist.attackTimeout);
  assert.ok(ARCHETYPES.rusher.armyAttackSize < ARCHETYPES.economist.armyAttackSize);
  assert.ok(ARCHETYPES.rusher.workerTarget < ARCHETYPES.economist.workerTarget);
});

test("createGameState wires the resolved archetype onto state, matching the chosen planet", () => {
  const state = createGameState({ planetId: "korrath" });
  assert.equal(state.aiArchetype, ARCHETYPES.rusher);
});

test("every archetype carries sane Tier 4 fields", () => {
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    assert.ok(a.turretCount >= 0, `${key} turretCount should be non-negative`);
    assert.ok(a.maxBarracks >= 1, `${key} should allow at least one barracks`);
    assert.ok(a.expandWhenNodesBelow >= 0 && a.expandWhenNodesBelow < 1,
      `${key} expandWhenNodesBelow should be a fraction in [0, 1)`);
  }
});

test("fortification matches temperament: Economist 2, Balanced 1, Rusher 0 turrets", () => {
  assert.equal(ARCHETYPES.economist.turretCount, 2);
  assert.equal(ARCHETYPES.balanced.turretCount, 1);
  assert.equal(ARCHETYPES.rusher.turretCount, 0);
});

test("the Breacher rides only in the patient mixes, not the Rusher's", () => {
  assert.ok(ARCHETYPES.economist.unitMix.includes("breacher"));
  assert.ok(ARCHETYPES.balanced.unitMix.includes("breacher"));
  assert.ok(!ARCHETYPES.rusher.unitMix.includes("breacher"), "the rush profile stays lean and cheap");
});

test("every roster entry is a real planet mapped to a real archetype", () => {
  for (const [planetId, archetypeKey] of Object.entries({ ...PLANET_ARCHETYPE, ...ODYSSEY_EXTRA_ARCHETYPE })) {
    assert.ok(PLANETS.some(p => p.id === planetId), `${planetId} should be a charted world`);
    assert.ok(ARCHETYPES[archetypeKey], `${planetId} maps to a real archetype`);
  }
});

test("the skirmish roster stays frozen at nine so skirmish replays are byte-identical", () => {
  // Phase 4 grows the ODYSSEY roster, but PLANET_ARCHETYPE (the skirmish map picker
  // + its full-resolve tests) must NOT change — the Odyssey extras live in their own
  // table. If this count moves, a skirmish world was added and byte-identity is at risk.
  assert.equal(Object.keys(PLANET_ARCHETYPE).length, 9, "the skirmish roster is the original nine");
  for (const id of Object.keys(ODYSSEY_EXTRA_ARCHETYPE)) {
    assert.ok(!(id in PLANET_ARCHETYPE), `${id} is Odyssey-only, not a skirmish world`);
  }
});

test("archetypeFor resolves the Odyssey-only worlds too", () => {
  assert.equal(archetypeFor("kybernet"), ARCHETYPES.economist, "the research capital hands a patient rival");
  assert.equal(archetypeFor("verdani"), ARCHETYPES.balanced);
});
