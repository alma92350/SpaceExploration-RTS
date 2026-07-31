import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { updateCombat } from "../engine/combat.js";
import { tick } from "../engine/sim.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { POWER_TIERS } from "../engine/industry.js";
import { detonateBomb, detonateIfAttacked, checkBombProximity, updateBombFuse, lightFuse, updateCraters, bombDamageAt,
         BOMB_BLAST_RADIUS, BOMB_CORE_RADIUS, BOMB_MAX_DAMAGE, BOMB_DETECT_RANGE, BOMB_FUSE_DELAY,
         CRATER_SPAWN_DELAY, CRATER_NODE_AMOUNT, CRATER_COMMODITIES } from "../engine/bomb.js";
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

/* ---------- the fuse: BOMB_FUSE_DELAY between a trigger and the actual blast ---------- */

test("BOMB_DETECT_RANGE is exactly BOMB_CORE_RADIUS — you have to be point-blank to trip the fuse", () => {
  assert.equal(BOMB_DETECT_RANGE, BOMB_CORE_RADIUS);
});

test("lightFuse timestamps the detonation BOMB_FUSE_DELAY sim-seconds out, and is idempotent", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 3000, 3000);
  state.units.set(bomb.id, bomb);

  lightFuse(state, bomb);
  assert.equal(bomb.fuseUntil, state.time + BOMB_FUSE_DELAY);
  assert.ok(state.units.has(bomb.id), "lighting the fuse doesn't detonate it on the spot");

  const firstFuseUntil = bomb.fuseUntil;
  state.time += 1;
  lightFuse(state, bomb);   // re-triggering an already-lit fuse
  assert.equal(bomb.fuseUntil, firstFuseUntil, "the clock isn't restarted");

  const fused = state.events.filter(e => e.type === "bombFused");
  assert.equal(fused.length, 1, "the fuse-lit event fires once, not on every re-trigger");
});

test("updateBombFuse detonates once state.time reaches fuseUntil, not a moment before", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 3000, 3000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  lightFuse(state, bomb);

  state.time += BOMB_FUSE_DELAY - 0.01;
  assert.ok(updateBombFuse(state, bomb), "still committed/fused — nothing left for it to do this tick");
  assert.ok(state.units.has(bomb.id), "not due yet");

  state.time += 0.01;
  assert.ok(updateBombFuse(state, bomb));
  assert.ok(!state.units.has(bomb.id), "the timer came due — it actually detonated");
});

/* ---------- trigger 2: enemy presence lights the fuse (doesn't detonate on the spot) ---------- */

test("an ARMED bomb lights its fuse — but does NOT detonate yet — the instant a live enemy comes within BOMB_DETECT_RANGE", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2000 + BOMB_DETECT_RANGE - 2, 2000);
  state.units.set(enemy.id, enemy);

  assert.ok(checkBombProximity(state, bomb), "proximity check reports it lit the fuse");
  assert.ok(state.units.has(bomb.id), "still here — the blast is delayed, not instant");
  assert.equal(bomb.fuseUntil, state.time + BOMB_FUSE_DELAY);
});

test("an enemy close enough to trigger AND be caught in the eventual blast dies once the fuse comes due", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2000 + 10, 2000);   // well inside both DETECT_RANGE and the core
  state.units.set(enemy.id, enemy);

  assert.ok(checkBombProximity(state, bomb));
  assert.ok(state.units.has(enemy.id), "the fuse is only lit so far — nobody's died yet");

  state.time += BOMB_FUSE_DELAY;
  updateBombFuse(state, bomb);
  assert.ok(!state.units.has(enemy.id), "close enough to trigger it is close enough to die once it actually blows");
});

test("an ARMED bomb does NOT light its fuse from an enemy just outside BOMB_DETECT_RANGE", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  // Measured to the enemy's own RIM (engine/bomb.js), so "just outside" has to clear its own
  // radius too, not just BOMB_DETECT_RANGE from the bomb's bare center.
  const enemy = makeUnit("worker", "ai", 2000 + BOMB_DETECT_RANGE + UNITS.worker.radius + 5, 2000);   // just outside
  state.units.set(enemy.id, enemy);

  assert.equal(checkBombProximity(state, bomb), false);
  assert.equal(bomb.fuseUntil, undefined);
  assert.ok(state.units.has(bomb.id));
  assert.ok(state.units.has(enemy.id));
});

