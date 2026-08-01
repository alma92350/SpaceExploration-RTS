import { test } from "node:test";
import assert from "node:assert/strict";
import { createFog } from "../engine/fog.js";
import { UNITS } from "../engine/entities.js";
import { drawNodes } from "../renderNodes.js";

/* ============================================================
   Node saturation visible on the map (docs/improvement-proposals.md): node.miners is retallied
   every tick by sim.js countMiners, but nothing in render.js used to read it, so six workers piled
   on one deposit just looked like slow income with no visible cause. drawNodes now rings/labels a
   node whose live miner count exceeds UNITS.worker.minerSoftCap.

   Unlike the other render test files' fakeCtx() (a silent no-op Proxy — see
   renderBuildings.test.js / renderEffects.test.js), these tests need to prove specific draw calls
   DID or DID NOT happen, so this records every method call and property assignment instead of
   swallowing them. Still no hand-enumerated canvas API: any call/assignment is accepted and logged.
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

function makeNode(overrides = {}) {
  return { id: "n1", com: "ore", x: 100, y: 100, amount: 200, max: 200, miners: 0, ...overrides };
}

function stateWith(node) {
  return { map: { nodes: [node] }, fog: createFog({ width: 800, height: 600 }) };
}

// The amber "warn" tone (renderShared.js drawHealthBar / renderBuildings.js CONCERN_STYLE.warn)
// used for "running, just not at full rate" — the same read a saturated node deserves: not dead,
// just diminishing.
const SATURATION_COLOR = "#fbbf24";

function ringDrawn(ctx) {
  return ctx.calls.some(c => c.set === "strokeStyle" && c.value === SATURATION_COLOR)
    && ctx.calls.some(c => c.fn === "stroke");
}

test("drawNodes rings a node whose miners exceed the soft cap and labels the live count", () => {
  const cap = UNITS.worker.minerSoftCap;
  const node = makeNode({ miners: cap + 2 });
  const ctx = recordingCtx();

  drawNodes(ctx, stateWith(node), null);

  assert.ok(ringDrawn(ctx), "expected an amber saturation ring for a node over the soft cap");
  const label = ctx.calls.find(c => c.fn === "fillText" && String(c.args[0]).includes(`${cap + 2}/${cap}`));
  assert.ok(label, "expected the live 'miners/cap' count drawn on the map");
});

test("drawNodes does not ring a node exactly at the soft cap — no penalty yet, matching miningEfficiency", () => {
  const cap = UNITS.worker.minerSoftCap;
  const node = makeNode({ miners: cap });
  const ctx = recordingCtx();

  drawNodes(ctx, stateWith(node), null);

  assert.ok(!ringDrawn(ctx), "at the cap, miningEfficiency still pays full rate — the ring must not fire yet");
});

// Observer Mode (observer.js): a free-look spectator that reveals fog on whichever world it's
// pointed at. drawNodes' trailing observerMode param (default false, so every test above is
// unaffected) bypasses isNodeDiscovered entirely — a pure render-time flag, never a mutation of
// state.fog itself. A hidden cache is charted knowledge to a spectator too.
test("observerMode bypasses the discovery gate — a hidden node draws only when spectating", () => {
  const node = makeNode({ hidden: true });
  const state = stateWith(node);

  const hidden = recordingCtx();
  drawNodes(hidden, state, null);
  assert.equal(hidden.calls.length, 0, "an undiscovered node draws nothing by default");

  const revealed = recordingCtx();
  drawNodes(revealed, state, null, true);
  assert.ok(revealed.calls.length > 0, "the same node draws once observerMode bypasses the discovery gate");
});

test("drawNodes does not ring an under-cap or freshly-untallied node", () => {
  for (const miners of [0, 1, undefined]) {
    const node = makeNode({ miners });
    const ctx = recordingCtx();
    drawNodes(ctx, stateWith(node), null);
    assert.ok(!ringDrawn(ctx), `miners=${miners} must not draw the saturation ring`);
  }
});

test("drawNodes still skips a depleted or undiscovered node entirely, ring included", () => {
  const cap = UNITS.worker.minerSoftCap;
  const depleted = makeNode({ id: "n-depleted", amount: 0, miners: cap + 5 });
  const hidden = makeNode({ id: "n-hidden", hidden: true, miners: cap + 5 });
  const ctx = recordingCtx();

  drawNodes(ctx, stateWith(depleted), null);
  drawNodes(ctx, stateWith(hidden), null);

  assert.equal(ctx.calls.length, 0, "a depleted or undiscovered node draws nothing at all, saturation ring included");
});
