# Evolving the AI — a genome, mutation, and crossover

*2026-08-06 — a brainstorm, not a commitment. No code changes accompany this document.*

The question: **how could the AI be parameterised so that it can evolve — by random mutation, or
by crossing over two AIs — and get better at the game?**

The short answer is that most of the machinery already exists and nobody has called it evolution.
`tools/ailab.js`'s `applyOverrides` is a genome loader. `tools/candidates/*.json` are genomes.
`runDuel`/`runSwissTournament` plus `elo.js` are a fitness function that pits individuals against
each other. `runSearch` is a search loop — just the weakest one in the family (a one-dial-at-a-time
coordinate scan). What is genuinely missing is three things: a **schema** that says what a legal
gene is, a set of **variation operators** (mutate, cross), and a **selection loop** that runs
generations instead of a single scan.

This document works through each, and then through the traps this particular codebase will spring.

---

## 1. The premise: a candidate AI is already data

`tools/ailab.js:508`:

```js
export function applyOverrides(ov = {}) {
  for (const [name, row] of Object.entries(ov.strategies || {})) …
  for (const [name, row] of Object.entries(ov.archetypes || {})) …
  for (const [key, row] of Object.entries(ov.difficulties || {})) …
}
```

Three plain exported tables — `STRATEGIES`, `ARCHETYPES`, `DIFFICULTY_OPTIONS` — every field of
which is read at its use site through `|| 1` or a falsy-flag default. That property is what makes
this whole idea cheap: **an arbitrary mutation is always a runnable AI.** There is no parser to
write, no patch to apply, no engine change, and no way for a malformed gene to crash a match — a
nonsense value produces a bad player, not an exception. Evolutionary algorithms need exactly that
(a *tolerant* genotype→phenotype map); most codebases have to be retrofitted for it and this one
already is, by accident of the `|| 1` convention.

`snapshotTables`/`restoreTables` (`tools/ailab.js:525`) already give clean isolation between
individuals, which is the other half of what a population loop needs.

---

## 2. The genome — three chromosomes, only two of which should evolve

| Layer | File | Evolve? | Why |
|---|---|---|---|
| **Strategy** | `engine/aiStrategy.js` | **Yes — the main chromosome** | Composes over any archetype; `galaxy.js:61` `neighbourAiProfile` draws strategies *uniformly at random*, so a new strategy row immediately populates ~1/N of the galaxy |
| **Archetype** | `engine/aiArchetypes.js` | **Yes, carefully** | Carries the world's identity (faction, unit mix, doctrine). Evolving it risks flattening the roster into one optimum — see §6E |
| **Difficulty** | `engine/aiDifficulty.js` | **No — freeze it** | It is the *fairness pin*. `pinnedDuelDials` (`tools/duelCore.js:34`) reads one difficulty row into one object both sides spread from. Let a genome touch it and fitness measures an APM edge, not strategy |

### 2.1 The gene inventory as it stands today

Everything the AI actually reads, with its type — this is the search space, and it is already
about 30-dimensional without adding a single new dial.

**Strategy chromosome** (`engine/aiStrategy.js`):

| Gene | Type | Read at |
|---|---|---|
| `attackTimeoutMult` | continuous ratio | `aiMilitary.js` `aiOffense` |
| `armyAttackSizeMult` | continuous ratio | `aiMilitary.js` |
| `garrisonMult` | continuous ratio | `aiMilitary.js` |
| `workerTargetMult` | continuous ratio | `aiEconomy.js:170` |
| `turretCountMult` | continuous ratio | `aiEconomy.js` |
| `standingArmyCap` | integer count | `aiEconomy.js` |
| `warFootingMult` | continuous ratio | `aiEconomy.js` |
| `warFootingTime` | seconds | `ai.js:146`, `aiEconomy.js` |
| `matchBuffer` | continuous ratio | `aiEconomy.js` |
| `matchFloor` | integer count | `aiEconomy.js` |
| `graceMult` / `grievanceMult` / `forgiveness` | continuous ratio | `engine/diplomacy.js` |
| `matchEnemyForce` | **flag** | `aiEconomy.js` |
| `neverInitiates` | **flag** | `aiMilitary.js` (×3) |
| `useBombOffensively` | **flag** | `aiSuperweapon.js` |
| `wantsIndustryAlways` | **flag** | `aiIndustry.js` (×2) |

