# The adaptive opponent — reading the player, and answering

*2026-08-07. A design for an AI that works out what kind of game you are playing and responds to it,
rather than executing a plan picked before the match started.*

## The problem, stated from two directions

**From the player's side.** You decide whether you are playing an economy game, a war game, or
something in between. Today the AI does not notice. Its strategy is picked once at setup
(`engine/aiStrategy.js`, chosen in `setup.js`) and never changes, so a Rusher rushes into your
turtle and an Economic neighbour keeps building refineries while you mass an army on its border.
Nothing you do changes what kind of opponent you are facing.

**From the bench's side.** The evolutionary search
(`docs/ai-evolution-design.md` §9) bred a champion that beat all four shipped strategies by
*never attacking* — hoarding an army it never risked, because `engine/victory.js`'s score-at-clock
tiebreak pays 1.35× for combat units and 0.25× for banked ore. It won 78% at Medium and its every
win at Hard came from the timer.

These are the same problem. **The hoarder only works because its opponents cannot see that it is
undefended.** An AI that reads "enemy has a huge economy and no army near me" and raids the worker
line turns hoarding from optimal into exploitable. That is worth stating plainly, because the
alternative — penalising turtling inside the fitness function — is a patch evolution would simply
route around, and this is a structural fix that needs no fitness change at all.

## What already exists

The AI is not blind. Every primitive is present and correctly fog-limited:

| signal | where |
|---|---|
| enemy army size, from the AI's own fog | `aiMilitary.js` `visibleEnemyForceCount` |
| enemy buildings currently in sight | `aiMilitary.js` `chooseAttackTarget`'s `seenBuildings` |
| enemy worker lines | `aiMilitary.js` `raidTarget` |
| enemy composition, for counter-picking | `aiMilitary.js` `counterToPlayerArmy` |
| enemy combat pressing home | `aiMilitary.js` `visibleThreatsNearHome` |

What is missing is not perception. It is that **each signal drives exactly one hardcoded reaction,
and nothing synthesises them into a view of the opponent.** Four concrete gaps:

1. **Nothing reads the enemy's economy.** `visibleEnemyForceCount` counts soldiers. No code
   anywhere counts enemy workers or economic buildings — so the AI literally cannot perceive greed,
   which is the single thing this design needs it to see.
2. **The economy raid is gated behind `controller.micro`** — Hard only — and fires on a fixed
   `waveCount % RAID_EVERY` cadence. It is a metronome, not a response to seeing you undefended.
3. **There is no memory.** Entity sighting goes through `isVisibleAt` (the *live* fog layer), never
   `isExploredAt`. Everything the AI knows is what it can see this instant; kill its scout and its
   picture of you is empty, and it has no way to know it is blind.
4. **Strategy never changes.** Force Parity's `matchEnemyForce` is the closest thing to adaptation
   in the game, and it is one number — mirror the enemy's army size.

## The design

### 1. The read — posture and confidence

A new leaf module `engine/aiIntel.js` maintains, per controller, an estimate of the enemy:

- **`mil`** — ore-value of enemy combat units and defensive buildings the AI can see
- **`eco`** — ore-value of enemy workers and economic buildings the AI can see
- **`posture`** = `mil / (mil + eco)` — 0 is a pure economy game, 1 is a pure war game
- **`confidence`** — how much of the enemy has been seen, and how recently

Two properties are load-bearing:

**It must have memory.** A live-only read is unusable: the number would collapse to zero every time
the scout dies and spike whenever a wave walks past. So the estimate persists on the controller and
decays toward "unknown" with age. This is the first AI state that is genuinely a *belief* rather
than a fact.

**Confidence must be separate from the estimate.** "I have seen nothing" and "I have seen an empty
base" are completely different situations that a single number cannot distinguish, and conflating
them is how an AI ends up confidently raiding into an army it never scouted. Low confidence means
*hedge and go look*, which is what makes the scout worth its cost — and gives the player a real
counter-play in denying it.

### 2. The response — a vocabulary of aggression

Today the AI has one offensive move: muster a wave, walk at the base. The read gives it a reason to
choose among several:

| the read says | the answer |
|---|---|
| greedy, undefended | **poke** — a small squad at the worker line, leave when answered |
| greedy, teching | **sabotage** — hit the economic buildings, not the Command Center |
| massing an army | **turtle and match** — turrets, force parity, counter-pick |
| unknown | **hedge and scout** — balanced build, go find out |

`raidTarget` already implements the poke's targeting. What changes is *why* it fires.

### 3. Mode switching, with hysteresis

The existing strategy multipliers stop being a fixed pick and become a target the AI moves toward.
Hysteresis is not optional: two adaptive AIs facing each other form a feedback loop (A goes
economy → B raids → A goes military → B turtles → A goes economy) and without damping they
oscillate instead of converging. A wide dead-band and a rate limit keep the mode stable enough to
be legible.

## The tension worth protecting

**Adaptive is not automatically better.** Part of what makes Korrath's Rusher enjoyable is that it
is predictable enough to learn, plan against, and beat. An opponent that perfectly counters
everything is not a better opponent; it is an unreadable one.

This repo has already reasoned about exactly this. `engine/aiDifficulty.js` gives Easy
`counterEvery: 0` so that "its army stays exactly its learnable, exploitable archetype mix". That
precedent decides the shape here:

- **Adaptation is a difficulty dial** — sharp on Hard, mild on Medium, absent on Easy.
- **Adaptation changes tempo and targeting, never identity.** A Rusher that adapts into an
  economist is not a Rusher. The archetype still decides *what it is*; the read decides *when it
  commits and what it hits*.

## Phases

1. **The read.** `engine/aiIntel.js` — posture, confidence, decay-memory. Pure, deterministic,
   owner-parametric, fog-limited. No behaviour change: the number exists and is charted before
   anything consumes it, so a regression in the read is separable from a regression in the response.
2. **One behaviour.** Raid on the read rather than the metronome, and ungated from `micro`. The
   most player-visible slice, and the one that makes hoarding punishable.
3. **Mode switching** with hysteresis and the difficulty dial.
4. **Make it evolvable.** Adaptation genes into `tools/genome.js`'s `GENOME_SCHEMA`, so the search
   breeds adaptation *policies* rather than constants — and MAP-Elites breeds a cast of adaptation
   styles rather than a cast of fixed builds.

## Constraints this must respect

Everything before this touched only `tools/`. This touches `engine/`, so the project's hard rules
apply in full:

- **Determinism** — no `Math.random`, no `Date.now()`. The read is a pure function of state.
- **Owner-parametric** — `controllerFor(state, owner)`, `state.fogs[owner]`, `otherOwner(owner)`.
  A stray `"ai"` literal is exactly how the two self-play bugs in the ledger happened.
- **Fog-limited** — the AI reacts to what it has *seen*. An omniscient read would be both a cheat
  and, worse, would delete the scouting counter-play that makes this design interesting.
- **Save compatibility** — the belief lives on the controller, so `engine/persist.js` carries it,
  defaulting cleanly for saves that predate it.
- **Skirmish/Odyssey separation** — anything Odyssey-only stays behind `state.diplomacy` /
  `state.endless`.
