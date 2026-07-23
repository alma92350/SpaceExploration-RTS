import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";

const near = (a, b, eps = 1) => Math.abs(a - b) < eps;

test("Odyssey buildings wear out over time, down to a floor — not below", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const b = makeBuilding("reactor", "player", 600, 500);
  s.buildings.set(b.id, b);
  const hp0 = b.hp;
  for (let i = 0; i < 200; i++) tick(s, 0.1);   // 20s, before any AI army exists
  assert.ok(b.hp < hp0, "the structure wore down with no mender to maintain it");
  assert.ok(b.hp >= b.maxHp * 0.35, "…but never below the wear floor");

  const low = makeBuilding("reactor", "player", 640, 500);
  low.hp = low.maxHp * 0.36;                     // just above the floor
  s.buildings.set(low.id, low);
  for (let i = 0; i < 200; i++) tick(s, 0.1);
  assert.ok(low.hp >= low.maxHp * 0.35 - 1e-6, "wear clamps at the floor, never razing a building on its own");
});

test("a skirmish building does NOT decay — the byte-identical short game is untouched", () => {
  const s = createGameState({ planetId: "ferros" });   // not endless
  const cc = [...s.buildings.values()].find(x => x.owner === "player" && x.type === "command");
  const hp0 = cc.hp;
  for (let i = 0; i < 300; i++) tick(s, 0.1);           // 30s, before the AI can reach the base
  assert.equal(cc.hp, hp0, "no decay off the Odyssey layer");
});

test("a Mender heals faster on the powered grid than off it (recharges from stations)", () => {
  const healed = (onGrid) => {
    const s = createGameState({ planetId: "ferros", endless: true });
    if (onGrid) { const r = makeBuilding("reactor", "player", 500, 500); s.buildings.set(r.id, r); }
    const m = makeUnit("mender", "player", 500, 500); s.units.set(m.id, m);
    const hurt = makeUnit("ranger", "player", 506, 500); hurt.hp = 10; s.units.set(hurt.id, hurt);
    for (let i = 0; i < 20; i++) tick(s, 0.1);          // 2s
    return hurt.hp;
  };
  const onGrid = healed(true), offGrid = healed(false);
  assert.ok(onGrid > offGrid, `on-grid Mender out-heals the off-grid one (${onGrid.toFixed(1)} > ${offGrid.toFixed(1)})`);
  assert.ok(offGrid > 10, "…and even off-grid it still mends slowly on reserves");
});

test("an auto-repair Mender roams to a damaged building; a passive one stays put", () => {
  const mk = (auto) => {
    const s = createGameState({ planetId: "ferros", endless: true });
    const dmg = makeBuilding("turret", "player", 950, 500);
    dmg.hp = dmg.maxHp * 0.5;                           // damaged, far from the mender
    s.buildings.set(dmg.id, dmg);
    const m = makeUnit("mender", "player", 400, 500);
    if (auto) m.autoRepair = true;
    s.units.set(m.id, m);
    const before = Math.hypot(dmg.x - m.x, dmg.y - m.y);
    for (let i = 0; i < 80; i++) tick(s, 0.1);          // 8s
    return before - Math.hypot(dmg.x - m.x, dmg.y - m.y);   // how much closer it got
  };
  assert.ok(mk(true) > 100, "auto-repair mender closed on the damaged building");
  assert.ok(near(mk(false), 0, 5), "a passive mender doesn't roam");
});