test("an ARMED bomb's fuse also lights from a nearby ENEMY BUILDING, not just units", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemyBase = makeBuilding("command", "ai", 2000 + 10, 2000);   // well within both ranges
  state.buildings.set(enemyBase.id, enemyBase);

  assert.ok(checkBombProximity(state, bomb));
  assert.ok(state.buildings.has(enemyBase.id), "not yet — only the fuse is lit");
  state.time += BOMB_FUSE_DELAY;
  updateBombFuse(state, bomb);
  assert.ok(!state.buildings.has(enemyBase.id));
});

test("a CONSTRUCTING enemy building within BOMB_DETECT_RANGE does NOT trip the proximity fuse — checkBombProximity explicitly skips it", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemyBase = makeBuilding("command", "ai", 2000 + 10, 2000, { constructing: true });   // well within both ranges, but unfinished
  state.buildings.set(enemyBase.id, enemyBase);

  assert.equal(checkBombProximity(state, bomb), false, "a building still under construction can't trip the fuse");
  assert.equal(bomb.fuseUntil, undefined, "no fuse lit at all");
  assert.ok(state.units.has(bomb.id), "so the bomb never goes off from this alone");
  assert.ok(state.buildings.has(enemyBase.id), "...and the constructing building itself is untouched, for now (see the detonation test below)");
});

test("a constructing building within blast range STILL takes damage once the bomb actually detonates — the constructing skip is fuse-only, not a blast exemption", () => {
  // The asymmetry: checkBombProximity (above) treats a constructing building as invisible, but
  // detonateBomb's blast sweep (engine/bomb.js) has no such check — every building in range is
  // caught, constructing or not. Triggered here via lightFuse directly (the player's "Detonate
  // Now" — see "lightFuse arms the countdown on direct command regardless of any enemy presence
  // at all" above), which needs no enemy presence at all, so this constructing building could
  // never have been the thing that set the bomb off — and still isn't spared by the blast.
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const constructingBuilding = makeBuilding("command", "ai", 2000 + 10, 2000, { constructing: true });   // well within the core
  state.buildings.set(constructingBuilding.id, constructingBuilding);

  lightFuse(state, bomb);
  state.time += BOMB_FUSE_DELAY;
  updateBombFuse(state, bomb);

  assert.ok(!state.buildings.has(constructingBuilding.id),
    "the constructing building was caught in the actual blast sweep despite being unable to have triggered it itself");
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

test("a full tick() loop: proximity lights the fuse, and the blast lands BOMB_FUSE_DELAY sim-seconds later — the real integration path", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 2000, 2000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  const enemy = makeUnit("worker", "ai", 2000 + 10, 2000);
  state.units.set(enemy.id, enemy);

  tick(state, 0.1);
  assert.ok(state.units.has(bomb.id), "the fuse only just lit this tick — no blast yet");
  assert.ok(state.units.has(enemy.id));

  // 20 Hz fixed step (see engine/loop.js) — enough ticks to cross the fuse delay. A fused
  // bomb takes no more orders and sits put (asserted below), but the enemy that tripped it
  // is a normal AI-controlled unit and free to wander off during those 4 real sim-seconds —
  // so its eventual fate isn't asserted here (a dedicated, non-AI-driven test above already
  // covers "close enough to trigger it is close enough to die to it" deterministically).
  const dt = 0.05;
  for (let i = 0; i < Math.ceil(BOMB_FUSE_DELAY / dt) + 1; i++) tick(state, dt);

  assert.ok(!state.units.has(bomb.id), "the fuse came due — it actually went off");
});

/* ---------- trigger 3: player-triggered (also lights the fuse, not an instant blast) ---------- */

test("lightFuse arms the countdown on direct command regardless of any enemy presence at all", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 3000, 3000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);   // nothing else nearby

  lightFuse(state, bomb);

  assert.ok(state.units.has(bomb.id), "the fuse is lit, but it hasn't blown yet");
  assert.equal(bomb.fuseUntil, state.time + BOMB_FUSE_DELAY);
});

