import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { TECHS, researchTech, updateResearch, researchTimeScale, techMult, cancelResearch } from "../engine/techtree.js";
import { BUILDINGS, UPGRADES, prereqsMet } from "../engine/entities.js";

// A datacenter on an endless world, with commodities to burn — owned by the player by
// default, but an AI-owned one (and any extra createGameState opts, e.g. difficulty) can be
// asked for too, for the AI-only research-pace tests below.
function odysseyWithDatacenter(planetId = "ferros", owner = "player", stateOpts = {}) {
  const state = createGameState({ planetId, endless: true, ...stateOpts });
  const dc = makeBuilding("datacenter", owner, 600, 500);
  state.buildings.set(dc.id, dc);
  state.players[owner].resources.crystals = 1000;
  state.players[owner].resources.radioactives = 1000;
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

test("updateResearch silently drops a queued job whose techId no longer resolves in TECHS", () => {
  const { state, dc } = odysseyWithDatacenter();
  // Simulates a save written before a tech was renamed/removed: the queued techId
  // no longer resolves in TECHS. researchTech itself would refuse such an id, so
  // set the queue directly, same as the non-Datacenter test above.
  dc.researchQueue = [{ techId: "not-a-real-tech", progress: 0 }];
  assert.doesNotThrow(() => updateResearch(state, dc, 1), "an unrecognized techId must not throw");
  assert.equal(dc.researchQueue.length, 0, "the unresolvable job is dropped rather than stalling the queue forever");

  // The Datacenter keeps working normally afterward — a real job can still be
  // queued and developed to completion.
  assert.equal(researchTech(state, dc.id, "metallurgy"), true, "a real research job can still be queued after the stale drop");
  const need = TECHS.metallurgy.time * researchTimeScale(state);
  for (let t = 0; t < need + 1; t += 0.5) updateResearch(state, dc, 0.5);
  assert.equal(state.players.player.upgrades.metallurgy, true, "…and develops to completion normally");
});

test("research develops faster on a high-tech world than a frontier one, and is clamped", () => {
  const hi = createGameState({ planetId: "kybernet", endless: true });   // tech 10
  const lo = createGameState({ planetId: "oort", endless: true });        // tech 2
  assert.ok(researchTimeScale(hi) < researchTimeScale(lo), "Kybernet out-researches Oort");
  assert.ok(researchTimeScale(hi) >= 0.5 && researchTimeScale(lo) <= 2, "clamped so no world is punishing");
});

/* ---------- difficulty's research-pace dial (Tier 2, engine/aiDifficulty.js) — AI-only ---------- */

test("Hard's AI researches faster, and Easy's slower, than Medium's — at the identical world/tech/job", () => {
  const progressAfterOneTick = difficulty => {
    const { state, dc } = odysseyWithDatacenter("ferros", "ai", { difficulty });
    researchTech(state, dc.id, "metallurgy");
    updateResearch(state, dc, 1);
    return dc.researchQueue[0].progress;
  };
  const easy = progressAfterOneTick("easy"), medium = progressAfterOneTick("medium"), hard = progressAfterOneTick("hard");
  assert.ok(hard > medium, "Hard's AI develops the identical job faster than Medium's");
  assert.ok(medium > easy, "Medium's AI develops the identical job faster than Easy's");
});

test("difficulty's research-pace dial never touches the PLAYER's own research, even on an AI-favoring difficulty", () => {
  const progressAfterOneTick = difficulty => {
    const { state, dc } = odysseyWithDatacenter("ferros", "player", { difficulty });
    researchTech(state, dc.id, "metallurgy");
    updateResearch(state, dc, 1);
    return dc.researchQueue[0].progress;
  };
  const easy = progressAfterOneTick("easy"), medium = progressAfterOneTick("medium"), hard = progressAfterOneTick("hard");
  assert.equal(easy, medium, "the player's pace is identical on Easy...");
  assert.equal(hard, medium, "...Medium, and Hard alike — this dial reads building.owner, not who's asking");
});

test("passive nodes multiply industry through techMult; unlock nodes carry no passive field", () => {
  assert.equal(techMult({}, "powerMult"), 1, "nothing researched → no multiplier");
  assert.equal(techMult({ reactors: true }, "powerMult"), 1.5, "Fusion Containment lifts Power");
  assert.equal(techMult({ automation: true }, "rateMult"), 1.25, "Automation speeds factories");
  assert.equal(techMult({ heavyalloys: true }, "yieldMult"), 1.4, "Heavy Alloys lifts yield");
  assert.equal(techMult({ metallurgy: true }, "powerMult"), 1, "an unlock node has no passive field");
});

// Scope Heavy Alloys to the factories its tooltip names (docs/improvement-proposals.md): the
// tooltip promises "+40% output from the Smelter and Assembly Plant" specifically, so techMult
// must honor an appliesTo list and skip the node for any OTHER asking building type.
test("heavyalloys' appliesTo names exactly the Smelter and Assembly Plant, matching its tooltip", () => {
  assert.deepEqual(TECHS.heavyalloys.appliesTo, ["smelter", "assembler"]);
});

test("techMult's optional building-type argument scopes an appliesTo-limited node to only the types it names", () => {
  assert.equal(techMult({ heavyalloys: true }, "yieldMult", "smelter"), 1.4, "applies to the Smelter it names");
  assert.equal(techMult({ heavyalloys: true }, "yieldMult", "assembler"), 1.4, "…and the Assembly Plant it names");
  assert.equal(techMult({ heavyalloys: true }, "yieldMult", "chipfab"), 1, "…but NOT the Chip Fab its tooltip never mentions");
  assert.equal(techMult({ heavyalloys: true }, "yieldMult", "antimatterforge"), 1, "…nor any other deeper factory");
});

test("techMult omitting a building type keeps the plain un-scoped product (back-compat for every pre-existing call site)", () => {
  assert.equal(techMult({ heavyalloys: true }, "yieldMult"), 1.4, "the 2-arg form ignores appliesTo entirely");
});

test("techMult: a node with no appliesTo field stays global regardless of what building type asks", () => {
  assert.equal(techMult({ reactors: true }, "powerMult", "chipfab"), 1.5, "reactors carries no appliesTo — every building type sees it");
  assert.equal(techMult({ automation: true }, "rateMult", "antimatterforge"), 1.25, "automation likewise stays global");
});

/* ---------- generalized to the Refinery's doctrine upgrades too (Tier 1: "Doctrine research
   develops over time instead of landing instantly", docs/improvement-proposals.md) ----------
   updateResearch now resolves ITS node table by building.type — datacenter -> TECHS (above),
   refinery -> UPGRADES — instead of being hardcoded to the Datacenter alone. The Refinery's own
   enqueue side (production.js researchUpgrade: doctrine lock, prereqsMet, queued-dupe guard,
   pay-on-enqueue) is exercised in test/production.test.js; these pin the SHARED development loop
   itself against the Refinery's table. */

function withRefinery(planetId = "ferros", owner = "player", stateOpts = {}) {
  const state = createGameState({ planetId, ...stateOpts });
  const refinery = makeBuilding("refinery", owner, 600, 500);
  state.buildings.set(refinery.id, refinery);
  return { state, refinery };
}

test("updateResearch resolves a Refinery's queue against UPGRADES, not TECHS, and lands it in player.upgrades on completion", () => {
  const { state, refinery } = withRefinery();
  // Set directly (production.js's own enqueue/pay path is covered in production.test.js) — this
  // test is only about the shared development loop resolving the right table.
  refinery.researchQueue = [{ techId: "reinforcedPlating", progress: 0 }];
  const need = UPGRADES.reinforcedPlating.time * researchTimeScale(state);
  for (let t = 0; t < need + 1; t += 0.5) updateResearch(state, refinery, 0.5);
  assert.equal(state.players.player.upgrades.reinforcedPlating, true, "a Refinery job develops against UPGRADES and lands in player.upgrades");
  assert.equal(refinery.researchQueue.length, 0, "the job leaves the queue on completion, same as a Datacenter job");
  assert.ok(state.events.some(e => e.type === "researchComplete" && e.techId === "reinforcedPlating"), "the same researchComplete event a TECHS job fires");
});

test("updateResearch is a no-op for a Refinery still under construction", () => {
  const { state, refinery } = withRefinery();
  refinery.constructing = true;
  refinery.researchQueue = [{ techId: "reinforcedPlating", progress: 0 }];
  updateResearch(state, refinery, 1000);
  assert.ok(!state.players.player.upgrades.reinforcedPlating, "an unfinished Refinery never develops research");
  assert.equal(refinery.researchQueue[0].progress, 0, "no progress accrues either");
});

test("updateResearch silently drops a queued Refinery job whose techId no longer resolves in UPGRADES", () => {
  const { state, refinery } = withRefinery();
  refinery.researchQueue = [{ techId: "not-a-real-upgrade", progress: 0 }];
  assert.doesNotThrow(() => updateResearch(state, refinery, 1), "an unrecognized upgrade id must not throw");
  assert.equal(refinery.researchQueue.length, 0, "the unresolvable job is dropped rather than stalling the queue forever");
});

test("difficulty's research-pace dial also reaches the AI's own Refinery doctrine research, mirroring the Datacenter dial", () => {
  const progressAfterOneTick = difficulty => {
    const { state, refinery } = withRefinery("ferros", "ai", { difficulty });
    refinery.researchQueue = [{ techId: "reinforcedPlating", progress: 0 }];
    updateResearch(state, refinery, 1);
    return refinery.researchQueue[0].progress;
  };
  const easy = progressAfterOneTick("easy"), medium = progressAfterOneTick("medium"), hard = progressAfterOneTick("hard");
  assert.ok(hard > medium, "Hard's AI develops a doctrine upgrade faster than Medium's");
  assert.ok(medium > easy, "Medium's AI develops a doctrine upgrade faster than Easy's");
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

/* ---------- Cancelable research queue with refunds (docs/improvement-proposals.md) ----------
   researchTech pays on enqueue with no way back out — a mis-click or a strategy pivot otherwise
   strands the cost in a queue the player can't touch. cancelResearch mirrors production.js's
   cancelProduction full-refund convention, and cascades over any queued node that named the
   cancelled one in its own `requires` (researchTech's "queued ahead counts as met" allowance means
   a dependent can only ever sit BEHIND its prereq in the queue, never ahead of it). */

test("cancelResearch fully refunds a queued node and removes it from the queue", () => {
  const { state, dc } = odysseyWithDatacenter();
  const before = state.players.player.resources.crystals;
  researchTech(state, dc.id, "metallurgy");

  const ok = cancelResearch(state, dc.id, 0);

  assert.equal(ok, true);
  assert.equal(dc.researchQueue.length, 0);
  assert.equal(state.players.player.resources.crystals, before, "cancelling refunds the full cost, same as production.js's cancelProduction");
});

test("cancelResearch cascades over a whole dependent chain, refunding every cascaded node too", () => {
  const { state, dc } = odysseyWithDatacenter();
  const before = state.players.player.resources.crystals;
  researchTech(state, dc.id, "metallurgy");
  researchTech(state, dc.id, "electronics");   // requires metallurgy, queued ahead of it
  researchTech(state, dc.id, "machining");     // requires electronics, queued ahead of THAT
  assert.equal(dc.researchQueue.length, 3, "sanity: the whole chain queued");

  const ok = cancelResearch(state, dc.id, 0);   // cancel metallurgy, the root of the chain

  assert.equal(ok, true);
  assert.equal(dc.researchQueue.length, 0,
    "electronics and machining both cascade out — neither's prereq can ever be met now, so the queue can't hold an unsatisfiable job");
  assert.equal(state.players.player.resources.crystals, before, "every cascaded node's cost is refunded, not just the one directly cancelled");
});

test("cancelResearch leaves an unrelated queued node untouched by the cascade", () => {
  const { state, dc } = odysseyWithDatacenter();
  researchTech(state, dc.id, "metallurgy");
  researchTech(state, dc.id, "reactors");      // independent passive — no relation to metallurgy
  researchTech(state, dc.id, "electronics");   // requires metallurgy — the dependent

  cancelResearch(state, dc.id, 0);   // cancel metallurgy

  assert.deepEqual(dc.researchQueue.map(j => j.techId), ["reactors"],
    "reactors (unrelated) survives; electronics (the dependent) cascades out");
});

test("cancelResearch refuses an out-of-range index instead of corrupting the queue", () => {
  const { state, dc } = odysseyWithDatacenter();
  researchTech(state, dc.id, "metallurgy");

  const ok = cancelResearch(state, dc.id, 5);

  assert.equal(ok, false);
  assert.equal(dc.researchQueue.length, 1, "the real job is untouched");
});

test("cancelResearch also refunds a Refinery's queued doctrine research (the same shared research loop, UPGRADES table)", () => {
  const { state, refinery } = withRefinery();
  state.players.player.resources.crystals = 1000;
  refinery.researchQueue = [{ techId: "reinforcedPlating", progress: 0.2 }];

  const ok = cancelResearch(state, refinery.id, 0);

  assert.equal(ok, true);
  assert.equal(refinery.researchQueue.length, 0);
  assert.equal(state.players.player.resources.crystals, 1000 + UPGRADES.reinforcedPlating.cost.crystals,
    "refunds the Refinery upgrade's own cost, resolved against UPGRADES instead of TECHS");
});
