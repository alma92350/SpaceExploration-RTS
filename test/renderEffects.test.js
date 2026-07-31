import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";
import { drawBuildGhost, drawEffects, TRACER_STYLE } from "../renderEffects.js";
import { addTracer, resetEffects } from "../effects.js";

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
