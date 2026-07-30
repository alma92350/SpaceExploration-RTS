/* ============================================================
   AI LAB — a headless bench for the Odyssey opponent, so "is this AI any good?"
   becomes a measurement instead of an opinion.

   The engine test suite already guards INVARIANTS (determinism, purity, "a skirmish
   resolves to a winner"). Nothing measures QUALITY: whether the neighbour on an
   Odyssey world develops, spends what it earns, and applies pressure in proportion to
   how hostile it has become. Those are curves over 30–60 minutes of sim, not
   assertions, and they're exactly what breaks silently when an archetype number moves.

   This tool runs the sim headlessly (it's already pure and deterministic — that's the
   whole reason this is cheap), samples an AI-quality metric set on a fixed cadence, and
   prints a scoreboard. Because the AI's whole behaviour space is three plain-data
   tables — ARCHETYPES × STRATEGIES × DIFFICULTY_OPTIONS, all read through defensive
   `|| 1` accessors — a candidate strategy is a JSON object, not a code change: pass
   --overrides and the lab writes new rows into those tables before it runs. So
   searching for a better AI needs no engine edit at all.

   Usage
     node tools/ailab.js probe   [--world ferros] [--strategy default] [--difficulty medium]
                                 [--opponent passive] [--minutes 40] [--sample 5]
     node tools/ailab.js sweep   [--worlds a,b] [--strategies a,b] [--difficulties a,b]
                                 [--seeds 3] [--minutes 40] [--json out.json] [--csv out.csv]
     node tools/ailab.js compare --baseline base.json --candidate cand.json
     node tools/ailab.js search  --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'
                                 [--trials 24] [--worlds a,b]
     node tools/ailab.js check   [--worlds a,b] [--minutes 60]      # health checks (stall/hoard/flatline)

   Common flags
     --overrides f.json   inject rows into the AI tables before running, e.g.
                          { "strategies": { "swarm": { "armyAttackSizeMult": 0.5 } },
                            "archetypes": { "rusher": { "odyssey": { "workerTarget": 9 } } },
                            "difficulties": { "hard": { "workerTargetMult": 1.4 } } }
     --seed N             base seed (default 1) — every run is reproducible from it

   Deterministic by construction: every world seeds from mulberry32, every sparring
   opponent is scripted off the sim clock, and no wall-clock or Math.random is read. Two
   runs of the same command produce byte-identical numbers.

   Lives in tools/ (a dev bench, like tools/serve.js) — NOT in engine/, which stays the
   pure shipped simulation. It only ever READS the engine's public API.
   ============================================================ */

"use strict";

import { readFileSync, writeFileSync } from "node:fs";
import { createGameState } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { createDiplomacy, hostility, aiDevelopment, provoked } from "../engine/diplomacy.js";
import { strategyFor } from "../engine/aiStrategy.js";
import { issueAttackMove } from "../engine/commands.js";
import { createMarket } from "../engine/market.js";
import { deployColonyShip } from "../engine/colony.js";
import { findPlacement } from "../engine/colliders.js";
import { issueBuild } from "../engine/commands.js";
import { queueProduction } from "../engine/production.js";
import { supplyUsed, supplyCap } from "../engine/supply.js";
import { BUILDINGS, UNITS, canAfford } from "../engine/entities.js";
import { pickNextUnitType } from "../engine/aiMilitary.js";
import { ARCHETYPES, archetypeFor, PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE } from "../engine/aiArchetypes.js";
import { STRATEGIES } from "../engine/aiStrategy.js";
import { DIFFICULTY_OPTIONS } from "../engine/aiDifficulty.js";
import { mulberry32, hashStr } from "../engine/rng.js";

const WORLDS = [...Object.keys(PLANET_ARCHETYPE), ...Object.keys(ODYSSEY_EXTRA_ARCHETYPE)];
const DT = 0.1;                  // the sim's fixed step, same as the game loop
const THINK = 1.5;               // sparring-bot decision cadence, matching the AI's own think interval

/* ============================================================
   THE LAB WORLD
   ============================================================ */

