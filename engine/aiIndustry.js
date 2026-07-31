/* ============================================================
   AI — the Odyssey industrial build order: power the base and electrify it,
   then (a patient developer only) climb the factory chain, work the Datacenter
   tech tree, and reach the capital path (Star Dock → Leviathan) and a Plasma
   Rig. Skirmish is a no-op (the endless gate), so the byte-identical short game
   is untouched. Depends on aiCommon (budget + affordability + builder pick) and
   aiWorkers (wantsDeepIndustry — moved there so its own plannedMix, the unit-mix
   half of "does this AI climb the deep chain", reads the exact same test this
   file's factory climb and industry reserve do).
   ============================================================ */

"use strict";

import { queueProduction } from "./production.js";
import { issueBuild } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, canAfford, prereqsMet, isElectrifiable } from "./entities.js";
import { powerCap, powerDraw } from "./industry.js";
import { researchTech } from "./techtree.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { canAct, spend, canAffordKeeping, pickBuilder } from "./aiCommon.js";
import { wantsDeepIndustry } from "./aiWorkers.js";

// The industrial build order the AI climbs (Odyssey), lowest tier first. prereqsMet gates each on
// its `requires` (an earlier factory + a research node), so the AI can only raise the next one once
// the chain and the tech beneath it are in place — a Smelter and a Datacenter open the tree, then
// each research node unlocks its factory. Deterministic first-buildable pick each think cycle.
//
// 'chemplant'/'fabricator' (docs/improvement-proposals.md "Promote the legacy consumer-goods
// recipes into a trade-industry branch") are folded into this SAME flat, world-independent
// priority order — same as every other entry here (a Reactor is always raised regardless of local
// deposits too) — so a developer AI CAN walk the new branch, not just the existing military/Gate
// spine. chemplant sits right after 'datacenter' (it needs no Smelter/metallurgy at all — see its
// own `requires` in entities.js — so prereqsMet alone decides whether it's actually reachable
// yet); fabricator sits right after 'assembler' (its own recipe needs alloys, so it can only ever
// win this priority race once the metallurgy branch has already supplied one). This does NOT bias
// the AI toward biomass-rich worlds specifically — a per-world "lean into this branch when biomass
// is abundant" heuristic is a reasonable follow-up, left out here since every other entry in this
// array is equally world-blind.
const INDUSTRY_CHAIN = ["smelter", "datacenter", "chemplant", "assembler", "fabricator", "chipfab",
                        "machineworks", "antimatterforge", "aifoundry", "torpedoworks"];

// The tech path the AI's Datacenter works through, lowest tier first: the passives that lift its
// industry (Fusion Containment power, Factory Automation rate, Heavy Alloys yield) interleaved with
// the unlock nodes that open the next factory (Metallurgy→Assembler, Microelectronics→Chip Fab,
// Precision Machining→Machine Works, Antimatter Containment→Forge, Machine Minds→AI Foundry).
//
// 'chemistry'/'consumerfab' slot in right after 'metallurgy': a genuinely separate branch (per
// engine/techtree.js, chemistry has no requires of its own) that a developer AI now researches
// early rather than only after the whole existing spine — mirroring INDUSTRY_CHAIN's placement
// of chemplant/fabricator just above.
const RESEARCH_ORDER = ["metallurgy", "chemistry", "consumerfab", "reactors", "electronics",
                        "automation", "heavyalloys", "machining", "antimatter", "aicores"];

// How many chain buildings get a BANKING reserve before the AI is expected to fund the rest from
// genuine surplus (aiIndustryReserve, below). Two — the Smelter and the Datacenter — is the set
// that opens the tree; past them the AI has industrial income and a longer reserve would just
// freeze its army for the whole climb.
const INDUSTRY_BOOTSTRAP = 2;

// The ore the AI must BANK this cycle to get its industry off the ground. runAI calls this between
// aiBaseAndTech and aiProduceAndFortify, because the phase order is production-first,
// industry-last with no holdback between them — so an archetype whose units are cheap relative to
// its income spent its ore down below a Reactor's 120 every think cycle and never developed at
// all. Measured: a Rusher world still on one industrial building after 60 sim-minutes, and Hard's
// rusherGraduates landing ~30 minutes past its own 20-minute trigger
// (docs/odyssey-ai-review.md §2.4).
//
// This mirrors ctx.foundryReserve exactly, including that it is BOUNDED: the power grid (every
// archetype needs one) plus the first INDUSTRY_BOOTSTRAP chain buildings. Past that the reserve
// is zero and the deep climb is bought from surplus, as before — the army is never frozen for the
// length of an eight-building chain. Skirmish is a no-op, same endless gate as aiIndustry itself.
/** @param {State} state @param {AiContext} ctx */
export function aiIndustryReserve(state, ctx) {
  ctx.industryReserve = 0;
  if (!state.endless) return;
  const { cc, barracks, buildings, archetype, strategy } = ctx;
  if (!cc || !barracks || barracks.constructing) return;   // same preconditions aiIndustry itself waits on
  const reactors = buildings.filter(b => b.type === "reactor");
  if (!reactors.length) { ctx.industryReserve = BUILDINGS.reactor.cost.ore; return; }
  if (reactors.some(b => b.constructing)) return;          // one already on the way — aiIndustry won't start a second
  if (!wantsDeepIndustry(state, archetype, strategy)) return;
  if (buildings.filter(b => INDUSTRY_CHAIN.includes(b.type)).length >= INDUSTRY_BOOTSTRAP) return;
  const next = INDUSTRY_CHAIN.find(t => !buildings.some(b => b.type === t) && prereqsMet(state, "ai", BUILDINGS[t]));
  if (next) ctx.industryReserve = BUILDINGS[next].cost.ore;
}

