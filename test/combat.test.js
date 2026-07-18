import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { updateCombat } from "../engine/combat.js";
import { UNITS, UPGRADES } from "../engine/entities.js";

function faceOff(state, x = 500, y = 500) {
  const a = makeUnit("skiff", "player", x, y);
  const b = makeUnit("skiff", "ai", x + 10, y);   // well within weapon range
  state.units.set(a.id, a);
  state.units.set(b.id, b);
  return [a, b];
}

test("a combat unit auto-acquires and damages an enemy within aggro range with no order at all", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(b.hp < startHp);
});

test("a killed target is removed from state and the killer's explicit order clears", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  a.order = { type: "attack", targetId: b.id };
  b.hp = 1;   // one hit from behind the guard clause below

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(state.units.has(b.id), false);
  assert.equal(a.order, null);
});

test("an explicit attack order on a target killed by someone else re-acquires instead of freezing", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const c = makeUnit("skiff", "player", 500, 500);
  state.units.set(c.id, c);

  a.order = { type: "attack", targetId: b.id };
  state.units.delete(b.id);   // simulate b dying to a different attacker this same tick

  const other = makeUnit("skiff", "ai", a.x + 10, a.y);
  state.units.set(other.id, other);
  const startHp = other.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(a.order, null, "the stale order should be dropped, not kept forever");
  assert.ok(other.hp < startHp, "it should have engaged the new nearby enemy instead of idling");
});

test("a plain move order is honored even with an enemy sitting right on top of the destination", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 505, 500);   // well within aggro range
  state.units.set(a.id, a);
  state.units.set(enemy.id, enemy);
  a.order = { type: "move", x: 700, y: 500 };
  const enemyHp = enemy.hp;

  updateCombat(state, a, 0.1);

  assert.equal(enemy.hp, enemyHp, "should not have attacked despite the enemy being in range");
  assert.ok(a.x > 500, "should have moved toward its destination, not stayed to fight");
  assert.equal(a.order.type, "move", "the move order should survive an enemy being nearby");
});

test("a move order still eventually clears on arrival, same as before", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  state.units.set(a.id, a);
  a.order = { type: "move", x: 500, y: 500 };   // already there

  updateCombat(state, a, 0.1);

  assert.equal(a.order, null);
});

test("attack-move still engages an enemy encountered along the way (unlike plain move)", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 505, 500);
  state.units.set(a.id, a);
  state.units.set(enemy.id, enemy);
  a.order = { type: "attack-move", x: 700, y: 500 };
  const enemyHp = enemy.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(enemy.hp < enemyHp, "attack-move should still fight what it runs into");
});

test("Bastion deals its bonus damage specifically against Skiff", () => {
  const state = createGameState({ planetId: "ferros" });
  const bastion = makeUnit("bastion", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 500 + UNITS.bastion.range - 1, 500);   // within melee range
  state.units.set(bastion.id, bastion);
  state.units.set(skiff.id, skiff);
  const startHp = skiff.hp;

  updateCombat(state, bastion, UNITS.bastion.cooldown);

  const expectedDamage = UNITS.bastion.attack + UNITS.bastion.bonusVs.skiff;
  assert.equal(startHp - skiff.hp, expectedDamage);
});

test("Bastion deals only its base damage against a non-Skiff target", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("bastion", "player", 500, 500);
  const otherBastion = makeUnit("bastion", "ai", 500 + UNITS.bastion.range - 1, 500);
  state.units.set(attacker.id, attacker);
  state.units.set(otherBastion.id, otherBastion);
  const startHp = otherBastion.hp;

  updateCombat(state, attacker, UNITS.bastion.cooldown);

  assert.equal(startHp - otherBastion.hp, UNITS.bastion.attack);
});

