---
name: ai-lab
description: Search for and test better Odyssey AI strategies using tools/ailab.js. Use when asked to tune, improve, evaluate, or compare the AI opponent — its archetypes (engine/aiArchetypes.js), strategies (engine/aiStrategy.js), or difficulty dials (engine/aiDifficulty.js) — or when asked why the AI in Odyssey feels passive, stalls, hoards, or plays the same on every world.
---

# Tuning the Odyssey AI

`tools/ailab.js` is a headless bench: it runs the real sim for 30–60 sim-minutes per world
(a few seconds of wall clock each), samples AI-quality metrics, and prints a scoreboard.
Use it instead of reasoning about the AI from source — the AI's behaviour is three data
tables composed multiplicatively across a 40-minute curve, and reading the code will not
tell you what that curve does.

## The one thing that makes this cheap

A candidate AI is **JSON, not a patch**. `ARCHETYPES`, `STRATEGIES` and `DIFFICULTY_OPTIONS`
are plain exported objects read through `|| 1`-style accessors, so `--overrides` writes new
rows into them before a run. Explore the whole space without touching `engine/`.

```json
{
  "strategies":   { "swarm":  { "armyAttackSizeMult": 0.5, "garrisonMult": 0.2 } },
  "archetypes":   { "rusher": { "odyssey": { "workerTarget": 9, "expandWhenNodesBelow": 0.45 } } },
  "difficulties": { "hard":   { "workerTargetMult": 1.4 } }
}
```

Only promote a winner into `engine/` **after** it survives a multi-seed sweep on the full roster.

## The loop

1. **Baseline.** `node tools/ailab.js sweep --seeds 2 --json /tmp/base.json`
   Never skip this. The objective is noisy and the roster is uneven; a candidate compared
   against remembered numbers is a candidate compared against nothing.
2. **Read the components, not the total.** Every row prints `develop / keepGrowing /
   pressure / thrift / liveness / survive`. A total that moved without a component moving is
   noise. Name which component you intend to move before you change anything.
3. **One hypothesis at a time**, written as an overrides file. Two dials at once and you
   cannot attribute the result.
4. **Measure.** `node tools/ailab.js sweep --overrides cand.json --seeds 2 --json /tmp/cand.json`
   then `node tools/ailab.js compare --baseline /tmp/base.json --candidate /tmp/cand.json`.
   `compare` prints per-configuration deltas — read them. A mean that improved because one
   world improved a lot and three got worse is a regression wearing a disguise.
5. **Guardrails before you believe it** (all three, every time):
   - `npm test` — determinism, engine purity, and "a skirmish resolves to a winner" on all
     nine worlds. AI changes break the resolve guarantee more often than anything else.
   - `node tools/ailab.js check` — the named defect list. It must not grow.
   - Confirm the skirmish path is untouched if you only meant to change Odyssey (Odyssey-only
     behaviour lives behind `state.diplomacy` / `state.endless` guards).
6. **Record the result in the ledger** (`docs/odyssey-ai-review.md`, "Search ledger"), including
   the failures. An unrecorded negative result gets re-run by the next session.

## Picking the objective before you optimise

`WEIGHTS` in `tools/ailab.js` encodes what "better AI" means and is deliberately editable.
Odyssey is a **play-forever sandbox with no win condition**, so the default weights reward a
neighbour that keeps developing, keeps spending, and applies pressure proportional to how
hostile it has actually become — not one that wins fast. If the user wants something else
(a harder opponent, a more passive galaxy), change the weights *first* and say so, rather
than optimising the default and describing the result as an improvement.

## Choosing an opponent — this decides what you are measuring

- `--opponent none` — no player at all. What 10 of 11 worlds actually are for most of an
  Odyssey. Use for development-curve work. Pressure is dropped from the score here.
- `--opponent passive` (default) — a seated base that never acts. Use to answer "does
  pressure ever arrive at all".
- `--opponent turtle` — a real economy behind turrets that never attacks. Use for
  "can the AI crack a defended base", which is the question that decides whether an
  Odyssey neighbour is threatening. (Its turrets still kill the AI's scouts, so it *does*
  provoke — `passive` is the only bot that never draws blood.)
- `--opponent skirmisher` — a turtle that also throws its army at the AI. The only bot that
  reliably provokes, so it is the one that answers "does a never-initiating neighbour push
  back once it's entitled to?" and "does the AI hold up under sustained attack?".

A result from one opponent says nothing about the others. State which one you used.

## Search

`node tools/ailab.js search --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'`

A deterministic coordinate scan — the simplest thing that works. The judgement that matters
is *which dials to open*, and that is yours: prefer dials whose mechanism you can state in a
sentence ("commit sooner, with less"), and open at most two or three. Re-run any winner
through `sweep --seeds 3` on the full roster before believing it — the search optimises a
noisy mean and will happily overfit three worlds.

## Ranking several candidates at once (a proxy, not self-play)

