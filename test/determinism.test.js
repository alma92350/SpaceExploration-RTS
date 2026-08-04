import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { mulberry32, entitySnapshot } from "./_helpers.js";

// The fingerprint and the seeded PRNG both come from test/_helpers.js on purpose. This file
// used to carry its own copies, and the local snapshot had quietly drifted into a WEAKER one:
// it recorded only `order.type` (not the order's target), and no cargo, tier, charge,
// constructing flag or state.time — so a float-accumulation drift that moved a hauler's cargo
// or a move order's destination replayed "identically". entitySnapshot captures every
// sim-owned fact at full precision; the sensitivity test at the bottom of this file keeps it
// that way.
function runTo(planetId, seed, ticks) {
  const state = createGameState({ planetId, rng: mulberry32(seed) });
  for (let i = 0; i < ticks && !state.over; i++) tick(state, 0.1);
  return state;
}

test("the sim is deterministic: two same-seed runs produce byte-identical state", () => {
  // Long enough that the AI has built, fought, revealed fog, and units have
  // jostled through separation/avoidance — all the id-hashed tie-breaks.
  const a = runTo("ferros", 12345, 2500);
  const b = runTo("ferros", 12345, 2500);
  assert.equal(entitySnapshot(a), entitySnapshot(b), "identical seed + planet must replay identically");
  assert.ok(a.tick > 100, "and the run must actually have progressed, not ended instantly");
});

test("createGameState stores the seed and the same seed reproduces the same world", () => {
  // This is what makes a seed shareable/replayable: the seed is recorded on the
  // state, and generating twice from it yields the identical map + starting layout.
  const opts = { planetId: "ferros", seed: 987654, sizeMult: 2, resourceMult: 1.5 };
  const a = createGameState({ ...opts, rng: mulberry32(opts.seed) });
  const b = createGameState({ ...opts, rng: mulberry32(opts.seed) });
  assert.equal(a.seed, 987654, "the seed is recorded on the state");
  assert.deepEqual(a.map.nodes, b.map.nodes, "same seed -> same deposits");
  assert.deepEqual(a.map.bases, b.map.bases, "same seed -> same bases");
  assert.equal(entitySnapshot(a), entitySnapshot(b), "and the same starting entities");
});

test("different seeds diverge — the determinism above isn't just a frozen sim", () => {
  const a = entitySnapshot(runTo("ferros", 1, 1500));
  const b = entitySnapshot(runTo("ferros", 2, 1500));
  assert.notEqual(a, b, "two different seeds should not produce the same world");
});

test("id counter resets per game: a second createGameState in the same process replays identically", () => {
  // Guards the nextEntityId reset — before it, the module-global counter kept
  // climbing across games, so the second run minted different ids (and thus
  // different id-hashed micro-positions) despite the identical seed.
  const first = runTo("ferros", 999, 800);
  const second = runTo("ferros", 999, 800);
  assert.equal(entitySnapshot(first), entitySnapshot(second));
});

test("the determinism fingerprint is sensitive to every sim-owned field a replay must reproduce", () => {
  // A guard on the guard. Every test above rests on the fingerprint actually CHANGING when the
  // sim diverges — one that silently omits a field turns "byte-identical replay" into
  // "identical in the fields we happened to list", which is not what CONTRIBUTING §1 promises.
  // So: mutate one sim-owned field at a time and require the fingerprint to move. Each of these
  // cases was verified red against this file's previous hand-rolled snapshot.
  const state = createGameState({ planetId: "ferros", rng: mulberry32(4242) });
  const unit = [...state.units.values()].find(u => u.cargo);
  const building = [...state.buildings.values()][0];
  assert.ok(unit && building, "fixture sanity: a cargo-carrying unit and a building exist");
  unit.order = { type: "move", x: 500, y: 500 };

  const cases = [
    ["unit cargo qty", () => { unit.cargo.qty = 999; }],
    ["unit cargo commodity", () => { unit.cargo.com = "alloys"; }],
    ["move-order target", () => { unit.order.x = 9; unit.order.y = 9; }],
    ["building charge", () => { building.charge = 0.99; }],
    ["building tier", () => { building.tier = 3; }],
    ["building constructing", () => { building.constructing = !building.constructing; }],
    ["state.time", () => { state.time = 123.456; }],
  ];
  for (const [field, mutate] of cases) {
    const before = entitySnapshot(state);
    mutate();
    assert.notEqual(entitySnapshot(state), before, `the fingerprint must see a change to ${field}`);
  }
});

test("the determinism guard makes no wall-clock assertion", () => {
  // The two perf guards used to live in this file. A slow CI box could trip their millisecond
  // budgets, and the file that went red was the DETERMINISM guard — training contributors to
  // rerun a red determinism file until it passes, which is exactly when a real replay
  // divergence would be waved through. They now live in test/perf-guard.test.js.
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.doesNotMatch(src, /performance\.now\(\)/, "wall-clock budgets belong in test/perf-guard.test.js, not here");
});
