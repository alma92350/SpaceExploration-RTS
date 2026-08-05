# In-Game Competitions and Elo — design + phased implementation

*Today the AI competition machinery is a developer tool: `tools/ailab.js` and `tools/selfplay.js`,
driven from a Node CLI by whoever is tuning the AI. This proposal turns it into a **game feature** —
the player organises a competition from the splash screen, between AI entrants alone or with
themselves in the field, and an Elo ranking accumulates across it. Nothing here invents a new way of
deciding who won a match: every phase below is built on the fairness machinery that already exists
and has already had bugs found in it.*

---

## 1. What exists today (and what doesn't)

**The match primitive is done.** `tools/selfplay.js` drives *both* seats of a real skirmish with the
real controller — `runAI(state, dt, owner)` for owner `"ai"`, and a second `state.playerAi`
controller for owner `"player"` — resolved by `engine/victory.js`'s ordinary
elimination/score-at-clock rule, unmodified. The engine is already owner-parametric
(`controllerFor`/`otherOwner` in `engine/aiCommon.js`), and `engine/persist.js` already serialises
`state.playerAi`, so an AI-vs-AI match can even be saved and resumed.

**The fairness machinery is done, and it was hard-won.** `tools/ailab.js` pins APM/micro identically
for both sides through one shared object (`pinnedDuelDials`), side-swaps every pairing by default
(`runSwappedDuel`), alternates the map's own `asym` halves by replicate parity, keeps difficulty as a
never-blended bracket axis (`runDuelBrackets`), and derives every match seed from a sorted hash of
the pair (`duelSeed`). Each of those exists because a naive version was tried first and an
independent review found a real bug in it — see `docs/odyssey-ai-review.md` §2.8.

**The scheduling is done.** `runRoundRobinSwapped` (every pair) and `runSwissTournament` (Swiss
pairing with backtracking matching and proper bye assignment) both already ship in `tools/ailab.js`.

**Three things do not exist:**

| Missing | Where it bites |
|---|---|
| **Any rating system.** Standings are raw `{wins, losses, draws}` tallies. | Nothing carries skill across competitions, and a 6–2 result against a strong field reads the same as 6–2 against a weak one. |
| **Any browser entry point.** `tools/selfplay.js:197` dereferences `process.argv` at module top level, so importing it in a browser throws `ReferenceError`. `setup.js`/`boot.js`/`main.js` are deliberately untouched by it. | The game literally cannot run a self-play match today. |
| **Any human seat in a competition.** Self-play means both seats are AI, by construction. | The whole "compete against the bots yourself" half of the request. |