// One Odyssey world, built exactly the way engine/galaxy.js addPlanet builds a neighbour:
// endless, with its own market and diplomacy, the archetype's faction, and the AI dials under
// test. The `opponent` decides what the player side is, which is what the AI is actually being
// measured against — see the sparring bots below.
function labWorld({ world, strategy, difficulty, opponent, seed }) {
  const s = createGameState({
    planetId: world, seed, rng: mulberry32(seed), endless: true,
    aiStrategy: strategy, difficulty,
    aiApm: null, aiMicro: !!DIFFICULTY_OPTIONS.find(o => o.mult === difficulty)?.aiMicro,
    aiFaction: archetypeFor(world).faction,
  });
  s.diplomacy = createDiplomacy();
  s.market = createMarket(s);
  s.inGalaxy = true;             // galaxy states never resolve per-world (engine/victory.js)
  const bot = OPPONENTS[opponent];
  if (!bot) throw new Error(`unknown opponent "${opponent}" — one of: ${Object.keys(OPPONENTS).join(", ")}`);
  bot.setup(s);
  return { state: s, bot };
}

/* ============================================================
   SPARRING OPPONENTS — what the AI is measured against

   An Odyssey neighbour with nobody to react to is playing solitaire, so a metric taken
   with no opponent only measures its build order. Each bot below drives the "player"
   side through the engine's PUBLIC command API (the same calls input.js makes), off the
   sim clock, with no randomness — so a measurement is repeatable and the difference
   between two AI configs is the only thing that moves.

   These are deliberately dumb and legible. A sparring partner you can't describe in a
   sentence makes a scoreboard you can't interpret.
   ============================================================ */

const playerUnitsOf = (s, type) => [...s.units.values()].filter(u => u.owner === "player" && u.type === type);
const playerBuildingsOf = (s, type) =>
  [...s.buildings.values()].filter(b => b.owner === "player" && (!type || b.type === type));

// Deploy the opening colony ship into a real Command Center — every bot but `none` starts here,
// because an undeployed ship is a foothold the AI's wave logic reads but can't meaningfully fight.
function seatBase(s) {
  const ship = playerUnitsOf(s, "colonyship")[0];
  if (ship) deployColonyShip(s, ship.id);
}

// Keep idle player workers mining, using the PLAYER's own fog for discovery (the AI's
// assignIdleWorkers reads state.fogAI, so it can't be reused here without handing the bot
// the AI's intel). Nearest live discovered node, ore first — deliberately simpler than the
// AI's saturation-aware steering, since the bot is a yardstick, not a contender.
function botGather(s) {
  const live = s.map.nodes.filter(n => n.amount > 0 && !n.hidden);
  if (!live.length) return;
  const ore = live.filter(n => n.com === "ore");
  for (const w of playerUnitsOf(s, "worker")) {
    if (w.order) continue;
    const pool = ore.length ? ore : live;
    let best = null, bestD = Infinity;
    for (const n of pool) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best) w.order = { type: "gather", nodeId: best.id };
  }
}

// Put `type` down near the player's CC, sliding off collisions the same way the AI does.
function botBuild(s, type, dx, dy) {
  const cc = playerBuildingsOf(s, "command").find(b => !b.constructing);
  const worker = playerUnitsOf(s, "worker").find(w => !w.order || w.order.type === "gather");
  if (!cc || !worker || !canAfford(s.players.player.resources, BUILDINGS[type].cost)) return false;
  const spot = findPlacement(s, type, cc.x + dx, cc.y + dy);
  return !!spot && issueBuild(s, worker.id, type, spot.x, spot.y);
}