test("detonateBomb still fires immediately when called directly — the underlying blast itself is unchanged", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 3000, 3000);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);

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

/* ---------- the blast itself: distance-squared damage falloff ---------- */

test("BOMB_CORE_RADIUS is exactly 1.5x the bomb unit's own footprint", () => {
  assert.equal(BOMB_CORE_RADIUS, UNITS.heliumbomb.radius * 1.5);
});

test("bombDamageAt: flat peak damage inside the core, inverse-square falloff beyond it, zero past the blast radius", () => {
  assert.equal(bombDamageAt(0), BOMB_MAX_DAMAGE, "ground zero itself takes the peak hit");
  assert.equal(bombDamageAt(BOMB_CORE_RADIUS), BOMB_MAX_DAMAGE, "still full damage exactly at the core boundary");
  assert.equal(bombDamageAt(BOMB_CORE_RADIUS / 2), BOMB_MAX_DAMAGE, "inside the core the curve is clamped flat, not left to diverge");

  // Distance-SQUARED decay referenced off BOMB_CORE_RADIUS: doubling the distance past the
  // core should quarter the damage, tripling it should cut damage to a ninth.
  const at2x = bombDamageAt(BOMB_CORE_RADIUS * 2);
  const at3x = bombDamageAt(BOMB_CORE_RADIUS * 3);
  assert.ok(Math.abs(at2x - BOMB_MAX_DAMAGE / 4) < 1e-9, `2x core distance should be ~1/4 damage, got ${at2x}`);
  assert.ok(Math.abs(at3x - BOMB_MAX_DAMAGE / 9) < 1e-9, `3x core distance should be ~1/9 damage, got ${at3x}`);

  assert.ok(bombDamageAt(BOMB_BLAST_RADIUS) > 0, "still some token damage right at the edge of the blast radius");
  assert.equal(bombDamageAt(BOMB_BLAST_RADIUS + 0.01), 0, "nothing at all past the blast radius");
});

test("ground zero (within BOMB_CORE_RADIUS) still kills everything outright, ANY owner — indiscriminate", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);

  const ownWorker = makeUnit("worker", "player", 4005, 4000);            // friendly, well within the core
  const enemyWorker = makeUnit("worker", "ai", 4000, 4010);              // enemy, well within the core
  const ownBuilding = makeBuilding("command", "player", 4000, 3986);     // friendly, 1000hp — but at dist 14, inside the core
  const enemyBuilding = makeBuilding("barracks", "ai", 3985, 4000);      // enemy, at dist 15 — exactly the core boundary
  for (const u of [ownWorker, enemyWorker]) state.units.set(u.id, u);
  for (const b of [ownBuilding, enemyBuilding]) state.buildings.set(b.id, b);

  detonateBomb(state, bomb);

  assert.ok(!state.units.has(ownWorker.id), "the bomb owner's own worker dies too — indiscriminate");
  assert.ok(!state.units.has(enemyWorker.id));
  assert.ok(!state.buildings.has(ownBuilding.id), "even the owner's own 1000hp Command Center dies at ground zero");
  assert.ok(!state.buildings.has(enemyBuilding.id));
});

test("a bomb detonated at a Command Center's wall (physical contact) kills it outright — the documented one-shot, now geometrically reachable", () => {
  // engine/bomb.js's own header claims the peak blast "one-shots even the toughest building in
  // the game (the Antimatter Gate, 1200hp)". At physical contact, the bomb's own footprint
  // (radius 10) and the CC's (radius 26) are touching — 36 apart center-to-center — which used to
  // sit well outside BOMB_CORE_RADIUS (15) measured from the bomb's bare center. Rim-measured, the
  // CC's own radius is subtracted back off, landing it inside the core after all.
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);
  const wallContact = UNITS.heliumbomb.radius + BUILDINGS.command.radius;   // 10 + 26 = 36
  const cc = makeBuilding("command", "ai", 4000 + wallContact, 4000);
  state.buildings.set(cc.id, cc);

  detonateBomb(state, bomb);

  assert.ok(!state.buildings.has(cc.id), "a bomb touching the Command Center's wall now lands in the peak band and one-shots it");
});

