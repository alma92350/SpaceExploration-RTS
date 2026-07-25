import { test } from "node:test";
import assert from "node:assert/strict";
import { formationSlots, clusterUnits, pickLeader, FORMATION_SHAPES } from "../engine/formation.js";
import { issueHoldFormation } from "../engine/commands.js";
import { UNITS } from "../engine/entities.js";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateCombat } from "../engine/combat.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

// A bare positioned "unit" — enough for formation.js (which only reads id/type/x/y/maxHp),
// without going through makeUnit/a real game state.
function fakeUnit(id, type, x, y, maxHp) {
  return { id, type, x, y, maxHp: maxHp ?? UNITS[type].hp };
}

// A minimal state (as the movement/combat tests use): just a unit Map + players, so we can drive
// updateCombat directly without the AI/win-checks of a full tick.
function miniState(...units) {
  return {
    units: new Map(units.map(u => [u.id, u])),
    buildings: new Map(),
    players: { player: { color: "#0ff", resources: {} }, ai: { color: "#f00", resources: {} } },
    events: [],
  };
}

// ---- pickLeader -------------------------------------------------------------

test("pickLeader picks the unit with the most maxHp", () => {
  const a = fakeUnit("u2", "skiff", 0, 0);         // maxHp 72
  const b = fakeUnit("u1", "dreadnought", 0, 0);   // maxHp 340
  const c = fakeUnit("u3", "worker", 0, 0);        // maxHp 40
  assert.equal(pickLeader([a, b, c]).id, "u1");
});

test("pickLeader breaks a maxHp tie by the lower id, never by array order", () => {
  const first = fakeUnit("u5", "skiff", 0, 0);
  const second = fakeUnit("u4", "skiff", 0, 0);   // same maxHp, lower id, listed SECOND
  assert.equal(pickLeader([first, second]).id, "u4");
  assert.equal(pickLeader([second, first]).id, "u4");
});

// ---- clusterUnits: the nesting trigger ---------------------------------------

test("clusterUnits collapses a single blob of units to one cluster — the common case", () => {
  const units = [0, 1, 2, 3, 4, 5].map(i => fakeUnit(`u${i}`, "skiff", i * 5, i * 3));
  assert.equal(clusterUnits(units).length, 1);
});

test("clusterUnits splits a selection spread across the map into separate armies", () => {
  const near = [0, 1, 2].map(i => fakeUnit(`a${i}`, "skiff", i * 10, 0));
  const far = [0, 1, 2].map(i => fakeUnit(`b${i}`, "skiff", 3000 + i * 10, 0));
  const clusters = clusterUnits([...near, ...far]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters.map(c => c.length).sort(), [3, 3]);
});

// ---- formationSlots: the default (grid, single cluster) path stays legacy-exact ----

test("formationSlots grid (no shape chosen) matches the exact legacy spacing formula", () => {
  const units = [0, 1, 2, 3].map(i => fakeUnit(`u${i}`, "skiff", 0, 0));   // co-located -> one cluster
  const spots = formationSlots(units, 900, 700);
  assert.deepEqual(spots, [
    { x: 890, y: 690 }, { x: 910, y: 690 }, { x: 890, y: 710 }, { x: 910, y: 710 },
  ]);
});

test("formationSlots on a single unit lands exactly on the destination, any shape", () => {
  for (const shape of FORMATION_SHAPES) {
    const spots = formationSlots([fakeUnit("u0", "skiff", 0, 0)], 500, 400, { shape });
    assert.deepEqual(spots, [{ x: 500, y: 400 }]);
  }
});

// ---- centroid invariant: line/wedge/circle center on the destination --------------
// (grid is the one exception: its legacy formula — kept byte-identical on purpose — only
// self-centers for a perfectly rectangular unit count, e.g. 4 = 2x2; the new shapes'
// centerOffsets pass guarantees it for ANY count, which is the property under test here.)

test("line/wedge/circle center their group's centroid exactly on the destination, for any count", () => {
  const units = [0, 1, 2, 3, 4].map(i => fakeUnit(`u${i}`, "skiff", 100 + i * 5, 100));
  for (const shape of ["line", "wedge", "circle"]) {
    const spots = formationSlots(units, 900, 700, { shape, leaderPos: "front", originX: 0, originY: 0 });
    const avgX = spots.reduce((s, p) => s + p.x, 0) / spots.length;
    const avgY = spots.reduce((s, p) => s + p.y, 0) / spots.length;
    assert.ok(Math.abs(avgX - 900) < 1e-6, `${shape}: centroid x`);
    assert.ok(Math.abs(avgY - 700) < 1e-6, `${shape}: centroid y`);
  }
});