const OPPONENTS = {
  // A living-galaxy BACKGROUND world: no player at all. This is what 10 of the 11 worlds
  // actually are for most of an Odyssey, so it's the honest setting for measuring the
  // development curve — and the one where a frozen build order shows up bare.
  none: {
    desc: "no player at all (a living-galaxy background world)",
    setup(s) {
      for (const [id, u] of [...s.units]) if (u.owner === "player") s.units.delete(id);
      for (const [id, b] of [...s.buildings]) if (b.owner === "player") s.buildings.delete(id);
      s.background = true;
    },
    think() {},
  },

  // Seats a base and then does NOTHING — the "player who wandered off". Measures whether
  // pressure ever actually arrives: an AI that can't beat this one will never threaten anyone.
  passive: {
    desc: "seats a Command Center, then never acts again",
    setup: seatBase,
    think() {},
  },

  // A real economy that never attacks: workers to target, Habitats ahead of the cap, a
  // Barracks, defenders, and turrets. The yardstick for "can the AI crack a defended base",
  // which is the question that actually matters for an Odyssey neighbour.
  turtle: {
    // NB it can still provoke: its turrets kill the AI's scouts, which counts as the player
    // destroying the neighbour's ships (engine/diplomacy.js). `passive` is the only bot that never
    // draws blood at all.
    desc: "economy + static defence, never attacks (the base-cracking yardstick)",
    setup: seatBase,
    think(s) {
      botGather(s);
      const cc = playerBuildingsOf(s, "command").find(b => !b.constructing);
      if (!cc) return;
      const res = s.players.player.resources;
      const workers = playerUnitsOf(s, "worker").length;
      if (workers < 12 && cc.queue.length === 0) { queueProduction(s, cc.id, "worker"); return; }
      if (supplyUsed(s, "player") >= supplyCap(s, "player") - 4
          && !playerBuildingsOf(s, "habitat").some(b => b.constructing)) { botBuild(s, "habitat", 0, 90); return; }
      const rax = playerBuildingsOf(s, "barracks").filter(b => !b.constructing);
      if (!playerBuildingsOf(s, "barracks").length) { botBuild(s, "barracks", 90, -90); return; }
      if (playerBuildingsOf(s, "turret").length < 4 && canAfford(res, BUILDINGS.turret.cost)) {
        const i = playerBuildingsOf(s, "turret").length;
        if (botBuild(s, "turret", 120 - 60 * (i % 2), 120 * (i < 2 ? 1 : -1))) return;
      }
      // A standing guard, cheapest-first so the bot's composition never depends on tech it
      // hasn't built. Units hold at the rally point; the bot never issues an attack order.
      const idle = rax.find(b => b.queue.length === 0);
      if (idle && canAfford(res, UNITS.skiff.cost)) queueProduction(s, idle.id, "skiff");
    },
  },

  // The only bot that PROVOKES. A `neverInitiates` neighbour is entitled to answer a player who
  // has drawn blood (engine/diplomacy.js provoked()), so measuring whether Economic / Force Parity
  // ever push back needs an opponent that actually fights — the other three never do, and against
  // them those strategies are SUPPOSED to stay quiet. Deterministic: it commits whenever six idle
  // combat units have accumulated, off the sim clock, with no randomness.
  skirmisher: {
    desc: "turtle economy that throws its army at the AI whenever it musters one (the only bot that provokes)",
    setup: seatBase,
    think(s) {
      OPPONENTS.turtle.think(s);
      const idle = [...s.units.values()].filter(u =>
        u.owner === "player" && UNITS[u.type].role === "combat" && (!u.order || u.order.type === "move"));
      if (idle.length >= 6) issueAttackMove(idle, s.map.bases.ai.x, s.map.bases.ai.y);
    },
  },
};

/* ============================================================
   METRICS

   Everything here is read off sim state, never off the AI's own bookkeeping where a
   cheaper read exists — the point is to measure what the AI DID, not what it intended.
   ============================================================ */

const oreValue = cost => (cost.ore || 0) + 2 * (cost.crystals || 0) + 2 * (cost.radioactives || 0);

function sample(s) {
  const ai = [...s.units.values()].filter(u => u.owner === "ai");
  const army = ai.filter(u => UNITS[u.type].role === "combat");
  const done = [...s.buildings.values()].filter(b => b.owner === "ai" && !b.constructing);
  const rax = done.filter(b => b.type === "barracks");
  const res = s.players.ai.resources;
  const banked = oreValue(res);
  const next = rax.length ? pickNextUnitType(s, s.ai.archetype) : null;
  return {
    t: Math.round(s.time),
    workers: ai.filter(u => u.type === "worker").length,
    army: army.length,
    armyValue: army.reduce((v, u) => v + oreValue(UNITS[u.type].cost), 0),
    dev: aiDevelopment(s),
    buildings: done.length,
    banked: Math.round(banked),
    stance: +s.diplomacy.stance.toFixed(3),
    hostility: +hostility(s).toFixed(3),
    waves: s.ai.waveCount || 0,
    // IDLE PRODUCTION: a completed Barracks with an empty queue while the AI is sitting on
    // real money. Not "it's between jobs" — it's the signature of an AI that has run out of
    // things it knows how to buy, which in a play-forever mode is the failure that matters.
    idleRax: rax.filter(b => b.queue.length === 0).length,
    rax: rax.length,
    // Is the next mix entry unaffordable in SUPPLY specifically? The mix cycle retries the same
    // entry until it succeeds, so a unit that doesn't fit under the cap wedges production —
    // and the Habitat trigger only fires within 2 supply of the cap, which doesn't cover the
    // 4- and 8-supply Odyssey units. That combination is a hard deadlock, so it's measured.
    supplyBlocked: !!next && supplyUsed(s, "ai") + (UNITS[next].supplyCost || 0) > supplyCap(s, "ai"),
    supplyFree: +(supplyCap(s, "ai") - supplyUsed(s, "ai")).toFixed(1),
    playerBuildings: playerBuildingsOf(s).length,
    aiAlive: done.some(b => b.type === "command"),
    // ENTITLED to attack right now? Odyssey draws a line between a strategy that goes looking for
    // a fight and one that only answers being provoked (engine/aiStrategy.js neverInitiates +
    // engine/diplomacy.js provoked()). "Hostile and idle" is only a defect on the near side of
    // that line — a neighbour leaving an unprovoked player alone is the contract working, and
    // scoring it as a failure would push the tuning loop toward breaking it.
    entitled: !strategyFor(s).neverInitiates || provoked(s),
    provokedAi: provoked(s),   // has the player drawn blood / started a Gate? (diagnostic + the `entitled` input)
  };
}

