import { test } from "node:test";
import assert from "node:assert/strict";
import { createFog, updateFog, isVisibleAt, isExploredAt, isNodeDiscovered, nearestUnexploredPoint, FOG_CELL_SIZE } from "../engine/fog.js";
import { makeUnit, makeBuilding } from "../engine/state.js";

function mapStub(width = 800, height = 600) {
  return { width, height };
}

test("a freshly created fog grid is entirely unexplored and not visible", () => {
  const fog = createFog(mapStub());
  assert.equal(isVisibleAt(fog, 100, 100), false);
  assert.equal(isExploredAt(fog, 100, 100), false);
});

test("updateFog reveals cells within a unit's sight radius, and marks them explored", () => {
  const map = mapStub();
  const fog = createFog(map);
  const worker = makeUnit("worker", "player", 400, 300);   // worker sight = 110
  const state = { units: new Map([[worker.id, worker]]), buildings: new Map() };

  updateFog(state, fog, "player");

  assert.equal(isVisibleAt(fog, 400, 300), true, "right on top of the worker");
  assert.equal(isVisibleAt(fog, 400 + 100, 300), true, "within sight radius");
  assert.equal(isVisibleAt(fog, 400 + 500, 300), false, "far outside sight radius");
  assert.equal(isExploredAt(fog, 400, 300), true);
});

test("only the requested owner's entities grant vision", () => {
  const map = mapStub();
  const fog = createFog(map);
  const enemy = makeUnit("skiff", "ai", 400, 300);
  const state = { units: new Map([[enemy.id, enemy]]), buildings: new Map() };

  updateFog(state, fog, "player");

  assert.equal(isVisibleAt(fog, 400, 300), false, "an enemy unit shouldn't grant the player vision");
});

test("explored cells stay explored after the source of vision moves away, but stop being visible", () => {
  const map = mapStub();
  const fog = createFog(map);
  const worker = makeUnit("worker", "player", 400, 300);
  const state = { units: new Map([[worker.id, worker]]), buildings: new Map() };

  updateFog(state, fog, "player");
  assert.equal(isVisibleAt(fog, 400, 300), true);

  worker.x = 400 + 1000;   // walk far away, well outside the map even
  updateFog(state, fog, "player");

  assert.equal(isVisibleAt(fog, 400, 300), false, "no longer in sight");
  assert.equal(isExploredAt(fog, 400, 300), true, "but permanently remembered as explored");
});

test("buildings also grant vision, at their own sight radius", () => {
  const map = mapStub();
  const fog = createFog(map);
  const cc = makeBuilding("command", "player", 400, 300);   // command sight = 220
  const state = { units: new Map(), buildings: new Map([[cc.id, cc]]) };

  updateFog(state, fog, "player");

  assert.equal(isVisibleAt(fog, 400 + 200, 300), true);
  assert.equal(isVisibleAt(fog, 400 + 300, 300), false);
});

test("cells outside the map bounds are neither visible nor explored, not a crash", () => {
  const fog = createFog(mapStub());
  assert.equal(isVisibleAt(fog, -50, -50), false);
  assert.equal(isVisibleAt(fog, 100000, 100000), false);
});

test("FOG_CELL_SIZE is a sane positive grid resolution", () => {
  assert.ok(FOG_CELL_SIZE > 0);
});

test("a charted deposit is always discovered; a hidden cache only after its cell is scouted", () => {
  const map = mapStub();
  const fog = createFog(map);
  const charted = { com: "ore", x: 400, y: 300 };            // an ordinary surface node
  const cache = { com: "crystals", x: 400, y: 300, hidden: true };

  assert.equal(isNodeDiscovered(fog, charted), true, "surface deposits are known from the start");
  assert.equal(isNodeDiscovered(fog, cache), false, "a hidden cache stays undiscovered until scouted");

  // Send a unit to that spot; once its cell is explored the cache is revealed
  // — and stays revealed after the scout leaves (explored memory is permanent).
  const worker = makeUnit("worker", "player", 400, 300);
  updateFog({ map, units: new Map([[worker.id, worker]]), buildings: new Map() }, fog, "player");
  assert.equal(isNodeDiscovered(fog, cache), true, "scouting its cell discovers the cache");

  worker.x = 400 + 1000;
  updateFog({ map, units: new Map([[worker.id, worker]]), buildings: new Map() }, fog, "player");
  assert.equal(isNodeDiscovered(fog, cache), true, "and it stays discovered after the scout moves on");
});

test("a planet sight modifier shrinks how far a unit reveals fog", () => {
  const worker = makeUnit("worker", "player", 400, 300);   // worker sight 110
  const reveal = modifiers => {
    const map = { width: 800, height: 600, modifiers };
    const fog = createFog(map);
    updateFog({ map, units: new Map([[worker.id, worker]]), buildings: new Map() }, fog, "player");
    return fog;
  };

  const full = reveal({});
  const dim = reveal({ sightMult: 0.5 });   // effective sight 55

  assert.equal(isVisibleAt(full, 490, 300), true, "at full sight the far tile is visible");
  assert.equal(isVisibleAt(dim, 490, 300), false, "the modifier pulls that same tile out of sight");
  assert.equal(isVisibleAt(dim, 430, 300), true, "close ground stays visible under the modifier");
});

test("nearestUnexploredPoint returns the closest dark cell, and null once all is explored", () => {
  const map = mapStub(800, 600);
  const fog = createFog(map);
  // Reveal a patch around (400,300) via a worker, leaving the rest dark.
  const worker = makeUnit("worker", "player", 400, 300);
  updateFog({ map, units: new Map([[worker.id, worker]]), buildings: new Map() }, fog, "player");

  const p = nearestUnexploredPoint(fog, 400, 300);
  assert.ok(p, "there is unexplored ground to head for");
  assert.equal(isExploredAt(fog, p.x, p.y), false, "the returned point is genuinely unexplored");
  // It should be just outside the explored patch, not off in a far corner.
  assert.ok(Math.hypot(p.x - 400, p.y - 300) < 200, "and it's the NEAREST dark ground, hugging the frontier");

  // Explore everything -> null.
  fog.explored.fill(1);
  assert.equal(nearestUnexploredPoint(fog, 400, 300), null, "a fully-charted map has nothing left to find");
});

test("nearestUnexploredPoint is deterministic — same fog and origin give the same point", () => {
  const fog = createFog(mapStub(800, 600));
  fog.explored[0] = 1;   // chart one corner cell so the scan isn't trivial
  const a = nearestUnexploredPoint(fog, 400, 300);
  const b = nearestUnexploredPoint(fog, 400, 300);
  assert.deepEqual(a, b);
});
