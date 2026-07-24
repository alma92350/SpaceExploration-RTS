import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import { updateProduction } from "../engine/industry.js";
import { updatePlasmaRig } from "../engine/rig.js";
import { storeCapOf } from "../engine/entities.js";
import { mulberry32 } from "../engine/rng.js";

// A SEEDED Odyssey state — createGameState falls back to Math.random for map generation when no rng
// is passed, so pin one, else the node layout (and the AI's economy timing) varies run to run.
const seeded = (planetId, endless = true, seed = 4242) =>
  createGameState({ planetId, endless, seed, rng: mulberry32(seed) });

// Give an Odyssey AI a real, deployed base (Odyssey seeds only a colony ship) so the AI-brain
// phases have something to build from: a CC, a Barracks, workers, and ore to spend.
function aiBase(planetId = "ferros") {
  const s = seeded(planetId);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 5; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 3000;   // plenty, so industry isn't starved behind the army
  return s;
}

// TRUE SYMMETRY — the AI runs the SAME finite-buffer + worker-haulage model the player does. A factory
// only produces once workers have supplied its input larder; a rig fills a finite buffer that stalls
// until hauled. There is no owner special-case; skirmish (no factories) is untouched.

test("an AI Smelter with no workers to supply it produces nothing — real logistics, no free treasury", () => {
  const s = seeded("ferros");
  const r = makeBuilding("reactor", "ai", 500, 500); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "ai", 520, 500); s.buildings.set(sm.id, sm);
  s.players.ai.resources.ore = 100;   // ore in the treasury, but no worker to carry it into the larder
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.equal(s.players.ai.resources.metals || 0, 0, "no metals — the larder was never supplied (the abstract cheat is gone)");
  assert.equal(s.players.ai.resources.ore, 100, "…and the treasury ore is untouched — no straight-from-treasury draw");
});

test("an AI factory runs off its finite buffers exactly like the player's (filled larder → store, not treasury)", () => {
  const s = seeded("ferros");
  const r = makeBuilding("reactor", "ai", 500, 500); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "ai", 520, 500); s.buildings.set(sm.id, sm);
  sm.input = { ore: 40 };   // as if a worker had delivered ore to the larder
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.ok((sm.store?.metals || 0) > 0, "it banked metals into its output buffer");
  assert.equal(s.players.ai.resources.metals || 0, 0, "…never straight to the treasury (a worker must haul it out)");
});

test("an AI factory with no Reactor produces nothing — the power throttle still bites", () => {
  const s = seeded("ferros");
  const sm = makeBuilding("smelter", "ai", 520, 500); s.buildings.set(sm.id, sm);
  s.players.ai.resources.ore = 100;
  for (let i = 0; i < 50; i++) updateProduction(s, sm, 0.1);
  assert.equal(s.players.ai.resources.metals || 0, 0, "no Reactor → no power → no production");
  assert.equal(s.players.ai.resources.ore, 100, "…and no ore consumed");
});

test("a PLAYER factory still runs off its buffers, not the treasury (haulage path unchanged)", () => {
  const s = seeded("ferros");
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

test("an AI Plasma Rig fills a finite buffer that stalls until hauled — no free treasury", () => {
  const s = seeded("ferros");
  const r = makeBuilding("reactor", "ai", 500, 500); s.buildings.set(r.id, r);
  const rig = makeBuilding("plasmarig", "ai", 520, 500); s.buildings.set(rig.id, rig);
  s.players.ai.resources.radioactives = 100;   // nuclear to exploit
  const treasuryBefore = { ...s.players.ai.resources };
  for (let i = 0; i < 400; i++) updatePlasmaRig(s, rig, 0.1);   // no workers → the buffer fills and stalls
  assert.ok((rig.digCount || 0) > 0, "the rig completed dig cycles");
  const stored = Object.values(rig.store || {}).reduce((a, b) => a + b, 0);
  assert.ok(stored > 0, "the dig piled into the rig's finite output buffer");
  assert.ok(stored <= storeCapOf("plasmarig") + 1e-6, "…which stalled at its cap, not an unbounded treasury sink");
  const vein = Object.keys(rig.store)[0];
  assert.ok((s.players.ai.resources[vein] || 0) <= (treasuryBefore[vein] || 0) + 1e-9, "…and nothing went straight to the treasury");
});

// The AI actually runs the machinery: it dedicates workers to feed/clear its factory, and the goods
// complete the loop back to the treasury via haulage — the same labour the player pays.
test("the AI feeds and clears its factory with real worker haulage (metals reach the treasury)", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 560, 540); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "ai", 620, 540); s.buildings.set(sm.id, sm);
  s.players.ai.resources.ore = 500;   // raws for its workers to carry to the larder
  for (let i = 0; i < 900; i++) tick(s, 0.2);
  assert.ok((s.players.ai.resources.metals || 0) > 0, "the AI's workers fed the smelter and hauled the metals back to the treasury");
});

test("the AI dedicates a worker to service its factory (real logistics allocation)", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 560, 540); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "ai", 620, 540); s.buildings.set(sm.id, sm);
  s.players.ai.resources.ore = 500;   // so the factory needs input and the treasury can supply it
  let serviced = false;
  for (let i = 0; i < 6 && !serviced; i++) {
    runAI(s, 1.5);
    serviced = [...s.units.values()].some(u => u.owner === "ai" && u.order && u.order.type === "service" && u.order.buildingId === sm.id);
  }
  assert.ok(serviced, "the AI assigned a worker to service the smelter");
});

