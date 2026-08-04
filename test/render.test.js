import { test } from "node:test";
import assert from "node:assert/strict";
import { createFog, updateFog, FOG_CELL_SIZE } from "../engine/fog.js";
import { makeUnit } from "../engine/state.js";

/* ============================================================
   Stop per-cell fog/terrain fills in the main view (docs/improvement-proposals.md lines
   843-851): render.js's drawFogBase and drawTerrain used to issue one fillRect per cell, per
   frame — up to 16,000 fog cells scanned/filled at 60Hz on a fully-zoomed-out Gigantic map
   (camera.js's minZoomFor lets the whole map fit on screen at once), plus the same again for
   40px terrain cells.

   (a) Terrain is immutable per map (engine/map.js's own header), so it's now pre-rendered ONCE
   per map into an offscreen canvas at CELL resolution (one canvas pixel per cell) and blitted
   with a single drawImage per frame — minimap.js's own underlayMap cache idiom (see its header
   comment for the identical "16k+ fillRects" pathology), mirrored here and keyed the same way,
   on state.map identity.
   (b) The fog wash (explored-but-not-visible) is genuinely dynamic — it can't be cached
   wholesale — so instead drawFogBase now merges each row's contiguous run of qualifying cells
   into a single fillRect span, since fog is spatially coherent (most rows are long uniform
   runs), collapsing thousands of per-cell rects into a handful of per-row spans.

   Same recording-Proxy idiom as test/renderNodes.test.js / test/minimap.test.js: any canvas
   method/property call is tolerated (no hand-enumerated canvas API), but every call and
   property assignment is recorded so a test can reconstruct exactly what got drawn (which
   rects, which colors) without asserting on real pixel output. render.js is never imported
   under plain Node otherwise, so `document` needs a stub before first use — same as
   minimap.test.js's own ensureUnderlay() dependency on document.createElement("canvas").
   ============================================================ */

function recordingCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(t, prop) {
      if (prop === "calls") return calls;
      return (...args) => { calls.push({ fn: prop, args }); };
    },
    set(t, prop, value) { calls.push({ set: prop, value }); return true; },
  });
  return ctx;
}

// document.createElement("canvas") stub. `canvases` accumulates every offscreen canvas
// render.js's terrain cache creates, so a test can assert exactly how many times the
// (relatively expensive, once-per-map) pre-render actually ran — cleared per-test via
// `doc.canvases.length = 0` rather than reassigning globalThis.document each time.
function trackedDocument() {
  const canvases = [];
  return {
    canvases,
    createElement() {
      const ctx = recordingCtx();
      const canvas = { width: 0, height: 0, getContext: () => ctx };
      canvases.push(canvas);
      return canvas;
    },
  };
}

const doc = trackedDocument();
globalThis.document = doc;

const { drawFogBase, drawTerrain, drawFrame } = await import("../render.js");

// Reconstructs the ordered (x, y, w, h, color) rects a recorded ctx actually painted, pairing
// each fillRect with the most recently set fillStyle — the same pairing the real Canvas 2D API
// applies at draw time.
function paintedRects(calls) {
  const out = [];
  let fill = null;
  for (const c of calls) {
    if (c.set === "fillStyle") fill = c.value;
    else if (c.fn === "fillRect") { const [x, y, w, h] = c.args; out.push({ x, y, w, h, color: fill }); }
  }
  return out;
}

function terrainGrid(cols, rows, cell, codes) {
  return { cols, rows, cell, type: Uint8Array.from(codes) };
}

// Mirrors render.js's own private TERRAIN_FILL — not exported (an internal style constant, like
// renderNodes.test.js's own SATURATION_COLOR mirrors renderNodes.js's private one).
const ROUGH_FILL = "rgba(120, 140, 180, 0.16)";
const HIGH_FILL = "rgba(255, 209, 102, 0.13)";

/* ---------- (a) terrain: offscreen cell-resolution cache + single drawImage blit ---------- */

test("drawTerrain does not throw when state.map.terrain is missing", () => {
  assert.doesNotThrow(() => drawTerrain(recordingCtx(), { map: {} }, null));
});

