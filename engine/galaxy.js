/* ============================================================
   The Odyssey galaxy — the open-world meta-layer over the per-planet sim. A
   galaxy holds one engine game state per planet (each a normal createGameState);
   one is "active" (rendered + controlled by the player) and ticks at full rate,
   while the worlds you've left keep evolving in the background on a coarser
   schedule (stepGalaxy). The player has a single, relocatable Command Center:
   their capital seat travels with them via a Spaceport (jumpCapital), and a world
   they leave stays a colony that keeps producing and sends home passive income.

   This module owns everything meta: the world roster, universal credits, the
   active planet, the per-frame advance (stepGalaxy), background-colony upkeep +
   notifications (sweepColonies), a status snapshot for the starmap (galaxyStatus),
   and the jump. The per-planet engine is untouched — a planet is just a normal
   createGameState flagged `endless` (no victory, no clock — see engine/victory.js).

   Determinism: the start world and every planet's map are derived from the galaxy
   seed, and the background schedule is keyed to the integer `galaxy.tick`, so the
   same seed replays the same galaxy — the same guarantee as the skirmish sim.
   ============================================================ */

"use strict";

import { createGameState } from "./state.js";
import { mulberry32 } from "./rng.js";
import { updateFog } from "./fog.js";
import { tick } from "./sim.js";
import { createMarket } from "./market.js";
import { createDiplomacy } from "./diplomacy.js";
import { UNITS, BUILDINGS } from "./entities.js";
import { hasColonyShip } from "./colony.js";
import { PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE, archetypeFor } from "./aiArchetypes.js";
import { PLANETS } from "../data.js";

// The worlds an Odyssey can settle: the skirmish nine PLUS the Odyssey-only extras
// (a research capital, an agri world) — appended AFTER the nine so the skirmish
// worlds keep their roster index, which keeps the background-tick schedule (keyed
// on worlds.indexOf) and every same-seed replay stable.
export const ODYSSEY_WORLDS = [...Object.keys(PLANET_ARCHETYPE), ...Object.keys(ODYSSEY_EXTRA_ARCHETYPE)];

// A stable per-planet seed derived from the galaxy seed + the world id, so every
// world generates its own deterministic map and two galaxies with the same seed
// are byte-identical.
function planetSeed(seed, planetId) {
  let h = seed >>> 0;
  for (let i = 0; i < planetId.length; i++) h = (Math.imul(h ^ planetId.charCodeAt(i), 0x01000193)) >>> 0;
  return h >>> 0;
}

// Create an Odyssey galaxy. Phase 1: a single active planet (the player's
// randomly-chosen starting world) plus the meta-fields (credits, activeId, the
// world roster) the later phases grow into.
export function createGalaxy({ seed = 1, difficulty = "medium", sizeMult = 1,
  resourceMult = 1, playerFaction = "frontier", aiApm, aiMicro } = {}) {
  seed = seed >>> 0;
  const pick = mulberry32(seed);
  const startId = ODYSSEY_WORLDS[Math.floor(pick() * ODYSSEY_WORLDS.length)];

  const galaxy = {
    seed,
    credits: 500,               // universal credits — galaxy-wide, transportable; fund jumps + trade
    activeId: startId,          // the world the player is currently on
    worlds: ODYSSEY_WORLDS.slice(),
    planets: new Map(),         // planetId -> engine game state
    settings: { difficulty, sizeMult, resourceMult, playerFaction, aiApm, aiMicro },
    tick: 0,                    // integer galaxy-tick counter (drives the background-world schedule)
    entitySeq: 0,               // fresh-id counter for entities relocated across worlds by a jump
    colonyNotes: new Map(),     // per-planet UI notification bookkeeping (galaxy-side, not sim state)
    pacified: new Set(),        // worlds where you've razed the neighbour's Command Center (a conquest milestone)
    pacifyNotes: [],            // freshly-pacified world ids awaiting a UI toast + firework (transient, drained by boot.js)
    reached: new Set(),         // progress milestones already celebrated (see checkGalaxyProgress) — persisted so a reload doesn't re-fire them
    milestones: [],             // freshly-reached milestones awaiting a UI firework (transient, drained by boot.js)
    wonBy: null,                // legacy: no Odyssey win any more (play-forever) — kept null for save/skirmish compat
  };
  addPlanet(galaxy, startId);
  return galaxy;
}

// Units staged within this radius of a Spaceport ride along with the capital on
// a jump — you assemble your expedition at the pad, then launch.
export const JUMP_LOAD_RADIUS = 150;

