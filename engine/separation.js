/* ============================================================
   General collision separation: any two same-owner units — any type,
   however they got where they are (a shared rally point, a group order,
   two workers converging on one node, whatever) — get gently pushed
   apart the instant their bodies overlap. This runs every tick as a
   correction pass, independent of movement/orders, so it catches
   stacking from any source instead of needing a fix at each place an
   order gets assigned.

   Deliberately skips different-owner pairs: opposing units are meant to
   close to weapon range and stand there, not get shoved off it.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";

const PUSH_SPEED = 60;   // units/sec of separation at full overlap

export function applySeparation(state, dt) {
  const units = [...state.units.values()];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      separatePair(units[i], units[j], dt);
    }
  }
}

function separatePair(a, b, dt) {
  if (a.owner !== b.owner) return;
  const minDist = UNITS[a.type].radius + UNITS[b.type].radius;

  let dx = b.x - a.x, dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  if (dist >= minDist) return;

  if (dist < 1e-4) {
    const angle = hashAngle(a.id, b.id);
    dx = Math.cos(angle); dy = Math.sin(angle); dist = 1;
  }

  const overlap = minDist - dist;
  const nx = dx / dist, ny = dy / dist;
  const push = Math.min(overlap, PUSH_SPEED * dt) / 2;
  a.x -= nx * push; a.y -= ny * push;
  b.x += nx * push; b.y += ny * push;
}

// Deterministic per-pair direction for the (rare) exactly-coincident case,
// so two units spawned on the same point don't jitter frame to frame.
function hashAngle(idA, idB) {
  let h = 7;
  for (const c of idA + idB) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 360) * (Math.PI / 180);
}