test("further from ground zero, damage falls off — a fragile unit dies where a tough building only takes a scratch", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);

  const dist = 90;
  const worker = makeUnit("worker", "ai", 4000 + dist, 4000);            // 40hp
  const command = makeBuilding("command", "ai", 4000, 4000 + dist);      // 1000hp, same CENTER distance
  state.units.set(worker.id, worker);
  state.buildings.set(command.id, command);
  // Damage is measured to each victim's RIM, not its center (engine/bomb.js) — the command
  // building's own 26-radius footprint eats into that 90, so its ACTUAL damage differs from a
  // same-center-distance worker's, even though both were placed the same 90 from the bomb's center.
  const expectedDmg = bombDamageAt(dist - command.radius);

  detonateBomb(state, bomb);

  assert.ok(!state.units.has(worker.id), "40hp worker doesn't survive this far out");
  assert.ok(state.buildings.has(command.id), "1000hp Command Center survives the same distance");
  const survivor = state.buildings.get(command.id);
  assert.ok(Math.abs(survivor.hp - (1000 - expectedDmg)) < 1e-6, "took real, partial damage — not untouched, not erased");
});

test("something well past the blast radius survives completely untouched", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);
  // Measured to the worker's own RIM (engine/bomb.js), so "past the blast radius" has to clear
  // its own radius too, not just BOMB_BLAST_RADIUS from the bomb's bare center.
  const safe = makeUnit("worker", "ai", 4000 + BOMB_BLAST_RADIUS + UNITS.worker.radius + 5, 4000);
  state.units.set(safe.id, safe);

  detonateBomb(state, bomb);

  assert.ok(state.units.has(safe.id), "past the blast radius — untouched");
  assert.equal(state.units.get(safe.id).hp, safe.hp, "not even scratched");
});

test("right at the ragged edge of the blast radius, a fragile unit only takes a scratch — not necessarily lethal", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 4000, 4000);
  state.units.set(bomb.id, bomb);
  const dist = BOMB_BLAST_RADIUS - 5;
  const edge = makeUnit("worker", "ai", 4000 + dist, 4000);
  state.units.set(edge.id, edge);
  // Rim distance, not center — the worker's own (small) radius still shaves a bit off dist.
  const expectedDmg = bombDamageAt(dist - UNITS.worker.radius);

  detonateBomb(state, bomb);

  assert.ok(state.units.has(edge.id), "the tapering tail of the blast isn't lethal to a full-hp worker this far out");
  assert.ok(Math.abs(state.units.get(edge.id).hp - (40 - expectedDmg)) < 1e-6);
});

test("a blast-killed entity leaves wreckage just like an ordinary kill — but still no INSTANT refund either way", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 5000, 5000);
  state.units.set(bomb.id, bomb);
  const skiff = makeUnit("skiff", "ai", 5010, 5000);   // well within the core — guaranteed kill
  state.units.set(skiff.id, skiff);
  const resourcesBefore = { ...state.players.ai.resources };

  detonateBomb(state, bomb);

  assert.ok(!state.units.has(skiff.id), "sanity check: it actually died");
  assert.deepEqual(state.players.ai.resources, resourcesBefore, "no instant refund — that mechanic is gone entirely, blast or not");
  assert.ok(state.wrecks.some(w => Math.abs((w.goods.ore || 0) - UNITS.skiff.cost.ore * 0.8) < 1e-9),
    "it now leaves its own minable wreckage, same as an ordinary combat kill (engine/wreckage.js)");
});

/* ---------- terraforming: the crater matures into a mineable deposit ---------- */

test("detonation schedules a crater at the blast site, maturing CRATER_SPAWN_DELAY later", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);

  detonateBomb(state, bomb);

  assert.equal(state.craters.length, 1);
  const crater = state.craters[0];
  assert.equal(crater.x, 800);
  assert.equal(crater.y, 800);
  assert.equal(crater.owner, "player");
  assert.equal(crater.spawnAt, state.time + CRATER_SPAWN_DELAY);
});

