/* ============================================================
   STELLAR FRONTIER: RTS — bootstrap game loop
   Proof-of-life: renders the charted worlds from data.js on a canvas and
   ticks on wall-clock delta time (requestAnimationFrame), not player
   actions/cycles. This is the seam the real game gets built on — no
   engine, state model or unit logic yet.
   ============================================================ */

"use strict";

const canvas = document.getElementById("field");
const ctx = canvas.getContext("2d");

function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
}
window.addEventListener("resize", resize);
resize();

// Spread the charted worlds' 1-D `x` (a lane-order index in the original
// game) across a simple 2-D field so there's something to look at.
const worlds = PLANETS.map((p, i) => ({
  ...p,
  px: 80 + (p.x / 28) * (canvas.clientWidth - 160) * devicePixelRatio,
  py: (120 + (i % 5) * 90 + (i * 37) % 60) * devicePixelRatio,
}));

let last = performance.now();
function tick(now) {
  const dt = (now - last) / 1000;
  last = now;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const w of worlds) {
    const pulse = 4 + Math.sin(now / 600 + w.px) * 2;
    ctx.beginPath();
    ctx.arc(w.px, w.py, 10 + pulse, 0, Math.PI * 2);
    ctx.fillStyle = w.color;
    ctx.fill();
    ctx.font = `${12 * devicePixelRatio}px sans-serif`;
    ctx.fillStyle = "#dce6ff";
    ctx.fillText(w.name, w.px + 16, w.py + 4);
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
