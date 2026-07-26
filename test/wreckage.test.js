import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { updateCombat } from "../engine/combat.js";
import { tick } from "../engine/sim.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { detonateBomb } from "../engine/bomb.js";
import {
  depositWreckage, updateWreckage,
  WRECK_RETURN_FRAC, WRECK_MERGE_RADIUS, WRECK_SPAWN_DELAY, WRECK_MAX_DELAY,
  WRECK_BONUS_COMMODITIES, WRECK_BONUS_THRESHOLD, WRECK_BONUS_FRAC, WRECK_BONUS_CAP,
} from "../engine/wreckage.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

/* ---------- depositWreckage: a single death opens (or joins) a pending site ---------- */

test("a single death deposits a pending wreck site worth 80% of its cost", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 1000, 1000);
  state.units.set(worker.id, worker);

  depositWreckage(state, worker);

  assert.equal(state.wrecks.length, 1);
  const site = state.wrecks[0];
  assert.equal(site.x, 1000);
  assert.equal(site.y, 1000);
  assert.equal(site.n, 1);
  assert.equal(site.id, `wreck-${worker.id}`);
  assert.ok(Math.abs(site.goods.ore - UNITS.worker.cost.ore * WRECK_RETURN_FRAC) < 1e-9);
  assert.equal(site.spawnAt, state.time + WRECK_SPAWN_DELAY);
});

test("a multi-commodity cost recovers every commodity at the same 80%", () => {
  const state = createGameState({ planetId: "ferros" });
  const dread = makeUnit("dreadnought", "player", 2000, 2000);
  state.units.set(dread.id, dread);

  depositWreckage(state, dread);

  const site = state.wrecks[0];
  assert.ok(Math.abs(site.goods.ore - UNITS.dreadnought.cost.ore * WRECK_RETURN_FRAC) < 1e-9);
  assert.ok(Math.abs(site.goods.radioactives - UNITS.dreadnought.cost.radioactives * WRECK_RETURN_FRAC) < 1e-9);
});

test("a building's cost is recovered the same way as a unit's", () => {
  const state = createGameState({ planetId: "ferros" });
  const turret = makeBuilding("turret", "player", 1500, 1500);
  state.buildings.set(turret.id, turret);

  depositWreckage(state, turret);

  const site = state.wrecks[0];
  assert.ok(Math.abs(site.goods.ore - BUILDINGS.turret.cost.ore * WRECK_RETURN_FRAC) < 1e-9);
  assert.ok(Math.abs(site.goods.crystals - BUILDINGS.turret.cost.crystals * WRECK_RETURN_FRAC) < 1e-9);
});

test("a no-cost entity (the scenario-only Freighter) deposits nothing", () => {
  const state = createGameState({ planetId: "ferros" });
  const freighter = makeUnit("freighter", "player", 1000, 1000);
  state.units.set(freighter.id, freighter);

  depositWreckage(state, freighter);

  assert.equal(state.wrecks.length, 0);
});

/* ---------- gating the base return to what this world actually has ---------- */

test("a commodity foreign to this world is excluded from the base return", () => {
  const state = createGameState({ planetId: "ferros" });   // deposits: ore, crystals, radioactives -- no gas
  const wraith = makeUnit("wraith", "player", 1000, 1000);   // cost: { ore: 120, gas: 60 }
  state.units.set(wraith.id, wraith);

  depositWreckage(state, wraith);

  const site = state.wrecks[0];
  assert.ok(Math.abs(site.goods.ore - UNITS.wraith.cost.ore * WRECK_RETURN_FRAC) < 1e-9, "ore is native to ferros");
  assert.ok(!site.goods.gas, "gas is foreign to ferros -- excluded from the base return");
  assert.ok(Math.abs(site.value - (UNITS.wraith.cost.ore + UNITS.wraith.cost.gas)) < 1e-9,
    "but the FULL cost (including the foreign gas) still counts toward battle intensity");
});

