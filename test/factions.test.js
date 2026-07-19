import { test } from "node:test";
import assert from "node:assert/strict";
import { FACTIONS, PLAYABLE_FACTIONS, factionTrait } from "../engine/factions.js";
import { sideMod, generateMap } from "../engine/map.js";
import { createGameState, makeUnit } from "../engine/state.js";
import { updateCombat } from "../engine/combat.js";
import { tick } from "../engine/sim.js";
import { archetypeFor } from "../engine/aiArchetypes.js";
import { mulberry32 } from "../engine/rng.js";

// Every trait a faction can carry must be a key the engine actually reads
// through sideMod, or the trait would be dead data.
const SIDEMOD_KEYS = new Set(["speedMult", "sightMult", "gatherMult", "buildTimeMult", "damageDealtMult"]);

test("each playable faction is a small bundle of real traits; neutral has none", () => {
  for (const id of PLAYABLE_FACTIONS) {
    const f = FACTIONS[id];
    assert.ok(f, `${id} exists`);
    assert.equal(f.id, id);
    assert.ok(f.name && f.short && f.blurb, `${id} carries display text`);
    assert.ok(f.traits && Object.keys(f.traits).length > 0, `${id} has at least one trait`);
    for (const k of Object.keys(f.traits)) assert.ok(SIDEMOD_KEYS.has(k), `${id}'s trait ${k} is a real sideMod key`);
  }
  assert.deepEqual(FACTIONS.neutral.traits, {}, "neutral is the no-bonus default used by tests + a bare state");
});

test("factionTrait reads a side's trait, and is 1 with no faction / no trait / no players", () => {
  const st = { players: { player: { faction: "miners" }, ai: { faction: "syndicate" } } };
  assert.equal(factionTrait(st, "player", "gatherMult"), 1.15, "miners' haul bonus");
  assert.equal(factionTrait(st, "player", "speedMult"), 1, "miners has no speed trait -> 1");
  assert.equal(factionTrait(st, "ai", "damageDealtMult"), 1.10, "syndicate's firepower");
  assert.equal(factionTrait({}, "player", "gatherMult"), 1, "no players -> 1");
  assert.equal(factionTrait({ players: { player: {} } }, "player", "gatherMult"), 1, "no faction -> 1");
});

test("sideMod multiplies the world modifier by the side's faction trait", () => {
  const withFac = (planet, pf, af) =>
    ({ map: generateMap(planet, () => 0.5), players: { player: { faction: pf }, ai: { faction: af } } });

  // ferros has no gather modifier: neutral stays 1, miners folds its +15% in.
  assert.equal(sideMod(withFac("ferros", "neutral", "neutral"), "player", "gatherMult"), 1);
  assert.equal(sideMod(withFac("ferros", "miners", "neutral"), "player", "gatherMult"), 1.15);

  // oort gives the PLAYER a 1.2x gather claim: the faction stacks on top of it.
  const st = withFac("oort", "miners", "neutral");
  assert.ok(Math.abs(sideMod(st, "player", "gatherMult") - 1.2 * 1.15) < 1e-9, "oort 1.2 x miners 1.15");
  assert.equal(sideMod(st, "ai", "gatherMult"), 1, "the AI (neutral) gets oort's no-bonus side x 1");
});

test("a neutral state reproduces the pre-faction sideMod exactly (regression guard)", () => {
  // A player-less map stub is what every legacy sideMod test uses; folding the
  // faction layer in must leave that path byte-identical.
  const oort = { map: generateMap("oort", () => 0.5) };
  assert.equal(sideMod(oort, "player", "gatherMult"), 1.2);
  assert.equal(sideMod(oort, "ai", "buildTimeMult"), 0.82);
});

test("the Syndicate's firepower trait makes its units hit ~10% harder, end-to-end", () => {
  // Drive a real attack through updateCombat and measure the damage dealt, with
  // the attacker at the SAME spot in both runs so terrain cancels and only the
  // faction differs.
  function hitDamage(playerFaction) {
    const state = createGameState({ planetId: "ferros", seed: 1, rng: mulberry32(1), playerFaction });
    const cx = state.map.width / 2, cy = state.map.height / 2;
    const atk = makeUnit("skiff", "player", cx, cy); atk.attackTimer = 0;
    const tgt = makeUnit("skiff", "ai", cx + 20, cy);   // inside the Skiff's 40 range, far from both bases
    state.units.set(atk.id, atk); state.units.set(tgt.id, tgt);
    const before = tgt.hp;
    updateCombat(state, atk, 0.1);
    return before - tgt.hp;
  }
  const base = hitDamage("frontier");     // frontier carries no damage trait -> the baseline
  const syndicate = hitDamage("syndicate");
  assert.ok(base > 0 && syndicate > 0, "both actually landed a hit");
  assert.ok(Math.abs(syndicate / base - 1.10) < 1e-6, `syndicate ~1.10x (${base} -> ${syndicate})`);
});

// A compact deterministic-facts snapshot (mirrors determinism.test.js).
function snapshot(state) {
  const units = [...state.units.values()].map(u => `${u.id}|${u.type}|${u.owner}|${u.x}|${u.y}|${u.hp}`).sort();
  const builds = [...state.buildings.values()].map(b => `${b.id}|${b.type}|${b.hp}|${b.buildProgress}`).sort();
  const res = JSON.stringify(state.players.player.resources) + JSON.stringify(state.players.ai.resources);
  return JSON.stringify({ units, builds, res, tick: state.tick, over: state.over, winner: state.winner });
}

test("a faction game stays deterministic: same seed + factions replays identically", () => {
  const run = () => {
    const s = createGameState({ planetId: "ferros", seed: 42, rng: mulberry32(42),
      playerFaction: "syndicate", aiFaction: "miners", aiMicro: true });
    for (let i = 0; i < 1800 && !s.over; i++) tick(s, 0.1);
    return snapshot(s);
  };
  assert.equal(run(), run(), "factions are static multipliers — the sim must still replay byte-identically");
});

test("every faction matchup still resolves to a winner — the guarantee holds with factions on", () => {
  // Three worlds spanning all three AI factions (ferros->miners, korrath->syndicate,
  // vesper->frontier), each against all three player factions, under the toughest
  // Tactical AI. A faction is only passive multipliers, so it can never stop the
  // AI razing a passive base — but prove it across the matrix anyway.
  for (const planetId of ["ferros", "korrath", "vesper"]) {
    const aiFaction = archetypeFor(planetId).faction;
    for (const playerFaction of PLAYABLE_FACTIONS) {
      const state = createGameState({ planetId, playerFaction, aiFaction, aiMicro: true });
      let ticks = 0;
      while (!state.over && ticks < 20000) { tick(state, 0.1); ticks++; }
      assert.equal(state.over, true, `${playerFaction} vs ${aiFaction} on ${planetId} should reach a winner`);
      assert.ok(["player", "ai"].includes(state.winner));
    }
  }
});

test("each AI archetype names a real, playable faction", () => {
  for (const planetId of ["korrath", "ferros", "vesper"]) {
    const fid = archetypeFor(planetId).faction;
    assert.ok(PLAYABLE_FACTIONS.includes(fid), `${planetId}'s AI faction ${fid} is playable`);
  }
});
