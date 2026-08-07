/* ============================================================
   Guards for engine/aiIntel.js — what the AI BELIEVES about its opponent.

   This is the first AI state that can be WRONG (every other read is a fact about the current
   frame), so the properties that matter are not "is the number right" but "is the number honest":

     1. FOG-LIMITED. An unscouted army must not exist as far as the belief is concerned. An
        omniscient read here would be both a cheat and — worse — would delete the scouting
        counter-play the whole design rests on.
     2. "I HAVE SEEN NOTHING" ≠ "I HAVE SEEN AN EMPTY BASE". posture stays null until something is
        actually sighted, and confidence is what separates the two. Collapsing them is how an AI
        ends up confidently raiding into an army it never scouted.
     3. A HIGH-WATER MARK THAT FADES. Only a sighting raises it, only time lowers it — so an army
        stepping out of vision does not erase itself, but five-minute-old intel does decay.
     4. OWNER-PARAMETRIC. Both seats read their own fog and their own enemy. A stray "ai" literal is
        exactly how the two self-play bugs in docs/odyssey-ai-review.md happened.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sightEnemy, updateIntel, readEnemy, enemyIsGreedy, isMilitaryBuilding, INTEL_FADE, INTEL_FULL,
} from "../engine/aiIntel.js";
import { BUILDINGS, UNITS } from "../engine/entities.js";
import { createGameState, createAiController } from "../engine/state.js";
import { FOG_CELL_SIZE } from "../engine/fog.js";

const world = () => {
  const s = createGameState({ planetId: "ferros", seed: 1 });
  // Clear the map so each test states its own situation exactly.
  for (const [id] of [...s.units]) s.units.delete(id);
  for (const [id] of [...s.buildings]) s.buildings.delete(id);
  return s;
};

let nextId = 0;
const addUnit = (s, owner, type, x, y) => {
  const u = { id: `u${nextId++}`, owner, type, x, y, hp: UNITS[type].hp, order: null };
  s.units.set(u.id, u);
  return u;
};
const addBuilding = (s, owner, type, x, y) => {
  const b = { id: `b${nextId++}`, owner, type, x, y, hp: BUILDINGS[type].hp, constructing: false, queue: [] };
  s.buildings.set(b.id, b);
  return b;
};
// Light the fog directly rather than driving updateFog off a scout's sight radius: these tests are
// about what the belief does with a sighting, not about how sight is computed, and stating "the AI
// can see this spot" outright keeps each case readable. Mirrors engine/fog.js's own cell math.
const see = (s, owner, x, y, radius = 400) => {
  const fog = s.fogs[owner];
  const r = Math.ceil(radius / FOG_CELL_SIZE);
  const cx = Math.floor(x / FOG_CELL_SIZE), cy = Math.floor(y / FOG_CELL_SIZE);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (gx < 0 || gy < 0 || gx >= fog.cols || gy >= fog.rows) continue;
      fog.visible[gy * fog.cols + gx] = 1;
      fog.explored[gy * fog.cols + gx] = 1;
    }
};

/* ---------- classification ---------- */

test("military buildings are identified from the DEFINITION, not a hardcoded list", () => {
  // Anything that shoots, projects a defensive aura, or produces a combat unit.
  assert.equal(isMilitaryBuilding(BUILDINGS.turret), true, "a turret shoots");
  assert.equal(isMilitaryBuilding(BUILDINGS.bastille), true, "a bastille shoots");
  assert.equal(isMilitaryBuilding(BUILDINGS.barracks), true, "a barracks produces combat units");
  assert.equal(isMilitaryBuilding(BUILDINGS.refinery), false);
  assert.equal(isMilitaryBuilding(BUILDINGS.habitat), false);
  // A Command Center produces only workers and support, so it reads as economy — it is what a
  // greedy player is PROTECTING, not what they are threatening you with.
  assert.equal(isMilitaryBuilding(BUILDINGS.command), false, "a Command Center is economy");
  assert.equal(isMilitaryBuilding(undefined), false, "an unknown def must not throw");
});

test("every shipped building classifies without throwing", () => {
  for (const [id, def] of Object.entries(BUILDINGS))
    assert.equal(typeof isMilitaryBuilding(def), "boolean", `${id} did not classify`);
});

/* ---------- fog limits ---------- */

test("an unscouted army does not exist as far as the belief is concerned", () => {
  const s = world();
  addUnit(s, "player", "skiff", 2000, 2000);
  addUnit(s, "player", "skiff", 2010, 2000);
  assert.deepEqual(sightEnemy(s, "ai"), { mil: 0, eco: 0 }, "unseen enemies must not be counted");
  updateIntel(s, "ai");
  const r = readEnemy(s, "ai");
  assert.equal(r.posture, null, "never having seen anything must read as 'I do not know'");
  assert.equal(r.confidence, 0);
});

