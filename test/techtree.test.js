import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { TECHS, researchTech, updateResearch, researchTimeScale, techMult } from "../engine/techtree.js";
import { BUILDINGS, prereqsMet } from "../engine/entities.js";

// A datacenter owned by the player on an endless world, with commodities to burn.
function odysseyWithDatacenter(planetId = "ferros") {
  const state = createGameState({ planetId, endless: true });
  const dc = makeBuilding("datacenter", "player", 600, 500);
  state.buildings.set(dc.id, dc);
  state.players.player.resources.crystals = 1000;
  state.players.player.resources.radioactives = 1000;
  return { state, dc };
}

test("every TECH node is well-formed: a commodity cost (no separate currency), a time, resolvable prereqs", () => {
  for (const t of Object.values(TECHS)) {
    assert.ok(t.cost && Object.keys(t.cost).length > 0, `${t.id} costs gathered commodities`);
    assert.ok(!t.cost.tech, `${t.id} must not invent a separate tech currency`);
    assert.ok(t.time > 0, `${t.id} takes time to develop`);
    assert.ok(t.desc, `${t.id} has a description`);
    for (const r of t.requires || []) {
      assert.ok(BUILDINGS[r] || TECHS[r], `${t.id} prereq ${r} resolves to a building or another node`);
    }
  }
});

test("researchTech queues a project and pays its commodity cost on enqueue", () => {
  const { state, dc } = odysseyWithDatacenter();
  const before = state.players.player.resources.crystals;
  assert.equal(researchTech(state, dc.id, "metallurgy"), true);
  assert.equal(state.players.player.resources.crystals, before - TECHS.metallurgy.cost.crystals, "paid on enqueue");
  assert.equal(dc.researchQueue[0].techId, "metallurgy", "the project heads the queue");
  assert.equal(researchTech(state, dc.id, "metallurgy"), false, "the same node can't be queued twice");
  assert.equal(researchTech(state, dc.id, "reactors"), true, "but a second node queues behind the first");
  assert.equal(dc.researchQueue.length, 2, "both are lined up — no more one-at-a-time babysitting");
});

test("a whole prereq chain can be queued at once — a prereq queued ahead counts as met", () => {
  const { state, dc } = odysseyWithDatacenter();
  assert.equal(researchTech(state, dc.id, "metallurgy"), true);
  assert.equal(researchTech(state, dc.id, "electronics"), true, "electronics queues though metallurgy isn't done — it's ahead");
  assert.equal(researchTech(state, dc.id, "machining"), true, "…and machining behind electronics");
  assert.deepEqual(dc.researchQueue.map(j => j.techId), ["metallurgy", "electronics", "machining"]);
});

test("research is prereq-gated and afford-gated", () => {
  const { state, dc } = odysseyWithDatacenter();
  assert.equal(researchTech(state, dc.id, "electronics"), false, "electronics needs metallurgy first");
  state.players.player.upgrades.metallurgy = true;
  assert.equal(researchTech(state, dc.id, "electronics"), true, "unlocked once metallurgy is owned");

  const poor = odysseyWithDatacenter();
  poor.state.players.player.resources.crystals = 0;
  assert.equal(researchTech(poor.state, poor.dc.id, "metallurgy"), false, "can't afford → refused");
});

test("updateResearch develops the head of the queue and banks it into player.upgrades", () => {
  const { state, dc } = odysseyWithDatacenter();
  researchTech(state, dc.id, "metallurgy");
  const need = TECHS.metallurgy.time * researchTimeScale(state);
  for (let t = 0; t < need + 1; t += 0.5) updateResearch(state, dc, 0.5);
  assert.equal(state.players.player.upgrades.metallurgy, true, "the node completes and lands in upgrades");
  assert.equal(dc.researchQueue.length, 0, "the job leaves the queue on completion");
  assert.ok(state.events.some(e => e.type === "researchComplete" && e.techId === "metallurgy"), "an event fires for the HUD/sound");
});

test("the queue auto-advances: a lined-up chain researches without babysitting", () => {
  const { state, dc } = odysseyWithDatacenter();
  researchTech(state, dc.id, "metallurgy");
  researchTech(state, dc.id, "electronics");
  for (let i = 0; i < 4000; i++) updateResearch(state, dc, 0.1);   // long enough for both
  assert.equal(state.players.player.upgrades.metallurgy, true);
  assert.equal(state.players.player.upgrades.electronics, true, "the second node researched on its own after the first");
  assert.equal(dc.researchQueue.length, 0);
});

test("updateResearch is a no-op for a non-Datacenter and for an idle Datacenter", () => {
  const { state, dc } = odysseyWithDatacenter();
  const smelter = makeBuilding("smelter", "player", 700, 500);
  smelter.researchQueue = [{ techId: "metallurgy", progress: 0 }];   // even if mis-set, a non-datacenter ignores it
  state.buildings.set(smelter.id, smelter);
  updateResearch(state, smelter, 100);
  assert.ok(!state.players.player.upgrades.metallurgy, "a Smelter never researches");
  updateResearch(state, dc, 100);   // dc has no queue
  assert.ok(!state.players.player.upgrades.metallurgy, "an idle Datacenter accrues nothing");
});

test("research develops faster on a high-tech world than a frontier one, and is clamped", () => {
  const hi = createGameState({ planetId: "kybernet", endless: true });   // tech 10
  const lo = createGameState({ planetId: "oort", endless: true });        // tech 2
  assert.ok(researchTimeScale(hi) < researchTimeScale(lo), "Kybernet out-researches Oort");
  assert.ok(researchTimeScale(hi) >= 0.5 && researchTimeScale(lo) <= 2, "clamped so no world is punishing");
});

test("passive nodes multiply industry through techMult; unlock nodes carry no passive field", () => {
  assert.equal(techMult({}, "powerMult"), 1, "nothing researched → no multiplier");
  assert.equal(techMult({ reactors: true }, "powerMult"), 1.5, "Fusion Containment lifts Power");
  assert.equal(techMult({ automation: true }, "rateMult"), 1.25, "Automation speeds factories");
  assert.equal(techMult({ heavyalloys: true }, "yieldMult"), 1.4, "Heavy Alloys lifts yield");
  assert.equal(techMult({ metallurgy: true }, "powerMult"), 1, "an unlock node has no passive field");
});

test("the research + deeper-industry buildings are Odyssey-only and tech-gated through prereqsMet", () => {
  for (const t of ["datacenter", "chipfab", "machineworks"]) assert.equal(BUILDINGS[t].odysseyOnly, true, `${t} is Odyssey-only`);
  assert.ok(BUILDINGS.assembler.requires.includes("metallurgy"), "the Assembly Plant is gated behind Metallurgy research");
  assert.ok(BUILDINGS.chipfab.requires.includes("electronics"), "the Chip Fab is gated behind Microelectronics");
  assert.ok(BUILDINGS.machineworks.requires.includes("machining"), "the Machine Works is gated behind Precision Machining");

  // A tech node gates a building through the SAME prereqsMet used by building tokens.
  const state = createGameState({ planetId: "ferros", endless: true });
  const smelter = makeBuilding("smelter", "player", 600, 500);
  state.buildings.set(smelter.id, smelter);
  assert.equal(prereqsMet(state, "player", BUILDINGS.assembler), false, "no metallurgy → Assembly Plant locked");
  state.players.player.upgrades.metallurgy = true;
  assert.equal(prereqsMet(state, "player", BUILDINGS.assembler), true, "metallurgy researched → unlocked");
});