test("drawTerrain: the offscreen cache paints exactly one pixel per non-open cell, in the right color, skipping OPEN cells", () => {
  doc.canvases.length = 0;
  const terrain = terrainGrid(4, 3, 40, [
    0, 1, 2, 0,
    1, 1, 0, 2,
    0, 0, 0, 0,
  ]);
  const state = { map: { width: 160, height: 120, terrain } };
  const main = recordingCtx();

  drawTerrain(main, state, null);

  assert.equal(doc.canvases.length, 1, "builds exactly one offscreen cache canvas");
  const cache = doc.canvases[0];
  assert.equal(cache.width, 4, "cache canvas is sized cols x rows — one pixel per cell");
  assert.equal(cache.height, 3);

  const painted = paintedRects(cache.getContext("2d").calls);
  assert.deepEqual(painted, [
    { x: 1, y: 0, w: 1, h: 1, color: ROUGH_FILL },
    { x: 2, y: 0, w: 1, h: 1, color: HIGH_FILL },
    { x: 0, y: 1, w: 1, h: 1, color: ROUGH_FILL },
    { x: 1, y: 1, w: 1, h: 1, color: ROUGH_FILL },
    { x: 3, y: 1, w: 1, h: 1, color: HIGH_FILL },
  ], "matches TERRAIN_FILL per cell — the same colors the old per-cell fillRect used — OPEN cells untouched");

  const mainFillRects = main.calls.filter(c => c.fn === "fillRect");
  assert.equal(mainFillRects.length, 0, "the on-screen canvas gets no per-cell fillRect calls anymore");
  const drawImageCalls = main.calls.filter(c => c.fn === "drawImage");
  assert.equal(drawImageCalls.length, 1, "exactly one drawImage blit per frame");
  assert.deepEqual(drawImageCalls[0].args, [cache, 0, 0, 4, 3, 0, 0, 160, 120],
    "blits the full grid (no view passed) at 1:1 cell->pixel source, cell-size-scaled destination");
  assert.ok(main.calls.some(c => c.set === "imageSmoothingEnabled" && c.value === false),
    "nearest-neighbour scaling keeps the current hard-edged per-cell look when scaled up");
});

test("drawTerrain blits only the view's visible cell sub-rect, same clamp math as before", () => {
  doc.canvases.length = 0;
  const terrain = terrainGrid(4, 3, 40, [0, 1, 2, 0, 1, 1, 0, 2, 0, 0, 0, 0]);
  const state = { map: { width: 160, height: 120, terrain } };
  const view = { minX: 45, maxX: 130, minY: 5, maxY: 45 };   // -> gx 1..3, gy 0..1
  const main = recordingCtx();

  drawTerrain(main, state, view);

  const cache = doc.canvases[0];
  const drawImageCalls = main.calls.filter(c => c.fn === "drawImage");
  assert.equal(drawImageCalls.length, 1);
  assert.deepEqual(drawImageCalls[0].args, [cache, 1, 0, 3, 2, 40, 0, 120, 80]);
});

test("terrain cache: reused for the same state.map identity, rebuilt for a new one", () => {
  doc.canvases.length = 0;
  const map1 = { width: 80, height: 80, terrain: terrainGrid(2, 2, 40, [0, 1, 1, 0]) };
  const state1 = { map: map1 };

  drawTerrain(recordingCtx(), state1, null);
  assert.equal(doc.canvases.length, 1, "first draw builds the cache");

  drawTerrain(recordingCtx(), state1, null);
  drawTerrain(recordingCtx(), state1, null);
  assert.equal(doc.canvases.length, 1, "same state.map object -> cached canvas reused across many frames, no rebuild");

  // A fresh map object — even with identical terrain VALUES — is a new state.map identity and
  // must force a fresh pre-render (the whole point of keying on identity, not a deep-equal).
  const map2 = { width: 80, height: 80, terrain: terrainGrid(2, 2, 40, [0, 1, 1, 0]) };
  drawTerrain(recordingCtx(), { map: map2 }, null);
  assert.equal(doc.canvases.length, 2, "a new state.map identity forces a fresh pre-render");
});

test("perf-adjacent: a Gigantic-scale terrain grid is cached once and costs one drawImage per frame, zero fillRects", () => {
  doc.canvases.length = 0;
  const cols = 160, rows = 100;   // docs/improvement-proposals.md's own cited Gigantic dims (160x100 = 16,000 cells)
  const codes = new Uint8Array(cols * rows);
  for (let i = 0; i < codes.length; i++) codes[i] = i % 5 === 0 ? 1 : (i % 7 === 0 ? 2 : 0);
  const state = { map: { width: cols * 40, height: rows * 40, terrain: { cols, rows, cell: 40, type: codes } } };

  let totalFillRects = 0, totalDrawImages = 0;
  for (let frame = 0; frame < 30; frame++) {
    const main = recordingCtx();
    drawTerrain(main, state, null);
    totalFillRects += main.calls.filter(c => c.fn === "fillRect").length;
    totalDrawImages += main.calls.filter(c => c.fn === "drawImage").length;
  }

  assert.equal(doc.canvases.length, 1, "the expensive per-cell pre-render runs exactly once across 30 frames, not once per frame");
  assert.equal(totalFillRects, 0, "zero fillRect calls on the real canvas across 30 frames — was up to 16,000 cells x 30 before");
  assert.equal(totalDrawImages, 30, "one cheap drawImage blit per frame instead");
});

