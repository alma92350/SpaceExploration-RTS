import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { drawBuildGhost, drawEffects, TRACER_STYLE } from "../renderEffects.js";
import { addTracer, addUnderAttackPing, addDeathFlash, activeEffects, activePings, resetEffects, DEATH_BASE_RADIUS } from "../effects.js";

// A stub 2D context that no-ops any method the drawing code happens to call, instead of
// hand-enumerating the canvas API — keeps this test robust to unrelated rendering changes.
// measureText needs a real-shaped return (drawRigSurveyCue reads .width off it).
function fakeCtx() {
  return new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : (p === "measureText" ? () => ({ width: 10 }) : () => {})),
  });
}

// Like fakeCtx, but also RECORDS every lineWidth/strokeStyle/fillStyle assignment — so a test can
// tell two draws apart by what they actually set, without hand-enumerating the whole canvas API
// or asserting on exact pixel output. Used by the counter-triangle bonus-hit tests below: the
// concrete shape/color a tracer draws in is an implementation detail (and changes again once
// TRACER_STYLE lands), but "a bonus hit draws thicker, in a different color, than the same unit
// type's plain hit" is a stable, implementation-agnostic claim.
function recordingCtx() {
  const target = { lineWidth: 1, strokeStyle: "", fillStyle: "" };
  const widths = [], colors = [];
  const ctx = new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : (p === "measureText" ? () => ({ width: 10 }) : () => {})),
    set: (t, p, v) => {
      t[p] = v;
      if (p === "lineWidth") widths.push(v);
      if (p === "strokeStyle" || p === "fillStyle") colors.push(v);
      return true;
    },
  });
  return { ctx, maxLineWidth: () => Math.max(0, ...widths), colors: () => colors.slice() };
}

// Like fakeCtx, but records every ctx.arc(x, y, radius, ...) call's radius — lets a test assert
// the exact radius an impact ring was drawn at (the Colossus splash ring, below), not just "some
// extra drawing happened".
function arcRecordingCtx() {
  const radii = [];
  const ctx = new Proxy({ lineWidth: 1, strokeStyle: "", fillStyle: "" }, {
    get: (t, p) => {
      if (p === "arc") return (x, y, r) => radii.push(r);
      return p in t ? t[p] : (p === "measureText" ? () => ({ width: 10 }) : () => {});
    },
    set: (t, p, v) => { t[p] = v; return true; },
  });
  return { ctx, radii: () => radii.slice() };
}

// Regression test for a live, reported bug: renderBuildings.js's POWER_TIER_COLOR and
// drawReactorBands were never exported (a leftover from the render.js god-file split —
// see git history around "Split render.js god file into cohesive render modules"), but
// renderEffects.js's drawGhostPowerCue referenced both anyway. The moment a player armed
// build mode for ANY power-consuming building (a factory, the Plasma Rig, or the Antimatter
// Gate), every single frame's render() threw a ReferenceError while the ghost followed the
// cursor — caught by loop.js's try/catch (so the loop itself didn't die), but re-thrown on
// literally every frame for as long as build mode stayed armed, which is what made the game
// look and feel completely frozen. Covers every building type that would have triggered it.
test("drawBuildGhost does not throw for any recipe/rig/wonder building (the power-cue ghost)", () => {
  const state = createGameState({ planetId: "ferros", seed: 1, rng: mulberry32(1) });
  const ctx = fakeCtx();

  const triggeringTypes = Object.entries(BUILDINGS)
    .filter(([, def]) => def.recipe || def.rig || def.wonder)
    .map(([type]) => type);
  assert.ok(triggeringTypes.length > 0, "sanity check: at least one building type exercises the power cue");

  for (const buildingType of triggeringTypes) {
    const ghost = { buildingType, x: state.map.width / 2, y: state.map.height / 2 };
    assert.doesNotThrow(
      () => drawBuildGhost(ctx, state, ghost),
      `drawBuildGhost threw while placing a ${buildingType}`
    );
  }
});