test("a commodity that IS naturally deposited on this world still comes through the base return in full", () => {
  const state = createGameState({ planetId: "vesper" });   // deposits: ore, crystals, gas
  const wraith = makeUnit("wraith", "player", 1000, 1000);
  state.units.set(wraith.id, wraith);

  depositWreckage(state, wraith);

  const site = state.wrecks[0];
  assert.ok(Math.abs(site.goods.gas - UNITS.wraith.cost.gas * WRECK_RETURN_FRAC) < 1e-9, "gas is native to vesper -- recovered in full");
});

test("Strategic-tier costs (AI Cores, Plasma Torpedoes) are never recoverable through the base return on any world", () => {
  const state = createGameState({ planetId: "ferros" });
  const leviathan = makeUnit("leviathan", "player", 1000, 1000);   // cost: { ore: 300, ai: 3, plasmatorp: 4 }
  state.units.set(leviathan.id, leviathan);

  depositWreckage(state, leviathan);

  const site = state.wrecks[0];
  assert.ok(Math.abs(site.goods.ore - UNITS.leviathan.cost.ore * WRECK_RETURN_FRAC) < 1e-9);
  assert.ok(!site.goods.ai, "AI Cores are manufactured, never a natural surface deposit");
  assert.ok(!site.goods.plasmatorp, "Plasma Torpedoes are manufactured, never a natural surface deposit");
});

test("an entity whose ENTIRE cost is foreign still opens/merges a site -- its value counts, even with nothing reclaimable", () => {
  const state = createGameState({ planetId: "ferros" });   // no gas, no antimatter, no plasmatorp anywhere on this world
  const bomb = makeUnit("heliumbomb", "player", 1000, 1000);   // cost: { gas: 150, antimatter: 3, plasmatorp: 3 } -- all foreign
  state.units.set(bomb.id, bomb);

  depositWreckage(state, bomb);

  assert.equal(state.wrecks.length, 1, "it still opens a site");
  assert.deepEqual(state.wrecks[0].goods, {}, "but with nothing reclaimable");
  const bombCostTotal = Object.values(UNITS.heliumbomb.cost).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(state.wrecks[0].value - bombCostTotal) < 1e-9, "its value still counts toward battle intensity");
});

test("the gate isn't self-defeating: an existing wreck node of a foreign commodity doesn't 'unlock' it for later kills", () => {
  const state = createGameState({ planetId: "ferros" });
  // Directly seed a wreck node of a commodity ferros doesn't naturally deposit, simulating
  // an already-matured site elsewhere on the map -- isNaturalDeposit must ignore it.
  const foreignWreck = { id: "wreck-earlier-gas", com: "gas", amount: 10, max: 10, x: 50, y: 50, wreck: true };
  state.map.nodes.push(foreignWreck);
  state.map.nodesById.set(foreignWreck.id, foreignWreck);

  const wraith = makeUnit("wraith", "player", 2000, 2000);
  state.units.set(wraith.id, wraith);
  depositWreckage(state, wraith);

  assert.ok(!state.wrecks[0].goods.gas, "an existing WRECK node of that commodity still doesn't count as a natural deposit");
});

/* ---------- consolidation: nearby deaths pool into one site ---------- */

test("two deaths within WRECK_MERGE_RADIUS consolidate into one site", () => {
  const state = createGameState({ planetId: "ferros" });
  const w1 = makeUnit("worker", "player", 1000, 1000);
  const w2 = makeUnit("worker", "player", 1000 + WRECK_MERGE_RADIUS - 10, 1000);
  state.units.set(w1.id, w1); state.units.set(w2.id, w2);

  depositWreckage(state, w1);
  depositWreckage(state, w2);

  assert.equal(state.wrecks.length, 1, "both deaths pooled into one site");
  const site = state.wrecks[0];
  assert.equal(site.n, 2);
  assert.ok(Math.abs(site.goods.ore - UNITS.worker.cost.ore * WRECK_RETURN_FRAC * 2) < 1e-9, "goods summed across both deaths");
  assert.ok(Math.abs(site.x - (1000 + (WRECK_MERGE_RADIUS - 10) / 2)) < 1e-6, "centroid is the average of both death positions");
});