`node tools/ailab.js leaderboard --candidates a.json,b.json,c.json` runs N candidates through the
same `sweep` machinery and ranks them by mean `score().total`, with difficulty/opponent/worlds/seeds
held identical across every one of them — so no candidate gets an APM or micro edge another one
doesn't. Each candidate file: `{ "name": "...", "strategy": "aggressive", "overrides": {...} }`
(`overrides` optional; see `tools/candidates/` for runnable examples). Useful when the question is
"which of several hypotheses is most promising" rather than "did this one change help" — it's still
`sweep`'s baseline-vs-yardstick comparison under the hood, just done N times with clean isolation
between candidates (each one's overrides are reverted before the next one runs).

**`leaderboard` is not head-to-head play** — it's still ranking against the same fixed sparring
bot, just N times. Report its result as "beat the same fixed opponent by more," never as "beat the
other candidates" — the two are not the same claim. When the question really is which candidate
beats the other one, use `duel`/`swiss` below instead.

## Head-to-head: `duel` and `swiss` (real self-play)

The AI controller is owner-parametric (`runAI(state, dt, owner)` — `docs/odyssey-ai-review.md`
§2.8), so two candidates can now really fight: both driven by the real `runAI`, each with its own
archetype/strategy/difficulty, resolved by `engine/victory.js`'s own skirmish rule. `tools/selfplay.js`
is the headless bench this runs on; `tools/ailab.js` wraps it:

```
node tools/ailab.js duel --a a.json --b b.json [--worlds w1,w2] [--difficulties medium,hard] [--seeds 2]
node tools/ailab.js duel --candidates a.json,b.json,c.json ...     # round-robin
node tools/ailab.js swiss --candidates a.json,b.json,...,z.json [--rounds N]   # large pools
node tools/ailab.js search --tournament-against baseline.json ...  # dial search scored by duel, not score()
```

Fairness is structural: `pinnedDuelDials(difficulty)` reads the difficulty *once* into one object
both sides' configs spread from, so apm/micro/difficulty cannot diverge — every row reads them back
off the live controllers to prove it. `duel` is side-swapped by default (both candidates play both
owner slots, reported separately, never blended) and keeps every difficulty bracket separate rather
than averaged. Both defaults exist because naive versions of each were tried first and an
independent adversarial review caught real bugs in both: a fixed side assignment let a map's own
`asym` block (`oort`/`nimbus`) decide matches regardless of candidate quality, and Hard difficulty's
economic edge (`hardEdge`) was only ever seeded onto owner `"ai"`, never a self-play `"player"`
controller configured for Hard. Full story and numbers in `docs/odyssey-ai-review.md` §2.8 and the
2026-08-03 ledger rows. If you extend this further: **assume there's another one of these bugs
until an independent reviewer — a fresh agent with no memory of writing the code — has actually
tried to find it.** Every tier of this build caught something real; the one tier that skipped
independent review (a scripting accident, not a deliberate skip) was the one a human had to go back
and check by hand afterward.

## Traps specific to this codebase

- **Self-play code must resolve everything from `owner`, never hardcode a side.** Any new AI-phase
  code has to read the controller via `controllerFor(state, owner)`, the fog via
  `state.fogs[owner]`, and the enemy via `otherOwner(owner)` (`engine/aiCommon.js`) — a stray
  `state.ai`/`state.fogAI`/`"ai"` literal in a spot that could run for owner `"player"` is exactly
  how the two bugs in the section above happened, and it usually still passes `npm test` because
  the shipped game only ever exercises owner `"ai"`.
- **Layers compose multiplicatively.** Archetype × strategy × difficulty all multiply
  (`graceMult`, `workerTargetMult`, …). A dial that looks mild in isolation can be a 3×
  swing on Hard + Aggressive + Rusher. Always sweep across difficulties when touching one.
- **`neverInitiates` means "doesn't start fights", and only in Odyssey.** In a skirmish it is
  absolute, including the desperation timeout — made so on purpose, because a passive player
  was eating unexplained all-in waves. In Odyssey a neighbour may still answer a player who
  **provoked** it (`engine/diplomacy.js` `provoked()`: destroyed its ships, or is charging a
  Gate). Never widen provocation to elapsed time or stance alone — that reintroduces the exact
  bug. And note what it means for measurement: against `passive` and `none` those strategies
  correctly commit nothing, so use `--opponent skirmisher` when the question is whether the AI
  pushes back.
- **A metric that fires on correct behaviour is worse than no metric.** Two detectors had to be
  rewritten after they turned into false positives on a scaled-up AI. When a fix lands, re-read
  the detectors before trusting the scoreboard — and if you change one, re-baseline the OLD
  engine under the NEW metric (a `git worktree` at the pre-fix commit with the current
  `tools/ailab.js` copied in) rather than comparing across metric definitions.
- **Neighbour worlds pick their strategy uniformly at random** (`neighbourAiProfile` in
  `engine/galaxy.js`), so any change to the STRATEGIES table changes roughly a quarter of the
  galaxy. Weight the sweep accordingly.
- **Phase order in `engine/ai.js` `runAI` is load-bearing** — phases share an APM budget and
  pass ore reserves forward. Production runs before industry, which is why industry starves
  on a fast-spending archetype. Reordering is a real change; measure it, don't assume it.
- **The engine must stay pure and deterministic.** No `Math.random`/`Date.now` under
  `engine/`, ever (`test/engine-purity.test.js`). Sparring bots and metrics belong in
  `tools/`, never in the engine.
