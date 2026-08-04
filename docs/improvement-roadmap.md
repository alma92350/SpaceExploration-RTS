# Improvement Roadmap — Sequencing the Proposal Catalog

*Answers "where do we start" for the 71 proposals in [docs/improvement-proposals.md](./improvement-proposals.md). That
catalog already ranks impact-per-effort (its own shortlist) and flags its own conflicts (its review
section: 7 duplicate pairs, 6 collisions, a Gate-monoculture warning). This plan resolves those once,
in a dependency-ordered sequence, so nobody re-litigates them mid-implementation. Every one of the 71
proposals is accounted for below — scheduled into a phase, merged into a workstream, or explicitly
deferred to the backlog with a reason.*

## TL;DR

Start with **Phase 1**. It's the shortlist's T1-legibility half: all S/M effort, zero cross-dependencies,
mostly additive event fields and view-layer reads. The first PR should be **counter-triangle
readability** — the catalog's own #1 pick, and it needs no design decision first.

Run **Phase 2** (AI counter-intelligence) at the same time if you have the bandwidth — disjoint files,
no shared risk. The one hard gate in this whole plan: **Phase 4 (new static defense) cannot start until
Phase 2 lands.** Every other phase boundary below is a soft grouping by file-locality and theme, not a
hard blocker — parallelize freely once you're past Phase 2.

## Decisions this plan makes

The catalog's review section flags 6 unresolved collisions. Building any affected proposal means
picking a side first — here's the call, made once, so implementation doesn't stall on it:

