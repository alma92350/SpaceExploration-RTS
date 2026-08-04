import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoop } from "../engine/loop.js";

// Drive the loop by hand: capture the rAF callback and feed it timestamps, so the
// accumulator/substep logic can be tested without a browser. (The loop reads the
// timestamp the browser passes to the rAF callback, not a wall clock.)
function harness(hz = 20) {
  const updates = [], renders = [];
  let cb = null;
  const prevRaf = globalThis.requestAnimationFrame, prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { cb = fn; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const loop = createLoop({ update: dt => updates.push(dt), render: f => renders.push(f), hz });
  loop.start();
  return {
    updates, renders,
    frame: tMs => cb(tMs),   // advance to an absolute timestamp (ms)
    restore: () => { globalThis.requestAnimationFrame = prevRaf; globalThis.cancelAnimationFrame = prevCancel; },
  };
}

test("runs exactly one update per fixed timestep (20 Hz -> one per 50 ms)", () => {
  const h = harness();
  h.frame(0);      // first frame primes `last`, no elapsed time yet
  h.frame(50);     // +50 ms = one fixed step
  h.frame(100);    // +50 ms = one more
  assert.equal(h.updates.length, 2, "two 50 ms gaps -> two fixed updates");
  assert.ok(h.updates.every(dt => Math.abs(dt - 0.05) < 1e-9), "each update gets the fixed dt");
  h.restore();
});

test("accumulates fractional time and fires when it crosses a full step", () => {
  const h = harness();
  h.frame(0);
  h.frame(30);   // 0.03 s accumulated, < one step -> no update yet
  assert.equal(h.updates.length, 0);
  h.frame(60);   // +0.03 -> 0.06 total, crosses 0.05 -> one update, 0.01 carried
  assert.equal(h.updates.length, 1, "the fixed step fires once the accumulator crosses it");
  h.restore();
});

test("a long stall is clamped and capped — the sim degrades, it never spirals", () => {
  const h = harness();
  h.frame(0);
  h.frame(100);            // steady step or two
  h.updates.length = 0;
  h.frame(100 + 10_000);   // a 10 s freeze (backgrounded tab): delta clamps to 0.25 s
  assert.equal(h.updates.length, 5, "clamp (0.25 s) x cap (MAX_SUBSTEPS 5) bounds the catch-up");
  h.restore();
});

test("render runs every frame, even one with no fixed update", () => {
  const h = harness();
  h.frame(0);
  h.frame(10);   // too little for a fixed step, but the frame still renders
  assert.equal(h.updates.length, 0);
  assert.equal(h.renders.length, 2, "render is per animation frame, decoupled from the sim rate");
  h.restore();
});

test("a throwing render doesn't stop subsequent frames", () => {
  const updates = [], renders = [];
  let cb = null;
  const prevRaf = globalThis.requestAnimationFrame, prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { cb = fn; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const prevError = console.error;
  console.error = () => {};   // the loop logs the caught error; keep test output clean
  let renderCalls = 0;
  const loop = createLoop({
    update: dt => updates.push(dt),
    render: f => { renderCalls++; renders.push(f); if (renderCalls === 2) throw new Error("boom"); },
    hz: 20,
  });
  loop.start();
  cb(0);     // primes `last`, render call #1 — fine
  cb(50);    // +50 ms -> one update, render call #2 — throws
  assert.equal(updates.length, 1, "the update before the throwing render still ran");
  assert.equal(renders.length, 2, "the throwing render call is still recorded before it throws");
  // A further frame must still drive update/render normally — the throw above didn't brick the loop.
  cb(100);   // +50 ms -> another update, render call #3 — doesn't throw
  assert.equal(updates.length, 2, "a fixed update after the throwing frame still runs");
  assert.equal(renders.length, 3, "render is still called on the frame after the throw");
  console.error = prevError;
  globalThis.requestAnimationFrame = prevRaf; globalThis.cancelAnimationFrame = prevCancel;
});

test("stop() halts the loop — a further frame callback does nothing", () => {
  let cb = null;
  const prevRaf = globalThis.requestAnimationFrame, prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { cb = fn; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const updates = [];
  const loop = createLoop({ update: () => updates.push(1), render: () => {}, hz: 20 });
  loop.start();
  cb(0); cb(50);
  assert.equal(updates.length, 1, "one update before stopping");
  loop.stop();
  cb(100);   // after stop, the frame guard returns immediately
  assert.equal(updates.length, 1, "no updates run after stop()");
  globalThis.requestAnimationFrame = prevRaf; globalThis.cancelAnimationFrame = prevCancel;
});

test("at a higher sim rate a stall past the substep cap drops the backlog instead of carrying it (C16)", () => {
  // The backlog-drop branch is UNREACHABLE at the shipped rate, and no test reached it at any rate:
  // every harness in this file used hz 20, where dtFixed is 0.05, the delta clamp is 0.25 and
  // MAX_SUBSTEPS is 5 — so five steps consume the clamp EXACTLY and the leftover accumulator is
  // always zero. That exact identity couples three tuning constants with nothing recording it: bump
  // the loop to 30 or 60 Hz, or raise the clamp, and a previously-dead line starts running and takes
  // render(acc / dtFixed) with it, handing the renderer an interpolation alpha >= 1. Measured over
  // 500 frames with repeated 10-second stalls: taken 0 times at hz 20, 72 times at hz 60.
  const h = harness(60);
  h.frame(0);
  h.frame(16);
  h.updates.length = 0;
  h.renders.length = 0;

  h.frame(10016);                 // a 10-second stall: far past the clamp
  const burst = h.updates.length;
  assert.ok(burst > 0 && burst <= 5, `the stall is capped at MAX_SUBSTEPS, got ${burst}`);

  h.updates.length = 0;
  h.frame(10032);                 // one ordinary 16ms frame afterwards
  assert.ok(h.updates.length <= 1,
    `the backlog must be DROPPED, not carried forward into a catch-up burst — got ${h.updates.length} updates`);
  h.restore();
});

test("the render interpolation alpha always stays in [0,1) (C16)", () => {
  const h = harness(60);
  h.frame(0);
  for (let t = 16; t <= 400; t += 16) h.frame(t);
  h.frame(10400);                 // and across a stall
  h.frame(10416);
  for (const a of h.renders)
    assert.ok(a >= 0 && a < 1, `interpolation alpha out of range: ${a}`);
  h.restore();
});
