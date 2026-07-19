import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { updateCombat, updateBuildingCombat, updateWorkerCombat } from "../engine/combat.js";
import { UNITS, BUILDINGS, UPGRADES } from "../engine/entities.js";

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

test("focus-fire: a unit with a focusId concentrates on that target over a closer one", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const closer = makeUnit("skiff", "player", 512, 500);   // nearest — the dispersed pick might otherwise take this
  const focus = makeUnit("skiff", "player", 530, 500);    // the directed target, still inside skiff range/aggro
  for (const u of [attacker, closer, focus]) state.units.set(u.id, u);
  attacker.attackTimer = 0;
  attacker.focusId = focus.id;
  const focusHp = focus.hp, closerHp = closer.hp;

  updateCombat(state, attacker, 0);   // dt 0 so only targeting + the ready shot happen

  assert.ok(focus.hp < focusHp, "the directed (focus) target took the hit");
  assert.equal(closer.hp, closerHp, "the closer enemy was ignored in favour of the focus target");
});

test("focus-fire falls back to normal acquire when the focus target is dead or out of reach", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const near = makeUnit("skiff", "player", 515, 500);
  state.units.set(attacker.id, attacker);
  state.units.set(near.id, near);
  attacker.attackTimer = 0;
  attacker.focusId = "u-does-not-exist";   // stale focus
  const nearHp = near.hp;

  updateCombat(state, attacker, 0);

  assert.ok(near.hp < nearHp, "a stale focus doesn't freeze the unit — it auto-acquires the real enemy");
});

test("kiting: a reloading Tactical ranged unit steps away from a closed-in enemy without firing", () => {
  const state = createGameState({ planetId: "ferros", aiMicro: true });
  const lancer = makeUnit("lancer", "ai", 500, 500);        // range 55, so danger band ~41
  const enemy = makeUnit("bastion", "player", 520, 500);    // 20 away — well inside the danger band
  state.units.set(lancer.id, lancer); state.units.set(enemy.id, enemy);
  lancer.order = { type: "attack", targetId: enemy.id };
  lancer.attackTimer = 1;   // reloading — should kite, not shoot
  const enemyHp = enemy.hp;

  updateCombat(state, lancer, 0.1);

  assert.ok(lancer.x < 500, "the lancer backed away from the enemy on its right");
  assert.equal(enemy.hp, enemyHp, "and held its fire while reloading (no shot this tick)");
});

test("kiting is Tactical-only and ranged-only: a Standard ranged unit and a melee unit both hold ground", () => {
  // Standard AI (micro off): a reloading lancer stands.
  const std = createGameState({ planetId: "ferros" });
  const l1 = makeUnit("lancer", "ai", 500, 500);
  const e1 = makeUnit("bastion", "player", 520, 500);
  std.units.set(l1.id, l1); std.units.set(e1.id, e1);
  l1.order = { type: "attack", targetId: e1.id }; l1.attackTimer = 1;
  updateCombat(std, l1, 0.1);
  assert.equal(l1.x, 500, "Standard AI never kites");

  // Tactical, but a melee brawler (range < 50) doesn't kite either.
  const tac = createGameState({ planetId: "ferros", aiMicro: true });
  const b1 = makeUnit("bastion", "ai", 500, 500);   // range 24 — too short to kite
  const e2 = makeUnit("skiff", "player", 512, 500);
  tac.units.set(b1.id, b1); tac.units.set(e2.id, e2);
  b1.order = { type: "attack", targetId: e2.id }; b1.attackTimer = 1;
  updateCombat(tac, b1, 0.1);
  assert.equal(b1.x, 500, "a short-range brawler stands and trades, it doesn't kite");
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

test("a worker lands its (weak) hit on an enemy it's been ordered to attack", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 508, 500);   // within the worker's short reach
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = { type: "attack", targetId: enemy.id };
  const startHp = enemy.hp;

  updateWorkerCombat(state, worker, UNITS.worker, UNITS.worker.cooldown);

  assert.equal(startHp - enemy.hp, UNITS.worker.attack, "a worker's swing lands for its attack stat");
});