test("Lancer deals its bonus damage specifically against Bastion", () => {
  const state = createGameState({ planetId: "ferros" });
  const lancer = makeUnit("lancer", "player", 500, 500);
  const bastion = makeUnit("bastion", "ai", 500 + UNITS.lancer.range - 1, 500);   // within Lancer's long range
  state.units.set(lancer.id, lancer);
  state.units.set(bastion.id, bastion);
  const startHp = bastion.hp;

  updateCombat(state, lancer, UNITS.lancer.cooldown);

  const expectedDamage = UNITS.lancer.attack + UNITS.lancer.bonusVs.bastion;
  assert.equal(startHp - bastion.hp, expectedDamage);
});

test("Lancer deals only its base damage against a non-Bastion target", () => {
  const state = createGameState({ planetId: "ferros" });
  const lancer = makeUnit("lancer", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 500 + UNITS.lancer.range - 1, 500);
  state.units.set(lancer.id, lancer);
  state.units.set(skiff.id, skiff);
  const startHp = skiff.hp;

  updateCombat(state, lancer, UNITS.lancer.cooldown);

  assert.equal(startHp - skiff.hp, UNITS.lancer.attack);
});

test("Skiff deals its bonus damage specifically against Lancer, closing the rock-paper-scissors loop", () => {
  const state = createGameState({ planetId: "ferros" });
  const skiff = makeUnit("skiff", "player", 500, 500);
  const lancer = makeUnit("lancer", "ai", 500 + UNITS.skiff.range - 1, 500);
  state.units.set(skiff.id, skiff);
  state.units.set(lancer.id, lancer);
  const startHp = lancer.hp;

  updateCombat(state, skiff, UNITS.skiff.cooldown);

  const expectedDamage = UNITS.skiff.attack + UNITS.skiff.bonusVs.lancer;
  assert.equal(startHp - lancer.hp, expectedDamage);
});

test("the rock-paper-scissors triangle is a genuine cycle: no unit also counters the unit that counters it", () => {
  assert.ok(UNITS.skiff.bonusVs.lancer > 0, "Skiff should beat Lancer");
  assert.ok(UNITS.bastion.bonusVs.skiff > 0, "Bastion should beat Skiff");
  assert.ok(UNITS.lancer.bonusVs.bastion > 0, "Lancer should beat Bastion");
  assert.ok(!UNITS.skiff.bonusVs.bastion, "Skiff must not also counter Bastion, or Skiff would beat everything");
  assert.ok(!UNITS.bastion.bonusVs.lancer, "Bastion must not also counter Lancer, or Bastion would beat everything");
  assert.ok(!UNITS.lancer.bonusVs.skiff, "Lancer must not also counter Skiff, or Lancer would beat everything");
});

test("Skiff has no bonus damage table and deals only its base attack", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(startHp - b.hp, UNITS.skiff.attack);
});

test("Overcharged Weapons multiplies the attacker's damage dealt", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.overchargedWeapons = true;
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const { damageDealtMult } = UPGRADES.overchargedWeapons;
  assert.ok(Math.abs((startHp - b.hp) - UNITS.skiff.attack * damageDealtMult) < 1e-9);
});

test("Reinforced Plating multiplies the defender's damage taken", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.ai.upgrades.reinforcedPlating = true;   // the defender's research, not the attacker's
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const { damageTakenMult } = UPGRADES.reinforcedPlating;
  assert.ok(Math.abs((startHp - b.hp) - UNITS.skiff.attack * damageTakenMult) < 1e-9);
});

test("both upgrades stack: attacker's damage bonus and defender's damage reduction apply together", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.overchargedWeapons = true;
  state.players.ai.upgrades.reinforcedPlating = true;
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const expected = UNITS.skiff.attack * UPGRADES.overchargedWeapons.damageDealtMult * UPGRADES.reinforcedPlating.damageTakenMult;
  assert.ok(Math.abs((startHp - b.hp) - expected) < 1e-9);
});

test("a player's own upgrades don't affect damage against their own side", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.reinforcedPlating = true;   // attacker researched the DEFENSIVE upgrade for themselves
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(startHp - b.hp, UNITS.skiff.attack, "the attacker's own defensive research shouldn't reduce their own damage output");
});
