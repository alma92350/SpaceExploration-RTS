/* ============================================================
   Guards for playerFingerprint.js — measuring a human and fitting an AI to them.

   This is the feature the genome work existed for: play against yourself. The properties that
   decide whether it delivers that, rather than delivering a plausible-looking number:

     1. IT ACTUALLY DISCRIMINATES. Two players who played differently must produce genomes that
        differ in the dials that matter. A fit that returns roughly the archetype default whatever
        it is shown is the failure mode here, and it is invisible without an explicit contrast.
     2. IT IS A RATIO, NOT AN ABSOLUTE. The engine composes archetype x strategy x difficulty, so
        "18 workers" has to become "1.5x this temperament" or the fit only describes the one
        archetype it was measured against.
     3. IT IS ALWAYS LEGAL. An extreme game must still produce a runnable AI — the same guarantee
        mutation has, via the same schema bounds.
     4. IT IS GROUND TRUTH, not fog-limited. Unlike engine/aiIntel.js, this is analysis of a
        finished game; crippling it with fog would be confusing the two.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintPlayer, genomeFromFingerprint, mirrorOfPlayer } from "../playerFingerprint.js";
import { GENOME_SCHEMA, geneKeys, toOverrides } from "../tools/genome.js";
import { ARCHETYPES } from "../engine/aiArchetypes.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { createGameState } from "../engine/state.js";

const world = () => {
  const s = createGameState({ planetId: "ferros", seed: 1 });
  for (const [id] of [...s.units]) s.units.delete(id);
  for (const [id] of [...s.buildings]) s.buildings.delete(id);
  return s;
};
let n = 0;
const unit = (s, owner, type, k = 1) => {
  for (let i = 0; i < k; i++)
    s.units.set(`u${n}`, { id: `u${n++}`, owner, type, x: 100 + i, y: 100, hp: UNITS[type].hp, order: null });
};
const build = (s, owner, type, k = 1) => {
  for (let i = 0; i < k; i++)
    s.buildings.set(`b${n}`, { id: `b${n++}`, owner, type, x: 100 + i, y: 200, hp: BUILDINGS[type].hp, constructing: false, queue: [] });
};

/* ---------- the measurement ---------- */

test("a builder and a warmonger fingerprint differently", () => {
  const builder = world();
  unit(builder, "player", "worker", 20);
  build(builder, "player", "refinery", 3);
  build(builder, "player", "command", 2);

  const warmonger = world();
  unit(warmonger, "player", "worker", 4);
  unit(warmonger, "player", "skiff", 25);
  build(warmonger, "player", "barracks", 3);

  const b = fingerprintPlayer(builder), w = fingerprintPlayer(warmonger);
  assert.ok(b.posture < 0.2, `a builder must read as economy (got ${b.posture})`);
  assert.ok(w.posture > 0.7, `a warmonger must read as war (got ${w.posture})`);
  assert.equal(b.bases, 2, "two Command Centers is someone who took ground");
  assert.equal(w.army, 25);
});

test("it measures the named owner only, and reads ground truth rather than fog", () => {
  const s = world();
  unit(s, "player", "skiff", 5);
  unit(s, "ai", "worker", 30);          // the opponent's economy must not land in the player's fingerprint
  // Nothing is revealed anywhere — a fog-limited read would return nothing at all here. This is
  // analysis of a finished game, not a decision the AI is making, so ground truth is correct.
  const fp = fingerprintPlayer(s, "player");
  assert.equal(fp.army, 5);
  assert.equal(fp.workers, 0, "the AI's workers are not the player's");
  assert.equal(fp.posture, 1);
});

test("an empty owner reads as 'nothing to say', not as a peaceful player", () => {
  const fp = fingerprintPlayer(world(), "player");
  assert.equal(fp.posture, null, "no assets at all must not read as posture 0");
  assert.equal(fp.total, 0);
});

test("the mix is what they actually built, most-used first", () => {
  const s = world();
  unit(s, "player", "skiff", 2);
  unit(s, "player", "lancer", 7);
  unit(s, "player", "bastion", 4);
  unit(s, "player", "mender", 9);        // support, not a production cycle entry
  const fp = fingerprintPlayer(s, "player");
  assert.deepEqual(fp.mix, ["lancer", "bastion", "skiff"],
    "descending by count — the type they leaned on hardest opens the cycle");
  assert.ok(!fp.mix.includes("mender"), "support units are not a mix gene");
});

/* ---------- the fit ---------- */

test("the fit DISCRIMINATES — a builder and a warmonger produce genuinely different AIs", () => {
  const builder = world();
  unit(builder, "player", "worker", 20);
  build(builder, "player", "refinery", 4);
  const warmonger = world();
  unit(warmonger, "player", "worker", 4);
  unit(warmonger, "player", "skiff", 25);
  build(warmonger, "player", "barracks", 3);

  const gb = genomeFromFingerprint(fingerprintPlayer(builder));
  const gw = genomeFromFingerprint(fingerprintPlayer(warmonger));

  assert.equal(gb.strategy.neverInitiates, true, "an overwhelmingly economic player does not start fights");
  assert.equal(gw.strategy.neverInitiates, false, "…and a warmonger does");
  assert.ok(gb.strategy.workerTargetMult > gw.strategy.workerTargetMult,
    "the builder's AI must keep the bigger economy");
  assert.ok(gw.strategy.armyAttackSizeMult > gb.strategy.armyAttackSizeMult,
    "the warmonger's AI must commit harder");
  assert.ok(gw.strategy.attackTimeoutMult < gb.strategy.attackTimeoutMult,
    "…and sooner");
});