**Archetype chromosome** (`engine/aiArchetypes.js`), plus its `odyssey:` overlay which shadows the
same names when `state.diplomacy` exists (`ai.js:133`, the `arch` reader):

| Gene | Type |
|---|---|
| `workerTarget`, `armyAttackSize`, `turretCount`, `maxBarracks`, `garrison`, `odyssey.probeMin` | integer counts |
| `attackTimeout` | seconds |
| `expandWhenNodesBelow` | continuous, bounded 0–1 |
| `wantsRefinery` | flag |
| `doctrine` | **categorical** (`assault` \| `bulwark`) |
| `faction` | **categorical** (`syndicate` \| `miners` \| `frontier` \| …) |
| `unitMix` | **sequence** — see §3.5, the interesting one |

### 2.2 Genes worth *adding* because evolution can find their values

Evolution is only as good as its search space. Three cheap additions widen it a lot, and each is a
`|| 1`-style read at one site, so each is a no-op when absent:

- **`expandAggressionMult`** — today expansion is one threshold (`expandWhenNodesBelow`). A
  multiplier on *how many* expansions it will chase gives the GA a macro/greed axis it currently
  cannot express.
- **`techRushBias`** — the AI's tech-gate order in `aiEconomy.js` `aiBaseAndTech` is hardcoded.
  A single scalar reordering Barracks-first vs Foundry-first opens the whole build-order axis,
  which is where real RTS strategy lives and where the genome is currently blind.
- **`waveCommitFraction`** — commit with a *fraction* of the army rather than all-but-garrison.
  Turns a binary (attack / don't) into a continuous dial, and continuous dials are what mutation
  operators are good at.

Without at least one build-order gene, evolution can only tune the AI's *tempo*, never its *plan*.

---

## 3. Gene types decide the operators

The single most common way a GA fails on a mixed genome is one operator applied to every gene.
These five kinds each want different treatment.

### 3.1 Continuous ratios — mutate multiplicatively, not additively

`attackTimeoutMult`, `graceMult`, `workerTargetMult` … are *ratios*. An additive step of ±0.1 is a
50% change at 0.2 and a 7% change at 1.5 — so additive Gaussian mutation searches the low end far
too coarsely and the high end far too finely. Mutate in log space:

```js
gene *= Math.exp(sigma * gaussian());        // log-normal step; symmetric in ratio terms
```

with `sigma ≈ 0.15` for a fine local search and `≈ 0.4` for exploration. **Self-adapt sigma**
(carry it as a gene of its own, mutate it too): this is the single highest-value trick in
evolution strategies, and it costs about four lines.

### 3.2 Integer counts — geometric step, clamped at zero

`standingArmyCap`, `matchFloor`, `turretCount`, `maxBarracks`, `garrison`, `probeMin`. Round after
a small geometric/Poisson step and clamp to `[0, …]`. Note **0 is a meaningful allele**, not a
degenerate one — `rusher.turretCount: 0` and `rusher.garrison: 0` are deliberate. Never clamp to 1.

### 3.3 Flags — low bit-flip rate, because they are *epistatic switches*

`neverInitiates` is not one gene among fifteen. Flipping it decides whether
`attackTimeoutMult`/`armyAttackSizeMult` mean *anything at all* — under `neverInitiates: true`
every offense gene is inert (`aiMilitary.js` blocks every voluntary commit). Likewise
`matchEnemyForce` makes `standingArmyCap` dead, and `warFootingMult` is dead without
`warFootingTime`.

This is textbook **epistasis**, and it has two consequences:

1. Flip flags **rarely** (~2-5%). A flag flip is a jump to a different fitness landscape entirely;
   at a 20% rate the population never settles anywhere long enough to tune the dials.
2. The inert genes become **junk DNA** — and that is a feature, not a bug. A lineage that has been
   `neverInitiates` for ten generations still carries drifting offense genes; when a descendant
   flips the flag back it lands somewhere new rather than at the ancestral value. This is how
   evolution actually escapes local optima, and it comes free here because the `|| 1` convention
   means an inert gene is *carried*, not *erased*.

### 3.4 Categoricals — resample uniformly; cross by allele choice

`doctrine`, `faction`. There is no metric on these — no sense in which `miners` is "between"
`syndicate` and `frontier`. Mutation = pick a different one uniformly; crossover = take one
parent's allele wholesale. Note `faction` interacts strongly with `unitMix` (both feed combat
strength through `factions.js`), so these two should be treated as one **linkage group** — see §4.