// Credits a jump costs (fuel). Funded by trading at the market, so exploration
// draws on your economy rather than being free.
export const JUMP_COST = 400;

// A held background colony sends home this many credits per second per surviving
// player building — passive income, so the worlds you leave keep working for you
// (and a razed colony, down to no buildings, quietly stops paying).
export const COLONY_INCOME_PER_BUILDING = 0.3;

const playerBuildingCount = state => {
  let n = 0;
  for (const b of state.buildings.values()) if (b.owner === "player") n++;
  return n;
};

// Build (or rebuild) a planet's engine state into the galaxy. Reuses the exact
// skirmish scaffold — economy, both players' bases, fog — but flagged `endless`
// so it never resolves by conquest or clock (see engine/victory.js).
//
// `unsettled` strips the auto-seeded player presence: a jump DESTINATION you
// haven't settled yet has only its neighbour — your capital + forces arrive via
// the jump, not from map generation.
export function addPlanet(galaxy, planetId, { unsettled = false } = {}) {
  const s = galaxy.settings;
  const seed = planetSeed(galaxy.seed, planetId);
  const aiFaction = archetypeFor(planetId).faction || "neutral";
  const state = createGameState({
    planetId, seed, rng: mulberry32(seed),
    aiApm: s.aiApm, aiMicro: s.aiMicro, sizeMult: s.sizeMult, resourceMult: s.resourceMult,
    playerFaction: s.playerFaction, aiFaction, endless: true,
  });
  if (unsettled) {
    for (const [id, u] of [...state.units]) if (u.owner === "player") state.units.delete(id);
    for (const [id, b] of [...state.buildings]) if (b.owner === "player") state.buildings.delete(id);
    state.background = true;   // not the active seat until you land here
    updateFog(state, state.fog, "player");
  }
  state.market = createMarket(state);         // every world has its own price book
  state.diplomacy = createDiplomacy();        // and its own neighbour's stance toward you
  state.inGalaxy = true;                       // part of a galaxy → defeat is judged galaxy-wide (checkGalaxyLoss),
                                               // not per-world (so an army-only hop to a world you don't hold isn't a loss)
  galaxy.planets.set(planetId, state);
  return state;
}

// Run the background colonies each tick: bank their passive income, watch for
// trouble, and return notifications for the UI. Also the single place their sim
// events are drained — a colony isn't rendered or heard, so nothing else consumes
// them (left alone they would grow without bound). Reports a colony coming under
// attack (a player asset destroyed there) and a colony being lost (its last
// player building razed), each at most once per state transition. The "already
// notified" flags live on the galaxy (colonyNotes), not on the deterministic
// engine state — they're transient UI bookkeeping, re-derived harmlessly on load.
export function sweepColonies(galaxy, dt = 0) {
  const out = [];
  for (const [id, state] of galaxy.planets) {
    if (!state.background) continue;
    const buildings = playerBuildingCount(state);
    galaxy.credits += buildings * COLONY_INCOME_PER_BUILDING * dt;   // passive colony income
    const rec = galaxy.colonyNotes.get(id) || { hadColony: false, colonyLost: false };
    if (buildings > 0) rec.hadColony = true;
    if (rec.hadColony && buildings === 0 && !rec.colonyLost) {
      rec.colonyLost = true;
      out.push({ type: "lost", planetId: id });
    } else if (!rec.colonyLost && state.events.some(e => e.type === "entityKilled" && e.owner === "player")) {
      out.push({ type: "attacked", planetId: id });
    }
    galaxy.colonyNotes.set(id, rec);
    state.events.length = 0;   // drain: a background colony's events have no other consumer
  }
  return out;
}

// The game state the player is currently on — what boot.js renders and drives.
export function activeState(galaxy) {
  return galaxy.planets.get(galaxy.activeId);
}

// Background worlds tick once every BG_STEP galaxy-ticks, each time by BG_STEP× the
// step, so a colony advances the same amount of sim time as the active world over
// any span — just in coarser, cheaper increments.
export const BG_STEP = 4;