// Run one configuration and fold its samples into a result row. `minutes` is SIM time; a
// 40-minute world costs a few seconds of wall clock, which is what makes a sweep practical.
function run(cfg) {
  const { state, bot } = labWorld(cfg);
  const stepsPerSample = Math.round(cfg.sample * 60 / DT);
  const total = Math.round(cfg.minutes * 60 / DT);
  const curve = [];
  let sinceThink = 0;
  for (let i = 0; i < total; i++) {
    tick(state, DT);
    sinceThink += DT;
    if (sinceThink >= THINK) { sinceThink = 0; bot.think(state); }
    if (i % stepsPerSample === 0) curve.push(sample(state));
  }
  curve.push(sample(state));
  return { ...cfg, curve, ...summarise(curve) };
}

// Collapse a curve into the handful of numbers a scoreboard can rank. Deliberately few: a
// metric nobody can act on is noise.
function summarise(curve) {
  const last = curve[curve.length - 1];
  const peak = key => curve.reduce((m, c) => Math.max(m, c[key]), 0);
  // The tail is the last third of the run — the play-forever regime, where an AI whose plan
  // has run out looks identical to one that's still going unless you look at the derivative.
  const tail = curve.slice(Math.floor(curve.length * 2 / 3));
  const devGrowthTail = tail.length > 1 ? tail[tail.length - 1].dev - tail[0].dev : 0;
  const armyGrowthTail = tail.length > 1 ? tail[tail.length - 1].army - tail[0].army : 0;
  const firstWave = curve.find(c => c.waves > 0);
  // Only samples where the AI was BOTH hostile and entitled to act on it (see sample().entitled).
  const hostileSamples = curve.filter(c => c.hostility >= 0.5 && c.playerBuildings > 0 && c.entitled);
  return {
    devFinal: last.dev,
    devGrowthTail,
    armyFinal: last.army,
    armyValueFinal: last.armyValue,
    armyGrowthTail,
    workersFinal: last.workers,
    buildingsFinal: last.buildings,
    bankedFinal: last.banked,
    bankedPeak: peak("banked"),
    waves: last.waves,
    firstWaveAt: firstWave ? firstWave.t : null,
    // Fraction of the run spent hostile-but-idle: the neighbour reads "Hostile" in the HUD
    // while never committing a wave. The single most player-visible AI failure in Odyssey.
    hostileIdleFrac: hostileSamples.length
      ? +(hostileSamples.filter(c => c.waves === 0).length / hostileSamples.length).toFixed(2) : 0,
    // How much of the run the AI actually had standing to attack. Zero means the question
    // "did it apply pressure?" was never asked of it — scored the same way an opponent-less run is.
    entitledSamples: hostileSamples.length,
    // Fraction of samples where EVERY Barracks stood idle while the AI held real money — i.e. it
    // had nothing left it knew how to buy. Deliberately "every", not "any": once surplus opens
    // extra Barracks, one of six sitting between jobs is ordinary churn, and an "any" test fired on
    // 42 of 44 healthy runs. This is the version that distinguishes a working production line from
    // a stopped one.
    idleRichFrac: +(curve.filter(c => c.rax > 0 && c.idleRax === c.rax && c.banked > 1000).length / curve.length).toFixed(2),
    supplyDeadlockFrac: +(curve.filter(c => c.supplyBlocked && c.banked > 400).length / curve.length).toFixed(2),
    stanceFinal: last.stance,
    playerBuildingsFinal: last.playerBuildings,
    aiAlive: last.aiAlive,
  };
}