// A Reactor nearby exercises the OTHER half of drawGhostPowerCue — the branch that draws the
// connector line + reactor bands to the nearest power source, which is exactly where
// drawReactorBands(POWER_TIER_COLOR) is actually called (the plain "no source nearby" case
// above never reaches that line).
test("drawBuildGhost does not throw when a nearby Reactor is in range of the ghost", () => {
  const state = createGameState({ planetId: "ferros", seed: 1, rng: mulberry32(1) });
  const reactor = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "reactor")
    || { owner: "player", type: "reactor", x: state.map.width / 2, y: state.map.height / 2, constructing: false, id: "test-reactor" };
  state.buildings.set(reactor.id, reactor);

  const ghost = { buildingType: "smelter", x: reactor.x + 50, y: reactor.y };
  assert.doesNotThrow(() => drawBuildGhost(fakeCtx(), state, ghost));
});

// Counter-triangle readability (docs/improvement-proposals.md "Counter-triangle telegraphs"):
// a bonus hit (engine/combat.js's attackHit `bonus` flag, plumbed through effects.js's
// addTracer) must render "hotter and thicker" than the same unit type's plain hit.
test("a counter-triangle bonus hit renders its tracer thicker than the same unit type's plain hit", () => {
  resetEffects();
  const plain = recordingCtx();
  addTracer(0, 0, 100, 0, "skiff", false);
  drawEffects(plain.ctx);

  resetEffects();
  const bonus = recordingCtx();
  addTracer(0, 0, 100, 0, "skiff", true);
  drawEffects(bonus.ctx);

  assert.ok(bonus.maxLineWidth() > plain.maxLineWidth(),
    `expected a bonus hit to draw a thicker line (plain=${plain.maxLineWidth()}, bonus=${bonus.maxLineWidth()})`);
});

test("a counter-triangle bonus hit renders in a different (hotter) color than the same unit type's plain hit", () => {
  resetEffects();
  const plain = recordingCtx();
  addTracer(0, 0, 100, 0, "skiff", false);
  drawEffects(plain.ctx);

  resetEffects();
  const bonus = recordingCtx();
  addTracer(0, 0, 100, 0, "skiff", true);
  drawEffects(bonus.ctx);

  assert.notDeepEqual(bonus.colors(), plain.colors(),
    "a bonus hit must use at least one different stroke/fill color along the way (impact flash included)");
});

// addTracer's `bonus` argument defaults falsy, so every pre-existing call site (and every event
// that never sets the flag) keeps drawing the plain, un-bonused look — this proposal must not
// retroactively brighten every tracer in the game.
test("a tracer with no bonus argument at all renders exactly like an explicit bonus:false one", () => {
  resetEffects();
  const omitted = recordingCtx();
  addTracer(0, 0, 100, 0, "skiff");
  drawEffects(omitted.ctx);

  resetEffects();
  const explicit = recordingCtx();
  addTracer(0, 0, 100, 0, "skiff", false);
  drawEffects(explicit.ctx);

  assert.equal(omitted.maxLineWidth(), explicit.maxLineWidth());
  assert.deepEqual(omitted.colors(), explicit.colors());
});

/* ---------------------------------------------------------------------------------------------
   Per-weapon fire signatures (docs/improvement-proposals.md "Per-weapon fire signatures for the
   counter-triangle"): TRACER_STYLE replaces the old two-case tracerColor() special-case (only
   bastion/lancer were colored; skiff, breacher, turret, dreadnought, wraith and colossus all fell
   to the same hostile-red default, including the player's OWN units). Every unit/building type
   that can actually fire (UNITS[].attack or BUILDINGS[].attack truthy) must own a real entry, not
   silently fall through to `default`.
   --------------------------------------------------------------------------------------------- */

