import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { runAI } from "../engine/ai.js";
import { updateProduction } from "../engine/industry.js";
import { updatePlasmaRig } from "../engine/rig.js";
import { storeCapOf } from "../engine/entities.js";
import { mulberry32 } from "../engine/rng.js";
import { plannedMix } from "../engine/aiWorkers.js";

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
  const r = makeBuilding("reactor", "ai", 500, 500); r.powered = true; s.buildings.set(r.id, r);
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
  const r = makeBuilding("reactor", "player", 500, 500); r.powered = true; s.buildings.set(r.id, r);
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
  const r = makeBuilding("reactor", "ai", 500, 500); r.powered = true; s.buildings.set(r.id, r);
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

// Tier 4 (engine/aiDifficulty.js rusherGraduates, Hard only): past RUSHER_GRADUATE_TIME, a Rusher
// picks up the same deep chain a patient developer would — tested at the DECISION level (the
// existing "developer AI opens the industrial chain" idiom above), not a real-time simulation.
test("a Rusher AI on Hard, once its opening rush is long past, graduates into the deep factory chain", () => {
  const s = aiBase("korrath");
  s.ai.difficulty = "hard";
  s.time = 1300;   // past RUSHER_GRADUATE_TIME (1200)
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(aiTypes(s).has("smelter"), "graduated: the Rusher raised a Smelter");
  assert.ok(aiTypes(s).has("datacenter"), "…and a Datacenter to research");
});

test("a Rusher AI on Hard but still within its opening rush window has not graduated yet", () => {
  const s = aiBase("korrath");
  s.ai.difficulty = "hard";
  s.time = 500;   // well before RUSHER_GRADUATE_TIME (1200)
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(!aiTypes(s).has("smelter") && !aiTypes(s).has("datacenter"), "too soon to graduate — still a lean Rusher");
});

