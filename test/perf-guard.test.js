/* ============================================================
   Wall-clock catastrophe alarms. NOT benchmarks — they exist to catch an accidental
   O(n^2)->O(n^3) regression or a per-tick allocation blow-up, with budgets generous
   enough not to flake on a loaded CI runner.

   These two tests lived in test/determinism.test.js until they were split out. The
   problem wasn't the budgets, it was the filing: a slow shared runner tripping a perf
   alarm made the DETERMINISM guard go red, which teaches contributors to rerun a red
   determinism file rather than read it. Timing noise and replay correctness are
   different failure modes and deserve different files.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { mulberry32 } from "./_helpers.js";

test("perf guard: 200 units for 120 ticks stays well under a generous budget", () => {
  const state = createGameState({ planetId: "ferros", rng: mulberry32(7) });
  for (let i = 0; i < 200; i++) {
    const owner = i % 2 === 0 ? "player" : "ai";
    const type = ["skiff", "bastion", "lancer"][i % 3];
    const u = makeUnit(type, owner, 700 + (i % 20) * 6, 400 + Math.floor(i / 20) * 6);
    u.order = { type: "attack-move", x: 800, y: 500 };
    state.units.set(u.id, u);
  }
  const t0 = performance.now();
  for (let i = 0; i < 120; i++) tick(state, 0.05);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 8000, `200-unit sim took ${elapsed.toFixed(0)}ms for 120 ticks (budget 8000ms)`);
});

test("perf guard at scale: ~500 units on a Gigantic map stays under a catastrophe budget", () => {
  // The bigger sibling of the guard above, at the scale where an O(n^2) neighbour
  // scan or a per-tick fog rebuild would actually bite: a 4x map (both fog grids
  // over 16k cells) with ~500 units. Measured ~4.1s for the 300 ticks on a dev box,
  // so the 20s budget allows roughly 5x before it trips.
  const state = createGameState({ planetId: "ferros", rng: mulberry32(11), sizeMult: 4 });
  const base = state.map.bases;
  const types = ["skiff", "bastion", "lancer", "breacher", "worker"];
  for (let i = 0; i < 250; i++) {
    for (const [owner, b] of [["player", base.player], ["ai", base.ai]]) {
      const u = makeUnit(types[i % types.length], owner, b.x + (i % 20) * 14, b.y + Math.floor(i / 20) * 14);
      if (u.type !== "worker") u.order = { type: "attack-move", x: state.map.width / 2, y: state.map.height / 2 };
      state.units.set(u.id, u);
    }
  }
  assert.ok(state.units.size >= 500, "fixture sanity: ~500 units in play");
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) tick(state, 0.05);
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 20000, `500-unit Gigantic sim took ${elapsed.toFixed(0)}ms for 300 ticks (budget 20000ms)`);
});