test("no deposit exists before the crater's timer comes due", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  const craterId = state.craters[0].id;

  state.time += CRATER_SPAWN_DELAY - 1;
  updateCraters(state);

  assert.equal(state.craters.length, 1, "still pending — not due yet");
  assert.ok(!state.map.nodesById.has(craterId));
});

test("the crater matures into a real, mineable Raw-tier deposit once its timer comes due", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  const craterId = state.craters[0].id;

  state.time += CRATER_SPAWN_DELAY;
  updateCraters(state);

  assert.equal(state.craters.length, 0, "the pending entry is consumed");
  const node = state.map.nodesById.get(craterId);
  assert.ok(node, "a real node now exists at the crater's id");
  assert.equal(node.x, 800);
  assert.equal(node.y, 800);
  assert.equal(node.amount, CRATER_NODE_AMOUNT);
  assert.equal(node.max, CRATER_NODE_AMOUNT);
  assert.ok(node.crater, "tagged so persist.js knows to fully serialize it");
  assert.ok(CRATER_COMMODITIES.includes(node.com), "the commodity is one of the Raw-tier pool");
  assert.equal(COM[node.com].tier, "Raw");
  assert.ok(state.map.nodes.includes(node), "also present in the plain nodes array gather.js/rendering iterate");
});

test("the commodity choice is deterministic — same crater id, same roll, every time", () => {
  const runOnce = () => {
    const state = createGameState({ planetId: "ferros", endless: true, seed: 99 });
    const bomb = makeUnit("heliumbomb", "player", 700, 700);
    // Force a specific, reproducible id so both runs schedule an identically-id'd crater
    // (a fresh game normally mints a different unit id each run via the module-global counter).
    bomb.id = "u-fixed-for-test";
    state.units.set(bomb.id, bomb);
    detonateBomb(state, bomb);
    state.time += CRATER_SPAWN_DELAY;
    updateCraters(state);
    return state.map.nodesById.get("crater-u-fixed-for-test").com;
  };
  assert.equal(runOnce(), runOnce(), "the same crater id always rolls the same commodity");
});

test("a full tick() loop matures a crater on schedule — the real integration path", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  const craterId = state.craters[0].id;

  // 20 Hz fixed step (see engine/loop.js) — enough ticks to cross CRATER_SPAWN_DELAY.
  const dt = 0.05;
  for (let i = 0; i < Math.ceil(CRATER_SPAWN_DELAY / dt) + 1; i++) tick(state, dt);

  assert.ok(state.map.nodesById.has(craterId), "matured for real, through the actual per-tick path");
  assert.equal(state.craters.length, 0);
});

test("a worker can actually mine the crater's deposit once it matures", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  state.time += CRATER_SPAWN_DELAY;
  updateCraters(state);
  const node = [...state.map.nodesById.values()].find(n => n.crater);

  const worker = makeUnit("worker", "player", node.x + 5, node.y);
  state.units.set(worker.id, worker);
  worker.order = { type: "gather", nodeId: node.id };
  const startAmount = node.amount;

  for (let i = 0; i < 50; i++) tick(state, 0.05);

  assert.ok(node.amount < startAmount || worker.cargo.qty > 0, "the worker actually extracted from the crater deposit");
});

/* ---------- crater persistence ---------- */

test("a PENDING crater (not yet matured) survives save/load and still matures on schedule after loading", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  const craterId = state.craters[0].id;
  const spawnAt = state.craters[0].spawnAt;

  const loaded = deserializeGame(serializeGame(state));
  assert.equal(loaded.craters.length, 1);
  assert.deepEqual(
    { id: loaded.craters[0].id, x: loaded.craters[0].x, y: loaded.craters[0].y, owner: loaded.craters[0].owner, spawnAt: loaded.craters[0].spawnAt },
    { id: craterId, x: 800, y: 800, owner: "player", spawnAt }
  );

  loaded.time = spawnAt;
  updateCraters(loaded);
  assert.ok(loaded.map.nodesById.has(craterId), "still matures correctly after a load");
});

