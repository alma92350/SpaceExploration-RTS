/* ============================================================
   Colony standing orders (P6 colony-economy rework, half 2 of 2): a small per-colony
   policy store on the galaxy — auto-sell surplus above a floor into the world's own
   REAL market, and sustain a target worker headcount (queue one at the CC, re-task
   idle ones to gather) — executed only for BACKGROUND worlds, on the same throttled
   schedule sweepColonies' sibling galaxy-wide scans already use (stepGalaxy's
   PROGRESS_CHECK_EVERY block). Mirrors sweepColonies' own test patterns
   (test/odyssey-meta.test.js, test/economy.test.js).
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, stepGalaxy, sweepColonies } from "../engine/galaxy.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { setColonyPolicy, getColonyPolicy, runColonyPolicies, sanitizePolicy, MAX_WORKER_TARGET } from "../engine/colonyPolicy.js";

// A held background colony: an unsettled world given a fresh Command Center, matching
// odyssey-meta.test.js's own backgroundColony fixture.
function backgroundColony(g, id) {
  const colony = addPlanet(g, id, { unsettled: true });
  colony.background = true;
  const cc = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  colony.buildings.set(cc.id, cc);
  colony.events.length = 0;
  return colony;
}

/* ---------- sanitizePolicy / setColonyPolicy / getColonyPolicy ---------- */

