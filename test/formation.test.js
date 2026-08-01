import { test } from "node:test";
import assert from "node:assert/strict";
import { formationSlots, clusterUnits, pickLeader, FORMATION_SHAPES } from "../engine/formation.js";
import { issueHoldFormation, issueMove, issueAttackMove, issueStop } from "../engine/commands.js";
import { UNITS } from "../engine/entities.js";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateCombat } from "../engine/combat.js";
import { serializeGame, deserializeGame } from "../engine/persist.js";

// A bare positioned "unit" — enough for formation.js (which only reads id/type/x/y/maxHp),
// without going through makeUnit/a real game state. No `owner` on purpose for the pure-geometry
// tests below (formation.js itself doesn't care); tests that exercise the PLAYER leader/follow
// squad mechanic (engine/commands.js) need a real owner:"player" — see fakePlayerUnit.
function fakeUnit(id, type, x, y, maxHp) {
  return { id, type, x, y, maxHp: maxHp ?? UNITS[type].hp, order: null };
}
function fakePlayerUnit(id, type, x, y) {
  return { ...fakeUnit(id, type, x, y), owner: "player" };
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

// ---- pickLeader: the unit FIRST in the array, not a stat-based pick ----------

test("pickLeader is simply the first unit in the array — the one the rest were added to", () => {
  const a = fakeUnit("u2", "dreadnought", 0, 0);   // highest maxHp, but NOT first
  const b = fakeUnit("u1", "skiff", 0, 0);          // listed first
  assert.equal(pickLeader([b, a]).id, "u1");
  assert.equal(pickLeader([a, b]).id, "u2", "array order alone decides it — not maxHp");
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

test("clusterUnits keeps the cluster containing units[0] first, so it stays the outer leader cluster", () => {
  const leaderSide = [0, 1].map(i => fakeUnit(`L${i}`, "skiff", i * 10, 0));
  const otherSide = [0, 1].map(i => fakeUnit(`O${i}`, "skiff", 3000 + i * 10, 0));
  const clusters = clusterUnits([...leaderSide, ...otherSide]);
  assert.equal(clusters[0][0].id, "L0", "units[0]'s cluster is clusters[0]");
});

test("clusterUnits groups a transitive chain (A-B close, B-C close, A-C far) into one cluster — true transitive closure, not a naive pairwise check", () => {
  // engine/formation.js's own (unexported) CLUSTER_RADIUS — mirrored here, not imported, same as
  // GRID_SPACING's legacy constant is mirrored numerically further down this file.
  const CLUSTER_RADIUS = 150;
  const a = fakeUnit("A", "skiff", 0, 0);
  const b = fakeUnit("B", "skiff", 140, 0);    // 140 from A: within CLUSTER_RADIUS
  const c = fakeUnit("C", "skiff", 280, 0);    // 140 from B: within CLUSTER_RADIUS; 280 from A: NOT
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) <= CLUSTER_RADIUS, "fixture: A-B is a close pair");
  assert.ok(Math.hypot(c.x - b.x, c.y - b.y) <= CLUSTER_RADIUS, "fixture: B-C is a close pair");
  assert.ok(Math.hypot(c.x - a.x, c.y - a.y) > CLUSTER_RADIUS, "fixture: A-C is NOT directly within radius of each other");

  const clusters = clusterUnits([a, b, c]);

  // A pairwise-only check (each unit tested only against the group's first/anchor member) would
  // put C in its own cluster, since A-C alone are too far apart — only real transitive closure
  // through B still catches it.
  assert.equal(clusters.length, 1, "A-B-C should collapse to one cluster via transitive closure through B");
  assert.deepEqual(new Set(clusters[0].map(u => u.id)), new Set(["A", "B", "C"]), "all three units land in that one cluster");
});

// ---- formationSlots: the default (grid, single cluster) path uses the flat, scaled spacing ----

test("formationSlots grid (no shape chosen) matches the flat GRID_SPACING formula (legacy 20, +15% then a further +20% coarser)", () => {
  const units = [0, 1, 2, 3].map(i => fakeUnit(`u${i}`, "skiff", 0, 0));   // co-located -> one cluster
  const spots = formationSlots(units, 900, 700);
  assert.deepEqual(spots, [
    { x: 886.2, y: 686.2 }, { x: 913.8, y: 686.2 }, { x: 886.2, y: 713.8 }, { x: 913.8, y: 713.8 },
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

// ---- explicit heading override ------------------------------------------------

test("an explicit headingX/headingY overrides the origin-derived heading", () => {
  const units = [0, 1, 2, 3].map(i => fakeUnit(`u${i}`, "skiff", 0, 0));
  // origin==dest (no travel at all) defaults to a stable heading (see the "line formation"
  // tests below, which rely on exactly this default) — an explicit override must still change
  // the resulting layout rather than being silently ignored.
  const withoutOverride = formationSlots(units, 500, 500, { shape: "line", originX: 500, originY: 500 });
  const withOverride = formationSlots(units, 500, 500, { shape: "line", originX: 500, originY: 500, headingX: 0, headingY: -1 });
  assert.notDeepEqual(withOverride, withoutOverride, "an explicit heading produces a different layout than the origin-derived default");
});

// ---- line ---------------------------------------------------------------------
// The leader is always units[0] — these tests put the intended leader FIRST in the array.

test("line formation: leaderPos front pushes the leader ahead of the rest of the line", () => {
  const leader = fakeUnit("L", "skiff", 0, 0);
  const followers = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...followers];
  const spots = formationSlots(units, 1000, 0, { shape: "line", leaderPos: "front", originX: 0, originY: 0 });
  const leaderX = spots[0].x;
  const avgFollowerX = spots.slice(1).reduce((s, p) => s + p.x, 0) / followers.length;
  assert.ok(leaderX > avgFollowerX, "the leader sits ahead of the line toward the heading");
});

test("line formation: leaderPos back tucks the leader behind the line", () => {
  const leader = fakeUnit("L", "skiff", 0, 0);
  const followers = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...followers];
  const spots = formationSlots(units, 1000, 0, { shape: "line", leaderPos: "back", originX: 0, originY: 0 });
  const leaderX = spots[0].x;
  const avgFollowerX = spots.slice(1).reduce((s, p) => s + p.x, 0) / followers.length;
  assert.ok(leaderX < avgFollowerX, "the leader trails behind the line");
});

// ---- wedge ----------------------------------------------------------------------

test("wedge formation: leaderPos front puts the leader at the tip, most forward of everyone", () => {
  const leader = fakeUnit("L", "skiff", 0, 0);
  const others = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 1000, 0, { shape: "wedge", leaderPos: "front", originX: 0, originY: 0 });
  const leaderX = spots[0].x;
  for (const p of spots.slice(1)) assert.ok(leaderX >= p.x - 1e-6, "every flank trails the tip");
});

test("wedge formation: leaderPos back shields the leader at the rear vertex, flanks leading", () => {
  const leader = fakeUnit("L", "skiff", 0, 0);
  const others = [1, 2, 3, 4].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 1000, 0, { shape: "wedge", leaderPos: "back", originX: 0, originY: 0 });
  const leaderX = spots[0].x;
  for (const p of spots.slice(1)) assert.ok(leaderX <= p.x + 1e-6, "every flank leads ahead of the shielded leader");
});

// ---- circle -----------------------------------------------------------------

test("circle formation: leaderPos center seats the leader at the anchor, escorted by a ring", () => {
  const leader = fakeUnit("L", "skiff", 0, 0);
  const others = [1, 2, 3, 4, 5].map(i => fakeUnit(`f${i}`, "skiff", 0, 0));
  const units = [leader, ...others];
  const spots = formationSlots(units, 900, 700, { shape: "circle", leaderPos: "center", originX: 0, originY: 0 });
  assert.ok(Math.hypot(spots[0].x - 900, spots[0].y - 700) < 0.5, "leader sits at the anchor");
  for (const p of spots.slice(1)) assert.ok(Math.hypot(p.x - 900, p.y - 700) > 10, "an escort stands out on the protective ring");
});

test("circle formation: leaderPos front/back puts every unit, leader included, on the ring", () => {
  const leader = fakeUnit("L", "skiff", 0, 0);
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

  // The overall layout still centers on the destination, even nested. The tolerance scales with
  // COARSENESS (engine/formation.js) like every other footprint distance here — a small, pre-existing
  // rounding asymmetry from the odd (3-per-cluster) count, not a bug: it was ~4.2 at the previous
  // COARSENESS and is ~5.06 now, both comfortably sub-hull-radius.
  const avgX = spots.reduce((s, p) => s + p.x, 0) / spots.length;
  const avgY = spots.reduce((s, p) => s + p.y, 0) / spots.length;
  assert.ok(Math.abs(avgX - 1500) < 6 && Math.abs(avgY - 0) < 6, "the nested layout as a whole is still centered on the destination");
});

// ---- AI-owned (and owner-less) units never form a squad ----------------------
// The leader/follow mechanic is a PLAYER selection-UX feature: the scripted AI (and any test
// double with no owner set) always gets the plain, pre-existing per-unit spread — every unit its
// own real order, no leader, no follow-leader, no speed cap.

test("issueMove on AI-owned units gives every unit its own real move order — no squad", () => {
  const units = [fakeUnit("a1", "skiff", 0, 0), fakeUnit("a2", "skiff", 0, 0)].map(u => ({ ...u, owner: "ai" }));
  issueMove(units, 900, 700);
  for (const u of units) {
    assert.equal(u.order.type, "move");
    assert.ok(Number.isFinite(u.order.x) && Number.isFinite(u.order.y));
  }
  assert.equal(units[1].order.type, "move", "the second unit is NOT a follow-leader");
  assert.equal(units.some(u => u.squadLeader), false);
});

test("issueMove on owner-less units (a bare test double) also skips the squad mechanic", () => {
  const units = [fakeUnit("u1", "skiff", 0, 0), fakeUnit("u2", "skiff", 0, 0)];   // no owner field at all
  issueMove(units, 900, 700);
  units.forEach(u => assert.equal(u.order.type, "move"));
});

// ---- range-layered formation ranks: brawlers screen, artillery trails (engine/commands.js
// dispatchFormation) -------------------------------------------------------------------------
// Within an opt-in SHAPED formation (not the legacy grid spread), dispatchFormation re-pairs the
// followers with their slots by weapon range instead of raw selection-array order: shortest-ranged
// (Bastion range 44, Skiff range 40) take the most forward slots, longest-ranged (Breacher range
// 150, Lancer range 55) the rearmost. Only the PLAYER leader/follower path does this (the AI/
// owner-less path above already returned before any of it runs), so every follower here ends up
// with a "follow-leader" order whose offsetX/offsetY IS its position relative to the leader —
// and since every unit starts co-located and travels straight along +x, offsetX alone measures
// forwardness (see engine/formation.js layout()'s hx=1,hy=0 basis for a pure +x heading).

test("a wedge formation ranks followers by weapon range — short-ranged Bastions screen ahead of long-ranged Breachers", () => {
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  // Interleaved (not grouped by type) in the selection array, and the long-ranged Breachers listed
  // BEFORE the short-ranged Bastions — so a pass can only be explained by the RANGE-based reorder,
  // never by a coincidence of array order.
  const r1 = fakePlayerUnit("R1", "breacher", 0, 0);   // range 150
  const b1 = fakePlayerUnit("B1", "bastion", 0, 0);    // range 44
  const r2 = fakePlayerUnit("R2", "breacher", 0, 0);
  const b2 = fakePlayerUnit("B2", "bastion", 0, 0);
  const units = [leader, r1, b1, r2, b2];

  issueMove(units, 1000, 0, false, { shape: "wedge", leaderPos: "front" });

  for (const u of [r1, b1, r2, b2]) assert.equal(u.order.type, "follow-leader", "sanity: a real squad formed");
  const bastionFwd = [b1, b2].map(u => u.order.offsetX);
  const breacherFwd = [r1, r2].map(u => u.order.offsetX);
  assert.ok(Math.min(...bastionFwd) > Math.max(...breacherFwd),
    "every short-ranged Bastion sits strictly ahead of every long-ranged Breacher");
});

test("an unarmed support unit (Mender) sinks to the rear of a shaped formation, not the front", () => {
  // UNITS[type].range is undefined for the Mender (role:"support", unarmed) — the proposal's own
  // Problem/Change text says "support (Mender) and unarmed units innermost/rear", so the missing-
  // range fallback must sort LAST (rearmost), not first. A bare `?? -1` would make it the single
  // lowest key in the whole army and put it on the MOST forward slot instead — exactly backwards.
  // Same two-rank-wedge shape (4 followers, 2 per type) as the Bastion/Breacher test above: a
  // 1-follower-per-side wedge ties every follower's forwardness, so this needs real depth to split.
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  const m1 = fakePlayerUnit("M1", "mender", 0, 0);   // no range field at all
  const b1 = fakePlayerUnit("B1", "bastion", 0, 0);  // range 44 — the shortest armed range in the roster
  const m2 = fakePlayerUnit("M2", "mender", 0, 0);
  const b2 = fakePlayerUnit("B2", "bastion", 0, 0);
  const units = [leader, m1, b1, m2, b2];

  issueMove(units, 1000, 0, false, { shape: "wedge", leaderPos: "front" });

  const menderFwd = [m1, m2].map(u => u.order.offsetX);
  const bastionFwd = [b1, b2].map(u => u.order.offsetX);
  assert.ok(Math.max(...menderFwd) < Math.min(...bastionFwd),
    "the unarmed Menders sit strictly behind every armed unit, including the shortest-ranged Bastion");
});

test("issueHoldFormation (origin === destination) also range-ranks — the near-zero heading still resolves to a real forward axis", () => {
  // issueHoldFormation forms up right where the group already stands (origin===dest), the one
  // case where the origin-derived heading is degenerate (0,0) — engine/formation.js resolveHeading
  // must still fall back to a real orientation (facing +x) for the ranking to mean anything. Same
  // 4-follower wedge shape as the test above (a "line", or a 1-follower-per-side wedge, ties every
  // follower's forwardness exactly — see engine/formation.js lineOffsets/wedgeOffsets — so this
  // needs the same two-rank wedge to actually exercise a real forward/rear split).
  const leader = fakePlayerUnit("L", "skiff", 500, 500);
  const r1 = fakePlayerUnit("R1", "breacher", 500, 500);
  const b1 = fakePlayerUnit("B1", "bastion", 500, 500);
  const r2 = fakePlayerUnit("R2", "breacher", 500, 500);
  const b2 = fakePlayerUnit("B2", "bastion", 500, 500);
  const units = [leader, r1, b1, r2, b2];

  issueHoldFormation(units, "wedge", "front");

  const bastionFwd = [b1, b2].map(u => u.order.offsetX);
  const breacherFwd = [r1, r2].map(u => u.order.offsetX);
  assert.ok(Math.min(...bastionFwd) > Math.max(...breacherFwd),
    "even holding in place, the short-ranged Bastions still screen ahead of the long-ranged Breachers");
});

test("a wedge formation still keeps the leader at slot 0, whatever the leader's own weapon range", () => {
  // The leader is a documented player choice (engine/formation.js header) — never re-picked by a
  // stat like range, even when the leader itself happens to be the longest-ranged unit present.
  const leader = fakePlayerUnit("L", "breacher", 0, 0);   // long range, but listed first -> stays leader
  const follower = fakePlayerUnit("F", "skiff", 0, 0);    // short range
  const units = [leader, follower];

  issueMove(units, 1000, 0, false, { shape: "wedge", leaderPos: "front" });

  assert.equal(leader.order.type, "move", "the leader always gets its own real order, never a follow-leader offset");
  assert.equal(follower.order.type, "follow-leader");
});

test("a grid-shaped formation is never range-reordered, even for a player squad with mixed ranges — the legacy path stays byte-identical", () => {
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  // Long-range Breacher listed BEFORE the short-range Bastion — a range-based reorder would put
  // the Bastion ahead; the plain grid spread must not.
  const breacher = fakePlayerUnit("R", "breacher", 0, 0);
  const bastion = fakePlayerUnit("B", "bastion", 0, 0);
  const units = [leader, breacher, bastion];

  // What formationSlots itself produces, unmodified — dispatchFormation must pass this straight
  // through for a "grid" shape, with no range-based re-pairing at all.
  const rawSpots = formationSlots(units, 1000, 0, { shape: "grid" });

  issueMove(units, 1000, 0, false, { shape: "grid" });

  assert.deepEqual({ x: breacher.order.offsetX, y: breacher.order.offsetY },
    { x: rawSpots[1].x - rawSpots[0].x, y: rawSpots[1].y - rawSpots[0].y },
    "the breacher (listed first among followers) keeps formationSlots' own raw slot 1");
  assert.deepEqual({ x: bastion.order.offsetX, y: bastion.order.offsetY },
    { x: rawSpots[2].x - rawSpots[0].x, y: rawSpots[2].y - rawSpots[0].y },
    "the bastion keeps formationSlots' own raw slot 2");
});

test("issueMove with no formation at all is never range-reordered either — the AI's plain call path", () => {
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  const breacher = fakePlayerUnit("R", "breacher", 0, 0);
  const bastion = fakePlayerUnit("B", "bastion", 0, 0);
  const units = [leader, breacher, bastion];

  const rawSpots = formationSlots(units, 1000, 0);   // no opts at all -> formationSlots' own "grid" default

  issueMove(units, 1000, 0);   // no formation argument

  assert.deepEqual({ x: breacher.order.offsetX, y: breacher.order.offsetY },
    { x: rawSpots[1].x - rawSpots[0].x, y: rawSpots[1].y - rawSpots[0].y });
});

// ---- issueHoldFormation / the leader-follow squad (engine/commands.js) -------

test("issueHoldFormation makes units[0] the leader (anchored near the group's own centroid) and everyone else a follower", () => {
  const units = [fakePlayerUnit("u1", "skiff", 100, 100), fakePlayerUnit("u2", "skiff", 120, 100)];
  issueHoldFormation(units, "grid", "front");
  const [leader, follower] = units;
  assert.equal(leader.order.type, "hold-formation");
  // The grid shape gives the leader its own slot in the grid (not necessarily the exact
  // centroid — see the "matches the exact legacy spacing formula" test), but it's always
  // WITHIN the group's own footprint, close to where the two units actually are.
  assert.ok(Math.hypot(leader.order.anchorX - 110, leader.order.anchorY - 100) < 20);
  assert.equal(follower.order.type, "follow-leader");
  assert.equal(follower.order.leader, leader);
  assert.equal(follower.squadLeader, leader);
  assert.deepEqual(leader.squadFollowers, [follower]);
  assert.equal(leader.hold, true, "a combat leader also takes the Hold stance");
  assert.equal(follower.hold, true, "…and so does a combat follower");
  // Leader and follower end up at distinct points (the formation's own spacing), not stacked.
  const followerTarget = { x: leader.order.anchorX + follower.order.offsetX, y: leader.order.anchorY + follower.order.offsetY };
  assert.ok(Math.hypot(followerTarget.x - leader.order.anchorX, followerTarget.y - leader.order.anchorY) > 5);
});

test("issueHoldFormation gives a non-combat unit a slot but no Hold stance to set", () => {
  const worker = fakePlayerUnit("u1", "worker", 0, 0);
  issueHoldFormation([worker]);
  assert.equal(worker.order.type, "hold-formation");
  assert.ok(!worker.hold);
});

test("issueHoldFormation on an empty selection is a safe no-op", () => {
  assert.doesNotThrow(() => issueHoldFormation([]));
});

// ---- persistent leader-follow: select the leader alone, move it, others trail --

test("a solo move on the leader alone drags its existing followers along, capped to the group's slowest speed", () => {
  const leader = fakePlayerUnit("L", "bulkfreighter", 100, 100);   // slow (speed 32)
  const follower = fakePlayerUnit("F", "ranger", 120, 100);        // fast (speed 115)
  issueMove([leader, follower], 1000, 100);
  assert.equal(leader.order.speedCap, UNITS.bulkfreighter.speed * 0.95, "capped to 95% of the slowest member's speed, leaving it room to catch up");
  assert.equal(follower.order.type, "follow-leader");
  assert.equal(follower.order.leader, leader);

  // Now command the LEADER alone — the follower's order is untouched (still follow-leader,
  // still pointing at the same live leader object), so it keeps trailing automatically.
  issueMove([leader], 50, 100);
  assert.equal(leader.order.type, "move");
  assert.equal(leader.order.speedCap, UNITS.bulkfreighter.speed * 0.95, "the solo command still re-derives the group's speed cap");
  assert.equal(follower.order.type, "follow-leader", "never re-issued — it was already chasing the leader");
  assert.equal(follower.order.leader, leader);
});

test("a follower given a DIRECT order leaves the squad — the leader's own list drops it", () => {
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  const follower = fakePlayerUnit("F", "skiff", 0, 0);
  issueHoldFormation([leader, follower]);
  assert.equal(follower.squadLeader, leader);

  issueMove([follower], 500, 500);   // a direct command to the follower alone

  assert.equal(follower.order.type, "move", "direct control wins");
  assert.equal(follower.squadLeader, undefined, "no longer tracked as this leader's follower");
  assert.deepEqual(leader.squadFollowers, [], "the leader's own list was trimmed to match");
});

test("issueStop on a follower releases it from the squad too", () => {
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  const follower = fakePlayerUnit("F", "skiff", 0, 0);
  issueHoldFormation([leader, follower]);
  issueStop([follower]);
  assert.equal(follower.order, null);
  assert.equal(follower.squadLeader, undefined);
  assert.deepEqual(leader.squadFollowers, []);
});

test("redefining a leader's squad with a smaller group stops (not just unlinks) the dropped-out unit", () => {
  const leader = fakePlayerUnit("L", "skiff", 0, 0);
  const a = fakePlayerUnit("A", "skiff", 0, 0);
  const b = fakePlayerUnit("B", "skiff", 0, 0);
  issueHoldFormation([leader, a, b]);
  assert.deepEqual(leader.squadFollowers, [a, b]);

  issueMove([leader, a], 500, 0);   // a fresh command that only re-selects the leader + A

  assert.deepEqual(leader.squadFollowers, [a], "B fell out of the squad");
  assert.equal(b.squadLeader, undefined);
  assert.equal(b.order, null, "B is actually stopped, not left silently chasing a leader that dropped it");
  assert.equal(a.order.type, "follow-leader", "A is still following");
});

// ---- click-and-drag facing (engine/commands.js applyFacing) ------------------

test("issueMove with an explicit heading stamps every commanded unit's facing; a plain move clears it", () => {
  const units = [fakePlayerUnit("u1", "skiff", 0, 0), fakePlayerUnit("u2", "skiff", 0, 0)];
  issueMove(units, 100, 0, false, { headingX: 0, headingY: 1 });   // facing straight down (+y)
  for (const u of units) assert.ok(Math.abs(u.facing - Math.PI / 2) < 1e-6);

  issueMove(units, 100, 0);   // a later plain move, no heading
  for (const u of units) assert.ok(!Number.isFinite(u.facing), "no explicit heading clears the earlier facing");
});

test("issueAttackMove also stamps and clears facing the same way", () => {
  const units = [fakePlayerUnit("u1", "skiff", 0, 0)];
  issueAttackMove(units, 100, 0, false, { headingX: -1, headingY: 0 });   // facing left
  assert.ok(Math.abs(units[0].facing - Math.PI) < 1e-6);
  issueAttackMove(units, 100, 0);
  assert.ok(!Number.isFinite(units[0].facing));
});

// ---- sim/combat integration: keepFormationStation / keepFollowingLeader -----

test("a leader holding formation converges on its own anchor; a follower converges on leader+offset — arrival never clears either", () => {
  const leader = makeUnit("skiff", "player", 100, 100);
  const follower = makeUnit("skiff", "player", 300, 300);
  const units = [leader, follower];
  const s = miniState(...units);
  issueHoldFormation(units, "line", "front");
  for (let i = 0; i < 400; i++) for (const u of units) updateCombat(s, u, 0.1);

  const leaderTarget = { x: leader.order.anchorX + leader.order.offsetX, y: leader.order.anchorY + leader.order.offsetY };
  assert.ok(Math.hypot(leader.x - leaderTarget.x, leader.y - leaderTarget.y) < 5, "leader reached its own anchor");
  assert.equal(leader.order.type, "hold-formation");

  const followerTarget = { x: leader.x + follower.order.offsetX, y: leader.y + follower.order.offsetY };
  assert.ok(Math.hypot(follower.x - followerTarget.x, follower.y - followerTarget.y) < 5, "follower reached leader+offset");
  assert.equal(follower.order.type, "follow-leader");
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

test("a combat follower still auto-engages a threat, then resumes following", () => {
  const leader = makeUnit("skiff", "player", 500, 500);
  const follower = makeUnit("skiff", "player", 540, 500);
  const units = [leader, follower];
  const s = miniState(...units);
  issueHoldFormation(units);
  for (let i = 0; i < 100; i++) for (const u of units) updateCombat(s, u, 0.1);   // settle into formation

  const enemy = makeUnit("skiff", "ai", follower.x + 20, follower.y);   // right on the follower
  enemy.hp = enemy.maxHp = 100000;
  s.units.set(enemy.id, enemy);
  for (let i = 0; i < 80; i++) updateCombat(s, follower, 0.1);
  assert.ok(enemy.hp < enemy.maxHp, "the follower broke to engage a threat at its post");
  assert.equal(follower.order.type, "follow-leader", "still tracking its leader throughout");
});

test("a follower drops its order (free to be re-ordered) the moment its leader dies", () => {
  const leader = makeUnit("skiff", "player", 500, 500);
  const follower = makeUnit("skiff", "player", 540, 500);
  const s = miniState(leader, follower);
  issueHoldFormation([leader, follower]);
  leader.hp = 0;   // the leader has died (removeEntity already dropped it from state.units in real play)
  updateCombat(s, follower, 0.1);
  assert.equal(follower.order, null, "no live leader to follow → free for a new order");
});

test("a worker (non-combat) leader+follower pair reaches its formation via the full sim tick path", () => {
  const s = createGameState({ planetId: "ferros", seed: 2 });
  const w1 = makeUnit("worker", "player", 500, 500);
  const w2 = makeUnit("worker", "player", 700, 500);
  const units = [w1, w2];
  s.units.set(w1.id, w1); s.units.set(w2.id, w2);
  issueHoldFormation(units, "line", "front");
  for (let i = 0; i < 200; i++) tick(s, 0.1);

  const leaderTarget = { x: w1.order.anchorX + w1.order.offsetX, y: w1.order.anchorY + w1.order.offsetY };
  assert.ok(Math.hypot(w1.x - leaderTarget.x, w1.y - leaderTarget.y) < 10, "leader reached its anchor");
  const followerTarget = { x: w1.x + w2.order.offsetX, y: w1.y + w2.order.offsetY };
  assert.ok(Math.hypot(w2.x - followerTarget.x, w2.y - followerTarget.y) < 10, "follower reached leader+offset");
});

test("a support unit (Mender) leader+follower pair keeps station via updateSupport", () => {
  const s = createGameState({ planetId: "ferros", seed: 3 });
  const m1 = makeUnit("mender", "player", 500, 500);
  const m2 = makeUnit("mender", "player", 700, 500);
  s.units.set(m1.id, m1); s.units.set(m2.id, m2);
  issueHoldFormation([m1, m2], "circle", "front");
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  const leaderTarget = { x: m1.order.anchorX + m1.order.offsetX, y: m1.order.anchorY + m1.order.offsetY };
  assert.ok(Math.hypot(m1.x - leaderTarget.x, m1.y - leaderTarget.y) < 10);
  const followerTarget = { x: m1.x + m2.order.offsetX, y: m1.y + m2.order.offsetY };
  assert.ok(Math.hypot(m2.x - followerTarget.x, m2.y - followerTarget.y) < 10);
});

test("a formation's travel speed never outruns its slowest member, via the real tick loop", () => {
  const s = createGameState({ planetId: "ferros", seed: 5 });
  const leader = makeUnit("bulkfreighter", "player", 500, 500);   // speed 32 — the slowest
  // Placed ALONGSIDE the leader (perpendicular to the +x travel direction), not directly ahead
  // of it on the path — so movement.js's lateral-avoidance sensing (same-owner neighbours AHEAD
  // in the seek direction) never engages and curves either unit's path, keeping this a clean
  // measurement of the speed cap alone.
  const follower = makeUnit("ranger", "player", 500, 530);        // speed 115 — much faster
  s.units.set(leader.id, leader); s.units.set(follower.id, follower);
  issueMove([leader, follower], 1500, 500);
  for (let i = 0; i < 50; i++) tick(s, 0.1);   // 5 sim seconds
  const traveled = leader.x - 500;
  assert.ok(traveled < UNITS.ranger.speed * 5 * 0.5,
    `the leader (${traveled.toFixed(0)} travelled) moves far slower than the follower's own top speed would allow`);
  // The formation's grid layout for 2 units puts the follower's slot 27.6 units off the leader's
  // own — see the "matches the flat GRID_SPACING formula" test above (spacing 27.6, cols 2).
  const gap = Math.hypot(follower.x - (leader.x + 27.6), follower.y - leader.y);
  assert.ok(gap < 10, `the fast follower stays tight on the slow leader (gap ${gap.toFixed(1)}), not racing ahead and idling`);
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

test("a follow-leader order (and squadLeader/squadFollowers) never survives save/load — no circular reference crash", () => {
  const s = createGameState({ planetId: "ferros", seed: 6 });
  const leader = makeUnit("skiff", "player", 500, 500);
  const follower = makeUnit("skiff", "player", 540, 500);
  s.units.set(leader.id, leader); s.units.set(follower.id, follower);
  issueHoldFormation([leader, follower]);

  let payload;
  assert.doesNotThrow(() => { payload = JSON.parse(JSON.stringify(serializeGame(s))); },
    "serializing a live squad (a circular leader<->follower reference) must not throw");

  const restored = deserializeGame(payload);
  const rLeader = [...restored.units.values()].find(u => u.id === leader.id);
  const rFollower = [...restored.units.values()].find(u => u.id === follower.id);
  assert.equal(rFollower.order, null, "the follow-leader order is dropped, not reconstructed");
  assert.equal(rLeader.squadFollowers, undefined);
  assert.equal(rFollower.squadLeader, undefined);
});
