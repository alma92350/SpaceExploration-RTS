/* ============================================================
   Guards for tools/ailab.js — the headless AI bench (see docs/odyssey-ai-review.md).

   The bench exists to answer "did this AI change help?", so the bench itself has to be
   trustworthy in exactly two ways, and these tests pin both:

     1. DETERMINISM. Two runs of the same configuration must produce identical numbers,
        or a "+0.04 improvement" is indistinguishable from noise and the whole loop is
        theatre. The engine is already deterministic; what this guards is that the lab
        (its sparring bots, its sampling cadence, its seed derivation) doesn't smuggle in
        a wall-clock or an unseeded pick.
     2. THE OVERRIDE SEAM. A candidate AI is injected as data into the ARCHETYPES /
        STRATEGIES / DIFFICULTY_OPTIONS tables. If that injection silently no-ops, every
        search result is a measurement of the baseline against itself.

   Runs are short (a few sim-minutes) — this suite guards the harness, not the AI. The
   long soak lives behind `node tools/ailab.js check`, which is a tool you run, not a test
   that runs you: several of its findings fire today on purpose.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { run, summarise, score, applyOverrides, CHECKS, OPPONENTS, WORLDS, WEIGHTS } from "../tools/ailab.js";
import { STRATEGIES } from "../engine/aiStrategy.js";

const short = extra => ({ world: "ferros", strategy: "default", difficulty: "medium",
                          opponent: "passive", minutes: 4, sample: 2, seed: 7, ...extra });

// Compare only the summary fields — the curve is a superset of them, so a divergence
// anywhere in the run shows up here too, without a 40-field diff to read.
const fingerprint = r => JSON.stringify(summarise(r.curve));

test("a lab run is deterministic — same configuration, byte-identical metrics", () => {
  assert.equal(fingerprint(run(short())), fingerprint(run(short())),
    "two identical lab runs diverged: something in the harness reads a clock or an unseeded pick");
});

test("the seed genuinely varies the run (the lab isn't pinned to one world roll)", () => {
  const a = run(short({ seed: 7 })), b = run(short({ seed: 99 }));
  assert.notEqual(fingerprint(a), fingerprint(b), "two different seeds produced identical metrics");
});

test("each sparring opponent sets up the player side it advertises", () => {
  const presence = opponent => {
    const r = run(short({ opponent, minutes: 2 }));
    return r.curve[r.curve.length - 1].playerBuildings;
  };
  assert.equal(presence("none"), 0, "the background-world opponent leaves no player presence at all");
  assert.ok(presence("passive") >= 1, "the passive opponent seats a Command Center");
  assert.ok(presence("turtle") >= 1, "the turtle opponent seats a Command Center");
  for (const [id, bot] of Object.entries(OPPONENTS))
    assert.equal(typeof bot.desc, "string", `opponent ${id} needs a one-line description for the scoreboard`);
});

test("the turtle bot actually builds an economy — it's a yardstick, not a statue", () => {
  const r = run(short({ opponent: "turtle", minutes: 8, world: "ferros" }));
  const last = r.curve[r.curve.length - 1];
  assert.ok(last.playerBuildings > 1, `the turtle should raise more than its Command Center (got ${last.playerBuildings})`);
});

test("an overrides row reaches the sim — a strategy that never initiates commits no waves", () => {
  // The seam the whole search loop rests on: STRATEGIES is a plain object read through
  // strategyFor(), so writing a row into it before a run IS the experiment.
  applyOverrides({ strategies: { labPacifist: { neverInitiates: true } } });
  assert.ok(STRATEGIES.labPacifist, "applyOverrides must add the row to the live table");
  const pacifist = run(short({ strategy: "labPacifist", world: "korrath", minutes: 12 }));
  const baseline = run(short({ strategy: "default", world: "korrath", minutes: 12 }));
  assert.equal(pacifist.waves, 0, "a neverInitiates strategy must commit zero waves");
  assert.ok(baseline.waves > 0, "the korrath baseline should commit at least one wave in 12 minutes");
});

test("applyOverrides merges into an existing row rather than replacing it", () => {
  applyOverrides({ strategies: { aggressive: { garrisonMult: 0.9 } } });
  assert.equal(STRATEGIES.aggressive.garrisonMult, 0.9, "the overridden field is applied");
  assert.equal(STRATEGIES.aggressive.attackTimeoutMult, 0.55, "…and the untouched fields survive");
});

test("score components stay in 0..1 and the total is their weighted mean", () => {
  const r = run(short({ minutes: 3 }));
  const s = score(r);
  for (const [k, v] of Object.entries(s.parts))
    assert.ok(v >= 0 && v <= 1, `component ${k} out of range: ${v}`);
  const wsum = Object.keys(s.parts).reduce((a, k) => a + WEIGHTS[k], 0);
  const expected = Object.entries(s.parts).reduce((a, [k, v]) => a + (WEIGHTS[k] / wsum) * v, 0);
  assert.ok(Math.abs(s.total - expected) < 1e-3, `total ${s.total} isn't the weighted mean ${expected}`);
});

test("scoring an opponent-less run drops the pressure component instead of scoring zero for it", () => {
  // Nobody to attack means "did it apply pressure?" is unanswerable, not answered badly —
  // scoring it 0 would make the right setting for development work look like a bad AI.
  const s = score(run(short({ opponent: "none", minutes: 3 })));
  assert.ok(!("pressure" in s.parts), "pressure must be dropped when there is no player at all");
  assert.ok(s.total > 0, "the remaining components still produce a usable score");
});

test("every health check is well-formed and covers the whole Odyssey roster", () => {
  const ids = CHECKS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, "check ids must be unique — they name findings in reports");
  for (const c of CHECKS) {
    assert.equal(typeof c.hit, "function");
    assert.ok(c.why && c.why.length > 20, `check ${c.id} needs a why: line explaining the mechanism`);
  }
  assert.equal(WORLDS.length, 11, "the lab sweeps the full Odyssey roster (nine skirmish worlds + two extras)");
});

/* ---------- the bench has to encode the CURRENT contract, not a stale one ---------- */