test("two deaths farther apart than WRECK_MERGE_RADIUS open separate sites", () => {
  const state = createGameState({ planetId: "ferros" });
  const w1 = makeUnit("worker", "player", 1000, 1000);
  const w2 = makeUnit("worker", "player", 1000 + WRECK_MERGE_RADIUS + 10, 1000);
  state.units.set(w1.id, w1); state.units.set(w2.id, w2);

  depositWreckage(state, w1);
  depositWreckage(state, w2);

  assert.equal(state.wrecks.length, 2, "too far apart to be the same battle");
});

test("a death equidistant between two pending sites merges into the lower-id one, deterministically", () => {
  const state = createGameState({ planetId: "ferros" });
  state.wrecks = [
    { id: "wreck-zzz", x: 900, y: 1000, n: 1, goods: { ore: 10 }, value: 10, createdAt: state.time, spawnAt: state.time + WRECK_SPAWN_DELAY },
    { id: "wreck-aaa", x: 1100, y: 1000, n: 1, goods: { ore: 10 }, value: 10, createdAt: state.time, spawnAt: state.time + WRECK_SPAWN_DELAY },
  ];
  const dying = makeUnit("worker", "player", 1000, 1000);   // exactly 100 from each site
  state.units.set(dying.id, dying);

  depositWreckage(state, dying);

  const zzz = state.wrecks.find(w => w.id === "wreck-zzz");
  const aaa = state.wrecks.find(w => w.id === "wreck-aaa");
  assert.equal(aaa.n, 2, "the lower id wins an exact distance tie");
  assert.equal(zzz.n, 1, "the other site is untouched");
});

/* ---------- a raging battle grows before it settles (spawnAt extension) ---------- */

test("a new contribution to an existing site extends its spawnAt", () => {
  const state = createGameState({ planetId: "ferros" });
  const w1 = makeUnit("worker", "player", 1000, 1000);
  state.units.set(w1.id, w1);
  depositWreckage(state, w1);
  const firstSpawnAt = state.wrecks[0].spawnAt;

  state.time += 20;   // well before the first spawnAt
  const w2 = makeUnit("worker", "player", 1010, 1000);
  state.units.set(w2.id, w2);
  depositWreckage(state, w2);

  assert.equal(state.wrecks.length, 1, "still one consolidated site");
  assert.ok(state.wrecks[0].spawnAt > firstSpawnAt, "the second death pushed maturation further out");
  assert.equal(state.wrecks[0].spawnAt, state.time + WRECK_SPAWN_DELAY, "refreshed to a full delay from the second death");
});

test("createdAt is set once at a site's first death and never changes on later merges", () => {
  const state = createGameState({ planetId: "ferros" });
  const w1 = makeUnit("worker", "player", 1000, 1000);
  state.units.set(w1.id, w1);
  depositWreckage(state, w1);
  const createdAt = state.wrecks[0].createdAt;
  assert.equal(createdAt, state.time);

  state.time += 10;
  const w2 = makeUnit("worker", "player", 1000, 1000);
  state.units.set(w2.id, w2);
  depositWreckage(state, w2);

  assert.equal(state.wrecks[0].createdAt, createdAt, "createdAt is immutable once the site exists");
});

test("repeated contributions can't defer maturation past WRECK_MAX_DELAY from the first death", () => {
  const state = createGameState({ planetId: "ferros" });
  const first = makeUnit("worker", "player", 1000, 1000);
  state.units.set(first.id, first);
  depositWreckage(state, first);
  const createdAt = state.wrecks[0].createdAt;

  // Keep contributing, always well within WRECK_SPAWN_DELAY of the last extension, for
  // long enough that an unbounded refresh would push spawnAt far past WRECK_MAX_DELAY.
  for (let i = 0; i < 20; i++) {
    state.time += WRECK_SPAWN_DELAY - 1;
    const next = makeUnit("worker", "player", 1000, 1000);
    state.units.set(next.id, next);
    depositWreckage(state, next);
  }

  assert.equal(state.wrecks[0].spawnAt, createdAt + WRECK_MAX_DELAY, "capped, regardless of how many more contributions arrive");
});

