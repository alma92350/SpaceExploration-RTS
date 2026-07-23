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

import { createGameState, makeUnit, peekEntityId, restoreEntityId } from "./state.js";
import { mulberry32 } from "./rng.js";
import { updateFog } from "./fog.js";
import { tick } from "./sim.js";
import { createMarket } from "./market.js";
import { createDiplomacy } from "./diplomacy.js";
import { UNITS, BUILDINGS } from "./entities.js";
import { hasColonyShip } from "./colony.js";
import { PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE, archetypeFor } from "./aiArchetypes.js";
import { PLANETS, COM } from "../data.js";

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
    time: 0,                    // galaxy-wide sim clock (seconds) — monotonic across jumps; keys the relief cooldown
    entitySeq: 0,               // fresh-id counter for entities relocated across worlds by a jump
    colonyNotes: new Map(),     // per-planet UI notification bookkeeping (galaxy-side, not sim state)
    pacified: new Set(),        // worlds where you've razed the neighbour's Command Center (a conquest milestone)
    pacifyNotes: [],            // freshly-pacified world ids awaiting a UI toast + firework (transient, drained by boot.js)
    reached: new Set(),         // progress milestones already celebrated (see checkGalaxyProgress) — persisted so a reload doesn't re-fire them
    milestones: [],             // freshly-reached milestones awaiting a UI firework (transient, drained by boot.js)
    wonBy: null,                // legacy: no Odyssey win any more (play-forever) — kept null for save/skirmish compat
    discovered: new Set([startId]),   // LIVING GALAXY: worlds the player has actually reached (starmap "explored" + free return-jump). Every world SIMULATES from the start, but the player only SEES a world once they've been there.
  };
  addPlanet(galaxy, startId);
  // LIVING GALAXY: every other world already exists and simulates in the background from turn one —
  // each with its own AI faction founding a base and developing (engine/ai.js aiIndustry), its
  // economy growing and its diplomacy drifting — so the galaxy is alive before you ever visit, and
  // (checkExpansion) factions spread across it over time. Added `unsettled` (no player presence until
  // you jump in). The BG scheduler (stepGalaxy) already spreads their ticks round-robin, and a probe
  // puts the whole 11-world galaxy at well under 1 ms/frame. Deterministic: ODYSSEY_WORLDS is a fixed
  // order and each world seeds from its own planetSeed, so two same-seed galaxies are byte-identical.
  for (const id of ODYSSEY_WORLDS) if (id !== startId) addPlanet(galaxy, id, { unsettled: true });
  return galaxy;
}

// Units staged within this radius of a Spaceport ride along with the capital on
// a jump — you assemble your expedition at the pad, then launch.
export const JUMP_LOAD_RADIUS = 150;

// Credits a jump costs (fuel). Funded by trading at the market, so exploration
// draws on your economy rather than being free.
export const JUMP_COST = 400;

// A held background colony sends home this many credits per second per surviving
// income-earning player building — passive income, so the worlds you leave keep working
// for you (and a razed colony, down to no buildings, quietly stops paying).
export const COLONY_INCOME_PER_BUILDING = 0.3;
// …but only up to this many buildings per world. Without a cap, spamming the cheapest
// building (a 75-ore Habitat, a turret) on a pacified world — where the razed neighbour
// can never strike back — was an unbounded credit annuity that made the counter a
// meaningless up-only number. The cap bounds a colony's yield to a real economy's worth.
export const COLONY_INCOME_CAP = 6;

const playerBuildingCount = state => {
  let n = 0;
  for (const b of state.buildings.values()) if (b.owner === "player") n++;
  return n;
};

// Buildings that count toward passive income: everything except the pure-defensive
// turret (a turret wall isn't an economy), capped per world (see COLONY_INCOME_CAP).
const incomeBuildingCount = state => {
  let n = 0;
  for (const b of state.buildings.values()) if (b.owner === "player" && b.type !== "turret") n++;
  return Math.min(COLONY_INCOME_CAP, n);
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
  state.inGalaxy = true;                       // part of a galaxy → the per-world defeat check is off (engine/victory.js);
                                               // the galaxy never loses (checkGalaxyRescue), it only ends by surrender
  galaxy.planets.set(planetId, state);
  bumpEntityCounterPastGalaxy(galaxy);         // keep future live-built ids galaxy-unique (see below)
  return state;
}