/* ============================================================
   SCORING — one number to rank candidates, and the components that explain it

   A scalar is what a search loop needs; the components are what a HUMAN needs to accept
   or reject the result. Both are printed, always. Weights are here in the open so an
   argument about what "better AI" means is an argument about these six lines, not about
   the harness.
   ============================================================ */

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

export const WEIGHTS = {
  develop: 0.25,     // climbs the industry/tech chain rather than flatlining on a 2-building base
  keepGrowing: 0.2,  // and is STILL growing in the last third — the play-forever requirement
  pressure: 0.25,    // commits waves when it has actually turned hostile
  thrift: 0.15,      // spends what it earns instead of banking an unusable pile
  liveness: 0.1,     // production never wedges (idle Barracks on real money)
  survive: 0.05,     // still holds a Command Center at the end
};

export function score(r) {
  const parts = {
    develop: clamp01(r.devFinal / 20),                      // ~20 = the full chain + most of the tree
    keepGrowing: clamp01((r.devGrowthTail + Math.max(0, r.armyGrowthTail) / 5) / 4),
    pressure: r.hostileIdleFrac > 0 ? clamp01(1 - r.hostileIdleFrac) : clamp01(r.waves / 6),
    // What it ENDED holding, not what it ever touched: a working economy peaks high and spends it
    // straight back down, so a peak-based measure scored a healthy AI the same as a stalled one.
    thrift: clamp01(1 - r.bankedFinal / 8000),
    liveness: clamp01(1 - Math.max(r.idleRichFrac, r.supplyDeadlockFrac)),
    survive: r.aiAlive ? 1 : 0,
  };
  // "Did it apply pressure?" is only a fair question when it was ever ASKED — there was somebody
  // to attack (not the `none` opponent) and the AI had standing to attack them (an initiating
  // strategy, or a provoked one). Otherwise drop the component and renormalise the remaining
  // weights, rather than quietly scoring an unanswerable question as a failure and pushing the
  // tuning loop toward an AI that attacks players who have done nothing to it.
  const askable = r.opponent !== "none" && r.entitledSamples > 0;
  const applicable = Object.keys(WEIGHTS).filter(k => !(k === "pressure" && !askable));
  const wsum = applicable.reduce((a, k) => a + WEIGHTS[k], 0);
  const total = applicable.reduce((sum, k) => sum + (WEIGHTS[k] / wsum) * parts[k], 0);
  if (!askable) delete parts.pressure;
  return { total: +total.toFixed(3), parts };
}

/* ============================================================
   OVERRIDES — a candidate AI is DATA, not a patch

   ARCHETYPES / STRATEGIES / DIFFICULTY_OPTIONS are plain exported objects read through
   `|| 1`-style accessors, so writing a row into them before a run is the whole mechanism
   for trying a new AI. That's why searching this space needs no engine change: the search
   space is already a JSON document.
   ============================================================ */

export function applyOverrides(ov = {}) {
  for (const [name, row] of Object.entries(ov.strategies || {}))
    STRATEGIES[name] = { name, desc: "(lab candidate)", ...(STRATEGIES[name] || {}), ...row };
  for (const [name, row] of Object.entries(ov.archetypes || {})) {
    const base = ARCHETYPES[name] || ARCHETYPES.balanced;
    ARCHETYPES[name] = { ...base, ...row, odyssey: { ...(base.odyssey || {}), ...(row.odyssey || {}) } };
  }
  for (const [key, row] of Object.entries(ov.difficulties || {})) {
    const i = DIFFICULTY_OPTIONS.findIndex(o => o.mult === key);
    if (i >= 0) DIFFICULTY_OPTIONS[i] = { ...DIFFICULTY_OPTIONS[i], ...row };
  }
}

/* ============================================================
   HEALTH CHECKS — the findings this bench already turned up, encoded

   Each is a named, reproducible defect rather than a paragraph in a review doc: run the
   check, get the list of worlds it fires on. Fix the AI and the list shrinks. These are
   REPORTED, not asserted — the tool's job is to measure, and today several of them fire.
   ============================================================ */