/* ---------- (b) fog wash: row-by-row run-length span emission ---------- */

function fogGrid(cols, rows, exploredBits, visibleBits) {
  return { cols, rows, explored: Uint8Array.from(exploredBits), visible: Uint8Array.from(visibleBits) };
}

// Mirrors render.js's own private drawFogBase fillStyle.
const FOG_WASH = "rgba(79, 209, 255, 0.05)";

test("drawFogBase does not throw when state.fog is missing", () => {
  assert.doesNotThrow(() => drawFogBase(recordingCtx(), {}, null));
});

test("drawFogBase merges each row's contiguous explored-not-visible run into a single fillRect span", () => {
  const cols = 10, rows = 3;
  // Row0: explored everywhere, cell 4 currently visible -> two runs (0..3, 5..9), 9 cells total.
  // Row1: nothing ever explored -> no runs.
  // Row2: explored everywhere, nothing visible -> one run spanning the whole row, 10 cells.
  const explored = [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  ];
  const visible = [
    0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ];
  const fog = fogGrid(cols, rows, explored, visible);
  const ctx = recordingCtx();

  drawFogBase(ctx, { fog }, null);

  const painted = paintedRects(ctx.calls);
  assert.deepEqual(painted, [
    { x: 0, y: 0, w: 4 * FOG_CELL_SIZE, h: FOG_CELL_SIZE, color: FOG_WASH },
    { x: 5 * FOG_CELL_SIZE, y: 0, w: 5 * FOG_CELL_SIZE, h: FOG_CELL_SIZE, color: FOG_WASH },
    { x: 0, y: 2 * FOG_CELL_SIZE, w: 10 * FOG_CELL_SIZE, h: FOG_CELL_SIZE, color: FOG_WASH },
  ], "3 spans total instead of 19 individual qualifying-cell fillRects");
});

test("drawFogBase spans are clipped to the viewport, same clamp math as before", () => {
  const cols = 10, rows = 5;
  const explored = new Uint8Array(cols * rows).fill(1);
  const visible = new Uint8Array(cols * rows);   // nothing visible -> everything explored qualifies
  const fog = { cols, rows, explored, visible };
  const view = { minX: 2 * FOG_CELL_SIZE + 1, maxX: 6 * FOG_CELL_SIZE - 1, minY: FOG_CELL_SIZE, maxY: 2 * FOG_CELL_SIZE };
  const ctx = recordingCtx();

  drawFogBase(ctx, { fog }, view);

  const painted = paintedRects(ctx.calls);
  assert.deepEqual(painted, [
    { x: 2 * FOG_CELL_SIZE, y: 1 * FOG_CELL_SIZE, w: 4 * FOG_CELL_SIZE, h: FOG_CELL_SIZE, color: FOG_WASH },
    { x: 2 * FOG_CELL_SIZE, y: 2 * FOG_CELL_SIZE, w: 4 * FOG_CELL_SIZE, h: FOG_CELL_SIZE, color: FOG_WASH },
  ]);
});

// Rendering-correctness oracle: an independently-computed reference (straight from the
// explored/visible semantics, no batching) must land on EXACTLY the same set of cells the
// span-batched output paints — same visual result, just fewer draw calls. A varied,
// deterministic (no rng — this is a plain test, not engine/, but a fixed pattern keeps a
// failure reproducible) pattern exercises multiple run lengths, gaps, and row-boundary cases
// at once, rather than only the hand-picked case above.
test("drawFogBase span output covers exactly the cells the old per-cell semantics (explored && !visible) would have — same cells, same colors", () => {
  const cols = 23, rows = 9;
  const explored = new Uint8Array(cols * rows);
  const visible = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx;
      explored[i] = (gx + gy * 3) % 7 !== 0 ? 1 : 0;
      visible[i] = (gx * 3 + gy) % 11 === 0 ? 1 : 0;
    }
  }
  const fog = { cols, rows, explored, visible };
  const ctx = recordingCtx();

  drawFogBase(ctx, { fog }, null);

  let expectedCount = 0;
  const expectedCells = new Set();
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const i = gy * cols + gx;
      if (explored[i] && !visible[i]) { expectedCells.add(`${gx},${gy}`); expectedCount++; }
    }
  }

  const painted = paintedRects(ctx.calls);
  const actualCells = new Set();
  for (const { x, y, w, h, color } of painted) {
    assert.equal(color, FOG_WASH, "every span uses the one charted-space wash color");
    assert.equal(h, FOG_CELL_SIZE, "a span is always exactly one row tall — only horizontal runs are merged");
    const gy = y / FOG_CELL_SIZE;
    const gx0 = x / FOG_CELL_SIZE, gx1 = gx0 + w / FOG_CELL_SIZE - 1;
    for (let gx = gx0; gx <= gx1; gx++) actualCells.add(`${gx},${gy}`);
  }

  assert.deepEqual([...actualCells].sort(), [...expectedCells].sort(),
    "span-batched output fills exactly the explored-and-not-visible cells, no more, no less");
  assert.ok(painted.length < expectedCount,
    `batching should issue fewer fillRects (${painted.length}) than individual qualifying cells (${expectedCount})`);
});

