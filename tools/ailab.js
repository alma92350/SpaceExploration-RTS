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
                                 [--seeds 3] [--minutes 40] [--json out.json] [--csv out.csv] [--full]
     node tools/ailab.js compare --baseline base.json --candidate cand.json
     node tools/ailab.js search  --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'
                                 [--steps 4] [--worlds a,b] [--difficulties a,b]
                                 [--tournament-against baseline.json]
                                 # default objective: solo score() against the --opponent sparring
                                 # bot, same as always. --tournament-against swaps ONLY the
                                 # objective a candidate dial-value is scored by, onto Tier 2/3's
                                 # fair, side-swapped, difficulty-bracketed self-play duel
                                 # (runDuelBrackets) against the named baseline candidate JSON
                                 # ({ name, strategy, overrides }) — the coordinate-scan mechanics
                                 # (the per-dial, per-step loop, "keep an improvement") are
                                 # unchanged and don't know which objective is active.
     node tools/ailab.js check   [--worlds a,b] [--minutes 60] [--exit-code]   # the named-defect list
     node tools/ailab.js duel    --a candA.json --b candB.json [--worlds a,b] [--seeds 2]
                                 [--difficulties easy,hard] [--seed 1] [--minutes 40] [--json out.json]
                                 # Tier 3: side-swapped (both candidates play BOTH owner slots, by
                                 # DEFAULT, not an opt-in) and difficulty-bracketed (each --difficulties
                                 # entry reported on its own, never blended) — see the DUEL header
                                 # comment below.

   Opponents (--opponent) decide what the AI is measured AGAINST, and the answer differs
   completely between them: none (no player at all) · passive (seats a base, never acts — the
   only bot that never draws blood) · turtle (economy behind turrets, never attacks) · skirmisher
   (a turtle that also attacks with whatever it has mustered) · tech (a turtle that ALSO climbs
   Foundry -> Arsenal and attacks with a Lancer/Breacher/Dreadnought guard instead of a Skiff blob
   — the counter-pick/composition yardstick: does the AI react to and survive an actual army, not
   just a blob). skirmisher and tech are the two that provoke.

   Common flags
     --overrides f.json   inject rows into the AI tables before running, e.g.
                          { "strategies": { "swarm": { "armyAttackSizeMult": 0.5 } },
                            "archetypes": { "rusher": { "odyssey": { "workerTarget": 9 } } },
                            "difficulties": { "hard": { "workerTargetMult": 1.4 } } }
     --seed N             base seed (default 1) — every run is reproducible from it
     --apm real|none      default 'real': the AI runs at its OWN difficulty row's aiApm cap
                          (engine/aiDifficulty.js) — the single biggest difficulty dial, and until
                          now exercised by zero bench measurements. 'none' keeps a run unthrottled,
                          for comparison against the bench's pre-APM measurement history.

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
import { createSelfPlayState, runSelfPlayMatch } from "./selfplay.js";
import { playerScore } from "../engine/victory.js";

const WORLDS = [...Object.keys(PLANET_ARCHETYPE), ...Object.keys(ODYSSEY_EXTRA_ARCHETYPE)];
const DT = 0.1;                  // the sim's fixed step, same as the game loop
const THINK = 1.5;               // sparring-bot decision cadence, matching the AI's own think interval

/* ============================================================
   THE LAB WORLD
   ============================================================ */