// Odyssey now distinguishes "doesn't start fights" from "never fights": a neverInitiates strategy
// is entitled to commit once the player has provoked it (engine/diplomacy.js provoked()). If the
// bench kept scoring an unprovoked, quiet neighbour as a defect, the tuning loop would optimise
// straight toward an AI that attacks players who have done nothing to it — the exact bug
// neverInitiates exists to prevent. So "entitled" gates both the detector and the score component.

test("an unprovoked never-initiating neighbour is NOT counted as hostile-but-idle", () => {
  const r = run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 20 }));
  assert.equal(r.waves, 0, "it correctly leaves a player who has done nothing to it alone");
  assert.equal(r.entitledSamples, 0, "…so it never had standing to attack");
  assert.equal(r.hostileIdleFrac, 0, "…and that must not read as a defect");
  assert.ok(!CHECKS.find(c => c.id === "hostile-but-idle").hit(r), "the detector stays silent on correct behaviour");
});

test("pressure is dropped from the score when the AI never had standing to attack", () => {
  const s = score(run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 20 })));
  assert.ok(!("pressure" in s.parts), "an unanswerable question is dropped, not scored zero");
});

test("the skirmisher opponent actually fights — it is the bot that exercises provocation", () => {
  // Contrasted against `passive` — the only bot that genuinely never draws blood. `turtle` is NOT
  // the comparison to make: its turrets kill the AI's scouts, which is the player destroying the
  // neighbour's ships however defensively it was meant, so it provokes too.
  const fights = run(short({ world: "ferros", strategy: "economic", opponent: "skirmisher", minutes: 25 }));
  const ignores = run(short({ world: "ferros", strategy: "economic", opponent: "passive", minutes: 25 }));
  assert.ok(fights.curve.some(c => c.provokedAi), "the skirmisher draws blood, which is the whole point of it");
  assert.ok(!ignores.curve.some(c => c.provokedAi), "…and a player who does nothing at all never does");
  assert.ok(fights.curve.some(c => c.army > 0), "the AI it fights is a real opponent, not an empty world");
});

test("a provoked never-initiating neighbour DOES gain standing, and the bench sees it", () => {
  // The end-to-end proof that engine and bench agree: against the one bot that draws blood, an
  // Economic neighbour becomes entitled and commits — where against `passive` it never does.
  const fought = run(short({ world: "korrath", strategy: "economic", opponent: "skirmisher", minutes: 30 }));
  const ignored = run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 30 }));
  assert.equal(ignored.entitledSamples, 0, "an untouched player is still left alone");
  assert.ok(fought.entitledSamples > 0, "a player who attacks it earns a neighbour that may answer");
});

// Two detectors were rewritten after the first fix round, because scaling the AI up turned them
// into false positives: "any Barracks idle while holding 400" fired on 42 of 44 HEALTHY runs once
// surplus opened six Barracks, and a peak-based thrift measure scored a working economy (peaks
// high, spends straight back down) the same as a stalled one. A metric that fires on correct
// behaviour is worse than no metric — the tuning loop optimises against it.

test("ordinary churn in a scaled-up production line is not a production stall", () => {
  const healthy = { rax: 6, idleRax: 2, banked: 2200 };
  const stalled = { rax: 6, idleRax: 6, banked: 12000 };
  const frac = c => summarise([{ ...c, dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1,
                                 entitled: true, banked: c.banked, armyValue: 0, workers: 0,
                                 buildings: 0, supplyBlocked: false, aiAlive: true, t: 0 }]).idleRichFrac;
  assert.equal(frac(healthy), 0, "two of six Barracks between jobs on a working balance is not a stall");
  assert.equal(frac(stalled), 1, "every Barracks idle on a large bank is");
});

test("hoarding means a bank it never spent, not a bank it passed through", () => {
  const hoard = CHECKS.find(c => c.id === "hoarding");
  assert.ok(hoard.hit({ bankedFinal: 30000, armyGrowthTail: 0 }), "big final bank + a frozen army is hoarding");
  assert.ok(!hoard.hit({ bankedFinal: 2200, armyGrowthTail: 51 }), "a working balance with a growing army is not");
  assert.ok(!hoard.hit({ bankedFinal: 30000, armyGrowthTail: 40 }), "…nor is a big balance it's actively converting");
});
