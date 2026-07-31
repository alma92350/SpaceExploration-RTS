/* ============================================================
   AI use of the Helium Bomb (engine/aiSuperweapon.js), the one capability the
   AI previously never touched at all (entities.js UNITS.heliumbomb / stardock
   .produces). Covers: building it at the Star Dock (engine/aiIndustry.js),
   arming it as a universal home-defense trap once attacked, and — Aggressive
   strategy only — walking it to the attack target and triggering it there.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { mulberry32 } from "../engine/rng.js";
import { BOMB_CORE_RADIUS } from "../engine/bomb.js";
import { BUILDINGS } from "../engine/entities.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

// A real, deployed Odyssey AI base (endless seeds only a colony ship) with room to add
// the Star Dock chain on top — mirrors test/aiIndustry.test.js's own aiBase fixture.
function aiBase(planetId = "ferros", opts = {}) {
  const seed = 4242;
  const s = createGameState({ planetId, endless: true, seed, rng: mulberry32(seed), ...opts });
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 3000;
  return s;
}

/* ---------- building it ---------- */

test("the AI builds a Helium Bomb at its Star Dock once a Leviathan is already up", () => {
  const s = aiBase("ferros");
  for (const [t, x, y] of [["reactor", 764, 452], ["stardock", 764, 556], ["habitat", 700, 436], ["habitat", 700, 566]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  const levi = makeUnit("leviathan", "ai", 764, 600); s.units.set(levi.id, levi);
  // Funded for the bomb (gas/antimatter/plasmatorp) but deliberately NOT "ai" (AI Cores), so the
  // Leviathan-training check just above it in aiIndustry.js fails on cost and doesn't hog the
  // Star Dock's one queue slot every cycle — isolating the bomb decision cleanly.
  Object.assign(s.players.ai.resources, { ore: 4000, gas: 500, antimatter: 60, plasmatorp: 60 });
  const bombQueued = () => [...s.buildings.values()].some(b => b.type === "stardock" && b.queue.some(j => j.unitType === "heliumbomb"));
  let queued = false;
  for (let i = 0; i < 8 && !queued; i++) { runAI(s, THINK_INTERVAL); queued = bombQueued(); }
  assert.ok(queued, "the AI queued a Helium Bomb at its Star Dock now that a Leviathan already exists");
});

test("...but never a second one", () => {
  const s = aiBase("ferros");
  for (const [t, x, y] of [["reactor", 764, 452], ["stardock", 764, 556], ["habitat", 700, 436], ["habitat", 700, 566]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  const levi = makeUnit("leviathan", "ai", 764, 600); s.units.set(levi.id, levi);
  const existing = makeUnit("heliumbomb", "ai", 764, 620); s.units.set(existing.id, existing);
  Object.assign(s.players.ai.resources, { ore: 4000, gas: 500, antimatter: 60, plasmatorp: 60 });
  for (let i = 0; i < 8; i++) runAI(s, THINK_INTERVAL);
  const stardock = [...s.buildings.values()].find(b => b.type === "stardock");
  assert.ok(!stardock.queue.some(j => j.unitType === "heliumbomb"), "one bomb already exists — it never queues a second");
});

/* ---------- the universal home-defense trap ---------- */

test("the AI arms an idle Helium Bomb as a home-defense trap the instant its base is under attack", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const base = state.map.bases.ai;
  const cc = makeBuilding("command", "ai", base.x, base.y); state.buildings.set(cc.id, cc);
  const bomb = makeUnit("heliumbomb", "ai", base.x + 10, base.y); state.units.set(bomb.id, bomb);
  assert.ok(!bomb.armed, "sanity check: a freshly built bomb starts unarmed (engine/bomb.js)");

  const raider = makeUnit("skiff", "player", base.x + 30, base.y); state.units.set(raider.id, raider);
  runAI(state, THINK_INTERVAL);

  assert.ok(bomb.armed, "the bomb arms itself the instant the AI can see combat pressing its base");
});

test("...and stays unarmed and untouched when nothing threatens the base", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const base = state.map.bases.ai;
  const cc = makeBuilding("command", "ai", base.x, base.y); state.buildings.set(cc.id, cc);
  const bomb = makeUnit("heliumbomb", "ai", base.x + 10, base.y); state.units.set(bomb.id, bomb);

  runAI(state, THINK_INTERVAL);

  assert.ok(!bomb.armed, "no threat, and the default strategy never sends it out — it just sits");
  assert.equal(bomb.order, null, "…completely untouched: Adaptive/Economic/Force Parity never move it proactively");
});

/* ---------- Aggressive strategy: offensive delivery ---------- */

test("Aggressive strategy arms and triggers a Helium Bomb immediately once it's within range of the attack target", () => {
  const state = createGameState({ planetId: "ferros", endless: true, aiStrategy: "aggressive" });
  const base = state.map.bases.ai;
  const cc = makeBuilding("command", "ai", base.x, base.y); state.buildings.set(cc.id, cc);
  const bomb = makeUnit("heliumbomb", "ai", base.x, base.y); state.units.set(bomb.id, bomb);
  const enemyCC = makeBuilding("command", "player", base.x + 40, base.y); state.buildings.set(enemyCC.id, enemyCC);

  runAI(state, THINK_INTERVAL);

  assert.ok(bomb.armed, "close enough to the target on the very first cycle — arms right away");
  assert.ok(bomb.fuseUntil != null, "…and lights the fuse immediately too — the same lightFuse() the player's own Detonate Now calls");
});

test("the offensive bomb no longer arms at the old flat ARRIVE_RADIUS (70) — it waits for the target's own rim-based kill-band", () => {
  const state = createGameState({ planetId: "ferros", endless: true, aiStrategy: "aggressive" });
  const base = state.map.bases.ai;
  const cc = makeBuilding("command", "ai", base.x, base.y); state.buildings.set(cc.id, cc);
  const bomb = makeUnit("heliumbomb", "ai", base.x, base.y); state.units.set(bomb.id, bomb);
  // The Antimatter Gate (radius 28): its real per-target threshold is radius + BOMB_CORE_RADIUS =
  // 43 — well short of the old flat 70 this used to arm at, where bombDamageAt(70) is only
  // ~138hp against a 1200hp Gate, nowhere near the documented one-shot (engine/bomb.js). Placed at
  // the midpoint between the two thresholds: inside the old flat radius (would have armed under
  // the bug) but outside the new, correct one.
  const threshold = BUILDINGS.antimatter_gate.radius + BOMB_CORE_RADIUS;
  assert.ok(threshold < 70, "sanity check: the new per-target threshold really is tighter than the old flat radius");
  const dist = (threshold + 70) / 2;
  const gate = makeBuilding("antimatter_gate", "player", base.x + dist, base.y); state.buildings.set(gate.id, gate);
  // A committed wave (order.type 'attack-move'), so the walk itself isn't held home by the
  // separate "travels with the wave" fix (engine/aiSuperweapon.js) — isolates this test to the
  // arrival-threshold question alone.
  const raider = makeUnit("skiff", "ai", base.x + 10, base.y);
  raider.order = { type: "attack-move", x: gate.x, y: gate.y };
  state.units.set(raider.id, raider);

  runAI(state, THINK_INTERVAL);

  assert.ok(!bomb.armed, "inside the old flat ARRIVE_RADIUS but outside the Gate's real kill-band — must not arm here");
  assert.equal(bomb.order?.type, "move", "still closing the last distance to the Gate's rim");
});

test("Aggressive strategy walks a Helium Bomb (unarmed) toward a distant target instead of arming on the spot", () => {
  const state = createGameState({ planetId: "ferros", endless: true, aiStrategy: "aggressive" });
  const base = state.map.bases.ai;
  const cc = makeBuilding("command", "ai", base.x, base.y); state.buildings.set(cc.id, cc);
  const bomb = makeUnit("heliumbomb", "ai", base.x, base.y); state.units.set(bomb.id, bomb);
  // No enemy in sight at all — chooseAttackTarget falls back to the player's (unexplored, and on
  // a fresh map, comfortably distant) starting position.

  runAI(state, THINK_INTERVAL);

  assert.ok(!bomb.armed, "still in transit — it only arms once it arrives");
  assert.equal(bomb.order?.type, "move", "issued a plain move toward the target — free to travel at no risk while unarmed (engine/bomb.js)");
});
