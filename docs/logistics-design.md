# Logistics overhaul — brainstorm & phased design

Goal (from the request): make **storage finite** so collection and production
buildings can fill up and stall, and make **workers haul** goods between them, so
logistics stays a live, mindful process that keeps workers relevant to the end of
the game. Plus **energy efficiency by Reactor proximity** with placement cues.

**Status:** the *energy* half is **done and merged** (see below). The *finite-storage
+ haulage* half is a core-economy reshape and is designed here for a dedicated,
phased implementation — this doc is the plan of record.

---

## 1. What's already shipped — energy grid efficiency

Energy is a per-tick **flow**, not a hauled good, so its "logistics" is a *placement*
decision — no workers needed. Implemented in `engine/industry.js`:

- `POWER_TIERS` — distance-to-nearest-Reactor bands: on-grid ×1.0 → near ×1.3 →
  far ×1.7 → isolated ×2.3 (draw multiplier).
- `powerEfficiency(state, owner, x, y)` — the tier for a spot.
- `powerDraw` scales every consumer (factory, rig, charging Gate) by its tier, so a
  remote building bleeds capacity to transmission loss and throttles the whole grid;
  clustering around a Reactor lets the same Reactors run more of it.

Visual cues mirror the Spaceport's jump radius (`render.js`): a **selected Reactor**
shows concentric efficiency zones; a **build ghost** for a power consumer shows the
nearest Reactor's zones, a connector, and the tier it would land in ("Far · draw
×1.7"); a **selected factory/rig** gains a colour-keyed "Grid: … · draws ×N" line
(`hud.js`). Pure distance math — deterministic, DOM-free, no new stored state.

---

## 2. Finite storage + haulage — the hard half

### 2.1 The core tension (why this is a real reshape, not a patch)

Today there is ONE global stockpile per side: `player.resources` (a commodity→float
map). Everything reads/writes it:

| System | Uses `player.resources` for |
| --- | --- |
| `gather.js` | workers bank hauls here |
| `industry.js` | factories draw inputs here, bank outputs here |
| `rig.js` | banks dug raws here |
| `market.js` | buy/sell price + settle against it |
| `production.js` | `canAfford` / `payCost` for units, buildings, upgrades |
| `wonder.js` | the Gate's `feed` is drawn from here |
| `ai.js` | every AI economic decision reads it |
| `hud.js` | the resource topbar shows it |

"Finite per-building storage" means goods no longer live in one global pool — they
live in **building buffers** and only become *spendable* once hauled to a Command
Center. That touches every row above. It must be phased, determinism-first, or it
breaks the byte-identical replay law and the AI at once.

### 2.2 Scope insight — who builds what

The **AI builds none of the industry chain** (no smelter/assembler/chipfab/
machineworks/reactor/plasmarig/…/torpedoworks). So **production-side** storage +
haulage is **player-only and self-contained**. The **collection-side** (Command
Center + Refinery/Foundry/Arsenal drop-offs) IS used by the AI, so finite collection
storage cascades to AI worker logic — the riskier half.

### 2.3 Forgotten aspects surfaced by the brainstorm

1. **The AI must not deadlock.** If drop-offs can fill, the AI's gather loop must
   reroute or it starves. Simplest safe rule: the AI's Command Center keeps an
   effectively huge cap (tier-scaled), so the AI never softlocks while the player
   opts into tighter forward logistics. Alternatively, exempt the AI entirely in
   phase 1 and only make the *player's* buildings finite.
2. **What is "spendable"?** Decide up front: are build/unit/upgrade costs and the
   market paid from (a) the global pool as today, fed by haulage into the CC, or
   (b) summed across all buildings? Recommendation: **(a)** — the CC pool is the
   treasury; buffers are in-transit inventory. Keeps `canAfford`/market/AI intact.
3. **Determinism.** Any "nearest full/needy building" or worker task-assignment must
   be order-independent and tie-broken deterministically (by id/hash, never by Map
   iteration + wall clock). Reuse `gather.js`'s `nearestDropoff` pattern + `hashStr`.
4. **Save/load.** New `store` / `input` buffers on buildings must be coerced in
   `persist.js cleanEntity` (COM-valid keys, ≥0, clamped to cap) exactly like
   `freight` and the rig's `digProgress`.