test("a worker's kill clears its attack order so a queued waypoint (or idle) can follow", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 508, 500);
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = { type: "attack", targetId: enemy.id };
  enemy.hp = 1;

  updateWorkerCombat(state, worker, UNITS.worker, UNITS.worker.cooldown);

  assert.equal(state.units.has(enemy.id), false, "the target is removed");
  assert.equal(worker.order, null, "and the order clears");
});

test("a worker out of reach closes on its attack target instead of firing", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 700, 500);   // far beyond the worker's range
  state.units.set(worker.id, worker);
  state.units.set(enemy.id, enemy);
  worker.order = { type: "attack", targetId: enemy.id };
  const startHp = enemy.hp;

  updateWorkerCombat(state, worker, UNITS.worker, 0.1);

  assert.equal(enemy.hp, startHp, "no damage from out of range");
  assert.ok(worker.x > 500, "it moved toward the target");
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

test("attackers fan out across several nearby enemies instead of all dogpiling the nearest", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  // A cluster of attackers facing a cluster of enemies, all within the local
  // engagement band — so the spread policy has several targets to distribute
  // across rather than everyone locking the single closest.
  const attackers = [];
  for (let i = 0; i < 6; i++) { const u = makeUnit("skiff", "player", 500 + i * 4, 500); state.units.set(u.id, u); attackers.push(u); }
  for (let i = 0; i < 4; i++) { const e = makeUnit("skiff", "ai", 545 + i * 8, 500); state.units.set(e.id, e); }

  for (const u of attackers) updateCombat(state, u, 0.001);   // acquire (tiny dt so nobody dies this step)

  const targets = new Set(attackers.map(u => u.autoTarget).filter(Boolean));
  assert.ok(targets.size >= 2, `attackers should spread across multiple targets, got ${targets.size}`);
});

test("a unit sticks to its auto-target while it's alive and in range, instead of re-picking each tick", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  const a = makeUnit("skiff", "player", 500, 500);
  const near = makeUnit("skiff", "ai", 520, 500);
  const nearer = makeUnit("skiff", "ai", 505, 500);   // closer, but arrives "after" a is already locked on `near`
  state.units.set(a.id, a);
  state.units.set(near.id, near);
  a.autoTarget = near.id;                              // already committed
  updateCombat(state, a, 0.001);
  assert.equal(a.autoTarget, near.id, "it keeps its committed target even with a closer enemy present");
  state.units.set(nearer.id, nearer);                 // introduce the closer enemy AFTER the lock
  updateCombat(state, a, 0.001);
  assert.equal(a.autoTarget, near.id, "still committed — no re-dogpiling onto the newly-closest foe");
});

test("the two Assault tiers stack multiplicatively on damage dealt", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.overchargedWeapons = true;   // Assault I
  state.players.player.upgrades.overchargedCore = true;      // Assault II
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  const mult = UPGRADES.overchargedWeapons.damageDealtMult * UPGRADES.overchargedCore.damageDealtMult;
  assert.ok(Math.abs((startHp - b.hp) - UNITS.skiff.attack * mult) < 1e-9, "both tiers multiply the base damage");
});

test("a player's own upgrades don't affect damage against their own side", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);
  state.players.player.upgrades.reinforcedPlating = true;   // attacker researched the DEFENSIVE upgrade for themselves
  const startHp = b.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.equal(startHp - b.hp, UNITS.skiff.attack, "the attacker's own defensive research shouldn't reduce their own damage output");
});

// A completed turret standing at (500,500); enemies dropped near it, well
// clear of the map's far-apart Command Centers so the only target in aggro
// is the one the test placed.
function turretAt(state, x = 500, y = 500) {
  const t = makeBuilding("turret", "player", x, y);
  state.buildings.set(t.id, t);
  return t;
}

