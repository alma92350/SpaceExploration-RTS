/* ============================================================
   Camera: pans and zooms the view over the map instead of squeezing
   the whole map into one screen. Pure view-space math — never reads or
   mutates game state, just converts between screen (CSS pixel, origin
   at the canvas's top-left) and world (map) coordinates.
   ============================================================ */

"use strict";

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 2.5;
const PAN_SPEED = 900;   // world units/sec of keyboard pan at zoom 1

// How far out the wheel can zoom: the usual MIN_ZOOM, but never so tight that
// a big map can't be pulled fully into view. On a Small map this is just
// MIN_ZOOM; on a Gigantic one it drops low enough to fit the whole thing.
function minZoomFor(map, vw, vh) {
  if (!vw || !vh) return MIN_ZOOM;
  return Math.min(MIN_ZOOM, vw / map.width, vh / map.height);
}

export function createCamera(map) {
  return { x: map.width / 2, y: map.height / 2, zoom: 1 };
}

export function screenToWorld(camera, vw, vh, sx, sy) {
  return {
    x: camera.x + (sx - vw / 2) / camera.zoom,
    y: camera.y + (sy - vh / 2) / camera.zoom,
  };
}

export function worldToScreen(camera, vw, vh, wx, wy) {
  return {
    x: vw / 2 + (wx - camera.x) * camera.zoom,
    y: vh / 2 + (wy - camera.y) * camera.zoom,
  };
}

// Keeps the camera from panning past the map edge into empty space. Once
// the viewport is wider/taller than the map (zoomed out far enough, or a
// tiny window), that axis just centers instead of "clamping" to a
// backwards range.
export function clampCamera(camera, map, vw, vh) {
  const halfW = vw / (2 * camera.zoom);
  const halfH = vh / (2 * camera.zoom);
  camera.x = map.width <= 2 * halfW ? map.width / 2 : Math.min(Math.max(camera.x, halfW), map.width - halfW);
  camera.y = map.height <= 2 * halfH ? map.height / 2 : Math.min(Math.max(camera.y, halfH), map.height - halfH);
}

// Zooms by `factor` while keeping the world point under (sx, sy) fixed on
// screen, so scrolling the wheel feels like it's zooming toward the
// cursor instead of the map drifting out from under it.
export function zoomAt(camera, map, vw, vh, sx, sy, factor) {
  const before = screenToWorld(camera, vw, vh, sx, sy);
  camera.zoom = Math.min(MAX_ZOOM, Math.max(minZoomFor(map, vw, vh), camera.zoom * factor));
  const after = screenToWorld(camera, vw, vh, sx, sy);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  clampCamera(camera, map, vw, vh);
}

// dx/dy is a direction (not necessarily normalized) — e.g. from held
// keys — scaled by dt and the current zoom so panning covers the same
// screen distance per second regardless of zoom level.
export function panCamera(camera, map, vw, vh, dx, dy, dt) {
  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy);
  camera.x += (dx / len) * PAN_SPEED * dt / camera.zoom;
  camera.y += (dy / len) * PAN_SPEED * dt / camera.zoom;
  clampCamera(camera, map, vw, vh);
}
