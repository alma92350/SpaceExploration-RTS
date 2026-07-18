import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { canPlaceBuilding, findPlacement } from "../engine/colliders.js";
import { MAP_WIDTH, MAP_HEIGHT } from "../engine/map.js";

// ferros with rng () => 0.5: player CC at (160,500), ai CC at (1440,500),
// all player-side nodes near x=400 — leaving (800,500) as open ground.
function freshState() {
  return createGameState({ planetId: "ferros", rng: () => 0.5 });
}

test("canPlaceBuilding rejects a footprint hanging past any map edge but accepts open ground", () => {
  const state = freshState();
  assert.equal(canPlaceBuilding(state, "barracks", 10, 500), false, "past the left edge");
  assert.equal(canPlaceBuilding(state, "barracks", MAP_WIDTH - 10, 500), false, "past the right edge");
  assert.equal(canPlaceBuilding(state, "barracks", 800, 10), false, "past the top edge");
  assert.equal(canPlaceBuilding(state, "barracks", 800, MAP_HEIGHT - 10), false, "past the bottom edge");
  assert.equal(canPlaceBuilding(state, "barracks", 800, 500), true, "open mid-map ground");
});

test("canPlaceBuilding rejects overlap with an existing building, own or enemy alike", () => {
  const state = freshState();
  assert.equal(canPlaceBuilding(state, "barracks", 160, 500), false, "on the player's own Command Center");
  assert.equal(canPlaceBuilding(state, "barracks", 1440, 500), false, "on the enemy Command Center");
});

test("canPlaceBuilding rejects a live resource node but frees the ground once it's depleted", () => {
  const state = freshState();
  const node = state.map.nodes.find(n => n.com === "ore");
  assert.equal(canPlaceBuilding(state, "barracks", node.x, node.y), false, "a live node blocks placement");
  node.amount = 0;
  assert.equal(canPlaceBuilding(state, "barracks", node.x, node.y), true, "mined-out ground is buildable");
});

test("findPlacement echoes a valid requested spot exactly", () => {
  const state = freshState();
  assert.deepEqual(findPlacement(state, "barracks", 800, 500), { x: 800, y: 500 });
});

test("findPlacement slides a blocked request to nearby valid ground within its search radius", () => {
  const state = freshState();
  const spot = findPlacement(state, "barracks", 160, 500);   // dead center of the player CC
  assert.ok(spot, "a spot should exist near the base");
  assert.equal(canPlaceBuilding(state, "barracks", spot.x, spot.y), true);
  assert.ok(Math.hypot(spot.x - 160, spot.y - 500) <= 200, "should stay within the default search radius");
});

test("findPlacement gives up (null) when everything within maxRadius is blocked", () => {
  const state = freshState();
  // canPlaceBuilding only reads x/y/radius, so a bare oversized blocker is
  // enough to wall off every candidate ring around the request.
  state.buildings.set("blocker", { id: "blocker", x: 800, y: 500, radius: 300 });
  assert.equal(findPlacement(state, "barracks", 800, 500, 60), null);
});

test("findPlacement is deterministic: the same state and request always pick the same spot", () => {
  const state = freshState();
  const first = findPlacement(state, "barracks", 160, 500);
  const second = findPlacement(state, "barracks", 160, 500);
  assert.deepEqual(first, second);
});
