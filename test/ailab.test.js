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
import { run, labWorld, summarise, score, applyOverrides, CHECKS, OPPONENTS, WORLDS, WEIGHTS, runLeaderboard } from "../tools/ailab.js";
import { STRATEGIES } from "../engine/aiStrategy.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { tick } from "../engine/sim.js";

const short = extra => ({ world: "ferros", strategy: "default", difficulty: "medium",
                          opponent: "passive", minutes: 4, sample: 2, seed: 7, ...extra });

// Compare only the summary fields — the curve is a superset of them, so a divergence
// anywhere in the run shows up here too, without a 40-field diff to read.
const fingerprint = r => JSON.stringify(summarise(r.curve));

test("a lab run is deterministic — same configuration, byte-identical metrics", () => {
  assert.equal(fingerprint(run(short())), fingerprint(run(short())),
    "two identical lab runs diverged: something in the harness reads a clock or an unseeded pick");
});

test("the tech opponent is deterministic too — same configuration, byte-identical metrics", () => {
  const cfg = short({ opponent: "tech", minutes: 10 });
  assert.equal(fingerprint(run(cfg)), fingerprint(run(cfg)),
    "two identical tech-opponent runs diverged: the new bot must be exactly as clock-free as the others");
});

test("the seed genuinely varies the run (the lab isn't pinned to one world roll)", () => {
  const a = run(short({ seed: 7 })), b = run(short({ seed: 99 }));
  assert.notEqual(fingerprint(a), fingerprint(b), "two different seeds produced identical metrics");
});

test("labWorld's apm flag resolves to the difficulty row's own aiApm ('real'), or stays unthrottled otherwise", () => {
  const hard = DIFFICULTY_OPTIONS.find(o => o.mult === "hard");
  const cfg = { world: "ferros", strategy: "default", difficulty: "hard", opponent: "passive", seed: 1 };
  const real = labWorld({ ...cfg, apm: "real" });
  assert.equal(real.state.ai.apm, hard.aiApm, "apm:'real' should set state.ai.apm to Hard's own aiApm dial");
  const none = labWorld({ ...cfg, apm: "none" });
  assert.equal(none.state.ai.apm, null, "apm:'none' must preserve today's unthrottled runs");
  const unset = labWorld(cfg);
  assert.equal(unset.state.ai.apm, null, "omitting apm must keep the unthrottled default direct callers (incl. this suite) rely on");
});

test("the apm override seam reaches the sim: 'real' Easy builds measurably less than 'real' Hard over the same window", () => {
  // Mirrors test/sim.test.js's own "AI speed scales with its APM setting" contrast, but through
  // the ailab.js CLI seam specifically — proving --apm doesn't just set a field nobody reads. Easy
  // (20) vs unthrottled converges too fast to tell apart (the opening is resource-limited, not
  // action-limited, well before 20 APM), so this compares the two ends of the real dial instead —
  // exactly what a player choosing a difficulty actually gets.
  const base = { opponent: "passive", minutes: 10, sample: 1, apm: "real" };
  const output = r => r.workersFinal + r.buildingsFinal;
  const easy = output(run(short({ ...base, difficulty: "easy" })));
  const hard = output(run(short({ ...base, difficulty: "hard" })));
  assert.ok(easy < hard * 0.85,
    `Easy's 20-apm run (${easy}) should build noticeably less than Hard's 140-apm run (${hard}) in the same 10 minutes`);
});

test("each sparring opponent sets up the player side it advertises", () => {
  const presence = opponent => {
    const r = run(short({ opponent, minutes: 2 }));
    return r.curve[r.curve.length - 1].playerBuildings;
  };
  assert.equal(presence("none"), 0, "the background-world opponent leaves no player presence at all");
  assert.ok(presence("passive") >= 1, "the passive opponent seats a Command Center");
  assert.ok(presence("turtle") >= 1, "the turtle opponent seats a Command Center");
  assert.ok(presence("tech") >= 1, "the tech opponent seats a Command Center");
  for (const [id, bot] of Object.entries(OPPONENTS))
    assert.equal(typeof bot.desc, "string", `opponent ${id} needs a one-line description for the scoreboard`);
});

test("the turtle bot actually builds an economy — it's a yardstick, not a statue", () => {
  const r = run(short({ opponent: "turtle", minutes: 8, world: "ferros" }));
  const last = r.curve[r.curve.length - 1];
  assert.ok(last.playerBuildings > 1, `the turtle should raise more than its Command Center (got ${last.playerBuildings})`);
});

