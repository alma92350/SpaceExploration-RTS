import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { drawUnits } from "../renderUnits.js";
import { facing, resetFacing } from "../renderShared.js";

// Same recording-Proxy idiom as test/renderEffects.test.js's recordingCtx: a no-op canvas stub
// that also logs every strokeStyle/fillStyle assignment, so a test can tell two draws apart by
// what color they actually used without hand-enumerating the whole canvas API.
function recordingCtx() {
  const target = { lineWidth: 1, strokeStyle: "", fillStyle: "" };
  const colors = [];
  const ctx = new Proxy(target, {
    get: (t, p) => (p in t ? t[p] : () => {}),
    set: (t, p, v) => {
      t[p] = v;
      if (p === "strokeStyle" || p === "fillStyle") colors.push(v);
      return true;
    },
  });
  return { ctx, colors: () => colors.slice() };
}

// A ctx that logs every property SET as {set, value} — A8's tests need to count how many times a
// specific colour was assigned, not just which colours appeared.
function tracedCtx() {
  const target = { lineWidth: 1, strokeStyle: "", fillStyle: "" };
  const calls = [];
  const ctx = new Proxy(target, {
    get: (t, p) => (p === "calls" ? calls : (p in t ? t[p] : () => {})),
    set: (t, p, v) => { t[p] = v; calls.push({ set: p, value: v }); return true; },
  });
  return ctx;
}
const facingOf = id => facing.get(id) && facing.get(id).angle;

function stateWithOneUnit(unit) {
  const state = createGameState({ planetId: "ferros" });
  state.units.clear();
  state.units.set(unit.id, unit);
  return state;
}

/* ---------------------------------------------------------------------------------------------
   Veterancy chevrons (docs/improvement-proposals.md "Veterancy ranks: kills forge small combat
   multipliers and visible chevrons"): drawUnits' overlay pass stamps a small chevron stack over
   the health bar for any unit at rank > 0 (entities.js rankMults), regardless of owner or
   current hp — a permanent trait, not a damage state.
   --------------------------------------------------------------------------------------------- */

test("a veteran unit (rank > 0) draws its chevron overlay", () => {
  const veteran = makeUnit("skiff", "player", 500, 500);
  veteran.kills = 3;   // rank 1
  const state = stateWithOneUnit(veteran);
  const rec = recordingCtx();

  drawUnits(rec.ctx, state, null, 1, new Set());

  assert.ok(rec.colors().includes("#a5f3fc"), "expected the chevron color to appear for a rank-1 veteran");
});

test("a fresh (rank 0) unit draws no chevron overlay", () => {
  const fresh = makeUnit("skiff", "player", 500, 500);
  const state = stateWithOneUnit(fresh);
  const rec = recordingCtx();

  drawUnits(rec.ctx, state, null, 1, new Set());

  assert.ok(!rec.colors().includes("#a5f3fc"), "no rank yet — the chevron color should never appear");
});

test("chevrons render for either owner — an enemy veteran's rank is intel, same as its pip", () => {
  const enemyVeteran = makeUnit("skiff", "ai", 500, 500);
  enemyVeteran.kills = 8;   // rank 2
  const state = stateWithOneUnit(enemyVeteran);
  state.fog.visible.fill(1);   // an AI unit only draws when visible through the player's own fog — reveal everything
  const rec = recordingCtx();

  drawUnits(rec.ctx, state, null, 1, new Set());

  assert.ok(rec.colors().includes("#a5f3fc"), "an AI-owned veteran also draws its chevrons");
});

test("drawUnits does not throw for a veteran at any rank, 1 through 3, or for a building-less bare unit", () => {
  for (const kills of [0, 1, 3, 8, 17, 18, 500]) {
    const u = makeUnit("skiff", "player", 500, 500);
    u.kills = kills;
    const state = stateWithOneUnit(u);
    assert.doesNotThrow(() => drawUnits(recordingCtx().ctx, state, null, 1, new Set()),
      `drawUnits threw for kills=${kills}`);
  }
});

