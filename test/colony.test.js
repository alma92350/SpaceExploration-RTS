import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip, hasColonyShip, COLONY_SHIP_WORKERS, packCommandCenter, PACK_COST } from "../engine/colony.js";
import { canPlaceBuilding } from "../engine/colliders.js";
import { queueProduction } from "../engine/production.js";
import { checkEndlessLoss } from "../engine/victory.js";
import { createGalaxy, activeState, checkDomination, galaxyStatus } from "../engine/galaxy.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";
import { runAI } from "../engine/ai.js";

const THINK = 1.5;
const playerShip = s => [...s.units.values()].find(u => u.owner === "player" && u.type === "colonyship");
const ccs = (s, owner) => [...s.buildings.values()].filter(b => b.owner === owner && b.type === "command");

// ---- the deploy mechanic ----

test("deploying a colony ship founds a COMPLETED Command Center and disembarks the colonists", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  const ship = playerShip(s);
  const { x, y } = ship;
  const ccId = deployColonyShip(s, ship.id);
  assert.ok(ccId, "deploy returns the new CC id");
  assert.ok(!s.units.get(ship.id), "the ship is consumed");
  const cc = s.buildings.get(ccId);
  assert.equal(cc.type, "command");
  assert.ok(!cc.constructing, "the CC is completed at once (no foothold gap)");
  assert.equal(cc.x, x); assert.equal(cc.y, y);
  assert.equal([...s.units.values()].filter(u => u.owner === "player" && u.type === "worker").length,
    COLONY_SHIP_WORKERS, "the colonists disembarked as workers");
});

test("a colony ship on blocked ground can't deploy — the ship survives, a deployBlocked event fires", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  const ship = playerShip(s);
  const blocker = makeBuilding("reactor", "player", ship.x, ship.y);   // occupy the exact spot
  s.buildings.set(blocker.id, blocker);
  s.events.length = 0;
  assert.equal(canPlaceBuilding(s, "command", ship.x, ship.y), false, "the spot is blocked");
  assert.equal(deployColonyShip(s, ship.id), null, "deploy is refused");
  assert.ok(s.units.get(ship.id), "the ship survives to move elsewhere");
  assert.equal(ccs(s, "player").length, 0, "no CC was minted");
  assert.ok(s.events.some(e => e.type === "deployBlocked"), "a deployBlocked event fired");
  s.buildings.delete(blocker.id);                                     // clear the spot
  assert.ok(deployColonyShip(s, ship.id), "clear ground → it deploys");
});

test("deploy is deterministic — same setup mints an identical CC + colonists", () => {
  const fingerprint = () => {
    const s = createGameState({ planetId: "ferros", seed: 7, endless: true });
    deployColonyShip(s, playerShip(s).id);
    return [...s.buildings.values(), ...s.units.values()]
      .filter(e => e.owner === "player").map(e => `${e.type}@${Math.round(e.x)},${Math.round(e.y)}`).sort().join("|");
  };
  assert.equal(fingerprint(), fingerprint());
});

// ---- packing (the reverse: CC -> colony ship) ----

test("packing a plain CC pays PACK_COST, removes the building, and spawns a colony ship in its place", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  deployColonyShip(s, playerShip(s).id);
  const built = ccs(s, "player")[0];
  s.players.player.resources.ore = 1000;
  const before = s.players.player.resources.ore;
  const { x, y } = built;
  const shipId = packCommandCenter(s, built.id);
  assert.ok(shipId, "packing succeeds");
  assert.equal(s.players.player.resources.ore, before - PACK_COST.ore);
  assert.ok(!s.buildings.get(built.id), "the CC is gone");
  const ship = s.units.get(shipId);
  assert.equal(ship.type, "colonyship");
  assert.equal(ship.owner, "player");
  assert.equal(ship.x, x); assert.equal(ship.y, y);
});

test("packing refuses a Capital, a still-constructing CC, and an unaffordable player", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  deployColonyShip(s, playerShip(s).id);
  const cc = ccs(s, "player")[0];
  s.players.player.resources.ore = 1000;

  cc.capital = true;
  assert.equal(packCommandCenter(s, cc.id), null, "a Capital never packs — only a smaller CC relocates");
  cc.capital = false;

  cc.constructing = true;
  assert.equal(packCommandCenter(s, cc.id), null, "nothing to pack up mid-construction");
  cc.constructing = false;

  s.players.player.resources.ore = 0;
  assert.equal(packCommandCenter(s, cc.id), null, "can't afford it");
  assert.ok(s.buildings.get(cc.id), "…and the CC is untouched — a refused pack charges nothing");
});