// Advance the whole galaxy by one frame. The active world ticks every frame at
// full cadence (it's rendered and controlled). Every background colony ticks on a
// coarser fixed step, spread round-robin across BG_STEP frames by its fixed roster
// index, so per-frame background work is ~ceil(N/BG_STEP) worlds instead of N.
// Deterministic by construction: the schedule is pure integer arithmetic on the
// galaxy tick and the world's roster position (no wall-clock, no Map-order
// dependence), and each background tick uses the exact constant dtBg so total sim
// time is conserved regardless of cadence.
export function stepGalaxy(galaxy, dt) {
  const t = (galaxy.tick = (galaxy.tick | 0) + 1);
  tick(activeState(galaxy), dt);                     // active world: full rate
  const dtBg = dt * BG_STEP;
  for (const [id, state] of galaxy.planets) {
    if (id === galaxy.activeId || !state.background) continue;
    if (t % BG_STEP === galaxy.worlds.indexOf(id) % BG_STEP) tick(state, dtBg);
  }
  checkDomination(galaxy);      // conquest progress: pacified worlds (per-world toast) + a milestone at the target
  checkGalaxyProgress(galaxy);  // other milestones: colonies founded, the Antimatter Gate coming online — fireworks, not wins
  checkGalaxyLoss(galaxy);      // DEFEAT is the ONLY terminal state now (play-forever): no foothold left on ANY world
}

// Galaxy-wide DEFEAT — the ONLY terminal state (there are no wins any more; the Odyssey
// is a play-forever sandbox). You're beaten only when you hold no foothold — no Command
// Center and no colony ship — on ANY world. So a jump to a world where you have nothing
// yet (an army-only reinforcement run, or a hop to fetch a colony ship) is never an instant
// loss while a base or ship still stands somewhere else. The per-world checkEndlessLoss is
// suppressed for galaxy states (state.inGalaxy, see engine/victory.js), so this is the one
// authority. Idempotent.
export function checkGalaxyLoss(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  for (const state of galaxy.planets.values()) {
    for (const b of state.buildings.values())
      if (b.owner === "player" && b.type === "command") return;   // a base somewhere → still in the game
    if (hasColonyShip(state, "player")) return;                   // …or a colony ship to re-found from
  }
  active.over = true; active.winner = "ai";                       // last foothold anywhere is gone
}

// Record a one-time progress milestone — a firework, drained UI-side by boot.js. Idempotent
// per id, and `reached` persists (engine/persist.js) so a reload never replays a milestone
// you've already celebrated.
function reachMilestone(galaxy, id) {
  if (galaxy.reached.has(id)) return;
  galaxy.reached.add(id);
  galaxy.milestones.push(id);
}

// Progress milestones for the play-forever sandbox — the fireworks that mark how far you've
// come, in place of a victory that would end the run. Swept galaxy-wide each tick, each fired
// once (reachMilestone): founding your first base and each further WORLD you settle
// ("world:N"), fortifying your first Capital ("capital"), and bringing an Antimatter Gate
// online anywhere ("gate" — the former economic victory, now a triumph you keep playing past).
// Conquest milestones live in checkDomination. Pure — reads only entity state; the firework
// itself is fired UI-side (boot.js), keeping the engine DOM-free.
export function checkGalaxyProgress(galaxy) {
  let settledWorlds = 0, hasCapital = false, gateOnline = false;
  for (const state of galaxy.planets.values()) {
    let heldHere = false;
    for (const b of state.buildings.values()) {
      if (b.owner !== "player") continue;
      if (b.type === "command" && !b.constructing) { heldHere = true; if (b.capital) hasCapital = true; }
      if (BUILDINGS[b.type]?.wonder && (b.charge || 0) >= 1) gateOnline = true;
    }
    if (heldHere) settledWorlds++;
  }
  for (let n = 1; n <= settledWorlds; n++) reachMilestone(galaxy, "world:" + n);
  if (hasCapital) reachMilestone(galaxy, "capital");
  if (gateOnline) reachMilestone(galaxy, "gate");
}

// Worlds to pacify (raze the neighbour's Command Center on) for the grand CONQUEST
// milestone — the military, multi-world firework. No longer a win: the galaxy keeps
// running past it (play-forever).
export const DOMINATION_TARGET = 4;

// The AI's foothold on a world — a Command Center OR an undeployed colony ship. The
// colony-ship clause is what stops checkDomination false-pacifying every world at
// tick 0 (both sides now START with a CC-less colony ship), and keeps "pacified"
// meaning "you actually drove them off" — a neighbour reduced to a lone ship can still
// re-found, so it isn't conquered yet. hasColonyShip is false in a skirmish.
const hasAiCommand = state => {
  for (const b of state.buildings.values()) if (b.owner === "ai" && b.type === "command" && !b.constructing) return true;
  return hasColonyShip(state, "ai");
};