// ---- line ---------------------------------------------------------------------

test("line formation: leaderPos front pushes the leader ahead of the rest of the line", () => {
  const leader = fakeUnit("L", "dreadnought", 0, 0);
  const followers = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [...followers, leader];
  const spots = formationSlots(units, 1000, 0, { shape: "line", leaderPos: "front", originX: 0, originY: 0 });
  const leaderX = spots[units.indexOf(leader)].x;
  const avgFollowerX = followers.reduce((s, f) => s + spots[units.indexOf(f)].x, 0) / followers.length;
  assert.ok(leaderX > avgFollowerX, "the leader sits ahead of the line toward the heading");
});

test("line formation: leaderPos back tucks the leader behind the line", () => {
  const leader = fakeUnit("L", "dreadnought", 0, 0);
  const followers = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [...followers, leader];
  const spots = formationSlots(units, 1000, 0, { shape: "line", leaderPos: "back", originX: 0, originY: 0 });
  const leaderX = spots[units.indexOf(leader)].x;
  const avgFollowerX = followers.reduce((s, f) => s + spots[units.indexOf(f)].x, 0) / followers.length;
  assert.ok(leaderX < avgFollowerX, "the leader trails behind the line");
});

// ---- wedge ----------------------------------------------------------------------

test("wedge formation: leaderPos front puts the leader at the tip, most forward of everyone", () => {
  const leader = fakeUnit("L", "dreadnought", 0, 0);
  const others = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 1000, 0, { shape: "wedge", leaderPos: "front", originX: 0, originY: 0 });
  const leaderX = spots[units.indexOf(leader)].x;
  for (const o of others) assert.ok(leaderX >= spots[units.indexOf(o)].x - 1e-6, `${o.id} trails the tip`);
});

test("wedge formation: leaderPos back shields the leader at the rear vertex, flanks leading", () => {
  const leader = fakeUnit("L", "dreadnought", 0, 0);
  const others = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 1000, 0, { shape: "wedge", leaderPos: "back", originX: 0, originY: 0 });
  const leaderX = spots[units.indexOf(leader)].x;
  for (const o of others) assert.ok(leaderX <= spots[units.indexOf(o)].x + 1e-6, `${o.id} leads ahead of the shielded leader`);
});

// ---- circle -----------------------------------------------------------------

test("circle formation: leaderPos center seats the leader at the anchor, escorted by a ring", () => {
  const leader = fakeUnit("L", "dreadnought", 0, 0);
  const others = [1, 2, 3, 4, 5].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 900, 700, { shape: "circle", leaderPos: "center", originX: 0, originY: 0 });
  const leaderSpot = spots[units.indexOf(leader)];
  assert.ok(Math.hypot(leaderSpot.x - 900, leaderSpot.y - 700) < 0.5, "leader sits at the anchor");
  for (const o of others) {
    const p = spots[units.indexOf(o)];
    assert.ok(Math.hypot(p.x - 900, p.y - 700) > 10, `${o.id} stands out on the protective ring`);
  }
});

test("circle formation: leaderPos front/back puts every unit, leader included, on the ring", () => {
  const leader = fakeUnit("L", "dreadnought", 0, 0);
  const others = [1, 2, 3].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 900, 700, { shape: "circle", leaderPos: "front", originX: 0, originY: 0 });
  const radii = spots.map(p => Math.hypot(p.x - 900, p.y - 700));
  const [min, max] = [Math.min(...radii), Math.max(...radii)];
  assert.ok(max - min < 1, "every unit, leader included, sits on the same ring radius");
});

// ---- sufficient spacing, scaled to hull size ---------------------------------

test("formation slots keep at least 2x the largest hull's radius apart from each other", () => {
  const units = [0, 1, 2, 3].map(i => fakeUnit(`u${i}`, "bulkfreighter", 0, 0));   // radius 15 — the biggest hull
  const minGap = 2 * UNITS.bulkfreighter.radius;
  for (const shape of ["line", "wedge", "circle"]) {
    const spots = formationSlots(units, 1000, 0, { shape, leaderPos: "front", originX: 0, originY: 0 });
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y) >= minGap - 1e-6,
          `${shape}: slots ${i},${j} clear two ${UNITS.bulkfreighter.radius}-radius hulls`);
  }
});

