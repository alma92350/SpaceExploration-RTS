/* ============================================================
   Fixed-timestep game loop.
   Simulation runs at a constant rate (default 20 Hz) regardless of
   display refresh rate, via an accumulator — the render callback runs
   once per animation frame and gets the leftover fraction for
   interpolation if it wants it. This is the seam that makes the sim
   deterministic-ish and decoupled from how fast the browser paints.
   ============================================================ */

"use strict";

const MAX_SUBSTEPS = 5;   // most catch-up sim ticks to run in one animation frame

export function createLoop({ update, render, hz = 20, now = () => performance.now() }) {
  const dtFixed = 1 / hz;
  let acc = 0;
  let last = null;
  let running = false;
  let rafId = null;

  function frame(t) {
    if (!running) return;
    if (last === null) last = t;
    let delta = (t - last) / 1000;
    last = t;
    if (delta > 0.25) delta = 0.25;   // clamp so a backgrounded tab doesn't spiral on return
    acc += delta;
    // Cap catch-up substeps per frame. If a single update ever runs longer than
    // the fixed step (plausible on a Gigantic map once armies are huge), the
    // accumulator would otherwise grow every frame and the sim spirals into an
    // ever-deepening backlog. Capping lets it degrade to slow-motion — dropping
    // sim time — instead, which stays responsive and recovers.
    let steps = 0;
    while (acc >= dtFixed && steps < MAX_SUBSTEPS) {
      update(dtFixed);
      acc -= dtFixed;
      steps++;
    }
    if (acc > dtFixed) acc = 0;   // over the cap: drop the backlog rather than carry it forward
    render(acc / dtFixed);
    rafId = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = null;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
    get running() { return running; },
  };
}
