import { test } from "node:test";
import assert from "node:assert/strict";
import { createFog, updateFog } from "../engine/fog.js";
import { makeUnit, makeBuilding } from "../engine/state.js";
import { drawBuildings } from "../renderBuildings.js";

// A stub 2D context that no-ops any method the drawing code happens to call, instead of
// hand-enumerating the canvas API — keeps this test robust to unrelated rendering changes.
function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}

// Regression test for the crash where renderBuildings.js called drawEnemyPip without
// importing it (drawEnemyPip was a private, non-exported function in renderUnits.js):
// drawing so much as one AI-owned, fog-visible building threw a ReferenceError and,
// because engine/loop.js had no try/catch around render(), permanently killed the loop.
test("drawBuildings does not throw on a fog-visible enemy building", () => {
  const map = { width: 800, height: 600 };
  const fog = createFog(map);
  // A player unit standing right on top of the enemy building's spot so the player's
  // fog actually reveals it (drawBuildings gates non-player buildings on state.fog).
  const scout = makeUnit("worker", "player", 400, 300);
  updateFog({ map, units: new Map([[scout.id, scout]]), buildings: new Map() }, fog, "player");

  const enemyBuilding = makeBuilding("command", "ai", 400, 300);
  const state = {
    buildings: new Map([[enemyBuilding.id, enemyBuilding]]),
    units: new Map(),
    selection: [],
    fog,
    players: { player: { color: "#5ec8ff" }, ai: { color: "#ff5e5e" } },
  };

  assert.doesNotThrow(() => drawBuildings(fakeCtx(), state, null));
});
