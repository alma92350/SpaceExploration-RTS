import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit, removeEntity } from "../engine/state.js";
import { queueProduction, updateProductionQueue } from "../engine/production.js";
import { supplyUsed, supplyCap, buildingSupplyCap } from "../engine/supply.js";
import { runAI } from "../engine/ai.js";
import { tick } from "../engine/sim.js";
import { UNITS } from "../engine/entities.js";
import { mulberry32 } from "../engine/rng.js";

const THINK_INTERVAL = 1.5;   // must match ai.js's own THINK_INTERVAL to force a fresh think cycle each call

// A completed Barracks anyone can queue against, with money to burn so
// supply — not ore — is the only thing that can ever block a job.
function stockedBarracks(state, owner = "player") {
  const barracks = makeBuilding("barracks", owner, 500, 500);
  state.buildings.set(barracks.id, barracks);
  state.players[owner].resources.ore = 100000;
  return barracks;
}

test("supplyCap counts only completed buildings — a constructing Habitat grants nothing yet", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.equal(supplyCap(state, "player"), 10, "the seeded Command Center alone grants 10");

  const habitat = makeBuilding("habitat", "player", 700, 500, { constructing: true });
  state.buildings.set(habitat.id, habitat);
  assert.equal(supplyCap(state, "player"), 10, "a Habitat still going up doesn't raise the cap");

  habitat.constructing = false;
  assert.equal(supplyCap(state, "player"), 18, "once finished it adds its 8");
});

/* ---------- setup.js's Population cap row (200/250/300/Max — state.popCap) ---------- */

test("a configured population cap clamps supplyCap below the building-derived total", () => {
  const state = createGameState({ planetId: "ferros" });
  const habitat = makeBuilding("habitat", "player", 700, 500);
  state.buildings.set(habitat.id, habitat);
  assert.equal(supplyCap(state, "player"), 18, "CC (10) + Habitat (8), unclamped");

  state.popCap = 12;
  assert.equal(supplyCap(state, "player"), 12, "clamped down to the configured ceiling");
  assert.equal(buildingSupplyCap(state, "player"), 18,
    "the raw building-derived total is unaffected — still there for the AI's own headroom check");
});

test("a population cap ABOVE the building-derived total changes nothing", () => {
  const state = createGameState({ planetId: "ferros" });
  state.popCap = 500;
  assert.equal(supplyCap(state, "player"), 10, "still just the seeded CC's own 10 — a cap never RAISES anything");
});

test("no population cap set (Max, the default) behaves exactly as before this setting existed", () => {
  const state = createGameState({ planetId: "ferros" });
  assert.equal(state.popCap, null, "defaults to null — Max/uncapped");
  assert.equal(supplyCap(state, "player"), 10);
});

test("a population cap applies identically to both the player and the AI", () => {
  const state = createGameState({ planetId: "ferros" });
  const habitat = makeBuilding("habitat", "ai", 700, 500);
  state.buildings.set(habitat.id, habitat);
  state.popCap = 12;
  assert.equal(supplyCap(state, "player"), 10, "player's own building total (10) is already below the cap — unaffected");
  assert.equal(supplyCap(state, "ai"), 12, "AI's own total (18) gets clamped down exactly the same way");
});

test("production blocks against a configured population cap even with plenty of housing built", () => {
  const state = createGameState({ planetId: "ferros" });
  const habitat = makeBuilding("habitat", "player", 700, 500);
  state.buildings.set(habitat.id, habitat);   // uncapped cap would be 18 (CC 10 + Habitat 8)
  state.popCap = 12;
  const barracks = stockedBarracks(state);

  while (queueProduction(state, barracks.id, "skiff")) {}

  assert.equal(supplyUsed(state, "player"), 12, "stopped at the configured ceiling (3 seeded workers + 9 skiffs), not the building-derived 18");
  const blocked = state.events.find(e => e.type === "productionBlocked");
  assert.ok(blocked, "the same productionBlocked event fires for a popCap block as for a building-derived one");
  assert.equal(blocked.reason, "supply");
});