// One Odyssey world, built exactly the way engine/galaxy.js addPlanet builds a neighbour:
// endless, with its own market and diplomacy, the archetype's faction, and the AI dials under
// test. The `opponent` decides what the player side is, which is what the AI is actually being
// measured against — see the sparring bots below. `apm` === "real" runs the AI at its OWN
// difficulty row's aiApm (the CLI's own default, via baseConfig below); anything else — including
// simply omitting it — keeps a direct labWorld/run() call unthrottled exactly like before, so
// every existing programmatic caller (this file's own test suite included) is untouched.
function labWorld({ world, strategy, difficulty, opponent, seed, apm }) {
  const diffOpt = DIFFICULTY_OPTIONS.find(o => o.mult === difficulty);
  const s = createGameState({
    planetId: world, seed, rng: mulberry32(seed), endless: true,
    aiStrategy: strategy, difficulty,
    aiApm: apm === "real" ? (diffOpt?.aiApm ?? null) : null, aiMicro: !!diffOpt?.aiMicro,
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

// Shared by every bot with a real economy (today: `turtle` and `tech`): grow the workforce to a
// target, keep supply ahead of the cap, and — once there's a Barracks — hold a wall of turrets.
// Returns false when the tick's one action already went to an economy/defence step (or there's no
// Command Center yet, so nothing else can happen), true once the caller is free to decide what its
// Barracks builds — the same one-action-per-think discipline every bot here already follows.
function botEconomy(s) {
  botGather(s);
  const cc = playerBuildingsOf(s, "command").find(b => !b.constructing);
  if (!cc) return false;
  const res = s.players.player.resources;
  const workers = playerUnitsOf(s, "worker").length;
  if (workers < 12 && cc.queue.length === 0) { queueProduction(s, cc.id, "worker"); return false; }
  if (supplyUsed(s, "player") >= supplyCap(s, "player") - 4
      && !playerBuildingsOf(s, "habitat").some(b => b.constructing)) { botBuild(s, "habitat", 0, 90); return false; }
  if (!playerBuildingsOf(s, "barracks").length) { botBuild(s, "barracks", 90, -90); return false; }
  if (playerBuildingsOf(s, "turret").length < 4 && canAfford(res, BUILDINGS.turret.cost)) {
    const i = playerBuildingsOf(s, "turret").length;
    if (botBuild(s, "turret", 120 - 60 * (i % 2), 120 * (i < 2 ? 1 : -1))) return false;
  }
  return true;
}

// tech's composition guard: Tier-2 (Foundry) then Tier-3 (Arsenal), never a Skiff — the whole
// point of this bot is a mixed army the counter-pick/turret-wall-reading changes actually have
// something to answer, not another single-unit blob (engine/entities.js `requires`: Lancer and
// Breacher need a completed Foundry, Dreadnought a completed Arsenal). Listed cost-ascending so
// trying it in order doubles as "cheapest-affordable-first": queueProduction already rejects a
// locked or unaffordable entry on its own, so this never wedges waiting on a Dreadnought it can't
// yet pay for while it's sitting on Lancer money.
const TECH_COMP = ["lancer", "breacher", "dreadnought"];

// turtle's economy, plus the tech ladder past the Barracks. Foundry first (Lancer/Breacher's
// prereq), then Arsenal (Dreadnought's) once the Foundry is actually done — not just laid down —
// and only then does an idle Barracks start cycling TECH_COMP.
function techBuild(s) {
  if (!botEconomy(s)) return;
  if (!playerBuildingsOf(s, "foundry").length) { botBuild(s, "foundry", -90, -90); return; }
  const foundryDone = playerBuildingsOf(s, "foundry").some(b => !b.constructing);
  if (foundryDone && !playerBuildingsOf(s, "arsenal").length) { botBuild(s, "arsenal", -90, 90); return; }
  const idle = playerBuildingsOf(s, "barracks").filter(b => !b.constructing).find(b => b.queue.length === 0);
  if (idle) for (const t of TECH_COMP) if (queueProduction(s, idle.id, t)) break;
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
      if (!botEconomy(s)) return;
      // A standing guard, cheapest-first so the bot's composition never depends on tech it
      // hasn't built. Units hold at the rally point; the bot never issues an attack order.
      const res = s.players.player.resources;
      const idle = playerBuildingsOf(s, "barracks").filter(b => !b.constructing).find(b => b.queue.length === 0);
      if (idle && canAfford(res, UNITS.skiff.cost)) queueProduction(s, idle.id, "skiff");
    },
  },

  // PROVOKES: commits its army once it's mustered one. A `neverInitiates` neighbour is entitled to
  // answer a player who has drawn blood (engine/diplomacy.js provoked()), so measuring whether
  // Economic / Force Parity ever push back needs an opponent that actually fights — `none`/
  // `passive` never do, and against them those strategies are SUPPOSED to stay quiet (`turtle` can
  // still incidentally provoke — its turrets kill the AI's scouts — but never deliberately
  // attacks). Deterministic: it commits whenever six idle combat units have accumulated, off the
  // sim clock, with no randomness. `tech` below is the other bot that provokes, same trigger.
  skirmisher: {
    desc: "turtle economy that throws a Skiff blob at the AI whenever it musters one",
    setup: seatBase,
    think(s) {
      OPPONENTS.turtle.think(s);
      const idle = [...s.units.values()].filter(u =>
        u.owner === "player" && UNITS[u.type].role === "combat" && (!u.order || u.order.type === "move"));
      if (idle.length >= 6) issueAttackMove(idle, s.map.bases.ai.x, s.map.bases.ai.y);
    },
  },

  // The composition yardstick: everything skirmisher is, plus it actually teches — so it answers
  // "does the AI react to and survive a composition, not a blob" instead of re-asking "does the AI
  // beat a Skiff blob". Same six-idle wave-commit trigger as skirmisher, so it provokes too.
  tech: {
    desc: "turtle economy that also teches Foundry/Arsenal and throws a Lancer/Breacher/Dreadnought guard at the AI",
    setup: seatBase,
    think(s) {
      techBuild(s);
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
    // …and is it doing anything about it? A healthy AI at full tilt runs close to its cap and is
    // momentarily blocked all the time — that's supply PRESSURE, not deadlock. The deadlock is
    // being blocked with no Habitat on the way, which is the state that never resolves itself.
    habitatPending: [...s.buildings.values()].some(b => b.owner === "ai" && b.type === "habitat" && b.constructing),
    supplyFree: +(supplyCap(s, "ai") - supplyUsed(s, "ai")).toFixed(1),
    playerBuildings: playerBuildingsOf(s).length,
    aiAlive: done.some(b => b.type === "command"),
    // ENTITLED to attack right now? Odyssey draws a line between a strategy that goes looking for
    // a fight and one that only answers being provoked (engine/aiStrategy.js neverInitiates +
    // engine/diplomacy.js provoked()). "Hostile and idle" is only a defect on the near side of
    // that line — a neighbour leaving an unprovoked player alone is the contract working, and
    // scoring it as a failure would push the tuning loop toward breaking it.
    entitled: !strategyFor(s).neverInitiates || provoked(s),
    // Is this strategy DELIBERATELY holding its army down (Economic's fixed cap, Force Parity's
    // mirror)? Idle Barracks are the intended output of a standing-army cap, so the stall detector
    // has to exclude them — the same principle as `entitled` above: a detector that fires on
    // behaviour the design asks for teaches the tuning loop to break the design.
    armyCapped: strategyFor(s).standingArmyCap != null || !!strategyFor(s).matchEnemyForce,
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
    idleRichFrac: +(curve.filter(c => !c.armyCapped && c.rax > 0 && c.idleRax === c.rax && c.banked > 1000)
      .length / curve.length).toFixed(2),
    supplyDeadlockFrac: +(curve.filter(c => c.supplyBlocked && !c.habitatPending && c.banked > 400)
      .length / curve.length).toFixed(2),
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

// Deep-clone the three live tables so a candidate's overrides can be reverted EXACTLY once its
// runs are done, leaving the next candidate a clean baseline. Plain data (the whole reason
// applyOverrides can work at all), so a JSON round-trip clones it safely. Used by runLeaderboard
// below — two candidates that both patch e.g. "aggressive" must never see each other's edits.
function snapshotTables() {
  return {
    strategies: JSON.parse(JSON.stringify(STRATEGIES)),
    archetypes: JSON.parse(JSON.stringify(ARCHETYPES)),
    difficulties: JSON.parse(JSON.stringify(DIFFICULTY_OPTIONS)),
  };
}
function restoreTables(snap) {
  for (const k of Object.keys(STRATEGIES)) delete STRATEGIES[k];
  Object.assign(STRATEGIES, snap.strategies);
  for (const k of Object.keys(ARCHETYPES)) delete ARCHETYPES[k];
  Object.assign(ARCHETYPES, snap.archetypes);
  DIFFICULTY_OPTIONS.length = 0;
  DIFFICULTY_OPTIONS.push(...snap.difficulties);
}

/* ============================================================
   LEADERBOARD — Tier 0 of "which strategy is actually better": rank candidates against a
   FIXED, non-adaptive sparring bot with every other dial held equal, no engine change needed.

   This is NOT head-to-head play. Nothing here makes two candidates fight each other — that
   needs runAI to drive two independently-configured owners in the same match, which it can't
   do yet (docs/odyssey-ai-review.md §2.8, "There is no AI-vs-AI, but there nearly is"). What
   this CAN do today: hold difficulty, opponent, world roster, seed count and minutes IDENTICAL
   across every candidate — so no candidate gets an APM/micro edge another one doesn't — and rank
   them by the same score() this bench already uses for solo tuning. "Candidate A beats candidate
   B" here means "A scored higher against the same yardstick B faced", which is real signal but a
   PROXY for competitive self-play, not a substitute for it — say so wherever this is reported.

   A candidate is { name, strategy, overrides }: `strategy` (default "default") is which
   STRATEGIES key this candidate actually runs as; `overrides` (optional) is exactly the
   --overrides shape, scoped to this one candidate's runs via snapshotTables/restoreTables above.
   ============================================================ */

export function runLeaderboard(candidates, { worlds, difficulty = "medium", opponent = "tech", seeds = 2, ...rest } = {}) {
  const results = [];
  for (const cand of candidates) {
    if (!cand.name) throw new Error('a candidate needs a "name"');
    const snap = snapshotTables();
    try {
      if (cand.overrides) applyOverrides(cand.overrides);
      const strategy = cand.strategy || "default";
      if (!STRATEGIES[strategy])
        throw new Error(`candidate "${cand.name}": unknown strategy "${strategy}" — define it under overrides.strategies`);
      const rows = runMatrix({ ...rest, opponent }, { worlds, strategies: [strategy], difficulties: [difficulty], seeds });
      const scored = rows.map(score);
      const mean = scored.reduce((a, s) => a + s.total, 0) / scored.length;
      const partsMean = {};
      for (const k of Object.keys(WEIGHTS)) {
        const vals = scored.filter(s => k in s.parts).map(s => s.parts[k]);
        if (vals.length) partsMean[k] = +(vals.reduce((a, v) => a + v, 0) / vals.length).toFixed(3);
      }
      let worstIdx = 0;
      scored.forEach((s, i) => { if (s.total < scored[worstIdx].total) worstIdx = i; });
      results.push({ name: cand.name, strategy, mean: +mean.toFixed(3), partsMean, worst: rows[worstIdx], n: rows.length });
    } finally {
      restoreTables(snap);   // never let one candidate's patch leak into the next, even on error
    }
  }
  return results.sort((a, b) => b.mean - a.mean);
}

/* ============================================================
   DUEL — Tier 2: true head-to-head, not a proxy. Two independently-configured
   candidates fight each other for real, via Tier 1's self-play (tools/selfplay.js):
   BOTH sides driven by the real scripted AI (engine/ai.js runAI), never a scripted
   sparring bot (contrast the LEADERBOARD above, which is exactly that proxy). Skirmish
   only — createSelfPlayState's default (non-endless) shape — resolved purely by engine/
   victory.js's own checkWinCondition (elimination, or its score-at-clock timeout),
   exactly as any other skirmish resolves. No new win condition is invented here.

   FAIRNESS, the one property this command cannot be trusted without: difficulty — and
   therefore APM and micro, both DERIVED from the difficulty row (engine/aiDifficulty.js
   DIFFICULTY_OPTIONS: aiApm/aiMicro) — is pinned IDENTICAL for both sides. That isn't a
   convention the caller has to remember: pinnedDuelDials() below reads the difficulty
   ONCE into a single `dials` object, and duelRun() spreads that SAME object into both
   createSelfPlayState `ai` and `playerAi` configs. There is only one variable in the
   whole call graph that could ever hold "this side's apm/micro/difficulty" — so there is
   no second code path left that could read a different value for either side, even by
   mistake. Only `strategy` (and whatever --overrides row it names) differs between the
   two candidates — that is the entire point of the comparison.

   Candidate A always plays owner "player", candidate B always plays owner "ai" — a fixed,
   documented mapping. That is NOT enough on its own: some worlds (oort, nimbus — both
   reachable via --worlds) carry engine/map.js's `asym: { player, ai }` modifier block, a
   genuinely asymmetric per-owner stat tweak baked into the map, independent of which
   candidate is playing which owner. A fixed candidate->owner mapping would hand that
   map-side advantage to the same candidate on every single match — measured empirically at
   ~6/0 (oort) and ~5/6-inverted (nimbus) for two IDENTICAL candidates, i.e. the map side
   deciding the match, not candidate quality. So runDuel alternates the engine's own escape
   hatch for this (`swapAsym`, the same flag the skirmish game exposes so a human can choose
   which half to play) by replicate parity — even reps (0, 2, …) play the map as generated,
   odd reps play it with the asym halves exchanged — so across any run of seeds >= 2 on an
   asym world, each candidate spends half its matches on each side of the map's own
   asymmetry and neither one's map-side is fixed for the whole run. `swapAsym` is a no-op on
   every world without an asym block, so this changes nothing for the default roster
   (korrath/ferros/vesper/kybernet). Each row records the `swapAsym` it actually ran with.

   SCORING: winner/loser/draw comes straight from engine/victory.js's own state.winner/
   state.over — elimination or its score-at-clock tiebreak, never reinterpreted here (a
   "draw" here means only that the run hit its safety-net cutoff still undecided, which
   the tiebreak means should not happen in practice). The "score margin" reported
   alongside it is exactly the score that tiebreak itself uses — engine/victory.js
   playerScore/scoreBreakdown (bank + army + structures) — NOT this file's own score()/
   WEIGHTS system above. That system scores an ODYSSEY play-forever curve: `develop` and
   `keepGrowing` key off aiDevelopment(state), which engine/diplomacy.js's own header
   comment says plainly is hardcoded to owner "ai" and that "the whole skirmish path...
   never calls this"; `pressure`/`hostileIdleFrac` key off hostility()/provoked(), which
   need state.diplomacy — absent from every skirmish state, self-play included. Forcing
   that curve-shaped, Odyssey-specific metric onto a skirmish fight it was never built to
   describe would produce numbers that LOOK like this file's score() but don't mean the
   same thing. Reusing playerScore instead keeps "score" meaning exactly what it already
   means everywhere self-play/skirmish resolution is concerned: the real number the match
   itself would settle a tie with.
   ============================================================ */

// difficulty -> the ONE dial object both sides read (apm/micro, derived from the same
// DIFFICULTY_OPTIONS row labWorld's own --apm real already reads for a single side) — see
// the FAIRNESS paragraph above. Exported so a test can read back exactly what a run should
// have used, rather than trusting the CLI flag was honoured.
export function pinnedDuelDials(difficulty) {
  const opt = DIFFICULTY_OPTIONS.find(o => o.mult === difficulty) || DIFFICULTY_OPTIONS.find(o => o.mult === "medium");
  // Echo back opt.mult, NOT the raw input: apm/micro already fall back to medium's values when
  // `difficulty` doesn't match any DIFFICULTY_OPTIONS row, so the reported difficulty has to fall
  // back with them — otherwise a typo'd/unknown --difficulty would run medium's dials but LABEL
  // the result with the garbage string, misleading anyone reading a saved --json duel result about
  // which difficulty actually ran.
  return { difficulty: opt.mult, apm: opt.aiApm, micro: !!opt.aiMicro };
}

// Every duel match's seed is derived from (base seed, world, difficulty, BOTH candidate
// names, replicate) — reproducible on its own, same discipline as runSeed() above, just
// keyed on the pair rather than a single strategy since a duel row always involves two.
// The pair's names are SORTED into the hash, so runDuel(a,b) and runDuel(b,a) draw the identical
// map. runSwappedDuel exists to isolate seat asymmetry — its header says "a side-symmetry bug would
// show up as those two disagreeing" — and with an order-dependent seed the two halves differed in
// seat AND map, so a disagreement was confounded with ordinary seed variance and carried no
// information at all. (swapAsym, the map-side control, was already paired correctly by replicate
// parity; this makes the seat-side control match it.)
const duelSeed = (base, world, difficulty, aName, bName, rep) =>
  hashStr(`${base}:duel:${world}:${difficulty}:${[aName, bName].sort().join("|")}:${rep}`);

// Run ONE match: candidate A as owner "player", candidate B as owner "ai", both spending
// from the SAME `dials` object (see pinnedDuelDials/FAIRNESS above). `swapAsym` exchanges
// the map's own asym halves (engine/map.js) for THIS match only — see the FAIRNESS
// paragraph above for why runDuel alternates it by replicate parity rather than holding it
// fixed. Returns a plain result row, mirroring run()'s own "cfg in, small row out" shape.
function duelRun({ world, seed, dials, aName, aStrategy, bName, bStrategy, minutes, swapAsym }) {
  const state = createSelfPlayState({
    planetId: world, seed, swapAsym,
    matchTimeLimit: minutes ? minutes * 60 : undefined,
    ai: { ...dials, strategy: bStrategy },
    playerAi: { ...dials, strategy: aStrategy },
  });
  const result = runSelfPlayMatch(state, minutes ? { maxSeconds: minutes * 60 + 120 } : undefined);
  const aScore = playerScore(state, "player");
  const bScore = playerScore(state, "ai");
  const winner = !result.over ? "draw" : result.winner === "player" ? "a" : "b";
  return {
    world, seed, difficulty: dials.difficulty, swapAsym: !!swapAsym,
    aName, aStrategy, bName, bStrategy,
    // Read back off the actual controllers, not the input — the structural-fairness test
    // asserts on exactly these fields, so a bug that let the two dials diverge would show here.
    aDifficulty: state.playerAi.difficulty, bDifficulty: state.ai.difficulty,
    aApm: state.playerAi.apm, bApm: state.ai.apm, aMicro: state.playerAi.micro, bMicro: state.ai.micro,
    winner, winReason: result.winReason, time: +result.time.toFixed(1),
    aScore: +aScore.toFixed(1), bScore: +bScore.toFixed(1), margin: +(aScore - bScore).toFixed(1),
  };
}

// Head-to-head: candidate A vs candidate B across `worlds` x `seeds`, difficulty pinned
// identical for both (pinnedDuelDials — see the FAIRNESS paragraph above). `worlds`/
// `difficulty`/`seeds`/`seedBase`/`minutes` mirror runMatrix's own options; each candidate is
// `{ name, strategy, overrides }`, exactly runLeaderboard's own candidate shape. Overrides
// from BOTH candidates are applied together, once, before any match runs (they share one
// live fight, unlike leaderboard's candidates which never meet) — snapshot/restored around
// the whole call exactly like runLeaderboard does around each candidate, via the same
// snapshotTables/restoreTables this file already uses.
export function runDuel(a, b, {
  worlds = ["korrath", "ferros", "vesper", "kybernet"], difficulty = "medium",
  seeds = 2, seedBase = 1, minutes,
} = {}) {
  if (!a || !a.name) throw new Error('candidate A needs a "name"');
  if (!b || !b.name) throw new Error('candidate B needs a "name"');
  const dials = pinnedDuelDials(difficulty);   // read ONCE — see the FAIRNESS paragraph above
  assertNoOverrideCollision(a, b);
  const snap = snapshotTables();
  try {
    if (a.overrides) applyOverrides(a.overrides);
    if (b.overrides) applyOverrides(b.overrides);
    const aStrategy = a.strategy || "default", bStrategy = b.strategy || "default";
    if (!STRATEGIES[aStrategy])
      throw new Error(`candidate "${a.name}": unknown strategy "${aStrategy}" — define it under overrides.strategies`);
    if (!STRATEGIES[bStrategy])
      throw new Error(`candidate "${b.name}": unknown strategy "${bStrategy}" — define it under overrides.strategies`);
    const rows = [];
    for (const world of worlds)
      for (let rep = 0; rep < seeds; rep++)
        rows.push(duelRun({
          world, seed: duelSeed(seedBase, world, difficulty, a.name, b.name, rep),
          dials, aName: a.name, aStrategy, bName: b.name, bStrategy, minutes,
          // Alternate the map's own asym halves by replicate parity — see the FAIRNESS
          // paragraph above. A no-op on every world without an `asym` block.
          swapAsym: rep % 2 === 1,
        }));
    const aWins = rows.filter(r => r.winner === "a").length;
    const bWins = rows.filter(r => r.winner === "b").length;
    const draws = rows.filter(r => r.winner === "draw").length;
    const avgMargin = +(rows.reduce((s, r) => s + r.margin, 0) / rows.length).toFixed(1);
    // dials.difficulty, NOT the raw `difficulty` param — pinnedDuelDials already normalizes an
    // unknown/typo'd difficulty to "medium" for apm/micro, and every row already reports
    // dials.difficulty for the same reason (see pinnedDuelDials' own comment); the aggregate has
    // to agree with its own rows instead of echoing back whatever garbage string was passed in.
    return { aName: a.name, bName: b.name, aStrategy, bStrategy, difficulty: dials.difficulty, n: rows.length, aWins, bWins, draws, avgMargin, rows };
  } finally {
    restoreTables(snap);   // never let this duel's overrides leak into whatever runs next
  }
}

// Shared by both round-robin flavours below: the standings Map is keyed by name, so two
// candidates sharing a name would silently collapse into one entry — an A-vs-A pairing would
// then read/write the SAME standings object for both sides of that match, corrupting it with a
// phantom self-match. Guard up front, the same discipline runDuel already applies to a missing
// name.
// Two candidates in ONE duel share a single live table (unlike leaderboard's, which never meet and
// are snapshot/restored per candidate), and applyOverrides MERGES rather than replaces. So if both
// patch the same key, the second's fields land on top of the first's and BOTH seats play a row
// belonging to neither — a mirror match that still reports a winner, from seat/seed noise alone.
// That is the natural A/B workflow (two values of one dial under one strategy name), so refuse it
// loudly rather than silently measuring nothing.
function assertNoOverrideCollision(a, b) {
  for (const table of ["strategies", "archetypes", "difficulties"]) {
    const aKeys = Object.keys((a.overrides && a.overrides[table]) || {});
    const bSet = new Set(Object.keys((b.overrides && b.overrides[table]) || {}));
    const shared = aKeys.filter(k => bSet.has(k));
    if (shared.length)
      throw new Error(`both candidates override ${table} "${shared.join('", "')}" — they share one live ` +
        `table for the duel, so the patches would merge and both sides would play the same row. ` +
        `Give each candidate its own key (e.g. "${shared[0]}A"/"${shared[0]}B").`);
  }
}

function assertUniqueCandidateNames(candidates) {
  const seen = new Set();
  for (const c of candidates) {
    if (!c || !c.name) throw new Error('every round-robin candidate needs a "name"');
    if (seen.has(c.name)) throw new Error(`duplicate candidate name "${c.name}" — round-robin standings are keyed by name`);
    seen.add(c.name);
  }
  // Every pairing this field will produce goes through runDuel, so catch a collision here rather
  // than partway through a long tournament.
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++)
      assertNoOverrideCollision(candidates[i], candidates[j]);
}

// Round-robin over N > 2 candidates: every unordered pair, run through runDuel exactly as a
// single --a/--b duel would be. A nice-to-have that falls straight out of runDuel already
// being pair-shaped — deliberately NOT a new tournament engine (no swiss pairing, no bracket):
// just every pair, once, tallied. Exported so a test can exercise it without going via argv.
export function runRoundRobin(candidates, opts = {}) {
  assertUniqueCandidateNames(candidates);
  const pairs = [];
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++)
      pairs.push(runDuel(candidates[i], candidates[j], opts));
  const standings = new Map(candidates.map(c => [c.name, { name: c.name, wins: 0, losses: 0, draws: 0 }]));
  for (const res of pairs) {
    const A = standings.get(res.aName), B = standings.get(res.bName);
    A.wins += res.aWins; A.losses += res.bWins; A.draws += res.draws;
    B.wins += res.bWins; B.losses += res.aWins; B.draws += res.draws;
  }
  return { pairs, standings: [...standings.values()].sort((x, y) => y.wins - x.wins) };
}

/* ============================================================
   TIER 3 — a candidate compared against remembered numbers is a candidate compared against
   nothing (docs/odyssey-ai-review.md §3, the ai-lab skill's standing lesson). runDuel above is
   already a fair SINGLE match-up: one map-side assignment (A="player", B="ai"), one difficulty.
   Tier 3 wraps it with the two things a noisy objective needs before a verdict means anything:

   1. SIDE-SWAP, on by DEFAULT (not a flag to remember). runDuel's own header comment already
      names why: "the two owner slots are not perfectly symmetric, different starting corner,
      different fog seed stream" — map-side asym (oort/nimbus) is the mechanical example
      runDuel already documents and corrects for WITHIN one direction (swapAsym by replicate
      parity), but that only balances the map; it says nothing about whether the "ai" owner
      slot itself is a structurally easier seat to play (a different think-cadence phase
      offset, a different fog stream, in principle even an unnoticed engine asymmetry between
      the two owner code paths). The only way to rule that out is to literally run the pairing
      both ways — A as "ai"/B as "player", THEN B as "ai"/A as "player" — and look at both
      halves, not just their sum. runSwappedDuel below returns `aAsAi` and `bAsAi` as two full,
      independently-inspectable sub-results (not just labelled rows folded into one number) for
      exactly that reason: a side-symmetry bug would show up as those two disagreeing, and
      collapsing them into a single aggregate is precisely what would hide it.
   2. DIFFICULTY as a swept, NEVER-BLENDED axis. runDuelBrackets below takes a LIST of
      difficulties and runs the full side-swapped pairing separately at each one, returning one
      result per difficulty — never a mean across them. Averaging across difficulty brackets
      would let a strategy's edge at one difficulty's APM/micro cap paper over a deficit at
      another's, which is exactly the APM confound the whole duel mechanism exists to rule out
      (see the FAIRNESS paragraph on runDuel above) — just reintroduced one level up, between
      brackets instead of between sides. So each bracket is reported standalone, on purpose.
   ============================================================ */

// Relabel a runDuel() result (and every one of its rows) from B's perspective to A's — i.e.
// turn "the result of runDuel(b, a, opts)" into "what A did, reported as if A were the first
// argument". Only swaps WHICH name/strategy/score a value is filed under; the underlying match
// numbers (winReason, time, world, seed, swapAsym) are untouched. This is how runSwappedDuel
// below lets both directions read with the same aName/bName regardless of which candidate
// runDuel itself treated as owner "player" for that call.
function flipDuelResult(res) {
  const flipRow = r => ({
    ...r,
    aName: r.bName, bName: r.aName,
    aStrategy: r.bStrategy, bStrategy: r.aStrategy,
    aDifficulty: r.bDifficulty, bDifficulty: r.aDifficulty,
    aApm: r.bApm, bApm: r.aApm, aMicro: r.bMicro, bMicro: r.aMicro,
    winner: r.winner === "a" ? "b" : r.winner === "b" ? "a" : "draw",
    aScore: r.bScore, bScore: r.aScore, margin: -r.margin,
  });
  return {
    aName: res.bName, bName: res.aName, aStrategy: res.bStrategy, bStrategy: res.aStrategy,
    difficulty: res.difficulty, n: res.n,
    aWins: res.bWins, bWins: res.aWins, draws: res.draws, avgMargin: -res.avgMargin,
    rows: res.rows.map(flipRow),
  };
}

// Candidate A vs candidate B, BOTH ways, aggregated — the side-swap default described above.
// `bAsAi` is runDuel(a, b, opts) as-is (B plays owner "ai", A plays "player" — runDuel's own
// fixed mapping). `aAsAi` is runDuel(b, a, opts) relabelled to A's perspective (A plays owner
// "ai", B plays "player"): same mechanism, opposite assignment. Both are returned in full,
// alongside the combined tallies, so a caller (or a test) can inspect either direction on its
// own — see the TIER 3 header comment above for why collapsing them would hide exactly the bug
// this exists to catch.
export function runSwappedDuel(a, b, opts = {}) {
  if (!a || !a.name) throw new Error('candidate A needs a "name"');
  if (!b || !b.name) throw new Error('candidate B needs a "name"');
  const bAsAi = runDuel(a, b, opts);
  const aAsAi = flipDuelResult(runDuel(b, a, opts));
  const n = bAsAi.n + aAsAi.n;
  const aWins = bAsAi.aWins + aAsAi.aWins;
  const bWins = bAsAi.bWins + aAsAi.bWins;
  const draws = bAsAi.draws + aAsAi.draws;
  const avgMargin = +(((bAsAi.avgMargin * bAsAi.n) + (aAsAi.avgMargin * aAsAi.n)) / n).toFixed(1);
  return {
    aName: a.name, bName: b.name, aStrategy: bAsAi.aStrategy, bStrategy: bAsAi.bStrategy,
    difficulty: bAsAi.difficulty, n, aWins, bWins, draws, avgMargin,
    bAsAi, aAsAi,   // the two independently-inspectable directions — see header comment
  };
}

// The side-swapped pairing, run separately at every difficulty in `opts.difficulties` (falls
// back to a single-element list built from `opts.difficulty`, default "medium" — the same
// default runDuel itself has always used, so an existing single-difficulty caller sees no
// change). Returns one runSwappedDuel result PER difficulty, each carrying its own `difficulty`
// field — deliberately an array, never averaged into one row. See the TIER 3 header comment
// above for why blending brackets would reintroduce the APM confound.
export function runDuelBrackets(a, b, opts = {}) {
  const { difficulties, difficulty, ...rest } = opts;
  const list = difficulties && difficulties.length ? difficulties : [difficulty || "medium"];
  return list.map(diff => runSwappedDuel(a, b, { ...rest, difficulty: diff }));
}

// Round-robin, side-swapped, difficulty-bracketed: every unordered pair of `candidates`,
// duelled via runSwappedDuel, separately at every difficulty in `opts.difficulties` (same
// fallback as runDuelBrackets). Returns one { difficulty, pairs, standings } per difficulty —
// never one standings table blended across brackets, for the same reason runDuelBrackets keeps
// its results separate.
export function runRoundRobinSwapped(candidates, opts = {}) {
  assertUniqueCandidateNames(candidates);
  const { difficulties, difficulty, ...rest } = opts;
  const list = difficulties && difficulties.length ? difficulties : [difficulty || "medium"];
  return list.map(diff => {
    const pairs = [];
    for (let i = 0; i < candidates.length; i++)
      for (let j = i + 1; j < candidates.length; j++)
        pairs.push(runSwappedDuel(candidates[i], candidates[j], { ...rest, difficulty: diff }));
    const standings = new Map(candidates.map(c => [c.name, { name: c.name, wins: 0, losses: 0, draws: 0 }]));
    for (const res of pairs) {
      const A = standings.get(res.aName), B = standings.get(res.bName);
      A.wins += res.aWins; A.losses += res.bWins; A.draws += res.draws;
      B.wins += res.bWins; B.losses += res.aWins; B.draws += res.draws;
    }
    return {
      difficulty: pinnedDuelDials(diff).difficulty,   // normalized — see pinnedDuelDials' own comment
      pairs, standings: [...standings.values()].sort((x, y) => y.wins - x.wins),
    };
  });
}

/* ============================================================
   TIER 5 — SWISS PAIRING: a schedule that scales in ROUNDS, not in candidates squared, for
   candidate pools too large for runRoundRobinSwapped's full round-robin to stay cheap.

   Every pairing above (leaderboard, duel, round-robin) is trustworthy because it's built on
   runSwappedDuel — side-swapped, difficulty-bracketed, APM/micro pinned identical for both
   sides. Round-robin's only weakness is its SCHEDULE: C(n,2) pairings, so a pool of 20
   candidates is already 190 pairings, each `worlds x seeds x 2 sides` matches — the quadratic
   cost the Tier 5 stretch goal in the roadmap named directly. Swiss pairing is the standard
   answer (chess/Magic tournament scheduling): each round pairs candidates with the CLOSEST
   current standing instead of every candidate meeting every other one, so after
   `rounds` = O(log2 n) rounds the ranking has converged without ever running the full
   quadratic schedule. This file changes NOTHING about what a "fair fight" means — every
   pairing below is still exactly one runSwappedDuel call, same fairness guarantees, same
   opts shape as runDuel/runRoundRobinSwapped. Tier 5 is a new SCHEDULE on top of a trusted
   primitive, not a new way of deciding who won a match.

   PAIRING RULE (findMatching/pairRound below): sort the field by current wins (ties keep the
   stable order they arrive in), then find a matching that avoids every already-played pair IF
   ONE EXISTS. The first cut of this shipped as pure greedy — walk the sorted list, pair each
   candidate with the first not-yet-played opponent remaining — and independent review caught
   that it does NOT deliver the "avoids a repeat unless truly forced" guarantee it claimed:
   fuzz-testing against a brute-force ground-truth checker measured avoidable repeats in roughly
   a quarter to half of realistic tournaments (n=6..50), because a greedy walk can strand two
   candidates with each other even when a full zero-repeat matching exists elsewhere in the same
   round (classic "first fit with no lookahead" failure). findMatching now backtracks: for each
   candidate (closest-standing first) it tries an unplayed opponent before ever trying a repeat,
   and if that choice can't be extended into a complete matching for the rest of the pool, it
   backtracks and tries the next one. Bounded by MATCH_ATTEMPT_CAP (small Swiss pools — this
   tool's whole use case — resolve in a handful of attempts; the cap exists so a pathological
   input can never hang) with a plain greedy pass as the last-resort fallback if the cap is hit,
   so this always terminates and always returns a complete pairing.

   BYES: odd `candidates.length` leaves one candidate unpaired each round. It's awarded to the
   LOWEST-standing candidate who hasn't had one yet, falling back to lowest-standing overall once
   everyone has — standard Swiss practice. That fallback CAN eventually reach the field's current
   leader in a long-enough Swiss on a small pool (this tool's own default rounds formula keeps
   real runs far short of that, but nothing prevents it if `--rounds` is pushed high). A bye is
   NOT a win: it's the schedule's own bookkeeping for "this candidate wasn't paired," and the
   first cut of this got that wrong too — it credited a bye as a full pairing's worth of wins
   (`worlds.length * seeds * 2`, i.e. a maximum-margin sweep) with zero matching losses, which an
   independent review caught letting a candidate that never fights at all tie or outrank one that
   won a genuine match (reproduced live: a neverInitiates/zero-standing-army candidate that drew
   a bye matched a real winner's standing). A bye now adds to nobody's `wins`/`losses` — only its
   own `byes` counter — so standings reflect actual fighting, never schedule luck. `byeMatchCount`
   is kept as an informational field only (how big a real pairing this round would have been),
   never applied to anyone's tally.

   ROUNDS: default `Math.max(3, Math.ceil(Math.log2(candidates.length)))` — the textbook rule
   of thumb for how many Swiss rounds separate a field of that size — override with `--rounds`.
   Like runDuelBrackets/runRoundRobinSwapped, `--difficulties` (plural) runs the WHOLE Swiss
   schedule again per difficulty, each one its own independent tournament (own pairings, own
   standings) — never blended, for the identical reason those two keep brackets separate.
   ============================================================ */

const pairKey = (a, b) => [a, b].sort().join("::");

// Total (candidate, opponent) trial attempts findMatching will spend across an ENTIRE call
// (shared across all its recursive branches via the mutable `budget` object) before giving up
// and falling back to a plain greedy pass. Small Swiss pools — this tool's whole use case —
// resolve in well under this; it exists purely so a pathological input can never hang.
const MATCH_ATTEMPT_CAP = 20000;

// Backtracking search for a COMPLETE ZERO-REPEAT matching over `pool` (already sorted by
// standing, closest-first) — every pair it considers must be absent from `played`; it never
// accepts a repeat itself. For the pool's first member, tries each unplayed opponent in
// closest-standing order, recursing on what's left; if a choice can't be extended into a
// complete zero-repeat matching for the REST of the pool, it backtracks and tries the next
// opponent — the step a plain greedy walk skips, which is exactly how it can strand two
// candidates with each other (see the header comment above). Returns null — not a
// repeat-containing matching — when no zero-repeat completion exists from here, so a caller
// can tell "impossible" apart from "found one" and only then fall back to greedyMatching, which
// is the one place a repeat is ever chosen. `budget.n` is decremented on every attempt and
// shared across the whole recursion (mutated in place), so total work is bounded regardless of
// tree depth; running out returns null the same as genuine impossibility, and the caller's
// greedy fallback still always completes since repeats are unconditionally allowed there.
function findMatching(pool, played, budget) {
  if (!pool.length) return [];
  const [a, ...rest] = pool;
  for (const b of rest) {
    if (played.has(pairKey(a.name, b.name))) continue;   // this search only ever considers UNPLAYED pairs
    if (budget.n <= 0) return null;
    budget.n--;
    const remaining = rest.filter(c => c !== b);
    const sub = findMatching(remaining, played, budget);
    if (sub) return [[a, b], ...sub];
  }
  return null;   // no zero-repeat completion from here (or the budget ran out) — caller falls back
}

// The original greedy pass (closest-standing first, first not-yet-played opponent, forced repeat
// if none remain) — kept only as findMatching's fallback if MATCH_ATTEMPT_CAP is ever exhausted,
// so pairRound always terminates and always returns a complete pairing either way.
function greedyMatching(pool, played) {
  const rest = [...pool];
  const pairs = [];
  while (rest.length) {
    const a = rest.shift();
    let idx = rest.findIndex(b => !played.has(pairKey(a.name, b.name)));
    if (idx === -1) idx = 0;
    const b = rest.splice(idx, 1)[0];
    pairs.push([a, b]);
  }
  return pairs;
}

// One round's pairings off the current standings, sorted highest-first. `played` is the set of
// pairKey()s already run in ANY earlier round of this bracket; `hadBye` is the set of names
// already given a bye. Returns { pairs: [[aRow, bRow], ...], byeName } — `pairs` holds the
// standings rows (not the candidate objects; the caller looks the candidate up by name), so
// this function stays pure and easy to test on plain data. Exported for direct, fast unit tests
// against synthetic standings/played-sets — the pairing algorithm's own correctness doesn't
// depend on running real matches.
// Rank a Swiss field. Win RATE, with raw wins as the tie-break — not absolute wins, which is what
// this used to sort on. A bye is scorable-neutral (nothing added to wins or losses), but its
// recipient simply plays one fewer pairing, i.e. worlds x seeds x 2 fewer chances to earn a win —
// 16 under the swiss CLI defaults. Sorting on totals therefore ranked "everyone who avoided a bye,
// then everyone who didn't": a 2W-2L candidate at 50% finished below a 3W-3L candidate at 50%
// purely for having played more. That is the mirror image of the bug e9ad1d0 fixed, in the one
// place the tool is meant to be trustworthy. Ties fall back to name so the order is total.
export function rankStandings(rows) {
  const rate = r => {
    const n = (r.wins || 0) + (r.losses || 0) + (r.draws || 0);
    return n > 0 ? (r.wins || 0) / n : 0;
  };
  return [...rows].sort((x, y) =>
    rate(y) - rate(x) || (y.wins || 0) - (x.wins || 0) || (x.losses || 0) - (y.losses || 0)
    || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

export function pairRound(standingsRows, played, hadBye) {
  // Tie-break the pairing order by NAME, not by list position. Every standing is 0-0 in round 1, and
  // a stable sort preserved input order, so the loop below always took the last-LISTED candidate:
  // `--candidates a.json,…,e.json` structurally penalised e.json for nothing but its position.
  const order = [...standingsRows].sort((a, b) =>
    b.wins - a.wins || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let byeName = null;
  if (order.length % 2 === 1) {
    let idx = -1;
    for (let i = order.length - 1; i >= 0; i--) if (!hadBye.has(order[i].name)) { idx = i; break; }
    if (idx === -1) idx = order.length - 1;   // everyone's already had one — lowest standing again
    byeName = order.splice(idx, 1)[0].name;
  }
  const pairs = findMatching(order, played, { n: MATCH_ATTEMPT_CAP }) || greedyMatching(order, played);
  return { pairs, byeName };
}

// One difficulty bracket's whole Swiss schedule: `numRounds` rounds of pairRound, each pairing
// run through runSwappedDuel exactly like round-robin's own pairs — same opts shape, same
// fairness. Standings accumulate match wins/losses/draws round over round, same tallying
// runRoundRobinSwapped already does per pairing; a bye adds only to `byes`, never `wins`/
// `losses` — see the header comment above.
// The Swiss SCHEDULE, with the match runner injected. Extracted so the combinatorics — round count,
// pairings per round, bye rotation, rematch avoidance, standings order — can be tested on synthetic
// results in milliseconds instead of by simulating real 15-40 sim-minute matches. Those schedule
// tests were roughly 50 s of the suite's wall clock, all of it spent proving arithmetic. (The file
// already demonstrated the fast idiom once, in pairRound's own test, and said why it was better.)
// runSwissBracket below is now a thin wrapper that injects the real runSwappedDuel.
export function buildSwissBracket(candidates, numRounds, opts, runPair) {
  const worlds = opts.worlds || ["korrath", "ferros", "vesper", "kybernet"];
  const seeds = opts.seeds ?? 2;
  const byeMatchCount = worlds.length * seeds * 2;   // informational only — == a real pairing's runSwappedDuel `n`
  const standings = new Map(candidates.map(c => [c.name, { name: c.name, wins: 0, losses: 0, draws: 0, byes: 0 }]));
  const played = new Set(), hadBye = new Set();
  const rounds = [];
  for (let round = 1; round <= numRounds; round++) {
    const { pairs, byeName } = pairRound([...standings.values()], played, hadBye);
    if (byeName) {
      standings.get(byeName).byes += 1;   // NOT a win — see header comment
      hadBye.add(byeName);
    }
    const matches = [];
    // Fold the round number into the seed so a forced rematch in a later round isn't a byte-for-byte
    // copy of the earlier one, while staying fully deterministic (hashStr, no clock, no Math.random)
    // — the same discipline duelSeed() already applies to world/difficulty/names/rep.
    const roundSeedBase = hashStr(`${opts.seedBase ?? 1}:swiss:round${round}`);
    for (const [aRow, bRow] of pairs) {
      const a = candidates.find(c => c.name === aRow.name);
      const b = candidates.find(c => c.name === bRow.name);
      played.add(pairKey(a.name, b.name));
      const res = runPair(a, b, { ...opts, seedBase: roundSeedBase });
      const A = standings.get(a.name), B = standings.get(b.name);
      A.wins += res.aWins; A.losses += res.bWins; A.draws += res.draws;
      B.wins += res.bWins; B.losses += res.aWins; B.draws += res.draws;
      matches.push(res);
    }
    rounds.push({ round, byeName, byeMatchCount: byeName ? byeMatchCount : null, matches });
  }
  return {
    rounds: numRounds, byeMatchCount, roundsLog: rounds,
    standings: rankStandings([...standings.values()]),
  };
}

function runSwissBracket(candidates, numRounds, opts) {
  return {
    difficulty: pinnedDuelDials(opts.difficulty).difficulty,   // normalized — see pinnedDuelDials' own comment
    ...buildSwissBracket(candidates, numRounds, opts, runSwappedDuel),
  };
}

// Swiss-paired tournament over `candidates`: `Math.max(3, Math.ceil(Math.log2(n)))` rounds by
// default (override with `opts.rounds`), each round pairing candidates by CLOSEST current
// standing rather than running the full C(n,2) round-robin — see the TIER 5 header comment
// above for why and for exactly what stays identical to round-robin (the pairing primitive,
// runSwappedDuel, and its fairness guarantees) versus what's new (the schedule). Same
// `--difficulties` plural/never-blended convention as runDuelBrackets/runRoundRobinSwapped:
// returns one independent { difficulty, rounds, roundsLog, standings } tournament per bracket.
export function runSwissTournament(candidates, opts = {}) {
  assertUniqueCandidateNames(candidates);
  if (candidates.length < 2) throw new Error("a Swiss tournament needs at least 2 candidates");
  const { difficulties, difficulty, rounds, ...rest } = opts;
  const list = difficulties && difficulties.length ? difficulties : [difficulty || "medium"];
  const numRounds = rounds || Math.max(3, Math.ceil(Math.log2(candidates.length)));
  return list.map(diff => runSwissBracket(candidates, numRounds, { ...rest, difficulty: diff }));
}

/* ============================================================
   HEALTH CHECKS — the findings this bench already turned up, encoded

   Each is a named, reproducible defect rather than a paragraph in a review doc: run the
   check, get the list of worlds it fires on. Fix the AI and the list shrinks. These are
   REPORTED, not asserted — the tool's job is to measure, and today several of them fire.
   ============================================================ */

export const CHECKS = [
  { id: "supply-deadlock",
    why: "the mix cycle is stuck on a unit that won't fit under the supply cap, with no Habitat on "
       + "the way to raise it — the state that never resolves itself (being momentarily blocked "
       + "WITH one under construction is ordinary supply pressure on a busy AI, not a deadlock)",
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
    why: "every Barracks stood idle while the AI held real money, on a strategy that isn't "
       + "deliberately capping its army — it had nothing left it knew how to buy",
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
    // 'real' (the default) is the whole point of this flag: exercise the AI's own difficulty-row
    // aiApm cap, the one dial every CLI run used to skip entirely. 'none' opts back into the old
    // always-unthrottled runs, for a baseline comparison against the bench's pre-APM history.
    apm: args.apm === "none" ? "none" : "real",
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

// One single-direction duel's rows plus its aggregate — reuses pad() exactly like printTable()
// above. Used both standalone (whichever direction is being shown) and by printSwappedDuel
// below, once per direction.
function printDuelRows(res) {
  console.log(pad("world", 10) + pad("seed", 13) + pad("swap", 6) + pad("winner", 8) + pad("reason", 16)
    + pad("time(s)", 9) + pad("aScore", 9) + pad("bScore", 9) + "margin");
  for (const r of res.rows)
    console.log(pad(r.world, 10) + pad(r.seed, 13) + pad(r.swapAsym, 6) + pad(r.winner, 8) + pad(r.winReason || "-", 16)
      + pad(r.time, 9) + pad(r.aScore, 9) + pad(r.bScore, 9) + r.margin);
  console.log(`\n${res.aName}: ${res.aWins}W  ${res.bName}: ${res.bWins}W  draws: ${res.draws}  `
    + `avg score margin (${res.aName} - ${res.bName}): ${res.avgMargin}`);
}

// A Tier 3 side-swapped, single-difficulty-bracket result (one entry of runDuelBrackets' array):
// prints BOTH directions (aAsAi/bAsAi) as their own labelled table, per the TIER 3 header
// comment — never collapsed into one set of rows — then the combined tally.
function printSwappedDuel(res) {
  console.log(`DUEL -- ${res.aName} (${res.aStrategy}) vs ${res.bName} (${res.bStrategy}) -- `
    + `difficulty "${res.difficulty}" pinned identical for both sides, ${res.n} matches total -- `
    + `side-swapped (both directions below), map-side asym (oort/nimbus) alternated by replicate `
    + `within each direction, a no-op elsewhere`);
  console.log(`\n  -- ${res.bName} as "ai", ${res.aName} as "player" (${res.bAsAi.n} matches) --`);
  printDuelRows(res.bAsAi);
  console.log(`\n  -- ${res.aName} as "ai", ${res.bName} as "player" (${res.aAsAi.n} matches) --`);
  printDuelRows(res.aAsAi);
  console.log(`\nCOMBINED (${res.difficulty}): ${res.aName}: ${res.aWins}W  ${res.bName}: ${res.bWins}W  `
    + `draws: ${res.draws}  avg score margin (${res.aName} - ${res.bName}): ${res.avgMargin}`);
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

/* ============================================================
   SEARCH — a deterministic coordinate scan over a strategy's numeric dials, keeping an
   improvement. Deliberately the simplest thing that works; the interesting judgement is which
   dials to open, and that stays the caller's.

   Two OBJECTIVES an evaluate() step can score a candidate dial-value by, selected once up front
   and never mixed mid-run:
     - default: solo score() against the --opponent scripted sparring bot (unchanged from before
       this file grew a second mode — same runMatrix/score call, same seed derivation).
     - --tournament-against baseline.json: Tier 2/3's fair, side-swapped, difficulty-bracketed
       self-play duel (runDuelBrackets) against a FIXED baseline candidate, standing measured as
       win differential (aWins - bWins) / n across every bracket combined. This is the same
       "candidate vs a fixed yardstick" shape score()-mode already has — just the yardstick is a
       real opponent playing the real AI, not a scripted bot's solitaire curve.

   The coordinate-scan mechanics below (the per-dial, per-step loop, "keep an improvement if it
   beats the current best") are IDENTICAL in both modes and don't know which objective is active
   — only evaluate()'s own body differs. Returns a plain result object (not console output) so
   both the CLI and a test can read it directly.
   ============================================================ */

export function runSearch(args) {
  const name = args.strategy || "default";
  const dials = list(args.dials, []).map(d => {
    const [k, range] = d.split("=");
    const [lo, hi] = String(range).split(":").map(Number);
    return { k, lo, hi };
  });
  if (!dials.length) return null;   // caller prints the --dials usage line
  const worlds = list(args.worlds, ["korrath", "ferros", "vesper"]);
  const difficulties = list(args.difficulties, ["medium"]);
  const steps = num(args.steps, 4);
  const base = { ...(STRATEGIES[name] || {}) };

  const baselinePath = args["tournament-against"];
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
  if (baseline && !baseline.name) throw new Error('--tournament-against candidate needs a "name"');

  // Solo score() against the scripted sparring bot — untouched from before this file had a
  // second mode: same runMatrix call, same score() reduction.
  const scoreEvaluate = row => {
    applyOverrides({ strategies: { [`${name}__lab`]: row } });
    const rows = runMatrix(args, { worlds, strategies: [`${name}__lab`], difficulties, seeds: num(args.seeds, 1) });
    return { mean: rows.reduce((a, r) => a + score(r).total, 0) / rows.length, rows };
  };
  // Tier 2/3 side-swapped, difficulty-bracketed self-play duel standing against the fixed
  // baseline candidate — runDuelBrackets is the exact function `duel --difficulties` runs; this
  // just folds its per-bracket tallies into the single scalar the coordinate scan needs to
  // compare "better than the current best" against, the same job score()'s .total already does
  // for the default objective.
  const tournamentEvaluate = row => {
    applyOverrides({ strategies: { [`${name}__lab`]: row } });
    const candidate = { name: `${name}__lab`, strategy: `${name}__lab` };
    const brackets = runDuelBrackets(candidate, baseline, {
      worlds, difficulties,
      seeds: num(args.seeds, 1), seedBase: num(args.seed, 1), minutes: num(args.minutes, 40),
    });
    const n = brackets.reduce((a, b) => a + b.n, 0);
    const aWins = brackets.reduce((a, b) => a + b.aWins, 0);
    const bWins = brackets.reduce((a, b) => a + b.bWins, 0);
    const draws = brackets.reduce((a, b) => a + b.draws, 0);
    return { mean: n ? (aWins - bWins) / n : 0, brackets, aWins, bWins, draws, n };
  };
  const evaluate = baseline ? tournamentEvaluate : scoreEvaluate;

  const log = [];
  let best = { ...base }, bestEval = evaluate(best), bestScore = bestEval.mean;
  log.push({ kind: "start", name, mean: bestScore, dials: pickDials(best, dials) });
  for (const d of dials) {
    for (let i = 0; i <= steps; i++) {
      const v = +(d.lo + (d.hi - d.lo) * (i / steps)).toFixed(3);
      const cand = { ...best, [d.k]: v };
      const evald = evaluate(cand);
      const better = evald.mean > bestScore + 1e-9;
      log.push({ kind: "step", k: d.k, v, mean: evald.mean, better, detail: evald });
      if (better) { best = cand; bestScore = evald.mean; bestEval = evald; }
    }
  }
  log.push({ kind: "best", mean: bestScore, dials: pickDials(best, dials) });
  return {
    name, dials, worlds, difficulties, steps,
    mode: baseline ? "tournament" : "score",
    baseline, best, bestScore, bestEval, log,
  };
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

  search(args) {
    const result = runSearch(args);
    if (!result) { console.log("--dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'"); return; }
    for (const entry of result.log) {
      if (entry.kind === "start") {
        console.log(`start ${entry.name} -> ${entry.mean.toFixed(3)}  ${JSON.stringify(entry.dials)}`);
      } else if (entry.kind === "step") {
        const tourn = result.mode === "tournament"
          ? `  (${entry.detail.aWins}W-${entry.detail.bWins}L-${entry.detail.draws}D vs ${result.baseline.name})`
          : "";
        console.log(`  ${pad(entry.k + "=" + entry.v, 32)} ${entry.mean.toFixed(3)}${entry.better ? "  *" : ""}${tourn}`);
      } else if (entry.kind === "best") {
        console.log(`\nbest ${entry.mean.toFixed(3)}  ${JSON.stringify(entry.dials, null, 1)}`);
      }
    }
    if (result.mode === "tournament") {
      console.log(`\nTOURNAMENT MODE: each dial value was scored by Tier 2/3 side-swapped, `
        + `difficulty-bracketed self-play duel standing (win% differential, aWins-bWins over n) `
        + `against baseline candidate "${result.baseline.name}", NOT solo score() against a `
        + `scripted sparring bot.`);
    }
    console.log("\nThis is a LOCAL search on a noisy objective — re-run the winner through "
      + "`sweep --seeds 3` on the full roster before believing it, then `duel`/`compare` against "
      + "the baseline, `npm test`, and `ailab check` before promoting anything into engine/.");
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

  leaderboard(args) {
    const paths = list(args.candidates, []);
    if (!paths.length) { console.log("--candidates a.json,b.json,... (each: { name, strategy, overrides })"); return; }
    const candidates = paths.map(p => JSON.parse(readFileSync(p, "utf8")));
    const worlds = list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]);
    const difficulty = args.difficulty || "medium";
    const opponent = args.opponent || "tech";
    const seeds = num(args.seeds, 2);
    const results = runLeaderboard(candidates, {
      worlds, difficulty, opponent, seeds,
      minutes: args.minutes, sample: args.sample, apm: args.apm, seed: args.seed,
    });

    console.log("PROXY LEADERBOARD -- ranks candidates by score against a FIXED, non-adaptive sparring");
    console.log(`bot (${OPPONENTS[opponent].desc}), difficulty "${difficulty}" held identical for every`);
    console.log("candidate so none gets an APM/micro edge. NOT head-to-head play -- see the LEADERBOARD");
    console.log("header comment in this file for exactly what that does and doesn't prove.\n");
    console.log(pad("#", 4) + pad("candidate", 28) + pad("strategy", 13) + pad("score", 8) + "components");
    results.forEach((r, i) => {
      const parts = Object.entries(r.partsMean).map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ");
      console.log(pad(String(i + 1), 4) + pad(r.name, 28) + pad(r.strategy, 13) + pad(r.mean.toFixed(3), 8) + parts);
    });
    console.log("\nweakest matchup per candidate (lowest single score in its own run set):");
    for (const r of results)
      console.log(`  ${pad(r.name, 28)} ${r.worst.world}/${r.worst.difficulty}/seed=${r.worst.seed}  `
        + `${score(r.worst).total.toFixed(3)}`);
    if (args.json) {
      writeFileSync(args.json, JSON.stringify(results.map(({ worst, ...r }) => r), null, 1));
      console.log(`\nwrote ${args.json}`);
    }
  },

  // Tier 3: real head-to-head via Tier 1 self-play (tools/selfplay.js), side-swapped by DEFAULT
  // and difficulty-bracketed — see the TIER 3 and DUEL header comments above for exactly what's
  // fair here and why. --a/--b run one pair; --candidates a.json,b.json,c.json (3+) runs every
  // pair round-robin instead (a nice-to-have — see runRoundRobinSwapped above) and neither flag
  // combination requires the other to exist. --difficulties (plural, comma list) sweeps several
  // brackets, each reported on its own; --difficulty (singular) still works as a one-bracket
  // shorthand, default "medium", unchanged from Tier 2.
  duel(args) {
    const duelOpts = {
      worlds: list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]),
      seeds: num(args.seeds, 2),
      seedBase: num(args.seed, 1),
      minutes: args.minutes !== undefined ? Number(args.minutes) : undefined,
    };
    const difficulties = list(args.difficulties, [args.difficulty || "medium"]);
    const paths = list(args.candidates, []);
    if (!args.a && !args.b && paths.length < 2) {
      console.log('--a candA.json --b candB.json   (or --candidates a.json,b.json,c.json for round-robin)');
      console.log('[--worlds a,b] [--difficulties medium,hard] [--seeds 2] [--seed 1] [--minutes 40] [--json out.json]');
      console.log('Every pairing runs side-swapped by default (each candidate plays BOTH owner slots) and');
      console.log('each --difficulties entry is reported as its own bracket, never blended together.');
      return;
    }
    if (args.a || args.b) {
      if (!args.a || !args.b) { console.log("duel needs BOTH --a and --b"); return; }
      const a = JSON.parse(readFileSync(args.a, "utf8"));
      const b = JSON.parse(readFileSync(args.b, "utf8"));
      const brackets = runDuelBrackets(a, b, { ...duelOpts, difficulties });
      for (const res of brackets) { printSwappedDuel(res); console.log(); }
      if (args.json) { writeFileSync(args.json, JSON.stringify(brackets, null, 1)); console.log(`\nwrote ${args.json}`); }
      return;
    }
    const candidates = paths.map(p => JSON.parse(readFileSync(p, "utf8")));
    const roundRobinBrackets = runRoundRobinSwapped(candidates, { ...duelOpts, difficulties });
    for (const { difficulty, pairs, standings } of roundRobinBrackets) {
      console.log(`\n=== difficulty: ${difficulty} ===`);
      for (const res of pairs) { printSwappedDuel(res); console.log(); }
      console.log(`ROUND-ROBIN STANDINGS (${difficulty})`);
      console.log(pad("#", 4) + pad("candidate", 28) + pad("W", 5) + pad("L", 5) + "D");
      standings.forEach((s, i) => console.log(pad(String(i + 1), 4) + pad(s.name, 28) + pad(s.wins, 5) + pad(s.losses, 5) + s.draws));
    }
    if (args.json) {
      writeFileSync(args.json, JSON.stringify(roundRobinBrackets, null, 1));
      console.log(`\nwrote ${args.json}`);
    }
  },

  // Tier 5: same runSwappedDuel pairing as `duel --candidates`, a Swiss SCHEDULE instead of full
  // round-robin — see the TIER 5 header comment above for why and for exactly what stays fair.
  // Meant for pools too large for round-robin's C(n,2) pairings to stay cheap.
  swiss(args) {
    const paths = list(args.candidates, []);
    if (paths.length < 2) {
      console.log("--candidates a.json,b.json,c.json,...   (2+ candidates; Swiss pays off once there are many)");
      console.log("[--rounds N] [--worlds a,b] [--difficulties medium,hard] [--seeds 2] [--seed 1] [--minutes 40] [--json out.json]");
      console.log("Default rounds: max(3, ceil(log2(candidates))). Each pairing is side-swapped and difficulty-bracketed");
      console.log("exactly like `duel`; each --difficulties entry runs its own independent Swiss tournament, never blended.");
      return;
    }
    const candidates = paths.map(p => JSON.parse(readFileSync(p, "utf8")));
    const swissOpts = {
      worlds: list(args.worlds, ["korrath", "ferros", "vesper", "kybernet"]),
      seeds: num(args.seeds, 2),
      seedBase: num(args.seed, 1),
      minutes: args.minutes !== undefined ? Number(args.minutes) : undefined,
      difficulties: list(args.difficulties, [args.difficulty || "medium"]),
      rounds: args.rounds !== undefined ? Number(args.rounds) : undefined,
    };
    const brackets = runSwissTournament(candidates, swissOpts);
    for (const { difficulty, rounds, roundsLog, standings } of brackets) {
      console.log(`\n=== SWISS -- difficulty: ${difficulty} -- ${rounds} round(s), ${candidates.length} candidates ===`);
      for (const { round, byeName, matches } of roundsLog) {
        console.log(`\n-- round ${round} --`);
        if (byeName) console.log(`  bye: ${byeName} (not paired this round -- no win/loss credit either way)`);
        for (const res of matches) { printSwappedDuel(res); console.log(); }
      }
      console.log(`SWISS STANDINGS (${difficulty})`);
      console.log(pad("#", 4) + pad("candidate", 28) + pad("W", 5) + pad("L", 5) + pad("D", 5) + "byes");
      standings.forEach((s, i) =>
        console.log(pad(String(i + 1), 4) + pad(s.name, 28) + pad(s.wins, 5) + pad(s.losses, 5) + pad(s.draws, 5) + s.byes));
    }
    if (args.json) {
      writeFileSync(args.json, JSON.stringify(brackets, null, 1));
      console.log(`\nwrote ${args.json}`);
    }
  },
};

const USAGE = `AI LAB — a headless bench for the Odyssey opponent.

  node tools/ailab.js probe   [--world ferros] [--strategy default] [--difficulty medium]
                              [--opponent passive] [--minutes 40] [--sample 5]
  node tools/ailab.js sweep   [--worlds a,b] [--strategies a,b] [--difficulties a,b]
                              [--seeds 3] [--minutes 40] [--json out.json] [--csv out.csv] [--full]
  node tools/ailab.js compare --baseline base.json --candidate cand.json
  node tools/ailab.js search  --strategy aggressive --dials 'attackTimeoutMult=0.3:1,garrisonMult=0:1'
                              [--steps 4] [--worlds a,b] [--difficulties a,b]
                              [--tournament-against baseline.json]
                              -- default objective: solo score() against --opponent, unchanged.
                              --tournament-against swaps ONLY the objective onto a Tier 2/3
                              side-swapped, difficulty-bracketed self-play duel (runDuelBrackets)
                              against the named baseline candidate { name, strategy, overrides },
                              scored by win differential (aWins - bWins) / n. The coordinate-scan
                              loop itself is unchanged either way.
  node tools/ailab.js check   [--worlds a,b] [--minutes 60] [--exit-code]
  node tools/ailab.js leaderboard --candidates a.json,b.json,c.json
                              [--worlds a,b] [--difficulty medium] [--opponent tech] [--seeds 2]
                              [--json out.json]
                              -- ranks candidates against the SAME fixed opponent, all other dials
                              held equal (a proxy for competitive self-play, not a substitute for
                              it — see the LEADERBOARD header comment). Each candidate file is
                              { "name": "...", "strategy": "aggressive", "overrides": {...} }.
  node tools/ailab.js duel   --a candA.json --b candB.json
                              [--worlds a,b] [--difficulties medium,hard] [--seeds 2] [--seed 1]
                              [--minutes 40] [--json out.json]
                              -- TRUE head-to-head: candA and candB fight via Tier 1 self-play
                              (tools/selfplay.js), both sides the real AI, difficulty pinned
                              identical for both — see the DUEL header comment for the fairness
                              guarantee. Resolves via engine/victory.js exactly like any skirmish
                              (elimination or the score-at-clock tiebreak). --candidates
                              a.json,b.json,c.json instead runs every pair round-robin.
                              Tier 3, on by default: every pairing is SIDE-SWAPPED (each candidate
                              plays both the "ai" and "player" owner slot, both halves reported),
                              and --difficulties (plural) sweeps several brackets, each reported
                              standalone -- never averaged across difficulty -- see the TIER 3
                              header comment.
  node tools/ailab.js swiss  --candidates a.json,b.json,c.json,...
                              [--rounds N] [--worlds a,b] [--difficulties medium,hard]
                              [--seeds 2] [--seed 1] [--minutes 40] [--json out.json]
                              -- Tier 5: the SAME side-swapped, difficulty-bracketed runSwappedDuel
                              pairing 'duel --candidates' uses, scheduled as SWISS rounds instead
                              of full round-robin, for candidate pools too large for C(n,2)
                              pairings to stay cheap. Default rounds: max(3, ceil(log2(n))). Each
                              round pairs candidates by closest current standing, backtracking to
                              find a zero-repeat pairing whenever one exists rather than a repeat
                              a greedy walk could've avoided -- see the TIER 5 header comment for
                              the pairing/bye rules.

Common flags
  --overrides f.json   inject candidate rows into the AI tables before running:
                       { "strategies":   { "swarm":  { "armyAttackSizeMult": 0.5 } },
                         "archetypes":   { "rusher": { "odyssey": { "workerTarget": 9 } } },
                         "difficulties": { "hard":   { "workerTargetMult": 1.4 } } }
  --seed N             base seed (default 1) — every row is reproducible from it
  --apm real|none      default 'real': the AI runs at its own difficulty row's aiApm cap;
                       'none' runs unthrottled (the old default), for baseline comparability`;

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

export { run, labWorld, sample, summarise, OPPONENTS, WORLDS, snapshotTables, restoreTables };
