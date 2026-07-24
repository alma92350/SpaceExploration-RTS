import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";
import { BUILDINGS } from "../engine/entities.js";
import { drawBuildGhost } from "../renderEffects.js";

// A stub 2D context that no-ops any method the drawing code happens to call, instead of
// hand-enumerating the canvas API — keeps this test robust to unrelated rendering changes.
// measureText needs a real-shaped return (drawRigSurveyCue reads .width off it).
function fakeCtx() {
  return new Proxy({}, {
    get: (t, p) => (p in t ? t[p] : (p === "measureText" ? () => ({ width: 10 }) : () => {})),
  });
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
