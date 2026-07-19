import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { buildUnitGrid } from "../engine/grid.js";
import { updateCombat, updateBuildingCombat } from "../engine/combat.js";
import { applySeparation } from "../engine/separation.js";
import { UNITS } from "../engine/entities.js";

// These are BALANCE regression tests: they run the real combat sim as an
// auto-battle (armies attack-move into each other, the way the AI actually
// fights) and assert the intended balance invariants — the rock-paper-scissors
// triangle is a genuine cycle in practice, and the Breacher is the unique
// turtle-breaker. They exist so a future stat tweak that quietly breaks the
// triangle (or makes a unit dominant / the Breacher pointless) fails loudly.
// Deterministic (fixed seed + fixed placement), so they're stable, not flaky.

const totalCost = t => Object.values(UNITS[t].cost).reduce((a, b) => a + b, 0);

function place(state, type, owner, n, cx, cy, tx, ty) {
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) {
    const u = makeUnit(type, owner, cx + (i % cols) * 18, cy + Math.floor(i / cols) * 18);
    u.order = { type: "attack-move", x: tx, y: ty };
    state.units.set(u.id, u);
  }
}
const aliveCount = (state, owner) => [...state.units.values()].filter(u => u.owner === owner).length;

// A cost-parity auto-battle on open ground (ferros carries no terrain). Returns
// the survivors on each side once one is wiped.
function duel(typeA, typeB, budget = 800, maxTicks = 2500) {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear(); state.buildings.clear();
  place(state, typeA, "player", Math.floor(budget / totalCost(typeA)), 620, 480, 940, 500);
  place(state, typeB, "ai", Math.floor(budget / totalCost(typeB)), 940, 480, 620, 500);
  for (let t = 0; t < maxTicks; t++) {
    state.unitGrid = buildUnitGrid(state);
    for (const u of [...state.units.values()]) updateCombat(state, u, 0.1);
    applySeparation(state, 0.1);
    if (!aliveCount(state, "player") || !aliveCount(state, "ai")) break;
  }
  return { a: aliveCount(state, "player"), b: aliveCount(state, "ai") };
}
// True iff `attacker`'s cost-parity army beats `defender`'s in auto-battle.
function beats(attacker, defender) {
  const r = duel(attacker, defender);
  return r.a > r.b;
}

test("the rock-paper-scissors triangle holds in actual auto-battle", () => {
  assert.ok(beats("bastion", "skiff"), "Bastion should beat Skiff");
  assert.ok(beats("skiff", "lancer"), "Skiff should beat Lancer");
  assert.ok(beats("lancer", "bastion"), "Lancer should beat Bastion");
});

test("the triangle is a genuine cycle — no combat unit wins both its matchups", () => {
  // Each unit wins exactly one of its two triangle matchups and loses the other,
  // so none is dominant (beats everything) and none is dead weight.
  assert.ok(beats("skiff", "lancer") && !beats("skiff", "bastion"), "Skiff beats Lancer, loses to Bastion");
  assert.ok(beats("bastion", "skiff") && !beats("bastion", "lancer"), "Bastion beats Skiff, loses to Lancer");
  assert.ok(beats("lancer", "bastion") && !beats("lancer", "skiff"), "Lancer beats Bastion, loses to Skiff");
});

// Does a budget-sized army of `type` break a Command Center defended by `turrets`
// Sentinel Turrets? The Breacher's whole reason to exist.
function cracksBase(type, turrets, budget = 800, maxTicks = 6000) {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear(); state.buildings.clear();
  const cc = makeBuilding("command", "ai", 1000, 500);
  state.buildings.set(cc.id, cc);
  for (let i = 0; i < turrets; i++) {
    const tr = makeBuilding("turret", "ai", 900, 440 + i * 60);
    state.buildings.set(tr.id, tr);
  }
  place(state, type, "player", Math.floor(budget / totalCost(type)), 560, 480, 1000, 500);
  for (let t = 0; t < maxTicks; t++) {
    state.unitGrid = buildUnitGrid(state);
    for (const u of [...state.units.values()]) updateCombat(state, u, 0.1);
    for (const b of [...state.buildings.values()]) updateBuildingCombat(state, b, 0.1);
    applySeparation(state, 0.1);
    if (!state.buildings.has(cc.id)) return true;                 // base fell
    if (!aliveCount(state, "player")) return false;               // army wiped first
  }
  return !state.buildings.has(cc.id);
}

test("the Breacher is the turtle-breaker: it cracks a turret line that stops the line units", () => {
  // It out-ranges the Sentinel Turret (150 vs 130), so it razes a fortified base
  // the anti-unit specialists can't approach.
  assert.ok(cracksBase("breacher", 2), "a Breacher army breaks a 2-turret base");
  assert.ok(cracksBase("breacher", 4), "and even a heavy 4-turret turtle");
  assert.ok(!cracksBase("bastion", 4), "a same-cost Bastion army is stopped cold by the 4-turret line");
  assert.ok(!cracksBase("lancer", 4), "as is a Lancer army — siege is the Breacher's job");
});
