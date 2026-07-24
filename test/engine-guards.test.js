/* ============================================================
   Hardening guards for corrupt/tampered/missing data in the combat and
   movement paths. Every case here feeds the engine input a WELL-FORMED
   save can never contain (an entity whose owner has vanished from
   state.players; a move order with NaN coordinates) and asserts the tick
   degrades gracefully instead of throwing or NaN-poisoning shared state.
   Valid data is unaffected — those round-trip/determinism guarantees live
   in the determinism + combat suites; this file only covers the bad-input
   edges those suites never reach.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { updateCombat, updateBuildingCombat } from "../engine/combat.js";
import { tick } from "../engine/sim.js";
import { mulberry32 } from "../engine/rng.js";

// Seed createGameState's map generation so the world (and thus every derived
// terrain/side modifier read during combat) is reproducible — createGameState
// falls back to Math.random only when unseeded, which would make these runs vary.
const seeded = () => createGameState({ planetId: "ferros", rng: mulberry32(1234) });

test("a combat unit whose owner is momentarily absent from state.players survives a tick without throwing", () => {
  const state = seeded();
  const attacker = makeUnit("skiff", "player", 500, 500);
  const target = makeUnit("skiff", "ai", 510, 500);   // 10 away: well inside skiff range (40)
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);
  attacker.attackTimer = 0;   // ready to fire this tick, so the attacker-side upgrade read is exercised
  const startHp = target.hp;

  // Tamper: the attacker's owner has vanished from the player table (a corrupt/partial
  // save). attackDamage's attacker-side `state.players[owner].upgrades` read used to throw
  // here; with the optional-chaining guard it reads no-upgrades (mult 1) and fires normally.
  delete state.players.player;

  assert.doesNotThrow(() => updateCombat(state, attacker, 0));
  assert.ok(target.hp < startHp, "the attack still landed (proving attackDamage ran past the owner read, not that it bailed early)");
});

test("a static-defense building whose owner is momentarily absent from state.players survives a tick without throwing", () => {
  const state = seeded();
  const turret = makeBuilding("turret", "player", 500, 500);   // completed (not constructing): attack 20, range 130
  const enemy = makeUnit("skiff", "ai", 560, 500);             // 60 away: inside turret range
  state.buildings.set(turret.id, turret);
  state.units.set(enemy.id, enemy);
  turret.attackTimer = 0;   // ready to fire, so acquire → performAttack → attackDamage all run
  const startHp = enemy.hp;

  // Same tamper on the turret's side: its owner is gone from state.players. The building
  // combat path shares attackDamage, so it exercises the same attacker-side guard.
  delete state.players.player;

  assert.doesNotThrow(() => updateBuildingCombat(state, turret, 0));
  assert.ok(enemy.hp < startHp, "the turret still fired on the enemy in range");
});

test("a unit given a move order with NaN coordinates ends the tick with a finite position, not NaN", () => {
  const state = seeded();
  const unit = makeUnit("skiff", "player", 500, 500);
  state.units.set(unit.id, unit);
  // A tampered/coercion-slipped order pointing at a non-finite destination. Stepping toward
  // it would drive the unit's position to NaN and poison the separation spatial hash for
  // every neighbour it buckets with — so the movement guard must refuse and clear the order.
  unit.order = { type: "move", x: NaN, y: NaN };

  tick(state, 0.05);   // full tick: routes through movement AND the separation pass that a NaN would poison

  assert.ok(Number.isFinite(unit.x), "x stayed finite");
  assert.ok(Number.isFinite(unit.y), "y stayed finite");
  assert.equal(unit.order, null, "the unreachable order was treated as complete and cleared");
});