/* ---------- maturation: a pending site becomes real, mineable nodes ---------- */

test("nothing matures before a site's spawnAt", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 1000, 1000);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  const siteId = state.wrecks[0].id;

  state.time += WRECK_SPAWN_DELAY - 1;
  updateWreckage(state);

  assert.equal(state.wrecks.length, 1, "still pending — not due yet");
  assert.ok(!state.map.nodesById.has(`${siteId}-ore`));
});

test("a matured site spawns one real, mineable node per accumulated commodity", () => {
  const state = createGameState({ planetId: "ferros" });
  const dread = makeUnit("dreadnought", "player", 3000, 3000);
  state.units.set(dread.id, dread);
  depositWreckage(state, dread);
  const siteId = state.wrecks[0].id;

  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);

  assert.equal(state.wrecks.length, 0, "the pending entry is consumed");
  const oreNode = state.map.nodesById.get(`${siteId}-ore`);
  const radNode = state.map.nodesById.get(`${siteId}-radioactives`);
  assert.ok(oreNode, "an ore node exists");
  assert.ok(radNode, "a radioactives node exists");
  for (const node of [oreNode, radNode]) {
    assert.ok(node.wreck, "tagged so persist.js knows to fully serialize it");
    assert.equal(node.amount, node.max);
    assert.ok(state.map.nodes.includes(node), "also present in the plain nodes array gather.js/rendering iterate");
    const dist = Math.hypot(node.x - 3000, node.y - 3000);
    assert.ok(dist > 0 && dist < 60, `node should sit a modest jitter from the site centroid, got ${dist}`);
  }
  assert.ok(Math.abs(oreNode.amount - UNITS.dreadnought.cost.ore * WRECK_RETURN_FRAC) < 1e-9);
  assert.ok(Math.abs(radNode.amount - UNITS.dreadnought.cost.radioactives * WRECK_RETURN_FRAC) < 1e-9);
  assert.ok(state.events.some(e => e.type === "wreckMatured"));
});

test("the per-commodity jitter offset is deterministic — same site id, same position every run", () => {
  const runOnce = () => {
    const state = createGameState({ planetId: "ferros" });
    const worker = makeUnit("worker", "player", 4000, 4000);
    worker.id = "u-fixed-for-test";   // a fresh game normally mints a different id each run
    state.units.set(worker.id, worker);
    depositWreckage(state, worker);
    state.time += WRECK_SPAWN_DELAY;
    updateWreckage(state);
    const node = state.map.nodesById.get("wreck-u-fixed-for-test-ore");
    return { x: node.x, y: node.y };
  };
  const a = runOnce(), b = runOnce();
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
});

test("a worker can actually mine a matured wreck node", () => {
  const state = createGameState({ planetId: "ferros" });
  const victim = makeUnit("worker", "player", 5000, 5000);
  state.units.set(victim.id, victim);
  depositWreckage(state, victim);
  state.units.delete(victim.id);   // it actually died
  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);
  const node = [...state.map.nodesById.values()].find(n => n.wreck);

  const miner = makeUnit("worker", "player", node.x + 5, node.y);
  state.units.set(miner.id, miner);
  miner.order = { type: "gather", nodeId: node.id };
  const startAmount = node.amount;

  for (let i = 0; i < 50; i++) tick(state, 0.05);

  assert.ok(node.amount < startAmount || miner.cargo.qty > 0, "the worker actually extracted from the wreck deposit");
});

/* ---------- battle-intensity bonus materials ---------- */

test("no battle bonus rolls when a site's value stays below WRECK_BONUS_THRESHOLD", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 1000, 1000);   // cost value 50 — well under threshold
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  const siteId = state.wrecks[0].id;

  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);

  for (const com of WRECK_BONUS_COMMODITIES) {
    assert.ok(!state.map.nodesById.has(`${siteId}-${com}`), `no bonus ${com} node should exist`);
  }
});