// Every armed type in the roster today, by the same test combat.js's attackHit event actually
// uses for its `unitType` field (a unit's own `attack` stat, or a static-defense building's —
// engine/combat.js's comment: "a turret reads as its own 'turret' type").
const ARMED_TYPES = [
  ...Object.values(UNITS).filter(u => u.attack).map(u => u.id),
  ...Object.values(BUILDINGS).filter(b => b.attack).map(b => b.id),
];

test("every armed unit/building type owns its own TRACER_STYLE entry, not the shared default", () => {
  assert.ok(ARMED_TYPES.length > 0, "sanity: at least one armed type exists to check");
  for (const type of ARMED_TYPES) {
    assert.ok(TRACER_STYLE[type], `expected TRACER_STYLE.${type} to exist (armed types must not fall to the anonymous default)`);
  }
});

test("the Skiff/Bastion/Lancer counter-triangle each render in a distinct color — the whole point of the readability fix", () => {
  const { skiff, bastion, lancer } = TRACER_STYLE;
  assert.notEqual(skiff.color, bastion.color);
  assert.notEqual(bastion.color, lancer.color);
  assert.notEqual(skiff.color, lancer.color);
});

test("a turret (static defense) renders in its own hue, distinct from every mobile hull's color", () => {
  const mobileColors = new Set(Object.values(UNITS).filter(u => u.attack).map(u => TRACER_STYLE[u.id]?.color));
  assert.ok(!mobileColors.has(TRACER_STYLE.turret.color), "the turret's hue must not collide with any mobile unit's");
});

test("TRACER_STYLE's fallback `default` entry is not the old hostile-red — a gap here should read as unclassified, not enemy", () => {
  assert.notEqual(TRACER_STYLE.default.color, "#f87171", "the old hostile-red default must not survive as the new fallback color");
});

// One fresh tracer per armed type, both with and without the counter-triangle bonus flag, drawn
// immediately (age≈0, so this also exercises the new muzzle-flash branch) — regression coverage
// against a crash in any per-shape branch (dart/bolt/beam/arc/default) for any real roster type.
test("drawEffects does not throw for any armed type's tracer, bonus or plain, freshly fired", () => {
  for (const type of ARMED_TYPES) {
    for (const bonus of [false, true]) {
      resetEffects();
      addTracer(100, 100, 260, 180, type, bonus);
      assert.doesNotThrow(() => drawEffects(fakeCtx()), `drawEffects threw for ${type} (bonus=${bonus})`);
    }
  }
});

// Same roster, but drawn well past the muzzle-flash window (age >= 0.3 of the 120ms tracer
// lifetime) — proves the "no muzzle flash past this point" branch is equally crash-free, which
// the immediate (age≈0) test above can't reach on its own.
test("drawEffects does not throw once a tracer has aged past its muzzle-flash window", async () => {
  for (const type of ARMED_TYPES) {
    resetEffects();
    addTracer(100, 100, 260, 180, type, true);
    await new Promise(r => setTimeout(r, 45));   // > 0.3 * TRACER_LIFETIME_MS (120ms) — flash is long gone, tracer still fading
    assert.doesNotThrow(() => drawEffects(fakeCtx()), `drawEffects threw for an aged ${type} tracer`);
  }
});

/* ---------------------------------------------------------------------------------------------
   Colossus splash impact ring (docs/improvement-proposals.md "Colossus splash: def-driven area
   damage as the T3 anti-mass verb"): engine/combat.js's attackHit event carries a new, purely
   additive `splashRadius` field for a splash hit — plumbed through effects.js's addTracer (same
   pattern the counter-triangle `bonus` flag already established) so renderEffects.js can draw an
   impact ring at the true blast radius, distinct from the plain single-target impact spark every
   tracer already draws.
   --------------------------------------------------------------------------------------------- */