**Measured cost** (this machine, Node 20 — it decides what's feasible in a browser tab):

| Workload | Wall clock |
|---|---|
| One match resolved by elimination (~8–15 sim-min) | **~1.0 s** |
| One match run to the full 40-sim-min clock (worst case) | **~1.8 s** |
| `duel --worlds korrath,ferros --seeds 2` (8 matches, side-swapped, all went to the clock) | **14 s** |
| An 8-entrant Swiss round at those settings (4 pairings × 2 sides × 2 worlds × 2 seeds = 32 matches) | **~60 s** |

So: a **quick duel is instant enough to run in the foreground; a tournament round is not.** That one
number drives Decision D5 below.

---

## 2. Decisions this plan makes once

The catalog-style convention from `docs/improvement-roadmap.md`: resolve the contentious calls up
front so implementation doesn't stall re-litigating them.

### D1 — One Elo implementation, shared by the game *and* the CLI

A new **root-level pure module `elo.js`**, imported by both the in-game competition screen and
`tools/ailab.js`. Not under `engine/` — `engine/` is the simulation, and a rating is not sim state.
Root-level pure modules are already the established home for this kind of thing (`camera.js`,
`minimap.js`, `saveShape.js`, `version.js`).

*Why it matters:* if the bench and the game each grow their own rating math, a number the player sees
in-game and a number a tuning session reports stop meaning the same thing — and the entire value of a
rating is that it's comparable. One module, one meaning.

### D2 — Ratings are bracketed by difficulty, never blended

`runDuelBrackets`' header already argues this for win-rates: averaging across difficulty brackets lets
an edge at one APM/micro cap paper over a deficit at another, which is the exact confound the duel
mechanism exists to rule out. A shared Elo pool across brackets reintroduces it one level up.

So a rating is keyed **`(entrant, difficulty bracket)`**. A competition declares its bracket(s); each
bracket keeps its own table. "Aggressive @ Hard" and "Aggressive @ Medium" are two ratings, and the UI
says so.

### D3 — An entrant is `{ name, strategy, difficulty, faction }`; archetype is a Phase-2 addition

`createAiController(planetId, opts)` sets `archetype: archetypeFor(planetId)` — **derived from the
world, so both seats in a self-play match share it.** That's fair, but it means "Rusher vs Turtle"
head-to-head is not expressible today. Adding an optional `archetype` opt to `createAiController` is a
small additive change that makes competitions substantially more interesting, so it lands in Phase 2
rather than being smuggled into Phase 1.

### D4 — The human always plays owner `"player"`, and the plan says so out loud

`state.fog` aliases `state.fogs.player`, `state.selection` is documented as the human's, and
`input.js`/`hud.js` resolve the human seat as `"player"` throughout. Seating a human as `"ai"` is not
a competition feature, it's a renderer/HUD/input rewrite.

Consequence: **side-swap — the default correction for seat asymmetry — is unavailable for human
matches.** And there *is* a known seat edge: `tools/selfplay.js`'s own header measures the `"ai"` seat
reading state the `"player"` seat already mutated on 13% of think cycles, "FIXED IN DIRECTION: it
always favours the `ai` seat". The human sits in the seat that edge is measured *against*.

The honest handling, and what this plan does:
- Map-asym swap (`swapAsym`) still alternates by replicate parity for human matches — the map half is
  balanced even when the seat can't be.
- Every ledger row records `seatSwapped: true|false`, so a human-inclusive table is visibly built on
  half-corrected rows rather than silently.
- The competition screen states the bias in one line where the human's rating is shown.
- It is **not** papered over with a compensating rating fudge. A fudge factor nobody can derive is
  worse than a disclosed, bounded, one-directional bias.

### D5 — AI matches batch-simulate in a module Web Worker; the player can watch any one live

From the timings: a duel is foreground-fast, a tournament round is a minute. Freezing the tab for a
minute is not acceptable, and chunking across `setTimeout` makes the sim compete with rendering for
the main thread.

The engine is DOM-free — which is precisely what makes a Worker trivial here. `new Worker("./
competitionWorker.js", { type: "module" })`; `tools/serve.js` already serves `.js` as
`application/javascript`, so no build step and no server change. The worker posts progress per match;
the UI shows a progress bar and a **Cancel** that actually cancels.

Watching a pairing live is the *other* path (Phase 5), through the normal game loop — not a
replacement for batch simulation.

### D6 — A competition is a pure function of `(seed, roster, format)`

Every match seed derives from the competition seed via `hashStr` in the same style as `duelSeed`:
`hashStr(`${seed}:comp:${round}:${pairIdx}:${world}:${rep}`)`. Rating updates are applied in a
**canonical order** (round, then pairing index, then side) because Elo is order-dependent — so
re-running the same competition reproduces the same final table, byte for byte. That is what makes any
of this testable at all, and it matches the determinism discipline the rest of the repo already holds
itself to.

Human matches break purity by definition (a human is not a seeded input). Those rows are recorded as
*results*, not re-derived; a competition containing a human match replays its AI half deterministically
and reads the human rows back from the ledger.

### D7 — Plain Elo first, with honest uncertainty. Not Glicko-2, not margin-scaled

- `E = 1 / (1 + 10^((Rb - Ra)/400))`, `R' = R + K(S - E)`, start **1200**.
- `K = 40` while provisional (< 10 games), then `K = 20`, then `K = 10` above 2400.
- `S ∈ {1, 0.5, 0}`. Draws are near-impossible anyway — `checkWinCondition`'s score tiebreak means a
  "draw" only happens when a run hits its safety-net cutoff undecided.
- **No margin-of-victory scaling.** `engine/victory.js`'s score margin is reported alongside the
  rating as its own column and used as a standings tiebreak — but it does not feed the rating. Rating
  systems that fold in margin need careful calibration nobody here is going to do, and an
  uncalibrated one is a rating that quietly rewards running up the score.
- Entrants below 10 games render with a `?` and their game count. Glicko-2's rating deviation is the
  principled version of that and is a fine later upgrade — it's deferred, not dismissed.

### D8 — The ledger is versioned, sanitized, untrusted input

Same discipline as `engine/persist.js`, in the UI layer: `COMPETITION_VERSION`, exact-match version
gate, `sanitizeLedger()` coercing every field's type and range on load, prev-slot rotation on write
(mirroring `saveload.js`'s `autoSave`). Plus **export/import as a JSON file** through the existing
Save/Load file idiom, so a ladder can be shared or archived.

---

## 3. The format menu (brainstorm)

Formats worth having, ordered by value-per-effort. The first three are mostly *wiring* — the
scheduling already exists in `tools/ailab.js`.

| Format | What it answers | Status of the machinery |
|---|---|---|
| **Quick Duel** — two entrants, best-of-N, side-swapped | "Is A better than B?" | `runSwappedDuel` — done |
| **Round-robin** — every pair once | "Rank this small field" | `runRoundRobinSwapped` — done |
| **Swiss** — N rounds, closest-standing pairing | "Rank a large field cheaply" | `runSwissTournament` — done |
| **Gauntlet** — one entrant vs the entire field | "How good am *I* really?" — the natural human-inclusive format | Trivially a round-robin restricted to one row |
| **Knockout bracket** — single elimination | The most legible tournament *picture*; a real final | New, but small: pairing is a tree, matches are still `runSwappedDuel` |
| **Ladder / season** — persistent Elo, ad-hoc challenge matches, periodic reset | "Play forever" — matches the Odyssey's own sandbox philosophy | New: the ledger (D8) plus a challenge button |

**Human-inclusive scheduling.** The round flow becomes: *your* match is played live, everyone else's
batch-simulates. Concretely — "Round 2 of 5. Your match: **You (Frontier)** vs **Aggressive @ Hard**
on Korrath. `[Play]` `[Forfeit]`" → the human plays a normal skirmish → on `state.over`, the result
posts to the ledger → "Simulating 7 other matches…" → the round table and Elo deltas appear. A
forfeit records a loss; a bye records no rating change (standard Swiss practice, already how
`runSwissTournament` treats byes).

**Handicaps, deliberately not offered as a rating-affecting dial.** A human who wants an easier match
picks a lower-difficulty *opponent* — which is already a distinct entrant with a distinct rating
under D2, so the ladder stays coherent. A separate "handicap" multiplier would silently invalidate
every rating in the pool.

---

## 4. Phased implementation

Each phase is independently shippable and independently valuable. Effort tags are the roadmap's own
S/M/L. TDD per `CONTRIBUTING.md` — tests written from the requirement, red before green.

### Phase 0 — Make the self-play core importable from a browser *(S, no user-visible change)*

The blocker, and nothing else.

- Extract the pure core of `tools/selfplay.js` (`createSelfPlayState`, `tickSelfPlay`,
  `runSelfPlayMatch`, `fingerprint`) so it carries **no Node-only reference at module scope**. Either
  move the CLI half into a sibling `tools/selfplay-cli.js`, or guard line 197 with
  `typeof process !== "undefined"`. Prefer the split: the guard leaves a Node-shaped file in the
  browser's import graph and invites the next such line.
- Keep the file *itself* free of DOM too, so the same module runs in Node, on the main thread, and in
  a Worker.

**Files:** `tools/selfplay.js` (pure core) and `tools/selfplay-cli.js` (CLI entry point).
**Tests:** existing `test/ai-selfplay.test.js` stays green; add a case asserting the core module's
source contains no bare `process`/`document` reference (the `test/engine-purity.test.js` idiom,
pointed at this file).
**Done when:** `node tools/selfplay-cli.js run …` still works and the core imports cleanly with `process`
deleted from the global scope.

**Status: done.** The split landed exactly this way — `tools/selfplay.js` now holds only
`createSelfPlayState`/`tickSelfPlay`/`runSelfPlayMatch`/`fingerprint` (plus the `DT` they share) with
zero `process`/`document` references, and `tools/selfplay-cli.js` took the CLI half
(`parseArgs`/`runCmd`/`USAGE`/`main`) — run it as `node tools/selfplay-cli.js run …`.

### Phase 1 — `elo.js`, and an AI-vs-AI **Quick Duel** in the game *(M)*

The thinnest end-to-end slice: two AI entrants, a real match, a real rating change.

- **`elo.js`** (new, root, pure, `// @ts-check`): `expectedScore(a, b)`, `kFactor(games)`,
  `applyResult(ratings, aName, bName, score)`, `applySeries(ratings, rows)` — the last one enforcing
  D6's canonical ordering. No clock, no storage, no DOM.
- **`tools/ailab.js`**: `duel`/`swiss` gain an Elo column via the same module. This is the proof of
  D1 and costs almost nothing.
- **Competition screen**: a new `"competition"` entry in `setup.js`'s `MODES`, rendering a picker for
  two entrants (Strategy × Difficulty × Faction, reusing `optionGroup` and the existing
  `STRATEGY_OPTIONS`/`DIFFICULTY_OPTIONS`/`FACTION_OPTIONS` tables), worlds, seeds, and match length.
- **`competitionWorker.js`** (new): receives a job, runs matches through the Phase-0 core, posts
  `{type:"progress"}` per match and `{type:"done"}` with the rows. Cancellable.
- **Results view**: per-match table (world, seed, side, winner, reason, score margin) plus the
  rating delta — the shape `ailab`'s own printed table already uses, so the two read alike.

**Files:** `elo.js`, `competition.js` (screen + job orchestration), `competitionWorker.js`,
`setup.js`, `index.html`, `style.css`, `tools/ailab.js`.
**Tests:** `test/elo.test.js` (symmetry: equal ratings ⇒ E = 0.5; zero-sum: `Δa = −Δb` at equal K;
K schedule; **order-independence of the final table under D6's canonical sort**);
`test/competition.test.js` for job-shape/seed-derivation purity; `static-integrity` covers the new
DOM ids automatically.
**Risk:** the Worker is the one genuinely new browser surface. Keep the worker a thin shell — all
logic in importable modules — so it's testable under Node without a Worker at all.

### Phase 2 — Named roster, per-entrant archetype, persistent ladder *(M)*

Turns one-off duels into something that accumulates.

- **Roster**: name your entrants ("Blitz", "The Turtle"), stored in the ledger. Same
  `{name, strategy, …}` shape `tools/candidates/*.json` already uses, so a candidate file and a
  roster entry are interchangeable — and `ailab` candidates can be imported straight in.
- **Per-entrant archetype (D3)**: add an optional `archetype` opt to `createAiController`, defaulting
  to `archetypeFor(planetId)` so every existing call is byte-identical. Then an entrant can carry its
  own doctrine and "Rusher vs Turtle" becomes a real matchup.
- **Ledger (D8)**: versioned localStorage store — roster, per-bracket ratings, competition history,
  head-to-head records — plus JSON export/import.
- **Standings screen**: rating, games, W/L/D, average score margin, provisional flag, per bracket.

**Files:** `engine/state.js` (one additive opt), `competition.js`, `competitionLedger.js` (new),
`saveload.js` (file export/import reuse), `engine/types.js` (typedef).
**Tests:** ledger round-trip; sanitizer rejects a wrong-version / corrupt / hostile payload
(`test/save-hardening.test.js` is the model); `createAiController` default-archetype byte-identity;
`test/types-contract.test.js` compliance.
**Save-version note:** the *game* save shape is untouched — this is a new, separately-versioned store.
`state.playerAi` is already persisted, so watching and saving an AI-vs-AI match needs no bump either.

### Phase 3 — Real tournaments in-game: round-robin, Swiss, knockout *(M)*

- **Extract the pairing logic** from `tools/ailab.js` into a shared pure module (`pairing.js`), used
  by both the CLI and the game. The Swiss matcher's backtracking, its bye rule, and its
  already-played-pair avoidance are exactly the sort of code that must not be reimplemented — its
  header records that the first, greedy version shipped with a real defect that fuzz-testing caught.
- **Formats**: round-robin, Swiss (rounds auto-sized), knockout bracket (new pairing tree).
- **Tournament UI**: format picker, field builder, round-by-round progress, live standings, and a
  bracket view for knockout.
- **Budget estimate before you start**: show "≈ 32 matches, ≈ 1 min" from the measured per-match cost,
  because a user who picks 16 entrants × 4 worlds × 3 seeds deserves to be told it's a long run before
  it starts, not after.

**Files:** `pairing.js` (new, extracted), `tools/ailab.js` (now imports it), `competition.js`,
`competitionWorker.js`.
**Tests:** move/extend the existing Swiss pairing tests in `test/ailab.test.js` onto the shared
module — including the brute-force fuzz check for avoidable repeats, which is the whole reason that
code is trustworthy; knockout bracket shape (byes for non-power-of-two fields).

### Phase 4 — The human enters the field *(L — the flagship)*

- **Human as an entrant**: a roster row flagged `human: true`, seated as owner `"player"` (D4), with
  its own bracketed rating.
- **Mixed schedule**: the human's match per round is played live; the rest batch-simulate. Play /
  Forfeit / Simulate-the-rest, resume mid-tournament from the ledger.
- **Result capture**: hook `state.over` in `boot.js`'s existing game-over path — the result posts to
  the competition rather than only rendering "Choose another battlefield". The game-over screen shows
  the rating change and the next fixture.
- **Bias disclosure (D4)**: one line where the human's rating shows, and a `seatSwapped: false` flag
  on every human row.
- **Anti-frustration**: a competition is resumable, a match is abandonable (recorded as a forfeit,
  never silently dropped), and the tournament state survives a browser refresh via the ledger.

**Files:** `boot.js`, `competition.js`, `overlays.js` (game-over integration), `hud.js` (a fixture
chip), `competitionLedger.js`.
**Tests:** result-capture from a terminal state; forfeit/abandon paths; resume-from-ledger; a human
row never claims `seatSwapped: true`.
**Risk, named:** this is where scope creep lives. Ship *one* human-inclusive format first — **Gauntlet**
(you vs the field) is the smallest complete one and the most natural "how good am I" answer. Swiss and
knockout with a human in the field follow only once Gauntlet is played and liked.

### Phase 5 — Spectate, replay, season *(M)*

- **Watch any AI-vs-AI pairing live.** Observer Mode already does 90% of this: `input.js` fully
  delegates mouse/wheel/keyboard to `observer.js` whenever `game.observerMode` is set (input.js:342,
  364, 381, 412, 433, 696, 799), and `observedState()` already falls back to `game.state`. The only
  thing standing in the way is `enterObserverMode()`'s `if (!game.galaxy …) return` gate
  (`observer.js:73`) — Observer Mode is Odyssey-only today. Generalising it to a skirmish is a small
  change that reuses the entire camera/delegation path, and it's what makes "watch the final" work.
- **Speed control** for spectated matches (2× / 4× / 8×) via the loop's `hz` — bounded by
  `MAX_SUBSTEPS`, so it degrades to slow-motion rather than spiralling.
- **Replay a finished AI match** from its seed + entrant configs, since a competition is deterministic
  (D6). Costs nothing extra — the seed is already in the ledger.
- **Season**: reset or decay ratings on a schedule, archive the old table, hand out an award line.

**Files:** `observer.js`, `boot.js`, `input.js` (spectator guard), `competition.js`, `style.css`.
**Tests:** observer entry works without a galaxy; a spectated match issues no player orders; a replay
of a recorded match reproduces its recorded winner and score margin exactly.

---

## 5. Traps specific to this codebase

Collected so the implementation doesn't rediscover them one at a time. The first four have already bitten
someone here.

- **`tools/selfplay.js:197` breaks any browser import.** Phase 0 exists solely for this. Don't
  discover it at the end of Phase 1.
- **The seat edge is real and one-directional.** The `"ai"` seat sees the `"player"` seat's mutations
  on ~13% of think cycles. Side-swap corrects it for AI-vs-AI; nothing corrects it for a human. Any
  claim that a human rating is directly comparable to an AI rating is wrong by exactly that amount.
- **Never blend difficulty brackets** (D2) — for win-rates *or* ratings.
- **Any new AI-phase code must resolve everything from `owner`.** A stray `state.ai`/`state.fogAI`/
  `"ai"` literal on a path that can run for owner `"player"` is exactly how the two documented
  self-play bugs happened, and it still passes `npm test` because the shipped game only ever exercises
  owner `"ai"`.
- **Engine purity is enforced by test.** No `Date.now`/`Math.random` under `engine/`. Ledger
  timestamps are UI-layer and get injected, never read inside a pure module.
- **Every `getElementById` target must exist in `index.html`** (`test/static-integrity.test.js`) —
  each new panel needs its element declared.
- **No build step.** Module Worker, plain ES modules, inlined nothing. `tools/serve.js` already serves
  the right MIME type.
- **Elo is order-dependent.** Without D6's canonical ordering, a re-run of the same competition
  produces a different table and the whole thing becomes untestable.
- **Both candidates in one duel share one live overrides table.** `assertNoOverrideCollision` exists
  because merged patches make both seats play a row belonging to neither — a mirror match that still
  reports a winner from seat/seed noise alone. Any in-game roster that grows custom dials inherits that
  hazard.
- **Neighbour worlds pick their strategy at random** (`neighbourAiProfile`, `engine/galaxy.js`), so
  changing the `STRATEGIES` table for competition purposes changes roughly a quarter of the Odyssey
  galaxy too.

---

## 6. Deferred, with reasons

- **Glicko-2 / rating deviation** — the principled version of D7's provisional flag. Worth doing once
  there's real data on how noisy these ratings actually are; premature before that.
- **Cross-device / online ladders** — the game has no backend and no runtime dependencies. JSON
  export/import (D8) covers sharing without breaking that.
- **Human seated as owner `"ai"`** — a renderer/HUD/input rewrite (D4), not a competition feature.
- **Rating-affecting handicaps** — invalidates the pool; use difficulty brackets instead.
- **Tuning `WEIGHTS`-style objective scoring into the competition** — `tools/ailab.js`'s `score()`
  measures an *Odyssey development curve* and its components need `state.diplomacy`, absent from every
  skirmish state. `duel` already refuses to use it for exactly this reason and reads
  `engine/victory.js`'s `playerScore` instead. Competitions must do the same.
- **N > 2 entrants in a single match (free-for-all).** `state.owners` is genuinely owner-generic and
  `checkWinCondition` already reads for N sides — but map generation seeds exactly two bases
  (`map.bases`), so this is a map-generation project, not a competition one.

---

## 7. Suggested sequence

**Phase 0 → 1** is the smallest thing worth shipping: a player can pit two AI configurations against
each other and see who wins, with a rating that means the same thing the tuning bench means.

**Phase 2** is what makes it stick — without a persistent roster and ladder, every competition is
disposable.

**Phase 3 and Phase 4 are independent** and can run in either order or in parallel; they touch
different files (`pairing.js`/worker vs `boot.js`/game-over). If only one gets built, **Phase 4 is the
one the request is actually about** — a Gauntlet against the field, with your own Elo, is the feature.
Phase 3 is the depth behind it.

**Phase 5 is polish**, but "watch the final" is the cheapest spectacle in this entire plan, because
Observer Mode is one `if` away from already supporting it.
