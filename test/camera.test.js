import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCamera, screenToWorld, worldToScreen, clampCamera, zoomAt,
  dragCamera, pinchZoomPan, MIN_ZOOM, MAX_ZOOM,
} from "../camera.js";

const MAP = { width: 1600, height: 1000 };
const VW = 800, VH = 500;

test("screenToWorld and worldToScreen are inverses", () => {
  const cam = { x: 700, y: 420, zoom: 1.4 };
  const w = screenToWorld(cam, VW, VH, 123, 456);
  const s = worldToScreen(cam, VW, VH, w.x, w.y);
  assert.ok(Math.abs(s.x - 123) < 1e-9 && Math.abs(s.y - 456) < 1e-9, "round-trips back to the same screen point");
  // The view centre maps to the camera's world focus.
  const c = screenToWorld(cam, VW, VH, VW / 2, VH / 2);
  assert.ok(Math.abs(c.x - cam.x) < 1e-9 && Math.abs(c.y - cam.y) < 1e-9);
});

test("clampCamera keeps the view inside the map, and centres an axis smaller than the viewport", () => {
  const cam = { x: -500, y: 5000, zoom: 1 };   // way off both edges
  clampCamera(cam, MAP, VW, VH);
  assert.ok(cam.x >= VW / 2 && cam.x <= MAP.width - VW / 2, "x is pulled back inside the horizontal range");
  assert.ok(cam.y >= VH / 2 && cam.y <= MAP.height - VH / 2, "y is pulled back inside the vertical range");

  // Zoomed far out so the viewport is wider than the map -> that axis centres.
  const wide = { x: 10, y: 10, zoom: 0.1 };
  clampCamera(wide, MAP, VW, VH);
  assert.equal(wide.x, MAP.width / 2, "an over-wide viewport centres x");
  assert.equal(wide.y, MAP.height / 2, "an over-tall viewport centres y");
});

test("zoomAt keeps the world point under the cursor fixed and respects the zoom limits", () => {
  const cam = createCamera(MAP);
  const before = screenToWorld(cam, VW, VH, 600, 300);
  zoomAt(cam, MAP, VW, VH, 600, 300, 1.5);
  const after = screenToWorld(cam, VW, VH, 600, 300);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6, "the point under the cursor doesn't drift");
  assert.ok(cam.zoom > 1, "it zoomed in");

  for (let i = 0; i < 40; i++) zoomAt(cam, MAP, VW, VH, 400, 250, 2);
  assert.ok(cam.zoom <= MAX_ZOOM + 1e-9, "never past MAX_ZOOM");
  for (let i = 0; i < 40; i++) zoomAt(cam, MAP, VW, VH, 400, 250, 0.5);
  assert.ok(cam.zoom >= Math.min(MIN_ZOOM, VW / MAP.width, VH / MAP.height) - 1e-9, "never below the fit-the-map minimum");
});

test("dragCamera moves the world opposite the finger, scaled by zoom, and clamps", () => {
  const cam = { x: 800, y: 500, zoom: 2 };
  dragCamera(cam, MAP, VW, VH, 100, -40);   // fingers drag right/up
  assert.equal(cam.x, 800 - 100 / 2, "content follows the finger: +dx screen -> -dx/zoom world");
  assert.equal(cam.y, 500 - (-40) / 2);

  const edge = { x: MAP.width / 2, y: MAP.height / 2, zoom: 1 };
  dragCamera(edge, MAP, VW, VH, 100000, 0);   // shove hard past the edge
  assert.ok(edge.x <= MAP.width - VW / 2 + 1e-9, "a drag can't push the view off the map");
});

test("pinchZoomPan zooms by the spread ratio about the pinch midpoint", () => {
  const cam = { x: 800, y: 500, zoom: 1 };
  // Both fingers straddle the exact view centre and spread 2x apart, midpoint
  // fixed -> pure zoom-in of ~2x, and the world point at the centre stays put.
  const centreWorldBefore = screenToWorld(cam, VW, VH, VW / 2, VH / 2);
  const prev = { ax: VW / 2 - 50, ay: VH / 2, bx: VW / 2 + 50, by: VH / 2 };
  const cur  = { ax: VW / 2 - 100, ay: VH / 2, bx: VW / 2 + 100, by: VH / 2 };
  pinchZoomPan(cam, MAP, VW, VH, prev, cur);
  assert.ok(Math.abs(cam.zoom - 2) < 1e-6, "spread doubled -> zoom doubled");
  const centreWorldAfter = screenToWorld(cam, VW, VH, VW / 2, VH / 2);
  assert.ok(Math.abs(centreWorldBefore.x - centreWorldAfter.x) < 1e-6
    && Math.abs(centreWorldBefore.y - centreWorldAfter.y) < 1e-6, "the pinch midpoint's world point is anchored");
});

test("pinchZoomPan also pans when the two fingers translate together", () => {
  const cam = { x: 800, y: 500, zoom: 1 };
  // Same spread (no zoom), both fingers slide +60px in x -> a pure pan.
  const prev = { ax: 300, ay: 250, bx: 400, by: 250 };
  const cur  = { ax: 360, ay: 250, bx: 460, by: 250 };
  pinchZoomPan(cam, MAP, VW, VH, prev, cur);
  assert.ok(Math.abs(cam.zoom - 1) < 1e-9, "equal spread -> no zoom");
  assert.equal(cam.x, 800 - 60 / 1, "the view pans opposite the shared finger movement");
});
