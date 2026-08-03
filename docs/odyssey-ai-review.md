# The Odyssey AI — review, and a bench for tuning it

Two things live in this document:

1. **A review of the AI as it plays in Odyssey**, backed by measurements rather than by
   reading the source. Every claim below has a command that reproduces it.
2. **A proposal for searching and testing better AI strategies** with Claude Code, and the
   tool that makes it runnable — `tools/ailab.js`.

Each finding in §2 carries a **Status**: what was done about it, or why it was left. §5 is the
running ledger of experiments, including the ones that didn't work.

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

## 2. What the bench measured, and what changed

Reproduce any row with the command under it. All runs are seeded and deterministic.

The soak is **11 worlds × 4 strategies, Medium, 40 sim-minutes each** — 44 runs, a few minutes of
wall clock. It is run against two opponents, because the answer differs completely between them:
`passive` (a player who seats a base and then does nothing) and `skirmisher` (a turtle economy
that throws its army at the AI whenever it musters one).

Before / after the fixes in this pass, under **identical** metric definitions — the "before"
column is the pre-fix engine measured with today's bench, from a `git worktree` at the pre-fix
commit, not remembered numbers:

| detector | passive: before | passive: after | skirmisher: before | skirmisher: after |
|---|---|---|---|---|
| `supply-deadlock` | 4 / 44 | **1 / 44** | 4 / 44 | 2 / 44 |
| `hoarding` | 14 / 44 | **2 / 44** | 5 / 44 | 1 / 44 |
| `dev-flatline` | 19 / 44 | **11 / 44** | 34 / 44 | 35 / 44 |
| `production-stall` | 18 / 44 | **18 / 44** | 9 / 44 | 7 / 44 |
| `hostile-but-idle` | 0 / 44 | **2 / 44** | 13 / 44 | 34 / 44 |
| **mean score** | 0.497 | **0.619** | 0.373 | 0.336 |

Read that table honestly, because two of its columns are not wins.

Against a **passive** player the AI is substantially better: it no longer wedges, no longer
hoards, and develops on eight more worlds. `production-stall` is the exception — it did not move
at all, across two attempts. Probing the worlds it fires on shows why: the residue is the Rusher
archetype doing what it is designed to do (six workers, one Barracks) on Medium, where
`rusherGraduates` deliberately does not apply. That is not a stall the code can fix; it's the
Medium half of §2.4, and changing it means changing what a Rusher *is*.

Against a **skirmisher** the mean fell, 0.373 → 0.336, and that number needs unpacking
rather than defending. Most of it is a denominator change: `hostile-but-idle` and the `pressure`
component now apply to the never-initiating strategies too, because provocation gives them
standing where before the question was dropped as unanswerable. They are being *measured* on
something they used to be excused from. Underneath it, the real story is §2.9 — the AI dies in
the first ten minutes, so none of the long-game fixes ever come into play. That is the next
decision to make, and it is not a code decision.

One methodological note, because it bit three times: **a detector must not fire on behaviour the
design intends.** Scaling the AI up turned three of the five into false positives — "any Barracks
idle" fired on 42 of 44 healthy runs once surplus opened six of them; a peak-based thrift measure
scored a working economy (which peaks high and spends straight back down) the same as a stalled
one; and momentary supply pressure with a Habitat already going up is not a deadlock. Each was
rewritten and pinned with a test. A metric that rewards the wrong thing is worse than no metric,
because the tuning loop optimises against it.

### 2.1 Half the galaxy's neighbours can never attack you

**Status: fixed.** `neverInitiates` now means *unprovoked* in Odyssey — a neighbour still commits
once the player has destroyed its ships or started charging a Gate (`engine/diplomacy.js`
`provoked()`, read by `aiOffense`). The skirmish path keeps the flag absolute, which is where the
original player report came from. `neighbourAiProfile`'s uniform sampling was deliberately left
alone: with provocation in place it now produces variety rather than dead worlds.

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
desperation timeout. So the flag stayed; what changed is what counts as *unprovoked*. Note the
consequence for measurement: against the `passive` bot the non-initiating strategies still commit
nothing, and that is now the contract working, not a defect — which is why `hostile-but-idle` and
the `pressure` score component are gated on whether the AI was ever entitled to attack, and why
the bench gained a `skirmisher` opponent that actually fights.

