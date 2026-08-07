/* ============================================================
   GENOME — the AI as a mutable, crossable data structure (docs/ai-evolution-design.md)

   tools/ailab.js's own header already makes the observation this file builds on: "a candidate
   strategy is a JSON object, not a code change". What that means, said in the other vocabulary,
   is that the AI has a GENOTYPE — and that its genotype→phenotype map is unusually forgiving,
   because ARCHETYPES / STRATEGIES / DIFFICULTY_OPTIONS are read at their use sites through
   `|| 1`-style defaults. An arbitrary mutation is therefore always a RUNNABLE AI rather than a
   crash, which is the expensive precondition for evolutionary search and which this codebase
   happens to satisfy already.

   This file adds the three things applyOverrides does not have:

     1. A SCHEMA (GENOME_SCHEMA) — what a legal gene is: its layer, its kind, its bounds, and
        which functional module it belongs to. One source of truth, the same role
        DIFFICULTY_OPTIONS plays for difficulty keys.
     2. VARIATION OPERATORS — mutate() and cross(), with an operator per gene KIND rather than
        one operator for everything (see KINDS below; this is the design decision that matters
        most and the most common way a mixed-genome GA fails).
     3. A LOWERING (toOverrides / toCandidate) back into exactly the `--overrides` shape
        tools/ailab.js already consumes, so an evolved genome drops straight into sweep / duel /
        swiss / leaderboard with no adapter anywhere.

   PURE AND SEEDED. Every operator takes an explicit `rng` (a mulberry32 stream) and reads no
   clock — so a whole evolutionary run reproduces from one integer, exactly like every other
   number this bench prints. Lives in tools/ for the same reason tools/ailab.js does: the engine
   stays the pure shipped simulation and never learns that any of this exists.

   THE KINDS, and why each needs its own operator
   ----------------------------------------------
     ratio    A multiplier composed onto an archetype's own number (attackTimeoutMult, …). These
              are RATIOS, so they mutate multiplicatively — in log space — never additively: an
              additive ±0.1 is a 50% change at 0.2 and a 7% change at 1.5, which searches the low
              end far too coarsely and the high end far too finely.
                Note the lower bounds below are small but never 0. Zero is an ABSORBING state
              under multiplicative mutation (0 × anything is 0, forever), and it isn't needed:
              every use site rounds, so garrisonMult 0.05 against an archetype garrison of 3 is
              already `Math.round(0.15)` = 0, the all-in Rusher behaviour, reachably and
              reversibly.
     count    An integer headcount (standingArmyCap, matchFloor, turretCount, …). Additive
              integer step scaled to the gene's own range, so 0 stays REACHABLE — 0 is a
              meaningful allele here, not a degenerate one (rusher.turretCount and
              rusher.garrison are both deliberately 0).
     unit01   A bounded fraction (expandWhenNodesBelow). Additive, clamped to its range.
     flag     A boolean. Flipped RARELY (flagRate, default 4%), because these are not ordinary
              genes: they are EPISTATIC SWITCHES that decide whether other genes mean anything
              at all. Under neverInitiates every offense gene is inert (aiMilitary.js blocks
              every voluntary commit); under capsArmy=false standingArmyCap is never emitted.
              At a high flip rate the population never settles in one landscape long enough to
              tune the dials in it.
                The inert genes keep drifting — junk DNA — and that is deliberate: a lineage
              that flips a switch back lands somewhere NEW rather than at its ancestral value,
              which is one of the main ways a GA escapes a local optimum. It costs nothing here
              because the `|| 1` convention means an unread gene is carried, not erased.
     choice   An unordered categorical (doctrine, faction). No metric exists on these — `miners`
              is not "between" `syndicate` and `frontier` — so mutation resamples uniformly and
              crossover takes one parent's allele whole.
     mix      A CYCLIC SEQUENCE over an alphabet of unit types (unitMix), variable length, where
              both order and multiplicity carry meaning: it is a repeating production cycle, so
              three skiffs in four slots IS the Rusher, and a rotation decides which unit gets
              built first. Its operators are the sequence-GA ones (substitute / duplicate /
              delete / insert / rotate, and order crossover). Safe to mutate hard because
              aiWorkers.js's effectiveMix already drops entries a world can't pay for or hasn't
              teched to — an illegal mix degrades to a no-op instead of wedging production.

   WHAT IS DELIBERATELY NOT A GENE
   -------------------------------
   The DIFFICULTY layer (engine/aiDifficulty.js). It is the duel FAIRNESS PIN: pinnedDuelDials
   (tools/duelCore.js) reads one difficulty row into one object both sides spread from, and every
   duel row reads apm/micro back off the live controllers to prove they never diverged. A genome
   able to touch that layer would be selected for an APM edge, not for strategy.
   ============================================================ */

