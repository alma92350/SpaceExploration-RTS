import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { updateCombat } from "../engine/combat.js";
import { tick } from "../engine/sim.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { POWER_TIERS } from "../engine/industry.js";
import { detonateBomb, detonateIfAttacked, checkBombProximity, BOMB_BLAST_RADIUS, BOMB_DETECT_RANGE } from "../engine/bomb.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { queueProduction } from "../engine/production.js";
import { COM } from "../data.js";

test("the Helium Bomb is costed in helium (gas/Helium-3), antimatter, and plasma (Plasma Torpedoes)", () => {
  const def = UNITS.heliumbomb;
  assert.deepEqual(Object.keys(def.cost).sort(), ["antimatter", "gas", "plasmatorp"]);
  for (const com of Object.keys(def.cost)) assert.ok(COM[com], `${com} is a real commodity`);
  assert.equal(def.requires[0], "stardock");
  assert.equal(def.odysseyOnly, true, "strategic-goods cost means it only makes sense in Odyssey");
  assert.equal(BUILDINGS.stardock.produces.includes("heliumbomb"), true, "buildable at the Star Dock");
});

test("BOMB_BLAST_RADIUS is exactly a power station's first (on-grid) circle — POWER_TIERS[0]", () => {
  assert.equal(BOMB_BLAST_RADIUS, POWER_TIERS[0].max);
  assert.equal(POWER_TIERS[0].name, "linked", "sanity check: tier 0 really is the innermost/on-grid band");
});

test("a freshly built bomb is unarmed", () => {
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  assert.ok(!bomb.armed);
});

/* ---------- trigger 1: attacked ---------- */

test("an ARMED bomb detonates the instant it's attacked, instead of taking damage", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const attacker = makeUnit("skiff", "ai", 505, 500);   // well within skiff range
  state.units.set(attacker.id, attacker);

  updateCombat(state, attacker, 0);

  assert.ok(!state.units.has(bomb.id), "the bomb is gone — detonated, not merely damaged");
  assert.ok(!state.units.has(attacker.id), "the attacker was caught in its own blast (indiscriminate)");
});

test("an UNARMED bomb just takes damage like any other unit when attacked — it does NOT detonate", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  // bomb.armed left unset (unarmed)
  state.units.set(bomb.id, bomb);
  const attacker = makeUnit("skiff", "ai", 505, 500);
  state.units.set(attacker.id, attacker);
  const startHp = bomb.hp;

  updateCombat(state, attacker, 0);

  assert.ok(state.units.has(bomb.id), "the unarmed bomb survives the hit (assuming it wasn't lethal)");
  assert.ok(state.units.get(bomb.id).hp < startHp, "...but it still took normal damage");
  assert.ok(state.units.has(attacker.id), "no explosion happened, so the attacker is untouched");
});

test("detonateIfAttacked returns false (and changes nothing) for a non-bomb or an unarmed bomb", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const skiff = makeUnit("skiff", "player", 500, 500);
  state.units.set(skiff.id, skiff);
  assert.equal(detonateIfAttacked(state, skiff), false);

  const bomb = makeUnit("heliumbomb", "player", 600, 600);
  state.units.set(bomb.id, bomb);
  assert.equal(detonateIfAttacked(state, bomb), false, "unarmed — a hit must not detonate it");
  assert.ok(state.units.has(bomb.id));
});

/* ---------- trigger 2: enemy presence ---------- */

test("an ARMED bomb detonates on tick() the instant a live enemy comes within BOMB_DETECT_RANGE", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  // Just inside DETECT_RANGE but — deliberately, since detect is set past the blast radius
  // itself — just OUTSIDE BOMB_BLAST_RADIUS, so this pins the detection boundary specifically,
  // not the blast boundary (a separate test below covers an enemy close enough to be caught).
  const enemy = makeUnit("worker", "ai", 2000 + BOMB_DETECT_RANGE - 5, 2000);
  state.units.set(enemy.id, enemy);

  assert.ok(checkBombProximity(state, bomb), "proximity check reports a detonation");
  assert.ok(!state.units.has(bomb.id));
});

test("an enemy close enough to trigger AND be caught in the same blast is erased", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2000 + 10, 2000);   // well inside both DETECT_RANGE and BLAST_RADIUS
  state.units.set(enemy.id, enemy);

  assert.ok(checkBombProximity(state, bomb));
  assert.ok(!state.units.has(enemy.id), "close enough to trigger it is close enough to die to it");
});

test("an ARMED bomb does NOT detonate from an enemy just outside BOMB_DETECT_RANGE", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2000 + BOMB_DETECT_RANGE + 5, 2000);   // just outside
  state.units.set(enemy.id, enemy);

  assert.equal(checkBombProximity(state, bomb), false);
  assert.ok(state.units.has(bomb.id));
  assert.ok(state.units.has(enemy.id));
});