export const CHECKS = [
  { id: "supply-deadlock",
    why: "the mix cycle retries one unit forever because it doesn't fit under the supply cap, "
       + "while the Habitat trigger (used >= cap - 2) never fires for a 4- or 8-supply unit",
    hit: r => r.supplyDeadlockFrac > 0.1 },
  { id: "hoarding",
    why: "it finished sitting on a large bank AND its army hadn't grown — money it has no way to "
       + "spend, rather than a working balance in transit",
    hit: r => r.bankedFinal > 5000 && r.armyGrowthTail <= 0 },
  { id: "dev-flatline",
    why: "the industry/tech climb stopped: no development gained in the last third of the run",
    hit: r => r.devGrowthTail === 0 && r.devFinal < 12 },
  { id: "hostile-but-idle",
    why: "the HUD reads Hostile, the neighbour is entitled to act on it, and it never commits a wave "
       + "(samples where a never-initiating strategy was left unprovoked don't count — that's the contract)",
    hit: r => r.entitledSamples > 0 && r.hostileIdleFrac > 0.5 },
  { id: "production-stall",
    why: "a completed Barracks stood idle while the AI held real money",
    hit: r => r.idleRichFrac > 0.25 },
];

/* ============================================================
   CLI
   ============================================================ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : "true";
    else out._.push(a);
  }
  return out;
}

const list = (v, fallback) => (v ? String(v).split(",").map(x => x.trim()).filter(Boolean) : fallback);
const num = (v, d) => (v === undefined ? d : Number(v));

// Just the dials under search, so a search log shows what moved rather than the whole row.
const pickDials = (row, dials) => Object.fromEntries(dials.map(d => [d.k, row[d.k]]));

// Every run's seed is derived from (base seed, world, strategy, difficulty, replicate) so a
// row reproduces on its own — you can re-probe exactly one line of a sweep.
const runSeed = (base, world, strategy, difficulty, rep) =>
  hashStr(`${base}:${world}:${strategy}:${difficulty}:${rep}`);

function baseConfig(args) {
  return {
    minutes: num(args.minutes, 40),
    sample: num(args.sample, 5),
    opponent: args.opponent || "passive",
    seedBase: num(args.seed, 1),
  };
}

function runMatrix(args, { worlds, strategies, difficulties, seeds }) {
  const base = baseConfig(args);
  const rows = [];
  for (const world of worlds)
    for (const strategy of strategies)
      for (const difficulty of difficulties)
        for (let rep = 0; rep < seeds; rep++)
          rows.push(run({ ...base, world, strategy, difficulty,
                          seed: runSeed(base.seedBase, world, strategy, difficulty, rep) }));
  return rows;
}

const pad = (v, w) => String(v).padEnd(w);
const padL = (v, w) => String(v).padStart(w);

function printTable(rows) {
  const cols = [
    ["world", 10, r => r.world], ["strategy", 11, r => r.strategy], ["diff", 7, r => r.difficulty],
    ["score", 6, r => score(r).total], ["dev", 4, r => r.devFinal], ["+dev", 5, r => r.devGrowthTail],
    ["army", 5, r => r.armyFinal], ["wrk", 4, r => r.workersFinal], ["bank", 7, r => r.bankedPeak],
    ["waves", 6, r => r.waves], ["idle%", 6, r => r.idleRichFrac], ["hostIdle", 9, r => r.hostileIdleFrac],
  ];
  console.log(cols.map(([h, w]) => pad(h, w)).join(""));
  console.log(cols.map(([, w]) => "-".repeat(w - 1) + " ").join(""));
  for (const r of rows) console.log(cols.map(([, w, f]) => pad(f(r), w)).join(""));
}

function printFindings(rows) {
  console.log("\nHealth checks (a row here is a reproducible defect, not a style note):");
  let any = false;
  for (const c of CHECKS) {
    const hits = rows.filter(c.hit);
    if (!hits.length) { console.log(`  ok    ${pad(c.id, 20)} —`); continue; }
    any = true;
    console.log(`  FIRES ${pad(c.id, 20)} ${hits.length}/${rows.length} runs`);
    console.log(`        ${c.why}`);
    console.log(`        ${hits.slice(0, 6).map(r => `${r.world}/${r.strategy}/${r.difficulty}`).join("  ")}`
      + (hits.length > 6 ? `  …+${hits.length - 6}` : ""));
  }
  if (!any) console.log("  (clean)");
}

const CMDS = {
  probe(args) {
    const base = baseConfig(args);
    const cfg = {
      ...base,
      world: args.world || "ferros",
      strategy: args.strategy || "default",
      difficulty: args.difficulty || "medium",
    };
    const r = run({ ...cfg, seed: runSeed(base.seedBase, cfg.world, cfg.strategy, cfg.difficulty, 0) });
    console.log(`${cfg.world} · ${cfg.strategy} · ${cfg.difficulty} · vs ${OPPONENTS[cfg.opponent].desc}`);
    console.log("\ntime  wrk army  dev bldg   banked  waves stance  supplyFree  idleRax");
    for (const c of r.curve)
      console.log(`${padL(Math.round(c.t / 60) + "m", 4)} ${padL(c.workers, 4)} ${padL(c.army, 3)} `
        + `${padL(c.dev, 4)} ${padL(c.buildings, 4)} ${padL(c.banked, 8)} ${padL(c.waves, 6)} `
        + `${padL(c.stance, 6)} ${padL(c.supplyFree, 11)} ${padL(c.idleRax, 8)}`);
    const sc = score(r);
    console.log(`\nscore ${sc.total}  ` + Object.entries(sc.parts).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  "));
    printFindings([r]);
  },

  sweep(args) {
    const rows = runMatrix(args, {
      worlds: list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]),
      strategies: list(args.strategies, Object.keys(STRATEGIES)),
      difficulties: list(args.difficulties, ["medium"]),
      seeds: num(args.seeds, 1),
    });
    printTable(rows);
    const mean = rows.reduce((a, r) => a + score(r).total, 0) / rows.length;
    console.log(`\nmean score ${mean.toFixed(3)} over ${rows.length} runs`);
    printFindings(rows);
    if (args.json) {
      // Summary rows only unless --full: a saved sweep is meant to be read (by you or by
      // Claude) and diffed against the next one, and the per-sample curve buries the
      // handful of numbers a decision actually turns on.
      const out = rows.map(({ curve, ...r }) => ({ ...r, score: score(r), ...(args.full === "true" ? { curve } : {}) }));
      writeFileSync(args.json, JSON.stringify(out, null, 1));
      console.log(`\nwrote ${args.json}`);
    }
    if (args.csv) {
      const keys = Object.keys(summarise(rows[0].curve));
      const head = ["world", "strategy", "difficulty", "seed", "score", ...keys];
      const body = rows.map(r => [r.world, r.strategy, r.difficulty, r.seed, score(r).total, ...keys.map(k => r[k])].join(","));
      writeFileSync(args.csv, [head.join(","), ...body].join("\n") + "\n");
      console.log(`wrote ${args.csv}`);
    }
  },

  // A/B two saved sweeps (or a sweep against an overrides file run inline). Prints the
  // per-configuration delta, because a mean that moved could be one world moving a lot.
  compare(args) {
    const load = p => JSON.parse(readFileSync(p, "utf8"));
    const a = load(args.baseline), b = load(args.candidate);
    const key = r => `${r.world}/${r.strategy}/${r.difficulty}/${r.seed}`;
    const bm = new Map(b.map(r => [key(r), r]));
    console.log(pad("configuration", 34) + pad("base", 8) + pad("cand", 8) + "delta");
    let sa = 0, sb = 0, n = 0;
    for (const r of a) {
      const o = bm.get(key(r));
      if (!o) continue;
      const x = r.score.total, y = o.score.total;
      sa += x; sb += y; n++;
      const d = +(y - x).toFixed(3);
      console.log(pad(key(r), 34) + pad(x.toFixed(3), 8) + pad(y.toFixed(3), 8) + (d > 0 ? "+" : "") + d);
    }
    if (!n) { console.log("no matching configurations — the two sweeps must cover the same matrix"); return; }
    console.log(`\nmean ${(sa / n).toFixed(3)} -> ${(sb / n).toFixed(3)}  `
      + `(${sb > sa ? "+" : ""}${((sb - sa) / n).toFixed(3)} per configuration, n=${n})`);
  },

  // Coordinate search over a strategy's numeric dials. Deliberately the simplest thing that
  // works: a deterministic scan of each dial in turn, keeping an improvement. It's here to
  // make the search REPRODUCIBLE and cheap to reason about — the interesting judgement is in
  // which dials to open and what the objective is, and both of those are yours (or Claude's).
  search(args) {
    const name = args.strategy || "default";
    const dials = list(args.dials, []).map(d => {
      const [k, range] = d.split("=");
      const [lo, hi] = String(range).split(":").map(Number);
      return { k, lo, hi };
    });
    if (!dials.length) { console.log("--dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'"); return; }
    const worlds = list(args.worlds, ["korrath", "ferros", "vesper"]);
    const difficulties = list(args.difficulties, ["medium"]);
    const steps = num(args.steps, 4);
    const base = { ...(STRATEGIES[name] || {}) };
    const evaluate = row => {
      applyOverrides({ strategies: { [`${name}__lab`]: row } });
      const rows = runMatrix(args, { worlds, strategies: [`${name}__lab`], difficulties, seeds: num(args.seeds, 1) });
      return { mean: rows.reduce((a, r) => a + score(r).total, 0) / rows.length, rows };
    };
    let best = { ...base }, bestScore = evaluate(best).mean;
    console.log(`start ${name} -> ${bestScore.toFixed(3)}  ${JSON.stringify(pickDials(best, dials))}`);
    for (const d of dials) {
      for (let i = 0; i <= steps; i++) {
        const v = +(d.lo + (d.hi - d.lo) * (i / steps)).toFixed(3);
        const cand = { ...best, [d.k]: v };
        const { mean } = evaluate(cand);
        const better = mean > bestScore + 1e-9;
        console.log(`  ${pad(d.k + "=" + v, 32)} ${mean.toFixed(3)}${better ? "  *" : ""}`);
        if (better) { best = cand; bestScore = mean; }
      }
    }
    console.log(`\nbest ${bestScore.toFixed(3)}  ${JSON.stringify(pickDials(best, dials), null, 1)}`);
    console.log("\nThis is a LOCAL search on a noisy objective — re-run the winner through "
      + "`sweep --seeds 3` on the full roster before believing it.");
  },

  check(args) {
    const rows = runMatrix(args, {
      worlds: list(args.worlds, WORLDS),
      strategies: list(args.strategies, Object.keys(STRATEGIES)),
      difficulties: list(args.difficulties, ["medium"]),
      seeds: 1,
    });
    printTable(rows);
    const mean = rows.reduce((a, r) => a + score(r).total, 0) / rows.length;
    console.log(`\nmean score ${mean.toFixed(3)} over ${rows.length} runs`);
    printFindings(rows);
    if (args["exit-code"] === "true" && CHECKS.some(c => rows.some(c.hit))) process.exitCode = 1;
  },
};

const USAGE = `AI LAB — a headless bench for the Odyssey opponent.

  node tools/ailab.js probe   [--world ferros] [--strategy default] [--difficulty medium]
                              [--opponent passive] [--minutes 40] [--sample 5]
  node tools/ailab.js sweep   [--worlds a,b] [--strategies a,b] [--difficulties a,b]
                              [--seeds 3] [--minutes 40] [--json out.json] [--csv out.csv] [--full]
  node tools/ailab.js compare --baseline base.json --candidate cand.json
  node tools/ailab.js search  --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'
                              [--steps 4] [--worlds a,b]
  node tools/ailab.js check   [--worlds a,b] [--minutes 60] [--exit-code]

Common flags
  --overrides f.json   inject candidate rows into the AI tables before running:
                       { "strategies":   { "swarm":  { "armyAttackSizeMult": 0.5 } },
                         "archetypes":   { "rusher": { "odyssey": { "workerTarget": 9 } } },
                         "difficulties": { "hard":   { "workerTargetMult": 1.4 } } }
  --seed N             base seed (default 1) — every row is reproducible from it`;

function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (!cmd || !CMDS[cmd]) {
    console.log(USAGE);
    console.log(`\nworlds: ${WORLDS.join(", ")}`);
    console.log(`strategies: ${Object.keys(STRATEGIES).join(", ")}`);
    console.log(`opponents: ${Object.entries(OPPONENTS).map(([k, v]) => `${k} (${v.desc})`).join("\n            ")}`);
    return;
  }
  if (args.overrides) applyOverrides(JSON.parse(readFileSync(args.overrides, "utf8")));
  const t0 = process.hrtime.bigint();   // deterministic-exempt: wall clock is for the operator's benefit only, never read by the sim
  CMDS[cmd](args);
  console.log(`\n(${Number(process.hrtime.bigint() - t0) / 1e9 | 0}s)`);
}

// Only run the CLI when invoked directly, so a test can import run/score/CHECKS.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) main(process.argv.slice(2));

export { run, labWorld, sample, summarise, OPPONENTS, WORLDS };
