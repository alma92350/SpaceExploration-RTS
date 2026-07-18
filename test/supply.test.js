import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit, removeEntity } from "../engine/state.js";
import { queueProduction, updateProductionQueue } from "../engine/production.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { runAI } from "../engine/ai.js";
import { tick } from "../engine/sim.js";
import { UNITS } from "../engine/entities.js";

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