test("a splash hit draws an impact ring at the exact splash radius, on top of the plain impact spark", () => {
  resetEffects();
  const rec = arcRecordingCtx();
  addTracer(0, 0, 100, 0, "colossus", false, 26);

  drawEffects(rec.ctx);

  assert.ok(rec.radii().includes(26), `expected a drawn arc at radius 26 (the splash ring), got radii ${JSON.stringify(rec.radii())}`);
});

test("a plain tracer with no splashRadius argument draws no impact ring at all", () => {
  resetEffects();
  const rec = arcRecordingCtx();
  addTracer(0, 0, 100, 0, "colossus");   // splashRadius omitted — must default to "no ring"

  drawEffects(rec.ctx);

  // Every OTHER arc this tracer draws (the impact spark, the muzzle flash's polygon uses
  // lineTo/moveTo not arc) is small and fixed — nothing here should draw at a splash-sized radius.
  assert.ok(!rec.radii().some(r => r >= 20), `expected no large-radius ring, got radii ${JSON.stringify(rec.radii())}`);
});

test("splashRadius:0 (an explicit falsy value) also draws no impact ring, same as omitting it", () => {
  resetEffects();
  const rec = arcRecordingCtx();
  addTracer(0, 0, 100, 0, "colossus", false, 0);

  drawEffects(rec.ctx);

  assert.ok(!rec.radii().some(r => r >= 20), `expected no large-radius ring, got radii ${JSON.stringify(rec.radii())}`);
});

test("drawEffects does not throw for a splash-carrying tracer, freshly fired or aged past the muzzle-flash window", async () => {
  resetEffects();
  addTracer(100, 100, 260, 180, "colossus", true, 26);
  assert.doesNotThrow(() => drawEffects(fakeCtx()), "drawEffects threw for a fresh splash tracer");

  resetEffects();
  addTracer(100, 100, 260, 180, "colossus", false, 26);
  await new Promise(r => setTimeout(r, 45));
  assert.doesNotThrow(() => drawEffects(fakeCtx()), "drawEffects threw for an aged splash tracer");
});

/* ---------------------------------------------------------------------------------------------
   Attack pings on the minimap (docs/improvement-proposals.md "Attack pings on the minimap plus a
   jump-to-last-alert key"): activePings() is the minimap's own read of the same pings
   addUnderAttackPing already feeds the world-space ping above (drawEffects' `pings` handling),
   but kept alive far longer (MINIMAP_PING_LIFETIME_MS, not the short PING_LIFETIME_MS the
   world-space ping fades on) so a raid on a distant flank is still findable on the minimap long
   after the on-screen banner + world-space ping have both faded.
   --------------------------------------------------------------------------------------------- */

test("activePings returns every live under-attack ping, each with a fresh (near-zero) age", () => {
  resetEffects();
  addUnderAttackPing(400, 900);
  addUnderAttackPing(1200, 300);

  const pings = activePings();

  assert.equal(pings.length, 2);
  assert.deepEqual(pings.map(p => ({ x: p.x, y: p.y })), [{ x: 400, y: 900 }, { x: 1200, y: 300 }],
    "positions are carried through unchanged, in the order they were pinged");
  for (const p of pings) assert.ok(p.age >= 0 && p.age < 0.01, `a freshly-added ping's age should read ~0, got ${p.age}`);
});

test("activePings is empty with nothing pinged, and resetEffects clears an earlier ping from it", () => {
  resetEffects();
  assert.deepEqual(activePings(), []);

  addUnderAttackPing(0, 0);
  assert.equal(activePings().length, 1);

  resetEffects();
  assert.deepEqual(activePings(), [], "resetEffects must clear pings the minimap would otherwise keep showing");
});

test("activePings still reports a ping as alive well past the world-space ping's own (much shorter) PING_LIFETIME_MS", async () => {
  resetEffects();
  addUnderAttackPing(50, 60);
  await new Promise(r => setTimeout(r, 60));   // real ms elapsed — tiny next to either lifetime, but enough to prove it isn't pruned early
  const pings = activePings();
  assert.equal(pings.length, 1, "a ping barely 60ms old must still be alive for the minimap, same as for the world-space ping");
  assert.ok(pings[0].age > 0, "age should have advanced off exactly zero");
});