test("a Rusher AI on Medium never graduates, however long the game runs — rusherGraduates is Hard-only", () => {
  const s = aiBase("korrath");
  s.ai.difficulty = "medium";
  s.time = 5000;   // far past RUSHER_GRADUATE_TIME — only the difficulty gate should be stopping it now
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(!aiTypes(s).has("smelter") && !aiTypes(s).has("datacenter"), "Medium keeps the Rusher's temperament forever");
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

/* ---------- the industry BOOTSTRAP reserve (docs/odyssey-ai-review.md §2.4) ---------- */

// runAI's phase order is load-bearing and puts unit production BEFORE industry, with no holdback
// between them. So an archetype whose units are cheap relative to its income spent its ore down
// below a Reactor's 120 every think cycle and never developed: a Rusher world measured at one
// industrial building after 60 sim-minutes, and Hard's rusherGraduates landing ~30 minutes past
// its own 20-minute trigger. The Foundry and Refinery already solve exactly this with
// ctx.foundryReserve / ctx.refineryReserve; industry now has the same, BOUNDED to the grid plus
// the first couple of chain buildings so the army is never frozen for the whole climb.

// Both modes auto-seed a side (Odyssey a colony ship, skirmish a CC + workers) — strip it, or the
// fixture's supply and building counts aren't the ones the test is reasoning about.
function clearAiSeed(s) {
  for (const [id, u] of [...s.units]) if (u.owner === "ai") s.units.delete(id);
  for (const [id, b] of [...s.buildings]) if (b.owner === "ai") s.buildings.delete(id);
}

// A Rusher (korrath) Odyssey base: no Foundry or Refinery reserve of its own (its mix wants
// neither), so unit production is the ONLY thing competing for the ore — the exact shape that
// starved the grid.
function rusherBase(ore) {
  const s = seeded("korrath");
  clearAiSeed(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 7; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = ore;   // enough for a Reactor (120) OR a Skiff (100) — not both
  return s;
}
const aiOf = (s, type) => [...s.buildings.values()].filter(b => b.owner === "ai" && b.type === type);
const aiBarracksQueue = s => aiOf(s, "barracks")[0].queue;

test("an Odyssey AI banks for its Reactor instead of spending the ore on one more Skiff", () => {
  const s = rusherBase(150);
  runAI(s, 1.5);
  assert.equal(aiOf(s, "reactor").length, 1, "the grid gets founded — without a reserve the unit cycle ate the ore first");
  assert.equal(aiBarracksQueue(s).length, 0, "…and unit production is held back exactly while it banks, like the Foundry's reserve");
});

test("with the grid already up, a Rusher goes straight back to building units — the reserve is bounded", () => {
  const s = rusherBase(150);
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  runAI(s, 1.5);
  assert.ok(aiBarracksQueue(s).length > 0,
    "a Rusher stops at power+electrify, so nothing further is reserved and the army keeps flowing");
});

test("a developer stops reserving once its bootstrap chain stands, so the deep climb is bought from surplus", () => {
  const s = seeded("ferros");   // economist: wantsRefinery, so it does climb the chain
  clearAiSeed(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  for (const [t, x, y] of [["barracks", 664, 500], ["reactor", 540, 560], ["smelter", 700, 560],
                           ["datacenter", 700, 440], ["foundry", 510, 590], ["refinery", 510, 440]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  for (let i = 0; i < 12; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  const hab = makeBuilding("habitat", "ai", 600, 590); s.buildings.set(hab.id, hab);
  s.players.ai.resources.ore = 150;
  runAI(s, 1.5);
  assert.ok(aiBarracksQueue(s).length > 0,
    "past INDUSTRY_BOOTSTRAP the reserve is off — a long chain must never freeze the army for its whole length");
});

test("a SKIRMISH AI reserves nothing for industry — it has no industry to build", () => {
  const s = createGameState({ planetId: "korrath", endless: false, seed: 4242, rng: mulberry32(4242) });
  clearAiSeed(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 7; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 150;
  runAI(s, 1.5);
  assert.equal(aiOf(s, "reactor").length, 0, "no Reactor in a skirmish (aiIndustry is endless-only)");
  assert.ok(aiBarracksQueue(s).length > 0, "…so the skirmish unit cycle spends exactly as it always did");
});

/* ---------- graduation reaches the army (docs/improvement-proposals.md "Graduation reaches the
   army"): plannedMix (engine/aiWorkers.js) extends a developing AI's mix with the Foundry/Arsenal-
   gated units its industry climb unlocks, and aiEconomy's wantsFoundry/wantsArsenal gates now read
   THAT extended list — not just the raw archetype.unitMix — so a graduated Rusher actually techs
   the Foundry instead of climbing the factory chain with a Barracks stuck on Skiff/Bastion. ---------- */

test("plannedMix extends a graduated Hard Rusher's mix with the graduate units, pre-filter", () => {
  const s = seeded("korrath");   // Rusher: pure Tier-1 mix, no Foundry-gated entry of its own
  s.ai.difficulty = "hard";
  s.time = 1300;   // past RUSHER_GRADUATE_TIME (1200)
  const mix = plannedMix(s, s.ai.archetype);
  assert.deepEqual(mix, [...s.ai.archetype.unitMix, "lancer", "lancer", "dreadnought"],
    "the base mix plus the graduate extension, appended once");
});

test("plannedMix leaves a non-graduated Rusher's mix untouched — still within its rush window", () => {
  const s = seeded("korrath");
  s.ai.difficulty = "hard";
  s.time = 500;   // well before RUSHER_GRADUATE_TIME (1200)
  assert.deepEqual(plannedMix(s, s.ai.archetype), s.ai.archetype.unitMix);
});

test("plannedMix leaves a Rusher's mix untouched on Medium, however long the game runs", () => {
  const s = seeded("korrath");
  s.ai.difficulty = "medium";
  s.time = 5000;   // far past RUSHER_GRADUATE_TIME — rusherGraduates is Hard-only
  assert.deepEqual(plannedMix(s, s.ai.archetype), s.ai.archetype.unitMix);
});

test("plannedMix also extends a Rusher's mix under the Economic strategy's wantsIndustryAlways — not just Hard's graduation", () => {
  const s = seeded("korrath");   // default Medium difficulty — rusherGraduates never fires
  s.ai.strategy = "economic";
  const mix = plannedMix(s, s.ai.archetype);
  assert.deepEqual(mix, [...s.ai.archetype.unitMix, "lancer", "lancer", "dreadnought"]);
});

test("plannedMix does not double up on an archetype whose mix already reaches the Foundry (Economist)", () => {
  const s = seeded("ferros");   // Economist: wantsRefinery -> wantsDeepIndustry true, but the mix already has Lancer/Breacher
  const mix = plannedMix(s, s.ai.archetype);
  assert.deepEqual(mix, s.ai.archetype.unitMix, "already Foundry-gated — the graduate extension is a no-op");
});

test("plannedMix never extends the mix in skirmish, however far past graduation the clock runs — the state.endless gate", () => {
  const s = seeded("korrath", false);   // NOT endless
  s.ai.difficulty = "hard";
  s.time = 5000;
  assert.deepEqual(plannedMix(s, s.ai.archetype), s.ai.archetype.unitMix,
    "skirmish stays byte-identical: no graduate extension, regardless of difficulty/time");
});

test("a graduated Hard Rusher now wants (and starts) the Foundry its extended mix needs — not just the factory chain", () => {
  const s = aiBase("korrath");
  s.ai.difficulty = "hard";
  s.time = 1300;   // past RUSHER_GRADUATE_TIME
  const built = [];
  for (let i = 0; i < 12; i++) {
    runAI(s, 1.5);
    const bar = [...s.buildings.values()].find(b => b.owner === "ai" && b.type === "barracks");
    if (bar.queue.length) { built.push(bar.queue[bar.queue.length - 1].unitType); bar.queue.length = 0; }
  }
  assert.ok(aiTypes(s).has("foundry"),
    "graduated: the Rusher's now-extended mix includes a Foundry-gated unit, so wantsFoundry fires and it builds one");
  assert.ok(built.every(t => t === "skiff" || t === "bastion"),
    "…but the unit cycle stays Tier-1 until that Foundry actually completes — effectiveMix's existing prereq filter keeps this deadlock-free");
});

/* ---------- the trade-industry branch (docs/improvement-proposals.md "Promote the legacy
   consumer-goods recipes into a trade-industry branch") — the optional half of that proposal:
   INDUSTRY_CHAIN/RESEARCH_ORDER extended so a developer AI can also walk this branch, not just the
   existing military/Gate spine. Tested at the same DECISION level the rest of this file already
   uses (prereqs pre-set, a handful of think cycles) — fast, and robust to map timing. */

test("a developer AI researches chemistry once Metallurgy is already done — the off-spine branch isn't left permanently unresearched", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const dc = makeBuilding("datacenter", "ai", 560, 540); s.buildings.set(dc.id, dc);
  s.players.ai.upgrades.metallurgy = true;
  s.players.ai.resources.crystals = 500;
  let researching = false;
  for (let i = 0; i < 8 && !researching; i++) {
    runAI(s, 1.5);
    researching = s.players.ai.upgrades.chemistry || (dc.researchQueue || []).some(j => j.techId === "chemistry");
  }
  assert.ok(researching, "the AI picks up chemistry once metallurgy is already researched");
});

test("once chemistry is researched the AI climbs to the Chemical Plant — with metallurgy never researched at all", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const dc = makeBuilding("datacenter", "ai", 560, 540); s.buildings.set(dc.id, dc);
  const sm = makeBuilding("smelter", "ai", 620, 540); s.buildings.set(sm.id, sm);   // earlier in the chain's priority order, already standing
  s.players.ai.upgrades.chemistry = true;   // the off-spine root — deliberately NOT metallurgy
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(aiTypes(s).has("chemplant"), "the AI built the Chemical Plant its research unlocked, with metallurgy never researched");
});

test("once consumerfab is researched (and both branches are already standing) the AI climbs to the Fabricator", () => {
  const s = aiBase("ferros");
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const dc = makeBuilding("datacenter", "ai", 560, 540); s.buildings.set(dc.id, dc);
  const sm = makeBuilding("smelter", "ai", 620, 540); s.buildings.set(sm.id, sm);
  const as = makeBuilding("assembler", "ai", 680, 540); s.buildings.set(as.id, as);
  const cp = makeBuilding("chemplant", "ai", 620, 620); s.buildings.set(cp.id, cp);
  s.players.ai.upgrades.metallurgy = true;
  s.players.ai.upgrades.chemistry = true;
  s.players.ai.upgrades.consumerfab = true;
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(aiTypes(s).has("fabricator"), "the AI built the Fabricator once both branches (alloys + chemicals) and its own tech were in place");
});

test("a skirmish Rusher AI on Hard, however long the game runs, still never wants a Foundry", () => {
  const s = createGameState({ planetId: "korrath", endless: false, seed: 4242, rng: mulberry32(4242) });
  s.ai.difficulty = "hard";
  s.time = 5000;   // far past RUSHER_GRADUATE_TIME — would graduate in Odyssey
  clearAiSeed(s);
  const cc = makeBuilding("command", "ai", 600, 500); s.buildings.set(cc.id, cc);
  const bar = makeBuilding("barracks", "ai", 664, 500); s.buildings.set(bar.id, bar);
  for (let i = 0; i < 7; i++) { const w = makeUnit("worker", "ai", 610 + i * 12, 552); s.units.set(w.id, w); }
  s.players.ai.resources.ore = 3000;
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(!aiTypes(s).has("foundry"), "skirmish never extends the mix — the Foundry gate stays untouched behind state.endless");
});

/* ---------- Tier 6: strategicCeiling (docs/improvement-proposals.md "An Easy strategic ceiling") —
   engine/aiDifficulty.js's table-shape is covered in test/aiDifficulty.test.js; this is the actual
   chain-find/RESEARCH_ORDER slicing behavior. DECISION-level, matching the trade-industry tests
   just above: every prereq an antimatterforge/'antimatter' would need is pre-set, so the ONLY thing
   standing between the AI and the Strategic tier is the ceiling itself. */

// Every T2/T3 chain building an Easy neighbour should still be free to raise, standing so the
// ONLY remaining chain entry is antimatterforge — and 'antimatter' Containment researched, so
// prereqsMet(antimatterforge) is genuinely satisfied and only the ceiling itself can be withholding it.
function preStrategicTierBase(planetId, difficulty) {
  const s = aiBase(planetId);
  s.ai.difficulty = difficulty;
  for (const [t, x, y] of [["reactor", 540, 560], ["smelter", 620, 540], ["datacenter", 620, 620],
                           ["chemplant", 680, 620], ["assembler", 680, 540], ["fabricator", 740, 620],
                           ["chipfab", 740, 540], ["machineworks", 800, 540]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  Object.assign(s.players.ai.upgrades, {
    metallurgy: true, chemistry: true, consumerfab: true, reactors: true, electronics: true,
    automation: true, heavyalloys: true, machining: true, antimatter: true,
  });
  s.players.ai.resources.ore = 6000;
  return s;
}

test("an Easy developer AI never raises the Antimatter Forge, even with every prereq already satisfied", () => {
  const s = preStrategicTierBase("ferros", "easy");
  for (let i = 0; i < 15; i++) runAI(s, 1.5);
  assert.ok(!aiTypes(s).has("antimatterforge"), "strategicCeiling withholds the Strategic tier outright");
  assert.ok(aiTypes(s).has("machineworks"), "…but the T2/T3 factory economy up to Machine Works is untouched");
});

test("a Medium developer AI in the identical setup DOES raise the Antimatter Forge — the ceiling is Easy-only", () => {
  const s = preStrategicTierBase("ferros", "medium");
  for (let i = 0; i < 15; i++) runAI(s, 1.5);
  assert.ok(aiTypes(s).has("antimatterforge"), "Medium climbs the whole chain, exactly as before this feature");
});

test("an Easy developer AI never researches Antimatter Containment, even with every earlier node done", () => {
  const s = aiBase("ferros");
  s.ai.difficulty = "easy";
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const dc = makeBuilding("datacenter", "ai", 560, 540); s.buildings.set(dc.id, dc);
  Object.assign(s.players.ai.upgrades, {
    metallurgy: true, chemistry: true, consumerfab: true, reactors: true, electronics: true,
    automation: true, heavyalloys: true, machining: true,
  });
  s.players.ai.resources.crystals = 3000; s.players.ai.resources.radioactives = 3000;
  for (let i = 0; i < 10; i++) runAI(s, 1.5);
  assert.ok(!s.players.ai.upgrades.antimatter && !(dc.researchQueue || []).some(j => j.techId === "antimatter"),
    "the research ladder stops at 'machining' — 'antimatter' is never even queued");
});

test("a Medium developer AI in the identical research setup DOES queue Antimatter Containment", () => {
  const s = aiBase("ferros");
  s.ai.difficulty = "medium";
  const r = makeBuilding("reactor", "ai", 540, 560); s.buildings.set(r.id, r);
  const dc = makeBuilding("datacenter", "ai", 560, 540); s.buildings.set(dc.id, dc);
  Object.assign(s.players.ai.upgrades, {
    metallurgy: true, chemistry: true, consumerfab: true, reactors: true, electronics: true,
    automation: true, heavyalloys: true, machining: true,
  });
  s.players.ai.resources.crystals = 3000; s.players.ai.resources.radioactives = 3000;
  let queued = false;
  for (let i = 0; i < 10 && !queued; i++) {
    runAI(s, 1.5);
    queued = s.players.ai.upgrades.antimatter || (dc.researchQueue || []).some(j => j.techId === "antimatter");
  }
  assert.ok(queued, "Medium researches on past 'machining', exactly as before this feature");
});
