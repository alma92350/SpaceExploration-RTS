# The Odyssey AI — review, and a bench for tuning it

Two things live in this document:

1. **A review of the AI as it plays in Odyssey**, backed by measurements rather than by
   reading the source. Every claim below has a command that reproduces it.
2. **A proposal for searching and testing better AI strategies** with Claude Code, and the
   tool that makes it runnable — `tools/ailab.js`.

Nothing under `engine/` changed to produce this. The findings are reported, not fixed;
fixing them is the first job the bench is for.

---

## 1. How the Odyssey AI is actually built

The opponent is one scripted controller (`engine/ai.js` `runAI`) whose behaviour comes from
**three plain-data tables composed multiplicatively**, plus a diplomacy ramp that gates
whether it may attack at all:

| Layer | File | What it sets | Chosen by |
|---|---|---|---|
| **Archetype** | `aiArchetypes.js` | temperament: worker target, army size, attack timeout, unit mix, turrets, barracks, expansion, doctrine, faction — plus an `odyssey:` overlay that only applies when `state.diplomacy` exists | the world (`PLANET_ARCHETYPE`) |
| **Strategy** | `aiStrategy.js` | aggression: whether/when it voluntarily attacks, standing-army cap, war-footing response | the player at setup — or, for neighbour worlds, uniformly at random |
| **Difficulty** | `aiDifficulty.js` | APM, micro, worker multiplier, grace/grievance, research pace, market access, rusher graduation | the player at setup — or, for neighbour worlds, uniformly at random |
| **Diplomacy** | `diplomacy.js` | a stance from +1 to −1 driven by scarcity, your kills, the neighbour's own development, late-game creep, tributes, and your Gate. `hostility()` scales muster size, committed fraction and wave cadence | emergent |

`runAI` threads one world snapshot through its decision phases in a load-bearing order
(scout → workers → found/survive → expand → base/tech → produce/fortify → research → barter →
industry → military → superweapon), all sharing an APM action budget and forward-passed ore
reserves. That order matters more than it looks — see §2.4.

**This architecture is genuinely good, and it is what makes the rest of this document
cheap.** Every dial is read defensively (`|| 1` for multipliers, falsy for flags), so an
absent layer is a no-op; the tables are plain exported objects; the sim is pure,
deterministic and headless. Adding a candidate AI is therefore *writing a row into a table*,
not editing the engine — which is exactly what a search loop needs.

Other things the review found worth stating plainly:

- The AI plays under its own fog (`state.fogAI`) and earns its intel with a scout. Its
  counter-picking, expansion targets and threat response are all honestly gated on what it
  has seen.
- Odyssey offence is a hostility-paced *probe ramp*, not a doomstack: muster, committed
  fraction and cadence all scale with `hostility()`, and there's a `playerHasPresence` guard
  so background worlds don't send waves at nobody.
- The Odyssey-only paths (`state.endless` / `state.diplomacy`) are cleanly separated from the
  skirmish path, which is why the skirmish stayed byte-identical through all of it.

---

## 2. What the bench measured

Reproduce any row with the command under it. All runs are seeded and deterministic.

The headline: a full-roster soak — **11 worlds × 4 strategies, Medium, 40 sim-minutes each,
against a player that seats a base and then does nothing** (`node tools/ailab.js check
--minutes 40`, 44 runs, ~3½ minutes of wall clock) — fires every one of the bench's five
named defects:

| detector | fires on | what it means |
|---|---|---|
| `production-stall` | **43 / 44** | a completed Barracks stood idle while the AI held real money |
| `hoarding` | **23 / 44** | banked resources peaked above 4,000 with nothing to spend them on |
| `hostile-but-idle` | **22 / 44** | the HUD reads *Hostile* and no wave ever comes |
| `dev-flatline` | **19 / 44** | the industry/tech climb stopped and never resumed |
| `supply-deadlock` | **5 / 44** | production wedged on a unit that can't fit under the supply cap |

Mean quality score across the roster: **0.33 / 1.00**. The sections below take each finding
apart.

### 2.1 Half the galaxy's neighbours can never attack you

`STRATEGIES` has four rows; two of them (`economic`, `matching`) carry `neverInitiates: true`,
which blocks **every** voluntary commit. `neighbourAiProfile` (`engine/galaxy.js`) picks a
neighbour's strategy uniformly from `Object.keys(STRATEGIES)`, so in expectation **half the
worlds in a galaxy hold a strategy that cannot attack you, ever**, regardless of stance.

Measured across the full roster (11 worlds × 4 strategies, 40 sim-minutes, passive player):

