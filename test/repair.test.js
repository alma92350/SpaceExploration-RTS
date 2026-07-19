import { test } from "node:test";
import assert from "node:assert/strict";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { updateRepair } from "../engine/repair.js";
import { UNITS } from "../engine/entities.js";

// updateRepair reads only state.units, state.buildings and (optionally) the
// per-tick unitGrid. A bare state with two Maps is all it needs — the grid is
// absent here, so it exercises the full-scan fallback the direct tests use.
function stub() {
  return { units: new Map(), buildings: new Map() };
}
const addU = (s, u) => (s.units.set(u.id, u), u);
const addB = (s, b) => (s.buildings.set(b.id, b), b);
const RATE = UNITS.mender.repairRate;

test("a Mender heals a damaged friendly unit in range, and never past its max", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", 0, 0));
  const hurt = addU(s, makeUnit("skiff", "player", 40, 0));   // 40 < repairRange 110
  hurt.hp = 20;
  updateRepair(s, 1);
  assert.equal(hurt.hp, 20 + RATE, "one second of repair adds repairRate hp");

  hurt.hp = hurt.maxHp - 1;   // now just short of full
  updateRepair(s, 1);
  assert.equal(hurt.hp, hurt.maxHp, "healing clamps at maxHp — it never over-heals");
});

test("a Mender never heals itself — it can't self-sustain", () => {
  const s = stub();
  const mender = addU(s, makeUnit("mender", "player", 0, 0));
  mender.hp = 10;
  updateRepair(s, 1);
  assert.equal(mender.hp, 10, "a lone Mender stays hurt; it's a fragile, escort-me asset by design");
});

test("a Mender heals only friendlies — an enemy in range is left to bleed", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", 0, 0));
  const foe = addU(s, makeUnit("skiff", "ai", 30, 0));
  foe.hp = 20;
  updateRepair(s, 1);
  assert.equal(foe.hp, 20, "the enemy gets nothing");
});

test("a unit outside repairRange gets nothing", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", 0, 0));
  const far = addU(s, makeUnit("skiff", "player", 500, 0));   // 500 >> 110
  far.hp = 20;
  updateRepair(s, 1);
  assert.equal(far.hp, 20, "range is a hard cutoff — position the drone or it heals nothing");
});

test("a full-HP friendly is a no-op — no negative or phantom healing", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", 0, 0));
  const ok = addU(s, makeUnit("skiff", "player", 30, 0));
  updateRepair(s, 1);
  assert.equal(ok.hp, ok.maxHp, "an undamaged unit is untouched");
});

test("a Mender patches a damaged completed building, but not one still under construction", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", 0, 0));
  const done = addB(s, makeBuilding("turret", "player", 40, 0));
  done.hp = 100;
  const site = addB(s, makeBuilding("barracks", "player", 20, 20, { constructing: true }));
  site.hp = 30;
  updateRepair(s, 1);
  assert.equal(done.hp, 100 + RATE, "a finished building is mended like a unit");
  assert.equal(site.hp, 30, "a construction site is left to its builder — no battle damage to mend yet");
});

test("overlapping Menders heal additively and clamp identically — order-independent, so the deterministic replay holds", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", -10, 0));
  addU(s, makeUnit("mender", "player", 10, 0));
  const hurt = addU(s, makeUnit("bastion", "player", 0, 0));
  hurt.hp = 1;
  updateRepair(s, 1);
  assert.equal(hurt.hp, 1 + 2 * RATE, "both Menders' contributions stack");

  // Near the cap, both contributions clamp to exactly maxHp regardless of which
  // Mender the Map happens to iterate first — min(maxHp, ...) is order-free.
  hurt.hp = hurt.maxHp - 1;
  updateRepair(s, 1);
  assert.equal(hurt.hp, hurt.maxHp, "two Menders can't push a target past its max");
});

test("healing scales with dt so it's framerate-independent", () => {
  const s = stub();
  addU(s, makeUnit("mender", "player", 0, 0));
  const hurt = addU(s, makeUnit("bastion", "player", 30, 0));
  hurt.hp = 50;
  updateRepair(s, 0.5);
  assert.equal(hurt.hp, 50 + RATE * 0.5, "a half-step heals half as much");
});
