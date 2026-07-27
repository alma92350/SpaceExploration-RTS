/* ============================================================
   Scripted AI opponent: keep workers on the nearest spendable node, keep
   population growing, put up a Barracks once it can afford one, then cycle
   through its archetype's unit mix (Skiff/Bastion/Lancer/Breacher — see
   entities.js for the rock-paper-scissors relationship) across every
   Barracks it owns, and throw its home army at the player's base in
   repeated waves, once each wave is big enough (or the game's dragged on
   long enough that it should commit anyway). Along the way it fortifies
   with Sentinel Turrets on the approach vector, expands to a second
   Command Center when its home ore runs thin, puts up a Refinery (and, on a
   big map, plants extra Refineries forward as resource drop-offs to shorten a
   long ore haul without a whole second CC), and researches both upgrades — so
   the player isn't the only side that gets to use crystals/radioactives,
   expansions, decentralized collection, or defenses.

   The AI plays under its own fog of war (state.fogAI) — it is NOT omniscient.
   It keeps one unit out scouting (updateScout), and its intel-dependent moves
   are gated by what it has actually seen: every few units it breaks from the
   mix to counter whatever the player fields most, but only counting player
   units currently in its vision (counterToPlayerArmy); and it only mines or
   expands to nodes it has discovered — charted surface deposits always, hidden
   caches once scouted. The rest of the cycle follows the archetype's own
   flavor, so a Rusher doesn't turn into a pure reactive counter-picker.

   How aggressively vs. how patiently it plays — worker/army targets, attack
   timing, unit mix, how many turrets and barracks, when to expand — all comes
   from state.ai.archetype (see engine/aiArchetypes.js), which is picked by
   which planet the match is on. This file just executes whatever profile it's
   handed; every Tier 4 field is read with a use-site default so a legacy
   profile that predates them still runs.

   Layered on top of the archetype is state.ai.strategy (engine/aiStrategy.js) — a
   player-picked overlay (setup.js "AI Strategy"), orthogonal to which planet/
   archetype it's facing: Aggressive presses the attack earlier and forces the
   issue in Odyssey; Economic keeps a minimal standing army until it's actually
   attacked, then surges; Force Parity continuously matches whatever it's seen of
   the enemy's army. "default" (unset) reproduces today's pure archetype-driven
   play byte-for-byte — every multiplier defaults to 1 and every flag to falsy.

   This file is the ORCHESTRATOR: runAI runs the think-cycle and threads one
   world snapshot (aiContext) through the decision phases, which live in cohesive
   sibling modules so no single file is a 1000-line god object —
     • aiCommon.js     — the APM action budget + reserve-aware affordability + builder pick
     • aiStrategy.js   — the player-picked strategy table (Aggressive/Economic/Force Parity)
     • aiWorkers.js    — idle-worker logistics/gather steering + the unit-mix filters
     • aiMilitary.js   — defend/attack waves, focus-fire, the scout, target/mix picks
     • aiEconomy.js    — base build-out, expansion, tech gates, production, research
     • aiIndustry.js   — the Odyssey factory chain / power / capital path / rig
     • aiSuperweapon.js — arms/delivers a built Helium Bomb
   The phase order in runAI is load-bearing (shared action budget + ore reserves),
   so it stays here where the whole sequence reads top-to-bottom.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { playerBuildings, playerUnits } from "./state.js";
import { accrueActionBudget } from "./aiCommon.js";
import { assignIdleWorkers } from "./aiWorkers.js";
import { updateScout, aiMilitary, applyFocusFire, visibleThreatsNearHome } from "./aiMilitary.js";
import { aiFoundOrSurvive, aiExpand, aiBaseAndTech, aiProduceAndFortify, aiResearch } from "./aiEconomy.js";
import { aiIndustry } from "./aiIndustry.js";
import { aiSuperweapon } from "./aiSuperweapon.js";
import { strategyFor } from "./aiStrategy.js";

const THINK_INTERVAL = 1.5;

export function runAI(state, dt) {
  accrueActionBudget(state, dt);   // every tick, so credits build up between think cycles
  state.ai.think = (state.ai.think || 0) - dt;
  if (state.ai.think > 0) return;
  state.ai.think = THINK_INTERVAL;

  // One snapshot of the AI's world, threaded through every decision phase below. Order is
  // load-bearing: each phase can spend from a shared per-cycle action budget (canAct/spend),
  // and an earlier phase can bank ore (ctx.*Reserve) that a later one must leave alone.
  const ctx = aiContext(state);

  // Scout + worker assignment run first — a worker turned scout mustn't then be re-tasked to gather.
  updateScout(state, ctx.army, ctx.rangers, ctx.threats.length > 0);
  assignIdleWorkers(state, ctx.workers);

  aiFoundOrSurvive(state, ctx);    // Odyssey: (re)seat a razed / opening base from a colony ship
  aiExpand(state, ctx);            // scout Ranger + found a second base once home ore thins (sets ctx.oreReserve)
  aiBaseAndTech(state, ctx);       // workers, supply, Barracks, the Foundry/Arsenal tech gates, the Mender
  aiProduceAndFortify(state, ctx); // the shared unit-production cycle, Turrets, a 2nd Barracks, Refineries
  aiResearch(state, ctx);          // one doctrine upgrade per think cycle
  aiIndustry(state, ctx);          // Odyssey: power the base + electrify it (deeper phases: the factory chain)
  aiMilitary(state, ctx);          // defend a pressed base, else muster and commit the next wave
  aiSuperweapon(state, ctx);       // Odyssey: arm/deliver a built Helium Bomb (engine/aiSuperweapon.js)

  // TACTICAL micro (opt-in via aiMicro): concentrate the army's fire on one target so kills land
  // faster and incoming damage drops sooner — layered on top of the wave logic above without
  // touching it. A no-op unless real enemy combat is in sight, so the resolve guarantee holds.
  if (state.ai.micro) applyFocusFire(state, ctx.army);
}

// Snapshot the AI's world once per think cycle: the archetype (+ an `arch` reader that lets its
// Odyssey overlay win), the AI's own units bucketed by role, its buildings and the key ones by
// type, and the enemy combat pressing home. The three *Reserve fields start at 0 and are the
// running ore holdbacks the phases pass forward. See the AiContext typedef in engine/types.js.
/** @param {State} state @returns {AiContext} */
function aiContext(state) {
  const archetype = state.ai.archetype;
  const arch = field => (state.diplomacy && archetype.odyssey && archetype.odyssey[field] != null)
    ? archetype.odyssey[field] : archetype[field];
  const strategy = strategyFor(state);
  const buildings = playerBuildings(state, "ai");
  const threats = visibleThreatsNearHome(state);
  // WAR FOOTING (engine/aiStrategy.js Economic strategy): the instant the AI can SEE
  // combat units pressing its base, timestamp it — then for warFootingTime seconds
  // afterward, aiEconomy's standing-army throttle treats the AI as "recently attacked"
  // and lifts its cap, so being attacked is what turns a minimal economy into a real
  // production push. Updated here (not left to a later phase) so it's consistent for
  // every phase reading ctx.warFooting this same cycle. A strategy without
  // warFootingTime (every strategy but Economic) reads warFooting as permanently false.
  if (threats.length > 0) state.ai.lastThreatAt = state.time;
  const warFooting = !!strategy.warFootingTime
    && state.ai.lastThreatAt != null
    && (state.time - state.ai.lastThreatAt) < strategy.warFootingTime;
  return {
    archetype, arch, strategy, warFooting,
    ai: state.players.ai,
    workers: playerUnits(state, "ai").filter(u => u.type === "worker"),
    army: playerUnits(state, "ai").filter(u => UNITS[u.type].role === "combat"),
    rangers: playerUnits(state, "ai").filter(u => u.type === "ranger"),
    bombs: playerUnits(state, "ai").filter(u => u.type === "heliumbomb"),
    buildings,
    cc: buildings.find(b => b.type === "command" && !b.constructing),
    colonyShip: state.endless ? (playerUnits(state, "ai").find(u => u.type === "colonyship") || null) : null,
    barracks: buildings.find(b => b.type === "barracks"),
    refinery: buildings.find(b => b.type === "refinery"),
    allBarracks: buildings.filter(b => b.type === "barracks"),
    threats,
    oreReserve: 0, foundryReserve: 0, refineryReserve: 0,
  };
}