- `economic` and `matching`: **0 waves in all 22 runs**, and the passive player's Command
  Center still standing in all 22 — with **every** sample where `hostility() >= 0.5` showing
  zero waves committed. That's the `hostile-but-idle` detector firing 22/44, i.e. on *exactly*
  the non-initiating half and nothing else.
- `default` and `aggressive`: 1–3 waves on most worlds (8 on helix), player base razed in the
  majority.

So the HUD reads *Hostile*, the stance is pinned at −1, and nothing comes. That is the
single most player-visible AI failure in the mode, and it is a distribution choice
(`neighbourAiProfile`) meeting an absolute flag (`neverInitiates`), not a bug in either.

The secondary effect is just as costly: a `neverInitiates` neighbour also never *spends*.
The four highest banked-resource runs in the roster are all `economic`/`matching`
(helix/matching 36,207 · helix/economic 30,785 · vesper/economic 30,679 · ferros/economic
28,678), because the strategy caps the standing army at 3–8 units and nothing else in the AI
can absorb the income.

```
node tools/ailab.js sweep --strategies economic,matching --minutes 40
```

`neverInitiates` is absolute *on purpose* — see the comment in `aiStrategy.js`; it was made
absolute to stop a passive player eating an unexplained all-in wave on the skirmish
desperation timeout. The fix is therefore not to remove the flag but to give Odyssey its own
provocation path, or to stop `neighbourAiProfile` sampling the non-initiating strategies
uniformly.

### 2.2 A hard production deadlock that freezes a developed AI permanently

The unit-mix cycle retries the same entry until it succeeds (`pickNextUnitType` indexes on
`unitsBuilt`, which only increments on success). The Habitat trigger in `aiBaseAndTech` fires
at `used >= cap - 2` — a margin sized for a 2-supply unit. The Odyssey roster contains
4-supply (Dreadnought, Aegis, Colossus) and 8-supply (Leviathan) units.

When the free supply lands in the gap — at least 2 but less than the next mix entry needs —
neither side moves: production can't queue, and the Habitat that would unblock it is never
triggered. Measured on kybernet at Medium, 50 sim-minutes, no player:

```
unitsBuilt 63 -> next mix entry: dreadnought  supplyCost 4
supply 156 / 158.6   free 2.6
habitat trigger (used >= cap-2)?  false
can queue next?                   false
ore 8031   radioactives 1994
```

The result is permanent: army frozen at 66 units from minute 40 to minute 60, both Barracks
queues empty, banked ore climbing 2,797 → 8,031 → 11,476 → 30,000+ with nothing to spend it
on. The world is finished for the rest of what is an unbounded session.

```
node tools/ailab.js probe --world kybernet --opponent none --minutes 60 --sample 10
```

### 2.3 The build order terminates — and this is a play-forever mode

Even without the deadlock, the AI's plan has an end: the factory chain, the tech order, one
Star Dock, one Plasma Rig, one Helium Bomb. Once it's climbed them, there is nothing left in
the script to buy. `INDUSTRY_CHAIN` and `RESEARCH_ORDER` are finite lists; `maxBarracks` is 1
or 2; there is no "spend surplus on more of what works" rule at all.

That shows up as the same signature as the deadlock — banked resources rising, army flat —
and it is why `thrift` scores 0.00 on every long developed run. A neighbour in a mode with no
end needs a terminal loop, not a terminal list.

It is also the most widespread finding by far: `production-stall` fires on **43 of 44** runs,
across every world and every strategy. The single exception (glacius/aggressive) missed the
detector's 0.25 threshold by scoring 0.11 — it stalled too, just less often.

### 2.4 The Rusher never develops, and its Hard-only rescue lands ~30 minutes late

`rusherGraduates` (Hard) is meant to turn a Rusher into a developer after 20 minutes. On a
korrath background world it does not visibly land until ~50:

| sim time | dev (medium) | dev (hard) |
|---|---|---|
| 10m | 1 | 1 |
| 20m | 1 | 1 |
| 30m | 1 | 1 |
| 40m | 1 | 1 |
| 50m | 1 | 3 |
| 60m | 1 | 18 |

At Medium the Rusher is still on 6 workers, dev 1 and four distinct building types at
**60 minutes**. The mechanism is phase order, not the graduation gate: `aiProduceAndFortify`
runs *before* `aiIndustry` and holds no reserve, so a cheap-unit archetype spends ore down
below a Smelter's 160 every think cycle. The Foundry and Refinery already solve exactly this
with `ctx.foundryReserve` / `ctx.refineryReserve`; the industry chain has no equivalent.