test("supplyUsed counts live units and every queued job", () => {
  const state = createGameState({ planetId: "ferros" });
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  assert.equal(supplyUsed(state, "player"), 3, "three seeded workers cost one supply each");

  assert.equal(queueProduction(state, cc.id, "worker"), true);
  assert.equal(supplyUsed(state, "player"), 4, "a job reserves its supply the moment it's queued, before it spawns");
});

test("queue-time reservation caps queue-stuffing, with nothing spawning", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = stockedBarracks(state);

  let queued = 0;
  while (queueProduction(state, barracks.id, "skiff")) queued++;

  assert.equal(queued, 7, "3 seeded workers + 7 Skiffs fills the CC's 10 cap exactly");
  assert.equal(supplyUsed(state, "player"), 10);
  assert.equal(barracks.queue.length, 7, "a supply-blocked queue stops growing");
});

test("a supply-blocked job is rejected before it's paid for", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = stockedBarracks(state);
  while (queueProduction(state, barracks.id, "skiff")) {}   // fill to the cap
  assert.equal(supplyUsed(state, "player"), 10);

  const oreBefore = state.players.player.resources.ore;
  const queueBefore = barracks.queue.length;
  const ok = queueProduction(state, barracks.id, "skiff");

  assert.equal(ok, false);
  assert.equal(state.players.player.resources.ore, oreBefore, "a supply-blocked job charges nothing");
  assert.equal(barracks.queue.length, queueBefore, "and enqueues nothing");
});

test("a blocked job pushes a productionBlocked event for the owner", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = stockedBarracks(state);
  while (queueProduction(state, barracks.id, "skiff")) {}
  state.events.length = 0;

  queueProduction(state, barracks.id, "skiff");

  const blocked = state.events.find(e => e.type === "productionBlocked");
  assert.ok(blocked, "the block should surface an event for the HUD/sound to pick up");
  assert.equal(blocked.reason, "supply");
  assert.equal(blocked.owner, "player");
});

test("losing a Habitat drops the cap, keeps every unit, and blocks new production", () => {
  const state = createGameState({ planetId: "ferros" });
  const habitat = makeBuilding("habitat", "player", 700, 500);
  state.buildings.set(habitat.id, habitat);
  const barracks = stockedBarracks(state);
  while (queueProduction(state, barracks.id, "skiff")) {}   // fill the 18 cap
  assert.equal(supplyUsed(state, "player"), 18);
  const unitsBefore = state.units.size;

  removeEntity(state, habitat.id);

  assert.equal(supplyCap(state, "player"), 10, "the cap falls back to the CC's 10");
  assert.ok(supplyUsed(state, "player") > supplyCap(state, "player"), "the player is legally over cap");
  assert.equal(state.units.size, unitsBefore, "nothing dies for being over cap");
  assert.equal(queueProduction(state, barracks.id, "skiff"), false, "production blocks until the cap is rebuilt");
});

test("an already-queued unit still spawns even while over cap", () => {
  const state = createGameState({ planetId: "ferros" });
  const habitat = makeBuilding("habitat", "player", 700, 500);
  state.buildings.set(habitat.id, habitat);
  const barracks = stockedBarracks(state);
  for (let i = 0; i < 12; i++) assert.equal(queueProduction(state, barracks.id, "skiff"), true);

  removeEntity(state, habitat.id);
  assert.ok(supplyUsed(state, "player") > supplyCap(state, "player"), "over cap after the Habitat dies");

  const idsBefore = new Set(state.units.keys());
  const dt = 0.5;
  for (let t = 0; t < UNITS.skiff.buildTime + 1; t += dt) {
    updateProductionQueue(state, barracks, dt);
  }

  const spawnedId = [...state.units.keys()].find(id => !idsBefore.has(id));
  assert.ok(spawnedId, "in-flight production pops out regardless of cap — it was reserved at queue time");
  assert.equal(state.units.get(spawnedId).type, "skiff");
});

test("destroying a building frees its whole queue's supply reservation", () => {
  const state = createGameState({ planetId: "ferros" });
  const barracks = stockedBarracks(state);
  const baseUsed = supplyUsed(state, "player");   // the 3 seeded workers

  assert.equal(queueProduction(state, barracks.id, "skiff"), true);
  assert.equal(queueProduction(state, barracks.id, "skiff"), true);
  assert.equal(supplyUsed(state, "player"), baseUsed + 2, "two queued Skiffs reserve two supply");

  removeEntity(state, barracks.id);
  assert.equal(supplyUsed(state, "player"), baseUsed, "a dead building's queued reservations vanish with it");
});

