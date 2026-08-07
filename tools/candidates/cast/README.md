# The cast — ten playable AIs whose LABELS are still unverified

Produced by `node tools/ailab.js archive` (MAP-Elites), one file per filled cell of an
aggression × army-size grid. Design: `docs/ai-evolution-design.md` §6E; ledger rows dated
2026-08-06/07 in `docs/odyssey-ai-review.md`.

## Trustworthy: the genomes and their strength

Each file is a real, runnable candidate in exactly the shape `duel` / `sweep` / `leaderboard`
already take. Each passed the health screen. The percentage in each `_hypothesis` line is a win
rate over 16 real matches against a fixed panel of all four shipped strategies, both owner slots,
two worlds — fixed opponents, so those numbers are comparable to each other and across runs. They
range 38%–88%.

## NOT trustworthy: the cell labels

**Do not treat these ten as ten reliably distinct play styles.** The behaviour label on each file
is a measurement that does not reproduce on maps the archive never saw.

Verified by re-measuring four cells on **held-out replicates** — the archive measured on replicates
0–1, so 2–3 are maps it never trained on. Three of the four landed in a different bin:

| cell | filed as | re-measured |
|---|---|---|
| `never/token` | never/token | never/token ✓ |
| `never/small` | never/small | never/token |
| `waves/swarm` | waves/swarm | probes/token |
| `raids/token` | raids/token | probes/token |

The verification harness itself was checked first, because a uniformly-tiny re-measurement looks
more like a broken script than like noise: re-run on the archive's *own* replicates it reproduces
the filed descriptor exactly. The harness is faithful; the descriptor is not stable.

## Why — and why the obvious fixes were not enough

The final army size of a 40-minute Odyssey run varies enormously with the map. One genome, held
fixed, measured across three worlds × two replicates:

| | korrath | ferros | vesper |
|---|---|---|---|
| rep 0 | 3 | 58 | 47 |
| rep 1 | 3 | 143 | 208 |

Median ≈ 53. The same genome on replicates 2–3 medians at **1.5**.

Two fixes already landed and were not sufficient:

- **A median instead of a mean.** The distribution is heavy-tailed — an economy that gets going
  compounds — and averaging inherits a heavy tail rather than smoothing it. Measured over twelve
  runs of one genome, the *mean* read 21.0 / 14.8 / 36.9 at 1 / 2 / 4 replicates (diverging,
  because whichever sample held a 296 decided the answer) while the *median* read 26 / 13 / 15
  (converging). That fixed the pathology it was aimed at.
- **`runSeed` gained a pinned key**, so every genome in a run is described on identical maps and a
  saved cell re-reads on the same ones later. Without it, renaming a candidate changed its maps,
  which defeats verification outright.

Both were necessary and neither was enough, because the residual variance is **across worlds**, not
within one. A per-world median of 3 and a per-world median of 208 do not average into a
description of a genome; they average into a description of the roster.

## What a trustworthy cast would need

- **Bin per world, then vote** rather than taking one median across a pooled sample — a genome that
  is a swarm on vesper and a token force on korrath is not one thing, and the current descriptor
  hides that instead of reporting it.
- **Many more replicates** than 2, if the pooled median is kept.
- Or **a descriptor that is not final army size** — an integral over the run, or a per-ore-spent
  ratio, would not inherit the compounding that makes the raw count so map-dependent.

Until then: ten playable AIs of measured strength and unverified personality.