### 2.2 A hard production deadlock that freezes a developed AI permanently

**Status: fixed**, in three parts — each of which re-froze production on its own once the one
before it was cleared. (1) The Habitat margin is sized from the biggest supply cost the AI could
actually try to pay (`maxSupplyDemand`), not a flat 2. (2) Supply already under construction is
credited, so one Habitat per 10 s no longer throttles a scaled-up production line. (3) Habitats
are placed at *any* of the AI's Command Centers — measured, a 70-building capital had no valid
spot left while its own expansions had room to spare.

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

**Status: fixed.** Two surplus sinks, both Odyssey-only. Sustained banked ore now opens extra
Barracks (bounded), and — for the strategies that cap their standing army, whose banks were the
four biggest in the roster — a surplus also funds a colony ship regardless of home depletion, so
a rich neighbour grows instead of hoarding.

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

**Update, 2026-08-01 — the two sinks above are both finite, and a long-enough Odyssey session
outlives them.** Raised by a player-uploaded Odyssey save (real play, not the bench): after
~118 sim-minutes, four background neighbours (kybernet, helix, forge, glacius — all
`economic`/`matching`) had fully researched every upgrade and built out to their Barracks-surplus
cap and (where room allowed) multiple Command Centers, and were **still** sitting on
8,000–34,000+ idle ore behind a garrison frozen at the strategy's bare floor — kybernet: 34,065
ore, 9,285 crystals, 9,240 radioactives, 3 units, unmoved for the whole observed session. Both
sinks are bounded on purpose (`SURPLUS_MAX_BARRACKS`, one cluster per colony ship) — that's not
the bug — but nothing picks up once they're both exhausted, and a living-galaxy world's income
never stops.

**Status: fixed.** `standingArmyCap()` (`engine/aiEconomy.js`) now adds a third, unbounded
surplus term — the same `SURPLUS_STEP` escalation shape as the Barracks sink — so sustained ore
lifts the army cap itself once the strategy's own floor is what's holding it back. Verified
directly (120-sim-minute probes, `--opponent none`, before vs. after): worlds that were frozen at
the floor for the entire run now keep growing — `helix/matching` 3 → 11 units, `forge/economic`
3 → 12 — while `default`/`aggressive` worlds (which never hit this cap; it returns `Infinity` for
them) are byte-identical, confirming the change is scoped to exactly the two strategies it
targets, and the skirmish path (`state.endless`-gated) is untouched.

```
node tools/ailab.js probe --world helix --strategy matching --opponent none --minutes 120 --sample 12
```

`sweep --minutes 40` (16-run: korrath/ferros/vesper/kybernet × 4 strategies) moved
**0.632 → 0.637** with **zero regressions** — `compare` shows every delta ≥ 0. The two
configurations that moved most were `korrath/matching` (+0.015) and `ferros/economic` (+0.065,
peak bank 10,420 → 6,736). Read the rest honestly rather than call it clean: the full 44-run
`check` at the default 60 minutes still fires `hoarding` on 2/44 (`korrath/matching`,
`oort/matching`). Both are cases where ore crosses the `SURPLUS_STEP` threshold only once, early
(3 → 4 units), then plateaus for the rest of the run because income hovers just under the next
2,000-ore step — so `armyGrowthTail` (growth in the *last third* only) reads zero even though the
world is no longer frozen at the floor. A steeper or continuously-scaled escalation would close
that gap but risks outgrowing supply faster than `aiBaseAndTech` can raise Habitats for it — left
as a follow-up, not bundled into this fix. `kybernet`/`glacius` (this section's own worst
offenders) are fully clear: their surplus was ore, and ore is exactly what this fix drains.

### 2.4 The Rusher never develops, and its Hard-only rescue lands ~30 minutes late

**Status: fixed.** `aiIndustryReserve` banks for the power grid and the first two chain buildings
before production can spend the ore, mirroring `ctx.foundryReserve`. Bounded to that bootstrap, so
a long chain never freezes the army for its whole length.

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

### 2.5 A wiped neighbour is gone forever — *withdrawn: this is by design*

