/* ============================================================
   Guards for tools/duelCore.js — the fairness-critical "run one duel match" primitive extracted
   out of tools/ailab.js (docs/competitions-and-elo.md Phase 1) so a browser Worker can import it
   in a later stage without pulling in ailab.js's CLI/printing/search/leaderboard code.

   tools/ailab.js's own test/ailab.test.js already exercises pinnedDuelDials/the match runner
   EXHAUSTIVELY through runDuel/runSwappedDuel/runDuelBrackets — fairness across sides, difficulty
   pinning, determinism, override isolation — and stays the safety net proving the extraction
   didn't change any of that observable behaviour. This file adds direct, ISOLATED coverage of the
   primitive itself, imported straight from tools/duelCore.js, never through tools/ailab.js.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pinnedDuelDials, duelSeed, runDuelMatch } from "../tools/duelCore.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { STRATEGIES } from "../engine/aiStrategy.js";

/* ---------- pinnedDuelDials ---------- */

test("pinnedDuelDials reads apm/micro straight off the named DIFFICULTY_OPTIONS row", () => {
  for (const opt of DIFFICULTY_OPTIONS) {
    assert.deepEqual(pinnedDuelDials(opt.mult), { difficulty: opt.mult, apm: opt.aiApm, micro: !!opt.aiMicro },
      `difficulty "${opt.mult}" must echo its own row's dials`);
  }
});

test("pinnedDuelDials normalizes an unknown/typo'd difficulty to medium's dials AND label", () => {
  const medium = DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  const dials = pinnedDuelDials("totallyBogusTypo");
  assert.deepEqual(dials, { difficulty: "medium", apm: medium.aiApm, micro: !!medium.aiMicro },
    "an unrecognised difficulty must fall back to medium's own dials, and REPORT medium -- not echo the garbage input");
});

/* ---------- duelSeed ---------- */

test("duelSeed is deterministic: identical inputs produce the identical seed", () => {
  const a = duelSeed(1, "ferros", "medium", "Alpha", "Beta", 0);
  const b = duelSeed(1, "ferros", "medium", "Alpha", "Beta", 0);
  assert.equal(a, b);
  assert.equal(typeof a, "number");
});

test("duelSeed sorts the two candidate names into the hash, so a pair draws the identical map regardless of argument order", () => {
  const forward = duelSeed(1, "ferros", "medium", "Alpha", "Beta", 0);
  const backward = duelSeed(1, "ferros", "medium", "Beta", "Alpha", 0);
  assert.equal(forward, backward, "duelSeed(a,b,...) and duelSeed(b,a,...) must draw the same map");
});

test("duelSeed genuinely varies with world, difficulty, replicate, and base seed", () => {
  const base = duelSeed(1, "ferros", "medium", "Alpha", "Beta", 0);
  assert.notEqual(base, duelSeed(1, "korrath", "medium", "Alpha", "Beta", 0), "world must vary the seed");
  assert.notEqual(base, duelSeed(1, "ferros", "hard", "Alpha", "Beta", 0), "difficulty must vary the seed");
  assert.notEqual(base, duelSeed(1, "ferros", "medium", "Alpha", "Beta", 1), "replicate must vary the seed");
  assert.notEqual(base, duelSeed(2, "ferros", "medium", "Alpha", "Beta", 0), "the base seed must vary the seed");
  assert.notEqual(base, duelSeed(1, "ferros", "medium", "Alpha", "Gamma", 0), "the actual pair must vary the seed");
});

/* ---------- runDuelMatch (formerly ailab.js's own private duelRun) ---------- */

const dials = pinnedDuelDials("medium");

test("runDuelMatch returns exactly the row shape every ailab.js consumer relies on -- no more, no fewer fields", () => {
  const row = runDuelMatch({
    world: "ferros", seed: duelSeed(7, "ferros", "medium", "A", "B", 0), dials,
    aName: "A", aStrategy: "default", bName: "B", bStrategy: "aggressive", minutes: 5,
  });
  const expectedFields = [
    "world", "seed", "difficulty", "swapAsym", "aName", "aStrategy", "bName", "bStrategy",
    "aDifficulty", "bDifficulty", "aApm", "bApm", "aMicro", "bMicro",
    "winner", "winReason", "time", "aScore", "bScore", "margin",
  ];
  assert.deepEqual(Object.keys(row).sort(), [...expectedFields].sort(),
    "runDuelMatch's row shape must not change AT ALL -- every existing ailab.js consumer depends on this exact set of fields");
});

test("runDuelMatch is deterministic — same inputs, byte-identical row", () => {
  const cfg = {
    world: "ferros", seed: duelSeed(7, "ferros", "medium", "A", "B", 0), dials,
    aName: "A", aStrategy: "default", bName: "B", bStrategy: "aggressive", minutes: 5,
  };
  assert.equal(JSON.stringify(runDuelMatch(cfg)), JSON.stringify(runDuelMatch(cfg)),
    "two identical calls diverged: something reads a clock or an unseeded pick");
});