"use strict";

import { mulberry32 } from "../engine/rng.js";
import { STRATEGIES } from "../engine/aiStrategy.js";
import { ARCHETYPES } from "../engine/aiArchetypes.js";

/* ============================================================
   THE SCHEMA
   ============================================================ */

// The unitMix alphabet is the UNION of the vocabulary the four shipped archetypes already field
// (engine/aiArchetypes.js) — deliberately NOT every UNITS entry with role "combat". Two reasons:
// it keeps evolution recombining a vocabulary a designer has already judged coherent, and it
// leaves out `leviathan`, whose Star Dock sits at the far end of the Odyssey industry chain and
// which no skirmish-length duel could ever reach.
export const MIX_ALPHABET =
  ["skiff", "bastion", "lancer", "breacher", "dreadnought", "wraith", "aegis", "colossus"];

const MIX_MIN_LEN = 2, MIX_MAX_LEN = 10;

/**
 * Every gene, with the information the operators need to vary it legally.
 *   layer        which table it is lowered into — "strategy" or "archetype".
 *   kind         which operator applies (see the KINDS section in this file's header).
 *   module       the LINKAGE GROUP crossover cuts at (see cross() below). These map one-to-one
 *                onto the engine files that consume them, which is why cutting here preserves a
 *                working sub-solution instead of shredding it.
 *   odysseyOnly  the use site is behind a `state.endless` / `state.diplomacy` guard, so this
 *                gene is INERT in a skirmish — and every duel is a skirmish (tools/selfplay.js:
 *                "skirmish-only — no Odyssey, no diplomacy, no galaxy"). A duel-scored search
 *                must drop these or it is scoring pure drift; see geneKeys() and the evolve
 *                command's own `--fitness` handling.
 *   gatedBy      this gene is only emitted when the named flag gene is true. Only for genes
 *                whose use site tests PRESENCE rather than value (standingArmyCap's `!= null`),
 *                where emitting a default would silently change behaviour.
 * @typedef {{ key: string, layer: string, kind: string, module: string,
 *   min?: number, max?: number, of?: string[], odysseyOnly?: boolean, gatedBy?: string }} Gene
 */
