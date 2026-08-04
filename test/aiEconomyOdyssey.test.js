/* ============================================================
   Odyssey AI economy — the colony-ship state machine (engine/aiEconomy.js:
   aiFoundOrSurvive, plus aiExpand's `if (state.endless)` branch), driven
   through the real runAI(state, dt) entry point exactly like the rest of
   the AI suite.

   Every existing AI test fixture pre-plants a Command Center before the
   first runAI call, so this whole machine has zero coverage anywhere else:
     1. aiFoundOrSurvive: no CC but a colony ship in hand -> deploy in place.
        Covers BOTH the Odyssey opening move and re-founding after the AI's
        base is razed down to a lone surviving ship.
     2. aiExpand's LAUNCH step: a second ship in hand, home ore thinning,
        a discovered cluster to go to -> commit state.ai.colonyTarget and
        move the ship.
     3. aiExpand's HOME-IN -> DEPLOY step: a ship within COLONY_ARRIVE of its
        committed target -> deploy and clear the target.
     4. aiExpand's deadlock guard: bestExpansionCluster finds nowhere known
        to expand to -> the AI must never bank ore for, or queue, a colony
        ship it can never place.
   Each test below drives one of those four legs through runAI and nothing
   else, matching the fixture idiom in test/aiIndustry.test.js and
   test/ai-odyssey.test.js.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { mulberry32 } from "../engine/rng.js";

const THINK = 1.5;   // engine/ai.js THINK_INTERVAL — a fresh state's think timer starts at 0, so
                      // passing THINK (or anything >= 0) as dt on the first call fires immediately.

// A SEEDED Odyssey state, same idiom as aiIndustry.test.js — createGameState falls back to
// Math.random for map generation when no rng is passed, so pin one or the generated node layout
// (and therefore bestExpansionCluster's pick) varies run to run.
const seeded = (seed = 4242) => createGameState({ planetId: "ferros", endless: true, seed, rng: mulberry32(seed) });

// Every scenario below wants a specific, hand-placed ship/CC arrangement rather than the byte-for-
// byte Odyssey opening (a lone colony ship at the world's base spot) createGameState seeds — so
// strip whatever it gave the AI first.
function clearAiUnits(s) {
  for (const [id, u] of [...s.units]) if (u.owner === "ai") s.units.delete(id);
}

const aiCCs = s => [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === "command");
const aiShip = s => [...s.units.values()].find(u => u.owner === "ai" && u.type === "colonyship");

// ---- 1. aiFoundOrSurvive: redeploy after being razed to a lone ship -----------------------

test("an AI reduced to one surviving colony ship re-founds its base instead of permanently dropping out of the game", () => {
  const s = seeded();
  clearAiUnits(s);
  // No Command Center anywhere for the AI, one lone colony ship parked on open, buildable
  // ground far from either side's home ore — standing in for "the base was razed and this ship
  // is all that's left." aiFoundOrSurvive can't tell this apart from the Odyssey opening move
  // (ctx.cc falsy, ctx.colonyShip truthy is the whole test) — which is exactly the point: the
  // same deploy-in-place logic has to cover both, or an AI that loses its base but keeps a ship
  // is stuck forever (a base-less AI even mis-reads as "pacified" elsewhere — engine/galaxy.js).
  const ship = makeUnit("colonyship", "ai", 800, 650);
  s.units.set(ship.id, ship);
  s.ai.colonyTarget = { x: 999, y: 999 };   // a stale expansion intent left over from before the base fell
  assert.equal(aiCCs(s).length, 0, "sanity: no Command Center stands yet");

  runAI(s, THINK);

  const ccs = aiCCs(s);
  assert.equal(ccs.length, 1, "the lone ship re-founded exactly one Command Center");
  assert.equal(ccs[0].x, 800);
  assert.equal(ccs[0].y, 650);
  assert.ok(!ccs[0].constructing, "deploy mints a COMPLETED CC at once — no foothold gap for the loss check to catch");
  assert.ok(!aiShip(s), "the ship is consumed by the deploy");
  const aiWorkers = [...s.units.values()].filter(u => u.owner === "ai" && u.type === "worker");
  assert.equal(aiWorkers.length, 3, "the colonists disembarked as workers — a real founded base, not a half-effect");
  assert.equal(s.ai.colonyTarget, null, "re-seating cancels any stale expansion intent left over from before the base fell");
});

// ---- 2. aiExpand LAUNCH: a ship in hand commits to a discovered cluster -------------------

test("the AI launches its colony ship at a discovered, unclaimed ore cluster once it has one in hand", () => {
  const s = seeded();
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 800, 650); s.buildings.set(cc.id, cc);
  for (let i = 0; i < 3; i++) { const w = makeUnit("worker", "ai", 810 + i * 12, 690); s.units.set(w.id, w); }
  const ship = makeUnit("colonyship", "ai", 820, 650);   // an EXPANSION ship, already built, no target yet
  s.units.set(ship.id, ship);
  s.players.ai.resources.ore = 5000;

  // Flatten every node the map generated so there's exactly one live, unclaimed ore cluster to
  // find, then plant it — a non-hidden node is "discovered" by construction (fog.js
  // isNodeDiscovered: !node.hidden always reads true), and it sits ~750 away from the AI's CC,
  // well outside CLAIM_RADIUS (260, aiEconomy.js), so nothing disqualifies it as already claimed.
  for (const n of s.map.nodes) if (n.com === "ore") n.amount = 0;
  const cluster = { id: "testcluster", com: "ore", amount: 600, max: 600, x: 200, y: 200 };
  s.map.nodes.push(cluster);
  s.map.nodesById.set(cluster.id, cluster);
  assert.ok(Math.hypot(cc.x - cluster.x, cc.y - cluster.y) > 260, "sanity: the cluster is outside CLAIM_RADIUS");

  assert.equal(s.ai.colonyTarget, null, "sanity: no target committed yet");
  runAI(s, THINK);

  assert.ok(s.ai.colonyTarget, "the AI committed an expansion target (state.ai.colonyTarget)");
  assert.equal(typeof s.ai.colonyTarget.x, "number");
  assert.equal(typeof s.ai.colonyTarget.y, "number");
  const distToCluster = Math.hypot(s.ai.colonyTarget.x - cluster.x, s.ai.colonyTarget.y - cluster.y);
  assert.ok(distToCluster > 20 && distToCluster < 150,
    `the committed target sits just off the cluster it's homing on, not somewhere arbitrary (${distToCluster.toFixed(1)} away)`);
  assert.deepEqual(ship.order, { type: "move", x: s.ai.colonyTarget.x, y: s.ai.colonyTarget.y },
    "the colony ship was ordered to move toward the committed target");
});

// ---- 3. aiExpand HOME-IN -> DEPLOY: arrival founds the base and clears the target ---------

test("a colony ship that has homed in within COLONY_ARRIVE of its target deploys and clears state.ai.colonyTarget", () => {
  const s = seeded();
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 800, 650); s.buildings.set(cc.id, cc);
  for (let i = 0; i < 3; i++) { const w = makeUnit("worker", "ai", 810 + i * 12, 690); s.units.set(w.id, w); }
  const target = { x: 300, y: 300 };
  s.ai.colonyTarget = target;
  // Parked exactly on the committed target — trivially inside COLONY_ARRIVE (40, aiEconomy.js);
  // any distance up to that would trigger the same deploy, this is just the simplest deterministic
  // "arrived" case, on clear ground far from the home CC.
  const ship = makeUnit("colonyship", "ai", target.x, target.y);
  s.units.set(ship.id, ship);

  runAI(s, THINK);

  const ccs = aiCCs(s);
  assert.equal(ccs.length, 2, "the original base plus a newly deployed expansion");
  const newCc = ccs.find(c => c.x === target.x && c.y === target.y);
  assert.ok(newCc, "a Command Center now stands exactly at the committed colony target");
  assert.ok(!newCc.constructing, "deploy mints a COMPLETED CC at once, same as any other deploy");
  assert.ok(!aiShip(s), "the ship is consumed by the deploy");
  assert.equal(s.ai.colonyTarget, null,
    "the target is cleared once the ship deploys — the LAUNCH/HOME-IN machine is free to pick a fresh one next time");
});

// ---- 4. aiExpand deadlock guard: nowhere discovered to expand to --------------------------

test("expansion deadlock guard: with nothing discovered to expand to, the AI never queues a colony ship and never freezes ore behind an impossible reserve", () => {
  const s = seeded();   // ferros -> Economist archetype: expandWhenNodesBelow 0.4, maxBarracks 2
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 800, 650); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 864, 650); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const w = makeUnit("worker", "ai", 810 + i * 12, 690); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 5000;   // plenty to afford a colony ship if the guard ever slipped
  // No live ore anywhere on the map -> bestExpansionCluster (aiEconomy.js, private) returns null
  // unconditionally, regardless of fog. Home ore reads as fully depleted too (homeOreFraction),
  // so the AI genuinely "wants" to expand — this is exactly the "wants to expand but has
  // discovered nowhere to go" deadlock the guard exists to break, not a case where it merely
  // isn't trying.
  for (const n of s.map.nodes) if (n.com === "ore") n.amount = 0;

  for (let i = 0; i < 6; i++) {
    runAI(s, THINK);
    assert.ok(!aiShip(s), `cycle ${i}: no colony ship ever gets produced out of an expansion that can never happen`);
    assert.ok(!cc.queue.some(j => j.unitType === "colonyship"), `cycle ${i}: …and none ever sits queued at the CC either`);
  }

  // "Never gets stuck" means more than "no ship" — it means ctx.oreReserve (the banked colony-ship
  // cost that pauses lower-priority infrastructure spend while the AI saves, aiEconomy.js) never
  // gets set and left standing in the way of ordinary spending. Prove it indirectly: a second
  // Barracks — which this Economist archetype wants (maxBarracks: 2) and which is gated behind
  // that exact same ctx.oreReserve in aiProduceAndFortify — still goes up normally instead of
  // being starved by a reserve for an expansion that can never happen.
  const barracksCount = [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === "barracks").length;
  assert.ok(barracksCount >= 2,
    "ordinary infrastructure spend (a 2nd Barracks) still proceeds — the expansion reserve never walled off ore for a purchase that can never complete");
});

/* ---------- 5. the SURPLUS SINK: a play-forever AI must never run out of things to buy ---------- */