test("the spacing constant itself scales up for a bulkier group, not a flat number", () => {
  const spread = spots => Math.max(...spots.map(p => Math.hypot(p.x - 1000, p.y)));
  const skiffSpots = formationSlots([0, 1, 2, 3].map(i => fakeUnit(`s${i}`, "skiff", 0, 0)),
    1000, 0, { shape: "line", leaderPos: "front", originX: 0, originY: 0 });
  const freighterSpots = formationSlots([0, 1, 2, 3].map(i => fakeUnit(`b${i}`, "bulkfreighter", 0, 0)),
    1000, 0, { shape: "line", leaderPos: "front", originX: 0, originY: 0 });
  assert.ok(spread(freighterSpots) > spread(skiffSpots), "a group of Bulk Freighters claims more room than a group of Skiffs");
});

// ---- nested formations: formation OF formations ------------------------------

test("formationSlots lays out a nested formation of formations — tight within each army, well clear between them", () => {
  const near = [0, 1, 2].map(i => fakeUnit(`a${i}`, "skiff", i * 10, 0));
  const far = [0, 1, 2].map(i => fakeUnit(`b${i}`, "skiff", 3000 + i * 10, 0));
  const units = [...near, ...far];
  const spots = formationSlots(units, 1500, 0, { shape: "grid" });

  const centroidOf = pts => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
  const nearSpots = near.map(u => spots[units.indexOf(u)]);
  const farSpots = far.map(u => spots[units.indexOf(u)]);
  const nc = centroidOf(nearSpots), fc = centroidOf(farSpots);
  const betweenClusters = Math.hypot(nc.x - fc.x, nc.y - fc.y);
  const withinNear = Math.max(...nearSpots.map(p => Math.hypot(p.x - nc.x, p.y - nc.y)));
  const withinFar = Math.max(...farSpots.map(p => Math.hypot(p.x - fc.x, p.y - fc.y)));

  assert.ok(betweenClusters > withinNear * 3, "the two sub-formations sit well apart relative to their own tight internal spread");
  assert.ok(betweenClusters > withinFar * 3);

  // The overall layout still centers on the destination, even nested.
  const avgX = spots.reduce((s, p) => s + p.x, 0) / spots.length;
  const avgY = spots.reduce((s, p) => s + p.y, 0) / spots.length;
  assert.ok(Math.abs(avgX - 1500) < 5 && Math.abs(avgY - 0) < 5, "the nested layout as a whole is still centered on the destination");
});

// ---- issueHoldFormation (engine/commands.js) ---------------------------------

test("issueHoldFormation anchors the group on its own current centroid, not the map origin", () => {
  const units = [
    { id: "u1", type: "skiff", x: 100, y: 100, maxHp: 72, order: null },
    { id: "u2", type: "skiff", x: 120, y: 100, maxHp: 72, order: null },
  ];
  issueHoldFormation(units, "grid", "front");
  for (const u of units) {
    assert.equal(u.order.type, "hold-formation");
    assert.equal(u.order.anchorX, 110);
    assert.equal(u.order.anchorY, 100);
    assert.equal(u.hold, true, "a combat unit also takes the Hold stance");
  }
});

test("issueHoldFormation gives a non-combat unit a slot but no Hold stance to set", () => {
  const worker = { id: "u1", type: "worker", x: 0, y: 0, maxHp: 40, order: null };
  issueHoldFormation([worker]);
  assert.equal(worker.order.type, "hold-formation");
  assert.ok(!worker.hold);
});

test("issueHoldFormation on an empty selection is a safe no-op", () => {
  assert.doesNotThrow(() => issueHoldFormation([]));
});

// ---- sim/combat integration: keepFormationStation ----------------------------

test("a combat unit holding formation converges on its own anchor+offset slot and never clears the order on arrival", () => {
  const units = [makeUnit("skiff", "player", 100, 100), makeUnit("skiff", "player", 300, 300)];
  const s = miniState(...units);
  issueHoldFormation(units, "line", "front");
  for (let i = 0; i < 400; i++) for (const u of units) updateCombat(s, u, 0.1);
  for (const u of units) {
    const tx = u.order.anchorX + u.order.offsetX, ty = u.order.anchorY + u.order.offsetY;
    assert.ok(Math.hypot(u.x - tx, u.y - ty) < 5, `${u.id} reached its formation slot`);
    assert.equal(u.order.type, "hold-formation", "arrival never clears a hold-formation order");
  }
});