// createGameState (engine/state.js) resets the GLOBAL entity-id counter to 1 for each world's
// deterministic seeding — which, once a galaxy holds more than one world, would leave the counter
// BELOW ids already live on other worlds. The next thing the player then built or produced could
// reuse an id and silently overwrite an existing entity (e.g. return to a built-up world after
// visiting a new one and lay down a Spaceport → it clobbers a building that shared the id). So
// after each world is (re)built in, bump the counter past every b/u id anywhere in the galaxy, so
// live mints stay unique galaxy-wide. Deterministic — reads only entity ids (no clock/RNG); the
// seeded ids themselves are untouched, so per-world determinism is preserved.
function idNum(id) {
  const n = parseInt(String(id).replace(/^\D+/, ""), 10);   // "b12" | "u7" | "g3" → 12 | 7 | 3
  return Number.isFinite(n) ? n : 0;
}
function bumpEntityCounterPastGalaxy(galaxy) {
  let max = peekEntityId() - 1;                              // whatever this world's own seeding reached
  for (const state of galaxy.planets.values()) {
    for (const id of state.units.keys()) max = Math.max(max, idNum(id));
    for (const id of state.buildings.keys()) max = Math.max(max, idNum(id));
  }
  restoreEntityId(max + 1);
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
    galaxy.credits += incomeBuildingCount(state) * COLONY_INCOME_PER_BUILDING * dt;   // capped, turret-excluded passive income
    const rec = galaxy.colonyNotes.get(id) || { hadColony: false, colonyLost: false };
    // A standing colony resets the lost latch, so retaking and rebuilding a world re-arms
    // its alerts — without this, a world lost once was muted forever (a second razing never
    // re-announced, and the rebuilt colony's under-attack pings stayed suppressed).
    if (buildings > 0) { rec.hadColony = true; rec.colonyLost = false; }
    if (rec.hadColony && buildings === 0 && !rec.colonyLost) {
      rec.colonyLost = true;
      out.push({ type: "lost", planetId: id });
    } else if (rec.hadColony && !rec.colonyLost) {
      // Only worlds the player actually colonised raise hostile/attacked alerts — the living galaxy
      // now background-simulates every world (its AI can drift to war on its own), but a neighbour
      // turning on a world you've never set foot on isn't your problem and mustn't ping you.
      // A background world's diplomacy keeps drifting (diplomacy.js CREEP_RATE), so a
      // neighbour eventually declares war — but its neighbourHostile event has no other
      // consumer here and used to be silently drained, so the FIRST warning was the colony
      // already dying. Surface the declaration (once — diplomacy latches warAnnounced), else
      // the ongoing raid (fresh player losses this tick).
      if (state.events.some(e => e.type === "neighbourHostile")) out.push({ type: "hostile", planetId: id });
      else if (state.events.some(e => e.type === "entityKilled" && e.owner === "player")) out.push({ type: "attacked", planetId: id });
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
  galaxy.time = (galaxy.time || 0) + dt;             // galaxy-wide clock (deterministic: dt is the fixed step)
  tick(activeState(galaxy), dt);                     // active world: full rate
  const dtBg = dt * BG_STEP;
  for (const [id, state] of galaxy.planets) {
    if (id === galaxy.activeId || !state.background) continue;
    if (t % BG_STEP === galaxy.worlds.indexOf(id) % BG_STEP) tick(state, dtBg);
  }
  // These galaxy-wide scans (conquest progress, milestones, no-foothold relief) all change on a
  // minutes timescale, so running them every frame (20 Hz) is wasted work that grows with the
  // colony count. Throttle to ~1/sec on the same deterministic integer schedule the BG round-
  // robin uses — a milestone/pacification/rescue firing up to a second later is imperceptible,
  // and RELIEF_COOLDOWN (20 s) dwarfs it. Runs on tick 1 too, so a freshly-stepped galaxy is
  // checked immediately. Pure integer arithmetic on galaxy.tick — no wall-clock, deterministic.
  if (t === 1 || t % PROGRESS_CHECK_EVERY === 0) {
    checkDomination(galaxy);      // conquest progress: pacified worlds (per-world toast) + a milestone at the target
    checkGalaxyProgress(galaxy);  // milestones: colonies founded, the Antimatter Gate coming online — fireworks, not wins
    checkGalaxyRescue(galaxy);    // NEVER auto-defeat: a total wipeout sends a relief colony ship so life goes on
  }
}
const PROGRESS_CHECK_EVERY = 20;   // galaxy-wide scans run ~once per second (20 Hz sim), not every frame

// The Odyssey NEVER ends in defeat — as long as you haven't surrendered, life goes on
// (surrenderGalaxy is the only terminal state). So there's no galaxy-wide loss; instead, if you
// ever hold NO foothold anywhere (every Command Center razed and no colony ship left), a RELIEF
// colony ship is dispatched to your active world's landing zone so you can re-found and fight on.
// A short cooldown bounds the churn if relief keeps getting farmed, and its arrival is flagged for
// a UI toast. Once you hold the ship you have a foothold again, so it won't re-send. The per-world
// checkEndlessLoss is suppressed for galaxy states (state.inGalaxy, engine/victory.js), so this is
// the sole authority. The cooldown is keyed on the GALAXY-WIDE clock (galaxy.time), not any one
// world's local time — a jump swaps the active world, and each world's clock advances on its own,
// so comparing lastReliefTime (set on world A) to world B's time could read as "cooldown elapsed"
// (B younger than A ⇒ negative delta) or "never elapses", either of which breaks the anti-farm
// bound and could dead-end the no-defeat guarantee. galaxy.time is monotonic across the whole run.
// Pure + deterministic (galaxy.time accumulates the fixed dt in stepGalaxy).
export const RELIEF_COOLDOWN = 20;   // sim seconds between relief drops (anti-farm)
export function checkGalaxyRescue(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;                                         // a surrender already ended it
  for (const state of galaxy.planets.values()) {
    for (const b of state.buildings.values())
      if (b.owner === "player" && b.type === "command") return;   // a base somewhere → still going
    if (hasColonyShip(state, "player")) return;                   // …or a colony ship to re-found from
  }
  const now = galaxy.time || 0;
  if (now - (galaxy.lastReliefTime ?? -Infinity) < RELIEF_COOLDOWN) return;   // still on cooldown
  galaxy.lastReliefTime = now;
  const lz = active.map.bases.player;
  const ship = makeUnit("colonyship", "player", lz.x, lz.y);
  ship.id = "g" + (galaxy.entitySeq = (galaxy.entitySeq || 0) + 1);   // galaxy id scheme (as in jumpCapital)
  active.units.set(ship.id, ship);
  galaxy.reliefNote = true;                                        // drained by boot.js for a toast
}

// The one terminal state: the player voluntarily gives up. Ends the run on the active seat (the
// boot.js over-poll then shows the game-over screen with the surrender copy). A wipeout alone
// never triggers this — only an explicit surrender does.
export function surrenderGalaxy(galaxy) {
  const active = activeState(galaxy);
  if (active.over) return;
  active.over = true; active.winner = "ai";
  galaxy.surrendered = true;
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
  // The maximal achievement in a play-forever sandbox — pacifying EVERY world — gets its
  // own grander milestone, so the conquest-minded player who pushes hours past the 4-world
  // target isn't met with silence (and a per-conquest toast reading "Conquered 11/4").
  if (galaxy.pacified.size >= galaxy.worlds.length) reachMilestone(galaxy, "domination:all");
}

// A pure snapshot of the galaxy for the starmap: per-world status (your active
// seat / a colony you hold / unexplored) and, for worlds you've been to, the
// neighbour's stance. Plus the visited count and credits.
export function galaxyStatus(galaxy) {
  // Every world simulates, but the player only SEES one they've REACHED (`discovered`). An
  // undiscovered world reads "unexplored" and hides its neighbour's stance, exactly as before the
  // living galaxy — the difference is now invisible until you visit. Old saves default to the
  // instantiated set (which for them was precisely the visited worlds).
  const discovered = galaxy.discovered || new Set(galaxy.planets.keys());
  return {
    credits: galaxy.credits,
    activeId: galaxy.activeId,
    visited: discovered.size,
    total: galaxy.worlds.length,
    pacified: galaxy.pacified ? galaxy.pacified.size : 0,   // Domination progress: worlds conquered
    dominationTarget: DOMINATION_TARGET,
    worlds: galaxy.worlds.map(id => {
      const seen = discovered.has(id);
      const s = seen ? galaxy.planets.get(id) : null;
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
        income = Math.round(incomeBuildingCount(s) * COLONY_INCOME_PER_BUILDING * 60);   // credits/min (capped, turret-excluded)
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

// What counts as a launch-ready pad: the player's own, finished Spaceport. Defined once so
// jumpVessel/canJump/jumpCapital can't drift on the predicate (owner + type + built).
const isPlayerSpaceport = b => b.owner === "player" && b.type === "spaceport" && !b.constructing;
const playerSpaceport = state => [...state.buildings.values()].find(isPlayerSpaceport) || null;

// The colony ship that would carry an interplanetary jump: a player colony ship staged
// within JUMP_LOAD_RADIUS of a completed Spaceport. A jump relocates the SHIP (and the
// rest of the staged expedition) — NOT a deployed base. Deployed Command Centers are
// permanent: the world you leave keeps them and becomes a background colony. Deploy the
// ship at the destination to found your new base there. Null when no ship is on the pad.
export function jumpVessel(state) {
  const spaceport = playerSpaceport(state);
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
  return !!playerSpaceport(state);
}

// A world where the player still has a foothold — a Command Center or an undeployed colony ship
// (the same notion as the galaxy defeat/relief check). It's a world a stranded force can fall
// back to and actually operate from: build, re-arm, or fetch a colony ship.
const playerFoothold = state => !!state && ([...state.buildings.values()]
  .some(b => b.owner === "player" && b.type === "command") || hasColonyShip(state, "player"));

// Can the player jump to `destId` right now? A Spaceport on the CURRENT world lets you jump
// anywhere (expand to a new world or hop to a held one). WITHOUT a Spaceport here you can still
// FALL BACK to any world where you have a foothold — so a force stranded on a portless world
// (e.g. you hopped an army over and forgot the colony ship) is never trapped: it can always
// retreat to a base it holds and bring the ship back. Only opening a NEW frontier needs a
// Spaceport here.
export function canJumpTo(galaxy, destId) {
  if (destId === galaxy.activeId) return false;
  return canJump(activeState(galaxy)) || playerFoothold(galaxy.planets.get(destId));
}

const planetX = id => PLANETS.find(p => p.id === id)?.x ?? 0;

// The fuel a jump to `destId` costs: FREE to a world you already hold (any world you've
// visited — a colony you're returning to, reinforcing, or re-settling), so bouncing between
// your own worlds to defend or ferry a colony ship stays friction-free. Reaching a NEW world
// costs fuel that SCALES WITH DISTANCE across the frontier (data.js planet x, 0..~18): a near
// hop is close to the base fee, settling a distant world is a real, growing credit sink and a
// strategic choice — so exploration spend isn't the old flat, quickly-capped ~4,000 lifetime.
export function jumpCost(galaxy, destId) {
  // Free to a world you've already REACHED (a colony you're returning to, reinforcing, or
  // re-settling). Since the living galaxy instantiates every world up front, "reached" is the
  // player-facing `discovered` set, NOT merely "the state object exists" — else every jump would be
  // free. Old saves (no discovered set) fall back to planets.has, which for them meant the same thing.
  const known = galaxy.discovered ? galaxy.discovered.has(destId) : galaxy.planets.has(destId);
  if (known || playerFoothold(galaxy.planets.get(destId))) return 0;   // reached before, or a base you still hold → free
  const dist = Math.abs(planetX(destId) - planetX(galaxy.activeId));
  return Math.round(JUMP_COST * (0.8 + dist / 18));   // ~340 next-door … ~720 across the map
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

// A jump carries a CARGO HOLD of manufactured goods to the destination, so a run of production on
// one world can be sold on another — the make-here/sell-there loop (produced goods price
// differently per world, engine/market.js). The hold's SIZE is the combined cargoHold of the cargo
// ships (engine/entities.js: hauler/heavyhauler/bulkfreighter) staged for the jump — no cargo ship
// means no freight. Loaded most-valuable-first (data.js COM.base: machinery 250 > electronics 95 >
// alloys 80 > spice 34 > metals 22). spice is here so Verdani's agri surplus can be exported and
// sold dear on an industrial world (it's cheap where it's mined, precious where it isn't); cheaper
// raws aren't worth a cargo slot and strategic goods stay put.
const CARGO_GOODS = ["machinery", "electronics", "alloys", "spice", "metals"];

// The freight capacity a set of riders provides — the summed cargoHold of the cargo ships among
// them (anything without a cargoHold carries nothing). Pure.
export function freightCapacity(riders) {
  let cap = 0;
  for (const u of riders) cap += UNITS[u.type]?.cargoHold || 0;
  return cap;
}

// What `capacity` units of hold would haul from `from`, as { good: qty } — most-valuable-first, for
// the HUD preview and the jump itself (so the shown manifest and the moved goods can never
// disagree). capacity 0 (no cargo ship staged) → an empty hold.
export function cargoManifest(from, capacity = 0) {
  let room = Math.max(0, capacity | 0);
  const src = from.players.player.resources;
  const manifest = {};
  for (const com of CARGO_GOODS) {
    if (room <= 0) break;
    const move = Math.min(Math.floor(src[com] || 0), room);
    if (move > 0) { manifest[com] = move; room -= move; }
  }
  return manifest;
}

// How full a freighter's hold is (sum of its commodity quantities). 0 for a non-freighter.
export function freightUsed(unit) {
  let n = 0;
  if (unit && unit.freight) for (const com in unit.freight) n += unit.freight[com] || 0;
  return n;
}

// A freighter's remaining hold room = its cargoHold minus what's aboard.
export function freightRoom(unit) {
  const cap = unit ? (UNITS[unit.type]?.cargoHold || 0) : 0;
  return Math.max(0, cap - freightUsed(unit));
}

// Load up to `qty` of commodity `com` from the CURRENT world's player stockpile into a freighter's
// hold, clamped to the hold's room and what's actually in stock. Returns the amount loaded (0 if
// it's not a player freighter, the commodity is unknown, or nothing could move). The goods leave
// the stockpile immediately — they're aboard the ship now, to ride the next jump.
export function loadFreighter(state, unitId, com, qty) {
  const u = state.units.get(unitId);
  if (!u || u.owner !== "player" || !u.freight || !COM[com] || !(UNITS[u.type]?.cargoHold)) return 0;
  const res = state.players.player.resources;
  const move = Math.min(Math.floor(qty) || 0, freightRoom(u), Math.floor(res[com] || 0));
  if (move <= 0) return 0;
  res[com] -= move;
  u.freight[com] = (u.freight[com] || 0) + move;
  return move;
}

// Unload up to `qty` of `com` from a freighter's hold back onto the CURRENT world's player
// stockpile. Returns the amount unloaded. Works wherever the ship is — the origin (to undo a
// load) or a world it jumped to (to bank the haul and sell it at that market).
export function unloadFreighter(state, unitId, com, qty) {
  const u = state.units.get(unitId);
  if (!u || u.owner !== "player" || !u.freight) return 0;
  const move = Math.min(Math.floor(qty) || 0, u.freight[com] || 0);
  if (move <= 0) return 0;
  u.freight[com] -= move;
  if (u.freight[com] <= 0) delete u.freight[com];
  const res = state.players.player.resources;
  res[com] = (res[com] || 0) + move;
  return move;
}

// A jump delivers every staged freighter's HOLD to the destination colony's stockpile. A freighter
// the player left EMPTY auto-fills from the origin stockpile most-valuable-first first — the
// zero-effort "produce here, sell there" default, unchanged — while one the player hand-loaded
// ships exactly what they chose. Returns the combined delivered manifest (for the arrival toast).
// `riders` are the units that lifted off; non-freighters (no hold) are skipped.
function loadCargo(from, dest, riders) {
  const src = from.players.player.resources, dst = dest.players.player.resources;
  const delivered = {};
  for (const u of riders) {
    if (!u.freight || !(UNITS[u.type]?.cargoHold)) continue;
    if (freightUsed(u) === 0) {                                  // empty hold → auto-fill from what's left on the origin
      const manifest = cargoManifest(from, UNITS[u.type].cargoHold);
      for (const com in manifest) { src[com] -= manifest[com]; u.freight[com] = manifest[com]; }
    }
    for (const com in u.freight) {                               // deliver the hold to the destination colony
      dst[com] = (dst[com] || 0) + u.freight[com];
      delivered[com] = (delivered[com] || 0) + u.freight[com];
    }
    u.freight = {};
  }
  return delivered;
}

// Launch an interplanetary jump to `destId`: player units move to the destination's landing
// zone along with the cargo hold. NO deployed base moves — the origin keeps ALL its buildings
// and becomes a background colony. Costs fuel only for a NEW world (jumpCost); returning to a
// held world is free.
//
// Two modes:
//   • With a Spaceport HERE — the normal launch: the capacity-capped expedition staged near the
//     pad (a colony ship to settle, an army to reinforce, or nothing) rides along.
//   • WITHOUT a Spaceport, falling back to a world you ALREADY HOLD — a pure CONTROL SWITCH that
//     moves NO units: with no launch pad there's no way to load a fleet, so the force you left on
//     this world STAYS PUT. This is the catch-22 escape (hop back to a base to fetch a colony
//     ship) WITHOUT dragging a garrison home — you bring the ship to the stranded force, not the
//     force back. To actually ferry units off a world, build a Spaceport there. See canJumpTo.
//
// Returns a summary, or null if the jump can't run (no way to reach the destination, same world,
// or too poor to fuel a new-world jump).
export function jumpCapital(galaxy, destId) {
  const from = activeState(galaxy);
  if (destId === galaxy.activeId) return null;
  const spaceport = playerSpaceport(from);
  const canFallBack = playerFoothold(galaxy.planets.get(destId));   // a world you hold a base on
  if (!spaceport && !canFallBack) return null;                      // no port here and nowhere to fall back → can't jump
  const cost = jumpCost(galaxy, destId);
  if (galaxy.credits < cost) return null;

  // Spaceport → the capacity-capped staged expedition. No Spaceport (a fallback) → nothing rides:
  // a control switch that leaves every unit on this world where it is.
  let riders = [], leftBehind = 0;
  if (spaceport) ({ riders, leftBehind } = jumpManifest(from, spaceport));
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

  const cargo = loadCargo(from, dest, riders);   // deliver each staged freighter's hold (empty ones auto-fill)

  from.selection = []; dest.selection = [];
  from.background = true;    // the world you left keeps evolving on its own
  dest.background = false;   // the destination is now your active seat
  galaxy.activeId = destId;
  (galaxy.discovered || (galaxy.discovered = new Set())).add(destId);   // now REACHED — a free return-jump, and it shows on the starmap
  updateFog(dest, dest.fog, "player");
  updateFog(dest, dest.fogAI, "ai");
  updateFog(from, from.fog, "player");
  return { destId, riders: riders.length, leftBehind, cargo };   // leftBehind: staged units the pad couldn't fit this trip
}