test("a completed Sentinel Turret auto-acquires and damages an enemy unit in range", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", turret.x + 10, turret.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(startHp - enemy.hp, BUILDINGS.turret.attack);
  assert.equal(turret.targetId, enemy.id);
});

test("a turret under construction never fires and holds no target", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = makeBuilding("turret", "player", 500, 500, { constructing: true });
  state.buildings.set(turret.id, turret);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(enemy.hp, startHp, "an unfinished turret must not deal damage");
  assert.equal(turret.targetId, null);
});

test("a turret ignores an enemy sitting just beyond its range", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", turret.x + BUILDINGS.turret.range + 5, turret.y);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(enemy.hp, startHp);
  assert.equal(turret.targetId, null);
});

test("a turret respects its cooldown: two quick ticks land only one hit", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  state.units.set(enemy.id, enemy);
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, 0.1);
  updateBuildingCombat(state, turret, 0.1);   // still inside cooldown — no second shot

  assert.equal(startHp - enemy.hp, BUILDINGS.turret.attack);
});

test("a turret kill removes the entity and pushes an entityKilled event", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  enemy.hp = 1;
  state.units.set(enemy.id, enemy);

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(state.units.has(enemy.id), false);
  assert.ok(state.events.some(e => e.type === "entityKilled"));
});

test("Overcharged Weapons multiplies a turret's damage, same as a unit's", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const enemy = makeUnit("skiff", "ai", 510, 500);
  state.units.set(enemy.id, enemy);
  state.players.player.upgrades.overchargedWeapons = true;
  const startHp = enemy.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  const { damageDealtMult } = UPGRADES.overchargedWeapons;
  assert.ok(Math.abs((startHp - enemy.hp) - BUILDINGS.turret.attack * damageDealtMult) < 1e-9);
});

test("a Breacher deals its structure bonus against a building but only base damage against a unit", () => {
  const vsBuilding = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);
  const barracks = makeBuilding("barracks", "ai", 600, 500);   // within the Breacher's 150 range
  vsBuilding.units.set(breacher.id, breacher);
  vsBuilding.buildings.set(barracks.id, barracks);
  const barracksHp = barracks.hp;

  updateCombat(vsBuilding, breacher, UNITS.breacher.cooldown);

  assert.equal(barracksHp - barracks.hp, UNITS.breacher.attack + UNITS.breacher.bonusVsBuildings);

  const vsUnit = createGameState({ planetId: "ferros" });
  const breacher2 = makeUnit("breacher", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 600, 500);
  vsUnit.units.set(breacher2.id, breacher2);
  vsUnit.units.set(skiff.id, skiff);
  const skiffHp = skiff.hp;

  updateCombat(vsUnit, breacher2, UNITS.breacher.cooldown);

  assert.equal(skiffHp - skiff.hp, UNITS.breacher.attack, "no structure bonus, no bonusVs — just base attack against a unit");
});

test("a Breacher shells a building even when an enemy unit stands closer", () => {
  const state = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 520, 500);        // closer (20 away)
  const barracks = makeBuilding("barracks", "ai", 600, 500);   // farther (100 away)
  state.units.set(breacher.id, breacher);
  state.units.set(skiff.id, skiff);
  state.buildings.set(barracks.id, barracks);
  const skiffHp = skiff.hp, barracksHp = barracks.hp;

  updateCombat(state, breacher, UNITS.breacher.cooldown);

  assert.ok(barracks.hp < barracksHp, "prefersBuildings should win over the nearer unit");
  assert.equal(skiff.hp, skiffHp, "the closer unit should be ignored");
});

test("a Breacher falls back to the nearest unit when no building is in aggro range", () => {
  const state = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);
  const skiff = makeUnit("skiff", "ai", 520, 500);
  state.units.set(breacher.id, breacher);
  state.units.set(skiff.id, skiff);
  const skiffHp = skiff.hp;

  updateCombat(state, breacher, UNITS.breacher.cooldown);

  assert.ok(skiff.hp < skiffHp, "with no building to shell, it should still engage a unit");
});