test("a battle bonus rolls once a site's value clears WRECK_BONUS_THRESHOLD, sized off the excess", () => {
  const state = createGameState({ planetId: "ferros" });
  const excess = 50;
  state.wrecks = [{
    id: "wreck-big-battle", x: 2000, y: 2000, n: 5,
    goods: { ore: 100 }, value: WRECK_BONUS_THRESHOLD + excess,
    spawnAt: state.time,
  }];

  updateWreckage(state);

  const bonusNodes = WRECK_BONUS_COMMODITIES
    .map(com => state.map.nodesById.get(`wreck-big-battle-${com}`))
    .filter(Boolean);
  assert.equal(bonusNodes.length, 1, "exactly one bonus commodity node should appear");
  assert.ok(Math.abs(bonusNodes[0].amount - excess * WRECK_BONUS_FRAC) < 1e-9, "sized off the excess above threshold");
});

test("the battle bonus is capped at WRECK_BONUS_CAP regardless of how far value exceeds the threshold", () => {
  const state = createGameState({ planetId: "ferros" });
  state.wrecks = [{
    id: "wreck-huge-battle", x: 2000, y: 2000, n: 20,
    goods: { ore: 100 }, value: WRECK_BONUS_THRESHOLD + 100000,   // way past any reasonable cap
    spawnAt: state.time,
  }];

  updateWreckage(state);

  const bonusNodes = WRECK_BONUS_COMMODITIES
    .map(com => state.map.nodesById.get(`wreck-huge-battle-${com}`))
    .filter(Boolean);
  assert.equal(bonusNodes.length, 1);
  assert.equal(bonusNodes[0].amount, WRECK_BONUS_CAP);
});

test("the battle bonus commodity choice is deterministic — same site id, same commodity every run", () => {
  const runOnce = () => {
    const state = createGameState({ planetId: "ferros" });
    state.wrecks = [{
      id: "wreck-fixed-battle", x: 2000, y: 2000, n: 3,
      goods: { ore: 100 }, value: WRECK_BONUS_THRESHOLD + 50,
      spawnAt: state.time,
    }];
    updateWreckage(state);
    return WRECK_BONUS_COMMODITIES.find(com => state.map.nodesById.has(`wreck-fixed-battle-${com}`));
  };
  assert.equal(runOnce(), runOnce());
});

test("a single big enough kill clears the bonus threshold through the real deposit -> mature pipeline", () => {
  const state = createGameState({ planetId: "ferros" });
  // A Dreadnought's own value (240 ore + 100 radioactives = 340) already clears
  // WRECK_BONUS_THRESHOLD (300) on its own — no synthetic state.wrecks construction needed.
  const dread = makeUnit("dreadnought", "player", 3000, 3000);
  state.units.set(dread.id, dread);
  depositWreckage(state, dread);
  const site = state.wrecks[0];
  assert.ok(site.value >= WRECK_BONUS_THRESHOLD, "sanity check: a single Dreadnought's value clears the threshold");

  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);

  const bonusNodes = WRECK_BONUS_COMMODITIES
    .map(com => state.map.nodesById.get(`${site.id}-${com}`))
    .filter(Boolean);
  assert.equal(bonusNodes.length, 1, "the bonus rolled through the real deposit -> mature pipeline");
});

/* ---------- integration: the real death paths, not just direct calls ---------- */

test("an ordinary combat kill deposits wreckage through the real death path", () => {
  const state = createGameState({ planetId: "ferros" });
  const attacker = makeUnit("skiff", "ai", 500, 500);
  const victim = makeUnit("skiff", "player", 510, 500);
  state.units.set(attacker.id, attacker); state.units.set(victim.id, victim);
  victim.hp = 1; attacker.attackTimer = 0;

  updateCombat(state, attacker, 0);

  assert.equal(state.units.has(victim.id), false, "the victim died");
  assert.equal(state.wrecks.length, 1);
  assert.ok(Math.abs(state.wrecks[0].goods.ore - UNITS.skiff.cost.ore * WRECK_RETURN_FRAC) < 1e-9);
});