5. **Auto vs manual haulage.** Workers should auto-haul (RTS players won't micro
   every crate), but the player should be able to *prioritise* a building. Phase 1:
   fully automatic, nearest-worker/nearest-target, so it "just works".
6. **Idle-worker sourcing.** Haulage needs a labour pool. Reuse idle workers (no
   gather order); if none, production simply stalls — which is the intended pressure,
   not a bug. Surface it ("output full — assign a hauler").
7. **Deadlock & starvation UX.** A stalled factory (output full / input starved)
   already has a status line; extend it with the *reason* and a one-click "haul now".
8. **Balance / caps.** Buffer sizes set the rhythm. Too big → no logistics pressure;
   too small → constant micro. Start generous (minutes of runtime per buffer) and
   tune. CC cap scales with a `storeTier` (Capital upgrade → bigger treasury).
9. **Market side-effect.** If output must be hauled before it's sellable, a player
   with full rig buffers but no haulers can't sell — intended, but must read clearly
   in the HUD, not as "the market is broken".
10. **Freighters.** Interplanetary freight already exists (`unit.freight`); keep it
    orthogonal — freighters move goods *between worlds*, workers move goods *within* a
    world. Don't conflate.

### 2.4 Phased plan (each phase is its own merge, suite-green + determinism-verified)

**Phase A — Production OUTPUT buffers + auto-haulage (player-only, self-contained).**
- Add `building.store` (commodity→qty) + a `storeCap` per producing def (factory + rig).
- `updateProduction` / `updatePlasmaRig` bank output into `store`; when
  `total(store) ≥ storeCap`, **stall** (frac limited by remaining room; rig
  `digProgress` holds at the brink, like the out-of-nuclear stall).
- New worker task `haul`: an idle worker near a producer with a full-ish `store`
  picks up a load, carries it to the nearest CC, banks it into `player.resources`
  (the treasury). Deterministic target selection.
- `render.js`: a small storage bar under a producer (like the health bar); the hauler
  shows carried cargo (reuse the laden-freighter cue idea).
- `hud.js`: producer panel shows "Output NN/CAP" + stall reason.
- `persist.js`: coerce `store`.
- Tests: fills→stalls→hauled→resumes; determinism; save round-trip; AI untouched
  (it builds no producers, so its replay is byte-identical).
- **Note:** the chain still *flows* because inputs are still drawn from the global
  treasury — Phase A only gates *output*. This is the safe first slice and already
  delivers "production stops when storage is full until carried to a CC."

**Phase B — Factory INPUT buffers + input haulage.**
- Add `building.input` (commodity→qty) + `inputCap`. `updateProduction` draws inputs
  from the **local** `input` buffer, not the global pool.
- New worker task `supply`: an idle worker pulls a needed input from the treasury (or
  a producer's output buffer directly — a smelter→assembler direct line) and carries
  it to a factory's `input` buffer.
- This is where the chain becomes a real *supply network*: smelter output → hauled →
  assembler input. Bigger; do it only after Phase A is stable.
- Balance: default `inputCap` generous; a factory pre-stocks a few batches so it isn't
  worker-bound every tick.

**Phase C — Finite COLLECTION storage (affects the AI).**
- Give drop-offs (Refinery/Foundry/Arsenal) a finite intake buffer that must be
  drained to the CC; a full drop-off makes gatherers pick the next-nearest drop-off
  (extend `nearestDropoff` to skip full ones) or idle.
- CC gets a large, `storeTier`-scaled cap (Capital upgrade raises it).
- **AI safety first:** either give the AI CC an effectively unbounded cap, or gate
  the whole of Phase C behind an "advanced logistics" world/difficulty flag so the AI
  path stays deterministic and non-deadlocking. Re-verify `determinism-roster` across
  every archetype before merge.

### 2.5 Recommended order & risk

`Phase A` (low risk, player-only, self-contained, immediately satisfying) →
`Phase B` (medium, builds the supply network) → `Phase C` (higher, touches the AI &
market, needs the most careful determinism pass). Ship and play-test each before the
next; do not attempt all three in one pass.