test("default acquisition is unchanged: the nearest enemy wins across units and buildings, ties to units", () => {
  const nearest = createGameState({ planetId: "ferros" });
  const skiff = makeUnit("skiff", "player", 500, 500);
  const enemyUnit = makeUnit("skiff", "ai", 530, 500);        // 30 away
  const enemyBuilding = makeBuilding("barracks", "ai", 550, 500);   // 50 away
  nearest.units.set(skiff.id, skiff);
  nearest.units.set(enemyUnit.id, enemyUnit);
  nearest.buildings.set(enemyBuilding.id, enemyBuilding);
  const unitHp = enemyUnit.hp, buildingHp = enemyBuilding.hp;

  updateCombat(nearest, skiff, UNITS.skiff.cooldown);

  assert.ok(enemyUnit.hp < unitHp, "the nearer unit should be chosen over the farther building");
  assert.equal(enemyBuilding.hp, buildingHp);

  // Exact tie: a unit and a building at the same distance both inside weapon
  // range — the unit must win (units are scanned first).
  const tie = createGameState({ planetId: "ferros" });
  const skiff2 = makeUnit("skiff", "player", 500, 500);
  const tiedUnit = makeUnit("skiff", "ai", 515, 500);
  const tiedBuilding = makeBuilding("barracks", "ai", 515, 500);
  tie.units.set(skiff2.id, skiff2);
  tie.units.set(tiedUnit.id, tiedUnit);
  tie.buildings.set(tiedBuilding.id, tiedBuilding);
  const tiedUnitHp = tiedUnit.hp, tiedBuildingHp = tiedBuilding.hp;

  updateCombat(tie, skiff2, UNITS.skiff.cooldown);

  assert.ok(tiedUnit.hp < tiedUnitHp, "an exact distance tie should resolve to the unit");
  assert.equal(tiedBuilding.hp, tiedBuildingHp);
});

test("a planet sight modifier scales aggro range for both sides", () => {
  // An enemy just inside a Skiff's full aggro range but well beyond weapon
  // range: with the target acquired the Skiff steps toward it (moving), and
  // with it out of aggro the Skiff has nothing to chase (stays put). Movement
  // is the clean tell for whether acquisition happened.
  function engages(sightMult) {
    const state = createGameState({ planetId: "ferros" });
    state.map.modifiers = { sightMult };
    const a = makeUnit("skiff", "player", 500, 500);
    const enemy = makeUnit("skiff", "ai", 500 + UNITS.skiff.aggroRange * 0.9, 500);
    state.units.set(a.id, a);
    state.units.set(enemy.id, enemy);
    updateCombat(state, a, 0.1);
    return a.x > 500;
  }

  assert.equal(engages(1), true, "at full aggro the enemy just inside range is chased");
  assert.equal(engages(0.75), false, "a 0.75 sight modifier pulls that same enemy out of aggro range");
});

test("a Breacher out-ranges a Sentinel Turret: it chips the turret down while taking nothing back", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = makeBuilding("turret", "ai", 500, 500);
  const breacher = makeUnit("breacher", "player", 500 + 140, 500);   // 140: inside Breacher's 150, outside turret's 130
  state.buildings.set(turret.id, turret);
  state.units.set(breacher.id, breacher);
  const turretHp = turret.hp, breacherHp = breacher.hp;

  for (let t = 0; t < 6; t += 0.5) {
    updateCombat(state, breacher, 0.5);
    updateBuildingCombat(state, turret, 0.5);
  }

  assert.ok(turret.hp < turretHp, "the Breacher should be steadily shelling the turret");
  assert.equal(breacher.hp, breacherHp, "the turret can't reach the Breacher, so it takes no damage");
});