test("a Helium Bomb blast kill also deposits wreckage, stacking with the bomb's own crater", () => {
  const state = createGameState({ planetId: "ferros" });   // ferros deposits ore/crystals/radioactives — no gas
  const bomb = makeUnit("heliumbomb", "player", 6000, 6000);
  state.units.set(bomb.id, bomb);
  const victim = makeUnit("worker", "ai", 6005, 6000);   // well within the blast core
  state.units.set(victim.id, victim);

  detonateBomb(state, bomb);

  assert.equal(state.units.has(victim.id), false, "sanity check: the blast killed it");
  assert.equal(state.craters.length, 1, "the bomb's own crater is still scheduled");
  assert.equal(state.wrecks.length, 1, "the victim's (and the bomb's own) wreckage is ALSO scheduled now");
  assert.ok(Math.abs(state.wrecks[0].goods.ore - UNITS.worker.cost.ore * WRECK_RETURN_FRAC) < 1e-9, "the worker's own wreckage");
  assert.ok(!state.wrecks[0].goods.gas, "the bomb's own gas cost is gated out of the base return — ferros has no natural gas deposit");
  const bombCostTotal = Object.values(UNITS.heliumbomb.cost).reduce((a, b) => a + b, 0);
  const expectedValue = UNITS.worker.cost.ore + bombCostTotal;
  assert.ok(Math.abs(state.wrecks[0].value - expectedValue) < 1e-9,
    "the bomb's own value still counts toward battle intensity even though none of its cost was reclaimable here");
});

test("a full tick() loop matures wreckage on schedule — the real integration path", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  state.units.delete(worker.id);
  const siteId = state.wrecks[0].id;

  // 20 Hz fixed step (see engine/loop.js) — enough ticks to cross WRECK_SPAWN_DELAY.
  const dt = 0.05;
  for (let i = 0; i < Math.ceil(WRECK_SPAWN_DELAY / dt) + 1; i++) tick(state, dt);

  assert.ok(state.map.nodesById.has(`${siteId}-ore`), "matured for real, through the actual per-tick path");
  assert.equal(state.wrecks.length, 0);
});

/* ---------- persistence ---------- */

test("a PENDING wreck site survives save/load and still matures on schedule after loading", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  const siteId = state.wrecks[0].id;
  const spawnAt = state.wrecks[0].spawnAt;

  const loaded = deserializeGame(serializeGame(state));
  assert.equal(loaded.wrecks.length, 1);
  assert.deepEqual(
    { id: loaded.wrecks[0].id, x: loaded.wrecks[0].x, y: loaded.wrecks[0].y, n: loaded.wrecks[0].n, spawnAt: loaded.wrecks[0].spawnAt },
    { id: siteId, x: 800, y: 800, n: 1, spawnAt }
  );
  assert.ok(Math.abs(loaded.wrecks[0].goods.ore - UNITS.worker.cost.ore * WRECK_RETURN_FRAC) < 1e-9);

  loaded.time = spawnAt;
  updateWreckage(loaded);
  assert.ok(loaded.map.nodesById.has(`${siteId}-ore`), "still matures correctly after a load");
});

test("a pending site's battle-intensity value survives save/load", () => {
  const state = createGameState({ planetId: "ferros" });
  const dread = makeUnit("dreadnought", "player", 800, 800);
  state.units.set(dread.id, dread);
  depositWreckage(state, dread);
  const expectedValue = state.wrecks[0].value;

  const loaded = deserializeGame(serializeGame(state));

  assert.equal(loaded.wrecks[0].value, expectedValue);
});

test("a pending site's createdAt survives save/load", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  const expectedCreatedAt = state.wrecks[0].createdAt;

  const loaded = deserializeGame(serializeGame(state));

  assert.equal(loaded.wrecks[0].createdAt, expectedCreatedAt);
});

