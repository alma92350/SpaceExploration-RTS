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

// A speed MULTIPLIER on how much sim time one real second buys (docs/competitions-and-elo.md
// Phase 5: 2x/4x/8x for a spectated match). Either a plain number or a getter, so a caller can
// let the player change speed mid-match without rebuilding the loop.
//
// WHY IT SCALES THE ACCUMULATOR AND NOT `hz`. The obvious implementation — 4x means dtFixed/4 —
// would change THE FIXED TIMESTEP, and the fixed timestep is the thing that makes this sim
// replayable: same seed ⇒ same game only holds because every tick is the same dt in the same
// order. Scaling the time that feeds the accumulator instead leaves `update(dtFixed)` byte-for-
// byte what it always was and changes only how MANY of those identical steps a real second runs.
// It also lands the overload in exactly the place the existing design already handles well: past
// MAX_SUBSTEPS the loop degrades to slow motion (dropping sim time) rather than spiralling into
// an ever-deepening backlog, so 8x on a machine that can't feed it just runs slower than the
// label promises instead of freezing the tab.
// Anything that isn't a finite positive number reads as 1x — an invalid speed must never be able
// to stall the loop (0) or run it backwards.
function speedMultiplier(speed) {
  const v = typeof speed === "function" ? speed() : speed;
  return (typeof v === "number" && Number.isFinite(v) && v > 0) ? v : 1;
}

export function createLoop({ update, render, hz = 20, speed = 1, now = () => performance.now() }) {   // deterministic-exempt: wall clock drives the render loop, not the sim
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
    acc += delta * speedMultiplier(speed);   // …then buy that much MORE sim time per real second (see above)
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
    // A throwing render (e.g. a bad draw call on one odd entity) must not brick the whole
    // loop: without this, the throw unwinds past the requestAnimationFrame call below and
    // the session is permanently frozen. update() is deliberately left unguarded — a
    // throwing sim update is a correctness problem this catch isn't meant to paper over.
    try {
      render(acc / dtFixed);
    } catch (err) {
      console.error("render() threw; skipping this frame", err);
    }
    rafId = requestAnimationFrame(frame);   // browser-exempt: the render loop IS the browser seam; drives no sim state
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = null;
      rafId = requestAnimationFrame(frame);   // browser-exempt: render-loop seam only
    },
    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);   // browser-exempt: render-loop seam only
    },
    get running() { return running; },
  };
}