test("perf-adjacent: a fully-qualifying Gigantic-scale fog grid collapses 16,000 cells into one fillRect per row", () => {
  const cols = 160, rows = 100;   // docs/improvement-proposals.md's own cited Gigantic dims
  const explored = new Uint8Array(cols * rows).fill(1);
  const visible = new Uint8Array(cols * rows);   // nothing currently visible -> every cell qualifies
  const fog = { cols, rows, explored, visible };
  const ctx = recordingCtx();

  drawFogBase(ctx, { fog }, null);

  const fillRectCount = ctx.calls.filter(c => c.fn === "fillRect").length;
  assert.equal(fillRectCount, rows, "one full-width span per row");
  assert.ok(fillRectCount < cols * rows, `${fillRectCount} spans vs ${cols * rows} cells the old per-cell loop would have filled`);
});

// Empirical check against the CURRENT (post real-LOS-pass) engine/fog.js shape, not the
// pre-LOS-pass description in the proposal doc: createFog/updateFog still produce the plain
// {cols, rows, explored, visible} Uint8Array grid drawFogBase expects — uphill concealment
// changed WHICH cells get revealed, not the grid's own shape. A scout that reveals ground and
// then leaves it should leave behind exactly the explored-not-visible cells the wash is for.
test("integration: real createFog/updateFog output feeds drawFogBase and washes ground a scout has left", () => {
  const map = { width: 400, height: 400 };
  const fog = createFog(map);
  const scout = makeUnit("worker", "player", 100, 100);
  updateFog({ units: new Map([[scout.id, scout]]), buildings: new Map() }, fog, "player");
  // The scout leaves — recompute with no units left. `explored` stays permanent (once set);
  // `visible` clears, so the vacated cells should now qualify for the fog wash.
  updateFog({ units: new Map(), buildings: new Map() }, fog, "player");

  const ctx = recordingCtx();
  assert.doesNotThrow(() => drawFogBase(ctx, { fog }, null));
  const fillRectCount = ctx.calls.filter(c => c.fn === "fillRect").length;
  assert.ok(fillRectCount > 0, "the vacated, now-explored-but-not-visible area should get the fog wash");
});

/* ---- A7: a throwing draw must not permanently corrupt every later frame -------------------- */

// A ctx that tracks save/restore depth and can be told to throw once from inside a draw.
function depthCtx({ throwOn } = {}) {
  const state = { depth: 0, max: 0 };
  const ctx = new Proxy({}, {
    get(t, prop) {
      if (prop === "_depth") return state;
      return (...args) => {
        if (prop === "save") { state.depth++; state.max = Math.max(state.max, state.depth); }
        else if (prop === "restore") state.depth--;
        else if (prop === throwOn) throw new Error("boom in a draw");
        if (prop === "measureText") return { width: 10 };
        return undefined;
      };
    },
    set() { return true; },
  });
  return ctx;
}

test("a throwing draw leaves the canvas save-stack balanced (A7)", async () => {
  // engine/loop.js deliberately swallows a throwing render so the loop survives a bad entity. That
  // only works if the frame unwinds cleanly: drawFrame's save() had no matching restore() on the
  // throw path, so the camera transform was never popped. Every LATER frame then drew on top of the
  // leaked one — including the backdrop fillRect, which is why the screen stopped clearing at all.
  // The loop keeps running and the view is dead forever, which to a player is a freeze.
  const { createGameState } = await import("../engine/state.js");
  const st = createGameState({ planetId: "ferros", seed: 5 });
  const camera = { x: st.map.width / 2, y: st.map.height / 2, zoom: 1 };

  const ok = depthCtx();
  drawFrame(ok, st, camera, 800, 600, null, null, 1, true);
  assert.equal(ok._depth.depth, 0, "a clean frame is balanced");
  assert.ok(ok._depth.max > 0, "fixture sanity: the frame really did save/restore");

  const bad = depthCtx({ throwOn: "lineTo" });
  assert.throws(() => drawFrame(bad, st, camera, 800, 600, null, null, 1, true), /boom in a draw/);
  assert.equal(bad._depth.depth, 0,
    "a frame that threw must still pop its camera transform — otherwise every later frame is drawn " +
    "on top of it and the backdrop clear lands in world space");
});
