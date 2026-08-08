# Code review — Stellar Frontier: RTS

**Date:** 2026-08-07 · **Commit:** `56d13d7` · **Reviewer:** external, architecture + TDD focus

> **Status: all nine findings are closed.** Eight were fixed on this branch; one (#7) was
> **withdrawn as wrong** — see its section for what I got wrong and why. The suite is at **2502
> passing**, `npm run typecheck` is clean on TypeScript 5.7 and 7, and CI is green.
>
> | # | Finding | Outcome |
> |---|---|---|
> | 1 | CI red for two days, merged through twice | Fixed — both signatures corrected |
> | 2 | Unpinned TypeScript in CI | Fixed — pinned to 5.7.2 |
> | 3 | Adaptive AI forgets in ~60s, not 240s | Fixed — fade derived at read, per-channel clocks |
> | 4 | Tests drive accumulating state at a cadence production never uses | Fixed — `advanceThinkCycles` on an engine-owned constant |
> | 5 | Type-contract guard cannot fail on what broke CI | Fixed — inline-typedef parser, competition shapes covered |
> | 6 | Two 780+ line functions | Fixed — 871→309 and 785→562, plus a new module |
> | 7 | "15 unguarded UI import cycles" | **Withdrawn — the finding was wrong** |
> | 8 | `tools/` ships to the browser, outside the purity guard | Fixed — scan roots derived from `index.html` |
> | 9 | Release cadence stalled, deprecated CI actions | Fixed — 1.1.0 cut, actions bumped, smoke test run |
>
> Two things I flagged as needing a human are also done. The **browser smoke test**
> (`CONTRIBUTING.md` release step 2) was run against real Chromium: the game boots with zero
> uncaught errors, and drag-select, right-click commands and the rebuilt selection panel all work
> — which is the validation finding 6's refactor actually needed, since no headless test clicks
> anything. The only console error is the browser's automatic `/favicon.ico` request, which the
> page declares none for; cosmetic, and left alone rather than adding a binary asset unasked.
>
> **Branch protection on `main` still needs you.** It is a repository setting I cannot change, and
> without it finding 1 recurs the next time a check goes red. Tagging `v1.1.0` and deploying are
> yours too — the version files and changelog are prepared, but I have not tagged or published.
>
> Everything below is the review as written against `56d13d7`, left unedited apart from #7's
> correction.

**Baseline measured, not assumed:**

| Check | Result |
|---|---|
| `npm test` | **2494 pass, 0 fail** (271 s) |
| `npm run typecheck` | **FAILS — exit 1**, 21 errors (TypeScript 7.0.2) / 2 errors (TypeScript 5.7) |
| GitHub Actions | **Red since 2026-08-05.** Last green run `2026-08-05T17:02Z` |
| Source / test size | 36,499 src lines · 40,356 test lines |
| Dead exports | 1 (`sound.js:getVolume`) |
| `engine/` import cycles | 0 |
| UI import cycles | 15 |

---

## Verdict

The simulation core is genuinely good work — better than most game codebases this size. `engine/` is
acyclic, purity and determinism are enforced by tests that test *themselves*, and the comments
explain *why*. That is real engineering.

The problems are all on the outside of that core: **the quality gates are red and being merged
through**, the type contract is enforced by a test that cannot fail on the thing that is broken,
and the newest feature — the adaptive AI, ~3,000 lines across two PRs — **does not do what it says
it does once you break line of sight**, because the test written for it drives the code at a cadence
the game never uses. (I first wrote that more sweepingly; see #3 for the measurement that narrowed
it.)

No sugar coating: you have excellent discipline pointed at the wrong 20% of the surface. The engine
is over-guarded relative to its risk. The release pipeline, the type layer, and the newest AI logic
are under-guarded relative to theirs.

---

## 1. CI has been red for two days and two PRs merged straight through it — BLOCKER

**What.** `npm run typecheck` exits 1. Both matrix jobs (Node 20, Node 22) fail at the
*Type-check the annotated files* step. PR #90 and PR #91 both merged to `main` on a red build. The
failing file is `competitionLedger.js`:

- `competitionLedger.js:295` — `addRosterEntry`'s `@param` declares
  `{ name, strategy?, archetype?, faction?, createdAt?, human? }`, but the body reads and writes
  `entry.genome`. The field was added to the runtime shape and never to the type.
- `competitionLedger.js:363–426` — `recordCompetition`'s `@param` types `rows` as `object[]`. The
  body reads `r.aName`, `r.bName`, `r.winner`, `row.margin`. TypeScript 7 rejects property access on
  bare `object`; TypeScript 5 did not.

Neither is a runtime bug. The code works. But `CONTRIBUTING.md` names `npm run typecheck` as release
gate #1, and it has been failing for every commit since 2026-08-05.

**So what.** A red build that everyone merges through stops being a signal. Right now nothing in
this repo can tell you whether a *new* break is your fault — the answer is always "it was already
red". That is how the next real defect ships. The specific irony: the `genome` gap is precisely the
"field renamed or added without updating the typedef" failure that `CONTRIBUTING.md` says the type
layer exists to catch. The layer caught it. Nobody was listening.

**Now what.**
1. Fix both signatures. Add `genome?: object` to `addRosterEntry`'s param. Give `recordCompetition`
   a real `MatchRow`-shaped param instead of `object[]` (or define the typedef in `engine/types.js`
   and reference it).
2. Turn on branch protection so `main` cannot take a merge on a red check. Until that exists, every
   other item in this report is optional and this one is not.

---

## 2. CI installs an unpinned TypeScript — BLOCKER

**What.** `.github/workflows/test.yml` runs `npx --yes --package typescript -- tsc -p jsconfig.json`.
No version. That resolves to whatever is newest on the registry that morning. TypeScript 7.0.2 is
what runs today, and it turns the same source into 21 errors where TypeScript 5.7 reports 2.

**So what.** The build is not reproducible. A green commit can go red overnight with no code change,
and you cannot tell a real regression from a compiler upgrade. This is also how item #1 got worse
without anyone touching `competitionLedger.js` — the compiler moved, not the code. The comment above
that line carefully explains why TypeScript stays out of `package.json`, and that reasoning is
sound; the mistake is that "not a dependency" was allowed to mean "not a version".

**Now what.** Pin it: `npx --yes --package typescript@5.7.2 -- tsc -p jsconfig.json`. Keep it out of
`package.json` exactly as the comment argues — pinning the invocation costs you nothing and buys a
reproducible gate. Bump the pin deliberately, as its own commit, so a compiler upgrade is reviewable.

---

## 3. The adaptive AI forgets the enemy in ~60 seconds, not the 4 minutes it documents — HIGH

**What.** `engine/aiIntel.js:135` fades the stored belief and writes the faded value back, then
recomputes the fade next cycle from the *same* `intelAt` stamp and applies it to the
already-faded number. The decay compounds. The comment on line 130 says:

> Linear fade rather than an exponential one: subtraction and division only … "how stale is this"
> stays something a reader can do in their head.

It is neither linear nor exponential — it is a product of `(1 - age/240)` over every think cycle, so
the real decay rate depends on **how often the function is called**. `engine/ai.js:81` calls it
every `THINK_INTERVAL = 1.5` sim-seconds. Driving the real module at the real cadence:

| Sim seconds since last sighting | Documented (linear) | Actual |
|---:|---:|---:|
| 15 | 93.75 | 70.36 |
| 30 | 87.50 | 25.35 |
| 60 | 75.00 | **0.36** |
| 120 | 50.00 | 0.00 |

The belief is gone after one minute. Confidence collapses faster still, because
`readEnemy` multiplies the already-compounded total by a *second*, independent freshness term
(`aiIntel.js:157,162`) — the decay is applied twice.

**So what.** This breaks the headline promise of the feature and of `docs/ai-adaptive-opponent.md`.
The module header says "an army stepping out of vision for a fight doesn't erase itself." It does.

**Measured, after the fact — and this corrects an overstatement in my first draft.** I originally
wrote that the adaptive layer was "effectively inert" and that `adaptDefenceMult` returned 1.0. That
is wrong as a general claim. I checked by running a full 4-minute skirmish against both the old and
new code, and the two are **identical**: same peak confidence (0.60), same `adaptMode` swing
(0.50 → 0.34), same defence multiplier (0.808). While the AI keeps eyes on you, `live` refreshes the
belief every cycle and the compounding decay never gets a chance to bite.

The bug bites in exactly one situation — after vision is *lost*. Scouting an 8-Lancer army (1200
ore), then killing the scout:

| Time since the scout died | Remembered (old) | Remembered (fixed) | Old: still informed? |
|---|---:|---:|---|
| 30 s | 304 | 1050 | yes (barely — 0.296) |
| 60 s | 4 | 900 | **no — blind, hedges** |
| 120 s | 0 | 600 | **no — blind, hedges** |

So the correct statement is narrower than my first one, and still serious: the feature works while
you are visible, and collapses in under a minute once you are not — which is precisely the case it
was built for and the only case where a *belief* differs from a *look*. Killing the scout doesn't
degrade the AI's picture, it deletes it.

One knock-on I flagged and should also qualify: I suggested the MAP-Elites cast in
`tools/candidates/cast/` "may be tuned against noise". Given the above, that is likely overstated —
bench duels keep the two bases in contact for much of a match, so the signal was mostly present. A
re-run is still worth doing (the adaptation dials `punishPosture`, `punishConfidence`,
`adaptBandMult`, `adaptRateMult`, `defenceSwingMult` were searched against a fade that behaved
differently after vision loss), but treat it as a refresh rather than as invalidating the archive.

**Now what.**
1. Decide which the design wants and make the code say it. Cleanest fix: keep a `intelPeakMil` /
   `intelPeakEco` high-water pair that is only ever *raised* by a sighting, and compute the faded
   value at read time from `intelAt` — never write the faded number back. That makes the fade
   genuinely linear, cadence-independent, and matches every word of the existing comments.
2. Remove the double decay: either `readEnemy` applies freshness, or the stored value carries it.
   Not both.
3. Re-run the MAP-Elites cast afterwards as a refresh — see the measured correction above for why
   this is housekeeping rather than a rebuild.

Red test proving it (drop into `test/aiIntel.test.js`):

```js
test("the belief fades linearly over INTEL_FADE, whatever the think-cycle rate", () => {
  const s = { time: 0, units: new Map(), buildings: new Map(), fogs: { ai: null },
              ai: { intelMil: 100, intelEco: 0, intelAt: 0, adaptMode: null },
              playerAi: null, players: {} };
  while (s.time < INTEL_FADE / 2) { s.time += 1.5; updateIntel(s, "ai"); }  // ai.js THINK_INTERVAL
  const mil = readEnemy(s, "ai").mil;
  assert.ok(Math.abs(mil - 50) < 5, `half the window should leave ~50, got ${mil.toFixed(4)}`);
});
```

Currently fails with `got 0.0000`.

---

## 4. The test for #3 drives the code at a cadence production never uses — HIGH (TDD)

**What.** `test/aiIntel.test.js:179` is the test that owns this behaviour. It jumps
`s.time` in one hop (`0` → `INTEL_FADE * 0.5` → `INTEL_FADE * 3`) and calls `updateIntel` **once**
per hop. A single call *is* linear, so the test passes. The bug only exists across repeated calls —
which is the only way the game ever calls it.

Its assertions are directional, not numeric:

```js
assert.ok(faded > 0 && faded < grown, `time must fade the belief (${grown} -> ${faded})`);
```

Any decay curve at all satisfies that. A value 200× too small passes.

**So what.** This is the most expensive class of test gap you have, because it is invisible: the
feature has 441 lines of new tests, they are well-written, they read as thorough, and they cannot
fail on the defect. Two things went wrong together — the test *stepped time* where production
*accumulates* it, and it asserted a *direction* where the docs specify a *number*. Either alone
would probably have caught this.

**Now what.**
1. For any function that accumulates state across calls, the test must call it the way the caller
   does — in a loop, at the production interval. Consider a shared `advance(state, seconds)` helper
   in `test/_helpers.js` that ticks at `THINK_INTERVAL` so this is the path of least resistance.
2. Where a doc comment states a number (240 s, half at 120 s), assert the number. Directional
   assertions are right for emergent outcomes, wrong for specified curves.
3. Worth a sweep: 959 of your assertions are `assert.ok(a > b)`-shaped. Most are legitimate for a
   simulation. The ones guarding a *documented constant* are not.

---

## 5. The type-contract test checks that annotations exist, not that they are correct — MEDIUM (TDD)

**What.** `test/types-contract.test.js` does two things. It compares constructed keys against
declared `@property` lines for **five** factories (`State`, `AiState`, `Diplomacy`, `Galaxy`,
`GalaxySettings`). And it asserts every exported function in a `// @ts-check` file has *some*
`@param`/`@returns`:

```js
if (!/@(param|returns)\s*\{/.test(doc)) bare.push(...)
```

`addRosterEntry` has a `@param`. It is wrong. The test passes. `RosterEntry`, `CompetitionLedger`
and `MatchRow` are not in the five covered shapes, and `tsc` never runs inside `npm test`.

**So what.** The guard measures annotation *density* and calls it type safety. That is a proxy, and
this is the failure the proxy permits: a present-but-incomplete signature on an uncovered shape,
which is exactly the CI break in #1. The only check that would have caught it lives outside the
suite, in CI, which is red and ignored. The test file's own header is eloquent about drift being
invisible — and then leaves a hole the same size.

**Now what.**
1. Add `npm run typecheck` to the local loop, or add a suite test that shells out to `tsc` and
   asserts exit 0. A gate developers only see in CI is a gate developers do not see.
2. Extend the factory table to the competition shapes — `RosterEntry`, `CompetitionLedger`,
   `MatchRow`. They are user-facing persisted data and deserve it more than `GalaxySettings`.

---

## 6. Two functions are over 780 lines — MEDIUM

**What.** Measured by brace depth, not heuristics:

- `hudSelection.js:946` — `rebuildSelectionPanel()`, **871 lines**
- `input.js:38` — `attachInput()`, **785 lines**

For scale, the next largest in the repo is `hud.js:renderHUD()` at 214.

**So what.** These are the two places a contributor is most likely to need to change and least able
to change safely. `attachInput()` in particular closes over the entire input state in one scope, so
there is no seam to test a single interaction against. Note the team is already aware of the first —
`hudPanelSignature.js`'s header calls out "800 lines of button construction" by name, and
`docs/code-improvement-tiers.md` files the fix under Tier 3. It has not been scheduled, and it grew.

**Now what.** Do not rewrite either. Split by panel family, one at a time, behind the existing
`panelSignature` seam — that seam was built for exactly this and is the reason this is a move rather
than a rewrite. One family per PR, suite green each time. `attachInput()` splits along the same
line: one module per input mode (selection, camera, build placement, hotkeys).

---

## 7. Import discipline stops at the engine boundary — ~~MEDIUM~~ **WITHDRAWN**

**This finding was wrong, and the error is worth recording.** I reported "15 UI import cycles,
unguarded". Both halves are misleading.

The 15 is an artifact of how I counted: my detector enumerated distinct *simple cycles*, and a
single strongly-connected cluster of 7 modules contains many. There is **one** cycle here —
`boot.js`, `competition.js`, `hud.js`, `hudSelection.js`, `overlays.js`, `saveload.js`, `setup.js` —
not fifteen.

And it is already guarded, better than I proposed. `test/static-integrity.test.js` runs **Tarjan
over the whole shipped module graph** and asserts the set of strongly-connected components equals
exactly that 7-module cluster. A new cycle anywhere — including inside `engine/` — fails the suite,
and a *seventh* member joining the known cluster failed it too until someone justified it in a
comment. That is a membership freeze, which is strictly stronger than the count ratchet I
recommended adding.

I missed it because I ran my own cycle detector instead of checking whether the suite already had
one. Lesson worth keeping: measure the codebase, then check what the tests already claim, before
concluding something is unguarded.

**What still stands** is the underlying architectural point, downgraded to a remark: the cluster is
real, it makes `competition.js` un-importable in a test without dragging in `boot.js`, and its
safety rests on an invariant enforced by prose ("every back-edge is called at runtime, not at
module-evaluation time" — `overlays.js`) rather than by a check. Breaking it is still worthwhile,
just not urgent, and the existing guard will hold the line meanwhile.

---

## 8. `tools/` ships to the browser but sits outside the purity and determinism guards — MEDIUM

**What.** Four shipped modules import from `tools/`:

```
boot.js              → tools/selfplay.js
competition.js       → tools/duelCore.js, tools/genome.js
competitionWorker.js → tools/duelCore.js, tools/genome.js
playerFingerprint.js → tools/genome.js
```

`test/engine-purity.test.js` walks `engine/` and follows relative imports *out* of it. Nothing in
`engine/` imports `tools/`, so `tools/` is never scanned. Meanwhile
`test/static-integrity.test.js:24` still asserts the opposite in prose:

> The subset the BROWSER loads: shipped code minus tools/, which are Node CLI benches
> (tools/ailab.js, tools/selfplay.js, tools/serve.js) that index.html never reaches.

That was true when written. It is not true now.

**So what.** `tools/duelCore.js` and `tools/genome.js` run inside the competition Worker and decide
match outcomes that become **Elo ratings** — persisted, exported, compared across sessions. Their
determinism matters as much as the engine's. A `Math.random()` or `Date.now()` landing in either one
would silently make ratings irreproducible and no guard would say a word. They are clean today (I
checked); the point is that nothing keeps them clean. `tools/genome.js` also parses untrusted
player-authored JSON, which makes it a trust boundary sitting in a directory named "dev tooling".

**Now what.**
1. Extend the purity scan's roots to include the browser-reachable `tools/` files, or simplest and
   better: move `genome.js`, `duelCore.js` and `selfplay.js` out of `tools/` into the shipped tree
   (they have no Node-only imports — that is exactly why they were split out of `ailab.js`). Leave
   `ailab.js`, `selfplay-cli.js` and `serve.js` behind as the real benches.
2. Fix the stale comment either way.

---

## 9. Smaller remarks

**Release cadence has stalled.** `version.js`, `package.json` and `version.json` all agree on
`1.0.0` — that part is correct. But `CHANGELOG.md`'s `[Unreleased]` section now holds observer mode,
patrol orders, the counter-triangle work, doctrine research timing, Odyssey world selection, the
endgame clock, a new archetype, competitions with Elo, genome evolution and an in-app AI editor.
*So what:* the release checklist in `CONTRIBUTING.md` is thorough and unused, and a browser smoke
test (step 2) has not gated any of this. *Now what:* cut 1.1.0 once CI is green. The checklist is
good; run it.

**Documentation outweighs the thing it documents.** `docs/` is 1.3 MB — a 805 KB
`player-handbook.html` plus ~500 KB of design docs (`improvement-proposals.md` alone is 152 KB).
*So what:* design docs that large stop being read, and several already disagree with the code (see
#3, #8). *Now what:* when a doc and the code disagree, the doc is a bug. Prune the proposal backlog
to what is actually planned.

**CI runners are on deprecated Node.** `actions/checkout@v4` and `actions/setup-node@v4` are being
force-run on Node 24 with a deprecation warning. *Now what:* bump to `@v5` when convenient — no
urgency, but it will become a hard failure.

**Autosave and update timers are never cleared** (`saveload.js:354`, `update.js:107`). Correct for a
single-page app that lives as long as the tab; both are properly guarded against running under Node.
Noted only so a future reviewer does not re-flag it. No action.

---

## What is genuinely good — and should not be traded away

Stated plainly, because a review that only lists faults gives a false picture of this codebase:

- **The guard tests test themselves.** `determinism.test.js` mutates seven sim fields and requires
  the fingerprint to move; `engine-purity.test.js` asserts its own file-walk reaches `data.js`;
  `static-integrity.test.js` feeds its resolver a deliberate typo and requires a report;
  `types-contract.test.js` checks its own parser bites. Very few teams write the meta-test. It is
  the single strongest thing here.
- **Determinism coverage is real.** The roster sweep runs all 11 worlds *and fails if the fixture
  stops reaching combat* — that assertion is the difference between a sweep and theatre.
- **Comments explain why, not what,** and they carry the history of the bug they prevent. The
  `loop.js` note on why speed scales the accumulator instead of `hz` is a good example.
- **Additive save fields were handled correctly** — the new intel fields in `persist.js` default
  conservatively and correctly skip a `SAVE_VERSION` bump, exactly as `CONTRIBUTING.md` prescribes.
- **Near-zero rot:** one unreferenced export in 36k lines, no `.skip`, no `.only`, no silent
  `catch {}`.

---

## Order of work

| # | Item | Effort |
|---|---|---|
| 1 | Fix the two `competitionLedger.js` signatures; get CI green | 30 min |
| 2 | Pin the TypeScript version in CI; add branch protection | 15 min |
| 3 | Fix the `updateIntel` compounding decay; land the red test first | half day |
| 4 | Re-run the MAP-Elites cast as a refresh (see #3's correction) | rerun |
| 5 | `tsc` inside `npm test`; extend the contract table to competition shapes | half day |
| 6 | Move browser-reachable `tools/` files into the shipped tree | 1 hour |
| 7 | Cycle ratchet in `static-integrity`; cut 1.1.0 | 1 day |
| 8 | Split `rebuildSelectionPanel` / `attachInput`, one family per PR | ongoing |

Items 1 and 2 are not improvements. They are the precondition for trusting anything else here.