test("sanitizePolicy defaults to a fully-off policy for garbage or missing input", () => {
  assert.deepEqual(sanitizePolicy(null), { autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
  assert.deepEqual(sanitizePolicy(undefined), { autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
  assert.deepEqual(sanitizePolicy("garbage"), { autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
});

test("sanitizePolicy drops an unknown commodity and a negative/NaN floor, clamps workerTarget", () => {
  const p = sanitizePolicy({ autoSell: { enabled: true, floors: { ore: 50, notacommodity: 10, metals: -5, alloys: NaN } }, workerTarget: -3 });
  assert.deepEqual(p.autoSell.floors, { ore: 50 });
  assert.equal(p.workerTarget, 0);
  const p2 = sanitizePolicy({ workerTarget: 99999 });
  assert.ok(p2.workerTarget <= MAX_WORKER_TARGET, "workerTarget is capped, not left unbounded");
});

test("setColonyPolicy stores a per-planet policy and MERGES floors rather than replacing the set", () => {
  const g = createGalaxy({ seed: 1 });
  const id = g.worlds.find(w => w !== g.activeId);
  setColonyPolicy(g, id, { autoSell: { enabled: true, floors: { ore: 200 } } });
  setColonyPolicy(g, id, { autoSell: { floors: { metals: 50 } } });
  const p = getColonyPolicy(g, id);
  assert.equal(p.autoSell.enabled, true, "enabled flag persists across a later patch that doesn't mention it");
  assert.deepEqual(p.autoSell.floors, { ore: 200, metals: 50 }, "floors merge, they don't clobber");
});

test("getColonyPolicy returns the off-default for a world with no policy set yet", () => {
  const g = createGalaxy({ seed: 2 });
  const id = g.worlds.find(w => w !== g.activeId);
  assert.deepEqual(getColonyPolicy(g, id), { autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
});

/* ---------- auto-sell surplus, via the real market ---------- */

test("runColonyPolicies auto-sells stock above the floor via the real market, banking galaxy credits", () => {
  const g = createGalaxy({ seed: 20 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  colony.players.player.resources.metals = 500;
  setColonyPolicy(g, id, { autoSell: { enabled: true, floors: { metals: 100 } } });
  const creditsBefore = g.credits;

  runColonyPolicies(g);

  assert.equal(colony.players.player.resources.metals, 100, "sold everything above the floor, down to it exactly");
  assert.ok(g.credits > creditsBefore, "the sale banked real galaxy credits");
});

test("runColonyPolicies leaves stock at or under its floor untouched", () => {
  const g = createGalaxy({ seed: 21 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  colony.players.player.resources.metals = 50;
  setColonyPolicy(g, id, { autoSell: { enabled: true, floors: { metals: 100 } } });

  runColonyPolicies(g);

  assert.equal(colony.players.player.resources.metals, 50, "under the floor — nothing sold");
});

test("runColonyPolicies never sells while auto-sell is disabled, even with floors configured", () => {
  const g = createGalaxy({ seed: 22 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  colony.players.player.resources.metals = 500;
  setColonyPolicy(g, id, { autoSell: { enabled: false, floors: { metals: 100 } } });

  runColonyPolicies(g);

  assert.equal(colony.players.player.resources.metals, 500, "disabled ⇒ no-op regardless of floors");
});

test("runColonyPolicies only ever acts on BACKGROUND worlds, never the active seat", () => {
  const g = createGalaxy({ seed: 23 });
  const active = activeState(g);
  active.players.player.resources.metals = 500;
  setColonyPolicy(g, g.activeId, { autoSell: { enabled: true, floors: { metals: 100 } } });

  runColonyPolicies(g);

  assert.equal(active.players.player.resources.metals, 500, "the active seat takes real player orders, not standing policies");
});

test("colony auto-sell income is ADDITIVE on top of the existing flat per-building income, not a replacement for it", () => {
  const g = createGalaxy({ seed: 24 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  colony.players.player.resources.metals = 500;
  setColonyPolicy(g, id, { autoSell: { enabled: true, floors: { metals: 100 } } });
  const creditsBefore = g.credits;

  sweepColonies(g, 1);   // the flat COLONY_INCOME_PER_BUILDING floor
  const afterFlat = g.credits;
  assert.ok(afterFlat > creditsBefore, "sanity: the flat income banked something");

  runColonyPolicies(g);
  assert.ok(g.credits > afterFlat, "auto-sell adds MORE credits on top of the flat income, it doesn't replace it");
});

/* ---------- sustain workers: re-queue at the CC + re-task idle ones to gather ---------- */

test("runColonyPolicies queues a worker at the Command Center when under the sustain target, paid from the colony's own stockpile", () => {
  const g = createGalaxy({ seed: 30 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  const cc = [...colony.buildings.values()][0];
  colony.players.player.resources.ore = 1000;
  setColonyPolicy(g, id, { workerTarget: 3 });   // 0 workers on an unsettled colony < 3

  runColonyPolicies(g);

  assert.equal(cc.queue.length, 1, "one worker queued at the CC");
  assert.equal(cc.queue[0].unitType, "worker");
  assert.ok(colony.players.player.resources.ore < 1000, "paid from the colony's OWN stockpile, not galaxy credits");
});

test("worker sustain never floods the queue — it tops up once, then waits for that job to clear", () => {
  const g = createGalaxy({ seed: 31 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  const cc = [...colony.buildings.values()][0];
  colony.players.player.resources.ore = 1000;
  setColonyPolicy(g, id, { workerTarget: 5 });

  runColonyPolicies(g);
  runColonyPolicies(g);
  runColonyPolicies(g);

  assert.equal(cc.queue.length, 1, "still just the one job — repeated throttled ticks don't stack more behind it");
});

test("worker sustain does nothing once the colony already meets or exceeds its target", () => {
  const g = createGalaxy({ seed: 32 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  const cc = [...colony.buildings.values()][0];
  const base = colony.map.bases.player;
  for (let i = 0; i < 3; i++) { const w = makeUnit("worker", "player", base.x, base.y); colony.units.set(w.id, w); }
  colony.players.player.resources.ore = 1000;
  setColonyPolicy(g, id, { workerTarget: 3 });

  runColonyPolicies(g);

  assert.equal(cc.queue.length, 0, "already at target — nothing queued");
});

test("runColonyPolicies re-tasks an idle player worker on a background colony to gather", () => {
  const g = createGalaxy({ seed: 33 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  const base = colony.map.bases.player;
  const node = { id: "test-colony-ore", com: "ore", amount: 500, max: 500, x: base.x + 80, y: base.y };
  colony.map.nodes.push(node);
  colony.map.nodesById.set(node.id, node);
  const w = makeUnit("worker", "player", base.x, base.y);
  colony.units.set(w.id, w);
  setColonyPolicy(g, id, { workerTarget: 1 });

  runColonyPolicies(g);

  assert.equal(w.order?.type, "gather", "the idle worker on this held colony is put back to work");
});

test("sustain-workers policy is a no-op when workerTarget is 0 (the default, off)", () => {
  const g = createGalaxy({ seed: 34 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  const cc = [...colony.buildings.values()][0];
  const base = colony.map.bases.player;
  const w = makeUnit("worker", "player", base.x, base.y);
  colony.units.set(w.id, w);
  colony.players.player.resources.ore = 1000;
  // No policy set at all — getColonyPolicy defaults workerTarget to 0.

  runColonyPolicies(g);

  assert.equal(cc.queue.length, 0, "no policy ⇒ no auto-queueing");
  assert.equal(w.order, null, "…and no re-tasking either");
});

/* ---------- wired into stepGalaxy's throttled background scan ---------- */

test("stepGalaxy runs colony policies on the same throttled schedule as the other galaxy-wide scans", () => {
  const g = createGalaxy({ seed: 40 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  colony.players.player.resources.metals = 500;
  setColonyPolicy(g, id, { autoSell: { enabled: true, floors: { metals: 100 } } });

  stepGalaxy(g, 0.05);   // tick 1 — the throttled block also runs on tick 1 (see PROGRESS_CHECK_EVERY)

  assert.ok(colony.players.player.resources.metals < 500, "auto-sell already fired on the very first galaxy tick");
});

/* ---------- persistence: additive save field, round-trips ---------- */

test("colony policies round-trip through save/load", () => {
  const g = createGalaxy({ seed: 50 });
  const id = g.worlds.find(w => w !== g.activeId);
  addPlanet(g, id, { unsettled: true });
  setColonyPolicy(g, id, { autoSell: { enabled: true, floors: { ore: 40 } }, workerTarget: 5 });

  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));

  assert.deepEqual(getColonyPolicy(g2, id), { autoSell: { enabled: true, floors: { ore: 40 } }, workerTarget: 5 });
});

test("a save with no colony policies at all loads with every world defaulting off (old-save compatibility)", () => {
  const g = createGalaxy({ seed: 51 });
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  delete save.colonyPolicies;   // simulate a pre-this-feature save
  const g2 = deserializeGalaxy(save);
  assert.deepEqual(getColonyPolicy(g2, g2.activeId), { autoSell: { enabled: false, floors: {} }, workerTarget: 0 });
});