test("packing is Odyssey-only, same guarantee issueBuild makes for odysseyOnly content", () => {
  const s = createGameState({ planetId: "ferros", seed: 3 });   // NOT endless -- a skirmish
  const cc = ccs(s, "player")[0];
  s.players.player.resources.ore = 1000;
  assert.equal(packCommandCenter(s, cc.id), null, "a skirmish CC can't pack — colonyship is odysseyOnly");
  assert.ok(s.buildings.get(cc.id), "the skirmish CC is untouched");
});

test("packing refunds any queued production before charging the pack cost", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  deployColonyShip(s, playerShip(s).id);
  const cc = ccs(s, "player")[0];
  s.players.player.resources.ore = 1000;
  assert.ok(queueProduction(s, cc.id, "worker"), "queue a worker");
  const afterQueue = s.players.player.resources.ore;
  const workerCost = afterQueue !== 1000 ? 1000 - afterQueue : 0;
  assert.ok(workerCost > 0, "queuing actually charged ore");

  const shipId = packCommandCenter(s, cc.id);
  assert.ok(shipId, "pack succeeds");
  // The queued job's cost comes back, then PACK_COST is charged on top.
  assert.equal(s.players.player.resources.ore, afterQueue + workerCost - PACK_COST.ore);
});

test("a packed CC's ship redeploys through the ordinary deploy flow — full round trip", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  deployColonyShip(s, playerShip(s).id);
  const cc = ccs(s, "player")[0];
  s.players.player.resources.ore = 1000;
  const shipId = packCommandCenter(s, cc.id);
  const ship = s.units.get(shipId);
  ship.x += 300; ship.y += 300;   // "move" it to a new site
  const newCcId = deployColonyShip(s, shipId);
  assert.ok(newCcId, "the packed-and-moved ship redeploys just like any other colony ship");
  const newCc = s.buildings.get(newCcId);
  assert.equal(newCc.x, ship.x); assert.equal(newCc.y, ship.y);
  assert.ok(!newCc.constructing, "instant, same as any deploy");
});

test("packing a player's ONLY CC still leaves them with a foothold — no tick-1 defeat", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  deployColonyShip(s, playerShip(s).id);
  const cc = ccs(s, "player")[0];
  s.players.player.resources.ore = 1000;
  assert.ok(packCommandCenter(s, cc.id), "packs the player's sole base");
  assert.equal(ccs(s, "player").length, 0, "no CC left");
  checkEndlessLoss(s);
  assert.equal(s.over, false, "the resulting colony ship is already the recognised foothold");
});

// ---- the foothold rule (loss + domination) ----

test("a side with only a colony ship still has a foothold — not lost, not pacified", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  checkEndlessLoss(s);
  assert.equal(s.over, false, "a lone colony ship is a foothold — no tick-1 defeat");
  for (const u of [...s.units.values()]) if (u.owner === "player" && u.type === "colonyship") s.units.delete(u.id);
  checkEndlessLoss(s);
  assert.equal(s.over, true, "no CC and no ship → defeat");

  const g = createGalaxy({ seed: 5 });
  assert.equal(galaxyStatus(g).pacified, 0, "the AI's start colony ship keeps its world un-pacified");
  const active = activeState(g);
  for (const u of [...active.units.values()]) if (u.owner === "ai" && u.type === "colonyship") active.units.delete(u.id);
  checkDomination(g);
  assert.equal(galaxyStatus(g).pacified, 1, "removing the AI's last foothold pacifies the world");
});

// ---- skirmish byte-identity ----

test("a skirmish still starts with a Command Center — no colony ship, and can't build one", () => {
  const s = createGameState({ planetId: "ferros", seed: 3 });   // NOT endless
  assert.equal(ccs(s, "player").length, 1, "player starts with a placed CC");
  assert.equal(ccs(s, "ai").length, 1, "AI too");
  assert.ok(![...s.units.values()].some(u => u.type === "colonyship"), "no colony ship anywhere in a skirmish");
  assert.ok(!hasColonyShip(s, "player"));
  const cc = ccs(s, "player")[0];
  assert.equal(queueProduction(s, cc.id, "colonyship"), false, "a skirmish CC can't build the Odyssey-only colony ship");
});