test("a full-health veteran still draws its chevrons even though drawHealthBar itself hides at full hp", () => {
  const veteran = makeUnit("skiff", "player", 500, 500);
  veteran.kills = 18;   // rank 3, and hp starts at maxHp (drawHealthBar would normally skip)
  const state = stateWithOneUnit(veteran);
  const rec = recordingCtx();

  drawUnits(rec.ctx, state, null, 1, new Set());

  assert.ok(rec.colors().includes("#a5f3fc"), "rank is a permanent trait, independent of the health bar's own visibility rule");
});

// Observer Mode (observer.js): a free-look spectator that reveals fog on whichever world it's
// pointed at. drawUnits' trailing observerMode param (default false, so every test above is
// unaffected) bypasses the owner/fog gate entirely — a pure render-time flag, never a mutation
// of state.fog itself.
test("observerMode bypasses the fog gate — an unrevealed enemy unit draws only when spectating", () => {
  const enemy = makeUnit("skiff", "ai", 500, 500);
  const state = stateWithOneUnit(enemy);
  state.fog.visible.fill(0);   // guarantee nothing is visible, regardless of any start-base reveal

  const hidden = recordingCtx();
  drawUnits(hidden.ctx, state, null, 1, new Set());
  assert.equal(hidden.colors().length, 0, "a fogged enemy draws nothing by default");

  const revealed = recordingCtx();
  drawUnits(revealed.ctx, state, null, 1, new Set(), true);
  assert.ok(revealed.colors().length > 0, "the same unit draws once observerMode bypasses the fog gate");
});

/* ---- A8: the shared draw scratch must not leak one unit's optional fields into the next ---- */

test("an unarmed Helium Bomb is not drawn as armed just because an armed one drew first (A8)", () => {
  // drawUnits filled a module-level scratch with Object.assign, which copies own properties but
  // never DELETES stale ones. `armed` is optional — makeUnit never sets it — so once any armed bomb
  // was drawn, every later bomb in the same frame inherited the flag and rendered with the armed
  // cue: long red spikes and a hot glowing core. That cue is a safety signal; renderUnits' own
  // comment calls it "unmistakable at a glance, since walking anything (even a friendly) into it is
  // the whole hazard".
  const st = createGameState({ planetId: "ferros", seed: 12 });
  st.units.clear();
  const armed = makeUnit("heliumbomb", "player", 700, 500);
  armed.armed = true;
  const inert = makeUnit("heliumbomb", "player", 760, 500);
  assert.ok(!("armed" in inert), "fixture sanity: an inert bomb has no `armed` key at all");
  st.units.set(armed.id, armed);
  st.units.set(inert.id, inert);

  const ctx = tracedCtx();
  drawUnits(ctx, st, null, 1, new Set(), true);
  const hotCore = ctx.calls.filter(c => c.set === "fillStyle" && c.value === "#ff8a3d").length;
  assert.equal(hotCore, 1, "exactly one bomb should be drawn with the armed core, not both");
});

test("a unit with no explicit facing keeps its own orientation when a commanded unit drew first (A8)", () => {
  // Same leak, different field: `facing` is set only by an explicit click-and-drag heading
  // (engine/commands.js applyFacing). An idle unit drawn after a commanded one inherited the
  // commanded heading, defeating the explicit-facing feature entirely.
  resetFacing();
  const st = createGameState({ planetId: "ferros", seed: 13 });
  st.units.clear();
  const commanded = makeUnit("skiff", "player", 700, 500);
  commanded.facing = Math.PI;
  const idle = makeUnit("skiff", "player", 760, 500);
  assert.ok(!("facing" in idle), "fixture sanity: an idle unit has no `facing` key at all");
  st.units.set(commanded.id, commanded);
  st.units.set(idle.id, idle);

  drawUnits(tracedCtx(), st, null, 1, new Set(), true);
  assert.notEqual(facingOf(idle.id), Math.PI,
    "an idle unit must not inherit another unit's commanded heading through the shared scratch");
});
