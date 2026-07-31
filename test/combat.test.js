import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { buildUnitGrid } from "../engine/grid.js";
import { updateCombat, updateBuildingCombat, updateWorkerCombat } from "../engine/combat.js";
import { UNITS, BUILDINGS, UPGRADES } from "../engine/entities.js";
import { sampleTerrain } from "../engine/map.js";
import { collectAnvils } from "../engine/sim.js";

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

test("Hold stance: a holding unit fires on an in-range enemy but won't chase one out of range", () => {
  const s1 = createGameState({ planetId: "ferros" });
  const holder = makeUnit("skiff", "player", 500, 500);   // range 40, aggro 120
  const far = makeUnit("skiff", "ai", 590, 500);          // 90 away: inside aggro, outside range
  s1.units.set(holder.id, holder); s1.units.set(far.id, far);
  holder.hold = true;
  updateCombat(s1, holder, 0.1);
  assert.equal(holder.x, 500, "a holding unit stands its ground instead of chasing an out-of-range target");

  const s2 = createGameState({ planetId: "ferros" });
  const holder2 = makeUnit("skiff", "player", 500, 500);
  const near = makeUnit("skiff", "ai", 520, 500);         // 20 away: already in range
  s2.units.set(holder2.id, holder2); s2.units.set(near.id, near);
  holder2.hold = true; holder2.attackTimer = 0;
  const nearHp = near.hp;
  updateCombat(s2, holder2, 0.1);
  assert.ok(near.hp < nearHp, "but it still fires on anything that comes into range");
});

test("a combat unit's death no longer grants an instant resource refund to its owner", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const victim = makeUnit("skiff", "player", 510, 500);
  state.units.set(attacker.id, attacker); state.units.set(victim.id, victim);
  victim.hp = 1; attacker.attackTimer = 0;
  const before = state.players.player.resources.ore;

  updateCombat(state, attacker, 0);

  assert.equal(state.units.has(victim.id), false, "the victim died");
  assert.equal(state.players.player.resources.ore, before,
    "no instant refund — it leaves minable battle wreckage instead (see test/wreckage.test.js)");
});

