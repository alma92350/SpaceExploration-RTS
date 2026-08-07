# The cast — PROVISIONAL. Read this before using any of these.

Fifteen AI genomes produced by `node tools/ailab.js archive` (MAP-Elites) on 2026-08-07, one per
filled cell of an aggression × army-size grid. Full context: `docs/ai-evolution-design.md` §6E and
the 2026-08-07 rows of the search ledger in `docs/odyssey-ai-review.md`.

## What is trustworthy here

**The genomes.** Each file is a real, runnable candidate in exactly the shape `duel` / `sweep` /
`leaderboard` already take. They pass the health screen and they play.

**Their strength numbers.** The percentage in each `_hypothesis` line is a win rate over 16 real
matches against a fixed panel of all four shipped strategies (both owner slots, two worlds). Fixed
opponents mean those numbers are comparable to each other and across runs. They range 56%–94%.

## What is NOT trustworthy: the cell labels

**The behaviour label on each file — `never/swarm`, `raids/token` and so on — is not reliable, and
you should not treat these fifteen as fifteen genuinely distinct play styles.**

The run that produced them measured each genome's behaviour with a single 40-minute run per world.
That is far too noisy to bin on. Re-measuring two cells three bins apart on the army axis returned:

| cell | army in the archive run | army re-measured |
|---|---|---|
| `never/small` | 8 | 93 |
| `never/swarm` | 113 | 2 |

They swapped ends of the axis. The per-world spread behind a single one of those means was
`32 / 0 / 247` — that is not a measurement, it is a card draw. Two of these files differ in exactly
one active gene (`workerTargetMult` 1.30 vs 1.47) yet were filed three bins apart.

The extremes are probably real — a genome averaging 3 units and one averaging 138 are not the same
AI. Neighbouring cells are not.

## Why it was unstable, and what was fixed

Holding one genome fixed on pinned maps over four replicates per world:

| world | army across replicates |
|---|---|
| korrath | 26, 23, 22, 27 |
| vesper | 1, 0, 8, 0 |
| ferros | 36, 3, 1, **296** |

The distribution is **heavy-tailed**, not merely noisy — an Odyssey economy that gets going
compounds, so roughly one run in twelve returns an order of magnitude more army than the rest.
That matters because it rules out the obvious fix: averaging inherits a heavy tail rather than
smoothing it. The same twelve runs give a **mean** of 21.0 / 14.8 / 36.9 at 1 / 2 / 4 replicates —
*diverging*, because whichever sample happens to contain the 296 decides the answer. The **median**
over the identical samples gives 26 / 13 / 15, which converges.

Three changes landed:

- **The descriptor is now a median, not a mean.** This is the fix that matters, and it costs
  nothing.
- **`runSeed` takes an optional pinned key**, so every genome in a run is described on identical
  maps and a saved candidate re-reads on those same maps later. Previously the strategy *name* was
  hashed into the seed, so renaming a candidate changed its maps — which is why the re-measurement
  in the table above had to be read carefully, since it conflated "different genome" with
  "different maps".
- **`--descriptor-seeds`** (default 2) takes several replicates per world, which now buys real
  precision on top of a robust statistic instead of buying lottery tickets.

The files in this directory predate all three. Re-run `archive` to get a cast whose labels can be
trusted; until then, treat these as fifteen playable AIs of measured strength and unverified
personality.