/** @type {Gene[]} */
export const GENOME_SCHEMA = [
  // ---- OFFENSE — engine/aiMilitary.js aiOffense, engine/aiSuperweapon.js ----
  { key: "attackTimeoutMult",  layer: "strategy", kind: "ratio", min: 0.15, max: 3,   module: "offense" },
  { key: "armyAttackSizeMult", layer: "strategy", kind: "ratio", min: 0.2,  max: 3,   module: "offense" },
  { key: "garrisonMult",       layer: "strategy", kind: "ratio", min: 0.05, max: 3,   module: "offense" },
  { key: "neverInitiates",     layer: "strategy", kind: "flag",                       module: "offense" },
  { key: "useBombOffensively", layer: "strategy", kind: "flag",                       module: "offense", odysseyOnly: true },

  // ---- ECONOMY — engine/aiEconomy.js, engine/aiIndustry.js ----
  { key: "workerTargetMult",   layer: "strategy", kind: "ratio", min: 0.5,  max: 2,   module: "economy" },
  // capsArmy is the SWITCH, standingArmyCap the value it gates: aiEconomy.js reads
  // `strategy.standingArmyCap != null`, so emitting a number at all is what turns the cap on.
  // Modelled as two genes rather than a nullable one so the epistasis is explicit and the value
  // keeps drifting while the switch is off (see the flag note in this file's header).
  { key: "capsArmy",           layer: "strategy", kind: "flag",                       module: "economy" },
  { key: "standingArmyCap",    layer: "strategy", kind: "count", min: 0,    max: 40,  module: "economy", gatedBy: "capsArmy" },
  { key: "warFootingMult",     layer: "strategy", kind: "ratio", min: 1,    max: 10,  module: "economy" },
  { key: "warFootingTime",     layer: "strategy", kind: "ratio", min: 10,   max: 300, module: "economy" },
  { key: "wantsIndustryAlways", layer: "strategy", kind: "flag",                      module: "economy", odysseyOnly: true },

  // ---- DEFENSE — engine/aiEconomy.js turret cap + the Force Parity mirror ----
  { key: "turretCountMult",    layer: "strategy", kind: "ratio", min: 0.2,  max: 3,   module: "defense" },
  { key: "matchEnemyForce",    layer: "strategy", kind: "flag",                       module: "defense" },
  { key: "matchBuffer",        layer: "strategy", kind: "ratio", min: 0.5,  max: 2.5, module: "defense" },
  { key: "matchFloor",         layer: "strategy", kind: "count", min: 0,    max: 20,  module: "defense" },

  // ---- DIPLOMACY — engine/diplomacy.js. Odyssey-only, every one of them: a skirmish state has
  // no state.diplomacy at all, so these are read by nothing in a duel.
  { key: "graceMult",          layer: "strategy", kind: "ratio", min: 0.1,  max: 3,   module: "diplomacy", odysseyOnly: true },
  { key: "grievanceMult",      layer: "strategy", kind: "ratio", min: 0.3,  max: 3,   module: "diplomacy", odysseyOnly: true },
  { key: "forgiveness",        layer: "strategy", kind: "ratio", min: 0.3,  max: 3,   module: "diplomacy", odysseyOnly: true },

  // ---- ADAPTATION — the POLICY the AI reads its opponent with (engine/aiIntel.js,
  // docs/ai-adaptive-opponent.md). These are the genes that make the search breed a reactive
  // BEHAVIOUR rather than a fixed build: when to call an opponent greedy and punish it, how much
  // evidence to demand first, how twitchy or stubborn the stance is, and how far the stance is
  // allowed to swing investment. Every one is read through a `?? default` at its use site, so an
  // absent value is exactly the shipped behaviour.
  //   Their own linkage group on purpose: they interact strongly with each other (a low evidence
  // bar with a twitchy rate is a very different AI from either alone) and weakly with everything
  // else, which is precisely the condition module-wise crossover is built for.
  { key: "punishPosture",    layer: "strategy", kind: "ratio", min: 0.1,  max: 0.8, module: "adaptation" },
  { key: "punishConfidence", layer: "strategy", kind: "ratio", min: 0.05, max: 0.8, module: "adaptation" },
  { key: "adaptRateMult",    layer: "strategy", kind: "ratio", min: 0.25, max: 4,   module: "adaptation" },
  { key: "adaptBandMult",    layer: "strategy", kind: "ratio", min: 0.25, max: 4,   module: "adaptation" },
  { key: "defenceSwingMult", layer: "strategy", kind: "ratio", min: 0.05, max: 2,   module: "adaptation" },

  // ---- MACRO — the archetype's own counts. Only in play when the archetype chromosome is
  // enabled (`--genes strategy,archetype`), which also requires the per-side archetype plumb
  // through runDuel — see tools/ailab.js.
  { key: "workerTarget",       layer: "archetype", kind: "count", min: 3,  max: 30,  module: "macro" },
  { key: "expandWhenNodesBelow", layer: "archetype", kind: "unit01", min: 0, max: 0.8, module: "macro" },
  { key: "maxBarracks",        layer: "archetype", kind: "count",  min: 1,  max: 5,   module: "macro" },
  { key: "wantsRefinery",      layer: "archetype", kind: "flag",                      module: "macro" },

  // ---- TEMPO — the archetype's own offense numbers, which the strategy multipliers compose onto.
  { key: "armyAttackSize",     layer: "archetype", kind: "count", min: 2,  max: 30,  module: "tempo" },
  { key: "attackTimeout",      layer: "archetype", kind: "ratio", min: 30, max: 400, module: "tempo" },
  { key: "garrison",           layer: "archetype", kind: "count", min: 0,  max: 15,  module: "tempo" },
  { key: "turretCount",        layer: "archetype", kind: "count", min: 0,  max: 8,   module: "tempo" },

  // ---- COMPOSITION — what it actually builds, and who it builds it as.
  { key: "unitMix",            layer: "archetype", kind: "mix",                       module: "composition" },
  { key: "doctrine",           layer: "archetype", kind: "choice", of: ["assault", "bulwark"], module: "composition" },
  { key: "faction",            layer: "archetype", kind: "choice", of: ["frontier", "miners", "syndicate"], module: "composition" },
];