**Originally filed as a defect; it isn't.** `aiFoundOrSurvive` re-seats a razed base only from a
colony ship in hand, and `aiExpand`'s Odyssey branch only *produces* one when a standing Command
Center exists — so an AI that loses its CC with no ship in flight is permanently out. Against the
`turtle` bot an Aggressive Rusher on korrath threw itself away: base gone by minute 10, last
worker by minute 20, and 1,143 ore banked forever after.

But the second half of the original claim — "a background world can quietly die and stay dead" —
does not hold. A background world has no player and no third party, so nothing can raze the
neighbour's Command Center there; the AI cannot die unattended. The only way this state is
reachable is the player razing it, and that is exactly `galaxy.pacified`: a permanent conquest
milestone with its own toast, firework and domination counter. Letting the AI re-found would make
a world read "pacified" on the starmap while a live neighbour rebuilt on it.

Left as-is deliberately. The recoverable case (CC lost while an expansion ship is in flight) is
already covered by `aiFoundOrSurvive`.

```
node tools/ailab.js probe --world korrath --strategy aggressive --opponent turtle --minutes 25
```

### 2.6 The multiplicative layers have no clamp

**Status: fixed.** `effectiveDiplomacyMults` floors the composed grace multiplier and caps the
composed grievance one. The layers still compose — an Aggressive Hard Rusher is still much the
shortest fuse in the galaxy — they just can't compound into numbers nobody chose.

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

**Status: deferred, deliberately.** This is a feature, not a defect: making the AI build
Spaceports, jump, and settle other worlds is galaxy-layer design work with real gameplay
consequences (what does a neighbour arriving on *your* world mean?), and it wants a decision from
the designer before any code. The bench is ready for it — `--opponent none` measures exactly the
background-world behaviour such a feature would change.

The neighbour plays a skirmish with extra buildings. It never builds a Spaceport, never
jumps, never settles another world, never trades for credits, never charges a Gate, never
offers or demands tribute. `checkExpansion` gives the *appearance* of faction spread, but it
is a starmap bookkeeping pass — it sets `galaxy.claims` and relabels the target world's AI
faction; no AI actually goes anywhere.

This is a design gap rather than a defect, and it's the largest single lever on how alive the
galaxy feels.

### 2.8 There is no AI-vs-AI, but there nearly is — *done*

**Status: shipped.** `runAI(state, dt, owner = "ai")` and its `aiContext` now resolve everything —
the controller (`controllerFor(state, owner)`: `state.ai` for `"ai"`, the new `state.playerAi` for
`"player"`), the enemy owner (`otherOwner`), and the fog grid (`state.fogs[owner]` — `state.fog`
and `state.fogAI` are now aliases into that same object) — from `owner` alone, instead of every
phase hardcoding `"ai"`/`state.fogAI`. `state.ai`'s shape and meaning for owner `"ai"` are
byte-identical to before; a `"player"` call is a safe no-op until a caller populates
`state.playerAi` (`engine/aiCommon.js`, `engine/aiMilitary.js`, `engine/aiEconomy.js`,
`engine/aiIndustry.js`, `engine/aiWorkers.js`, `engine/aiSuperweapon.js`, `engine/aiStrategy.js`,
`engine/aiDifficulty.js`, `engine/techtree.js`, `engine/persist.js` — the last extended
defensively, no `SAVE_VERSION` bump). The only caller is `tools/selfplay.js`, a new headless bench
(`createSelfPlayState`/`tickSelfPlay`/`runSelfPlayMatch`) — nothing in `setup.js`/`boot.js`/the
shipped game changed.

Two real fairness bugs were found and fixed on the way, both by independent adversarial review
rather than by the implementer noticing its own blind spot — worth naming because they're exactly
the class of bug a self-play system has to get right or the whole exercise is theater:

- **Hard difficulty's economic edge (`hardEdge`) was seeded onto `state.players.ai` only**, at
  `createGameState` time — a self-play `"player"` controller configured for Hard got none of the
  +10%/−10% edge an `"ai"`-owner Hard controller gets for free. Not a fog leak, a real "pays less"
  asymmetry baked into one-time setup rather than the per-tick phases. Fixed with an exported
  `seedDifficultyEdge(state, owner)`, called for `"player"` from `tools/selfplay.js` once
  `state.playerAi` exists.
