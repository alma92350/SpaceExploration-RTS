import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit, makeBuilding } from "../engine/state.js";
import { mulberry32 } from "../engine/rng.js";

/* ============================================================
   Attack pings on the minimap (docs/improvement-proposals.md "Attack pings on the minimap plus a
   jump-to-last-alert key"): drawMinimap gains an optional trailing `pings` array (effects.js
   activePings(), threaded through by boot.js's render callback) and draws a pulsing alert ring at
   each live one, scaled into minimap space the same way every other marker on it already is —
   so a raid on a distant flank stays findable on the minimap long after the on-screen banner
   (and even the longer-lived world-space ping) have faded.

   minimap.js has no existing test file. drawMinimap's own ensureUnderlay() calls
   document.createElement("canvas") to build its cached offscreen underlay layer — unguarded
   (minimap.js is never imported under plain Node today), so a minimal document stub is needed
   before the first call. Same recording-Proxy idiom as test/renderEffects.test.js's fakeCtx/
   recordingCtx: tolerate any canvas-API call, but record what actually got drawn, rather than
   asserting on exact pixel output.
   ============================================================ */

function fakeCanvas() {
  return { width: 0, height: 0, getContext() { return fakeCtx(); } };
}
function fakeCtx() {
  return new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}) });
}
globalThis.document = { createElement: () => fakeCanvas() };

const { drawMinimap } = await import("../minimap.js");

// Records every ctx.arc(...) call (the ping ring's own draw primitive — every other minimap
// marker today uses fillRect/strokeRect, never arc, so a bare draw is a clean 0-arc baseline).
function recordingCtx() {
  const arcs = [];
  const target = {};
  const ctx = new Proxy(target, {
    get: (t, p) => (p === "arc" ? (...args) => arcs.push(args) : (p in t ? t[p] : () => {})),
  });
  return { ctx, arcs };
}

const VW = 800, VH = 600, MM_W = 200, MM_H = 125;

function freshState(seed) {
  return createGameState({ planetId: "ferros", seed, rng: mulberry32(seed) });
}

test("drawMinimap does not throw when called with no pings argument at all (backward compatible)", () => {
  const state = freshState(1);
  const camera = { x: state.map.width / 2, y: state.map.height / 2, zoom: 1 };
  assert.doesNotThrow(() => drawMinimap(recordingCtx().ctx, state, camera, VW, VH, MM_W, MM_H));
});

test("drawMinimap draws one ring arc per active under-attack ping, none with an empty pings array", () => {
  const state = freshState(2);
  const camera = { x: state.map.width / 2, y: state.map.height / 2, zoom: 1 };

  const bare = recordingCtx();
  drawMinimap(bare.ctx, state, camera, VW, VH, MM_W, MM_H, []);
  assert.equal(bare.arcs.length, 0, "no live pings -> no ring arcs drawn");

  const onePing = recordingCtx();
  drawMinimap(onePing.ctx, state, camera, VW, VH, MM_W, MM_H, [{ x: 500, y: 500, age: 0.1 }]);
  assert.equal(onePing.arcs.length, 1, "exactly one live ping -> exactly one ring arc");

  const twoPings = recordingCtx();
  drawMinimap(twoPings.ctx, state, camera, VW, VH, MM_W, MM_H, [{ x: 500, y: 500, age: 0.1 }, { x: 900, y: 200, age: 0.6 }]);
  assert.equal(twoPings.arcs.length, 2, "two live pings -> two ring arcs");
});

test("a ping ring is centered at the ping's world position scaled into minimap space, like every other marker", () => {
  const state = freshState(3);
  const camera = { x: state.map.width / 2, y: state.map.height / 2, zoom: 1 };
  const sx = MM_W / state.map.width, sy = MM_H / state.map.height;

  const { ctx, arcs } = recordingCtx();
  drawMinimap(ctx, state, camera, VW, VH, MM_W, MM_H, [{ x: 1234, y: 987, age: 0.2 }]);

  assert.equal(arcs.length, 1);
  const [cx, cy] = arcs[0];   // ctx.arc(x, y, radius, startAngle, endAngle)
  assert.ok(Math.abs(cx - 1234 * sx) < 1e-6, `expected the ring's x near ${1234 * sx}, got ${cx}`);
  assert.ok(Math.abs(cy - 987 * sy) < 1e-6, `expected the ring's y near ${987 * sy}, got ${cy}`);
});

test("a fully-aged (age=1) ping still draws without throwing — the fade-out boundary", () => {
  const state = freshState(4);
  const camera = { x: state.map.width / 2, y: state.map.height / 2, zoom: 1 };
  assert.doesNotThrow(() => drawMinimap(recordingCtx().ctx, state, camera, VW, VH, MM_W, MM_H, [{ x: 10, y: 10, age: 1 }]));
});

// Observer Mode (observer.js): a free-look spectator that reveals fog on whichever world it's
// pointed at. drawMinimap's trailing observerMode param (default false, so every test above is
// unaffected) bypasses every owner/fog gate below, same reasoning as render.js's drawFrame.
function fillRectRecorder() {
  const rects = [];
  const ctx = new Proxy({}, {
    get: (t, p) => (p === "fillRect" ? (...args) => rects.push(args) : (p in t ? t[p] : () => {})),
    set: (t, p, v) => { t[p] = v; return true; },
  });
  return { ctx, rects };
}

test("observerMode bypasses the fog gate for both units and buildings on the minimap", () => {
  const state = freshState(5);
  state.fog.visible.fill(0);   // guarantee nothing is currently visible, regardless of any start-base reveal

  const enemyUnit = makeUnit("skiff", "ai", state.map.width - 50, state.map.height - 50);
  const enemyBuilding = makeBuilding("command", "ai", state.map.width - 100, state.map.height - 100);
  state.units.set(enemyUnit.id, enemyUnit);
  state.buildings.set(enemyBuilding.id, enemyBuilding);
  const camera = { x: state.map.width / 2, y: state.map.height / 2, zoom: 1 };

  const hidden = fillRectRecorder();
  drawMinimap(hidden.ctx, state, camera, VW, VH, MM_W, MM_H);

  const revealed = fillRectRecorder();
  drawMinimap(revealed.ctx, state, camera, VW, VH, MM_W, MM_H, [], true);

  assert.ok(revealed.rects.length > hidden.rects.length,
    "observerMode draws at least the enemy unit + building the fogged pass skipped");
});
