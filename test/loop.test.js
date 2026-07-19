import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoop } from "../engine/loop.js";

// Drive the loop by hand: capture the rAF callback and feed it timestamps, so the
// accumulator/substep logic can be tested without a browser. (The loop reads the
// timestamp the browser passes to the rAF callback, not a wall clock.)
function harness() {
  const updates = [], renders = [];
  let cb = null;
  const prevRaf = globalThis.requestAnimationFrame, prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { cb = fn; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  const loop = createLoop({ update: dt => updates.push(dt), render: f => renders.push(f), hz: 20 });
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
