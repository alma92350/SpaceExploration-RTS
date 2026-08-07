/* ============================================================
   Guards for tools/genome.js — the AI as a mutable, crossable data structure
   (docs/ai-evolution-design.md).

   An evolutionary search is only as trustworthy as its operators, and an operator bug here is
   nearly invisible from the outside: a run still produces a champion, still prints an Elo, and
   still looks like it worked. So these tests pin the properties that would fail SILENTLY —

     1. LEGALITY. Every genome a random walk can reach is in bounds and lowers to a runnable
        overrides document. A gene out of range doesn't crash; it just quietly wastes a run.
     2. DETERMINISM. Same seed => same genome, everywhere. The bench's whole contract.
     3. REACHABILITY. The properties that decide whether the search can MOVE: a ratio gene can
        never reach an absorbing 0, a count gene CAN reach 0 (it's a real allele), and the mix
        can change length in both directions.
     4. THE GATE. standingArmyCap is emitted only behind capsArmy, because aiEconomy.js tests its
        PRESENCE (`!= null`), so an ungated emit would turn the cap on for the whole population.
     5. NO SHIPPED-TABLE MUTATION. Building genomes from the shipped rows must not write back into
        STRATEGIES/ARCHETYPES — test/ailab.test.js's own history has a permanent-table-mutation
        finding in it (docs/code-improvement-tiers.md), and this file builds from those tables on
        every single call.
   ============================================================ */

import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import {
  GENOME_SCHEMA, MODULES, MIX_ALPHABET, geneKeys, genomeFrom, randomGenome, mutate, mutateMix,
  cross, crossMix, cloneGenome, emptyGenome, toOverrides, toCandidate, diffGenes, rngFor, sanitizeGenome,
} from "../tools/genome.js";
import { STRATEGIES } from "../engine/aiStrategy.js";
import { ARCHETYPES } from "../engine/aiArchetypes.js";

const ALL = geneKeys({ layers: ["strategy", "archetype"], odyssey: true });

/* ---------- the schema itself ---------- */

test("every gene declares a kind the operators implement, and bounds where its kind needs them", () => {
  const KINDS = new Set(["ratio", "count", "unit01", "flag", "choice", "mix"]);
  for (const g of GENOME_SCHEMA) {
    assert.ok(KINDS.has(g.kind), `${g.key}: unknown kind "${g.kind}"`);
    assert.ok(["strategy", "archetype"].includes(g.layer), `${g.key}: unknown layer "${g.layer}"`);
    assert.ok(g.module, `${g.key}: no module — crossover cuts at module boundaries`);
    if (["ratio", "count", "unit01"].includes(g.kind)) {
      assert.equal(typeof g.min, "number", `${g.key}: needs min`);
      assert.equal(typeof g.max, "number", `${g.key}: needs max`);
      assert.ok(g.max > g.min, `${g.key}: max must exceed min`);
    }
    if (g.kind === "choice") assert.ok(g.of && g.of.length >= 2, `${g.key}: a choice needs 2+ alleles`);
    // A ratio's lower bound must be strictly positive: 0 is ABSORBING under multiplicative
    // mutation, so a gene that ever reached it could never leave. See the KINDS note in
    // tools/genome.js's header for why that costs nothing (use sites round).
    if (g.kind === "ratio") assert.ok(g.min > 0, `${g.key}: a ratio's min must be > 0 (0 is absorbing)`);
  }
  assert.ok(MODULES.length >= 4, "crossover needs several linkage groups to cut between");
});

