import { test } from "node:test";
import assert from "node:assert/strict";
import { archetypeFor, ARCHETYPES, PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE } from "../engine/aiArchetypes.js";
import { createGameState, createAiController } from "../engine/state.js";
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

/* ---------- D3 (docs/competitions-and-elo.md): createAiController's optional per-entrant
   archetype override — a competition entrant can carry its own doctrine instead of both seats
   sharing whatever temperament the world hands out ("Rusher vs Turtle" becomes a real matchup). ---------- */

test("createAiController with no opts.archetype resolves the planet's own archetype, byte-identical to before this option existed", () => {
  const bare = createAiController("ferros");
  assert.equal(bare.archetype, ARCHETYPES.economist, "ferros' own archetype, unchanged");

  // An opts object that simply never mentions archetype (every existing call site today —
  // createGameState, tools/selfplay.js, test/save-hardening.test.js) must behave identically to
  // the same opts with archetype explicitly absent.
  const withOtherOpts = createAiController("ferros", { apm: 90, micro: true, strategy: "aggressive", difficulty: "hard" });
  assert.equal(withOtherOpts.archetype, ARCHETYPES.economist, "other opts fields don't affect archetype resolution at all");
});

test("a valid opts.archetype key overrides the planet's own archetype", () => {
  // ferros is normally Economist (see PLANET_ARCHETYPE) — rusher must actually win here, proving
  // this is a real override and not a no-op that happens to already match.
  const c = createAiController("ferros", { archetype: "rusher" });
  assert.equal(c.archetype, ARCHETYPES.rusher);
  assert.notEqual(c.archetype, ARCHETYPES.economist);
});

test("every ARCHETYPES key is honored as an override, not just one", () => {
  for (const key of Object.keys(ARCHETYPES)) {
    const c = createAiController("ferros", { archetype: key });
    assert.equal(c.archetype, ARCHETYPES[key], `opts.archetype: "${key}" should resolve to ARCHETYPES.${key}`);
  }
});

test("an unknown or invalid opts.archetype key falls back to the planet's own archetype instead of producing undefined", () => {
  const unknown = createAiController("ferros", { archetype: "not-a-real-archetype" });
  assert.equal(unknown.archetype, ARCHETYPES.economist);
  assert.notEqual(unknown.archetype, undefined);

  const blank = createAiController("ferros", { archetype: "" });
  assert.equal(blank.archetype, ARCHETYPES.economist, "an empty string is falsy, same fallback as omitting the field");

  const wrongType = createAiController("ferros", { archetype: 123 });
  assert.equal(wrongType.archetype, ARCHETYPES.economist, "a non-string archetype value falls back rather than throwing");
});

test("a reserved/inherited key (__proto__, constructor, prototype) as opts.archetype falls back instead of resolving to a bogus non-archetype value", () => {
  // Regression: (opts.archetype && ARCHETYPES[opts.archetype]) is a truthy bracket-access, which
  // for a plain object resolves "__proto__" to the object's own prototype (Object.prototype, always
  // truthy) rather than treating it as "not a real key" — so the old implementation returned
  // Object.prototype as the "archetype", not archetypeFor(planetId) as documented. "constructor"/
  // "prototype" are ordinary inherited properties (Object.prototype.constructor/.prototype) and hit
  // the identical bug. Object.hasOwn is the fix; this pins the fallback behavior so it can't regress.
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const c = createAiController("ferros", { archetype: key });
    assert.equal(c.archetype, ARCHETYPES.economist, `opts.archetype: "${key}" must fall back, not resolve to Object.prototype's own "${key}"`);
    assert.notEqual(c.archetype, Object.prototype, `"${key}" must not resolve to Object.prototype itself`);
  }
});

test("opts.archetype takes a STRING KEY, not an archetype object — passing an object doesn't work as an override", () => {
  // Guards the documented contract: ARCHETYPES[opts.archetype] must be a real lookup, so handing
  // it an already-resolved archetype object (rather than its key) must NOT silently "just work" —
  // ARCHETYPES[{...}] stringifies to "[object Object]", which isn't a real key, so this falls back.
  const c = createAiController("ferros", { archetype: ARCHETYPES.rusher });
  assert.equal(c.archetype, ARCHETYPES.economist, "an archetype OBJECT (not its string key) is not a valid override");
});

test("opts.archetype changes only the archetype field — every other field is exactly as before", () => {
  const base = createAiController("ferros");
  const overridden = createAiController("ferros", { archetype: "rusher" });
  const { archetype: _base, ...restBase } = base;
  const { archetype: _overridden, ...restOverridden } = overridden;
  assert.deepEqual(restBase, restOverridden);
});

/* ---------- D3, one layer up: createGameState's own opts.aiArchetype threads through to state.ai
   (createAiController's own opts.archetype is proven above; this proves createGameState actually
   WIRES it through rather than dropping it, the same "wires the resolved archetype onto state"
   shape the very first test in this file already pins for the archetype-less default path). ---------- */

test("createGameState with no opts.aiArchetype resolves the planet's own archetype, byte-identical to before this option existed", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.equal(state.ai.archetype, ARCHETYPES.economist, "ferros' own archetype, unchanged");
});

test("createGameState's opts.aiArchetype overrides the planet's own archetype on state.ai", () => {
  // ferros is normally Economist (PLANET_ARCHETYPE) — rusher must actually win here, proving this
  // is a real override reaching state.ai, not a no-op that happens to already match.
  const state = createGameState({ planetId: "ferros", aiArchetype: "rusher" });
  assert.equal(state.ai.archetype, ARCHETYPES.rusher);
  assert.notEqual(state.ai.archetype, ARCHETYPES.economist);
});

test("createGameState's opts.aiArchetype falls back to the planet's own archetype on an unknown key, same fallback createAiController itself uses", () => {
  const state = createGameState({ planetId: "ferros", aiArchetype: "not-a-real-archetype" });
  assert.equal(state.ai.archetype, ARCHETYPES.economist);
});