/* ---------------------------------------------------------------------------------------------
   Tiered destruction (docs/improvement-proposals.md "Tiered destruction: deaths scale with what
   died"): addDeathFlash now carries the killed entity's own radius + kind, so the death ring's
   size/lifetime, a big hull's debris shards, and a building's slower double-ring collapse all
   scale off what actually died instead of drawing every death identically.
   --------------------------------------------------------------------------------------------- */

test("addDeathFlash defaults to a small-hull radius and unit kind for a bare (x, y) call — back-compat with any pre-existing call site", () => {
  resetEffects();
  addDeathFlash(10, 20);
  const { deaths } = activeEffects();
  assert.equal(deaths.length, 1);
  assert.equal(deaths[0].radius, DEATH_BASE_RADIUS);
  assert.equal(deaths[0].kind, "unit");
});

test("a bigger hull's death ring draws at a larger radius than a smaller hull's, at the same age", () => {
  resetEffects();
  const small = arcRecordingCtx();
  addDeathFlash(0, 0, 6, "unit");
  drawEffects(small.ctx);

  resetEffects();
  const big = arcRecordingCtx();
  addDeathFlash(0, 0, 20, "unit");
  drawEffects(big.ctx);

  assert.ok(Math.max(...big.radii()) > Math.max(...small.radii()),
    `expected the radius-20 death to draw a bigger ring than the radius-6 one (small=${small.radii()}, big=${big.radii()})`);
});

test("a building-kind death draws a second (inner) ring on top of the outer one — a unit-kind death of the same radius draws only one", () => {
  resetEffects();
  const unitDeath = arcRecordingCtx();
  addDeathFlash(0, 0, 8, "unit");
  drawEffects(unitDeath.ctx);

  resetEffects();
  const buildingDeath = arcRecordingCtx();
  addDeathFlash(0, 0, 8, "building");
  drawEffects(buildingDeath.ctx);

  assert.ok(buildingDeath.radii().length > unitDeath.radii().length,
    "the building's collapse draws strictly more ring arcs than the equivalent unit death");
});

test("a hull at or above the debris threshold (radius 10) also flings outward shards; a smaller hull does not", () => {
  resetEffects();
  const small = arcRecordingCtx();
  addDeathFlash(0, 0, 6, "unit");   // below the debris threshold
  drawEffects(small.ctx);

  resetEffects();
  const big = arcRecordingCtx();
  addDeathFlash(0, 0, 12, "unit");   // a Dreadnought/Colossus-scale hull, above it
  drawEffects(big.ctx);

  assert.ok(big.radii().length > small.radii().length,
    "the big hull's death draws extra debris-shard arcs the small hull's doesn't");
});

test("drawEffects does not throw across a death's whole lifetime, for a unit or a building", () => {
  resetEffects();
  addDeathFlash(50, 60, 14, "unit");
  addDeathFlash(80, 90, 22, "building");
  assert.doesNotThrow(() => drawEffects(fakeCtx()), "drawEffects threw for a fresh tiered death");
});

test("a building-kind death lingers longer than a same-radius unit-kind one — the slower collapse gets more time", async () => {
  resetEffects();
  addDeathFlash(0, 0, DEATH_BASE_RADIUS, "unit");
  addDeathFlash(100, 100, DEATH_BASE_RADIUS, "building");

  await new Promise(r => setTimeout(r, 320));   // past the unit's base ~280ms lifetime, short of the building's longer one

  const { deaths } = activeEffects();
  assert.equal(deaths.length, 1, `expected only the building's death to still be alive, got ${JSON.stringify(deaths)}`);
  assert.equal(deaths[0].kind, "building");
});
