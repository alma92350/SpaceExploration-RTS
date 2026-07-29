/* ============================================================
   AI MILITARY (engine/aiMilitary.js) — the offense ramp's real-target guard.

   The living galaxy instantiates every world at galaxy creation, but
   engine/galaxy.js's `addPlanet(..., { unsettled: true })` strips ALL player
   units and buildings from a world the player hasn't reached yet — so a
   background/unvisited neighbour starts with ZERO player footprint. Its own
   diplomacy (engine/diplomacy.js) still drifts toward war on its own —
   scarcity, and past grace, unbounded late-game creep — with no player
   involvement at all. Once hostile, aiOffense's Odyssey branch has, until
   now, mustered and committed a wave regardless: chooseAttackTarget always
   resolves SOME coordinate (the player's charted-but-empty start, or a
   fog-sweep hunt point) even when there is nothing there to fight. That
   wastes the neighbour's whole production line, forever, on a world the
   player may never even visit — and (a real save's data) starves it of the
   surplus it would otherwise bank toward its own economy.

   Written from the requirement, ahead of the fix: an Odyssey neighbour must
   only muster and commit a voluntary wave once the player has SOME real
   footprint on that specific world — a unit or a building, either counts.
   Deliberately NOT fog-gated (unlike visibleEnemyForceCount/counterToPlayerArmy):
   this is "is there anyone there at all", not "can the AI currently see them".
   Skirmish (no state.diplomacy) never reaches the guarded branch, so an
   always-present skirmish player is untouched — see the "no diplomacy"
   coverage in test/diplomacy.test.js.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { runAI } from "../engine/ai.js";

const THINK = 1.5;   // matches ai.js THINK_INTERVAL — forces a fresh think each call

// A `ferros` world with an AI home army banked at the given neighbour stance, but with
// EVERY player unit/building stripped — mirroring exactly what engine/galaxy.js's
// addPlanet(..., {unsettled:true}) leaves behind on a world the player has never reached.
// (createGameState always seeds a starting CC + 3 workers per side in non-endless mode —
// stripping the player's half afterward is what reproduces the real "never been here" world.)
function unvisitedHostileWorld(stance, n = 12) {
  const s = createGameState({ planetId: "ferros" });
  for (const [id, u] of [...s.units]) if (u.owner === "player") s.units.delete(id);
  for (const [id, b] of [...s.buildings]) if (b.owner === "player") s.buildings.delete(id);
  const army = [];
  for (let i = 0; i < n; i++) {
    const u = makeUnit("skiff", "ai", s.map.bases.ai.x, s.map.bases.ai.y);
    s.units.set(u.id, u); army.push(u);
  }
  s.diplomacy = { stance, depletion: 0 };
  return { s, army };
}
const attacking = army => army.filter(u => u.order?.type === "attack-move").length;

test("a deeply-hostile neighbour never commits a wave on a world with zero player presence", () => {
  const { s, army } = unvisitedHostileWorld(-0.95);   // h≈0.94 — would be a near-full commit if anyone were there
  runAI(s, THINK);
  assert.equal(attacking(army), 0, "nothing to attack on a world the player has never set foot on — no wave should launch");
});

test("even a barely-wary neighbour holds its probe, not just its doomstack, with no player footprint", () => {
  const { s, army } = unvisitedHostileWorld(-0.2);   // just past the peace line — a small-probe stance elsewhere
  runAI(s, THINK);
  assert.equal(attacking(army), 0, "no player footprint ⇒ no probe either, however wary the neighbour is");
});

test("the same hostile neighbour commits a wave once the player has a real unit here, even with no building", () => {
  const { s, army } = unvisitedHostileWorld(-0.95);
  const scout = makeUnit("worker", "player", s.map.bases.player.x, s.map.bases.player.y);
  s.units.set(scout.id, scout);
  runAI(s, THINK);
  assert.ok(attacking(army) > 0, "a real player unit is a real target — the wave still launches");
});

test("...and with only a standing player building here, even with no player unit", () => {
  const { s, army } = unvisitedHostileWorld(-0.95);
  const outpost = makeBuilding("command", "player", s.map.bases.player.x, s.map.bases.player.y);
  s.buildings.set(outpost.id, outpost);
  runAI(s, THINK);
  assert.ok(attacking(army) > 0, "a standing player building is a real target — the wave still launches");
});
