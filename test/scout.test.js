import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { updateScoutMode } from "../engine/scout.js";
import { issueScout, issueHoldFormation } from "../engine/commands.js";
import { UNITS } from "../engine/entities.js";
import { nearestUnexploredPoint, isExploredAt, FOG_CELL_SIZE } from "../engine/fog.js";
import { tick } from "../engine/sim.js";

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

test("a scout re-picks its target when its own side's sight reveals it early — before physically reaching it", () => {
  // The existing "closes distance over time" test above is too weak to isolate THIS branch —
  // it would likely still pass even if the early-reveal re-pick were deleted, since simply
  // closing the distance eventually trips the (separate) "arrived" re-pick instead. This test
  // pins the target far away (well beyond REACH, so arrival can't explain a change) and reveals
  // it some OTHER way, so only the early-reveal branch could account for the re-pick.
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);

  // Set a real frontier target directly on the order — mirrors how test/combat.test.js's
  // analogous stale-target test sets `.order.targetId` directly rather than deriving it through
  // the function under test.
  const spot = nearestUnexploredPoint(state.fog, ranger.x, ranger.y);
  assert.ok(spot, "fixture: there is dark ground to explore from the base");
  ranger.order = { type: "scout", tx: spot.x, ty: spot.y, explore: true };
  const startDist = Math.hypot(spot.x - ranger.x, spot.y - ranger.y);
  assert.ok(startDist > 20, "fixture: the target is well beyond arrival distance (REACH is 6)");

  // Something ELSE reveals that exact cell before the scout gets anywhere near it — e.g. the
  // AI's own base sight sweeping over it this tick. Flipped directly on the fog grid, the same
  // permanent effect engine/fog.js's reveal() would leave behind, but without moving the scout
  // itself at all — isolating this branch from the "arrived" one.
  const cx = Math.floor(spot.x / FOG_CELL_SIZE), cy = Math.floor(spot.y / FOG_CELL_SIZE);
  state.fog.explored[cy * state.fog.cols + cx] = 1;
  assert.ok(isExploredAt(state.fog, spot.x, spot.y), "fixture: the target's own cell now reads explored");

  updateScoutMode(state, ranger, 0.1);

  assert.ok(ranger.order.tx !== spot.x || ranger.order.ty !== spot.y,
    "the scout dropped the now-redundant target for a fresh one, instead of continuing toward already-charted ground");
  assert.ok(!isExploredAt(state.fog, ranger.order.tx, ranger.order.ty), "...and the new target is itself still genuinely unexplored");
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

// ---- scout mode leads a formation at its own pace instead of abandoning it -----------

test("issueScout on a formation LEADER keeps its followers — a protective scout, not an abandoning one", () => {
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
  assert.deepEqual(ranger.squadFollowers, [follower], "the squad stays intact — the Ranger keeps leading it");
  assert.equal(follower.squadLeader, ranger, "the follower is still linked to its leader");
  assert.equal(follower.order.type, "follow-leader", "and still actively following, not stopped or released");
});

test("a Ranger leading a formation scouts at the formation's pace, not its own top speed", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);
  const follower = makeUnit("worker", "player", ranger.x + 20, ranger.y);   // far slower than the Ranger
  state.units.set(follower.id, follower);
  issueHoldFormation([ranger, follower]);

  issueScout([ranger, follower]);
  assert.equal(ranger.order.speedCap, UNITS.worker.speed * 0.95,
    "capped to 95% of the slowest member's speed, same as a move/attack-move/hold-formation leader");

  const x0 = ranger.x, y0 = ranger.y;
  for (let i = 0; i < 10; i++) updateScoutMode(state, ranger, 0.1);   // 1 sim second
  const traveled = Math.hypot(ranger.x - x0, ranger.y - y0);
  assert.ok(traveled < UNITS.ranger.speed * 0.7,
    `the Ranger (${traveled.toFixed(0)} travelled) stays at the formation's pace, nowhere near its own top ${UNITS.ranger.speed}`);
});

test("a solo Ranger (nobody to lead) still scouts at its own full speed", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  const ranger = playerRanger(state);

  issueScout([ranger]);
  assert.ok(!Number.isFinite(ranger.order.speedCap), "nothing to cap to — the scout order carries no speed cap");

  const x0 = ranger.x, y0 = ranger.y;
  for (let i = 0; i < 10; i++) updateScoutMode(state, ranger, 0.1);
  const traveled = Math.hypot(ranger.x - x0, ranger.y - y0);
  assert.ok(traveled > UNITS.worker.speed,
    `the Ranger (${traveled.toFixed(0)} travelled) is not held to any group pace when it isn't leading one`);
});

test("a scout order's patrol circuit index never doubles as sim.js's requeue flag (T2)", () => {
  // `order.patrol` carries TWO incompatible meanings: engine/commands.js issuePatrol stamps
  // `patrol: true` as a boolean "requeue me" flag that engine/sim.js reads off orderQueue, while
  // engine/scout.js uses the same field name as a numeric circuit index. Latent only because
  // issueScout writes u.order directly and clears orderQueue — but the failure would be
  // shape-dependent: index 0 is falsy (no requeue), 1-3 are truthy (infinite requeue of the same
  // object). Both commands are gated to role === "scout", so the Ranger is the one unit that can
  // hold either, i.e. exactly where "queue a scout leg behind a patrol leg" is most natural.
  const st = createGameState({ planetId: "ferros", seed: 81 });
  const scout = [...st.units.values()].find(u => UNITS[u.type].role === "scout")
    || (() => { const u = makeUnit("ranger", "player", 700, 500); st.units.set(u.id, u); return u; })();

  // Fully explore the fog so nearestUnexploredPoint returns null and the patrol branch runs.
  st.fog.explored.fill(1);
  scout.order = { type: "scout" };
  for (let i = 0; i < 8 && !(scout.order.patrolLeg >= 1); i++) {
    scout.order.tx = scout.x; scout.order.ty = scout.y;   // "arrived", so it re-picks a leg
    updateScoutMode(st, scout, 0.1);
  }
  assert.ok(scout.order.patrolLeg >= 1, "fixture sanity: the scout reached its patrol circuit");
  assert.equal(scout.order.patrol, undefined,
    "the circuit index must NOT be stored on `patrol` — sim.js reads that field as a requeue flag");

  const queuedOrder = { ...scout.order };
  scout.orderQueue = [queuedOrder];
  scout.order = null;
  tick(st, 0.1);
  assert.equal(scout.orderQueue.length, 0,
    "pulling that order off the queue must not re-push it forever");
});