// Odyssey INDUSTRY: power the base and electrify it, then (a patient developer only) climb the
// factory chain and research the tech tree — the AI using the new economy. Skirmish is a no-op (the
// endless gate), so the byte-identical short game is untouched. Everything is APM-budgeted and
// reserve-aware, and runs after unit production so it's built from surplus — the army never freezes
// while the AI develops.
/** @param {State} state @param {AiContext} ctx */
export function aiIndustry(state, ctx) {
  if (!state.endless) return;   // Odyssey only — a skirmish never builds industry
  const { cc, barracks, workers, ai, buildings, archetype, strategy, army, bombs } = ctx;
  if (!cc || !barracks || barracks.constructing || workers.length === 0) return;

  const reactors = buildings.filter(b => b.type === "reactor");
  const hasReactor = reactors.some(b => !b.constructing);
  const cap = powerCap(state, "ai"), draw = powerDraw(state, "ai");

  // POWER: raise a Reactor when there's none yet (electrification and the factories need a grid) or
  // the grid is running tight (draw crowding cap), so Power scales with the industry the AI adds.
  // ONE AT A TIME — a Reactor takes 16s to finish and powerCap counts only completed ones, so without
  // the in-flight guard the AI keeps re-triggering "grid tight" every think cycle and over-builds a
  // dozen at once. Wait for the pending one to land, then re-evaluate. Reserve-aware, placed by the CC.
  const reactorPending = reactors.some(b => b.constructing);
  const wantMorePower = !reactors.length || (cap > 0 && draw > cap * 0.85);
  if (wantMorePower && !reactorPending && canAffordKeeping(ai.resources, BUILDINGS.reactor.cost, ctx.oreReserve) && canAct(state)) {
    const spot = findPlacement(state, "reactor", cc.x - 60, cc.y + 60);
    if (spot && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "reactor", spot.x, spot.y)) spend(state);
  }

  // ELECTRIFY: once the grid is live, wire the base's non-power buildings in — 30% faster unit
  // production (Barracks/Command Center) and +30% supply (Habitat). One per think cycle, APM-paced.
  // A pure win for the core army economy; if Power later runs short the boost just tapers (industry.js).
  if (hasReactor) {
    const target = buildings.find(b => !b.constructing && isElectrifiable(b.type) && !b.electrified);
    if (target && canAct(state)) { target.electrified = true; spend(state); }
  }

  // Deeper industry (factory chain + research) is a PATIENT developer's game — the same signal as
  // the Refinery (Economist/Balanced build it; a Rusher does not). A Rusher stops at power+electrify —
  // UNLESS the player-picked strategy overrides it: Economic (aiStrategy.js wantsIndustryAlways) climbs
  // the deep chain regardless of archetype, since pure economy means using every economic capability
  // in the game, even paired with a Rusher/Balanced world that wouldn't normally bother. OR unless
  // it's graduated (Tier 4, engine/aiDifficulty.js rusherGraduates — Hard only): a non-developing
  // archetype whose opening rush is long since resolved one way or the other picks up the same deep
  // chain a patient developer would, rather than sitting on a permanent 2-upgrade ceiling for the rest
  // of what can be an hours-long Odyssey session. Skirmish is untouched regardless — this whole
  // function already returned above on !state.endless, and a skirmish never runs this long anyway.
  // The chain needs the grid, so wait for the Reactor before starting it either way.
  if (!wantsDeepIndustry(state, archetype, strategy) || !hasReactor) return;

  // FACTORY CHAIN: raise the next chain building whose prereqs (its earlier factory + its research
  // node) are met and that the AI doesn't already have, one per think cycle, reserve-aware. Spread
  // in a spiral around the CC so its efficiency grid stays tight (findPlacement slides off collisions).
  const industryCount = buildings.filter(b => INDUSTRY_CHAIN.includes(b.type) || b.type === "reactor").length;
  const nextFactory = INDUSTRY_CHAIN.find(t => !buildings.some(b => b.type === t) && prereqsMet(state, "ai", BUILDINGS[t]));
  if (nextFactory && canAffordKeeping(ai.resources, BUILDINGS[nextFactory].cost, ctx.oreReserve) && canAct(state)) {
    const ang = industryCount * 2.4, rad = 120 + 18 * industryCount;
    const spot = findPlacement(state, nextFactory, cc.x + Math.cos(ang) * rad, cc.y + Math.sin(ang) * rad);
    if (spot && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, nextFactory, spot.x, spot.y)) spend(state);
  }

  // RESEARCH: at a completed Datacenter, queue the next unowned node whose prereqs are met (lowest
  // tier first). researchTech already gates prereqs/affordability/dupes, so try each in order and
  // stop at the first that takes — one purchase per think cycle, paid in gathered crystals/radioactives.
  const datacenter = buildings.find(b => b.type === "datacenter" && !b.constructing);
  if (datacenter && canAct(state)) {
    for (const techId of RESEARCH_ORDER) {
      if (ai.upgrades[techId]) continue;
      if (researchTech(state, datacenter.id, techId)) { spend(state); break; }
    }
  }

  // CAPITAL PATH: once the whole Strategic tree stands (a Star Dock proves the AI Foundry + Torpedo
  // Works are up), the AI can field LEVIATHANS — a real capital ship (role "combat", so aiMilitary
  // folds it into the waves), the payoff for the deep climb and the sink for its strategic goods.
  // One Star Dock, reserve-aware.
  const hasStardock = buildings.some(b => b.type === "stardock");
  if (!hasStardock && prereqsMet(state, "ai", BUILDINGS.stardock)
      && canAffordKeeping(ai.resources, BUILDINGS.stardock.cost, ctx.oreReserve) && canAct(state)) {
    const spot = findPlacement(state, "stardock", cc.x + 120, cc.y - 90);
    if (spot && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "stardock", spot.x, spot.y)) spend(state);
  }
  // Train a Leviathan at a completed, idle Star Dock when the manufactured strategic goods (AI Cores
  // + Plasma Torpedoes) are on hand and there's supply for the 8-supply capital ship. queueProduction
  // re-checks cost/supply/prereqs, so this only ever fires when it truly can.
  const stardock = buildings.find(b => b.type === "stardock" && !b.constructing);
  if (stardock && stardock.queue.length === 0 && canAct(state)
      && supplyUsed(state, "ai") + (UNITS.leviathan.supplyCost || 0) <= supplyCap(state, "ai")
      && canAfford(ai.resources, UNITS.leviathan.cost)) {
    if (queueProduction(state, stardock.id, "leviathan")) spend(state);
  }

  // HELIUM BOMB: the doomsday device beside the Leviathan at the same Star Dock (entities.js
  // stardock.produces) — at most one, and only once a Leviathan is already up or training, so it
  // never crowds out the capital-ship investment above. Every strategy gets a use for it (see
  // engine/aiSuperweapon.js: a built bomb becomes a home-defense trap the instant the AI is
  // attacked); Aggressive strategy also walks it into the enemy's lines. Reserve-aware like every
  // other Star Dock spend; gas is the one NEW cost commodity it needs beyond what a Leviathan-
  // capable base already produces, so it simply never completes on a gas-less world (accepted,
  // same graceful degradation as every other specialty-commodity unit on the roster).
  const hasLeviathan = army.some(u => u.type === "leviathan") || (stardock && stardock.queue.some(j => j.unitType === "leviathan"));
  if (stardock && stardock.queue.length === 0 && bombs.length === 0 && hasLeviathan && canAct(state)
      && supplyUsed(state, "ai") + (UNITS.heliumbomb.supplyCost || 0) <= supplyCap(state, "ai")
      && canAfford(ai.resources, UNITS.heliumbomb.cost)) {
    if (queueProduction(state, stardock.id, "heliumbomb")) spend(state);
  }

  // PLASMA RIG: an unlimited ore source for the late game, once the AI has the AI Foundry (its pilot)
  // and a Reactor (its plasma grid). Expensive and high-tech — ore + manufactured machinery/
  // electronics/AI Cores — so it's a genuine late investment; one only, from surplus.
  const hasRig = buildings.some(b => b.type === "plasmarig");
  if (!hasRig && prereqsMet(state, "ai", BUILDINGS.plasmarig)
      && canAffordKeeping(ai.resources, BUILDINGS.plasmarig.cost, ctx.oreReserve) && canAct(state)) {
    const spot = findPlacement(state, "plasmarig", cc.x - 120, cc.y - 90);
    if (spot && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "plasmarig", spot.x, spot.y)) spend(state);
  }
}
