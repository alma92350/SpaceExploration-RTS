import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateProduction } from "../engine/industry.js";
import { updatePlasmaRig } from "../engine/rig.js";

// Give an Odyssey AI a real, deployed base (Odyssey seeds only a colony ship) so the AI-brain
// phases have something to build from: a CC, a Barracks, workers, and ore to spend.
function aiBase(planetId = "ferros") {
  const s = createGameState({ planetId, endless: true });
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 3000;   // plenty, so industry isn't starved behind the army
  return s;
}

// Phase 1 — abstracted AI logistics: an AI factory/rig runs straight off the treasury (no worker
// haulage), while the player's buffer+haulage path and the skirmish replay stay untouched.

test("an AI Smelter refines treasury ore into metals with no workers — abstracted logistics", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const r = makeBuilding("reactor", "ai", 500, 500); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "ai", 520, 500); s.buildings.set(sm.id, sm);
  s.players.ai.resources.ore = 100;
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.ok((s.players.ai.resources.metals || 0) > 0, "the AI smelter banked metals into the treasury");
  assert.ok(s.players.ai.resources.ore < 100, "…drawing ore straight from the treasury");
  const store = sm.store || {};
  assert.equal(Object.values(store).reduce((a, b) => a + b, 0), 0, "…with nothing piled in a finite output buffer");
});

test("an AI factory with no Reactor produces nothing — the power throttle still bites", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const sm = makeBuilding("smelter", "ai", 520, 500); s.buildings.set(sm.id, sm);
  s.players.ai.resources.ore = 100;
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.equal(s.players.ai.resources.metals || 0, 0, "no Reactor → no power → no production");
  assert.equal(s.players.ai.resources.ore, 100, "…and no ore consumed");
});

test("a PLAYER factory still runs off its buffers, not the treasury (haulage path unchanged)", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const r = makeBuilding("reactor", "player", 500, 500); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "player", 520, 500); s.buildings.set(sm.id, sm);
  s.players.player.resources.ore = 100;   // in the treasury, but NOT in the factory's input larder
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.equal(s.players.player.resources.metals || 0, 0, "a player factory ignores the treasury — inputs must be hauled in");
  assert.equal(s.players.player.resources.ore, 100, "…so the treasury ore is untouched");
  // Fill its input larder and it produces into its output STORE buffer, still not the treasury.
  sm.input = { ore: 40 };
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.ok((sm.store?.metals || 0) > 0, "with a filled larder it banks into its output buffer");
  assert.equal(s.players.player.resources.metals || 0, 0, "…still never the treasury");
});

test("an AI Plasma Rig banks its dig straight into the treasury (no buffer to stall)", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const r = makeBuilding("reactor", "ai", 500, 500); s.buildings.set(r.id, r);
  const rig = makeBuilding("plasmarig", "ai", 520, 500); s.buildings.set(rig.id, rig);
  s.players.ai.resources.radioactives = 100;   // nuclear to exploit
  for (let i = 0; i < 200; i++) updatePlasmaRig(s, rig, 0.1);
  assert.ok((rig.digCount || 0) > 0, "the rig completed dig cycles");
  assert.ok((rig.lastYield || 0) > 0, "…banking a real yield");
  const store = rig.store || {};
  assert.equal(Object.values(store).reduce((a, b) => a + b, 0), 0, "…straight to the treasury, nothing left in a buffer");
});

// Phase 2 — the AI develops its base: builds a Reactor and electrifies its buildings.
test("an Odyssey AI powers and electrifies its base (Reactor + electrified buildings)", () => {
  const s = aiBase("ferros");
  for (let i = 0; i < 500; i++) tick(s, 0.2);   // ~100s: time to bank, build a Reactor, and wire the base in
  const reactors = [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === "reactor" && !b.constructing);
  assert.ok(reactors.length >= 1, "the AI built a Reactor to power its base");
  const electrified = [...s.buildings.values()].filter(b => b.owner === "ai" && b.electrified);
  assert.ok(electrified.length >= 1, `the AI electrified a base building (${electrified.map(b => b.type).join(",")})`);
});

// Skirmish quarantine: the AI never builds Odyssey industry off the endless layer.
test("a skirmish AI builds no Reactor and electrifies nothing (byte-identical short game)", () => {
  const s = createGameState({ planetId: "ferros" });   // not endless
  for (let i = 0; i < 300; i++) tick(s, 0.2);
  const industry = [...s.buildings.values()].filter(b => b.owner === "ai" && (b.type === "reactor" || b.electrified));
  assert.equal(industry.length, 0, "no reactors, no electrification in a skirmish");
});

// Phase 3 — a patient developer AI climbs the factory chain and researches the tech tree.
test("a developer AI builds the factory chain and researches (Smelter → Datacenter → Assembler)", () => {
  const s = aiBase("ferros");   // Economist archetype → wantsRefinery, so it develops industry
  s.players.ai.resources.crystals = 3000;      // fund the research (crystals) and the deeper recipes
  s.players.ai.resources.radioactives = 3000;
  for (let i = 0; i < 1200; i++) tick(s, 0.2);   // ~240s: reach the Assembler via Metallurgy
  const built = new Set([...s.buildings.values()].filter(b => b.owner === "ai" && !b.constructing).map(b => b.type));
  assert.ok(built.has("smelter"), "the AI raised a Smelter (ore → metals)");
  assert.ok(built.has("datacenter"), "…and a Datacenter to research");
  assert.ok(s.players.ai.upgrades.metallurgy, "…researched Metallurgy");
  assert.ok(built.has("assembler"), "…and climbed to the Assembler once Metallurgy unlocked it");
  assert.ok((s.players.ai.resources.metals || 0) > 0, "the chain is producing — metals in the treasury");
  const reactors = [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === "reactor").length;
  assert.ok(reactors >= 1 && reactors <= 5, `power scales sanely, no over-build (${reactors} reactors)`);
});

// A Rusher stays lean: it electrifies (Phase 2, universal) but never sinks ore into the deep chain.
test("a Rusher AI electrifies but skips the deep factory chain (temperament preserved)", () => {
  const s = aiBase("korrath");   // Rusher archetype → no wantsRefinery
  s.players.ai.resources.crystals = 3000; s.players.ai.resources.radioactives = 3000;
  for (let i = 0; i < 1000; i++) tick(s, 0.2);
  const built = new Set([...s.buildings.values()].filter(b => b.owner === "ai" && !b.constructing).map(b => b.type));
  assert.ok(!built.has("smelter") && !built.has("datacenter"), "a Rusher builds no factory chain");
});
