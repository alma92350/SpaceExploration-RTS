import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, stepGalaxy, galaxyStatus, ODYSSEY_WORLDS, neighbourAiProfile } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { STRATEGIES } from "../engine/aiStrategy.js";

test("the living galaxy instantiates every world, but the player has reached only the start seat", () => {
  const g = createGalaxy({ seed: 12 });
  assert.equal(g.planets.size, ODYSSEY_WORLDS.length, "every world exists and simulates in the background");
  assert.equal(g.discovered.size, 1, "the player has reached only the start world");
  const st = galaxyStatus(g);
  assert.equal(st.visited, 1, "starmap shows one world visited");
  assert.equal(st.worlds.filter(w => w.status === "unexplored").length, ODYSSEY_WORLDS.length - 1, "the rest read unexplored");
  for (const w of st.worlds) if (w.status === "unexplored") assert.equal(w.stance, null, "an unexplored world hides its neighbour's stance");
});

test("background AI factions develop on their own worlds over time (the galaxy is alive unseen)", () => {
  const g = createGalaxy({ seed: 8 });
  const other = ODYSSEY_WORLDS.find(id => id !== g.activeId);
  const s = g.planets.get(other);
  assert.ok(s.background, "a non-seat world runs in the background");
  assert.equal([...s.buildings.values()].filter(b => b.owner === "ai").length, 0, "it starts with just a colony ship — no buildings");
  for (let i = 0; i < 4000; i++) stepGalaxy(g, 0.05);   // ~200s of galaxy time
  const aiBuildings = [...s.buildings.values()].filter(b => b.owner === "ai");
  assert.ok(aiBuildings.length > 0, `the neighbour built up its base unseen (${aiBuildings.length} buildings)`);
  assert.ok(aiBuildings.some(b => b.type === "command"), "its faction founded a Command Center from the colony ship");
});

test("the reached-world set survives a save/load", () => {
  const g = createGalaxy({ seed: 5 });
  g.discovered.add(ODYSSEY_WORLDS.find(id => id !== g.activeId));   // the player has reached a second world
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.equal(g2.discovered.size, 2, "discovered round-trips");
  assert.ok(g2.discovered.has(g.activeId), "…including the seat");
});

/* ============================================================
   VARIED NEIGHBOUR DIFFICULTY/PERSONALITY. The player's Difficulty and AI Strategy
   picks at setup are a single splash-screen choice — but they must only describe
   the world the player actually lands on. Every OTHER world in the living galaxy
   carries its OWN difficulty and personality (strategy), some easier, some
   harder, independent of what the player picked — so the galaxy is worth
   exploring, and the player has to learn each neighbour's temperament by playing
   it, not read it off a settings screen. Written from the requirement, ahead of
   the implementation (neighbourAiProfile doesn't exist yet as of this test file).
   ============================================================ */

const VALID_DIFFICULTIES = DIFFICULTY_OPTIONS.map(o => o.mult);
const VALID_STRATEGIES = Object.keys(STRATEGIES);

/* ---------- neighbourAiProfile(seed, planetId): the pure per-world pick ---------- */

test("neighbourAiProfile is deterministic — the same seed and planet always resolve the same profile", () => {
  const a = neighbourAiProfile(999, "korrath");
  const b = neighbourAiProfile(999, "korrath");
  assert.deepEqual(a, b);
});

test("neighbourAiProfile always returns a real difficulty key, with aiApm/aiMicro matching THAT difficulty's own dials", () => {
  for (const planetId of ODYSSEY_WORLDS) {
    const p = neighbourAiProfile(4242, planetId);
    assert.ok(VALID_DIFFICULTIES.includes(p.difficulty), `${planetId}: "${p.difficulty}" must be a real difficulty key`);
    const matching = DIFFICULTY_OPTIONS.find(o => o.mult === p.difficulty);
    assert.equal(p.aiApm, matching.aiApm, `${planetId}: aiApm must belong to the SAME difficulty entry as p.difficulty`);
    assert.equal(p.aiMicro, matching.aiMicro, `${planetId}: aiMicro must belong to the SAME difficulty entry as p.difficulty`);
  }
});

test("neighbourAiProfile always returns a real AI Strategy key", () => {
  for (const planetId of ODYSSEY_WORLDS) {
    const p = neighbourAiProfile(1234, planetId);
    assert.ok(VALID_STRATEGIES.includes(p.aiStrategy), `${planetId}: "${p.aiStrategy}" must be a real STRATEGIES key`);
  }
});