test("a dead worker now leaves wreckage too, unlike the old combat-only salvage refund", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const worker = makeUnit("worker", "player", 510, 500);
  state.units.set(attacker.id, attacker); state.units.set(worker.id, worker);
  worker.hp = 1; attacker.attackTimer = 0;

  updateCombat(state, attacker, 0);

  assert.equal(state.units.has(worker.id), false, "the worker died");
  assert.equal(state.wrecks.length, 1, "workers now leave wreckage too — no longer a total loss (test/wreckage.test.js)");
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

// A patrol leg (engine/commands.js issuePatrol) is an ordinary attack-move order with an extra
// `patrol: true` flag combat.js never has to look at — the proposal's own claim ("combat.js
// needs nothing") is exactly that the flag is inert here: engaging along the way works
// identically with or without it.
test("an attack-move order carrying patrol:true still engages an enemy encountered along the way", () => {
  const state = createGameState({ planetId: "ferros" });
  const a = makeUnit("skiff", "player", 500, 500);
  const enemy = makeUnit("skiff", "ai", 505, 500);
  state.units.set(a.id, a);
  state.units.set(enemy.id, enemy);
  a.order = { type: "attack-move", x: 700, y: 500, patrol: true };
  const enemyHp = enemy.hp;

  updateCombat(state, a, UNITS.skiff.cooldown);

  assert.ok(enemy.hp < enemyHp, "a patrol leg still fights what it runs into, exactly like a plain attack-move");
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

// Counter-triangle readability (docs/improvement-proposals.md "Counter-triangle telegraphs"):
// performAttack stamps a `bonus` flag on the attackHit event whenever bonusVs applied, so
// effects.js/renderEffects.js can telegraph a counter hit instead of drawing it identically to
// a futile plink. Pure event bookkeeping — the damage-amount assertions above already cover the
// numbers; these only check the new event field.
test("performAttack stamps bonus:true on the attackHit event when the attacker's bonusVs counters the target's type", () => {
  const state = createGameState({ planetId: "ferros" });
  const skiff = makeUnit("skiff", "ai", 500, 500);   // Skiff.bonusVs = { lancer: 10 }
  const lancer = makeUnit("lancer", "player", 500 + UNITS.skiff.range - 1, 500);
  state.units.set(skiff.id, skiff);
  state.units.set(lancer.id, lancer);

  updateCombat(state, skiff, UNITS.skiff.cooldown);

  const hit = state.events.find(e => e.type === "attackHit");
  assert.ok(hit, "expected an attackHit event");
  assert.equal(hit.bonus, true, "Skiff vs Lancer is the counter-triangle bonus matchup");
});

test("performAttack leaves the attackHit event's bonus flag falsy for a matchup with no bonusVs", () => {
  const state = createGameState({ planetId: "ferros" });
  const [a, b] = faceOff(state);   // two Skiffs — neither counters the other

  updateCombat(state, a, UNITS.skiff.cooldown);

  const hit = state.events.find(e => e.type === "attackHit");
  assert.ok(hit, "expected an attackHit event");
  assert.ok(!hit.bonus, "no counter-triangle bonus applies between two Skiffs");
});

// The `bonus` flag is scoped to the per-type hard counter (def.bonusVs[target.type]) only — kept
// distinct from the pre-existing `heavy` flag (def.bonusVsBuildings, a class-wide siege bonus with
// no specific counter-triangle matchup to telegraph). A Breacher has no bonusVs table at all, so
// its building hits stay `heavy` but never `bonus`.
test("performAttack's bonus flag stays falsy for a class-wide siege bonus (bonusVsBuildings), unlike the pre-existing heavy flag", () => {
  const state = createGameState({ planetId: "ferros" });
  const breacher = makeUnit("breacher", "player", 500, 500);   // bonusVsBuildings: 30, no per-type bonusVs
  const turret = makeBuilding("turret", "ai", 500 + UNITS.breacher.range - 1, 500);
  state.units.set(breacher.id, breacher);
  state.buildings.set(turret.id, turret);
  breacher.order = { type: "attack", targetId: turret.id };

  updateCombat(state, breacher, UNITS.breacher.cooldown);

  const hit = state.events.find(e => e.type === "attackHit");
  assert.ok(hit, "expected an attackHit event");
  assert.equal(hit.heavy, true, "sanity: this is the same siege hit the pre-existing `heavy` flag already covers");
  assert.ok(!hit.bonus, "bonusVsBuildings is not a bonusVs counter-triangle matchup, so bonus must stay falsy");
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

// Bulwark's structure shielding, made official (docs/improvement-proposals.md): attackDamage
// (engine/combat.js) applies damageTakenMult to EVERY target it computes damage for — units AND
// buildings alike, with no kind/role filter — so a Bulwark player's turrets, Command Center, and
// Habitats already take reduced damage too, not just their combat units. These two pin that
// already-live behavior against the two structures the proposal calls out by name: a turret (the
// static defense a raid has to punch through) and a Habitat (hp 250, the softest raid target).
test("Reinforced Plating reduces damage taken by a defended turret, not just combat units", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const turret = makeBuilding("turret", "ai", 510, 500);   // same stand-off faceOff uses for its unit-target sibling above
  state.units.set(attacker.id, attacker);
  state.buildings.set(turret.id, turret);
  state.players.ai.upgrades.reinforcedPlating = true;   // the turret owner's research, not the attacker's
  const startHp = turret.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const { damageTakenMult } = UPGRADES.reinforcedPlating;
  assert.ok(Math.abs((startHp - turret.hp) - UNITS.skiff.attack * damageTakenMult) < 1e-9,
    "a Bulwark-researched turret takes reduced damage exactly like a combat unit would");
});

test("Reinforced Plating reduces damage taken by a defended Habitat, the softest raid target", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const habitat = makeBuilding("habitat", "ai", 510, 500);
  state.units.set(attacker.id, attacker);
  state.buildings.set(habitat.id, habitat);
  state.players.ai.upgrades.reinforcedPlating = true;
  const startHp = habitat.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  const { damageTakenMult } = UPGRADES.reinforcedPlating;
  assert.ok(Math.abs((startHp - habitat.hp) - UNITS.skiff.attack * damageTakenMult) < 1e-9,
    "a Habitat (hp 250) — the raid target supply chokes on — is shielded by Bulwark too");
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

test("a turret's target that dies to someone else earlier the same tick is dropped, not deref'd — it re-acquires cleanly instead of freezing", () => {
  // The mobile-unit analog: "an explicit attack order on a target killed by someone else
  // re-acquires instead of freezing" above. A turret has no order pipeline, but building.targetId
  // is the same kind of persisted, potentially-stale reference — this simulates it having locked
  // onto `stale` on some earlier pass, then `stale` dying to a DIFFERENT attacker before the
  // turret's own updateBuildingCombat runs this tick.
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const stale = makeUnit("skiff", "ai", turret.x + 10, turret.y);
  state.units.set(stale.id, stale);
  turret.targetId = stale.id;          // simulate the turret already locked onto this target
  state.units.delete(stale.id);        // simulate it dying to a different attacker earlier this same tick

  const other = makeUnit("skiff", "ai", turret.x + 15, turret.y);   // a fresh live enemy still in range
  state.units.set(other.id, other);
  const startHp = other.hp;

  updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown);

  assert.equal(turret.targetId, other.id, "re-acquired the live enemy instead of keeping/deref'ing the dead one");
  assert.ok(other.hp < startHp, "and actually landed a hit on it, same tick");
  assert.ok(Number.isFinite(other.hp), "no NaN-poisoning from a stale dereferenced target");
});

test("a turret whose only target dies to someone else earlier the same tick goes idle, not stuck referencing the corpse", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = turretAt(state);
  const stale = makeUnit("skiff", "ai", turret.x + 10, turret.y);
  state.units.set(stale.id, stale);
  turret.targetId = stale.id;
  state.units.delete(stale.id);   // dies to someone else, and nothing else is left in range

  assert.doesNotThrow(() => updateBuildingCombat(state, turret, BUILDINGS.turret.cooldown));
  assert.equal(turret.targetId, null, "cleanly falls back to idle rather than holding the stale id");
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

// ---- Broad-phase grid: every test above drives acquireTarget through the O(n)
// fallback (no state.unitGrid at all). Real gameplay never does that — sim.js
// builds state.unitGrid every tick before combat runs — so acquireTarget's grid
// branch (queryNeighbors, engine/grid.js) needs its own coverage too.

test("acquireTarget finds an enemy through the populated broad-phase grid, across a cell boundary — not just when both units share one cell", () => {
  // engine/grid.js's CELL is 96: placing the pair 90 apart straddles the
  // column-10/11 boundary, so a broken or silently-skipped neighbor-cell query
  // (unlike the same-cell placements every other test in this file happens to
  // use) would miss this target while the O(n) fallback still finds it fine.
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 1000, 500);   // grid column 10
  const target = makeUnit("skiff", "ai", 1090, 500);         // grid column 11 — 90 away: inside aggro (120), outside weapon range (40)
  state.units.set(attacker.id, attacker);
  state.units.set(target.id, target);
  state.unitGrid = buildUnitGrid(state);   // the real per-tick broad-phase index (engine/grid.js), same as sim.js builds every tick

  updateCombat(state, attacker, 0.1);

  assert.equal(attacker.autoTarget, target.id, "the target should be acquired through the grid, same as the fallback tests above establish");
  assert.ok(attacker.x > 1000, "and immediately start closing the distance, exactly like the no-grid case");
});

// ---- Terrain's combatMult: test/terrain.test.js only checks it as static
// TERRAIN table data. Nothing before this exercised it in a live attack.

test("terrain's combatMult is genuinely applied to a live attack, not just read as static data", () => {
  // Baseline: ferros carries no terrain (test/terrain.test.js) — every cell
  // samples combatMult 1, so this is exactly the plain-base-damage case every
  // other exact-damage test in this file already assumes.
  const flat = createGameState({ planetId: "ferros" });
  const [flatAttacker, flatTarget] = faceOff(flat, 500, 500);
  const flatStartHp = flatTarget.hp;
  updateCombat(flat, flatAttacker, UNITS.skiff.cooldown);
  const flatDamage = flatStartHp - flatTarget.hp;
  assert.equal(flatDamage, UNITS.skiff.attack, "fixture sanity: flat ground deals plain base damage");

  // Pyralis' central mesa is high ground (test/terrain.test.js): the attacker
  // stands ON it, the target just beside it — combatMult is read from the
  // ATTACKER's own position (engine/combat.js attackDamage), a positional edge
  // for whoever holds the high ground, not a per-target check.
  const high = createGameState({ planetId: "pyralis" });
  const map = high.map;
  const attacker = makeUnit("skiff", "player", map.width * 0.5, map.height * 0.5);
  const target = makeUnit("skiff", "ai", map.width * 0.5 + 10, map.height * 0.5);
  high.units.set(attacker.id, attacker);
  high.units.set(target.id, target);
  const tile = sampleTerrain(map.terrain, attacker.x, attacker.y);
  assert.equal(tile.name, "high", "fixture sanity: the attacker is standing on the mesa");
  const highStartHp = target.hp;

  updateCombat(high, attacker, UNITS.skiff.cooldown);

  const highDamage = highStartHp - target.hp;
  const expected = UNITS.skiff.attack * tile.combatMult;   // documented as 1.15 (engine/map.js TERRAIN.high)
  assert.ok(Math.abs(highDamage - expected) < 1e-9, `expected exactly ${expected} from the high-ground multiplier, got ${highDamage}`);
  assert.ok(highDamage > flatDamage, "and that's strictly more than the flat-ground baseline");
});

// ---- High ground extends weapon acquisition, not just fog sight: fog reveal already
// scales by the source tile's terrain sightMult (engine/fog.js updateFog srcMult), but
// aggro (acquireTarget/stillEngageable) only ever multiplied by the sideMod sightMult,
// never terrain — so a unit on a mesa/ridge could SEE an enemy it refused to ENGAGE.
// Nothing before this exercised aggro range against terrain at all.

test("a unit on high ground acquires a fresh target beyond its flat-ground aggro range; the same distance on open ground does not", () => {
  // helix's central ridge is high ground (engine/map.js PLANET_MODIFIERS.helix) with NO
  // world-level sightMult of its own (unlike pyralis/nimbus above), so the only aggro
  // multiplier in play is the terrain one — isolates this fix from the pre-existing
  // sideMod(sightMult) path this file's other tests already cover.
  // Skiff aggroRange 120 * TERRAIN.high.sightMult 1.25 = 150.
  const D = 135;   // strictly beyond flat aggro (120), strictly inside high-ground aggro (150)

  const flat = createGameState({ planetId: "ferros" });   // no terrain at all -> sightMult/combatMult both 1 everywhere
  const flatAttacker = makeUnit("skiff", "player", 500, 500);
  const flatTarget = makeUnit("skiff", "ai", 500 + D, 500);
  flat.units.set(flatAttacker.id, flatAttacker);
  flat.units.set(flatTarget.id, flatTarget);
  updateCombat(flat, flatAttacker, 0.1);
  assert.equal(flatAttacker.autoTarget, null, "flat ground: the target sits beyond the un-extended aggro range");

  const high = createGameState({ planetId: "helix" });
  const map = high.map;
  const highAttacker = makeUnit("skiff", "player", map.width * 0.5, map.height * 0.5);
  const highTarget = makeUnit("skiff", "ai", map.width * 0.5 + D, map.height * 0.5);
  high.units.set(highAttacker.id, highAttacker);
  high.units.set(highTarget.id, highTarget);
  const tile = sampleTerrain(map.terrain, highAttacker.x, highAttacker.y);
  assert.equal(tile.name, "high", "fixture sanity: the attacker is standing on the ridge");

  updateCombat(high, highAttacker, 0.1);
  assert.equal(highAttacker.autoTarget, highTarget.id, "high ground: the identical distance is now inside the terrain-extended aggro range");
});

test("stillEngageable also folds in terrain: a high-ground unit keeps its already-locked target instead of switching to a closer one", () => {
  const D = 135;   // beyond flat aggro (120), inside this attacker's high-ground aggro (150)
  const high = createGameState({ planetId: "helix" });
  const map = high.map;
  const attacker = makeUnit("skiff", "player", map.width * 0.5, map.height * 0.5);
  // Locked from a (simulated) previous tick, out at the terrain-extended range.
  const lockedTarget = makeUnit("skiff", "ai", map.width * 0.5 + D, map.height * 0.5);
  // Well within the FLAT aggro range too — what acquireTarget would prefer if stillEngageable
  // ever fell through to it (nearer target, unmodified by the fix being tested here).
  const closerTarget = makeUnit("skiff", "ai", map.width * 0.5 + 60, map.height * 0.5);
  high.units.set(attacker.id, attacker);
  high.units.set(lockedTarget.id, lockedTarget);
  high.units.set(closerTarget.id, closerTarget);
  attacker.autoTarget = lockedTarget.id;

  updateCombat(high, attacker, 0.1);

  assert.equal(attacker.autoTarget, lockedTarget.id,
    "stillEngageable's own terrain-extended aggro holds the original lock, rather than falling through to acquireTarget and picking the closer enemy");
});

// ---- anvilAura (the Aegis's guardAura): reduces damage taken by allies inside
// its bubble. Nothing before this landed a real hit through it.

test("a friendly Aegis's cryo-armour aura reduces damage taken by exactly its documented multiplier", () => {
  const unshielded = createGameState({ planetId: "ferros" });
  const [attacker1, target1] = faceOff(unshielded, 500, 500);
  const startHp1 = target1.hp;
  updateCombat(unshielded, attacker1, UNITS.skiff.cooldown);
  const unshieldedDamage = startHp1 - target1.hp;

  const shielded = createGameState({ planetId: "ferros" });
  const attacker2 = makeUnit("skiff", "player", 500, 500);
  const target2 = makeUnit("skiff", "ai", 500 + UNITS.skiff.range - 1, 500);   // within melee range, as faceOff would place it
  // Well within the target's 96-range guardAura, but past the attacker's own aggro
  // range (120) — otherwise it's a second enemy inside spreadEnemy's local band and
  // the attacker sometimes fans onto the Aegis itself instead of the intended target.
  const aegis = makeUnit("aegis", "ai", target2.x + 90, target2.y);
  shielded.units.set(attacker2.id, attacker2);
  shielded.units.set(target2.id, target2);
  shielded.units.set(aegis.id, aegis);
  collectAnvils(shielded);   // sim.js's per-tick anvil snapshot that combat.js's attackDamage reads (engine/sim.js)
  const startHp2 = target2.hp;

  updateCombat(shielded, attacker2, UNITS.skiff.cooldown);

  const shieldedDamage = startHp2 - target2.hp;
  const { damageTakenMult } = UNITS.aegis.guardAura;
  const expected = UNITS.skiff.attack * damageTakenMult;
  assert.ok(Math.abs(shieldedDamage - expected) < 1e-9, `expected exactly ${expected} with the Aegis's damage-taken multiplier applied, got ${shieldedDamage}`);
  assert.ok(shieldedDamage < unshieldedDamage, "and that's strictly less than the same attack against an unshielded target");
});

test("the Aegis's aura doesn't shield itself — the source's explicit exclusion, so it can still be focused down", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "player", 500, 500);
  const aegis = makeUnit("aegis", "ai", 500 + UNITS.skiff.range - 1, 500);   // within melee range, and trivially within its OWN aura (distance 0)
  state.units.set(attacker.id, attacker);
  state.units.set(aegis.id, aegis);
  collectAnvils(state);
  const startHp = aegis.hp;

  updateCombat(state, attacker, UNITS.skiff.cooldown);

  assert.equal(startHp - aegis.hp, UNITS.skiff.attack,
    "full damage landed — an Aegis standing inside its own aura radius doesn't reduce its own damage taken");
});