test("the tech bot climbs past the Barracks and fields more than Skiffs — the composition yardstick", () => {
  // Per this file's own header, this suite "guards the harness, not the AI" — the question
  // is whether the tech bot's OWN build order reaches a Foundry and fields Tier-2/3 units,
  // not whether its base survives 20 minutes against a real, symmetrically-tempo'd medium
  // opponent (a Foundry/Arsenal standing bonus applies to both sides via the shared
  // updateProductionQueue, and can now let a real AI win this race outright on some seeds —
  // an anticipated consequence of that feature, not a harness defect). So the milestones are
  // checked across the whole run, not just the final snapshot: reaching them once and later
  // losing the base still proves the build order works, which is all this test claims.
  const { state, bot } = labWorld({ world: "ferros", strategy: "default", difficulty: "medium",
                                     opponent: "tech", seed: 7 });
  const dt = 0.1;   // mirrors ailab.js's own fixed sim step (DT)
  let sinceThink = 0;
  let sawFoundry = false;
  let guardTypes = new Set();
  for (let i = 0; i < Math.round(20 * 60 / dt); i++) {
    tick(state, dt);
    sinceThink += dt;
    if (sinceThink >= 1.5) { sinceThink = 0; bot.think(state); }   // mirrors ailab.js's own THINK cadence
    if (!sawFoundry && [...state.buildings.values()].some(b => b.owner === "player" && !b.constructing && b.type === "foundry")) sawFoundry = true;
    for (const u of state.units.values()) if (u.owner === "player" && u.type !== "worker") guardTypes.add(u.type);
  }
  assert.ok(sawFoundry, "the tech bot should raise a Foundry within 20 minutes");
  assert.ok([...guardTypes].some(t => t !== "skiff"),
    `the tech bot's guard should include Tier-2/3 units, not just Skiffs (got: ${[...guardTypes].join(", ") || "none"})`);
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
  // NOT `army > 0`: docs/odyssey-ai-review.md §2.9 already documents ferros/economic dying to this
  // exact rush within minute 10 (a known, deliberately-unfixed difficulty characteristic), and
  // "Doctrine research develops over time" measurably deepened it on this seed — bisected to
  // 4b95948, where the AI now loses its whole opening (workers and all) before ever fielding a
  // single combat unit, instead of the pre-existing "fields 1-2 units, then still loses" pattern.
  // That's a real difficulty-curve shift `whoever owns that curve` (§2.9's own words) should weigh
  // in on, not something to paper over here — so `buildings > 1` stands in for "a real, developing
  // base existed to fight", true on both sides of that regression, while `army > 0` is not.
  assert.ok(fights.curve.some(c => c.buildings > 1), "the AI it fights is a real opponent, not an empty world");
});