// Conquest progress. A world is "pacified" the moment its neighbour has no standing
// Command Center — you razed it (only two sides fight, and every world is seeded with an
// AI capital). Pacification is STICKY (recorded on the galaxy, so a neighbour rebuilding
// can't un-pacify it); each freshly-pacified world is queued for a UI toast + firework
// (pacifyNotes), and reaching DOMINATION_TARGET fires the grand "domination" milestone —
// a firework, NOT a win, so the sandbox plays on. Deterministic — reads only entity state.
export function checkDomination(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  for (const [id, state] of galaxy.planets) {
    if (galaxy.pacified.has(id) || hasAiCommand(state)) continue;
    galaxy.pacified.add(id);
    galaxy.pacifyNotes.push(id);
  }
  if (galaxy.pacified.size >= DOMINATION_TARGET) reachMilestone(galaxy, "domination");
}

// A pure snapshot of the galaxy for the starmap: per-world status (your active
// seat / a colony you hold / unexplored) and, for worlds you've been to, the
// neighbour's stance. Plus the visited count and credits.
export function galaxyStatus(galaxy) {
  return {
    credits: galaxy.credits,
    activeId: galaxy.activeId,
    visited: galaxy.planets.size,
    total: galaxy.worlds.length,
    pacified: galaxy.pacified ? galaxy.pacified.size : 0,   // Domination progress: worlds conquered
    dominationTarget: DOMINATION_TARGET,
    worlds: galaxy.worlds.map(id => {
      const s = galaxy.planets.get(id);
      let status = "unexplored", income = 0;
      const pacified = !!(galaxy.pacified && galaxy.pacified.has(id));
      if (id === galaxy.activeId) status = "seat";
      else if (pacified) status = "pacified";   // conquered — its neighbour's capital is razed
      else if (s) {
        const buildings = playerBuildingCount(s);
        // A world you've been to is a "colony" only while you still hold a
        // building there; once razed it's "contested" — visited but no longer
        // yours (so the map doesn't keep calling a lost world your colony).
        status = buildings > 0 ? "colony" : "contested";
        income = Math.round(buildings * COLONY_INCOME_PER_BUILDING * 60);   // credits/min
      }
      // Industry/Tech ratings (data.js) drive factory speed + research speed and
      // finished-good prices — surfaced so "where to settle/jump" is an informed call.
      const p = PLANETS.find(pl => pl.id === id);
      return { id, status, income, pacified, stance: s && s.diplomacy ? s.diplomacy.stance : null,
        industry: p ? p.industry : 5, tech: p ? p.tech : 5, faction: p ? p.faction : null };
    }),
  };
}

// The fortified Capital: an upgraded Command Center with double HP. Like every deployed
// base it is permanent — it never travels (interplanetary jumps carry a colony ship, not
// a base; jumpVessel/jumpCapital) — so the Capital is your hardened anchor world. One
// per owner; the flag also drives its gold ring on the map (render.js).
export const CAPITAL_UPGRADE_COST = { ore: 400 };
export const CAPITAL_HP_MULT = 2;

// Improve a Command Center into your Capital: pay the cost, mark it, and scale its HP
// (and current HP, preserving any battle damage as a fraction) by CAPITAL_HP_MULT.
// Odyssey-only, one Capital per owner, not on a still-constructing CC. Deterministic —
// pure state mutation, no clock/RNG. Returns whether the upgrade happened.
export function upgradeToCapital(state, building) {
  if (!building || building.type !== "command" || building.constructing || building.capital) return false;
  const owner = building.owner;
  for (const b of state.buildings.values())
    if (b.owner === owner && b.capital) return false;             // only one Capital
  const res = state.players[owner].resources;
  for (const com in CAPITAL_UPGRADE_COST) if ((res[com] || 0) < CAPITAL_UPGRADE_COST[com]) return false;
  for (const com in CAPITAL_UPGRADE_COST) res[com] -= CAPITAL_UPGRADE_COST[com];
  building.capital = true;
  building.maxHp = Math.round(building.maxHp * CAPITAL_HP_MULT);
  building.hp = Math.round(building.hp * CAPITAL_HP_MULT);        // keeps the damage fraction
  return true;
}