const BY_KEY = new Map(GENOME_SCHEMA.map(g => [g.key, g]));

/** Every distinct linkage group in the schema, in declaration order. @returns {string[]} */
export const MODULES = [...new Set(GENOME_SCHEMA.map(g => g.module))];

/**
 * The genes a given run is allowed to vary.
 * @param {{ layers?: string[], odyssey?: boolean }} [opts]
 *   layers   which chromosomes are in play (default: strategy only — see the design doc's Phase 1).
 *   odyssey  include genes whose use site is Odyssey-gated. FALSE by default, because the duel
 *            objective is a skirmish and those genes are read by nothing there.
 * @returns {Gene[]}
 */
export function geneKeys({ layers = ["strategy"], odyssey = false } = {}) {
  return GENOME_SCHEMA.filter(g => layers.includes(g.layer) && (odyssey || !g.odysseyOnly));
}

/* ============================================================
   RANDOM SOURCES — all seeded, all explicit
   ============================================================ */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Box-Muller. One draw costs two rng() calls; taking only the cosine half (rather than caching
// the sine) keeps the stream position a pure function of how many gaussians have been drawn,
// which is what makes a run reproducible from its seed alone.
function gauss(rng) {
  const u = 1 - rng();   // (0, 1] — log(0) is -Infinity
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** A seeded stream, so callers never reach for Math.random. @param {number} seed */
export const rngFor = seed => mulberry32(seed >>> 0);

/* ============================================================
   THE GENOME ITSELF
   ============================================================ */

// The self-adaptive mutation step. Carried AS A GENE (mutated alongside the rest, in log space)
// rather than fixed by the caller: an individual whose lineage is still climbing benefits from a
// wide step, one sitting near an optimum from a narrow one, and evolution picks which by the only
// evidence that matters — whether the offspring survived. Four lines for the highest-value trick
// in evolution strategies.
const SIGMA_MIN = 0.03, SIGMA_MAX = 0.8, SIGMA_DEFAULT = 0.2;
const SIGMA_LEARNING_RATE = 0.3;

/** @typedef {{ strategy: Object, archetype: Object, sigma: number }} Genome */

/** An empty genome carrying no genes at all — every field absent, which every use site reads as
 * its own default. The identity element for the operators below. @returns {Genome} */
export const emptyGenome = () => ({ strategy: {}, archetype: {}, sigma: SIGMA_DEFAULT });

/** Deep-enough copy: gene values are numbers, booleans, strings, or a flat array (unitMix).
 * @param {Genome} g @returns {Genome} */
export const cloneGenome = g => ({
  strategy: { ...g.strategy },
  archetype: { ...g.archetype, ...(g.archetype.unitMix ? { unitMix: [...g.archetype.unitMix] } : {}) },
  sigma: g.sigma,
});

/**
 * Seed a genome from a SHIPPED row — the four hand-tuned strategies and the four archetypes are
 * the best starting points anyone has, and a GA that throws them away is starting from behind.
 * Genes the shipped row doesn't carry are filled from the schema's midpoint rather than left
 * absent, so the genome is complete and every operator has something to work on (an absent gene
 * would otherwise be frozen: nothing to mutate multiplicatively, nothing to blend).
 * @param {{ strategy?: string, archetype?: string, genes?: Gene[] }} [opts]
 * @returns {Genome}
 */
export function genomeFrom({ strategy = "default", archetype = "balanced", genes = geneKeys() } = {}) {
  const src = { strategy: STRATEGIES[strategy] || {}, archetype: ARCHETYPES[archetype] || {} };
  const out = emptyGenome();
  for (const g of genes) {
    const shipped = src[g.layer][g.key];
    out[g.layer][g.key] = shipped !== undefined ? (g.kind === "mix" ? [...shipped] : shipped) : midpoint(g);
  }
  // capsArmy has no shipped counterpart — it is this file's own explicit rendering of "does this
  // strategy carry a standingArmyCap at all", so derive it from whether the source row did.
  if (BY_KEY.has("capsArmy") && genes.some(g => g.key === "capsArmy"))
    out.strategy.capsArmy = src.strategy.standingArmyCap != null;
  return out;
}

function midpoint(g) {
  switch (g.kind) {
    case "ratio":  return +Math.sqrt(g.min * g.max).toFixed(3);   // geometric — a ratio's own midpoint
    case "count":  return Math.round((g.min + g.max) / 2);
    case "unit01": return +((g.min + g.max) / 2).toFixed(3);
    case "flag":   return false;
    case "choice": return g.of[0];
    case "mix":    return [...ARCHETYPES.balanced.unitMix];
    default:       throw new Error(`unknown gene kind "${g.kind}"`);
  }
}

/** A uniformly random genome over `genes` — the exploration half of an initial population.
 * @param {() => number} rng @param {Gene[]} [genes] @returns {Genome} */
export function randomGenome(rng, genes = geneKeys()) {
  const out = emptyGenome();
  for (const g of genes) {
    switch (g.kind) {
      // Uniform in LOG space, so a ratio gene is as likely to start below 1 as above it — a
      // uniform draw on [0.15, 3] would put 80% of the population above parity.
      case "ratio":  out[g.layer][g.key] = +Math.exp(Math.log(g.min) + rng() * (Math.log(g.max) - Math.log(g.min))).toFixed(3); break;
      case "count":  out[g.layer][g.key] = g.min + Math.floor(rng() * (g.max - g.min + 1)); break;
      case "unit01": out[g.layer][g.key] = +(g.min + rng() * (g.max - g.min)).toFixed(3); break;
      case "flag":   out[g.layer][g.key] = rng() < 0.5; break;
      case "choice": out[g.layer][g.key] = pick(rng, g.of); break;
      case "mix":    out[g.layer][g.key] = randomMix(rng); break;
      default:       throw new Error(`unknown gene kind "${g.kind}"`);
    }
  }
  out.sigma = SIGMA_DEFAULT;
  return out;
}

function randomMix(rng) {
  const len = 3 + Math.floor(rng() * 4);
  return Array.from({ length: len }, () => pick(rng, MIX_ALPHABET));
}

/* ============================================================
   MUTATION
   ============================================================ */

/**
 * A mutated COPY of `genome`. Each eligible gene is varied with probability `rate` (flags with
 * `flagRate`, which is deliberately far lower — see the KINDS note in this file's header), by the
 * operator its kind calls for, at the genome's own self-adapted step size.
 * @param {Genome} genome @param {() => number} rng
 * @param {{ rate?: number, flagRate?: number, genes?: Gene[] }} [opts]
 * @returns {Genome}
 */
export function mutate(genome, rng, { rate = 0.3, flagRate = 0.04, genes = geneKeys() } = {}) {
  const out = cloneGenome(genome);
  // The step size mutates FIRST and the new value is what this generation's genes are drawn at,
  // so a lineage that inherited a lucky step size is the one whose offspring survive to pass it
  // on — which is the entire mechanism by which self-adaptation works.
  out.sigma = clamp(genome.sigma * Math.exp(SIGMA_LEARNING_RATE * gauss(rng)), SIGMA_MIN, SIGMA_MAX);
  const sigma = out.sigma;
  for (const g of genes) {
    const p = g.kind === "flag" ? flagRate : rate;
    if (rng() >= p) continue;
    const cur = out[g.layer][g.key];
    switch (g.kind) {
      case "ratio":
        out[g.layer][g.key] = +clamp(cur * Math.exp(sigma * gauss(rng)), g.min, g.max).toFixed(3);
        break;
      case "count": {
        // Additive, scaled to the gene's own range — multiplicative would make 0 absorbing, and 0
        // is a real allele for every count here (a Rusher's turretCount and garrison are both 0).
        const step = gauss(rng) * sigma * Math.max(1, (g.max - g.min) * 0.5);
        out[g.layer][g.key] = clamp(Math.round(cur + step), g.min, g.max);
        break;
      }
      case "unit01":
        out[g.layer][g.key] = +clamp(cur + gauss(rng) * sigma * (g.max - g.min), g.min, g.max).toFixed(3);
        break;
      case "flag":
        out[g.layer][g.key] = !cur;
        break;
      case "choice": {
        // Resample from the OTHER alleles, so a mutation that fires always actually moves — a
        // uniform resample over all of them would silently no-op 1/|of| of the time and make the
        // effective mutation rate on categoricals lower than the number the caller passed.
        const others = g.of.filter(v => v !== cur);
        out[g.layer][g.key] = others.length ? pick(rng, others) : cur;
        break;
      }
      case "mix":
        out[g.layer][g.key] = mutateMix(cur, rng);
        break;
      default:
        throw new Error(`unknown gene kind "${g.kind}"`);
    }
  }
  return out;
}

// One sequence operator, chosen uniformly. `duplicate` and `delete` are what let the cycle change
// LENGTH — the thing a fixed-width vector genome cannot express and the reason a mix can evolve
// from a Rusher's 4-slot spam into a Technologist's 6-slot elite ladder rather than only ever
// re-weighting a fixed number of slots.
export function mutateMix(mix, rng) {
  const out = [...mix];
  const i = Math.floor(rng() * out.length);
  switch (Math.floor(rng() * 5)) {
    case 0: out[i] = pick(rng, MIX_ALPHABET); break;                       // substitute
    case 1: if (out.length < MIX_MAX_LEN) out.splice(i, 0, out[i]); break;  // duplicate in place
    case 2: if (out.length > MIX_MIN_LEN) out.splice(i, 1); break;          // delete
    case 3: if (out.length < MIX_MAX_LEN) out.splice(i, 0, pick(rng, MIX_ALPHABET)); break;   // insert
    // Rotate. NEUTRAL in the steady state of a repeating cycle — and decisive in the opening,
    // which is where an RTS match is usually decided. The one operator here whose effect the
    // scoreboard sees only in the first few minutes.
    default: out.push(...out.splice(0, 1 + Math.floor(rng() * (out.length - 1)))); break;
  }
  return out;
}

/* ============================================================
   CROSSOVER
   ============================================================ */

/**
 * Recombine two parents. `a` should be the FITTER of the two — `clone` returns it, and the blend
 * mode leans on nothing else about the order.
 *
 * MODULE-WISE is the default mode, not uniform-per-gene, and that is the substantive choice in
 * this file. The genes cluster into linkage groups that map one-to-one onto the engine files
 * consuming them (offense→aiMilitary, economy→aiEconomy, …). Genes WITHIN a group interact
 * strongly — a smaller muster only works alongside a thinner garrison — and genes ACROSS groups
 * interact weakly. Cutting at those boundaries therefore inherits a working sub-solution intact,
 * where uniform crossover would shred an offense package that only functions as a set.
 *
 * The repo has the worked example. engine/aiStrategy.js records that Aggressive finished LAST of
 * four in self-play (25W-47L), that a coordinate scan over its own offense dials could not fix
 * it, and that what did fix it — 25W-47L to 38W-34L — was borrowing Economic's workerTargetMult.
 * That is a hand-executed module-wise cross of the economy group onto an offense-heavy parent. It
 * took a human two searches to find; it is one draw from this operator.
 *
 * @param {Genome} a  the fitter parent @param {Genome} b @param {() => number} rng
 * @param {{ moduleWise?: number, blend?: number, genes?: Gene[] }} [opts]
 *   moduleWise/blend are probabilities; the remainder is a clone of `a`.
 * @returns {Genome}
 */
export function cross(a, b, rng, { moduleWise = 0.6, blend = 0.25, genes = geneKeys() } = {}) {
  const roll = rng();
  const out = cloneGenome(a);
  // Geometric mean: sigma is a ratio like any other, and an arithmetic mean of 0.05 and 0.8
  // would hand every child of a cautious and an exploratory parent a near-exploratory step.
  out.sigma = clamp(Math.sqrt(a.sigma * b.sigma), SIGMA_MIN, SIGMA_MAX);
  if (roll >= moduleWise + blend) return out;                    // clone the fitter parent

  if (roll < moduleWise) {
    // Draw one parent per linkage group. Drawn per MODULE, not per gene — that is the point.
    const byModule = new Map(MODULES.map(m => [m, rng() < 0.5 ? a : b]));
    for (const g of genes) {
      const src = byModule.get(g.module);
      const v = src[g.layer][g.key];
      if (v !== undefined) out[g.layer][g.key] = g.kind === "mix" ? [...v] : v;
    }
    return out;
  }

  // BLEND — a child BETWEEN two similar parents, which is what finds the last few percent once a
  // population has converged on a region. Only the ordered kinds can be averaged; the unordered
  // ones (flag/choice/mix) have no midpoint, so they take a parent's allele by coin flip.
  for (const g of genes) {
    const va = a[g.layer][g.key], vb = b[g.layer][g.key];
    if (va === undefined || vb === undefined) continue;
    switch (g.kind) {
      case "ratio":  out[g.layer][g.key] = +clamp(Math.sqrt(va * vb), g.min, g.max).toFixed(3); break;
      case "count":  out[g.layer][g.key] = clamp(Math.round((va + vb) / 2), g.min, g.max); break;
      case "unit01": out[g.layer][g.key] = +clamp((va + vb) / 2, g.min, g.max).toFixed(3); break;
      case "mix":    out[g.layer][g.key] = crossMix(va, vb, rng); break;
      default:       out[g.layer][g.key] = rng() < 0.5 ? va : vb; break;
    }
  }
  return out;
}

/**
 * Order crossover for the production cycle: take a contiguous RUN from `a` — a build order is a
 * sequence of adjacencies, and a run is the unit of it that means something — then fill out to
 * `b`'s length from `b`, skipping nothing, so both parents' composition contributes. Length lands
 * between the two parents' lengths, which is how the cycle keeps exploring size as well as
 * content.
 * @param {string[]} a @param {string[]} b @param {() => number} rng @returns {string[]}
 */
export function crossMix(a, b, rng) {
  const cut = 1 + Math.floor(rng() * Math.max(1, a.length - 1));
  const start = Math.floor(rng() * a.length);
  const run = Array.from({ length: Math.min(cut, a.length) }, (_, i) => a[(start + i) % a.length]);
  const target = clamp(Math.round((a.length + b.length) / 2), MIX_MIN_LEN, MIX_MAX_LEN);
  const out = [...run];
  for (let i = 0; out.length < target; i++) out.push(b[i % b.length]);
  return out.slice(0, Math.max(MIX_MIN_LEN, target));
}

/* ============================================================
   LOWERING — back into the shape tools/ailab.js already consumes
   ============================================================ */

/**
 * A genome as an `--overrides` document. Two rules worth stating:
 *   • A gene with `gatedBy` is emitted ONLY when its gate is true, because its use site tests
 *     presence (`standingArmyCap != null`) rather than value — emitting a default would turn the
 *     cap on for every genome in the population.
 *   • The archetype row is written under a name of its OWN (`${name}-arch`), never over a shipped
 *     archetype key. Two candidates in one duel share a single live table and applyOverrides
 *     MERGES, so patching a shared key would leave both seats playing a row belonging to neither
 *     — the exact collision tools/ailab.js's assertNoOverrideCollision refuses.
 * @param {Genome} genome @param {string} name @param {{ genes?: Gene[] }} [opts]
 * @returns {{ strategies?: Object, archetypes?: Object }}
 */
export function toOverrides(genome, name, { genes = geneKeys() } = {}) {
  const strategyRow = {}, archetypeRow = {};
  for (const g of genes) {
    if (g.gatedBy && !genome[g.layer][g.gatedBy]) continue;
    if (g.kind === "flag" && g.key === "capsArmy") continue;   // the switch itself is not a dial the engine reads
    const v = genome[g.layer][g.key];
    if (v === undefined) continue;
    (g.layer === "strategy" ? strategyRow : archetypeRow)[g.key] = g.kind === "mix" ? [...v] : v;
  }
  const out = { strategies: { [name]: strategyRow } };
  if (Object.keys(archetypeRow).length) out.archetypes = { [`${name}-arch`]: archetypeRow };
  return out;
}

/**
 * A genome as a CANDIDATE — the `{ name, strategy, overrides }` shape runLeaderboard, runDuel,
 * runRoundRobin and runSwissTournament all already take, plus the `archetype` field
 * tools/duelCore.js's runDuelMatch accepts per side. Drops straight into every one of them.
 * @param {Genome} genome @param {string} name @param {{ genes?: Gene[] }} [opts]
 */
export function toCandidate(genome, name, { genes = geneKeys() } = {}) {
  const overrides = toOverrides(genome, name, { genes });
  const cand = { name, strategy: name, overrides };
  if (overrides.archetypes) cand.archetype = `${name}-arch`;
  return cand;
}

/** One-line human summary of the genes that differ from `other` — what a generation log wants.
 * @param {Genome} genome @param {Genome} other @param {{ genes?: Gene[] }} [opts] @returns {string} */
export function diffGenes(genome, other, { genes = geneKeys() } = {}) {
  const parts = [];
  for (const g of genes) {
    const a = genome[g.layer][g.key], b = other[g.layer][g.key];
    const same = g.kind === "mix" ? JSON.stringify(a) === JSON.stringify(b) : a === b;
    if (!same) parts.push(`${g.key}=${g.kind === "mix" ? `[${a}]` : a}`);
  }
  return parts.join(" ");
}