test("the AI puts up a Habitat as it nears the cap, and doesn't stack a second while one is going up", () => {
  const state = createGameState({ planetId: "ferros" });
  // Seed the AI army up to cap - 1 so the next think cycle is right at the
  // >= cap - 2 trigger, and give it the ore for a Habitat.
  for (let i = 0; i < 3; i++) {
    const b = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y);
    state.units.set(b.id, b);
  }
  state.players.ai.resources.ore = 1000;
  assert.ok(supplyUsed(state, "ai") >= supplyCap(state, "ai") - 2, "fixture should sit at the trigger");

  runAI(state, THINK_INTERVAL);

  let aiHabitats = [...state.buildings.values()].filter(b => b.owner === "ai" && b.type === "habitat");
  assert.equal(aiHabitats.length, 1, "the AI founds a Habitat when it nears the cap");
  assert.ok(aiHabitats[0].constructing);

  runAI(state, THINK_INTERVAL);
  aiHabitats = [...state.buildings.values()].filter(b => b.owner === "ai" && b.type === "habitat");
  assert.equal(aiHabitats.length, 1, "it doesn't stack a second while the first is still under construction");
});

test("the AI's production recovers past the CC-only 10 cap instead of wedging", () => {
  const state = createGameState({ planetId: "ferros" });
  const dt = 0.1;
  let ticks = 0;
  const maxTicks = 12000;
  // The AI can only push its supply usage past the Command Center's 10 by
  // finishing a Habitat, so climbing past it proves the supply loop
  // unstalls rather than jamming the mix cycle forever at 10.
  while (!state.over && ticks < maxTicks && supplyUsed(state, "ai") <= 11) {
    tick(state, dt);
    ticks++;
  }

  assert.ok(supplyUsed(state, "ai") > 11, "the AI grew its supply past the CC-only cap of 10");
  const aiHabitats = [...state.buildings.values()].filter(b => b.owner === "ai" && b.type === "habitat");
  assert.ok(aiHabitats.length >= 1, "which it could only do by building at least one Habitat");
});

/* ---------- the AI's supply headroom must cover the unit it's actually about to build ---------- */

// The Habitat trigger used to fire at a FLAT `used >= cap - 2` — a margin sized for a 2-supply
// unit, back when nothing the AI built cost more. The Odyssey roster added 4-supply (Dreadnought,
// Aegis, Colossus) and 8-supply (Leviathan) units, and pickNextUnitType retries the SAME mix entry
// until it succeeds (state.ai.unitsBuilt only advances on a successful queue). So a free-supply
// gap of 2 or 3 with a 4-supply unit next is a hard deadlock: production can't queue, and the
// Habitat that would unblock it is never triggered. Measured on a real 50-minute Odyssey world
// (tools/ailab.js): army frozen, both Barracks queues empty, banked ore climbing past 30,000.
// See docs/odyssey-ai-review.md §2.2.

// An Odyssey Economist (ferros) teched to the Dreadnought, with `free` supply headroom left and
// its mix cycle parked one step before the 4-supply Dreadnought entry.
function aiOnTheSupplyEdge(free) {
  const state = createGameState({ planetId: "ferros", endless: true, seed: 99, rng: mulberry32(99) });
  for (const [id, u] of [...state.units]) if (u.owner === "ai") state.units.delete(id);
  const cc = makeBuilding("command", "ai", 600, 500);           // +10 supply
  state.buildings.set(cc.id, cc);
  const hab = makeBuilding("habitat", "ai", 600, 590);          // +8  => cap 18
  state.buildings.set(hab.id, hab);
  for (const [t, x, y] of [["barracks", 690, 410], ["foundry", 510, 590], ["arsenal", 510, 470]]) {
    const b = makeBuilding(t, "ai", x, y); state.buildings.set(b.id, b);
  }
  // Workers past the Economist's Odyssey target (11), so the worker line can't quietly eat the
  // headroom and trigger the Habitat by a route that has nothing to do with the bug under test.
  for (let i = 0; i < 12; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); state.units.set(w.id, w); }
  // Pad the rest of the way to `cap - free` with combat units.
  let pad = supplyCap(state, "ai") - free - supplyUsed(state, "ai");
  while (pad >= 2) { const u = makeUnit("bastion", "ai", 700, 500); state.units.set(u.id, u); pad -= 2; }
  while (pad >= 1) { const u = makeUnit("skiff", "ai", 700, 520); state.units.set(u.id, u); pad -= 1; }
  state.ai.unitsBuilt = 7;   // economist unitMix index 7 === "dreadnought" (4 supply)
  state.players.ai.resources = { ore: 2000, crystals: 2000, radioactives: 2000 };   // under SURPLUS_EXPAND_ORE: a queued colony ship would itself reserve supply
  return state;
}

