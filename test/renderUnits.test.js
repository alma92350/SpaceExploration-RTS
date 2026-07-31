import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { drawUnits } from "../renderUnits.js";

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