test("what it can see, it counts — split into military and economy", () => {
  const s = world();
  addUnit(s, "player", "skiff", 100, 100);          // combat
  addUnit(s, "player", "worker", 120, 100);         // economy
  addBuilding(s, "player", "turret", 140, 100);     // military
  addBuilding(s, "player", "refinery", 160, 100);   // economy
  see(s, "ai", 130, 100);
  const live = sightEnemy(s, "ai");
  const val = c => Object.values(c || {}).reduce((a, v) => a + v, 0);
  assert.equal(live.mil, val(UNITS.skiff.cost) + val(BUILDINGS.turret.cost));
  assert.equal(live.eco, val(UNITS.worker.cost) + val(BUILDINGS.refinery.cost));
});

test("it never counts its OWN units as the enemy's", () => {
  const s = world();
  addUnit(s, "ai", "skiff", 100, 100);
  addBuilding(s, "ai", "turret", 120, 100);
  see(s, "ai", 110, 100);
  assert.deepEqual(sightEnemy(s, "ai"), { mil: 0, eco: 0 });
});

/* ---------- "seen nothing" vs "seen an empty base" ---------- */

test("an empty base that HAS been looked at is not the same as never having looked", () => {
  const s = world();
  addBuilding(s, "player", "refinery", 100, 100);
  see(s, "ai", 100, 100);
  updateIntel(s, "ai");
  const r = readEnemy(s, "ai");
  assert.equal(r.posture, 0, "all economy, no military => a pure economy read");
  assert.ok(r.confidence > 0, "having actually seen something must produce non-zero confidence");
  // …and the never-looked case above reads posture null with confidence 0. The two are distinct,
  // which is the entire reason confidence exists as a separate number.
});

test("confidence needs BOTH enough seen and recently seen", () => {
  const s = world();
  addBuilding(s, "player", "refinery", 100, 100);
  see(s, "ai", 100, 100);
  s.time = 0;
  updateIntel(s, "ai");
  const fresh = readEnemy(s, "ai").confidence;

  // Same sighting, gone stale: the belief survives but confidence in it does not.
  s.time = INTEL_FADE / 2;
  const half = readEnemy(s, "ai").confidence;
  assert.ok(half < fresh && half > 0, `staleness must erode confidence (${fresh} -> ${half})`);
  s.time = INTEL_FADE + 1;
  assert.equal(readEnemy(s, "ai").confidence, 0, "intel older than the fade window is worth nothing");
});

test("confidence saturates on how much has been seen, not on a single glimpse", () => {
  const s = world();
  addUnit(s, "player", "worker", 100, 100);
  see(s, "ai", 100, 100);
  updateIntel(s, "ai");
  const oneWorker = readEnemy(s, "ai").confidence;
  assert.ok(oneWorker < 0.5, `one worker must not make the AI confident (got ${oneWorker})`);
  // A whole base's worth does.
  for (let i = 0; i < 12; i++) addBuilding(s, "player", "refinery", 100 + i, 100);
  updateIntel(s, "ai");
  assert.ok(readEnemy(s, "ai").confidence > oneWorker, "seeing more must raise confidence");
});

/* ---------- the high-water mark ---------- */

test("an army that walks out of vision is remembered, not forgotten", () => {
  const s = world();
  const skiffs = [addUnit(s, "player", "skiff", 100, 100), addUnit(s, "player", "skiff", 110, 100)];
  see(s, "ai", 105, 100);
  s.time = 10;
  updateIntel(s, "ai");
  const seenMil = readEnemy(s, "ai").mil;
  assert.ok(seenMil > 0);

  // They leave. A live-only read would collapse to zero here — which is exactly the failure mode
  // this module exists to avoid, since it would make the AI forget an army the moment it blinked.
  for (const u of skiffs) { u.x = 3000; u.y = 3000; }
  s.time = 20;
  updateIntel(s, "ai");
  assert.ok(readEnemy(s, "ai").mil > 0, "the belief must survive losing sight of the army");
});

test("only a sighting raises the estimate; only time lowers it", () => {
  const s = world();
  addUnit(s, "player", "skiff", 100, 100);
  see(s, "ai", 100, 100);
  s.time = 0;
  updateIntel(s, "ai");
  const first = readEnemy(s, "ai").mil;

  // Seeing MORE raises it.
  addUnit(s, "player", "skiff", 105, 100);
  updateIntel(s, "ai");
  const grown = readEnemy(s, "ai").mil;
  assert.ok(grown > first, "a bigger sighting must raise the belief");

  // Time with nothing in sight lowers it, and eventually to nothing.
  for (const u of [...s.units.values()]) if (u.owner === "player") { u.x = 4000; u.y = 4000; }
  s.time = INTEL_FADE * 0.5;
  updateIntel(s, "ai");
  const faded = readEnemy(s, "ai").mil;
  assert.ok(faded > 0 && faded < grown, `time must fade the belief (${grown} -> ${faded})`);
  s.time = INTEL_FADE * 3;
  updateIntel(s, "ai");
  assert.equal(readEnemy(s, "ai").mil, 0, "a long-unrefreshed belief must fade to nothing");
});