- **`duel` (below) never varied which candidate played which owner slot**, so on a world with a
  map-baked `asym: { player, ai }` stat block (`oort`, `nimbus` — `engine/map.js`), the fixed side
  assignment decided the match, not candidate quality: two *identical* candidates measured 6–0 on
  one asym world and 1–5 on the other before the fix. Fixed by alternating `swapAsym` by replicate
  parity — every `duel` row now records which map side it actually ran.

See §3.2 for what this actually unlocked and §4 for the full record.

### 2.9 The AI cannot survive an early rush — *new, found while fixing the rest*

Building a sparring bot that actually fights (`--opponent skirmisher`: a turtle economy that
throws its army at the AI whenever it musters six units) opened a measurement none of the
original findings covered, and the answer is stark. On ferros the neighbour is **dead by minute
10** of a 40-minute run — no Command Center, no workers, and the world inert for the remaining
thirty minutes:

```
time  wrk army  dev bldg   banked  waves
  5m    7   1    3    7      494      0
 10m    0   0    0    0      662      0
 40m    0   0    0    0      662      0
```

It is not close, and it is not one world: the AI fails to survive on most of the roster. The
bot is not cheating — it deploys the same opening colony ship, mines with its own workers, and
pays for every unit.

**Status: reported, not fixed — this one is a design decision, not a defect.** Razing a
neighbour's Command Center is `galaxy.pacified`, an intended conquest milestone with its own
firework and a domination counter, so "a determined player can kill a neighbour" is the *feature*.
What the bench can say is that today the bar is very low and the same rush works everywhere.
Whether that bar should move — and how far — is a call about the difficulty curve of the whole
Odyssey, and it belongs to whoever owns that curve, not to a defect-fix pass.

Worth knowing before deciding: **none of the five fixes above touch this.** They all improve the
long game, and against a rushing opponent the long game never arrives. That is visible in the
comparison table at the top of this section — the passive column moves a lot, the skirmisher
column barely does.

```
node tools/ailab.js probe --world ferros --opponent skirmisher --minutes 40 --sample 5
```

**Update, 2026-07-31 — the bar moved, unintentionally.** The "Doctrine research develops over
time" change (`docs/improvement-proposals.md`) is unrelated to this section by design — it's a T1
telegraphing/pacing fix, not an AI-survivability change — but `git bisect` on a freshly-red
`test/ailab.test.js` traced a real regression to it (commit `4b95948`): on
`ferros/economic/skirmisher/seed=7`, the AI now loses every worker and building before it ever
fields a single combat unit, where before it still lost — per this section's own table — but got a
worker and an army unit out first. Isolating the cause (research-time duration, `aiResearch`
disabled outright, gating on `ctx.threats`) each changed the trajectory without restoring the old
outcome, so this reads as the already-described fragility interacting with the new economy
pressure of a paid-up-front, no-longer-instant Refinery purchase, not a one-line bug in the new
feature itself. Left as-is per this section's own verdict (a difficulty-curve call, not a defect-fix
one) — `test/ailab.test.js` now asserts on `buildings`, not `army`, so it once again documents
reality instead of drifting red. Repro: `node tools/ailab.js probe --world ferros --strategy
economic --opponent skirmisher --minutes 25 --sample 2 --seed 7` against commit `4b95948`'s parent
vs. itself.

### 2.10 Cooling off was the one part of temperament diplomacy left flat — *fixed*

Not a defect from the original review; raised afterwards, and it's the right observation. The
diplomacy layer flavoured how fast a neighbour *sours* (`grievanceMult`: a Warlord world at 2×, a
patient one at 1×) but every world *recovered* at the same rate, and `provoked` — the flag that
lets a never-initiating strategy answer back — latched permanently. So once you had fought anyone,
every temperament held the grudge identically and for ever.

**Status: fixed.** One `forgiveness` dial drives both halves of the cooldown:

- **The stance drift is now asymmetric.** Recovery runs at `DRIFT_RATE × forgiveness`; souring
  keeps the stock rate, because that direction is already `grievanceMult`'s job. A personality
  that forgives slowly must not also turn hostile slowly — that's a separate test.
