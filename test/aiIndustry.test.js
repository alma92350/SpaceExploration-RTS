import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { updateProduction } from "../engine/industry.js";
import { updatePlasmaRig } from "../engine/rig.js";

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