test("gene keys are unique — a duplicate would silently shadow in the lowered row", () => {
  const keys = GENOME_SCHEMA.map(g => `${g.layer}.${g.key}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("every gene key is one the ENGINE actually reads, or the schema is tuning nothing", () => {
  // A gene named after a field no use site consults is the quietest possible bug in this whole
  // system: the search runs, the numbers move, generations pass, and the AI never changes.
  //
  // Checked against the engine SOURCE rather than against the shipped tables. The shipped-table
  // version of this test passed vacuously for anything already in a row and — worse — failed for a
  // gene that is genuinely read but has no shipped default, which is exactly what an adaptation
  // dial looks like (engine/aiIntel.js reads strategy.punishPosture through a `?? 0.35`, and no
  // STRATEGIES row carries it). Reading the source asks the real question: does anything consume
  // this name?
  const engine = readdirSync(new URL("../engine/", import.meta.url))
    .filter(f => f.endsWith(".js"))
    .map(f => readFileSync(new URL(`../engine/${f}`, import.meta.url), "utf8"))
    .join("\n");
  const CAPS_ARMY = "strategy.capsArmy";   // this file's own switch — gates standingArmyCap, never read by the engine
  for (const g of GENOME_SCHEMA) {
    if (`${g.layer}.${g.key}` === CAPS_ARMY) continue;
    // Strategy dials are read as `strategy.key`; archetype dials either as `archetype.key` or
    // through engine/ai.js's Odyssey-overlay reader, `arch("key")`.
    const patterns = [`strategy.${g.key}`, `archetype.${g.key}`, `arch("${g.key}")`, `.${g.key}`];
    assert.ok(patterns.some(p => engine.includes(p)),
      `gene "${g.key}" is read by nothing under engine/ — evolving it would tune nothing at all`);
  }
});

test("the adaptation genes really are wired into the engine's own reads", () => {
  // Sharper than the sweep above, because these are the newest and the easiest to leave dangling:
  // assert each one appears at the exact `strategy.X` read site engine/aiIntel.js uses.
  const intel = readFileSync(new URL("../engine/aiIntel.js", import.meta.url), "utf8");
  for (const key of ["punishPosture", "punishConfidence", "adaptRateMult", "adaptBandMult", "defenceSwingMult"]) {
    assert.ok(intel.includes(`strategy.${key}`), `${key} is not read in engine/aiIntel.js`);
    assert.ok(GENOME_SCHEMA.some(g => g.key === key && g.module === "adaptation"),
      `${key} must be in the adaptation linkage group so crossover cuts around it as a set`);
  }
});

test("geneKeys defaults to the strategy chromosome and drops Odyssey-gated genes", () => {
  const def = geneKeys();
  assert.ok(def.length > 0);
  assert.ok(def.every(g => g.layer === "strategy"), "default layer set is strategy-only");
  assert.ok(def.every(g => !g.odysseyOnly),
    "a duel is a skirmish — Odyssey-gated genes are read by nothing there, so they must not be searched");
  // …and asking for them explicitly gets them back.
  assert.ok(geneKeys({ odyssey: true }).some(g => g.odysseyOnly));
  assert.ok(geneKeys({ layers: ["strategy", "archetype"] }).some(g => g.layer === "archetype"));
});

/* ---------- legality under a random walk ---------- */

const inBounds = (genome, genes) => {
  for (const g of genes) {
    const v = genome[g.layer][g.key];
    switch (g.kind) {
      case "ratio": case "unit01":
        assert.equal(typeof v, "number", `${g.key} not a number: ${v}`);
        assert.ok(Number.isFinite(v), `${g.key} not finite: ${v}`);
        assert.ok(v >= g.min - 1e-9 && v <= g.max + 1e-9, `${g.key} out of [${g.min}, ${g.max}]: ${v}`);
        break;
      case "count":
        assert.ok(Number.isInteger(v), `${g.key} not an integer: ${v}`);
        assert.ok(v >= g.min && v <= g.max, `${g.key} out of [${g.min}, ${g.max}]: ${v}`);
        break;
      case "flag":   assert.equal(typeof v, "boolean", `${g.key} not a boolean: ${v}`); break;
      case "choice": assert.ok(g.of.includes(v), `${g.key} not an allele: ${v}`); break;
      case "mix":
        assert.ok(Array.isArray(v) && v.length >= 2, `${g.key} not a usable mix: ${JSON.stringify(v)}`);
        assert.ok(v.every(t => MIX_ALPHABET.includes(t)), `${g.key} has a type off the alphabet: ${v}`);
        break;
    }
  }
};

test("2000 generations of mutation never produce an out-of-bounds gene", () => {
  const rng = rngFor(11);
  let g = randomGenome(rng, ALL);
  inBounds(g, ALL);
  for (let i = 0; i < 2000; i++) {
    g = mutate(g, rng, { rate: 0.5, flagRate: 0.2, genes: ALL });
    inBounds(g, ALL);
    assert.ok(g.sigma >= 0.03 - 1e-9 && g.sigma <= 0.8 + 1e-9, `sigma escaped: ${g.sigma}`);
  }
});

test("crossover of two random parents is in bounds, for every mode", () => {
  const rng = rngFor(12);
  for (let i = 0; i < 500; i++) {
    const a = randomGenome(rng, ALL), b = randomGenome(rng, ALL);
    inBounds(cross(a, b, rng, { genes: ALL }), ALL);
    inBounds(cross(a, b, rng, { moduleWise: 1, blend: 0, genes: ALL }), ALL);
    inBounds(cross(a, b, rng, { moduleWise: 0, blend: 1, genes: ALL }), ALL);
    inBounds(cross(a, b, rng, { moduleWise: 0, blend: 0, genes: ALL }), ALL);   // clone
  }
});

/* ---------- determinism ---------- */

test("same seed => byte-identical genome, through every operator", () => {
  const walk = seed => {
    const rng = rngFor(seed);
    let g = randomGenome(rng, ALL);
    for (let i = 0; i < 50; i++) g = mutate(cross(g, randomGenome(rng, ALL), rng, { genes: ALL }), rng, { genes: ALL });
    return JSON.stringify(g);
  };
  assert.equal(walk(7), walk(7));
  assert.notEqual(walk(7), walk(8));
});

test("building from the shipped tables never writes back into them", () => {
  const before = JSON.stringify({ s: STRATEGIES, a: ARCHETYPES });
  const rng = rngFor(3);
  for (const key of Object.keys(STRATEGIES)) {
    const g = genomeFrom({ strategy: key, genes: ALL });
    const m = mutate(g, rng, { rate: 1, flagRate: 1, genes: ALL });
    m.archetype.unitMix.push("skiff");            // mutate the copy as hard as a caller could
    m.strategy.attackTimeoutMult = 99;
    toOverrides(m, "x", { genes: ALL });
  }
  assert.equal(JSON.stringify({ s: STRATEGIES, a: ARCHETYPES }), before);
});

test("cloneGenome deep-copies the one gene that is a reference", () => {
  const g = genomeFrom({ genes: ALL });
  const c = cloneGenome(g);
  c.archetype.unitMix.push("colossus");
  assert.notEqual(g.archetype.unitMix.length, c.archetype.unitMix.length);
});

/* ---------- reachability: can the search actually move? ---------- */

test("a ratio gene never reaches 0 — 0 is absorbing under multiplicative mutation", () => {
  const rng = rngFor(21);
  const genes = geneKeys().filter(g => g.kind === "ratio");
  let g = genomeFrom({ strategy: "aggressive" });
  for (let i = 0; i < 3000; i++) {
    g = mutate(g, rng, { rate: 1, genes: geneKeys() });
    for (const gene of genes) assert.ok(g.strategy[gene.key] > 0, `${gene.key} hit 0 and can never leave`);
  }
});

test("a count gene DOES reach 0 — it is a real allele (rusher.turretCount, rusher.garrison)", () => {
  const rng = rngFor(22);
  const genes = geneKeys();
  let g = genomeFrom({ strategy: "economic", genes });
  let sawZero = false;
  for (let i = 0; i < 3000 && !sawZero; i++) {
    g = mutate(g, rng, { rate: 1, genes });
    if (g.strategy.standingArmyCap === 0 || g.strategy.matchFloor === 0) sawZero = true;
  }
  assert.ok(sawZero, "a count gene never reached 0 in 3000 mutations — the low end is unreachable");
});

test("the mix changes length in BOTH directions and stays inside its length bounds", () => {
  const rng = rngFor(23);
  let mix = [...ARCHETYPES.balanced.unitMix];
  const start = mix.length;
  let grew = false, shrank = false;
  for (let i = 0; i < 2000; i++) {
    mix = mutateMix(mix, rng);
    assert.ok(mix.length >= 2 && mix.length <= 10, `mix length escaped: ${mix.length}`);
    if (mix.length > start) grew = true;
    if (mix.length < start) shrank = true;
  }
  assert.ok(grew && shrank, `mix never changed length both ways (grew ${grew}, shrank ${shrank})`);
});

test("order crossover of two mixes draws only from its parents' alphabet and keeps a legal length", () => {
  const rng = rngFor(24);
  for (let i = 0; i < 500; i++) {
    const a = randomGenome(rng, ALL).archetype.unitMix;
    const b = randomGenome(rng, ALL).archetype.unitMix;
    const c = crossMix(a, b, rng);
    assert.ok(c.length >= 2 && c.length <= 10, `crossMix length ${c.length}`);
    const parents = new Set([...a, ...b]);
    assert.ok(c.every(t => parents.has(t)), "crossMix invented a unit neither parent fielded");
  }
});

test("self-adaptive sigma actually moves, in both directions", () => {
  const rng = rngFor(25);
  let g = emptyGenome();
  let up = false, down = false;
  for (let i = 0; i < 200; i++) {
    const prev = g.sigma;
    g = mutate(g, rng, { genes: [] });
    if (g.sigma > prev) up = true;
    if (g.sigma < prev) down = true;
  }
  assert.ok(up && down, "sigma is not self-adapting");
});

/* ---------- module-wise crossover is actually module-wise ---------- */

test("module-wise crossover takes whole linkage groups, never a mix of parents within one", () => {
  const rng = rngFor(31);
  const genes = geneKeys();
  let sawSplit = false;                       // …and it must sometimes take DIFFERENT parents per module
  for (let i = 0; i < 200; i++) {
    const a = randomGenome(rng, genes), b = randomGenome(rng, genes);
    const c = cross(a, b, rng, { moduleWise: 1, blend: 0, genes });
    const parentOf = new Map();
    for (const g of genes) {
      const v = c[g.layer][g.key], va = a[g.layer][g.key], vb = b[g.layer][g.key];
      if (va === vb) continue;                // uninformative — both parents agree
      const src = v === va ? "a" : v === vb ? "b" : "?";
      assert.notEqual(src, "?", `${g.key} came from neither parent`);
      if (parentOf.has(g.module)) assert.equal(src, parentOf.get(g.module),
        `module "${g.module}" was split across parents — that is uniform crossover, not module-wise`);
      parentOf.set(g.module, src);
    }
    if (new Set(parentOf.values()).size > 1) sawSplit = true;
  }
  assert.ok(sawSplit, "every child took every module from one parent — crossover is doing nothing");
});

test("blend crossover puts an ordered gene BETWEEN its parents", () => {
  const rng = rngFor(32);
  const genes = geneKeys().filter(g => g.kind === "ratio");
  for (let i = 0; i < 200; i++) {
    const a = randomGenome(rng, geneKeys()), b = randomGenome(rng, geneKeys());
    const c = cross(a, b, rng, { moduleWise: 0, blend: 1, genes: geneKeys() });
    for (const g of genes) {
      const lo = Math.min(a.strategy[g.key], b.strategy[g.key]);
      const hi = Math.max(a.strategy[g.key], b.strategy[g.key]);
      const v = c.strategy[g.key];
      assert.ok(v >= lo - 1e-3 && v <= hi + 1e-3, `${g.key}: ${v} is not between ${lo} and ${hi}`);
    }
  }
});

/* ---------- lowering ---------- */

test("standingArmyCap is emitted ONLY behind its capsArmy gate", () => {
  const genes = geneKeys();
  const on = genomeFrom({ strategy: "economic", genes });
  assert.equal(on.strategy.capsArmy, true, "Economic ships a standingArmyCap, so its gate starts on");
  assert.ok("standingArmyCap" in toOverrides(on, "x", { genes }).strategies.x);

  const off = cloneGenome(on);
  off.strategy.capsArmy = false;
  const lowered = toOverrides(off, "x", { genes }).strategies.x;
  // aiEconomy.js reads `strategy.standingArmyCap != null` — emitting a number at all IS the switch,
  // so an ungated emit would cap the army of every genome in the population.
  assert.ok(!("standingArmyCap" in lowered), "an ungated standingArmyCap caps the whole population");
  // …and the gate itself is never emitted as a dial, because nothing reads it.
  assert.ok(!("capsArmy" in lowered));
});

test("a lowered genome is exactly the --overrides shape, and archetypes get a key of their own", () => {
  const genes = geneKeys({ layers: ["strategy", "archetype"] });
  const g = genomeFrom({ strategy: "aggressive", archetype: "rusher", genes });
  const cand = toCandidate(g, "gen1i0", { genes });
  assert.equal(cand.name, "gen1i0");
  assert.equal(cand.strategy, "gen1i0");
  assert.deepEqual(Object.keys(cand.overrides.strategies), ["gen1i0"]);
  // Never over a SHIPPED archetype key: two candidates in one duel share a live table and
  // applyOverrides merges, so patching a shared key leaves both seats playing a row belonging to
  // neither — the collision tools/ailab.js's assertNoOverrideCollision refuses outright.
  assert.deepEqual(Object.keys(cand.overrides.archetypes), ["gen1i0-arch"]);
  assert.equal(cand.archetype, "gen1i0-arch");
  assert.ok(!Object.keys(ARCHETYPES).includes("gen1i0-arch"), "toCandidate must not touch the live table");
});

test("a strategy-only genome carries no archetype at all, so runDuel forwards null", () => {
  const cand = toCandidate(genomeFrom({ strategy: "economic" }), "x");
  assert.equal(cand.archetype, undefined);
  assert.equal(cand.overrides.archetypes, undefined);
});

test("genomeFrom round-trips a shipped strategy's own values", () => {
  const genes = geneKeys({ odyssey: true });
  const g = genomeFrom({ strategy: "aggressive", genes });
  assert.equal(g.strategy.attackTimeoutMult, STRATEGIES.aggressive.attackTimeoutMult);
  assert.equal(g.strategy.garrisonMult, STRATEGIES.aggressive.garrisonMult);
  assert.equal(g.strategy.useBombOffensively, true);
  // A gene the shipped row doesn't carry is FILLED from the schema, never left absent — an absent
  // gene has nothing to mutate multiplicatively and nothing to blend, so it would be frozen.
  for (const gene of genes) assert.notEqual(g[gene.layer][gene.key], undefined, `${gene.key} left absent`);
});

test("diffGenes names what moved and stays silent when nothing did", () => {
  const a = genomeFrom({ strategy: "default" });
  assert.equal(diffGenes(a, cloneGenome(a)), "");
  const b = cloneGenome(a);
  b.strategy.garrisonMult = 2.5;
  assert.match(diffGenes(b, a), /garrisonMult=2\.5/);
});

/* ---------- sanitizeGenome: the untrusted-input boundary ----------

   Once a genome can arrive from outside the program — a player-edited AI, an imported ladder file,
   a mirror someone was sent — it is data this project is HANDED, not data it produced. And it is
   not inert: toOverrides writes it straight into the live tables the engine reads every think
   cycle. These pin that GENOME_SCHEMA is enforced as a whitelist rather than a suggestion.
   ---------- */

test("an unknown key is DROPPED, not passed through", () => {
  const g = sanitizeGenome({ strategy: { workerTargetMult: 1.2, notAGene: 99, __proto__: { x: 1 } } });
  assert.equal(g.strategy.workerTargetMult, 1.2, "a real gene survives");
  assert.ok(!("notAGene" in g.strategy), "a key the schema does not name must not survive");
  assert.equal(({}).x, undefined, "and nothing may reach Object.prototype");
});

test("numbers are coerced and CLAMPED to their own gene's bounds", () => {
  const g = sanitizeGenome({ strategy: { workerTargetMult: "99999", garrisonMult: -50 } });
  const wt = GENOME_SCHEMA.find(x => x.key === "workerTargetMult");
  const gm = GENOME_SCHEMA.find(x => x.key === "garrisonMult");
  assert.equal(g.strategy.workerTargetMult, wt.max, "a string number is coerced, then clamped to max");
  assert.equal(g.strategy.garrisonMult, gm.min, "…and a negative to min");
});

test("a non-finite number is dropped rather than poisoning every multiplication it joins", () => {
  for (const bad of [NaN, Infinity, -Infinity, "not a number", {}, []]) {
    const g = sanitizeGenome({ strategy: { attackTimeoutMult: bad } });
    assert.ok(!("attackTimeoutMult" in g.strategy), `${String(bad)} must not become a dial`);
  }
});

test("flags are strictly boolean — a truthy string is not a yes", () => {
  assert.equal(sanitizeGenome({ strategy: { neverInitiates: "yes" } }).strategy.neverInitiates, false);
  assert.equal(sanitizeGenome({ strategy: { neverInitiates: 1 } }).strategy.neverInitiates, false);
  assert.equal(sanitizeGenome({ strategy: { neverInitiates: true } }).strategy.neverInitiates, true);
});

test("a categorical must be a declared allele", () => {
  assert.equal(sanitizeGenome({ archetype: { doctrine: "assault" } }).archetype.doctrine, "assault");
  assert.ok(!("doctrine" in sanitizeGenome({ archetype: { doctrine: "evil" } }).archetype),
    "an undeclared allele must be dropped, not stored");
});

test("the mix is filtered to the known alphabet and to a legal length", () => {
  const g = sanitizeGenome({ archetype: { unitMix: ["skiff", "__proto__", "lancer", "notaunit", 7, null] } });
  assert.deepEqual(g.archetype.unitMix, ["skiff", "lancer"], "only real unit types survive");
  // Too short to be a production cycle: dropped rather than padded, because inventing units the
  // author never chose would misrepresent the genome. Absent falls back to the archetype's own mix.
  assert.ok(!("unitMix" in sanitizeGenome({ archetype: { unitMix: ["skiff"] } }).archetype));
  const huge = sanitizeGenome({ archetype: { unitMix: Array(500).fill("skiff") } });
  assert.ok(huge.archetype.unitMix.length <= 10, "an unbounded mix must be capped");
});

test("a sanitised genome is always a LEGAL genome — it lowers and runs", () => {
  const hostile = {
    strategy: { workerTargetMult: "1e400", neverInitiates: [], punishConfidence: -3 },
    archetype: { unitMix: ["colossus", "skiff"], turretCount: 1e9, faction: "nonsense" },
    sigma: Infinity,
  };
  const g = sanitizeGenome(hostile);
  const genes = geneKeys({ layers: ["strategy", "archetype"], odyssey: true });
  inBounds({ ...g, strategy: { ...genomeFrom({ genes }).strategy, ...g.strategy },
             archetype: { ...genomeFrom({ genes }).archetype, ...g.archetype } }, genes);
  assert.ok(g.sigma >= 0.03 && g.sigma <= 0.8, `sigma escaped: ${g.sigma}`);
  assert.ok(toOverrides(g, "hostile", { genes }).strategies.hostile, "it still lowers to a runnable row");
});

test("garbage that is not an object at all returns null rather than throwing", () => {
  for (const bad of [null, undefined, 42, "genome", [], true])
    assert.equal(sanitizeGenome(bad), null, `${String(bad)} must return null`);
});