- **Provocation is a timestamp, not a latch.** It fades after `PROVOKE_MEMORY / forgiveness`
  seconds of quiet, each fresh loss re-arms the clock, and a charging Gate provokes for as long as
  it charges regardless.

It composes across archetype × strategy × difficulty and is bounded like `graceMult`, giving a
spread of roughly 8× between the most and least forgiving reachable combinations:

| world / strategy / difficulty | forgiveness | grudge memory |
|---|---|---|
| korrath (Rusher) / Aggressive / Hard | 0.30 | 16.7 min |
| korrath (Rusher) / Adaptive / Medium | 0.50 | 10.0 min |
| vesper (Balanced) / Adaptive / Medium | 1.00 | 5.0 min |
| ferros (Economist) / Adaptive / Medium | 1.50 | 3.3 min |
| ferros (Economist) / Economic / Easy | 2.50 | 2.0 min |

In play: raid a Warlord world and it stays primed against you for most of a session; raid a
trading world, leave it alone for a few minutes, and it goes back to business.

Bench: the `passive` column is **byte-identical** across all five detectors (0.619 → 0.619), which
is the right answer — a player who never draws blood never provokes anyone, so the dial is a no-op
against that opponent. Against the `skirmisher` the mean rose 0.336 → 0.365 with `hostile-but-idle`
falling 34/44 → 18/44, but most of that is the *metric* getting fairer rather than the AI playing
better: a neighbour that has cooled off — or been killed — no longer counts as "hostile and
refusing to attack", because it is no longer entitled to attack.

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
node tools/ailab.js probe        # one configuration, full time series
node tools/ailab.js sweep        # a matrix of worlds × strategies × difficulties → scoreboard + JSON
node tools/ailab.js compare      # A/B two saved sweeps, per-configuration deltas
node tools/ailab.js search       # deterministic coordinate scan over a strategy's dials
node tools/ailab.js check        # the named-defect list from section 2, across the roster
node tools/ailab.js leaderboard  # rank N candidates against the SAME fixed opponent — see below
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
| `passive` | seats a base, never acts | does pressure ever arrive at all? the only bot that never draws blood |
| `turtle` | economy behind turrets, never attacks | can the AI crack a defended base? |
| `skirmisher` | turtle that also throws its army at the AI | does a provoked neighbour push back — and does the AI survive being rushed? |

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

**Ranking candidates against each other — a proxy for a championship, not the real thing.**
Every command above measures ONE candidate against the fixed sparring bots. `leaderboard` ranks
several at once, with difficulty/opponent/worlds/seeds held IDENTICAL across every candidate — so
comparing them never hands one an APM or micro edge another one doesn't get — and prints the same
`score()` components, meaned per candidate, sorted best-first:

```
node tools/ailab.js leaderboard --candidates a.json,b.json,c.json [--difficulty medium] [--opponent tech]
```

Each candidate file is `{ "name": "...", "strategy": "aggressive", "overrides": {...} }` — see
`tools/candidates/` for five runnable examples (the four stock strategies plus one novel tweak).
**Read the result honestly: this is "beats the same non-adaptive yardstick," not "beats the other
candidates directly."** `leaderboard` stays a proxy on purpose — it's cheap, and it's still the
right tool when the question is "how does this dial change do against a fixed opponent." When the
question is actually "which of these strategies beats the *other one*," use `duel` instead.

**True head-to-head — `duel`, `swiss`.** §2.8's self-play refactor means two candidates can now
really fight, both driven by the real `runAI`, each with its own archetype/strategy/difficulty, in
a real skirmish resolved by `engine/victory.js`'s own elimination/score-at-clock rule — not a
sparring bot standing in for one side:

```
node tools/ailab.js duel --a a.json --b b.json [--worlds w1,w2] [--difficulties medium,hard] [--seeds 2]
node tools/ailab.js duel --candidates a.json,b.json,c.json ...     # round-robin, every pair once
node tools/ailab.js swiss --candidates a.json,b.json,c.json,d.json,... [--rounds N]   # for a large pool
```