test("neighbourAiProfile produces real variety across the roster — some easier, some harder, not one constant pick", () => {
  const difficulties = new Set(), strategies = new Set();
  for (const planetId of ODYSSEY_WORLDS) {
    const p = neighbourAiProfile(2026, planetId);
    difficulties.add(p.difficulty);
    strategies.add(p.aiStrategy);
  }
  assert.ok(difficulties.size > 1, `expected more than one difficulty across ${ODYSSEY_WORLDS.length} worlds, saw only ${[...difficulties]}`);
  assert.ok(strategies.size > 1, `expected more than one AI Strategy across ${ODYSSEY_WORLDS.length} worlds, saw only ${[...strategies]}`);
});

/* ---------- createGalaxy/addPlanet: only the start world hears the player's pick ---------- */

test("the start world's AI runs at exactly the player's picked difficulty and strategy", () => {
  const g = createGalaxy({ seed: 77, difficulty: "hard", aiApm: 140, aiMicro: true, aiStrategy: "aggressive" });
  const start = g.planets.get(g.activeId);
  assert.equal(start.ai.difficulty, "hard");
  assert.equal(start.ai.apm, 140);
  assert.equal(start.ai.micro, true);
  assert.equal(start.ai.strategy, "aggressive");
});

test("neighbour worlds are NOT forced onto the player's picked difficulty/strategy — real variety exists among them", () => {
  const g = createGalaxy({ seed: 77, difficulty: "hard", aiApm: 140, aiMicro: true, aiStrategy: "aggressive" });
  const neighbours = ODYSSEY_WORLDS.filter(id => id !== g.activeId).map(id => g.planets.get(id));
  assert.equal(neighbours.length, ODYSSEY_WORLDS.length - 1);

  const difficulties = new Set(neighbours.map(s => s.ai.difficulty));
  assert.ok(difficulties.size > 1, `expected varied neighbour difficulty, saw only ${[...difficulties]}`);
  assert.ok([...difficulties].some(d => d !== "hard"), "at least one neighbour must differ from the player's own Hard pick");

  for (const s of neighbours) {
    // Every neighbour's apm/micro must belong to ITS OWN difficulty, never a stale mix of
    // "this world's difficulty key" + "the player's own apm/micro dials".
    const matching = DIFFICULTY_OPTIONS.find(o => o.mult === s.ai.difficulty);
    assert.equal(s.ai.apm, matching.aiApm, `${s.planetId}: apm must match its own difficulty, not the player's`);
    assert.equal(s.ai.micro, matching.aiMicro, `${s.planetId}: micro must match its own difficulty, not the player's`);
  }
});

test("neighbour difficulty/strategy assignment is fully deterministic — same galaxy seed, same roster-wide result", () => {
  const mk = () => createGalaxy({ seed: 555, difficulty: "medium", aiStrategy: "default" });
  const g1 = mk(), g2 = mk();
  for (const id of ODYSSEY_WORLDS) {
    const a = g1.planets.get(id).ai, b = g2.planets.get(id).ai;
    assert.equal(a.difficulty, b.difficulty, `${id}: difficulty must replay identically`);
    assert.equal(a.strategy, b.strategy, `${id}: strategy must replay identically`);
    assert.equal(a.apm, b.apm, `${id}: apm must replay identically`);
    assert.equal(a.micro, b.micro, `${id}: micro must replay identically`);
  }
});

test("a world's varied difficulty/strategy survives a save/load like every other per-planet AI field", () => {
  const g = createGalaxy({ seed: 321, difficulty: "easy", aiStrategy: "economic" });
  const other = ODYSSEY_WORLDS.find(id => id !== g.activeId);
  const before = g.planets.get(other).ai;
  const g2 = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const after = g2.planets.get(other).ai;
  assert.equal(after.difficulty, before.difficulty);
  assert.equal(after.strategy, before.strategy);
});

test("galaxyStatus never exposes a world's AI difficulty or personality, discovered or not — the player learns it only by playing", () => {
  const g = createGalaxy({ seed: 9, difficulty: "hard", aiStrategy: "aggressive" });
  const secondWorld = ODYSSEY_WORLDS.find(id => id !== g.activeId);
  g.discovered.add(secondWorld);   // even once "discovered", the starmap summary must stay silent on this
  const st = galaxyStatus(g);
  for (const w of st.worlds) {
    assert.equal(w.difficulty, undefined, `${w.id}: galaxyStatus must never surface a raw difficulty field`);
    assert.equal(w.aiStrategy, undefined, `${w.id}: galaxyStatus must never surface a raw strategy field`);
  }
});
