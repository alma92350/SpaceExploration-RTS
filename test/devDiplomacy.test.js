import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { updateDiplomacy, PEACE_THRESHOLD } from "../engine/diplomacy.js";

// Drift a world's stance to equilibrium at a FIXED depletion and a FIXED time just past the opening
// grace (so the grace floor is off but the late-game creep is still negligible), isolating the effect
// of the neighbour's own development on whether it turns hostile.
function settleStance(build) {
  const s = createGameState({ planetId: "ferros", endless: true });
  s.diplomacy = { stance: 0.35, depletion: 0, tributes: 0, lastAiUnits: 0 };
  for (const n of s.map.nodes) n.amount = n.max * 0.5;   // ~50% mined out on both worlds
  s.time = 430;                                          // just past GRACE_TIME (420) — creep ≈ 0
  build(s);                                              // stand up whatever industry this world's AI has
  for (let i = 0; i < 400; i++) updateDiplomacy(s, 1.0); // drift to equilibrium (DRIFT_RATE 0.05/s)
  return s.diplomacy.stance;
}

test("a developed neighbour keeps the peace where a bare strip-miner goes to war (same depletion)", () => {
  const bare = settleStance(() => {});   // just its seeded colony ship / CC — no industry
  const developed = settleStance(s => {
    // A self-sufficient industrial neighbour: power, the factory chain, a rig, a datacenter + research.
    const kit = [["reactor", 700, 440], ["reactor", 700, 480], ["smelter", 740, 440], ["assembler", 740, 480],
                 ["chipfab", 780, 440], ["machineworks", 780, 480], ["datacenter", 820, 440], ["plasmarig", 820, 480]];
    for (const [t, x, y] of kit) { const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b); }
    Object.assign(s.players.ai.upgrades, { metallurgy: true, electronics: true, machining: true });
  });

  assert.ok(bare <= PEACE_THRESHOLD, `the bare strip-miner turned hostile (${bare.toFixed(2)})`);
  assert.ok(developed > PEACE_THRESHOLD, `the developed neighbour held the peace (${developed.toFixed(2)})`);
  assert.ok(developed > bare + 0.2, `development markedly softened the stance (${developed.toFixed(2)} vs ${bare.toFixed(2)})`);
});

test("development delays war but never prevents it — a fully-mined world still tips hostile", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  s.diplomacy = { stance: 0.35, depletion: 0, tributes: 0, lastAiUnits: 0 };
  for (const n of s.map.nodes) n.amount = 0;   // fully stripped
  s.time = 430;
  for (const [t, x, y] of [["reactor", 700, 440], ["smelter", 740, 440], ["assembler", 740, 480],
                           ["chipfab", 780, 440], ["machineworks", 780, 480], ["datacenter", 820, 440],
                           ["plasmarig", 820, 480], ["antimatterforge", 860, 440]]) {
    const b = makeBuilding(t, "ai", x, y); s.buildings.set(b.id, b);
  }
  Object.assign(s.players.ai.upgrades, { metallurgy: true, electronics: true, machining: true, antimatter: true });
  for (let i = 0; i < 400; i++) updateDiplomacy(s, 1.0);
  assert.ok(s.diplomacy.stance <= PEACE_THRESHOLD, `even a maxed-out developer goes to war on a dead world (${s.diplomacy.stance.toFixed(2)})`);
});
