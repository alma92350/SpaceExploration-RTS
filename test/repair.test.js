import { test } from "node:test";
import assert from "node:assert/strict";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { updateRepair, updateBulwarkRegen } from "../engine/repair.js";
import { UNITS, UPGRADES } from "../engine/entities.js";

// updateRepair reads only state.units, state.buildings and (optionally) the
// per-tick unitGrid. A bare state with two Maps is all it needs — the grid is
// absent here, so it exercises the full-scan fallback the direct tests use.
function stub() {
  return { units: new Map(), buildings: new Map() };
}
const addU = (s, u) => (s.units.set(u.id, u), u);
const addB = (s, b) => (s.buildings.set(b.id, b), b);
const RATE = UNITS.mender.repairRate;

// updateBulwarkRegen additionally reads state.time and state.players[owner].upgrades — a minimal
// stub with just those, mirroring stub() above's "only what the function under test reads" idiom.
function bulwarkStub(time, upgrades) {
  return { units: new Map(), buildings: new Map(), time, players: { player: { upgrades } } };
}

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

/* ============================================================
   Bulwark doctrine regen (docs/improvement-proposals.md, merged doctrine-depth redesign):
   updateBulwarkRegen is a SEPARATE pass from the Mender's updateRepair above — doctrine-gated,
   army-only (role:"combat" units, not buildings), and reads state.time - unit.lastHitAt (stamped
   in engine/combat.js) instead of proximity to a healer.

   THE RECONCILIATION: proposal 1's Bulwark Tier-2 and proposal 2's Bulwark Tier-3 capstone both
   independently described "out-of-combat hp regen" as Bulwark's identity. These tests prove it's
   ONE mechanic, not two: reinforcedBulwark (Tier 2) grants the verb; selfSealingPlating (Tier 3)
   deepens it (faster rate, shorter delay) rather than restating it — a Tier-2-only army and a
   Tier-2+3 army must measurably differ, and BOTH must still be suppressed during active combat.
   ============================================================ */

test("Reinforced Bulwark (Tier 2) heals a role:'combat' unit once it's gone regenDelay seconds without a hit", () => {
  const { regenRate, regenDelay } = UPGRADES.reinforcedBulwark;
  const s = bulwarkStub(100, { reinforcedBulwark: true });
  const u = addU(s, makeUnit("bastion", "player", 0, 0));
  u.hp = 50;
  u.lastHitAt = 100 - regenDelay - 1;   // just past the delay

  updateBulwarkRegen(s, 1);

  assert.ok(Math.abs(u.hp - (50 + regenRate)) < 1e-9, "healed at Tier 2's regenRate for the 1s tick");
});

test("...but grants nothing before the out-of-combat delay has elapsed", () => {
  const { regenDelay } = UPGRADES.reinforcedBulwark;
  const s = bulwarkStub(100, { reinforcedBulwark: true });
  const u = addU(s, makeUnit("bastion", "player", 0, 0));
  u.hp = 50;
  u.lastHitAt = 100 - regenDelay + 1;   // just short of the delay

  updateBulwarkRegen(s, 1);

  assert.equal(u.hp, 50, "still inside the delay window — no heal yet");
});

test("Bulwark regen never applies without either upgrade researched, however long it's been unhit", () => {
  const s = bulwarkStub(1000, {});
  const u = addU(s, makeUnit("bastion", "player", 0, 0));
  u.hp = 50;
  u.lastHitAt = 0;

  updateBulwarkRegen(s, 5);

  assert.equal(u.hp, 50, "no Bulwark upgrade -> no regen, regardless of state.time");
});

test("Bulwark regen only heals role:'combat' units — not a worker, a Mender, or a building", () => {
  const s = bulwarkStub(1000, { reinforcedBulwark: true });
  const worker = addU(s, makeUnit("worker", "player", 0, 0));
  const mender = addU(s, makeUnit("mender", "player", 0, 0));
  const building = addB(s, makeBuilding("turret", "player", 0, 0));
  worker.hp = 10; mender.hp = 10; building.hp = 10;
  worker.lastHitAt = 0; mender.lastHitAt = 0; building.lastHitAt = 0;

  updateBulwarkRegen(s, 5);

  assert.equal(worker.hp, 10, "a worker doesn't regen — this is the army verb, not an economy one");
  assert.equal(mender.hp, 10, "the support Mender doesn't regen either");
  assert.equal(building.hp, 10, "buildings are untouched — Bulwark's regen is an army verb, not a base one (unlike its damageTakenMult)");
});

