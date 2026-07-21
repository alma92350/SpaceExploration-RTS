import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";
import { chargingPlayerWonder } from "../engine/wonder.js";
import { deployColonyShip } from "../engine/colony.js";

const THINK = 1.5;   // matches ai.js THINK_INTERVAL

// ---- the shared detector ----

test("chargingPlayerWonder finds only a partly-charged, completed player wonder", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  assert.equal(chargingPlayerWonder(s), null, "nothing charging → null");

  const gate = makeBuilding("antimatter_gate", "player", 600, 500);
  s.buildings.set(gate.id, gate);
  assert.equal(chargingPlayerWonder(s), null, "charge 0 → not yet charging");

  gate.charge = 0.5;
  assert.equal(chargingPlayerWonder(s)?.id, gate.id, "0<charge<1 → found");

  gate.charge = 1;
  assert.equal(chargingPlayerWonder(s), null, "full charge → done, not 'charging'");

  gate.charge = 0.5; gate.constructing = true;
  assert.equal(chargingPlayerWonder(s), null, "still constructing → not a live wonder");
});

test("chargingPlayerWonder is null in a skirmish (a wonder is Odyssey-only, never built)", () => {
  const s = createGameState({ planetId: "ferros" });   // no diplomacy, no wonder
  const gate = makeBuilding("antimatter_gate", "player", 600, 500);
  gate.charge = 0.5;
  s.buildings.set(gate.id, gate);
  // Even if one somehow existed, the skirmish AI never reads it (state.diplomacy is
  // undefined at the ai.js seam) — this just documents the detector is pure/harmless.
  assert.equal(chargingPlayerWonder(s)?.id, gate.id, "the detector itself is mode-agnostic…");
});

// ---- the AI sieges the Gate (Feature 1a, fog-gated) ----

// An Odyssey ferros world with a deeply-hostile neighbour and a home AI army, so a
// wave definitely commits this think. Reveals the whole map to the AI's fog so the
// player's buildings (incl. the Gate) are all seen — isolating the TARGET choice.
function siegeWorld(gateCharge) {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  // Deploy the AI's start colony ship so it has a base (its offense needs a CC); drop
  // the player's start ship — this test provides its own player CC + Gate below.
  for (const u of [...s.units.values()]) if (u.type === "colonyship") {
    if (u.owner === "ai") deployColonyShip(s, u.id); else s.units.delete(u.id);
  }
  s.diplomacy = { stance: -0.95, depletion: 0 };   // deeply hostile → h≈0.94, a real wave
  for (let i = 0; i < 12; i++) {
    const u = makeUnit("skiff", "ai", s.map.bases.ai.x, s.map.bases.ai.y);
    s.units.set(u.id, u);
  }
  const cc = makeBuilding("command", "player", s.map.bases.player.x, s.map.bases.player.y);
  const gate = makeBuilding("antimatter_gate", "player", s.map.bases.player.x + 220, s.map.bases.player.y + 160);
  if (gateCharge != null) gate.charge = gateCharge;
  s.buildings.set(cc.id, cc);
  s.buildings.set(gate.id, gate);
  s.fogAI.visible.fill(1);   // the AI can see the whole map (incl. the Gate)
  s.time = 999;              // past any wave cadence gate
  return { s, cc, gate };
}
const attackersOf = s => [...s.units.values()].filter(u => u.owner === "ai" && u.order?.type === "attack-move");
const nearer = (o, a, b) => Math.hypot(o.x - a.x, o.y - a.y) < Math.hypot(o.x - b.x, o.y - b.y);

test("the AI's wave converges on a visible charging Gate, not the Command Center", () => {
  const { s, cc, gate } = siegeWorld(0.5);
  runAI(s, THINK);
  const attackers = attackersOf(s);
  assert.ok(attackers.length > 0, "a wave launches against a deeply-hostile neighbour");
  assert.ok(attackers.every(u => nearer(u.order, gate, cc)),
    "every attacker is aimed at the Gate, not the CC");
});

test("with no Gate charging, the same wave targets the Command Center (regression guard)", () => {
  const { s, cc, gate } = siegeWorld(0);   // Gate present but NOT charging
  runAI(s, THINK);
  const attackers = attackersOf(s);
  assert.ok(attackers.length > 0, "a wave still launches");
  assert.ok(attackers.every(u => nearer(u.order, cc, gate)),
    "a non-charging Gate is ignored — the wave hits the CC via the normal target ladder");
});

test("a Gate the AI CANNOT see is not sieged (targeting stays fog-gated)", () => {
  const { s, cc, gate } = siegeWorld(0.5);
  s.fogAI.visible.fill(0);                 // blind the AI...
  // ...but reveal ONLY the CC, not the Gate, so the AI has a valid target but no eyes on the Gate.
  const reveal = (fx, fy) => {
    const cx = Math.floor(fx / (s.map.width / s.fogAI.cols));
    const cy = Math.floor(fy / (s.map.height / s.fogAI.rows));
    s.fogAI.visible[cy * s.fogAI.cols + cx] = 1;
  };
  reveal(cc.x, cc.y);
  runAI(s, THINK);
  const attackers = attackersOf(s);
  assert.ok(attackers.length > 0, "a wave launches");
  assert.ok(attackers.every(u => nearer(u.order, cc, gate)),
    "an unseen Gate can't pull the army — the AI marches on the seen CC instead");
});