### 3.5 `unitMix` — the sequence gene, and the most interesting one in the game

```js
unitMix: ["skiff", "lancer", "lancer", "dreadnought", "colossus", "wraith"],   // technologist
```

This is not a vector. It is a **cyclic sequence over an alphabet of unit types**, of variable
length, where order matters (it is the production cycle — `ai.js`'s comment: "a repeating
production cycle … not a random weighting, so a profile's composition is exact and testable") and
multiplicity matters (three `skiff`s in four slots is the Rusher's whole identity).

Its operators are the ones from sequence/permutation GAs:

| Operator | Effect |
|---|---|
| **Point substitution** | one slot → a different unit type. Changes composition ratio |
| **Duplication** | copy a slot in place. The classic way biology adds material — lengthens the cycle and doubles one unit's share |
| **Deletion** | drop a slot. Must guard length ≥ 1 |
| **Insertion** | a new random type at a random index |
| **Cyclic rotation** | *neutral in steady state, not in the opening* — rotating decides which unit gets built first, which is exactly the difference between a rush that works and one that dies |
| **Order crossover (OX)** | take a contiguous run from parent A, fill the rest from B in B's order — preserves composition and adjacency from both |

And the reason this is safe to mutate wildly: **`effectiveMix` already filters out units the world
cannot pay for** (`aiWorkers.js`; the Balanced archetype's Wraith/Aegis entries are dropped on
worlds without gas or ice). An illegal gene is silently ignored rather than fatal. That single
existing behaviour makes `unitMix` the most evolvable structure in the codebase — a random
`["colossus","colossus","colossus"]` on pyralis degrades to a no-op instead of a crash.

---

## 4. Crossover — cross at module boundaries, not per-gene

Uniform crossover (each gene independently from A or B) is the default and is probably wrong here.
The dials cluster into **functional modules that map one-to-one onto engine files**:

| Module | Genes | Consumer |
|---|---|---|
| OFFENSE | `attackTimeoutMult`, `armyAttackSizeMult`, `garrisonMult`, `neverInitiates`, `useBombOffensively` | `aiMilitary.js`, `aiSuperweapon.js` |
| ECONOMY | `workerTargetMult`, `standingArmyCap`, `warFooting*`, `wantsIndustryAlways` | `aiEconomy.js`, `aiIndustry.js` |
| DIPLOMACY | `graceMult`, `grievanceMult`, `forgiveness` | `diplomacy.js` |
| DEFENSE | `turretCountMult`, `matchEnemyForce`, `matchBuffer`, `matchFloor` | `aiEconomy.js` |
| COMPOSITION | `unitMix`, `faction`, `doctrine` | `aiWorkers.js`, `factions.js` |

Genes *within* a module interact strongly (a smaller muster only works with a thinner garrison);
genes *across* modules interact weakly. That is precisely the condition under which crossover beats
mutation alone: **cross at module boundaries and a working sub-solution survives intact.** Uniform
crossover would shred an offense package that only works as a set.

There is a documented, in-repo example of why this matters. `aiStrategy.js:53-64` records that the
Aggressive strategy was *last* of four in self-play (25W-47L), that a coordinate scan over its own
offense dials could not fix it, and that what fixed it was an **economy** gene (`workerTargetMult:
1.25`) borrowed from the Economic strategy — 25W-47L → 38W-34L. That is a hand-executed
module-wise crossover between two strategies. It worked. It took a human a search-and-a-half to
find. A GA doing module-wise crossover over a population containing both parents finds it in one
generation, by construction.

**Recommended recombination:** 60% module-wise crossover, 25% arithmetic blend (geometric mean in
log space for the continuous genes — good for fine-tuning between two similar parents), 15% clone.
Then mutate the offspring.

---

## 5. Fitness — three exist, and they reward different things

| Fitness | Where | Cost | What it actually rewards |
|---|---|---|---|
| `score()` | `tools/ailab.js:475` | ~seconds/world | Being a good *neighbour* in a play-forever sandbox: develops, keeps growing, spends, applies pressure proportional to hostility |
| `runLeaderboard` | `:559` | N × the above | The same thing, N times, ranked. **A proxy, not head-to-head** — its own header says so |
| `runDuel` / `runSwissTournament` + `elo.js` | `:667`, `:935` | ~a match each | *Winning.* Real self-play, resolved by `engine/victory.js` |

**Use Elo from Swiss-paired self-play as the fitness, and `score()` as a diagnostic only.**
Reasons:

- **Goodhart.** `score()`'s six components are a hand-written definition of good, and a GA is a
  machine for exploiting hand-written definitions. `thrift: clamp01(1 - bankedFinal / 8000)`
  rewards ending poor — a genome that dumps ore into worthless turrets scores well and plays
  badly. `pressure` counts waves — a genome that trickles one unit at a time farms it. Every one
  of these is a real attack surface. A win/loss cannot be farmed except by winning.
- **Cost.** `runSwissTournament` pairs by closest standing over `swissRoundCount(n)` rounds
  (`pairing.js:223`) instead of the full C(n,2) round-robin — O(n log n) matches per generation
  for a population of n. A 24-individual generation is ~5 rounds × 12 matches = 60 matches, not
  276. This is the difference between a generation costing minutes and costing an hour.
- **Relative fitness is what a GA wants anyway.** Selection only needs a ranking.

**But coevolution has its own failure mode, and it must be planned for.** A population evolving
only against itself can cycle forever (rusher beats greedy-economy beats turtle beats rusher) with
no absolute progress — the Red Queen. Two standard countermeasures, both cheap here:

1. **Hall of fame.** Seed every generation's tournament with the four shipped baselines —
   `tools/candidates/baseline-{adaptive,aggressive,economic,force-parity}.json` already exist and
   are exactly this. Elo against a fixed anchor is absolute, not relative.
2. **Archive the best-of-generation** and pair against a random sample of past champions, not just
   current peers. This is what stops the population from specialising into a rock-paper-scissors
   loop that beats itself and loses to the shipped AI.

**And a hard filter on top of fitness:** any genome that trips a `CHECKS` entry
(`tools/ailab.js:977` — `supply-deadlock`, `hoarding`, `dev-flatline`, `hostile-but-idle`,
`production-stall`) is disqualified regardless of Elo. A genome that wins duels while deadlocking
its own supply is a bug the GA found, not a strategy.

---

## 6. Five loops, cheapest first

### A. (1+λ) hill climb with Gaussian mutation — *~150 lines, the obvious first step*

Take the current best, make λ mutated copies, keep the winner. This is a strict upgrade on
`runSearch`'s coordinate scan for one structural reason: **the scan moves one dial at a time and
keeps improvements greedily, so it cannot cross a valley where two dials must move together.**
Aggressive's documented fix — offense dials only pay off once the economy funds them — is exactly
such a valley, and the scan is on record as having failed to find it. Multi-dial Gaussian mutation
crosses valleys by default. No crossover, no population, no new concepts.

### B. (μ,λ)-ES with self-adaptive step size — *the noise-robust choice*

Keep the μ best of λ offspring, each carrying its own mutation sigma. Handles the 10-15 continuous
genes very well and is more robust to a noisy objective than any hill climb, because it averages
over a population rather than trusting one comparison. Still no crossover.

### C. Genetic algorithm with module-wise crossover — *the direct answer to the question*

Population of 20-30, Swiss tournament each generation, tournament selection (pick 3 at random,
best of them breeds — cheap and doesn't need normalised fitness), module-wise crossover per §4,
mutation per §3, 2 elites carried unchanged. This is the design that can find the
Aggressive-borrows-Economic's-economy result by itself.

### D. Island model — *the fix for "improved on the mean, regressed on three worlds"*

One sub-population per world group (or per archetype), evolving independently, with occasional
migration of champions between islands. The ai-lab skill's own warning is that "a mean that
improved because one world improved a lot and three got worse is a regression wearing a disguise";
islands attack that directly by never letting one world's optimum swamp the roster. It also
parallelises perfectly, which matters when each fitness evaluation is a real simulated match.

### E. MAP-Elites — *the one that fits this game best, and the recommendation*

Odyssey has no win condition. The game does not want *the* optimal AI; it wants a **cast of
distinct, interesting opponents** — which is what `ARCHETYPES` is trying to be by hand, with four
entries written by a human.

MAP-Elites keeps an archive binned by *behavioural* descriptors and stores the best genome in each
bin. Every descriptor it needs is already measured, in `sample()`/`summarise()`
(`tools/ailab.js:318`):

- mean army size (`army` / `armyValue`) — turtle ←→ swarm
- time to first wave (`waves` first non-zero) — rush ←→ late
- development at 40 min (`devFinal`) — brawler ←→ teched
- banked ore (`bankedFinal`) — spendthrift ←→ hoarder
- expansions (`buildings`) — tall ←→ wide

Output: a grid of the strongest AI *of each play style*, every cell a genome, every genome a
runnable roster entry. That is directly shippable content — new archetypes with authentic
identities, discovered rather than hand-tuned — and it dodges the "evolution converges on one
degenerate cheese strategy" failure that would make the game worse even while the fitness number
goes up. It also composes with C: use the GA as the variation operator, MAP-Elites as the archive.

---

## 7. Where it runs — three deployment options, increasingly ambitious

**7.1 Offline, in `tools/evolve.js`.** Genomes are JSON, results go in the search ledger
(`docs/odyssey-ai-review.md`), winners are promoted into `engine/` by hand under the existing
discipline (`npm test` + `ailab check` + a full-roster multi-seed sweep). Safest, matches the
established workflow exactly, and needs zero engine changes.

**7.2 In-game: the roster breeds.** The Competition mode already has everything — a persistent
roster (`competitionLedger.js` `addRosterEntry`), Elo brackets, Swiss/round-robin/knockout
scheduling (`pairing.js`), a background worker (`competitionWorker.js`), seasons
(`archiveSeason`). Add one thing: when a season is archived, **the top two entrants produce
offspring** that join the next season's roster. Genomes are already JSON, so they serialise into
the ledger with no new format. The player-facing pitch writes itself: *a ladder that gets harder
because the AIs are breeding.* Note `competitionWorker.js:109` already plumbs a per-entrant
`archetype`, so an entrant is already more than just a strategy name.

**7.3 In-galaxy: the living galaxy evolves.** Each Odyssey neighbour world carries a genome. When
you conquer a world and it is re-settled, the new neighbour inherits a crossover of the two
strongest *surviving* neighbours — so wiping out the aggressive worlds leaves you a galaxy of
economists, and the survivors' traits propagate. This is the most interesting design and the most
dangerous: it must be seeded from `galaxy.seed` (never wall-clock, never `Math.random`), it changes
the Odyssey meta permanently, and a difficulty ratchet with no ceiling is a balance problem, not a
feature. Worth prototyping only after 7.1 has produced genomes anyone actually wants to face.

---

## 8. Traps this codebase will spring

These are specific, and each one has cost someone time already or clearly will.

**8.1 `duelSeed` hashes the candidates' names — so renaming a genome changes its maps.**
`tools/duelCore.js:60`:

```js
return hashStr(`${base}:duel:${world}:${difficulty}:${[aName, bName].sort().join("|")}:${rep}`);
```

Within one duel this is fine and deliberate (the sort is there so a side-swap draws the identical
map). Across *generations* it is a real confound: `gen3-ind7` vs `gen2-ind4` is fought on entirely
different maps than `gen2-ind4` vs `gen1-ind2` was, so "the child scored better than its parent
did" is partly a statement about map luck. **Fixed** (§9): `duelSeed` takes an optional `seedKey`
that replaces the names segment and defaults to today's exact derivation; `runDuel` forwards it,
and the evolution loop passes one fixed key for the whole run. The cost of pinning is that a run
can overfit the pinned map set — which is what held-out worlds are for (§8.6).

**8.2 `assertNoOverrideCollision` will refuse a population of mutants.**
`tools/ailab.js:720` throws if two candidates override the same table key — correctly, since they
share one live table in a duel and the patches would merge. A GA whose individuals are all mutants
of `"aggressive"` hits this on the very first pairing. **Give every individual a unique key**
(`gen3-ind7`), and treat the existing check as the naming discipline it is.

**8.3 Difficulty must be pinned, and every genome evaluated across brackets.**
Layers compose *multiplicatively* (archetype × strategy × difficulty), so a mild-looking gene is a
3× swing on Hard + Aggressive + Rusher. `aiStrategy.js:60-64` records the exact failure:
`workerTargetMult` at 1.4 wins Medium harder but *loses* Hard, because Hard's own row already
carries 1.25 and 1.4 there is really 1.75×. **A genome scored on one difficulty is not scored.**
Fitness must be the worst — or at minimum the mean — across brackets, never a single one.

**8.4 `runDuel` didn't plumb per-side archetypes; `runDuelMatch` always has.**
`tools/duelCore.js:84` accepts `aArchetype`/`bArchetype` and `competitionWorker.js:109` passes
them, but `tools/ailab.js`'s `runDuel` never set them — so in a CLI duel **both sides played the
world's own archetype**, and a candidate file carrying its own was silently ignored. **Fixed**
(§9), which is what makes the macro/tempo/composition chromosome measurable at all. Note this was
a pre-existing bug in the shipped bench, not something evolution introduced: any `duel` run
comparing two archetypes before this was measuring something else.

**8.5 Engine purity is non-negotiable.** No `Math.random`, no `Date.now()` under `engine/`, ever
(`test/engine-purity.test.js`). All mutation RNG uses `mulberry32` from `engine/rng.js` with an
explicit seed, and lives in `tools/`. If evolution ever moves in-game (§7.3) it must draw from a
seeded stream derived from `galaxy.seed`, exactly as `neighbourAiProfile` already does.

**8.6 Overfitting the roster.** `runSearch` "optimises a noisy mean and will happily overfit three
worlds". A GA is far better at overfitting than a coordinate scan is. **Hold worlds out**: evolve
on six, validate the champion on the other five, and report both numbers. A champion that wins on
its training worlds and not on the held-out ones is a champion of the seed set.

**8.7 Noise, and how much compute to spend proving a winner.** Duels are high-variance; 4-1 over
five matches is not significance. Rather than raising the seed count for everyone, use **successive
halving**: evaluate the whole generation cheaply (few seeds), keep the top half, re-evaluate with
more seeds, repeat. Compute concentrates on the individuals that might actually win.

**8.8 Strong is not the same as fun.** The fitness function is a definition of "better AI" and
evolution will satisfy it literally. A GA optimising win rate will find cheese — the same all-in
opening every game — and it will be *correct* to do so, and the game will be worse. `WEIGHTS`
(`:466`) exists to be edited before optimising, not after; and §6E's MAP-Elites is the structural
answer, because it selects for a *diverse cast* rather than a single maximum.

**8.9 The blast radius of promoting a winner.** `neighbourAiProfile` (`galaxy.js:61`) draws
strategies uniformly, so adding one evolved strategy row changes roughly 1/N of every Odyssey
galaxy. Editing an *existing* row changes every save that uses it. Keeping evolved values in the
`odyssey:` overlay only (read behind the `state.diplomacy` guard, `ai.js:133`) leaves the skirmish
game byte-identical and the determinism tests green — the same containment `aiArchetypes.js`
already uses for its labour retuning.

---

## 9. Phase 1 — shipped

Everything in this section is implemented. Nothing under `engine/` changed: the shipped game, the
skirmish path, and every determinism guarantee are untouched, which is the whole point of the
genotype living in `tools/`.

### `tools/genome.js` — the schema and the operators

`GENOME_SCHEMA` is the one source of truth for what a legal gene is — `{ key, layer, kind, module,
min, max, odysseyOnly, gatedBy }` — the same role `DIFFICULTY_OPTIONS` plays for difficulty keys.
28 genes across two chromosomes and six linkage groups. Alongside it: `mutate`, `cross`,
`randomGenome`, `genomeFrom` (seed from a shipped row), and `toOverrides`/`toCandidate`, which
lower a genome back into exactly the `--overrides` / `{ name, strategy, overrides }` shapes the
rest of the bench already consumes. Pure and seeded — every operator takes an explicit `mulberry32`
stream, so a whole run reproduces from one integer.

Two schema fields are load-bearing and were not in the original sketch:

- **`odysseyOnly`** marks a gene whose use site is behind a `state.endless` / `state.diplomacy`
  guard. Every duel is a **skirmish** (`tools/selfplay.js`: "no Odyssey, no diplomacy, no galaxy"),
  so the entire DIPLOMACY module plus `wantsIndustryAlways` and `useBombOffensively` are read by
  *nothing* under a duel objective. They are excluded by default; evolving them against duel Elo
  would be optimising pure drift. This was nearly a silent waste of a whole search.
- **`gatedBy`** handles the genes whose use site tests *presence* rather than value.
  `aiEconomy.js` reads `strategy.standingArmyCap != null`, so emitting a default would cap the army
  of every genome in the population. It is modelled as an explicit `capsArmy` switch plus a value
  that keeps drifting while the switch is off — §3.3's junk-DNA argument made concrete.

### The two plumbing fixes from §8

- **`duelSeed` takes an optional `seedKey`** (`tools/duelCore.js`) that replaces the sorted-names
  segment of the hash. Omitted, it is byte-for-byte the derivation it has always been — pinned by a
  test. The evolution loop passes one fixed key for the whole run, so every genome ever evaluated
  in round *R* faced the identical maps.
- **`runDuel` now forwards each candidate's own `archetype`** to `runDuelMatch`, which has always
  accepted it and which `competitionWorker.js` has always passed. Before this, a CLI duel gave both
  seats whatever temperament the *world* hands out and silently ignored the candidate's own — so
  the archetype chromosome could not have been measured at all.

### `node tools/ailab.js evolve`

Population, generations, elites, tournament selection, module-wise crossover, self-adaptive
mutation. Fitness is Swiss-scheduled duel Elo with the four shipped baselines riding along as a
hall of fame, every difficulty bracket rated separately and aggregated by the worst (`--agg min`).
The champion is written as a runnable candidate file, so it goes straight back into
`duel`/`sweep`/`leaderboard`.

One correction the implementation forced, worth recording because the bug was invisible:
`eloForMatches` folds every rating from a **fresh 1200** over one generation's own matches, so a
raw Elo is only comparable *within* a generation — the field changes every generation and the mean
is pinned at 1200 regardless of the field's absolute strength. Comparing generation 6's champion to
generation 1's on raw Elo would have measured nothing, reintroducing the exact Red Queen failure
the hall of fame exists to prevent, in the arithmetic rather than in the design. The loop therefore
reports **`edge`** — rating above the hall of fame's own mean in the same tournament. Anchors are
fixed genomes, so their mean is a fixed point of skill and an edge *is* comparable across
generations; within a generation it is a constant offset, so it changes no ranking.

`--screen` (CHECKS as a disqualifier) is **opt-in**, and that is a calibration argument rather than
a cost one. Every detector in `CHECKS` is written for a 40–60 sim-minute *Odyssey* run and several
carry an explicit "…and it never resolved in the last third" term keyed to that length; run over a
duel-length skirmish they fire on healthy genomes, which is precisely the failure this repo's own
CHECKS header records three rewrites of. So the screen runs at its own length, on its own Odyssey
worlds, and only when asked.

### What the first run actually found

12 genomes × 6 generations, korrath/ferros/vesper, Medium+Hard, 3h21m. Full rows in the search
ledger (`docs/odyssey-ai-review.md`); the three findings worth carrying forward:

**1. It works, and it generalises.** The champion beats all four hand-tuned strategies on four
worlds it never trained on, at a longer clock than it was selected under: 50W-14L (78%) at Medium,
40W-24L (63%) at Hard, over 320 matches. Medium is ~4.5σ over even. So the loop is not producing
noise, and it is not overfitting its training worlds.

**2. And it should not be promoted, because it is Goodhart's law in a can.** Stripped of inert
genes the champion is three dials — `neverInitiates`, `workerTargetMult` at the schema ceiling, and
no army cap — which is to say: *max economy, uncapped army, never attack*. At Hard **every one of
its 40 wins is a `timeout-score` win and none is an elimination**, while 16 of its 24 losses are
eliminations. It does not play better; it exploits the fact that `engine/victory.js` weights combat
units 1.35× and banked ore 0.25×, so an army that never fights and never takes attrition is the
most valuable thing you can own at the clock. §8.8 predicted this in the abstract; it took one
generation to arrive in practice.

This is the single most useful thing the run produced, and it is an argument about the *objective*,
not about the search. Duel-Elo was chosen over `score()` precisely because a win "cannot be farmed
except by winning" — that reasoning was incomplete. A win at the timeout is farmable, because the
timeout is scored by a heuristic, and any heuristic is a hand-written definition of good. Three
plausible responses, none free:
  - **Score only eliminations** (a timeout is a draw). Cleanest, but it selects hard for all-in
    aggression and would probably breed the opposite degenerate.
  - **Fitness = win rate weighted toward elimination wins.** A dial, therefore another thing to
    tune, therefore another thing to Goodhart.
  - **Take the finding as being about the game, not the bench**: a tiebreak that pays 1.35× for an
    army you never commit rewards turtling in *real* matches too, not just evolved ones. That is
    worth a balance conversation independent of any of this.

**3. Read the trajectory, not the numbers.** Elitism accidentally supplied a control: generation
3's champion is cloned unchanged into generation 4 and scored **+199 then +118** — 81 edge points
apart on a byte-identical genome. The apparent per-generation climb is a flat line with ±80
scatter. Only the gap to the anchors (+120 to +200, consistently) survives that, and the held-out
round-robin is what actually confirmed it. **A single-seed generation cannot rank genomes**; the
next run spends its compute on `--seeds` or on §8.7's successive halving, not on more generations.

The honest summary: Phase 1 delivered a working variation-and-selection loop and a genuinely
generalising champion that the game should not ship. Both halves of that are the result.

---

## 10. Open questions

- **What should the objective be, now that duel-Elo is known to be farmable?** The three options in
  §9 are the start of that argument, not the end of it. Until it is settled, no evolved genome
  should be promoted into `engine/` on duel record alone — the held-out round-robin proves
  generalisation, not quality.
- **Should the schema's bounds be widened where evolution pins them?** `workerTargetMult` landed
  exactly on 2.0, its ceiling. A binding bound means the optimum is outside the range, and the
  honest options are to widen it or to state why the range is a design constraint rather than a
  search constraint (on Hard the difficulty row multiplies by a further 1.25, so 2.0 is really
  2.5×).
- **`runEvolution` has no resume.** A 3-hour run that dies is a 3-hour run lost. Per-generation
  checkpointing now writes the champion-so-far, but the *population* is not serialised, so a run
  can be salvaged but not continued. The fix is the same shape as `Workflow`'s resume: write the
  population alongside the champion and take a `--resume-from`.

- **Should the player ever see a genome?** A "Lineage" panel on a Competition roster entry —
  parents, generation, which genes it inherited from which side — is nearly free (it is all JSON
  already) and is the thing that would make §7.2 feel alive rather than like a number going up.
- **Does the game want an AI that keeps getting harder?** §7.3's ratchet has no ceiling. Capping
  it against the player's own Elo (the ledger already tracks a human rating) is one answer; making
  it a per-galaxy toggle is another.
- **Is `unitMix` better evolved or better hand-written?** It is the gene most tied to a world's
  identity and flavour. Evolution may well produce a stronger mix that reads as characterless.
  Worth measuring against a "does this still feel like Korrath" judgement that no fitness function
  contains.