test("Bulwark regen clamps at maxHp, like every other heal in the game", () => {
  const { regenRate } = UPGRADES.reinforcedBulwark;
  const s = bulwarkStub(1000, { reinforcedBulwark: true });
  const u = addU(s, makeUnit("bastion", "player", 0, 0));
  u.hp = u.maxHp - regenRate / 2;
  u.lastHitAt = 0;

  updateBulwarkRegen(s, 1);

  assert.equal(u.hp, u.maxHp, "never over-heals past max");
});

test("RECONCILIATION: past Tier-3's shortened delay but still inside Tier-2's, only the Tier-2+capstone owner regens", () => {
  const t2 = UPGRADES.reinforcedBulwark, t3 = UPGRADES.selfSealingPlating;
  assert.ok(t3.regenDelay < t2.regenDelay, "sanity: the capstone really does shorten the window");
  const elapsed = (t2.regenDelay + t3.regenDelay) / 2;   // strictly between the two delays

  const tier2Only = bulwarkStub(1000, { reinforcedBulwark: true });
  const u2 = addU(tier2Only, makeUnit("bastion", "player", 0, 0));
  u2.hp = 50; u2.lastHitAt = 1000 - elapsed;

  const tier2Plus3 = bulwarkStub(1000, { reinforcedBulwark: true, selfSealingPlating: true });
  const u3 = addU(tier2Plus3, makeUnit("bastion", "player", 0, 0));
  u3.hp = 50; u3.lastHitAt = 1000 - elapsed;

  updateBulwarkRegen(tier2Only, 1);
  updateBulwarkRegen(tier2Plus3, 1);

  assert.equal(u2.hp, 50, "Tier-2 alone: still inside its own (longer) delay — no heal yet");
  assert.ok(u3.hp > 50, "Tier-2+capstone: past the capstone's shortened delay — already healing");
});

test("RECONCILIATION: once both are past their own delay, the capstone heals strictly faster than Tier 2 alone", () => {
  const t2 = UPGRADES.reinforcedBulwark, t3 = UPGRADES.selfSealingPlating;
  assert.ok(t3.regenRate > t2.regenRate, "sanity: the capstone really does raise the rate");

  const tier2Only = bulwarkStub(1000, { reinforcedBulwark: true });
  const u2 = addU(tier2Only, makeUnit("bastion", "player", 0, 0));
  u2.hp = 50; u2.lastHitAt = 0;   // long out of combat either way

  const tier2Plus3 = bulwarkStub(1000, { reinforcedBulwark: true, selfSealingPlating: true });
  const u3 = addU(tier2Plus3, makeUnit("bastion", "player", 0, 0));
  u3.hp = 50; u3.lastHitAt = 0;

  updateBulwarkRegen(tier2Only, 1);
  updateBulwarkRegen(tier2Plus3, 1);

  assert.ok(Math.abs(u2.hp - (50 + t2.regenRate)) < 1e-9, "Tier 2 alone heals at its own rate");
  assert.ok(Math.abs(u3.hp - (50 + t3.regenRate)) < 1e-9, "Tier 2+3 heals at the capstone's (higher) rate, not both added together");
  assert.ok(u3.hp > u2.hp, "the fully-committed Bulwark player heals more per second than Tier-2 alone");
});

test("regen is genuinely suppressed during ACTIVE combat at both tiers — a unit whose lastHitAt keeps getting refreshed never benefits", () => {
  // Mirrors the real per-tick order (engine/sim.js tick()): combat stamps lastHitAt, THEN the
  // regen pass runs, THEN state.time advances — same order this loop replays by hand.
  function simulateContinuousFire(upgrades) {
    const s = bulwarkStub(0, upgrades);
    const u = addU(s, makeUnit("bastion", "player", 0, 0));
    u.hp = 50;
    const dt = 0.5;
    for (let i = 0; i < 200; i++) {
      s.time += dt;
      u.lastHitAt = s.time;         // a hit lands THIS tick, every tick — continuous fire
      updateBulwarkRegen(s, dt);
    }
    return u.hp;
  }

  assert.equal(simulateContinuousFire({ reinforcedBulwark: true }), 50,
    "Tier 2 alone: a continuously-hit unit never regens a single hp — balance.test.js's duels depend on this");
  assert.equal(simulateContinuousFire({ reinforcedBulwark: true, selfSealingPlating: true }), 50,
    "Tier 2+3: the shortened delay is still a REAL delay — continuous fire suppresses it too, not just a smaller number");
});
