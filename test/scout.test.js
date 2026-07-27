import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { updateScoutMode } from "../engine/scout.js";
import { issueScout, issueHoldFormation } from "../engine/commands.js";
import { UNITS } from "../engine/entities.js";
import { nearestUnexploredPoint } from "../engine/fog.js";

function playerRanger(state) {
  const r = makeUnit("ranger", "player", state.map.bases.player.x, state.map.bases.player.y);
  state.units.set(r.id, r);
  return r;
}

test("scout mode drives a Ranger toward the nearest unexplored ground", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);
  ranger.order = { type: "scout" };

  const target = nearestUnexploredPoint(state.fog, ranger.x, ranger.y);
  assert.ok(target, "fixture: there is dark ground to explore from the base");
  const before = Math.hypot(target.x - ranger.x, target.y - ranger.y);

  for (let i = 0; i < 20; i++) updateScoutMode(state, ranger, 0.1);

  const after = Math.hypot(target.x - ranger.x, target.y - ranger.y);
  assert.ok(after < before, `the Ranger closed on the frontier (${before.toFixed(0)} -> ${after.toFixed(0)})`);
  assert.equal(ranger.order.type, "scout", "scout mode is persistent — it keeps exploring, not a one-shot move");
});

test("scout mode moves — it never freezes in place while ground is still dark", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);
  ranger.order = { type: "scout" };
  const x0 = ranger.x, y0 = ranger.y;
  for (let i = 0; i < 5; i++) updateScoutMode(state, ranger, 0.1);
  assert.ok(Math.hypot(ranger.x - x0, ranger.y - y0) > 1, "the Ranger actually travelled");
});

test("with the whole map charted, scout mode patrols instead of stalling", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.fog.explored.fill(1);   // everything charted — nothing left to discover
  const ranger = playerRanger(state);
  ranger.order = { type: "scout" };

  updateScoutMode(state, ranger, 0.1);
  assert.equal(ranger.order.explore, false, "no dark ground left -> patrol, not explore");
  assert.ok(ranger.order.tx != null && ranger.order.ty != null, "it still has a patrol waypoint to head for");
});

test("issueScout only puts scout-role units into scout mode, leaving others alone", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);
  const worker = [...state.units.values()].find(u => u.type === "worker");
  worker.order = { type: "gather", nodeId: "n0" };

  issueScout([ranger, worker]);

  assert.equal(ranger.order.type, "scout", "the Ranger enters scout mode");
  assert.equal(worker.order.type, "gather", "the Worker is untouched — it's not a scout unit");
});

// ---- scout mode breaks cleanly away from a formation it was leading -----------

test("issueScout on a formation LEADER releases its followers instead of leaving them to chase it forever", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);
  const follower = makeUnit("worker", "player", ranger.x + 20, ranger.y);
  state.units.set(follower.id, follower);
  issueHoldFormation([ranger, follower]);   // ranger (units[0]) becomes the squad leader
  assert.deepEqual(ranger.squadFollowers, [follower]);
  assert.equal(follower.squadLeader, ranger);
  assert.equal(follower.order.type, "follow-leader");

  issueScout([ranger, follower]);

  assert.equal(ranger.order.type, "scout");
  assert.deepEqual(ranger.squadFollowers, [], "the old squad is released, not left dangling on the ex-leader");
  assert.equal(follower.squadLeader, undefined, "the follower is unlinked from its old leader");
  assert.equal(follower.order, null, "and actually stopped, not left silently chasing a Ranger now roaming the whole map");
});

test("a Ranger's own scout speed is never capped to a slower formation it just led", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);
  const follower = makeUnit("worker", "player", ranger.x + 20, ranger.y);   // far slower than the Ranger
  state.units.set(follower.id, follower);
  issueHoldFormation([ranger, follower]);

  issueScout([ranger, follower]);
  assert.ok(!Number.isFinite(ranger.order.speedCap), "the scout order carries no speed cap at all");

  const x0 = ranger.x, y0 = ranger.y;
  for (let i = 0; i < 10; i++) updateScoutMode(state, ranger, 0.1);   // 1 sim second
  const traveled = Math.hypot(ranger.x - x0, ranger.y - y0);
  assert.ok(traveled > UNITS.worker.speed, `the Ranger (${traveled.toFixed(0)} travelled) outpaces the slow formation it left behind, not capped to its ${UNITS.worker.speed} speed`);
});