test("a pending site missing createdAt (a pre-Phase-4 save) still gets a sane fallback and matures correctly", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  const siteId = state.wrecks[0].id;
  const save = serializeGame(state);
  delete save.wrecks[0].createdAt;   // simulate an older, pre-Phase-4 save format

  const loaded = deserializeGame(save);

  assert.ok(Number.isFinite(loaded.wrecks[0].createdAt), "a sane fallback is reconstructed, not left undefined/NaN");
  loaded.time = loaded.wrecks[0].spawnAt;
  updateWreckage(loaded);
  assert.ok(loaded.map.nodesById.has(`${siteId}-ore`), "matures correctly despite the missing field");
});

test("a MATURED wreck node survives save/load — it isn't part of the seed-regenerated map", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);
  const original = [...state.map.nodesById.values()].find(n => n.wreck);

  const loaded = deserializeGame(serializeGame(state));
  const restored = loaded.map.nodesById.get(original.id);
  assert.ok(restored, "the wreck node was NOT silently dropped by the seed regeneration");
  assert.equal(restored.com, original.com);
  assert.equal(restored.amount, original.amount);
  assert.equal(restored.max, original.max);
  assert.equal(restored.x, original.x);
  assert.equal(restored.y, original.y);
  assert.ok(loaded.map.nodes.includes(restored), "present in the plain nodes array too, not just nodesById");
});

test("a partially-mined wreck node's REMAINING amount survives save/load, not its original max", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);
  const node = [...state.map.nodesById.values()].find(n => n.wreck);
  node.amount = node.max / 2;   // simulate partial mining

  const loaded = deserializeGame(serializeGame(state));
  assert.equal(loaded.map.nodesById.get(node.id).amount, node.max / 2);
});

test("a tampered/malformed wrecks save is dropped gracefully rather than crashing the load", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  const save = serializeGame(state);

  save.wrecks.push({ id: "wreck-evil", x: 100, y: 100, n: 1, goods: { "not-a-real-commodity": 999 }, spawnAt: 10 });   // no valid commodity left
  save.wrecks.push("not even an object");
  save.wrecks.push({
    id: "wreck-huge", x: 1e12, y: -1e12, n: "lots", value: -999, createdAt: 1e12,
    goods: { ore: 50 }, spawnAt: "soon",   // garbage coords/n/value/createdAt/time
  });

  const loaded = deserializeGame(save);
  assert.ok(!loaded.wrecks.some(w => w.id === "wreck-evil"), "an entry with no valid commodities after sanitizing is dropped entirely");
  const huge = loaded.wrecks.find(w => w.id === "wreck-huge");
  assert.ok(huge, "the garbage-coordinate entry survives, sanitized rather than dropped outright");
  assert.ok(Number.isFinite(huge.x) && huge.x >= 0 && huge.x <= loaded.map.width, "x clamped onto the map");
  assert.ok(Number.isFinite(huge.y) && huge.y >= 0 && huge.y <= loaded.map.height, "y clamped onto the map");
  assert.ok(Number.isFinite(huge.spawnAt), "non-numeric spawnAt coerced to a finite number");
  assert.ok(Number.isFinite(huge.n) && huge.n >= 1, "non-numeric n coerced to a sane floor");
  assert.ok(Number.isFinite(huge.value) && huge.value >= 0, "a negative value is clamped to 0, not left to poison the bonus roll");
  assert.ok(Number.isFinite(huge.createdAt) && huge.createdAt <= huge.spawnAt,
    "an implausibly future createdAt is clamped to at most this site's own spawnAt, not left to grant runaway extension");
});

test("a tampered wreck NODE (not the pending list) is sanitized on load — bogus commodity dropped", () => {
  const state = createGameState({ planetId: "ferros" });
  const worker = makeUnit("worker", "player", 800, 800);
  state.units.set(worker.id, worker);
  depositWreckage(state, worker);
  state.time += WRECK_SPAWN_DELAY;
  updateWreckage(state);
  const save = serializeGame(state);
  const savedNode = save.nodes.find(n => n.wreck);
  savedNode.com = "not-a-real-commodity";

  const loaded = deserializeGame(save);
  assert.ok(!loaded.map.nodesById.has(savedNode.id), "a wreck node with a bogus commodity is not restored at all");
});