test("an undeployed ship and a deployed base both survive a save/load", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  const r1 = deserializeGame(JSON.parse(JSON.stringify(serializeGame(s))));
  assert.ok(hasColonyShip(r1, "player"), "the undeployed colony ship round-trips");
  deployColonyShip(s, playerShip(s).id);
  const r2 = deserializeGame(JSON.parse(JSON.stringify(serializeGame(s))));
  assert.equal(ccs(r2, "player").length, 1, "the deployed CC round-trips");
  assert.ok(!hasColonyShip(r2, "player"), "…and the ship is gone");
});

// ---- the AI ----

test("the AI deploys its start colony ship into a base on its first think", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  assert.ok(hasColonyShip(s, "ai") && ccs(s, "ai").length === 0, "AI starts with a ship, no CC");
  runAI(s, THINK);
  assert.ok(ccs(s, "ai").length >= 1, "the AI founded a base");
  assert.ok(!hasColonyShip(s, "ai"), "…by deploying its colony ship");
});

test("the AI's start deploy is APM-exempt — even a throttled AI seats a base", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true, aiApm: 1 });
  s.ai.actionBudget = 0;                       // no action credits at all
  runAI(s, THINK);
  assert.ok(ccs(s, "ai").length >= 1, "a 1-APM AI still founds its base (progress is guaranteed)");
});

test("a lone-colony-ship AI redeploys to survive — never permanently base-less", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  runAI(s, THINK);                            // deploy the start base
  for (const b of [...s.buildings.values()]) if (b.owner === "ai" && b.type === "command") s.buildings.delete(b.id);
  const ship = makeUnit("colonyship", "ai", s.map.bases.ai.x + 120, s.map.bases.ai.y);
  s.units.set(ship.id, ship);                 // razed to a lone ship
  runAI(s, THINK);
  assert.ok(ccs(s, "ai").length >= 1, "it re-founded a base from the lone ship");
});

test("the AI expands by producing a colony ship (not a worker-built CC) once home ore runs thin", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true, rng: () => 0.5 });   // ferros = economist
  runAI(s, THINK);                            // deploy the start base
  const cc = ccs(s, "ai")[0];
  s.fogAI.explored.fill(1); s.fogAI.visible.fill(1);   // it can see clusters to settle onto
  s.players.ai.resources.ore = 100000;
  for (const n of s.map.nodes)                // drain home ore so it wants to expand
    if (n.com === "ore" && Math.hypot(n.x - s.map.bases.ai.x, n.y - s.map.bases.ai.y) <= 420) n.amount = 0;
  runAI(s, THINK);
  const expanding = cc.queue.some(j => j.unitType === "colonyship")
    || [...s.units.values()].some(u => u.owner === "ai" && u.type === "colonyship");
  assert.ok(expanding, "the AI queued/holds a colony ship to found a new base");
  assert.ok(![...s.buildings.values()].some(b => b.owner === "ai" && b.type === "command" && b.constructing),
    "…and did NOT build a CC directly (that's the skirmish-only path)");
});

test("the AI keeps at most one colony ship in flight", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true, rng: () => 0.5 });
  runAI(s, THINK);
  const cc = ccs(s, "ai")[0];
  s.fogAI.explored.fill(1); s.fogAI.visible.fill(1);
  s.players.ai.resources.ore = 100000;
  for (const n of s.map.nodes)
    if (n.com === "ore" && Math.hypot(n.x - s.map.bases.ai.x, n.y - s.map.bases.ai.y) <= 420) n.amount = 0;
  const ship = makeUnit("colonyship", "ai", s.map.bases.ai.x + 220, s.map.bases.ai.y);   // one already in flight
  s.units.set(ship.id, ship);
  runAI(s, THINK);
  assert.equal([...s.units.values()].filter(u => u.owner === "ai" && u.type === "colonyship").length, 1,
    "no second ship is produced while one is in flight");
  assert.ok(!cc.queue.some(j => j.unitType === "colonyship"), "and none queued at the CC");
});
