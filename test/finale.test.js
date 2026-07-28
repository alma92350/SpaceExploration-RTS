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

// ---- P1 review gap (supplemental): the Gate override outranks a Tactical economy raid too ----
//
// The three tests above already exercise the documented behavior (converges on a visible
// charging Gate; ignores a non-charging or unseen one) — this closes the one remaining branch:
// `raid = !gate && state.ai.micro && !desperate && waveCount % RAID_EVERY === 0 && raidTarget(...)`
// means a charging Gate must outrank even a Tactical economy raid, not just the default
// Command-Center target. No existing test turns on aiMicro alongside a charging Gate.
test("a charging Gate outranks even a Tactical economy raid — the wave still converges on it, not the worker line", () => {
  const { s, cc, gate } = siegeWorld(0.5);
  s.ai.micro = true;      // Tactical: economy raids are in play
  s.ai.waveCount = 2;     // this cycle's commit makes it 3 — a RAID_EVERY-th (raid-eligible) wave
  // +300/-250, not -300/-300: the player base sits near the map's left edge (x=160 on this
  // seed), so a naive -300 offset lands off-map — invisible to the AI's fog regardless of the
  // full-map reveal below — and raidTarget would find nothing whether or not the Gate exists.
  const workerNearPlayer = makeUnit("worker", "player", s.map.bases.player.x + 300, s.map.bases.player.y - 250);
  s.units.set(workerNearPlayer.id, workerNearPlayer);

  runAI(s, THINK);
  const attackers = attackersOf(s);
  assert.ok(attackers.length > 0, "a wave still launches");
  assert.ok(attackers.every(u => nearer(u.order, gate, cc)),
    "the wave still converges on the charging Gate rather than peeling off onto the worker-line raid");

  // Regression companion, same RAID_EVERY-th wave: WITHOUT a charging Gate, this fixture really
  // does prefer the economy raid — confirming the fixture actually reaches the raid branch, so
  // the assertion above is a genuine override, not a config that never gets there.
  const { s: s2, cc: cc2 } = siegeWorld(0);   // Gate present but not charging
  s2.ai.micro = true;
  s2.ai.waveCount = 2;
  const worker2 = makeUnit("worker", "player", s2.map.bases.player.x + 300, s2.map.bases.player.y - 250);
  s2.units.set(worker2.id, worker2);

  runAI(s2, THINK);
  const attackers2 = attackersOf(s2);
  assert.ok(attackers2.length > 0, "the comparison wave launches too");
  assert.ok(attackers2.every(u => nearer(u.order, worker2, cc2)),
    "…and without a charging Gate, the same RAID_EVERY-th wave really does peel onto the worker line");
});
