import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { buildUnitGrid } from "../engine/grid.js";
import { updateCombat, updateBuildingCombat } from "../engine/combat.js";
import { applySeparation } from "../engine/separation.js";
import { collectAnvils } from "../engine/sim.js";
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

// A supply-parity auto-battle (army size scaled by supply cost), for judging a
// capital unit whose value is per-supply in a supply-capped late game, not per-cost.
function supplyDuel(typeA, typeB, supply = 20, maxTicks = 3000) {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear(); state.buildings.clear();
  place(state, typeA, "player", Math.round(supply / UNITS[typeA].supplyCost), 600, 460, 980, 520);
  place(state, typeB, "ai", Math.round(supply / UNITS[typeB].supplyCost), 980, 460, 600, 520);
  for (let t = 0; t < maxTicks; t++) {
    state.unitGrid = buildUnitGrid(state);
    for (const u of [...state.units.values()]) updateCombat(state, u, 0.1);
    applySeparation(state, 0.1);
    if (!aliveCount(state, "player") || !aliveCount(state, "ai")) break;
  }
  return { a: aliveCount(state, "player"), b: aliveCount(state, "ai") };
}

test("the rock-paper-scissors triangle holds in actual auto-battle", () => {
  assert.ok(beats("bastion", "skiff"), "Bastion should beat Skiff");
  assert.ok(beats("skiff", "lancer"), "Skiff should beat Lancer");
  assert.ok(beats("lancer", "bastion"), "Lancer should beat Bastion");
});

test("the Bastion out-ranges the Skiff it counters, so a kiting Skiff can't orbit it forever", () => {
  // The kite exploit was static: Skiff range 40 > Bastion range, so a microed Skiff sat at
  // 40 and fired while the Bastion never closed. The counter now reaches past the Skiff.
  assert.ok(UNITS.bastion.range > UNITS.skiff.range, "Bastion reaches past the Skiff");
  assert.ok(UNITS.bastion.range < 50, "…but under KITE_MIN_RANGE 50, so the AI stands and trades with it");
});

test("an Aegis makes the army fighting around it die slower — the anvil finally soaks", () => {
  // Same fight, with and without an Aegis mixed into the player's line: the Aegis's
  // damage-reduction aura should leave more player survivors after a fixed exchange.
  function survivorsWithAegis(withAegis, maxTicks = 400) {
    const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
    state.units.clear(); state.buildings.clear();
    place(state, "skiff", "player", 8, 620, 480, 940, 500);
    if (withAegis) {
      const a = makeUnit("aegis", "player", 660, 500);
      a.order = { type: "attack-move", x: 940, y: 500 };
      state.units.set(a.id, a);
    }
    place(state, "skiff", "ai", 10, 940, 480, 620, 500);   // a slightly bigger enemy force so losses are real
    for (let t = 0; t < maxTicks; t++) {
      state.unitGrid = buildUnitGrid(state);
      collectAnvils(state);
      for (const u of [...state.units.values()]) updateCombat(state, u, 0.1);
      applySeparation(state, 0.1);
      if (!aliveCount(state, "player") || !aliveCount(state, "ai")) break;
    }
    return [...state.units.values()].filter(u => u.owner === "player" && u.type === "skiff").length;
  }
  assert.ok(survivorsWithAegis(true) > survivorsWithAegis(false),
    "the aura leaves more of the shielded army standing");
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

test("the Dreadnought is a supply-efficient capital unit, but hard-countered by mass Skiff", () => {
  // Its value is per-supply in a supply-capped late game: it out-values the
  // heavier line units at equal supply...
  assert.ok(supplyDuel("dreadnought", "bastion").a > supplyDuel("dreadnought", "bastion").b, "beats Bastion per supply");
  assert.ok(supplyDuel("dreadnought", "lancer").a > supplyDuel("dreadnought", "lancer").b, "beats Lancer per supply");
  // ...but a cheap Skiff swarm overwhelms the capital ship, so it can't be
  // massed uncounterably and light units stay relevant.
  const vsSkiff = supplyDuel("dreadnought", "skiff");
  assert.ok(vsSkiff.b > vsSkiff.a, "mass Skiff overwhelms it — its counter");
});

test("the Breacher is the turtle-breaker: it cracks a turret line that stops the line units", () => {
  // It out-ranges the Sentinel Turret (150 vs 130), so it razes a fortified base
  // the anti-unit specialists can't approach.
  assert.ok(cracksBase("breacher", 2), "a Breacher army breaks a 2-turret base");
  assert.ok(cracksBase("breacher", 4), "and even a heavy 4-turret turtle");
  assert.ok(!cracksBase("bastion", 4), "a same-cost Bastion army is stopped cold by the 4-turret line");
  assert.ok(!cracksBase("lancer", 4), "as is a Lancer army — siege is the Breacher's job");
});

// ---- Out-of-triangle counteredBy certification (engine/entities.js, folded into
// engine/aiMilitary.js's COUNTER_OF for the AI's counter-pick). Each of these units
// declares an optional `counteredBy` field; every one of those declared values must
// actually win its own duel here, so the field stays self-verifying — a future stat
// tweak that quietly breaks the mapping fails loudly instead of silently feeding the
// AI's counter-pick a stale answer. Tier-3 capital-supply units (Colossus, Aegis:
// supplyCost 4, like the Dreadnought above) are judged at supply parity — their value
// is per-supply in a supply-capped late game, not per-cost, same as supplyDuel's own
// doc comment; the Tier-2/3, supply-2 Breacher and Wraith are judged at ordinary cost
// parity, like the triangle itself.

test("the Breacher's declared counteredBy (Skiff) actually wins the duel", () => {
  assert.ok(beats("skiff", "breacher"), "a cost-parity Skiff swarm beats a Breacher army — \"folds to massed Skiffs\" per README");
});

test("the Wraith's declared counteredBy (Skiff) actually wins the duel", () => {
  assert.ok(beats("skiff", "wraith"), "the glass-cannon Wraith melts to focused Skiff fire, per its own doc comment");
});

test("the Colossus's declared counteredBy (Skiff) actually wins at supply parity", () => {
  const r = supplyDuel("skiff", "colossus");
  assert.ok(r.a > r.b, "mass Skiff overwhelms the fragile, slow-firing artillery piece at equal supply");
});

test("the Aegis's declared counteredBy (Lancer) actually wins at supply parity", () => {
  // Cost parity actually favours the Aegis — its huge hp pool buys more survivability
  // per ore than the Lancer's — but armies are supply-capped, not cost-capped, in the
  // late game, the same distinction the Dreadnought test above draws. At equal SUPPLY,
  // the Lancer's armor-piercing damage out-DPS's the Aegis's near-token gun before its
  // tankiness matters, so the same-supply comparison is the honest one.
  const r = supplyDuel("lancer", "aegis");
  assert.ok(r.a > r.b, "Lancer out-shoots the aura tank's token gun at equal supply");
});

test("the Leviathan's curated soft answer (Skiff) also wins at supply parity, though it carries no counteredBy of its own yet", () => {
  const r = supplyDuel("skiff", "leviathan");
  assert.ok(r.a > r.b, "a swarm of cheap Skiffs still trades into the capital ship at equal supply, per its own doc comment");
});