test("AI logistics is bounded — gathering never starves (at most half the workers haul)", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 560, 540); s.buildings.set(r.id, r);
  for (let i = 0; i < 3; i++) { const b = makeBuilding("smelter", "ai", 600 + i * 30, 560); s.buildings.set(b.id, b); }   // more factories than half the pool can serve
  s.players.ai.resources.ore = 500;
  for (let i = 0; i < 3; i++) runAI(s, 1.5);
  const ws = [...s.units.values()].filter(u => u.owner === "ai" && u.type === "worker");
  const logi = ws.filter(w => w.order && (w.order.type === "service" || w.order.type === "haul")).length;
  assert.ok(logi >= 1, "some workers service the factories");
  assert.ok(logi <= Math.ceil(ws.length / 2), `…but at most half haul, so miners remain (${logi}/${ws.length})`);
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
  const s = seeded("ferros", false);   // not endless
  for (let i = 0; i < 300; i++) tick(s, 0.2);
  const industry = [...s.buildings.values()].filter(b => b.owner === "ai" && (b.type === "reactor" || b.electrified));
  assert.equal(industry.length, 0, "no reactors, no electrification in a skirmish");
});

// Phase 3 — a patient developer AI climbs the factory chain and researches the tech tree. Tested at
// the DECISION level (runAI issues the build/research immediately) — fast, and robust to map timing.
const aiTypes = s => new Set([...s.buildings.values()].filter(b => b.owner === "ai").map(b => b.type));

test("a developer AI opens the industrial chain — a Smelter, then a Datacenter to research", () => {
  const s = aiBase("ferros");   // Economist archetype → wantsRefinery, so it develops industry
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);   // the chain needs power
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(aiTypes(s).has("smelter"), "the AI raised a Smelter (ore → metals)");
  assert.ok(aiTypes(s).has("datacenter"), "…and a Datacenter to research");
});

test("a developer AI researches the tech tree at its Datacenter", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const dc = makeBuilding("datacenter", "ai", 560, 540); s.buildings.set(dc.id, dc);
  s.players.ai.resources.crystals = 500;
  let researching = false;
  for (let i = 0; i < 8 && !researching; i++) {
    runAI(s, 1.5);
    researching = s.players.ai.upgrades.metallurgy || (dc.researchQueue || []).some(j => j.techId === "metallurgy");
  }
  assert.ok(researching, "the AI queued Metallurgy at its Datacenter");
});

test("once Metallurgy is researched the AI climbs to the Assembler", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const sm = makeBuilding("smelter", "ai", 560, 540); s.buildings.set(sm.id, sm);
  s.players.ai.upgrades.metallurgy = true;   // unlock the Assembler
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(aiTypes(s).has("assembler"), "the AI built the Assembler its research unlocked");
});

// A Rusher stays lean: it electrifies (Phase 2, universal) but never sinks ore into the deep chain.
test("a Rusher AI electrifies but skips the deep factory chain (temperament preserved)", () => {
  const s = aiBase("korrath");   // Rusher archetype → no wantsRefinery
  s.players.ai.resources.crystals = 3000; s.players.ai.resources.radioactives = 3000;
  for (let i = 0; i < 1000; i++) tick(s, 0.2);
  const built = new Set([...s.buildings.values()].filter(b => b.owner === "ai" && !b.constructing).map(b => b.type));
  assert.ok(!built.has("smelter") && !built.has("datacenter"), "a Rusher builds no factory chain");
});

// Phase 4 — the capital path. Tested at the DECISION level (runAI issues the build/queue immediately,
// via issueBuild/queueProduction) rather than simulating the ~10-minute climb, so it stays fast.
test("with the Strategic tree standing, the AI founds a Star Dock and a Plasma Rig", () => {
  const s = aiBase("ferros");
  for (const [t, x, y] of [["reactor", 764, 452], ["aifoundry", 764, 556], ["torpedoworks", 852, 452]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  Object.assign(s.players.ai.resources, { ore: 6000, machinery: 40, electronics: 40, ai: 40 });
  for (let i = 0; i < 8; i++) runAI(s, 1.5);   // a few think cycles — enough to issue the builds
  const types = new Set([...s.buildings.values()].filter(b => b.owner === "ai").map(b => b.type));
  assert.ok(types.has("stardock"), "the AI founded a Star Dock (AI Foundry + Torpedo Works met)");
  assert.ok(types.has("plasmarig"), "…and a Plasma Rig (AI Foundry + Reactor met, goods in hand)");
});

test("the AI trains a Leviathan at a completed Star Dock (strategic goods on hand)", () => {
  const s = aiBase("ferros");
  for (const [t, x, y] of [["reactor", 764, 452], ["stardock", 764, 556], ["habitat", 700, 436], ["habitat", 700, 566]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  Object.assign(s.players.ai.resources, { ore: 4000, ai: 40, plasmatorp: 40 });
  const leviQueued = () => [...s.buildings.values()].some(b => b.type === "stardock" && b.queue.some(j => j.unitType === "leviathan"));
  let queued = false;
  for (let i = 0; i < 8 && !queued; i++) { runAI(s, 1.5); queued = leviQueued(); }
  assert.ok(queued, "the AI queued a Leviathan at its Star Dock");
});