It's all three Rusher worlds, not one: across korrath, nimbus and oort, **9 of 12 runs end at
dev 1** after 40 minutes. The three exceptions are the `economic` strategy, whose
`wantsIndustryAlways` flag bypasses the archetype gate entirely and takes them to dev 20 — so
the capability is there and reachable; it's the archetype path that can't get to it.

```
node tools/ailab.js probe --world korrath --difficulty hard --opponent none --minutes 60 --sample 10
```

### 2.5 A wiped neighbour is gone forever

`aiFoundOrSurvive` can re-seat a razed base — but only from a colony ship in hand, and
`aiExpand`'s Odyssey branch only *produces* one when a standing Command Center exists
(`!colonyShip && cc && workers.length > 0`). Lose the CC without a ship in flight and the AI
is permanently dead: no workers, no production, no recovery.

Against the `turtle` sparring bot (a plain economy behind four turrets that never attacks),
an Aggressive Rusher on korrath threw itself away: base gone by minute 10, last worker gone by
minute 20, and for the remaining five minutes of the run — and every minute after it — no
Command Center, no production, and 1,143 ore banked forever.

For the *player's* conquest that's correct and intended (`galaxy.pacified` treats it as a
milestone). For a world the player has never visited, it means a background world can quietly
die and stay dead.

```
node tools/ailab.js probe --world korrath --strategy aggressive --opponent turtle --minutes 25
```

### 2.6 The multiplicative layers have no clamp

`graceMult` and `grievanceMult` multiply across all three layers with no bound:

```
grace = 420s × archetype × strategy × difficulty
      = 420 × 0.5 (Rusher) × 0.2 (Aggressive) × 0.9 (Hard) = 37.8s
```

The 7-minute opening grace — documented as the window that lets a player establish before a
world can turn — collapses to under 40 seconds on a reachable setup-screen combination
(Aggressive + Hard on a Rusher world). Grievance goes the other way: 0.04 × 2 × 1.6 × 1.15 =
0.147 per kill, so about ten kills drag a neighbour from its opening stance (+0.35) to fully
hostile. Neither is necessarily wrong, but both are *unintended* consequences of composition,
and nothing in the tests notices.

### 2.7 The AI does not play the Odyssey

The neighbour plays a skirmish with extra buildings. It never builds a Spaceport, never
jumps, never settles another world, never trades for credits, never charges a Gate, never
offers or demands tribute. `checkExpansion` gives the *appearance* of faction spread, but it
is a starmap bookkeeping pass — it sets `galaxy.claims` and relabels the target world's AI
faction; no AI actually goes anywhere.

This is a design gap rather than a defect, and it's the largest single lever on how alive the
galaxy feels.

### 2.8 There is no AI-vs-AI, but there nearly is

`state.ai` is a single controller slot bound to owner `"ai"`. Across the AI modules
there are only ~21 owner-literal references, and `engine/state.js` already keeps the
owner-generic scaffold (`state.owners`, per-owner fog, owner-keyed bases). Making the
controller owner-parametric — `state.ais[owner]` — is a contained refactor, and it would
unlock true self-play: the strongest possible evaluation signal, replacing the scripted
sparring bots below.

---

## 3. The proposal — searching for better AI with Claude Code

### 3.1 Why the usual approach doesn't work here

