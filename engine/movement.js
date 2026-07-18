"use strict";

// Moves `e` at most `speed * dt` toward (tx, ty). Returns true once it has
// arrived (within 1 unit), so callers can clear the order that got it there.
export function stepToward(e, tx, ty, speed, dt) {
  const dx = tx - e.x, dy = ty - e.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= 1) { e.x = tx; e.y = ty; return true; }
  const step = Math.min(dist, speed * dt);
  e.x += (dx / dist) * step;
  e.y += (dy / dist) * step;
  return step >= dist - 1e-6;
}