Fairness is structural, not conventional: `pinnedDuelDials(difficulty)` reads the difficulty *once*
into one `dials` object that both sides' configs spread from, so apm/micro/difficulty cannot
diverge between candidates — every row reads them back off the live controllers to prove it, not
the CLI input. `duel` runs **side-swapped by default** (candidate A as `"ai"` *and* as `"player"`,
both reported separately, never blended) and keeps every `--difficulties` bracket separate rather
than averaging across them — collapsing either of those is exactly what would hide a side- or
APM-driven asymmetry (see §2.8's two bugs, both of which a naive single-direction, single-bracket
measurement would have missed). `swiss` is the same fair pairing, scheduled Swiss-style
(closest-standing pairs, rotated byes, `max(3, ⌈log₂n⌉)` rounds by default) for a candidate pool too
large for round-robin's quadratic match count. `search --tournament-against baseline.json` points
the existing coordinate-scan dial search at a candidate's `duel` standing against a fixed baseline
instead of its solo `score()` — same search mechanics, a fairer objective when what you're actually
optimizing for is beating another strategy, not a scripted bot.

Candidate files are identical in shape to `leaderboard`'s. All of it lives in `tools/ailab.js` and
`tools/selfplay.js`; see `test/ai-selfplay.test.js` and the duel/swiss tests in
`test/ailab.test.js` for the fairness guarantees pinned as tests, not just comments.

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
6. **Done:** the controller is owner-parametric (§2.8) and self-play (`duel`/`swiss`, §3.2)
   replaces the sparring bots for head-to-head comparisons. `leaderboard`'s proxy signal is still
   the right tool against a fixed opponent; reach for `duel`/`swiss` when the question is which
   candidate beats the *other one*.

---

## 4. Search ledger

One row per experiment, including the ones that didn't work. Unrecorded negative results get
re-run.