The existing suite is excellent at invariants (determinism, purity, "a skirmish resolves to a
winner on all nine worlds") and useless for quality. AI quality in Odyssey is a *curve over
40+ minutes* — does it keep developing, does it spend what it earns, does pressure arrive in
proportion to hostility — and no assertion expresses that. Every finding in section 2 sat in
a suite of ~90 green test files.

So the missing piece is not more tests. It's a **measurement loop**.

### 3.2 The bench: `tools/ailab.js`

Zero dependencies, Node stdlib only, in `tools/` (never `engine/`, which stays pure). It runs
the real sim headlessly — a 40-sim-minute world costs ~7 seconds — samples a metric set on a
fixed cadence, and prints a scoreboard.

```
node tools/ailab.js probe    # one configuration, full time series
node tools/ailab.js sweep    # a matrix of worlds × strategies × difficulties → scoreboard + JSON
node tools/ailab.js compare  # A/B two saved sweeps, per-configuration deltas
node tools/ailab.js search   # deterministic coordinate scan over a strategy's dials
node tools/ailab.js check    # the named-defect list from section 2, across the roster
```

**A candidate AI is JSON, not a patch.** Because the three tables are plain objects read
through defensive accessors, `--overrides` writes rows into them before a run:

```json
{
  "strategies":   { "swarm":  { "armyAttackSizeMult": 0.5, "garrisonMult": 0.2 } },
  "archetypes":   { "rusher": { "odyssey": { "workerTarget": 9 } } },
  "difficulties": { "hard":   { "workerTargetMult": 1.4 } }
}
```

That is the whole reason this is a day of work and not a project: **the search space is
already a JSON document.**

**Sparring opponents.** An AI with nobody to react to is playing solitaire, so the bench
drives the player side with scripted bots through the engine's public command API:

| bot | what it is | the question it answers |
|---|---|---|
| `none` | no player at all | how does the development curve look on a background world? |
| `passive` | seats a base, never acts | does pressure ever arrive at all? |
| `turtle` | economy behind turrets, never attacks | can the AI crack a defended base? |

**Metrics and score.** Six components, weighted in `WEIGHTS` and printed individually:
`develop` (climbs the chain), `keepGrowing` (still growing in the last third — the
play-forever requirement), `pressure` (commits waves once actually hostile), `thrift`
(spends what it earns), `liveness` (production never wedges), `survive`. The weights are
the definition of "better AI" and are meant to be argued with and edited; the components are
printed because a total nobody can decompose is a number nobody should trust.

**Health checks.** Each finding in section 2 is encoded as a named detector
(`supply-deadlock`, `hoarding`, `dev-flatline`, `hostile-but-idle`, `production-stall`) so it
is a reproducible list that shrinks as the AI improves, rather than a paragraph that rots.

`test/ailab.test.js` guards the bench itself: that runs are deterministic (or a "+0.04
improvement" is indistinguishable from noise) and that the override seam actually reaches the
sim (or every search measures the baseline against itself).

### 3.3 The loop to run with Claude Code

Packaged as a skill at `.claude/skills/ai-lab/SKILL.md`, so Claude picks it up whenever the
work is about tuning the opponent. The loop it encodes:

1. **Baseline** a sweep to JSON. Never compare against remembered numbers.
2. **Name the component you intend to move** before changing anything.
3. **One hypothesis**, expressed as an overrides file.
4. **Sweep the candidate, then `compare`** — read the per-configuration deltas, not the mean.
   A mean that improved because one world improved a lot is a regression in disguise.
5. **Guardrails, every time:** `npm test` (determinism, purity, the resolve guarantee),
   `ailab check` (the defect list must not grow), and a check that the skirmish path is
   untouched if only Odyssey was meant to change.
6. **Record it in the ledger below — including the failures**, so the next session doesn't
   re-run a dead end.

The division of labour that makes this worth doing: the bench supplies reproducibility and
measurement; Claude supplies the part that's expensive for a human — reading a 40-row
scoreboard against the code that produced it, forming a mechanism-level hypothesis, and
turning it into the next overrides file. The judgement about *what the AI should feel like*
stays with you, encoded in `WEIGHTS`.

### 3.4 Suggested order of work

Sequenced so each step makes the next one measurable:

1. **Fix the supply deadlock** (§2.2) — a one-line-shaped fix (size the Habitat trigger to
   the largest supply cost in the effective mix, or skip a mix entry that can't fit rather
   than retrying it). It's the cheapest, and it currently corrupts every long-run
   measurement.
2. **Give the industry chain an ore reserve** like the Foundry's (§2.4), so development isn't
   starved by unit production. Then re-measure whether `rusherGraduates` needs to exist.
3. **Add a surplus sink** (§2.3): more Barracks / more expansions / a repeatable late-game
   purchase, so a developed economy has somewhere to put its income. This is the change that
   makes "play forever" true for the AI as well as the player.
4. **Decide what a non-initiating neighbour means in Odyssey** (§2.1) — either weight
   `neighbourAiProfile` away from them, or give Odyssey a provocation path that a
   `neverInitiates` strategy still answers.
5. **Then** search the dials (§3.3). Tuning multipliers on top of a deadlocked, starving,
   hoarding AI is fitting noise.
6. **Optional, high leverage:** make the controller owner-parametric (§2.8) and replace the
   sparring bots with self-play.

---

## 4. Search ledger

One row per experiment, including the ones that didn't work. Unrecorded negative results get
re-run.

| date | hypothesis | overrides | result | kept? |
|---|---|---|---|---|
| 2026-07-30 | — (baseline) | — | `check --minutes 40`, 44 runs: mean score **0.328**. production-stall 43/44 · hoarding 23/44 · hostile-but-idle 22/44 · dev-flatline 19/44 · supply-deadlock 5/44 | n/a |
