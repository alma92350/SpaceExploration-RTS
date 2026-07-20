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

test("researchTech starts a project: pays the commodity cost, one project at a time", () => {
  const { state, dc } = odysseyWithDatacenter();
  const before = state.players.player.resources.crystals;
  assert.equal(researchTech(state, dc.id, "metallurgy"), true);
  assert.equal(state.players.player.resources.crystals, before - TECHS.metallurgy.cost.crystals, "paid on start");
  assert.ok(dc.research && dc.research.techId === "metallurgy", "the project is in progress");
  assert.equal(researchTech(state, dc.id, "reactors"), false, "a Datacenter researches one node at a time");
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

test("updateResearch develops the node over time and banks it into player.upgrades", () => {
  const { state, dc } = odysseyWithDatacenter();
  researchTech(state, dc.id, "metallurgy");
  const need = TECHS.metallurgy.time * researchTimeScale(state);
  for (let t = 0; t < need + 1; t += 0.5) updateResearch(state, dc, 0.5);
  assert.equal(state.players.player.upgrades.metallurgy, true, "the node completes and lands in upgrades");
  assert.equal(dc.research, null, "the project clears on completion");
  assert.ok(state.events.some(e => e.type === "researchComplete" && e.techId === "metallurgy"), "an event fires for the HUD/sound");
});

test("updateResearch is a no-op for a non-Datacenter and for an idle Datacenter", () => {
  const { state, dc } = odysseyWithDatacenter();
  const smelter = makeBuilding("smelter", "player", 700, 500);
  smelter.research = { techId: "metallurgy", progress: 0 };   // even if mis-set, a non-datacenter ignores it
  state.buildings.set(smelter.id, smelter);
  updateResearch(state, smelter, 100);
  assert.ok(!state.players.player.upgrades.metallurgy, "a Smelter never researches");
  updateResearch(state, dc, 100);   // dc has no research job
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