test("a MATURED crater node survives save/load — it isn't part of the seed-regenerated map", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  state.time += CRATER_SPAWN_DELAY;
  updateCraters(state);
  const original = [...state.map.nodesById.values()].find(n => n.crater);

  const loaded = deserializeGame(serializeGame(state));
  const restored = loaded.map.nodesById.get(original.id);
  assert.ok(restored, "the crater node was NOT silently dropped by the seed regeneration");
  assert.equal(restored.com, original.com);
  assert.equal(restored.amount, original.amount);
  assert.equal(restored.max, original.max);
  assert.equal(restored.x, original.x);
  assert.equal(restored.y, original.y);
  assert.ok(loaded.map.nodes.includes(restored), "present in the plain nodes array too, not just nodesById");
});

test("a partially-mined crater node's REMAINING amount survives save/load, not its original max", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  state.time += CRATER_SPAWN_DELAY;
  updateCraters(state);
  const node = [...state.map.nodesById.values()].find(n => n.crater);
  node.amount = 123.5;   // simulate partial mining

  const loaded = deserializeGame(serializeGame(state));
  assert.equal(loaded.map.nodesById.get(node.id).amount, 123.5);
});

test("a tampered/malformed craters save is dropped gracefully rather than crashing the load", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  const save = serializeGame(state);

  save.craters.push({ id: "crater-evil", x: 100, y: 100, owner: "nobody", spawnAt: 10 });   // bogus owner
  save.craters.push("not even an object");
  save.craters.push({ id: "crater-huge", x: 1e12, y: -1e12, owner: "player", spawnAt: "soon" });   // garbage coords/time

  const loaded = deserializeGame(save);
  assert.ok(!loaded.craters.some(c => c.owner === "nobody"), "bogus-owner entry dropped");
  const huge = loaded.craters.find(c => c.id === "crater-huge");
  assert.ok(huge, "the garbage-coordinate entry survives, sanitized rather than dropped outright");
  assert.ok(Number.isFinite(huge.x) && huge.x >= 0 && huge.x <= loaded.map.width, "x clamped onto the map");
  assert.ok(Number.isFinite(huge.y) && huge.y >= 0 && huge.y <= loaded.map.height, "y clamped onto the map");
  assert.ok(Number.isFinite(huge.spawnAt), "non-numeric spawnAt coerced to a finite number");
});

test("a tampered crater NODE (not the pending list) is sanitized on load — bogus commodity dropped", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 800, 800);
  state.units.set(bomb.id, bomb);
  detonateBomb(state, bomb);
  state.time += CRATER_SPAWN_DELAY;
  updateCraters(state);
  const save = serializeGame(state);
  const savedNode = save.nodes.find(n => n.crater);
  savedNode.com = "not-a-real-commodity";

  const loaded = deserializeGame(save);
  assert.ok(!loaded.map.nodesById.has(savedNode.id), "a crater node with a bogus commodity is not restored at all");
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

test("a lit fuse survives a save/load round-trip, and still detonates on schedule after loading", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  lightFuse(state, bomb);
  const fuseUntil = bomb.fuseUntil;

  const loaded = deserializeGame(serializeGame(state));
  const loadedBomb = loaded.units.get(bomb.id);
  assert.equal(loadedBomb.fuseUntil, fuseUntil);

  loaded.time = fuseUntil;
  assert.ok(updateBombFuse(loaded, loadedBomb));
  assert.ok(!loaded.units.has(bomb.id), "still detonates right on schedule after the reload");
});

test("a tampered fuseUntil field is dropped (not coerced) when it isn't a finite number", () => {
  const state = createGameState({ planetId: "ferros", endless: true });
  const bomb = makeUnit("heliumbomb", "player", 500, 500);
  bomb.armed = true;
  state.units.set(bomb.id, bomb);
  lightFuse(state, bomb);
  const save = serializeGame(state);
  const savedBomb = save.units.find(u => u.id === bomb.id);
  savedBomb.fuseUntil = "soon-ish";   // a hand-edited save smuggling in garbage

  const loaded = deserializeGame(save);
  assert.equal(loaded.units.get(bomb.id).fuseUntil, undefined, "dropped, not left as a NaN-poisoning string");
});