test("dials are fitted as RATIOS against the archetype, so the same player transfers across worlds", () => {
  const s = world();
  unit(s, "player", "worker", 12);
  const fp = fingerprintPlayer(s, "player");
  // The same 12-worker player, fitted against two temperaments with different baselines, must
  // produce different multipliers — that is what "relative to this archetype" means.
  const vsRusher = genomeFromFingerprint(fp, { archetype: "rusher" });     // workerTarget 4
  const vsEconomist = genomeFromFingerprint(fp, { archetype: "economist" }); // workerTarget 8
  assert.ok(vsRusher.strategy.workerTargetMult > vsEconomist.strategy.workerTargetMult,
    "12 workers is a bigger stretch for a Rusher than for an Economist, and the fit must say so");
  // …and the product lands near the player's real number in both cases.
  for (const [arch, g] of [["rusher", vsRusher], ["economist", vsEconomist]]) {
    const implied = ARCHETYPES[arch].workerTarget * g.strategy.workerTargetMult;
    assert.ok(Math.abs(implied - 12) <= 4, `${arch}: implied worker target ${implied} is nowhere near the measured 12`);
  }
});

test("the player's own army becomes the AI's production cycle", () => {
  const s = world();
  unit(s, "player", "lancer", 6);
  unit(s, "player", "breacher", 3);
  const g = genomeFromFingerprint(fingerprintPlayer(s, "player"));
  assert.deepEqual(g.archetype.unitMix, ["lancer", "breacher"],
    "no inference needed — this gene is directly observable");
});

test("an extreme game still produces a LEGAL genome", () => {
  const s = world();
  unit(s, "player", "worker", 500);          // absurd, but a fingerprint must survive it
  build(s, "player", "turret", 200);
  build(s, "player", "barracks", 40);
  build(s, "player", "command", 12);
  const g = genomeFromFingerprint(fingerprintPlayer(s, "player"));
  for (const gene of geneKeys({ layers: ["strategy", "archetype"] })) {
    const v = g[gene.layer][gene.key];
    if (v === undefined || gene.kind === "flag" || gene.kind === "choice" || gene.kind === "mix") continue;
    assert.ok(v >= gene.min && v <= gene.max,
      `${gene.key} = ${v} escaped its schema bounds [${gene.min}, ${gene.max}] — an extreme game must clamp, not break`);
  }
});

test("a player who built no turrets against a no-turret archetype does not invent them", () => {
  const s = world();
  unit(s, "player", "skiff", 5);
  const g = genomeFromFingerprint(fingerprintPlayer(s, "player"), { archetype: "rusher" });
  // rusher.turretCount is 0, so there is no ratio to take; the fit must not fabricate a wall.
  assert.ok(!g.archetype.turretCount || g.archetype.turretCount === 0,
    "measuring zero turrets must not produce an AI that builds them");
});

/* ---------- the whole path ---------- */

test("mirrorOfPlayer hands back a runnable candidate in the shape everything else already speaks", () => {
  const s = world();
  unit(s, "player", "worker", 10);
  unit(s, "player", "skiff", 8);
  build(s, "player", "barracks", 2);
  const { candidate, fingerprint, genome } = mirrorOfPlayer(s, { name: "Your Mirror" });

  assert.equal(candidate.name, "Your Mirror");
  assert.equal(candidate.strategy, "Your Mirror");
  assert.ok(candidate.overrides.strategies["Your Mirror"], "a strategy row the engine can read");
  assert.ok(candidate.archetype, "…and its own archetype key, so the mix and counts actually apply");
  assert.ok(fingerprint.posture > 0 && fingerprint.posture < 1, "a mixed player reads as mixed");
  // The candidate must be exactly what toOverrides would produce from the genome — no divergence
  // between what was fitted and what will be run.
  const genes = geneKeys({ layers: ["strategy", "archetype"] });
  assert.deepEqual(candidate.overrides, toOverrides(genome, "Your Mirror", { genes }));
});

test("the fit is deterministic — the same state always yields the same AI", () => {
  const make = () => {
    const s = world();
    unit(s, "player", "worker", 9);
    unit(s, "player", "lancer", 4);
    build(s, "player", "turret", 2);
    return JSON.stringify(mirrorOfPlayer(s).candidate);
  };
  assert.equal(make(), make());
});

test("every dial the fit writes is a real gene", () => {
  // A fit that sets a key the schema does not know would be silently dropped by toOverrides — the
  // AI would come out as the archetype default and nobody would see why.
  const s = world();
  unit(s, "player", "worker", 11);
  unit(s, "player", "skiff", 6);
  build(s, "player", "turret", 3);
  build(s, "player", "barracks", 2);
  build(s, "player", "command", 2);
  const g = genomeFromFingerprint(fingerprintPlayer(s, "player"));
  const known = new Set(GENOME_SCHEMA.map(x => `${x.layer}.${x.key}`));
  for (const layer of ["strategy", "archetype"])
    for (const key of Object.keys(g[layer]))
      assert.ok(known.has(`${layer}.${key}`), `the fit wrote ${layer}.${key}, which is not in GENOME_SCHEMA`);
});