test("an ARMED bomb detonates from a nearby ENEMY BUILDING too, not just units", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemyBase = makeBuilding("command", "ai", 2000 + 10, 2000);   // well within both ranges
  state.buildings.set(enemyBase.id, enemyBase);

  assert.ok(checkBombProximity(state, bomb));
  assert.ok(!state.buildings.has(enemyBase.id));
});

test("an UNARMED bomb ignores enemy presence entirely, even point-blank", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2005, 2000);
  state.units.set(enemy.id, enemy);

  assert.equal(checkBombProximity(state, bomb), false);
  assert.ok(state.units.has(bomb.id));
  assert.ok(state.units.has(enemy.id));
});

test("a full tick() detonates an armed bomb from enemy proximity — the real integration path", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2000 + 10, 2000);
  state.units.set(enemy.id, enemy);

  tick(state, 0.1);

  assert.ok(!state.units.has(bomb.id));
  assert.ok(!state.units.has(enemy.id));
});

/* ---------- trigger 3: player-triggered ---------- */

test("detonateBomb fires on direct command regardless of any enemy presence at all", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 3000, 3000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);   // nothing else nearby

  detonateBomb(state, bomb);

  assert.ok(!state.units.has(bomb.id));
});

test("detonateBomb on an already-gone bomb is a harmless no-op", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 3000, 3000);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);   // first detonation removes it
  assert.doesNotThrow(() => detonateBomb(state, bomb));   // calling again on the same (now-orphaned) object
});

/* ---------- the blast itself: radius, indiscriminate, "erasing" ---------- */

test("the blast erases every unit and building within radius, ANY owner — including the bomb's own side", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);

  const ownWorker = makeUnit("worker", "player", 4050, 4000);           // friendly, well inside
  const enemyWorker = makeUnit("worker", "ai", 4000, 4050);             // enemy, well inside
  const ownBuilding = makeBuilding("command", "player", 4000, 4100);    // friendly building, inside
  const enemyBuilding = makeBuilding("barracks", "ai", 3900, 4000);     // enemy building, inside
  for (const u of [ownWorker, enemyWorker]) state.units.set(u.id, u);
  for (const b of [ownBuilding, enemyBuilding]) state.buildings.set(b.id, b);

  detonateBomb(state, bomb);

  assert.ok(!state.units.has(ownWorker.id), "the bomb owner's own worker is erased too — indiscriminate");
  assert.ok(!state.units.has(enemyWorker.id));
  assert.ok(!state.buildings.has(ownBuilding.id), "even the owner's own Command Center is erased");
  assert.ok(!state.buildings.has(enemyBuilding.id));
});

test("something just outside the blast radius survives untouched", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);
  const safe = makeUnit("worker", "ai", 4000 + BOMB_BLAST_RADIUS + 5, 4000);
  state.units.set(safe.id, safe);
  const caught = makeUnit("worker", "ai", 4000 + BOMB_BLAST_RADIUS - 5, 4000);
  state.units.set(caught.id, caught);

  detonateBomb(state, bomb);

  assert.ok(state.units.has(safe.id), "just past the blast radius — untouched");
  assert.ok(!state.units.has(caught.id), "just inside — erased");
});

test("erased entities grant no salvage — a total loss, not a normal kill", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 5000, 5000);
  state.units.set(bomb.id, bomb);
  const skiff = makeUnit("skiff", "ai", 5010, 5000);
  state.units.set(skiff.id, skiff);
  const resourcesBefore = { ...state.players.ai.resources };

  detonateBomb(state, bomb);

  assert.deepEqual(state.players.ai.resources, resourcesBefore, "no salvage was granted for the erased skiff");
});

/* ---------- production + save/load ---------- */

test("the bomb can be queued and produced at a Star Dock like any other unit", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  state.players.player.resources = { ...state.players.player.resources, gas: 1000, antimatter: 50, plasmatorp: 50 };
  // endless-mode createGameState seeds only a colony ship, no buildings — a real Command
  // Center (10 supply) is needed for the queue's supply check to have any room at all.
  const cc = makeBuilding("command", "player", 400, 400);
  state.buildings.set(cc.id, cc);
  const stardock = makeBuilding("stardock", "player", 500, 500);
  state.buildings.set(stardock.id, stardock);

  assert.ok(queueProduction(state, stardock.id, "heliumbomb"), "queues successfully with enough of the right goods");
  assert.equal(stardock.queue[0].unitType, "heliumbomb");
});

test("armed survives a save/load round-trip", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);

  const loaded = deserializeGame(serializeGame(state));
  assert.equal(loaded.units.get(bomb.id).armed, true);
});

test("a tampered armed field is coerced to a real boolean on load, not passed through raw", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  state.units.set(bomb.id, bomb);
  const save = serializeGame(state);
  const savedBomb = save.units.find(u => u.id === bomb.id);
  savedBomb.armed = "yes please";   // a hand-edited save smuggling in a non-boolean truthy value

  const loaded = deserializeGame(save);
  assert.equal(loaded.units.get(bomb.id).armed, true, "coerced to boolean true, not left as the raw string");
});