const aiHabitats = state => [...state.buildings.values()].filter(b => b.owner === "ai" && b.type === "habitat");

test("the AI raises a Habitat when its NEXT unit won't fit, not when a flat 2 supply is left", () => {
  const state = aiOnTheSupplyEdge(3);   // 3 free: the old `cap - 2` trigger stays silent, a 4-supply Dreadnought can't fit
  assert.equal(supplyCap(state, "ai") - supplyUsed(state, "ai"), 3, "fixture really does leave a 3-supply gap");
  assert.ok(supplyUsed(state, "ai") < supplyCap(state, "ai") - 2, "…which the old flat margin would NOT have caught");

  const before = aiHabitats(state).length;
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).length, before + 1,
    "the AI must raise a Habitat sized to the unit it's actually trying to build, or the mix cycle deadlocks forever");
});

test("the AI's production unwedges once that Habitat lands — the deadlock is genuinely broken", () => {
  const state = aiOnTheSupplyEdge(3);
  runAI(state, THINK_INTERVAL);
  for (const h of aiHabitats(state)) { h.constructing = false; h.buildProgress = 1; }   // let it finish
  const rax = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "barracks");
  rax.queue.length = 0;
  state.ai.think = 0;
  runAI(state, THINK_INTERVAL);
  assert.ok(rax.queue.some(j => j.unitType === "dreadnought"),
    "with the headroom in place the stalled mix entry finally queues");
});

test("a comfortable supply margin doesn't make the AI spam Habitats it doesn't need", () => {
  const state = aiOnTheSupplyEdge(9);   // plenty of room for the 4-supply Dreadnought
  const before = aiHabitats(state).length;
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).length, before, "no Habitat — the trigger is headroom-driven, not unconditional");
});

// A configured population cap (state.popCap) can sit at or below what the AI's own buildings
// already grant — raising another Habitat past that ceiling would only grow the RAW cap
// (buildingSupplyCap), which supplyCap's own clamp then caps right back down anyway. Without a
// guard aware of this, the same "blocked, not covered" trigger above would fire every think cycle
// forever, spending ore on Habitats that never actually raise the EFFECTIVE cap.
test("a population cap already reached by raw buildings stops the AI from raising more Habitats", () => {
  const state = aiOnTheSupplyEdge(3);   // the exact fixture the very first trigger test above uses
  assert.equal(buildingSupplyCap(state, "ai"), 18, "the fixture's raw cap is CC (10) + Habitat (8)");
  state.popCap = 18;   // exactly the raw cap already reached — no headroom left to gain
  const before = aiHabitats(state).length;
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).length, before,
    "another Habitat would only raise the raw cap past a ceiling already reached — pointless, so it doesn't try");
});

test("a population cap still well above the raw building total doesn't suppress the normal Habitat trigger", () => {
  const state = aiOnTheSupplyEdge(3);
  state.popCap = 40;   // well above the fixture's raw cap (18) — plenty of headroom before the ceiling bites
  const before = aiHabitats(state).length;
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).length, before + 1, "a distant configured ceiling doesn't block the ordinary deadlock-prevention trigger");
});

// Two follow-ons from running the fixed AI out to 45 sim-minutes on a built-out world: with the
// margin right, the Habitat loop then failed for two OTHER reasons, both of which re-froze
// production exactly the same way (docs/odyssey-ai-review.md §2.2).