/* ---------- posture ---------- */

test("posture reads 0 for a pure economy game and 1 for a pure war game", () => {
  const eco = world();
  for (let i = 0; i < 4; i++) addUnit(eco, "player", "worker", 100 + i * 5, 100);
  addBuilding(eco, "player", "refinery", 130, 100);
  see(eco, "ai", 110, 100);
  updateIntel(eco, "ai");
  assert.equal(readEnemy(eco, "ai").posture, 0);

  const war = world();
  for (let i = 0; i < 4; i++) addUnit(war, "player", "skiff", 100 + i * 5, 100);
  addBuilding(war, "player", "turret", 130, 100);
  see(war, "ai", 110, 100);
  updateIntel(war, "ai");
  assert.equal(readEnemy(war, "ai").posture, 1);
});

test("a mixed opponent reads between the two", () => {
  const s = world();
  addUnit(s, "player", "skiff", 100, 100);
  addUnit(s, "player", "worker", 110, 100);
  see(s, "ai", 105, 100);
  updateIntel(s, "ai");
  const p = readEnemy(s, "ai").posture;
  assert.ok(p > 0 && p < 1, `a mixed game must read between the extremes (got ${p})`);
});

/* ---------- the greed predicate ---------- */

test("enemyIsGreedy needs BOTH a low posture and enough confidence", () => {
  const s = world();
  // A single worker: greedy-looking, but far too little seen to act on.
  addUnit(s, "player", "worker", 100, 100);
  see(s, "ai", 100, 100);
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), false, "one worker is not grounds to commit a raid");

  // A whole economy, clearly seen.
  for (let i = 0; i < 10; i++) addBuilding(s, "player", "refinery", 100 + i * 2, 100);
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), true, "a scouted, undefended economy is exactly the target");

  // …and an army alongside it is not greed any more.
  for (let i = 0; i < 30; i++) addUnit(s, "player", "skiff", 100 + i, 105);
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), false, "an enemy with a real army must not read as greedy");
});

test("never having scouted must never read as greedy — hedge, do not assume weakness", () => {
  const s = world();
  for (let i = 0; i < 20; i++) addBuilding(s, "player", "refinery", 2000 + i, 2000);   // unseen
  updateIntel(s, "ai");
  assert.equal(enemyIsGreedy(s, "ai"), false,
    "an unscouted enemy must not be treated as undefended — that is how an AI walks into an army");
});

/* ---------- owner-parametric ---------- */

test("both seats read their OWN fog and their OWN enemy", () => {
  const s = world();
  s.playerAi = createAiController("ferros", {});
  addUnit(s, "player", "skiff", 100, 100);      // the "ai" seat's enemy
  addUnit(s, "ai", "worker", 900, 900);         // the "player" seat's enemy
  see(s, "ai", 100, 100);                       // only the ai seat can see the skiff
  see(s, "player", 900, 900);                   // only the player seat can see the worker

  updateIntel(s, "ai");
  updateIntel(s, "player");
  const ai = readEnemy(s, "ai"), pl = readEnemy(s, "player");
  assert.equal(ai.posture, 1, "the ai seat sees only an enemy skiff => pure war");
  assert.equal(pl.posture, 0, "the player seat sees only an enemy worker => pure economy");
  // Each belief lives on its own controller — no shared object, no leak.
  assert.ok(s.ai.intelMil > 0 && s.ai.intelEco === 0);
  assert.ok(s.playerAi.intelEco > 0 && s.playerAi.intelMil === 0);
});

test("driving a 'player' seat with no controller configured is a silent no-op", () => {
  const s = world();
  assert.doesNotThrow(() => updateIntel(s, "player"));
  assert.deepEqual(readEnemy(s, "player"), { posture: null, confidence: 0, mil: 0, eco: 0, age: null });
});

/* ---------- determinism ---------- */

test("the read is a pure function of state — same state, same answer", () => {
  const build = () => {
    const s = world();
    addUnit(s, "player", "skiff", 100, 100);
    addBuilding(s, "player", "refinery", 120, 100);
    see(s, "ai", 110, 100);
    s.time = 42;
    updateIntel(s, "ai");
    return JSON.stringify(readEnemy(s, "ai"));
  };
  assert.equal(build(), build());
});
