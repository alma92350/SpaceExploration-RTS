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

test("no ping-pong: once its building is topped up, the auto-repair Mender settles instead of oscillating", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const r = makeBuilding("reactor", "player", 600, 500); s.buildings.set(r.id, r);   // power the grid
  const dmg = makeBuilding("turret", "player", 624, 500); dmg.hp = dmg.maxHp * 0.5;   // one worn building
  s.buildings.set(dmg.id, dmg);
  const m = makeUnit("mender", "player", 624, 500); m.autoRepair = true; s.units.set(m.id, m);

  for (let i = 0; i < 500; i++) tick(s, 0.1);                 // let it heal the turret up (50s at ~6 hp/s)
  assert.ok(dmg.hp >= dmg.maxHp * 0.98, "the worn building got healed");

  // Now watch the drone: with hysteresis it should PARK by its building, not roam off and back as
  // the tiny decay re-nicks the full hull.
  let maxDrift = 0;
  for (let i = 0; i < 400; i++) { tick(s, 0.1); maxDrift = Math.max(maxDrift, Math.hypot(m.x - dmg.x, m.y - dmg.y)); }
  assert.ok(maxDrift < 60, `the mender settles by its building rather than ping-ponging (drift ${maxDrift.toFixed(0)})`);
});

test("priority: an auto-repair Mender goes to the MORE worn building first", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const light = makeBuilding("turret", "player", 500, 500); light.hp = light.maxHp * 0.7;   // lightly worn, nearer
  const heavy = makeBuilding("turret", "player", 560, 500); heavy.hp = heavy.maxHp * 0.4;    // badly worn, a touch farther
  s.buildings.set(light.id, light); s.buildings.set(heavy.id, heavy);
  const m = makeUnit("mender", "player", 460, 500); m.autoRepair = true; s.units.set(m.id, m);
  for (let i = 0; i < 5; i++) tick(s, 0.1);
  assert.equal(m.repairTargetId, heavy.id, "it commits to the worst-off building, not the nearest");
});

test("auto-repair Menders spread out — one per building, not all on the worst", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const walls = [];
  for (let i = 0; i < 3; i++) {
    const w = makeBuilding("turret", "player", 500 + i * 120, 300);
    w.hp = w.maxHp * (0.4 + i * 0.05);   // all worn (0.40, 0.45, 0.50) — the same nearest-ish cluster
    s.buildings.set(w.id, w); walls.push(w);
  }
  const menders = [];
  for (let i = 0; i < 3; i++) { const m = makeUnit("mender", "player", 500 + i * 120, 360); m.autoRepair = true; s.units.set(m.id, m); menders.push(m); }

  for (let i = 0; i < 3; i++) tick(s, 0.1);   // let them pick targets
  const targets = menders.map(m => m.repairTargetId);
  assert.equal(new Set(targets).size, 3, `each Mender committed to a different building (${targets.join(",")})`);
  assert.ok(targets.every(Boolean), "…and none is left idle while a building needs work");
});

test("with fewer worn buildings than Menders, the extra one doesn't pile on (one-per-building cap)", () => {
  const s = createGameState({ planetId: "ferros", endless: true });
  const only = makeBuilding("turret", "player", 600, 300); only.hp = only.maxHp * 0.4;
  s.buildings.set(only.id, only);
  const m1 = makeUnit("mender", "player", 600, 360); m1.autoRepair = true; s.units.set(m1.id, m1);
  const m2 = makeUnit("mender", "player", 620, 360); m2.autoRepair = true; s.units.set(m2.id, m2);
  for (let i = 0; i < 3; i++) tick(s, 0.1);
  const on = [m1, m2].filter(m => m.repairTargetId === only.id).length;
  assert.equal(on, 1, "exactly one Mender claims the lone worn building; the other doesn't dogpile it");
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
