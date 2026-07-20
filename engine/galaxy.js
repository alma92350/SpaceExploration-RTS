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
import { checkEndlessWin } from "./victory.js";
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
    pacified: new Set(),        // worlds where you've razed the neighbour's Command Center (Domination win progress)
    pacifyNotes: [],            // freshly-pacified world ids awaiting a UI toast (transient, drained by boot.js)
    wonBy: null,                // "gate" | "domination" — which victory ended the run (drives the win screen copy)
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
  checkGalaxyWin(galaxy);     // ECONOMIC win: an Antimatter Gate finishing on ANY held world
  checkDomination(galaxy);    // MILITARY win: enough neighbours' Command Centers razed
}

// The galaxy-wide economic WIN check. An Antimatter Gate (engine/wonder.js) can
// complete on your active seat OR on a colony you left charging in the background.
// sim.js's per-tick win check only runs on the active (foreground) world, so this
// sweep catches a Gate finishing off-screen: run the endless-win check on every
// world, and if any reports a player win, mirror it onto the active state so
// boot.js's game.state.over poll surfaces the victory screen. Deterministic and
// idempotent (finish() no-ops once a state is already over).
export function checkGalaxyWin(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  for (const state of galaxy.planets.values()) {
    checkEndlessWin(state);
    if (state.over && state.winner === "player") {
      active.over = true; active.winner = "player"; galaxy.wonBy = "gate"; return;
    }
  }
}

// Worlds you must pacify (raze the neighbour's Command Center on) to win by
// DOMINATION — the military, multi-world alternative to the single-world Gate.
export const DOMINATION_TARGET = 4;

const hasAiCommand = state => {
  for (const b of state.buildings.values()) if (b.owner === "ai" && b.type === "command" && !b.constructing) return true;
  return false;
};

// The MILITARY WIN check. A world is "pacified" the moment its neighbour has no
// standing Command Center — you razed it (only two sides fight, and every world is
// seeded with an AI capital). Pacification is STICKY (recorded on the galaxy, so a
// neighbour rebuilding can't un-pacify it) and win-progress: pacify DOMINATION_TARGET
// worlds and you conquer the galaxy. Newly-pacified worlds are queued for a UI toast.
// Deterministic — reads only entity state.
export function checkDomination(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  for (const [id, state] of galaxy.planets) {
    if (galaxy.pacified.has(id) || hasAiCommand(state)) continue;
    galaxy.pacified.add(id);
    galaxy.pacifyNotes.push(id);
  }
  if (galaxy.pacified.size >= DOMINATION_TARGET) {
    active.over = true; active.winner = "player"; galaxy.wonBy = "domination";
  }
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

// Can the player launch a jump from this world? — a completed player Spaceport.
export function canJump(state) {
  for (const b of state.buildings.values())
    if (b.owner === "player" && b.type === "spaceport" && !b.constructing) return true;
  return false;
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

// Relocate the capital to `destId`: the Command Center plus every player unit
// staged near the Spaceport move to the destination's landing zone; the origin
// keeps its other buildings and units and becomes a background colony that goes
// on evolving. Creates the destination (unsettled) on first visit. Returns a
// small summary, or null if the jump can't run (no Spaceport, or same world).
export function jumpCapital(galaxy, destId) {
  const from = activeState(galaxy);
  const spaceport = [...from.buildings.values()]
    .find(b => b.owner === "player" && b.type === "spaceport" && !b.constructing);
  if (!spaceport || destId === galaxy.activeId || galaxy.credits < JUMP_COST) return null;
  galaxy.credits -= JUMP_COST;   // fuel for the jump

  const dest = galaxy.planets.get(destId) || addPlanet(galaxy, destId, { unsettled: true });
  const lz = dest.map.bases.player;
  const nextId = () => "g" + (galaxy.entitySeq = (galaxy.entitySeq || 0) + 1);   // fresh ids: no cross-state collision

  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const riders = stagedRiders(from, spaceport);

  if (cc) {
    from.buildings.delete(cc.id);
    cc.id = nextId(); cc.x = lz.x; cc.y = lz.y; cc.rally = { x: lz.x + 60, y: lz.y + 60 };
    dest.buildings.set(cc.id, cc);
  }
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
  return { destId, riders: riders.length, cargo };
}
