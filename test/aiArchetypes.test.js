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
  assert.equal(state.ai.archetype, ARCHETYPES.rusher);
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
  // Kybernet now hands its own archetype (Technologist) rather than the generic Economist — see
  // "A fourth archetype: the Technologist on Kybernet" below.
  assert.equal(archetypeFor("kybernet"), ARCHETYPES.technologist, "the research capital hands its own small-elite, teched-up rival");
  assert.equal(archetypeFor("verdani"), ARCHETYPES.balanced);
});

/* ---------- A fourth archetype: the Technologist on Kybernet (docs/improvement-proposals.md) ----------
   Eleven Odyssey worlds shared only three temperaments (rusher/economist/balanced), and no archetype
   ever fielded the Colossus. Kybernet — tech 10, industry 8, the research capital — now gets its own
   small-elite-army profile that rushes the tech ladder instead of playing as a generic Economist. */

test("the Technologist is a small, teched-up elite army — not a wide Tier-1 spam", () => {
  const t = ARCHETYPES.technologist;
  assert.ok(t, "ARCHETYPES.technologist exists");
  assert.equal(t.name, "Technologist");
  assert.equal(t.workerTarget, 7);
  assert.equal(t.armyAttackSize, 7);
  assert.equal(t.attackTimeout, 220);
  assert.equal(t.turretCount, 2);
  assert.equal(t.maxBarracks, 2);
  assert.equal(t.wantsRefinery, true, "the deep-industry signal — Kybernet's identity is fastest research + fastest factories");
  assert.equal(t.doctrine, "assault");
});

test("the Technologist is the one archetype whose mix ever fields the Colossus", () => {
  assert.deepEqual(ARCHETYPES.technologist.unitMix, ["skiff", "lancer", "lancer", "dreadnought", "colossus", "wraith"]);
  for (const [key, a] of Object.entries(ARCHETYPES)) {
    if (key === "technologist") continue;
    assert.ok(!a.unitMix.includes("colossus"), `${key} should not field the Colossus — that's the point of the Technologist`);
  }
});

test("the Technologist carries an Odyssey overlay with patient grace and high forgiveness", () => {
  const od = ARCHETYPES.technologist.odyssey;
  assert.ok(od, "the Technologist has an odyssey overlay");
  assert.ok(od.graceMult > 1, "a research capital gets a longer opening peace than the stock window, not a shorter one");
  assert.ok(od.forgiveness > (ARCHETYPES.economist.odyssey.forgiveness || 1),
    "…and forgives even faster than the already-forgiving Economist (1.5)");
});

test("Kybernet maps to the Technologist archetype", () => {
  assert.equal(ODYSSEY_EXTRA_ARCHETYPE.kybernet, "technologist");
});

test("createGameState on Kybernet wires the Technologist archetype onto state", () => {
  const state = createGameState({ planetId: "kybernet", endless: true });
  assert.equal(state.ai.archetype, ARCHETYPES.technologist);
});

test("PLANET_ARCHETYPE (the skirmish nine) is untouched by the Technologist addition — byte-identical pin", () => {
  assert.deepEqual(PLANET_ARCHETYPE, {
    korrath: "rusher",
    ferros: "economist",
    vesper: "balanced",
    glacius: "balanced",
    nimbus: "rusher",
    pyralis: "balanced",
    helix: "economist",
    oort: "rusher",
    forge: "economist",
  }, "the skirmish roster's archetype keys are byte-identical to before the Technologist was added");
});
