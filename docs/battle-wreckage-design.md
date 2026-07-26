# Battle wreckage — brainstorm & phased design

Goal (from the request): **nothing is really destroyed**. Ships, workers, and buildings
killed in ordinary combat should leave wreckage that, after a delay, resolves into real
minable deposits roughly at the battle site — the same "explosion → consolidated mine"
shape the Helium Bomb's crater already uses. Recover **~80% of the destroyed thing's own
construction materials**, plus a chance of **denser, higher-tier byproducts** (metals,
electronics, relics) that a fight's energy can forge on top of the raw materials that
were actually spent.

**Status: Phase 1 and Phase 2 shipped** (`engine/wreckage.js`). Phase 3 (rendering/VFX
polish) is next; Phase 4 remains a follow-up-if-needed. This doc is the plan of record.

---

## 0. Decisions confirmed with the user before designing the mechanics

Three real forks were raised and settled up front, because they change the shape of the
implementation, not just its constants:

1. **Replaces the existing instant salvage, doesn't sit beside it.** Today,
   `engine/combat.js`'s `grantSalvage` refunds 25% of a **combat unit's** cost straight to
   its **owner**, instantly, with no location — and workers/buildings get nothing at all
   (`SALVAGE_FRAC`, `combat.js:164-180`). That whole mechanic is **removed** and replaced
   by the new wreckage system, which covers units, workers, and buildings uniformly. One
   consistent model, no double-dipping.