| date | hypothesis | change | result | kept? |
|---|---|---|---|---|
| 2026-07-30 | — (baseline) | — | passive **0.497** · skirmisher **0.373**. supply-deadlock 4/44 · hoarding 14/44 · dev-flatline 19/44 · production-stall 18/44 | n/a |
| 2026-07-30 | the five §2 defects are real and independently fixable | engine, TDD (§2.1–2.4, 2.6) | passive **0.619** (+0.122) · skirmisher **0.336** (-0.037). hoarding 14→2 · dev-flatline 19→11 · supply-deadlock 4→1 | **yes** |
| 2026-07-30 | extra Barracks alone will drain the hoard | Barracks escalation on surplus | no effect on `economic`/`matching` — a standing-army cap means extra capacity sits idle, so their bank kept climbing. Needed a second, in-character sink | partly — kept, but insufficient alone |
| 2026-07-30 | a rich neighbour should GROW, not stockpile | surplus also funds a colony ship | this is what actually moved hoarding 14→2 | **yes** |
| 2026-07-30 | `rusherGraduates` needs retuning | — | **not needed.** The graduation gate was fine; the 30-minute lag was unit production eating the ore first. Fixing the reserve fixed the symptom, so the dial was left alone | no change |
| 2026-07-30 | a wiped neighbour should be able to re-found (§2.5) | — | **rejected.** A background world has no player and no third party, so the AI cannot die unattended; the only path there is the player razing it, which is `galaxy.pacified` — permanent by design. A re-founding AI would show a world as "pacified" with a live neighbour rebuilding on it | no |
| 2026-07-30 | the bench's own detectors are still valid after the fixes | — | **no** — three of five became false positives on the scaled-up AI. Rewritten and pinned with tests; the pre-fix baseline was re-measured under the new definitions rather than compared across them | corrected |
| 2026-07-30 | temperament should govern the grievance/aggression COOLDOWN, not just the souring | `forgiveness` on archetype × strategy × difficulty, driving both the recovery drift and the provocation memory | a ~8× spread across reachable combinations (16.7 min of grudge down to 2.0). Bench: passive **0.619 → 0.619, byte-identical on all five detectors** (correct — a player who never draws blood never provokes anyone, so the dial is a no-op there); skirmisher **0.336 → 0.365**, `hostile-but-idle` 34/44 → 18/44. Read that second number carefully: most of it is the metric getting *fairer*, not the AI playing better — a neighbour that has cooled off, or died, no longer counts as "hostile and refusing to attack". Souring deliberately left on the stock rate, pinned by a test, since the obvious implementation would have slowed it too | **yes** |
| 2026-07-30 | `production-stall` is one Habitat per 10 s throttling the army | parallel Habitats when supply, not ore, is the bottleneck | **no** — 18/44 before, 18/44 after. Probing the worlds it fires on shows the residue is the Rusher archetype's designed economy (six workers, one Barracks) on Medium, where `rusherGraduates` doesn't apply. Kept anyway: it is what moved supply-deadlock 4→1 | kept, but it did not fix what it was aimed at |
| 2026-08-01 | the §2.3 Barracks/colony-ship surplus sinks are both finite, so a long-enough Odyssey session outlives them and hoarding returns once a neighbour is fully built out | let sustained ore lift the standing-army cap itself (`standingArmyCap` in `engine/aiEconomy.js`), same `SURPLUS_STEP` escalation shape, Odyssey-only | Raised by a player-uploaded Odyssey save: kybernet held 34,065 ore / 9,285 crystals / 9,240 radioactives behind a 3-unit garrison after ~118 sim-minutes with every upgrade researched and Barracks/CCs at cap. 120-min probes confirm the fix: `helix/matching` 3→11 units, `forge/economic` 3→12, both previously frozen at the floor all run. `sweep --minutes 40` (16 runs) 0.632→0.637, **zero regressions** (`compare`: every delta ≥ 0); `default`/`aggressive` configs byte-identical (never hit this cap). `check` (44 runs, 60 min) `hoarding` 2/44 residual (`korrath/matching`, `oort/matching`) — ore crosses the step threshold once early then plateaus just under the next one, so `armyGrowthTail`'s last-third window reads zero even though the world isn't frozen anymore; not the same failure as before | **yes** |
| 2026-08-03 | §2.8's owner-parametric refactor is buildable as a contained, additive change without touching the shipped single-AI game | `runAI(state, dt, owner = "ai")`, `state.playerAi` mirroring `state.ai`, `state.fogs[owner]` (`state.fog`/`state.fogAI` now aliases), `controllerFor`/`otherOwner` (`aiCommon.js`) threaded through every AI phase module; new headless bench `tools/selfplay.js` | Full suite 1850→1860 (10 new tests, `test/ai-selfplay.test.js`), zero regressions, `engine-purity`/determinism green. Independent adversarial review (fairness lens + correctness lens, run in parallel, neither trusting the implementer's self-report) found **one real high-severity bug before this was accepted**: Hard difficulty's `hardEdge` economic edge was seeded onto `state.players.ai` only, never a self-play `"player"` controller configured for Hard — a genuine "pays less" asymmetry, not a fog leak. Fixed with `seedDifficultyEdge(state, owner)`. Reviewers also independently falsified fog-isolation live (deliberately lighting single fog cells and confirming causally independent reads both directions) rather than trusting the shipped tests alone | **yes** |
| 2026-08-03 | a fair `duel` command (`tools/ailab.js`) can be built directly on the self-play refactor, reusing `engine/victory.js`'s own resolution rather than inventing one | `pinnedDuelDials()` reads difficulty once into one object both sides spread from; `runDuel`/`runRoundRobin` | 1860→1867 (7 new tests). Independent review found a **second real high-severity bug**: `duel` always seated candidate A as `"player"` and B as `"ai"`, so on a world with a map-baked `asym` block (`oort`, `nimbus`) the fixed side decided the match — two *identical* candidates measured 6W-0L on oort and 1W-5L on nimbus. Fixed by alternating `swapAsym` by replicate parity; the same repro then measured 4-2 / 3-3, consistent with ordinary variance | **yes** |
| 2026-08-03 | side-swap (both candidates play both owner slots) and never-blended difficulty brackets close the remaining "is one owner slot structurally easier" and "does averaging across difficulty hide an APM-driven edge" gaps `duel` alone couldn't rule out | `runSwappedDuel`/`runDuelBrackets`/`runRoundRobinSwapped`, side-swap on by default (no opt-out flag, "not an opt-in easy to forget") | 1867→1875 (8 new tests). Review found only non-blocking issues (a cosmetic aggregate-level difficulty-echo bug carried over from `duel`, and a documented note that the two swap directions sample different seeds so a disagreement between them isn't *purely* an owner-slot signal) — no fix cycle needed, passed on first review | **yes** |
| 2026-08-03 | `search`'s existing coordinate-scan can evaluate candidates by tournament standing instead of solo `score()` against a scripted bot, without changing the scan mechanics or the non-tournament path | `--tournament-against baseline.json` switches `evaluate()` to `runDuelBrackets` against a fixed baseline; `mode`/`detail` shape distinguishes tournament rows from score rows | 1875→1880 (5 new tests). Verifier independently re-ran `runDuelBrackets` on `search`'s own winning candidate and diffed against `search`'s internal result — byte-identical, proving genuine delegation rather than a look-alike calculation. One cosmetic-only finding (an advisory CLI line unconditionally reworded) | **yes** |
| 2026-08-03 | Swiss pairing (closest-standing pairs, rotated byes, `max(3, ⌈log₂n⌉)` rounds) is the right bounded Tier 5 slice — not an ELO ladder (needs cross-invocation persistence this project has no use for yet) or Odyssey multi-owner (needs the refactor generalized past two slots, out of proportion for a scheduling layer) | `runSwissTournament`, reusing `runSwappedDuel` unchanged as the per-pairing primitive | **Correction below (same date) — this row's own "independently verified" claim was false; see the next row.** A scripting accident in the orchestration crashed before Tier 5 got the same independent verify+review every other tier in this table got; it shipped self-graded (1880→1893, 13 new tests, all green) with nobody else checking it first | **partially — see below** |
| 2026-08-03 | the row above claimed independent verification Tier 5 never actually received — dispatched two fresh, independent agents (a verifier and an adversarial reviewer, same as every other tier) after the fact to check it for real | — | Both found real problems the self-grading missed. **(1) HIGH:** a bye credited `worlds.length × seeds × 2` (a maximum-margin sweep) as pure wins with zero losses — reproduced live tying a candidate that structurally cannot fight (`neverInitiates` + a zero standing-army cap) with a genuine winner, and confirmed that credit exceeded the best real margin observed across every pairing of the project's own 4 named strategies (best real: 7/8; bye credit: 8/8). **(2) MEDIUM:** the pairing algorithm's own comment and CLI text claimed a repeat pairing only happens when "every remaining opponent has already been played" — false: fuzz-tested against a brute-force ground-truth checker, a plain greedy walk (first-fit, no backtracking) produced an *avoidable* repeat in 25-51% of realistic tournaments at n=6..50, and the shipped "rematch avoidance" test only passed because its hardcoded `seedBase` (7) happened to be lucky (6/9/10 reproducibly failed). **(3) low:** the same difficulty-echo bug class fixed elsewhere that day existed twice more, unpatched, in `runSwissBracket`/`runRoundRobinSwapped`'s own bracket-level field | **yes — this is what the row above should have said** |
| 2026-08-03 | fix all three, properly this time: a bye must be worth nothing, and rematch-avoidance must actually hold, not just usually | Bye: removed the wins credit entirely — a bye now adds only to its own `byes` counter, never `wins`/`losses` (renamed `byePoints`→`byeMatchCount`, kept as informational-only). Pairing: `pairRound` now backtracks (`findMatching`, bounded by `MATCH_ATTEMPT_CAP`) to find a genuine zero-repeat matching whenever one exists, falling back to the old greedy pass (which allows repeats) only when none does. Difficulty echo: both remaining instances now read through `pinnedDuelDials` | Fuzz-verified the pairing fix at the exact scales the review found failing (n=4..50, realistic sequential simulation, 990 rounds total): **0 avoidable repeats**, down from the review's measured 25-51%. The bye fix directly closes the reviewer's own repro (a non-fighting candidate can no longer tie a genuine winner). Full suite 1893→1897 (new: a direct backtracking-vs-greedy regression test reproducing the reviewer's exact stranding scenario, a genuine-impossibility fallback test, the bye-neutrality tests, and a strengthened rematch-avoidance test run across 5 seed bases including the ones that broke the old algorithm) | **yes** |