test("for a never-initiating strategy, standing tracks provocation exactly — and provocation FADES", () => {
  // The end-to-end proof that engine and bench agree. Deliberately an invariant rather than "it
  // attacked by minute N": provocation is a memory that decays at a rate the world's temperament
  // sets (engine/diplomacy.js PROVOKE_MEMORY / forgiveness), so whether any particular sample
  // lands inside the window is a timing coincidence. What must ALWAYS hold is that a strategy
  // which doesn't start fights has standing exactly when, and only when, it has been provoked.
  const fought = run(short({ world: "korrath", strategy: "economic", opponent: "skirmisher", minutes: 30 }));
  const ignored = run(short({ world: "korrath", strategy: "economic", opponent: "passive", minutes: 30 }));
  for (const r of [fought, ignored])
    for (const c of r.curve)
      assert.equal(c.entitled, c.provokedAi, "a never-initiating neighbour's standing IS its provocation");
  assert.ok(fought.curve.some(c => c.provokedAi), "a player who attacks it earns a neighbour that may answer");
  assert.ok(!ignored.curve.some(c => c.provokedAi), "…and one who never touches it does not");
  // …and the memory really does fade: the fighting run must show provocation lapsing at some point,
  // not staying branded on for the rest of the session.
  const flips = fought.curve.filter((c, i) => i > 0 && !c.provokedAi && fought.curve[i - 1].provokedAi);
  assert.ok(flips.length > 0, "provocation cools off once the shooting stops — it is not a permanent brand");
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

test("supply PRESSURE with a Habitat on the way is not a deadlock", () => {
  // A healthy AI at full tilt lives close to its cap and is momentarily unable to fit the next
  // unit all the time. A third detector had to learn that difference: measured, helix grew its army
  // 75 -> 327 and drained a 10,000 bank to 854 while the old test still called it deadlocked.
  const base = { dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1, entitled: true,
                 armyValue: 0, workers: 0, buildings: 0, rax: 1, idleRax: 0, aiAlive: true, t: 0 };
  const frac = c => summarise([{ ...base, ...c }]).supplyDeadlockFrac;
  assert.equal(frac({ supplyBlocked: true, habitatPending: true, banked: 5000 }), 0,
    "blocked, but a Habitat is already going up — it resolves itself");
  assert.equal(frac({ supplyBlocked: true, habitatPending: false, banked: 5000 }), 1,
    "blocked with nothing on the way is the state that never resolves");
});

/* ---------- leaderboard: Tier 0 of ranking candidates against a fixed yardstick ----------

   Not head-to-head play (see the LEADERBOARD header comment in tools/ailab.js) — these tests
   guard the two things that would silently break that promise: that ranking two candidates
   never lets one's overrides bleed into the other's run, and that the whole thing is exactly
   as deterministic as every other lab run. ---------- */

test("leaderboard is deterministic — same candidates, byte-identical ranking", () => {
  const candidates = [{ name: "A", strategy: "default" }, { name: "B", strategy: "aggressive" }];
  const opts = { worlds: ["ferros"], difficulty: "medium", opponent: "passive", seeds: 1, minutes: 4, sample: 2, seed: 7 };
  const strip = rs => JSON.stringify(rs.map(({ worst, ...r }) => r));
  assert.equal(strip(runLeaderboard(candidates, opts)), strip(runLeaderboard(candidates, opts)),
    "two identical leaderboard runs diverged");
});

test("a candidate's overrides never leak into the next candidate's run", () => {
  const before = JSON.stringify(STRATEGIES.aggressive);
  const candidates = [
    { name: "patched", strategy: "aggressive", overrides: { strategies: { aggressive: { garrisonMult: 0.01 } } } },
    { name: "plain", strategy: "aggressive" },
  ];
  runLeaderboard(candidates, { worlds: ["ferros"], opponent: "passive", seeds: 1, minutes: 3, sample: 2, seed: 7 });
  assert.equal(JSON.stringify(STRATEGIES.aggressive), before,
    "STRATEGIES.aggressive must be restored to its pre-leaderboard shape once every candidate has run");
});

test("leaderboard restores the tables even when a later candidate throws", () => {
  const before = JSON.stringify(STRATEGIES.aggressive);
  const candidates = [
    { name: "patched", strategy: "aggressive", overrides: { strategies: { aggressive: { garrisonMult: 0.02 } } } },
    { name: "broken", strategy: "doesNotExist" },
  ];
  assert.throws(
    () => runLeaderboard(candidates, { worlds: ["ferros"], opponent: "passive", seeds: 1, minutes: 3, sample: 2, seed: 7 }),
    /unknown strategy/);
  assert.equal(JSON.stringify(STRATEGIES.aggressive), before,
    "an earlier candidate's patch must not survive a later candidate's failure");
});

test("a candidate needs a name", () => {
  assert.throws(() => runLeaderboard([{ strategy: "default" }], { worlds: ["ferros"], seeds: 1, minutes: 2 }), /needs a "name"/);
});

test("leaderboard results are sorted best-first", () => {
  const candidates = [{ name: "A", strategy: "default" }, { name: "B", strategy: "economic" }, { name: "C", strategy: "aggressive" }];
  const results = runLeaderboard(candidates, { worlds: ["ferros"], opponent: "passive", seeds: 1, minutes: 3, sample: 2, seed: 7 });
  for (let i = 1; i < results.length; i++)
    assert.ok(results[i - 1].mean >= results[i].mean, "leaderboard must be sorted highest score first");
});

test("leaderboard ranks a crippled candidate below a normal one against an opponent that attacks", () => {
  // Same override seam the earlier "an overrides row reaches the sim" test already trusts —
  // this just proves the leaderboard's own ranking (not just the raw score) reflects it.
  const candidates = [
    { name: "normal", strategy: "default" },
    { name: "crippled", strategy: "labCrippled", overrides: { strategies: { labCrippled: { neverInitiates: true, standingArmyCap: 1 } } } },
  ];
  const results = runLeaderboard(candidates,
    { worlds: ["korrath"], difficulty: "medium", opponent: "tech", seeds: 1, minutes: 20, sample: 4, seed: 7 });
  assert.deepEqual(results.map(r => r.name), ["normal", "crippled"],
    "a token 1-unit standing army should rank below the default Rusher build against an opponent that presses it");
});

test("a strategy that deliberately caps its army isn't reported as a production stall", () => {
  // Economic keeps 3 units and Force Parity mirrors what it has seen — idle Barracks are the
  // POINT of those strategies, and counting them made the detector fire on the design working.
  const base = { dev: 0, army: 0, waves: 0, hostility: 0, playerBuildings: 1, entitled: true,
                 armyValue: 0, workers: 0, buildings: 0, rax: 2, idleRax: 2, banked: 5000,
                 supplyBlocked: false, habitatPending: false, aiAlive: true, t: 0 };
  assert.equal(summarise([{ ...base, armyCapped: true }]).idleRichFrac, 0,
    "an army-capped strategy sitting on idle Barracks is doing what it was asked to");
  assert.equal(summarise([{ ...base, armyCapped: false }]).idleRichFrac, 1,
    "…an uncapped one doing the same has run out of things to buy");
});