2. **A Helium Bomb blast kill also leaves wreckage.** The blast's existing "no salvage,
   this is blast damage, not a normal kill" comment (`bomb.js:130-137`) stops being true
   in the sense that mattered (there's no more instant salvage for anyone to skip) — a
   blast-killed unit/building now deposits wreckage exactly like an ordinary combat death,
   **stacking with** the bomb's own separate crater. The bomb becomes strictly more
   rewarding than before; see §6 for the balance flag this raises.
3. **Wreckage is neutral — anyone can mine it, first-come-first-served.** This matches
   every existing `ResourceNode`: nodes carry no `owner` field today, so this is the
   zero-new-structure option, not just the simplest one. Holding the ground after a fight
   is what earns the loot, not which side lost the units.

---

## 1. The existing precedent this reuses almost wholesale

The Helium Bomb (`engine/bomb.js`) already implements the exact shape this feature needs,
end to end:

- **Pending timer, not instant.** Detonation doesn't spawn a deposit on the spot — it
  pushes `{id, x, y, owner, spawnAt: state.time + CRATER_SPAWN_DELAY}` onto `state.craters`
  (`bomb.js:163-169`).
- **Per-tick maturation.** `updateCraters(state)`, called once per tick from
  `engine/sim.js` right after `state.time += dt`, matures any entry whose timer has come
  due into a **plain `ResourceNode`** pushed onto `state.map.nodes` /
  `state.map.nodesById` (`bomb.js:175-199`). Gather, fog, rendering, and the AI need zero
  special-casing — once it exists, it's indistinguishable from a map-generated deposit.
- **Deterministic, not random.** The commodity is chosen via `hashStr(id) % choices.length`
  off the entry's own stable id — no `Math.random`, no `Date.now`, so the byte-identical
  replay / `engine-purity.test.js` guarantee holds. Same technique this feature reuses.
- **Fully solved persistence.** A dynamically-spawned node isn't part of the
  seed-regenerated map, so it needs its **whole shape** saved (not just `amount`, like a
  normal node) — `persist.js:357-366` (save) and `persist.js:396-461` (load, with full
  sanitization of tampered/garbage fields). The `crater: true` tag is exactly the marker
  that tells persist.js "this one needs full treatment."
- **Auto-discovered, no re-scan needed.** New nodes are never `hidden`, so
  `isNodeDiscovered` (`fog.js:56-59`) passes immediately. The AI's idle-worker assignment
  (`aiWorkers.js:50-111`) re-scans `state.map.nodes` live every think cycle
  (`THINK_INTERVAL = 1.5` sim-seconds, `ai.js:54-69`) — a fresh wreck node gets mined
  automatically within ~1.5s of maturing, same as a crater, with **zero new AI code**.
  Caveat carried over as-is: only **idle** workers get (re)assigned — a worker already
  gathering elsewhere won't drop what it's doing to redirect toward fresher wreckage.

The one place this feature can't just copy the crater verbatim: **`ResourceNode.com` is a
single commodity string, but `UNITS`/`BUILDINGS` costs are multi-commodity dicts** (e.g.
Dreadnought `{ore: 240, radioactives: 100}`). A "consolidated mine" for a multi-commodity
wreck therefore has to mean a **small cluster of single-commodity nodes** at one site — one
node per commodity recovered — not a single node. That's also a nice fit for "consolidated"
read literally: several small deposits pooling at one place, the same silhouette a natural
multi-commodity deposit cluster already has on the map.

---

## 2. Core mechanics

### 2.1 New file: `engine/wreckage.js`

Mirrors `engine/bomb.js`'s shape:

- `state.wrecks` — the pending array (parallel to `state.craters`), declared/initialized
  in `engine/state.js` the same way.
- `depositWreckage(state, entity)` — call this from every death path (see §2.6). Reads
  `entity`'s def (`UNITS[type]` or `BUILDINGS[type]`), computes `qty * WRECK_RETURN_FRAC`
  per commodity in `def.cost`, and merges it into a nearby pending wreck site (§2.2). A
  no-cost entity (e.g. the scenario-only `freighter`, `cost: {}`) contributes nothing and
  is a no-op — no special-casing needed.
- `updateWreckage(state)` — per-tick maturation, called from `sim.js` right alongside
  `updateCraters`. Matures any due site into one `ResourceNode` per accumulated commodity,
  tagged `wreck: true` (parallel to `crater: true`).

### 2.2 Consolidation: merge-on-proximity, not a fixed grid

When an entity dies, look for an **existing pending site** within `WRECK_MERGE_RADIUS` of
the death position (proposed **140** — in the same ballpark as the longer weapon/aggro
ranges already in the roster, e.g. Breacher's 150 range, Colossus's 185, so a single
engagement's spread of kills realistically falls inside one site). If one exists, merge
into it:

- `goods[com] += qty * WRECK_RETURN_FRAC` for each commodity in the new death's cost.
- `value += sum(def.cost)` — the running, un-scaled total, used for the bonus-material
  roll (§2.4).
- Position becomes the running centroid: `x = (x*n + deadX) / (n+1)`, same for `y`;
  `n += 1`.
- `spawnAt` is **not** extended (kept simple, see §7 for the extension idea as a later
  tweak) — the first death at a site sets its maturation time; every later contribution
  within the window just adds to the pot before it matures.

If none exists within radius, open a new pending site there:
`{id: "wreck-" + entity.id, x, y, n: 1, goods, value, spawnAt: state.time + WRECK_SPAWN_DELAY}`.
The id is namespaced off the **first contributing entity's own id** — same reasoning
`bomb.js:163-165` already documents for `crater-${bomb.id}`: guaranteed never to collide
with a map-gen node's `n<N>` scheme, and stable regardless of how many more deaths merge
in later.

**Determinism note:** if a death is within radius of two existing pending sites, ties are
broken the same way `combat.js`'s `spreadEnemy` already does it — nearest first, then
lower id string wins on an exact distance tie (`combat.js:311`'s pattern). Once a site
**matures** (removed from `state.wrecks`, nodes now live in `state.map.nodes`), it's
closed — a later nearby death starts a fresh new pending site rather than reopening it,
so a contested chokepoint can accumulate several separate wreck clusters over a long
match. That's fine, same as craters never merging with each other today.

### 2.3 Base return: `WRECK_RETURN_FRAC = 0.8`

Applied uniformly to every commodity in the dead thing's `def.cost` — no special-casing
by tier. That includes Strategic-tier costs (`ai`, `antimatter`, `plasmatorp` — e.g. a
Leviathan or the Helium Bomb itself). Flagged explicitly in §6 as the single biggest
balance lever: reclaiming most of a capital ship's strategic-goods cost from its own
wreck is a real economic swing, gated only by needing workers + time + control of the
site.

`altCost` (e.g. a Worker trainable on biomass instead of ore) is intentionally ignored —
nothing on a finished unit records which cost path it was actually paid with, so wreckage
always reflects `def.cost`, the primary/default cost dict.

A building still under construction when destroyed returns 80% of its **full** `def.cost`
regardless of `buildProgress` — cost is paid up front at queue time (`production.js`'s
`canAfford`/`payCost` pair), so the materials are already spent whether or not the
building ever finished. **To verify on Day 1 of implementation**, not just assumed.

### 2.4 Denser materials: a battle-intensity bonus, not a per-kill roll

Modeled at the **site** level, not per individual death, so a real battle (many kills
consolidating into one site) has a meaningfully better shot at bonus materials than a
single skirmish casualty — matching "energy of the battles," plural, in the request.

Proposed formula (starting point, meant to be tuned in playtesting):

- `WRECK_BONUS_THRESHOLD` — a site's running `value` (§2.2) has to clear this before any
  bonus rolls at all.
- Past it, deterministically pick one commodity from `WRECK_BONUS_COMMODITIES = ["metals",
  "electronics", "relics"]` via `hashStr(site.id) % 3` — identical technique to the
  crater's own commodity roll, so it's replay-safe by construction.
- Amount: `WRECK_BONUS_FRAC * (value - WRECK_BONUS_THRESHOLD)`, capped at
  `WRECK_BONUS_CAP` so a massive battle can't mint an unbounded pile of top-tier goods.

Worth calling out plainly: `metals`/`electronics` are **Refined/Component tier** —
normally only ever produced by a Smelter/Chip Fab chain, **never** minable from the
ground anywhere else in the game. Handing some out via wreckage is a deliberate shortcut
(thematically: a wrecked hull already *is* metal, its avionics already *are*
electronics — the battle didn't refine raw ore, it just exposed what the unit was already
built from). `relics` needs no such justification — it's already Raw-tier and already in
the crater's own `CRATER_COMMODITIES` pool. Keep the bonus capped and rare enough that it
reads as flavorful salvage, not a way to skip the refining chain outright.

### 2.5 Timing: `WRECK_SPAWN_DELAY` (proposed **45** sim-seconds)

Shorter than the crater's 60s — ordinary battles are far more frequent and smaller-scale
events than a doomsday device going off, so the fight → wreckage → re-mine → re-fight
loop should feel responsive rather than glacial. Fully tunable, same as
`CRATER_SPAWN_DELAY` was.

### 2.6 Where it hooks in

Both existing death paths funnel into the same `depositWreckage` call — one source of
truth, same philosophy `bomb.js` already states outright ("every path that DOES fire the
actual blast funnels through detonateBomb() so they can never disagree"):

- `combat.js`'s `performAttack`, in the `target.hp <= 0` branch — **replacing** the
  `grantSalvage(state, target)` call (`combat.js:156`), for both units and buildings
  (`performAttack` is already generic over `target.kind`).
- `bomb.js`'s `detonateBomb`, in its kill loop (`bomb.js:151-157`) — added alongside
  `removeEntity`/the `entityKilled` event push, per decision 2 above.

Recycling (`engine/recycle.js`, a player's own voluntary teardown with its own existing
refund via `UPGRADES.recycling`) stays untouched by construction: it doesn't go through
`performAttack` or `detonateBomb`, so it never calls `depositWreckage` — self-teardown and
battle wreckage remain two separate, non-overlapping systems, as they should.

### 2.7 Node placement within a site, persistence, and rendering

- Each commodity in a matured site's `goods` becomes its own `ResourceNode`, offset from
  the site centroid by a small deterministic jitter (angle/distance derived from
  `hashStr(id + com)`, same no-engine-randomness rule) so a 2-3 commodity wreck reads as a
  believable small debris field instead of stacked identical-position nodes.
- Tag every spawned node `wreck: true`. `persist.js`'s existing crater-handling blocks
  (`:357-366` save, `:396-461` load) get generalized to a shared "dynamic node" check
  (`n.crater || n.wreck`) instead of duplicating the whole sanitize/restore block a second
  time — same logic, one flag or the other.
- Pending `state.wrecks` entries get the same save/restore treatment `state.craters`
  already has.
- Events: a new `"wreckMatured"` event (parallel to `"craterMatured"`) per matured site,
  wired into `boot.js`'s existing event → sound/toast switch the same way
  `"craterMatured"` already is.
- Rendering: tag-gated in `renderNodes.js` is enough for a first pass (reuse the existing
  rocky-deposit look); a distinct debris/scrap visual is a nice-to-have, not required for
  the mechanic to work (see Phase 3).

---

## 3. AI and determinism considerations

- **No AI-specific code needed for basic mining** — `assignIdleWorkers` already treats any
  discovered node uniformly, so the AI starts mining battlefield wreckage (its own or the
  player's) automatically, unlike the finite-storage/haulage work which needed explicit
  player-only gating for safety. This one is safe by the same construction that made
  craters safe.
- **One real assumption to watch:** `aiWorkers.js`'s `effectiveMix`/`affordableOnSurface`
  (`:113-150`) treats "which commodities exist on this planet's surface" as constant for
  the whole match — nodes drain, they don't currently appear with a brand-new commodity
  mid-game. Wreckage's **base** portion only ever returns commodities the destroyed thing
  was actually costed in, which will usually already be locally available or tradeable,
  but isn't guaranteed (a unit costed in an imported commodity foreign to this world is a
  narrow edge case). The **bonus** portion (metals/electronics) is outside this assumption
  entirely, since Refined/Component tiers never appear as natural surface deposits
  anywhere regardless of planet. Flagged as a known edge case to monitor, not solved
  upfront — an easy follow-up if it proves disruptive is gating the base return to commodities
  already in the planet's own `deposits` table.
- **Determinism throughout:** no `Math.random`/`Date.now`, only `hashStr` off stable ids —
  same rule the whole engine (and `engine-purity.test.js`) already enforces.

---

## 4. Balance impact (the real headline change)

80% recovery + neutral access means **holding the battlefield after a fight becomes a
real economic incentive**, not just a tactical nicety — today combat is close to pure
attrition (minus the old small instant self-refund this replaces). Expect:

- Armies camping their own kill sites to loot them, or racing to reach an enemy's wipe
  before the enemy's own workers do.
- The Helium Bomb (per decision 2) becomes a strictly better trade than before: it already
  makes a crater; now it also seeds ordinary wreckage from everything it kills. Worth a
  deliberate look in playtesting — if it reads as too strong, the lever is either a lower
  `WRECK_RETURN_FRAC` specifically for blast kills, or leaving it as designed and letting
  the bomb's own steep strategic-goods cost be the counterweight.
- Full 80% recovery on Strategic-tier costs (capital ships, the bomb itself) is the single
  biggest number to watch in playtesting.

Start with the proposed constants and tune, exactly like `SALVAGE_FRAC` and the logistics
buffer caps were tuned after shipping.

---

## 5. Testing

Following this repo's existing bar (`test/bomb.test.js` runs ~30 cases across every
trigger, edge, and persistence path) — a new `test/wreckage.test.js` should cover:

- A single death spawns a pending site with the correct 80%-of-cost commodities.
- Two deaths within `WRECK_MERGE_RADIUS` consolidate into one site (summed goods,
  averaged centroid); two far apart create separate sites.
- Deterministic tie-break when a death is equidistant between two pending sites.
- Maturation timing, and that a site removed from `state.wrecks` on maturation doesn't
  double-spawn.
- Bonus-material threshold/roll is deterministic (same site id ⇒ same commodity, every
  run).
- A worker can actually mine a matured wreck node (mirrors the crater's own such test).
- Full save/load round-trip for both pending sites and matured nodes, including
  tampered/malformed data (mirrors the crater tamper tests).
- A full `tick()` integration test, start to finish.

This also **requires updating existing tests** that assert the old behavior:
`test/combat.test.js`'s salvage cases ("destroying a combat unit refunds a quarter of its
cost," "workers yield no salvage") and `test/bomb.test.js`'s "entities killed by the blast
grant no salvage — a total loss" case, plus the stale doc-comments in `bomb.js` (lines
32, 130-137) that currently describe the behavior this feature deliberately changes.

---

## 6. Phased plan

**Phase 1 — Core wreckage engine. ✅ DONE.**
`engine/wreckage.js` (pending sites, merge-on-death, maturation → nodes); wired into
`combat.js`'s death branch (replacing `grantSalvage`) and `bomb.js`'s kill loop; deleted
`SALVAGE_FRAC`/`grantSalvage`; `sim.js` tick wiring; `persist.js` save/load (extended the
crater-handling blocks to also cover `wreck: true`); 19-case test suite + updates to the
formerly-salvage tests in `test/combat.test.js`/`test/bomb.test.js`. No bonus materials —
just the 80% base return per §2.3.

**Phase 2 — Denser bonus materials. ✅ DONE.**
`applyBattleBonus` (§2.4) tracks each site's running `value` (the un-scaled sum of every
contributing death's own cost) alongside its goods, and once `value` clears
`WRECK_BONUS_THRESHOLD` (300 — a lone Dreadnought's 340 already clears it, a lone Worker's
50 doesn't) it deterministically forges one commodity from `WRECK_BONUS_COMMODITIES`
(`metals`/`electronics`/`relics`) sized at `WRECK_BONUS_FRAC` (0.15) of the excess above
threshold, capped at `WRECK_BONUS_CAP` (40). `value` is persisted on a pending site so a
save/load mid-battle can't reset its bonus-eligibility progress. All four constants are
tuning knobs, same as `WRECK_RETURN_FRAC` — revisit them after playtesting.

**Phase 3 — Polish. ✅ DONE.** Wreck nodes render as jagged grey/rust debris
(`drawWreckNode`/`wreckShape`, `renderNodes.js`) instead of the warm-gold look every
natural deposit shares, branched on `n.wreck` ahead of the existing extract-type
branching. The `"wreckMatured"` event gets a sound + toast in `boot.js`, mirroring
`craterMatured`, listing every commodity the site settled into. No pending-state HUD
countdown — matches the crater's own precedent, which has none either; the toast on
maturity is the payoff callout, same as it is for a crater. Verified live (dev server +
Playwright): a synthetic wreck node next to a normal one confirmed the visual
distinction, and a fired `wreckMatured` event confirmed the toast/sound with a clean
console.

**Phase 4 — Optional follow-ups, only if playtesting calls for them:** extending
`spawnAt` on new contributions to an ongoing site ("a raging battle grows before it
settles"); gating the base return's commodities to the planet's own `deposits` table if
the AI unit-mix assumption in §3 proves disruptive in practice.

### Recommended order & risk

`Phase 1` (medium risk — touches the shared death path for every kill in the game, so it
needs the fullest test coverage before anything else lands) → `Phase 2` (low risk,
additive, isolated to `wreckage.js`) → `Phase 3` (cosmetic, no sim logic) → `Phase 4`
(only if needed). Ship and play-test Phase 1 alone first — it's the phase that changes
how every single fight in the game pays out.