test("a unit holding formation still fires on a threat that wanders into weapon range", () => {
  const guard = makeUnit("skiff", "player", 500, 500);
  const s = miniState(guard);
  issueHoldFormation([guard]);
  for (let i = 0; i < 50; i++) updateCombat(s, guard, 0.1);
  const enemy = makeUnit("skiff", "ai", guard.x + 20, guard.y);   // inside skiff's 40 weapon range
  enemy.hp = enemy.maxHp = 100000;
  s.units.set(enemy.id, enemy);
  for (let i = 0; i < 80; i++) updateCombat(s, guard, 0.1);
  assert.ok(enemy.hp < enemy.maxHp, "the formation held its post but still engaged the threat");
});

test("the Hold stance keeps a formation unit from chasing a target out of weapon range", () => {
  const guard = makeUnit("skiff", "player", 500, 500);   // skiff: range 40, aggroRange 120
  const s = miniState(guard);
  issueHoldFormation([guard]);
  const enemy = makeUnit("skiff", "ai", guard.x + 80, guard.y);   // inside aggro, outside weapon range
  s.units.set(enemy.id, enemy);
  const startX = guard.x, startY = guard.y;
  for (let i = 0; i < 50; i++) updateCombat(s, guard, 0.1);
  assert.ok(Math.hypot(guard.x - startX, guard.y - startY) < 2, "held ground instead of closing on an out-of-range target");
});

test("a worker (non-combat) holding formation reaches its slot via the full sim tick path", () => {
  const s = createGameState({ planetId: "ferros", seed: 2 });
  const w1 = makeUnit("worker", "player", 500, 500);
  const w2 = makeUnit("worker", "player", 700, 500);
  s.units.set(w1.id, w1); s.units.set(w2.id, w2);
  issueHoldFormation([w1, w2], "line", "front");
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  for (const u of [w1, w2]) {
    const tx = u.order.anchorX + u.order.offsetX, ty = u.order.anchorY + u.order.offsetY;
    assert.ok(Math.hypot(u.x - tx, u.y - ty) < 10, `${u.id} reached its slot`);
    assert.equal(u.order.type, "hold-formation");
  }
});

test("a support unit (Mender) holding formation keeps station via updateSupport", () => {
  const s = createGameState({ planetId: "ferros", seed: 3 });
  const m1 = makeUnit("mender", "player", 500, 500);
  const m2 = makeUnit("mender", "player", 700, 500);
  s.units.set(m1.id, m1); s.units.set(m2.id, m2);
  issueHoldFormation([m1, m2], "circle", "front");
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  for (const u of [m1, m2]) {
    const tx = u.order.anchorX + u.order.offsetX, ty = u.order.anchorY + u.order.offsetY;
    assert.ok(Math.hypot(u.x - tx, u.y - ty) < 10, `${u.id} reached its slot`);
  }
});

// ---- persistence --------------------------------------------------------------

test("a hold-formation order survives save/load, and a tampered anchor/offset can't crash or NaN-poison the unit", () => {
  const s = createGameState({ planetId: "ferros", seed: 4 });
  const u1 = makeUnit("skiff", "player", 500, 500);
  const u2 = makeUnit("skiff", "player", 600, 500);
  s.units.set(u1.id, u1); s.units.set(u2.id, u2);
  issueHoldFormation([u1, u2], "wedge", "back");

  const restored = deserializeGame(JSON.parse(JSON.stringify(serializeGame(s))));
  const ru1 = [...restored.units.values()].find(u => u.id === u1.id);
  assert.equal(ru1.order.type, "hold-formation");
  assert.equal(ru1.order.anchorX, u1.order.anchorX);
  assert.equal(ru1.order.offsetY, u1.order.offsetY);

  // Tamper the anchor/offset with garbage and confirm the tick loop stays safe — stepToward
  // (engine/movement.js) already refuses a non-finite destination, so this needs no dedicated
  // sanitizer in persist.js's cleanEntity.
  ru1.order.anchorX = "not-a-number";
  ru1.order.offsetY = Infinity;
  tick(restored, 0.1);
  assert.ok(Number.isFinite(ru1.x) && Number.isFinite(ru1.y), "position stays finite even with a garbage anchor/offset");
});