test("a Habitat lands at another Command Center when there's no room left at the first", () => {
  // A late Odyssey base packs 70+ buildings around its capital; measured, every placement within
  // the search radius of the home CC was taken and the AI simply stopped raising Habitats — a
  // permanent supply freeze. It must fall through to its expansions. CC1 is parked off-map here so
  // that EVERY candidate spot around it is invalid, which is the same dead end saturation produces
  // and is deterministic to construct.
  const state = aiOnTheSupplyEdge(0);
  const home = [...state.buildings.values()].find(b => b.owner === "ai" && b.type === "command");
  home.x = -4000; home.y = -4000;
  const expansion = makeBuilding("command", "ai", 1000, 700);
  state.buildings.set(expansion.id, expansion);
  for (let i = 0; i < 5; i++) {   // soak up the +10 supply the expansion itself grants, back to the cap
    const u = makeUnit("bastion", "ai", 1010, 700); state.units.set(u.id, u);
  }
  assert.equal(supplyUsed(state, "ai"), supplyCap(state, "ai"), "fixture is back at the cap with two CCs");
  runAI(state, THINK_INTERVAL);
  const raised = aiHabitats(state).filter(b => b.constructing);
  assert.equal(raised.length, 1, "it still raised one");
  assert.ok(Math.hypot(raised[0].x - expansion.x, raised[0].y - expansion.y) < 500,
    "…at the expansion, because the capital had no room");
});

test("supply already on the way counts — one Habitat per cycle, but not one per world", () => {
  // The old guard was a flat `no second while one is going up`, which throttled the AI to +8 supply
  // per 10-second build while a surplus-scaled production line consumed more than that. The rule is
  // now arithmetic: a Habitat under construction is credited at its supplyGrants, so a second only
  // goes up when the AI is short even after counting it.
  const state = aiOnTheSupplyEdge(0);      // right at the cap
  state.players.ai.resources.ore = 600;    // lean: under SUPPLY_RUSH_ORE, so ore is the scarce thing, not supply
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).filter(b => b.constructing).length, 1, "one goes up");
  state.ai.think = 0;
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).filter(b => b.constructing).length, 1,
    "…and a second doesn't, because the 8 supply already on the way covers the shortfall");

  // Now put it genuinely far over the cap — more than the pending Habitat can absorb.
  for (let i = 0; i < 8; i++) { const u = makeUnit("bastion", "ai", 700, 500); state.units.set(u.id, u); }
  state.players.ai.resources.ore = 700;   // topped up, still under SUPPLY_RUSH_ORE
  state.ai.think = 0;
  runAI(state, THINK_INTERVAL);
  assert.equal(aiHabitats(state).filter(b => b.constructing).length, 2,
    "a shortfall bigger than what's in flight does open a second");
});

test("when SUPPLY is the bottleneck and ore is piling up, the AI raises Habitats in parallel", () => {
  // One Habitat at a time is 8 supply per 10 seconds. Production blocked at the cap can never run
  // far enough OVER it to trip the shortfall test above, so a low-Barracks archetype was throttled
  // to that rate for the whole game while its income piled up: measured, 40 sim-minutes to reach
  // 37 units with 3,900 ore banked and its Barracks idle two samples in three. Ore it has nothing
  // else to spend on should buy supply headroom instead.
  const state = aiOnTheSupplyEdge(0);
  state.players.ai.resources.ore = 6000;   // rich, and blocked
  for (let i = 0; i < 3; i++) { state.ai.think = 0; runAI(state, THINK_INTERVAL); }
  const pending = aiHabitats(state).filter(b => b.constructing).length;
  assert.ok(pending > 1, `a rich, supply-blocked AI parallelises its Habitats (got ${pending})`);
});

test("…but never without limit — parallel Habitats are capped", () => {
  const state = aiOnTheSupplyEdge(0);
  state.players.ai.resources.ore = 1e6;
  for (let i = 0; i < 30; i++) { state.ai.think = 0; runAI(state, THINK_INTERVAL); }
  assert.ok(aiHabitats(state).filter(b => b.constructing).length <= 3,
    "an unbounded bank must not turn the base into a Habitat farm");
});