// The Spaceport comes in THREE tiers. Its jump capacity — how much fleet it can launch
// at once, measured in ship POPULATION (supply cost), not head-count — scales with the
// tier, so a very large army has to cross in several jumps through a small pad, or you
// upgrade to a bigger one. Capacity is indexed by tier (1..3); index 0 is unused.
export const SPACEPORT_MAX_TIER = 3;
export const SPACEPORT_CAPACITY = [0, 12, 24, 40];              // supply carried per jump, by tier
export const SPACEPORT_UPGRADE_COST = { 2: { ore: 250 }, 3: { ore: 500 } };   // ore to reach a tier (escalating)

// A Spaceport's tier (defaults to 1 for a fresh pad or a pre-tier save) and the per-jump
// capacity it grants.
export const spaceportTier = b => Math.min(SPACEPORT_MAX_TIER, Math.max(1, b.tier || 1));
export const jumpCapacity = b => SPACEPORT_CAPACITY[spaceportTier(b)];

// Upgrade a Spaceport one tier (max 3): pay the ore, bump the tier, raising its per-jump
// capacity. Odyssey-only, deterministic (pure state mutation — no clock/RNG), like the
// Capital fortification. Returns whether it happened (refused when already max, still
// under construction, or unaffordable).
export function upgradeSpaceport(state, building) {
  if (!building || building.type !== "spaceport" || building.constructing) return false;
  const tier = spaceportTier(building);
  if (tier >= SPACEPORT_MAX_TIER) return false;
  const cost = SPACEPORT_UPGRADE_COST[tier + 1];
  const res = state.players[building.owner].resources;
  for (const com in cost) if ((res[com] || 0) < cost[com]) return false;
  for (const com in cost) res[com] -= cost[com];
  building.tier = tier + 1;
  return true;
}

const unitSupply = u => UNITS[u.type]?.supplyCost || 0;

// The colony ship that would carry an interplanetary jump: a player colony ship staged
// within JUMP_LOAD_RADIUS of a completed Spaceport. A jump relocates the SHIP (and the
// rest of the staged expedition) — NOT a deployed base. Deployed Command Centers are
// permanent: the world you leave keeps them and becomes a background colony. Deploy the
// ship at the destination to found your new base there. Null when no ship is on the pad.
export function jumpVessel(state) {
  const spaceport = [...state.buildings.values()]
    .find(b => b.owner === "player" && b.type === "spaceport" && !b.constructing);
  if (!spaceport) return null;
  for (const u of state.units.values())
    if (u.owner === "player" && u.type === "colonyship"
        && Math.hypot(u.x - spaceport.x, u.y - spaceport.y) <= JUMP_LOAD_RADIUS) return u;
  return null;
}

// Can the player launch a jump from this world? — just a completed Spaceport. No colony
// ship is required: a jump can carry one (to settle a new world), or an army (to reinforce
// a colony), or nothing (to hop back and control a world you already hold). jumpVessel
// stays as an informational helper (is a ship loaded?) for the HUD, not a gate.
export function canJump(state) {
  return [...state.buildings.values()]
    .some(b => b.owner === "player" && b.type === "spaceport" && !b.constructing);
}

// The fuel a jump to `destId` costs: FREE to a world you already hold (any world you've
// visited — a colony you're returning to, reinforcing, or re-settling), and JUMP_COST to
// reach a NEW world for the first time. So bouncing between your own worlds to defend or
// ferry a colony ship is friction-free; only expanding the frontier costs fuel.
export function jumpCost(galaxy, destId) {
  return galaxy.planets.has(destId) ? 0 : JUMP_COST;
}

// The player units staged near a Spaceport — the expedition that rides along on a
// jump. One definition, so the HUD's preview count and the jump's actual move can
// never disagree about what leaves.
export function stagedRiders(state, spaceport) {
  const out = [];
  for (const u of state.units.values())
    if (u.owner === "player" && Math.hypot(u.x - spaceport.x, u.y - spaceport.y) <= JUMP_LOAD_RADIUS) out.push(u);
  return out;
}

// What actually LAUNCHES on one jump, capped by the pad's tier capacity. From the units
// staged near the Spaceport, fill the hold closest-to-the-pad first by ship population
// (supply) until the next unit wouldn't fit — a skip-not-break fill, so a heavy unit that
// doesn't fit is passed over for lighter ones behind it rather than blocking them (workers
// are supply 1, so a fleet always makes progress and nothing softlocks). The overflow
// waits at the pad for the next jump. Pure + deterministic: closest-first, ties broken by
// entity id. One definition, so the HUD preview and the jump's actual move always agree.
export function jumpManifest(state, spaceport) {
  const capacity = jumpCapacity(spaceport);
  const staged = stagedRiders(state, spaceport)
    .map(u => ({ u, d: Math.hypot(u.x - spaceport.x, u.y - spaceport.y) }))
    .sort((a, b) => a.d - b.d || (a.u.id < b.u.id ? -1 : 1));
  const riders = [];
  let used = 0;
  for (const { u } of staged) {
    const s = unitSupply(u);
    if (used + s <= capacity) { riders.push(u); used += s; }
  }
  const stagedSupply = staged.reduce((t, { u }) => t + unitSupply(u), 0);
  return { riders, capacity, used, stagedSupply, staged: staged.length, leftBehind: staged.length - riders.length };
}