// The AI's build order used to TERMINATE: a finite factory chain, a finite research order, one
// Star Dock, one Plasma Rig — and a hard maxBarracks of 1 or 2. Once it had climbed all of that,
// nothing in the script could absorb another unit of income, so a developed neighbour sat on a
// rising pile of ore with a frozen army (measured: 30,000+ banked, army flat for 20 sim-minutes —
// docs/odyssey-ai-review.md §2.3). In a mode with no end, an AI needs a terminal LOOP, not a
// terminal list: sustained surplus now opens extra Barracks, which converts the pile back into
// army. Odyssey only — a 40-minute skirmish never banks this much, and its barracks counts are
// part of the archetype contract the skirmish suite pins.

// A settled Odyssey Economist (maxBarracks 2) with its first two Barracks already standing.
function richEconomist(ore) {
  const s = seeded();
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  for (const [t, x, y] of [["barracks", 690, 410], ["barracks", 690, 590], ["habitat", 530, 590],
                           ["habitat", 530, 410], ["habitat", 470, 500], ["refinery", 510, 470],
                           ["foundry", 470, 590]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  for (let i = 0; i < 14; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources = { ore, crystals: 0, radioactives: 0 };
  return s;
}
const aiBarracks = s => [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === "barracks");

test("a hoarding Odyssey AI opens extra Barracks — the surplus turns back into army instead of piling up", () => {
  const s = richEconomist(12000);
  assert.equal(aiBarracks(s).length, 2, "starts at the Economist's archetype cap");
  for (let i = 0; i < 8; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.ok(aiBarracks(s).length > 2,
    `a 12,000-ore bank must buy more production, not sit there (got ${aiBarracks(s).length} Barracks)`);
});

test("the extra Barracks are BOUNDED — a rich AI scales up, it doesn't sprawl without limit", () => {
  const s = richEconomist(1e6);
  for (let i = 0; i < 40; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.ok(aiBarracks(s).length <= 6,
    `the escalation is capped, not proportional to an unbounded bank (got ${aiBarracks(s).length})`);
});

test("an Odyssey AI that ISN'T rich still respects its archetype's Barracks cap", () => {
  const s = richEconomist(600);   // comfortable, but nowhere near a surplus
  for (let i = 0; i < 8; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.equal(aiBarracks(s).length, 2, "no escalation without a real surplus — the archetype contract still holds");
});

test("a SKIRMISH AI never escalates past its archetype cap, however much ore it is handed", () => {
  const s = createGameState({ planetId: "ferros", endless: false, seed: 4242, rng: mulberry32(4242) });
  for (const [id, u] of [...s.units]) if (u.owner === "ai") s.units.delete(id);
  for (const [id, b] of [...s.buildings]) if (b.owner === "ai") s.buildings.delete(id);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  for (const [t, x, y] of [["barracks", 690, 410], ["barracks", 690, 590], ["habitat", 530, 590],
                           ["habitat", 530, 410], ["habitat", 470, 500]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  for (let i = 0; i < 14; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources = { ore: 12000, crystals: 0, radioactives: 0 };
  for (let i = 0; i < 8; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.equal(aiBarracks(s).length, 2, "the skirmish keeps exactly the archetype's maxBarracks — this is an Odyssey rule");
});

// The Barracks escalation above is no help to a strategy that CAPS its standing army — Economic
// and Force Parity keep 3–8 units by design, so extra production capacity sits idle and the ore
// still piles up (the four biggest banks in the roster soak were all theirs: 36,207 · 30,785 ·
// 30,679 · 28,678). Their in-character sink is the other direction: a neighbour with money it
// can't spend GROWS — it settles another cluster rather than waiting for its home seam to thin.
// Bounded for free by bestExpansionCluster, which returns null once the map is claimed.

test("an Odyssey AI sitting on a surplus expands even though its home ore is untouched", () => {
  const s = seeded();
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const hab = makeBuilding("habitat", "ai", 600, 590); s.buildings.set(hab.id, hab);   // room for the ship's 3 supply
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources = { ore: 6000, crystals: 0, radioactives: 0 };   // rich, and the world is barely mined
  for (let i = 0; i < 4; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.ok(cc.queue.some(j => j.unitType === "colonyship"),
    "money it has no other use for buys growth — not a rising pile of ore");
});

test("a modest bank does NOT trigger a surplus expansion — depletion is still the normal trigger", () => {
  const s = seeded();
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const hab = makeBuilding("habitat", "ai", 600, 590); s.buildings.set(hab.id, hab);
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources = { ore: 900, crystals: 0, radioactives: 0 };
  for (let i = 0; i < 4; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.ok(!cc.queue.some(j => j.unitType === "colonyship"),
    "a comfortable bank is not a surplus — the AI doesn't expand for the sake of it");
});

test("a SKIRMISH AI never surplus-expands — it has no colony ships and its expansion rule is unchanged", () => {
  const s = createGameState({ planetId: "ferros", endless: false, seed: 4242, rng: mulberry32(4242) });
  for (const [id, u] of [...s.units]) if (u.owner === "ai") s.units.delete(id);
  for (const [id, b] of [...s.buildings]) if (b.owner === "ai") s.buildings.delete(id);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources = { ore: 6000, crystals: 0, radioactives: 0 };
  for (let i = 0; i < 4; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.ok(!cc.queue.some(j => j.unitType === "colonyship"), "no colony ship in a skirmish");
  const ccs = [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === "command");
  assert.equal(ccs.length, 1, "…and no second Command Center: the skirmish still expands only on depletion");
});

/* ---- C14: the ore-surplus army-cap lift (commit ac44339) had NO test at all -------------------
   Proved by mutation: replacing armySurplusBonus's body with `return 0` — deleting the whole
   feature — left the entire suite green. The commit itself records "manually probed before/after on
   five world/strategy combinations" in place of tests. It was invisible because every
   standingArmyCap test runs in SKIRMISH, and armySurplusBonus short-circuits to 0 outside Odyssey.
   The skirmish case below is the important half: it pins the gate, not just the arithmetic. */

function cappedEconomist(ore, { endless = true } = {}) {
  const s = createGameState({ planetId: "ferros", endless, seed: 4242, rng: mulberry32(4242) });
  clearAiUnits(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 690, 410); s.buildings.set(bar.id, bar);
  for (const [t, x, y] of [["habitat", 530, 590], ["habitat", 530, 410], ["habitat", 470, 500]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  for (let i = 0; i < 8; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.ai.strategy = "economic";
  for (let i = 0; i < 3; i++) {                       // exactly the Economic cap of standing army
    const u = makeUnit("skiff", "ai", 600 + i * 14, 540); s.units.set(u.id, u);
  }
  s.players.ai.resources = { ore, crystals: 0, radioactives: 0 };
  return { s, bar };
}
const queued = bar => (bar.queue || []).length;

test("an Odyssey AI sitting on a surplus lifts its standing-army cap instead of banking forever (C14)", () => {
  const { s, bar } = cappedEconomist(8000);
  for (let i = 0; i < 6; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.ok(queued(bar) > 0,
    "at the Economic cap with an 8,000-ore bank, the surplus must buy army rather than pile up");
});

test("an Odyssey AI without a surplus still respects its standing-army cap (C14)", () => {
  const { s, bar } = cappedEconomist(600);
  for (let i = 0; i < 6; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.equal(queued(bar), 0, "comfortable but not rich: the cap still holds");
});

test("the surplus lift is ODYSSEY-ONLY — a skirmish AI at its cap never gets it (C14)", () => {
  // This is the case that makes the pair meaningful. It is also why the feature was invisible:
  // every pre-existing standingArmyCap test builds a skirmish state, where the bonus is always 0.
  const { s, bar } = cappedEconomist(8000, { endless: false });
  for (let i = 0; i < 6; i++) { s.ai.think = 0; runAI(s, THINK); }
  assert.equal(queued(bar), 0, "a skirmish must be byte-identical to before the feature shipped");
});