| Collision | Decision | Why |
|---|---|---|
| Survey probes (paid intel) vs. Starmap dossiers (free intel) | **Dossiers win; probes dropped from this plan.** | The catalog's own shortlist already picked dossiers over probes. Free intel also matches the game's established "charted worlds" doctrine (fog.js's own header), and probes would sell almost nothing once dossiers ship free. |
| Tripling static defense (Bastille, Aegis Bastion, Torpedo Battery) vs. "the AI can't break a turret wall" | **AI counter-intelligence (Phase 2) ships first.** The new defense tier lands as one rationalized batch in Phase 4, never piecemeal. | test/balance.test.js already proves a 4-turret line stops same-cost armies cold. Shipping more static defense before the AI can answer it makes turtling strictly worse, not better. |
| Easy strategic ceiling vs. Rival Gate | **Not a real conflict — sequence, don't choose.** Ship the ceiling in the same phase as Rival Gate. | Rival Gate's own spec already gates on Hard difficulty or `wantsDeepIndustry`, so it excludes Easy neighbours by construction. They just need to land in the same phase so nobody builds Rival Gate against an still-ungated `aiIndustry.js` climb. |
| Domination with teeth vs. Faction memory | **Ship together as one stance-pipeline change.** | Both rewrite the same `checkDomination`/stance code. Tuning them in separate PRs risks a conquest-cost number nobody actually chose on purpose. |
| Three independent proposals all patching `counterToPlayerArmy` | **One PR, not three.** Verified directly: `counterToPlayerArmy` (engine/aiMilitary.js:386) is a single ~12-line function all three would edit. | Three independent diffs to the same dozen lines is a guaranteed collision, and the fixes compose naturally into one soft-answer table anyway. |
| Real LOS pass vs. fog-render perf batching | **LOS pass first.** | The perf proposal explicitly bakes in today's radius-flood fog-cell model. Batch it first and the LOS pass has to re-derive the batching. |

The catalog also warns that **8 of its 15 Strategic-tier proposals orbit the Antimatter Gate** and
explicitly says that cluster "needs a curated subset more than any tier needs more proposals." This
plan takes that literally: Phase 7 ships a curated 3-workstream slice (Rival Gate, the cheap half of
Gate-charge visibility, Domination+Faction memory) and defers the rest — Gate network, the galaxy-scale
finale, surge/trickle feed, Gate-craft research, and the Gate's map art — to the backlog until the
curated slice has shipped and been played.

## Phase 1 — Foundations: T1 legibility (start here)

Legibility fixes for rules the game already has — nothing here is a new mechanic. All S/M effort, no
pending design decisions, minimal engine risk. **No dependencies on the rest of this plan — start
immediately.**

| Workstream | Source proposal(s) | Effort | Files |
|---|---|---|---|
| **Counter-triangle readability — build this one first** | "Counter-triangle telegraphs" (Combat) + "Surface the counter-triangle on unit buttons" (UX), merged per the catalog | S | engine/combat.js, effects.js, renderEffects.js, hudSelection.js |
| Per-weapon fire signatures | Presentation | S | renderEffects.js |
| Gatherers roll to next seam on depletion | Economy | M | engine/gather.js |
| Node saturation visible on map/panel | Economy | S | render.js, hudSelection.js |
| Let the player choose/reroll starting world | Odyssey | S | engine/galaxy.js, setup.js, boot.js |
| Starmap world dossiers *(wins the intel collision above)* | Worlds | S | starmap.js |
| Reactive opening checklist | UX | M | overlays.js, hud.js |
| Make Bulwark's structure shielding official | Defense | S | engine/entities.js, README.md, tests only |
| Doctrine research develops over time | Tech | M | engine/techtree.js, engine/production.js |
| Pick your side of asymmetric matchups (Oort, Nimbus) | Worlds | M | engine/map.js, setup.js |
| Patrol: looping attack-move waypoints | Combat | M | engine/commands.js, engine/sim.js |
| Make the clock endgame visible, honest, configurable | Cross-tier / Defense | M | engine/victory.js, hud.js, overlays.js, setup.js |
| Give the Leviathan a real capital-ship hull | Presentation | S | renderUnits.js |
| Full-roster render smoke test *(land with, or just before, the Leviathan fix — it's built to catch exactly that bug)* | Cross-tier / Presentation | S | new test file |

## Phase 2 — AI counter-intelligence unification (run in parallel with Phase 1)

Everything touching `counterToPlayerArmy`/`COUNTER_OF`, the AI-adjacent correctness fixes near it, and
the bench tooling to measure the result. Disjoint from Phase 1's files, so a second
engineer/session can run this concurrently.

| Workstream | Source proposal(s) | Effort | Files |
|---|---|---|---|
| Bench tooling first: tech sparring bot + real-APM runs | Cross-tier / AI | M | tools/ailab.js |
| **Counter-intelligence rework** — out-of-triangle counters + soft-answer fallback + turret-wall reading, one PR | Combat "out-of-triangle" + AI "soft-answer fallback" + Defense "read a turret wall", merged | M | engine/aiMilitary.js, engine/entities.js |
| Difficulty-shaped counter-picking cadence | AI | S | engine/aiDifficulty.js, engine/aiMilitary.js |
| Graduation reaches the army (Rusher techs the Foundry) | AI | M | engine/aiWorkers.js, engine/aiIndustry.js, engine/aiEconomy.js |
| Measure the Helium Bomb blast to the target's rim | Defense | S | engine/bomb.js, engine/aiSuperweapon.js |
| The Helium Bomb travels with the wave | AI | S | engine/aiSuperweapon.js |

**Hard gate: nothing in Phase 4 starts until the counter-intelligence rework lands and
test/balance.test.js is re-verified green.**

## Phase 3 — T2 systems maturity

Independent of Phases 1/2/4 — schedule whenever bandwidth opens. Grouped here because these mature the
same tier (Foundry gate, first factories, power grid) and share file neighborhoods.

| Workstream | Source | Effort | Files |
|---|---|---|---|
| Range-layered formation ranks | Combat | M | engine/commands.js, engine/formation.js |
| Grid Substation | Tech/Industry | M | engine/entities.js, engine/industry.js |
| Per-building logistics priority | Economy | M | engine/commands.js, engine/haul.js |
| Bulk trading UI + glut/pressure readout | Economy | S | engine/market.js, hudSelection.js |
| Scope Heavy Alloys to the factories it names | Tech | S | engine/techtree.js, engine/industry.js |
| Foundry/Arsenal standing bonuses | Tech | M | engine/entities.js, engine/production.js |
| Gifts and favor requests: a road to Allied | Odyssey | M | engine/diplomacy.js, engine/market.js |
| Frontier belts on bigger maps | Worlds | M | engine/map.js |
| High ground extends weapon acquisition | Worlds | S | engine/combat.js |
| Attack pings on minimap + jump-to-last-alert | UX | M | effects.js, minimap.js, input.js |
| Space cycles bases + idle-production chip | UX | M | input.js, hud.js |
| **Tech & Industry Chart overlay** — flagship of this phase | UX | L | new techChart.js |
| Selection subtraction + map-wide select-all | UX | S | input.js |
| The landing picker charts terrain from orbit | Worlds | S | landingPicker.js |
| Cancelable research queue with refunds | Tech | S | engine/techtree.js |
| Bespoke power-plant hulls + working pulse | Presentation | M | renderBuildings.js |
| Two-generation autosave with fallback *(pulled forward from its Cross-tier slot — silent save loss is real user-facing harm, not worth deferring)* | Presentation | M | saveload.js |

## Phase 4 — Defense ladder rationalization (gated on Phase 2)

Ship as one rationalized tier, not three separate PRs — the catalog is explicit that shipping these
piecemeal, or before Phase 2, makes turtling worse, not better.

| Workstream | Source | Effort | Files |
|---|---|---|---|
| Bastille: second static-defense tier | Defense | M | engine/entities.js, hudSelection.js, engine/aiEconomy.js |
| Arsenal-gated Aegis Bastion | Defense | M | engine/entities.js, engine/sim.js |
| Plasma Torpedo Battery | Combat | L | engine/entities.js, engine/haul.js, engine/combat.js |
| Colossus splash: area damage | Combat | M | engine/combat.js |

## Phase 5 — Doctrine depth redesign

| Workstream | Source | Effort | Files |
|---|---|---|---|
| Doctrine Tier-2 verb (Assault drive, Bulwark regen) + Tier-3 capstones, merged into one redesign | Combat + Tech | M | engine/entities.js, engine/combat.js, engine/sim.js |

## Phase 6 — Multi-world colony economy rework

The catalog calls Freight Lanes and Colony Standing Orders "two halves of a single colony-economy
rework" — design them together even if the implementation ships in stages. Largest single workstream in
this plan.

| Workstream | Source | Effort | Files |
|---|---|---|---|
| Colony economy rework (Freight Lanes + Colony standing orders, merged) | Economy + Odyssey | L | engine/galaxy.js, new engine/colonyPolicy.js, engine/persist.js |
| Promote the legacy consumer-goods recipes *(supersedes the narrower Luxury-export proposal — this is its superset)* | Tech | L | engine/techtree.js, engine/entities.js |
| Spaceport tiers discount jump fuel | Odyssey | S | engine/galaxy.js |
| Starmap live colony ledger + alert badges | UX | M | boot.js, starmap.js |

## Phase 7 — Endgame stakes (curated Gate subset)

Deliberately not all 8 Gate-adjacent proposals — see the monoculture decision above.

| Workstream | Source | Effort | Files |
|---|---|---|---|
| Easy strategic ceiling *(land first in this phase)* | AI | S | engine/aiDifficulty.js, engine/aiIndustry.js |
| Rival Gate (Defense + AI twins, merged) | Defense + AI | L | engine/wonder.js, engine/aiIndustry.js, engine/galaxy.js |
| Domination with teeth + Faction memory, tuned as one system | Defense + Odyssey | M | engine/galaxy.js, engine/diplomacy.js |
| Persistent Gate charge strip *(cheap half of the charge-visibility merge — the expensive map-art half is deferred below)* | UX | S | hud.js |

## Phase 8 — Cross-tier polish, perf & safety nets

No dependencies on Phases 3–7; slot in anytime. The one internal ordering: LOS before fog-perf.

| Workstream | Source | Effort | Files |
|---|---|---|---|
| Real LOS pass *(must land first)* | Worlds | L | engine/fog.js, engine/combat.js |
| Stop per-cell fog/terrain fills *(after LOS)* | Presentation | M | render.js |
| Veterancy ranks | Combat | M | engine/combat.js, renderUnits.js |
| Commodity flow ledger | Economy | M | hud.js |
| Tiered destruction (deaths scale with what died) | Presentation | M | engine/combat.js, boot.js, effects.js, sound.js |

## Backlog — deferred by design, not forgotten

**Deferred from the Gate cluster** (revisit only after Phase 7 has shipped and been played — building
all 8 at once is the exact monoculture the catalog warns against):
- Gate network (an online Gate changes jump economics)
- Galaxy-scale finale (faction expeditions answer a charging Gate)
- Surge/trickle feed modes + the exclusive Gate-craft research pair (bundle these two — same design space, per the catalog)
- Monumental Gate / Star Dock map art (the charge *strip* ships in Phase 7; this is the expensive art half)

**Rejected by the intel-doctrine decision above:**
- Survey probes (superseded by free starmap dossiers)

**Large, standalone, no urgency — schedule opportunistically:**
- Deep-space worlds as an endgame frontier (better after Phase 6's colony rework gives new worlds something to plug into)

**Unclaimed territory** (the catalog's own completeness critic found these gaps; none has a proposal
write-up yet, so none is effort/impact-graded — scope one before scheduling):
- Scenario/mission mode has no owner (no 3rd scenario, no tuning pass, no Odyssey bridge)
- Replay and spectating (same-seed determinism makes this nearly free, per the catalog)
- Post-match debrief / score-over-time summary
- Accessibility (colorblind-safe owner colors, rebindable keys, UI scale)
- Audio as a system (alert hierarchy, ambient/tension layer, stereo pan)
- Modding-by-data / exposing the map seed for reroll-and-share
- The Odyssey's own midgame (first-jump-to-second-world transition is a starved cell)
- Movement feel through terrain (no pathfinding — terrain reads as a flat speed tax, not routing)

## Process notes for whoever implements

- **TDD per CONTRIBUTING.md.** Write the failing test from the requirement before the implementation,
  for every workstream above — this codebase enforces determinism/purity/static-integrity structurally,
  not just by convention.
- **One workstream per shared function.** Where this plan merges proposals (Phase 1's triangle
  readability, Phase 2's counter-intelligence, Phase 5's doctrine redesign, Phase 6's colony rework),
  land them as a single PR — that's the point of merging them, not a documentation nicety.
- **Determinism.** Every workstream above already sits behind test/determinism.test.js or
  test/determinism-roster.test.js. None of it needs a new randomness source — reuse `hashStr`/`mulberry32`
  before reaching for anything else.
- **Additive saves.** Most workstreams are additive fields (no `SAVE_VERSION` bump needed). The
  large ones with genuinely new persisted structures — colony policy, lanes, rival-gate state — need an
  explicit `sanitizeSave`/`cleanEntity` review, per CONTRIBUTING.md's rule.