// A jump carries a bounded CARGO HOLD of manufactured goods to the destination, so
// a run of production on one world can be sold on another — the make-here/sell-there
// loop (produced goods price differently per world, engine/market.js). Loaded
// most-valuable-first (data.js COM.base: machinery 250 > electronics 95 > alloys 80
// > metals 22). Raws are too cheap to bother hauling and strategic goods stay put
// (committed to local wonders/superweapons) — which also means the hold is empty
// until you've actually industrialized.
export const CARGO_CAPACITY = 300;
const CARGO_GOODS = ["machinery", "electronics", "alloys", "metals"];

// What a jump from `from` would haul, as { good: qty } — pure, for the HUD preview
// and the jump itself (so the shown manifest and the moved goods can never disagree).
export function cargoManifest(from) {
  let room = CARGO_CAPACITY;
  const src = from.players.player.resources;
  const manifest = {};
  for (const com of CARGO_GOODS) {
    if (room <= 0) break;
    const move = Math.min(Math.floor(src[com] || 0), room);
    if (move > 0) { manifest[com] = move; room -= move; }
  }
  return manifest;
}

function loadCargo(from, dest) {
  const manifest = cargoManifest(from);
  const src = from.players.player.resources, dst = dest.players.player.resources;
  for (const com in manifest) { src[com] -= manifest[com]; dst[com] = (dst[com] || 0) + manifest[com]; }
  return manifest;
}

// Launch an interplanetary jump to `destId`: every player unit staged near the Spaceport
// — a colony ship (to settle), an army (to reinforce), or nothing — moves to the
// destination's landing zone, along with the cargo hold. NO deployed base moves: the
// origin keeps ALL its buildings (and any un-staged units) and becomes a background colony
// that goes on evolving. Deploy a colony ship at the destination to found a base there.
// Costs fuel only for a NEW world (jumpCost) — returning to a world you hold is free.
// Returns a summary, or null if the jump can't run (no Spaceport, same world, or too poor
// to fuel a new-world jump).
export function jumpCapital(galaxy, destId) {
  const from = activeState(galaxy);
  const spaceport = [...from.buildings.values()]
    .find(b => b.owner === "player" && b.type === "spaceport" && !b.constructing);
  const cost = jumpCost(galaxy, destId);
  if (!spaceport || destId === galaxy.activeId || galaxy.credits < cost) return null;
  const { riders, leftBehind } = jumpManifest(from, spaceport);   // capacity-capped: overflow waits for the next jump
  galaxy.credits -= cost;   // fuel — free to a world you already hold

  const dest = galaxy.planets.get(destId) || addPlanet(galaxy, destId, { unsettled: true });
  const lz = dest.map.bases.player;
  const nextId = () => "g" + (galaxy.entitySeq = (galaxy.entitySeq || 0) + 1);   // fresh ids: no cross-state collision

  riders.forEach((u, i) => {
    from.units.delete(u.id);
    const a = (i / Math.max(1, riders.length)) * Math.PI * 2, ring = 46 + (i % 3) * 18;
    u.id = nextId(); u.x = lz.x + Math.cos(a) * ring; u.y = lz.y + Math.sin(a) * ring;
    u.order = null; u.orderQueue = [];
    dest.units.set(u.id, u);
  });

  const cargo = loadCargo(from, dest);   // haul the manufactured goods along to sell at the destination

  from.selection = []; dest.selection = [];
  from.background = true;    // the world you left keeps evolving on its own
  dest.background = false;   // the destination is now your active seat
  galaxy.activeId = destId;
  updateFog(dest, dest.fog, "player");
  updateFog(dest, dest.fogAI, "ai");
  updateFog(from, from.fog, "player");
  return { destId, riders: riders.length, leftBehind, cargo };   // leftBehind: staged units the pad couldn't fit this trip
}