test("runDuelMatch pins the SAME dials object's apm/micro/difficulty into both sides, read back off the real controllers", () => {
  for (const difficulty of ["easy", "hard"]) {
    const d = pinnedDuelDials(difficulty);
    const dial = DIFFICULTY_OPTIONS.find(o => o.mult === difficulty);
    const row = runDuelMatch({
      world: "ferros", seed: duelSeed(3, "ferros", difficulty, "A", "B", 0), dials: d,
      aName: "A", aStrategy: "default", bName: "B", bStrategy: "economic", minutes: 5,
    });
    assert.equal(row.difficulty, difficulty);
    assert.equal(row.aDifficulty, difficulty);
    assert.equal(row.bDifficulty, difficulty);
    assert.equal(row.aApm, dial.aiApm, "candidate A's own controller must carry this difficulty's aiApm");
    assert.equal(row.bApm, dial.aiApm, "candidate B's own controller must carry the SAME aiApm as A, not its own");
    assert.equal(row.aMicro, !!dial.aiMicro);
    assert.equal(row.bMicro, !!dial.aiMicro);
  }
});

test("runDuelMatch reports swapAsym back exactly as given", () => {
  const cfg = {
    world: "ferros", seed: duelSeed(7, "ferros", "medium", "A", "B", 0), dials,
    aName: "A", aStrategy: "default", bName: "B", bStrategy: "aggressive", minutes: 5,
  };
  assert.equal(runDuelMatch({ ...cfg, swapAsym: false }).swapAsym, false);
  assert.equal(runDuelMatch({ ...cfg, swapAsym: true }).swapAsym, true);
  assert.equal(runDuelMatch(cfg).swapAsym, false, "swapAsym must default falsy when omitted, coerced to a real boolean");
});

test("runDuelMatch actually resolves a fight: a strong candidate beats a defenceless one", () => {
  // neverInitiates + a standing-army cap of ZERO is absolute defencelessness in skirmish (no
  // desperation timeout) -- the same fixture shape test/ailab.test.js's own duel tests use, here
  // exercised directly against the primitive with a single match rather than a whole worlds x
  // seeds matrix (that exhaustive coverage already lives in test/ailab.test.js via runDuel).
  STRATEGIES.labDuelCoreCrippled = { name: "labDuelCoreCrippled", desc: "test", neverInitiates: true, standingArmyCap: 0 };
  const row = runDuelMatch({
    world: "korrath", seed: duelSeed(7, "korrath", "medium", "normal", "crippled", 0), dials,
    aName: "normal", aStrategy: "default", bName: "crippled", bStrategy: "labDuelCoreCrippled", minutes: 20,
  });
  assert.equal(row.winner, "a", `the normal candidate must win (got winner=${row.winner}, reason=${row.winReason})`);
  assert.equal(row.winReason, "elimination", "a defenceless base should lose to a genuine assault before the clock");
  assert.ok(row.margin > 0, "the winning side's score margin must be positive");
});

/* ---------- D3 (docs/competitions-and-elo.md): aArchetype/bArchetype -- the per-entrant archetype
   override, threaded through runDuelMatch's own config into createSelfPlayState's two controllers.
   The row shape itself must stay UNCHANGED (archetype is an input dial here, never a reported
   output field -- see the exact-shape test above), so this proves the override reaches the sim
   some other way: two otherwise-identical runs that disagree only on archetype must diverge. ---------- */

test("runDuelMatch's aArchetype/bArchetype reach the simulated match without changing the row's own field set", () => {
  const cfg = {
    world: "ferros", seed: duelSeed(9, "ferros", "medium", "A", "B", 0), dials,
    aName: "A", aStrategy: "default", bName: "B", bStrategy: "default", minutes: 8,
  };
  const baseline = runDuelMatch(cfg);
  const withArchetypes = runDuelMatch({ ...cfg, aArchetype: "rusher", bArchetype: "technologist" });

  assert.deepEqual(Object.keys(withArchetypes).sort(), Object.keys(baseline).sort(),
    "supplying an archetype must not add or remove ANY field from the row -- it's an input dial, not an output");
  assert.notEqual(JSON.stringify(baseline), JSON.stringify(withArchetypes),
    "two otherwise-identical matches that disagree only on archetype must actually simulate differently -- " +
    "proof the override genuinely reaches the created states, not just accepted and ignored");
});

test("runDuelMatch treats a missing/null aArchetype/bArchetype as byte-identical to omitting the option entirely", () => {
  const cfg = {
    world: "ferros", seed: duelSeed(9, "ferros", "medium", "A", "B", 0), dials,
    aName: "A", aStrategy: "default", bName: "B", bStrategy: "default", minutes: 8,
  };
  const omitted = runDuelMatch(cfg);
  const explicitNull = runDuelMatch({ ...cfg, aArchetype: null, bArchetype: undefined });
  assert.equal(JSON.stringify(omitted), JSON.stringify(explicitNull));
});

/* ---------- browser importability (docs/competitions-and-elo.md Phase 1: "it will be imported by
   a Worker next stage") -- same idiom test/ai-selfplay.test.js already uses for tools/selfplay.js,
   pointed at this file instead. ---------- */

test("tools/duelCore.js has no bare `document` or `window` reference anywhere in its source", () => {
  const src = readFileSync(new URL("../tools/duelCore.js", import.meta.url), "utf8");
  const FORBIDDEN = /\bdocument\b|\bwindow\b/;
  const offenders = [];
  src.split("\n").forEach((line, i) => {
    if (FORBIDDEN.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(offenders, [],
    "tools/duelCore.js must have zero `document`/`window` references so a browser Worker can import it cleanly:\n"
    + offenders.join("\n"));
});
