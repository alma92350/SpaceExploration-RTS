/* ============================================================
   Save / load. Because the sim is deterministic and seed-driven (see
   engine/rng.js), a save doesn't need the whole world — the map (terrain,
   node positions) regenerates from the seed, so we persist only the seed +
   the DYNAMIC state: entities, economies, fog memory, and the AI's bookkeeping.
   The per-planet payload (serPlanet / rehydratePlanet) is shared by two savers:
   a single skirmish (serializeGame) and a whole Odyssey galaxy of N planets
   (serializeGalaxy), which additionally carries each world's market pressure,
   diplomacy stance, and colony flag, plus the galaxy meta (credits, active
   world, schedule counter). Round-trip and continue-identically are covered by
   test/persist.test.js and test/odyssey.test.js.
   ============================================================ */

"use strict";

import { generateMap } from "./map.js";
import { mulberry32 } from "./rng.js";
import { createFog, updateFog } from "./fog.js";
import { archetypeFor } from "./aiArchetypes.js";
import { peekEntityId, restoreEntityId } from "./state.js";
import { createMarket } from "./market.js";
import { createDiplomacy } from "./diplomacy.js";
import { UNITS, BUILDINGS, storeCapOf, inputCapOf } from "./entities.js";
import { TECHS } from "./techtree.js";   // known research nodes — to sanitise a Datacenter's untrusted researchQueue on load
import { COM } from "../data.js";
import { ODYSSEY_WORLDS } from "./galaxy.js";

export const SAVE_VERSION = 1;
export const GALAXY_SAVE_VERSION = 1;

// --- load-time sanitization -------------------------------------------------
// A save loaded from a file or localStorage is UNTRUSTED input (a user can hand-edit a file, and
// localStorage is reachable by any script/devtools). The sim never eval()s save data, so there's
// no classic code-injection vector — but a hostile or corrupt payload could still (a) smuggle a
// prototype-polluting key (__proto__/constructor/prototype — JSON.parse makes these OWN props that
// can poison later object ops) or (b) be a node/string/depth "bomb" that hangs the load. So before
// a parsed save reaches the deserializer we walk it and reject anything that isn't plain, bounded
// JSON data. Correctness (version, shape) is still the deserializer's job; this is purely the
// safety gate. Throws with a clear reason; returns the input so it can be chained.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SAVE_NODES = 600000;   // total values — a whole galaxy is well under this; a bomb isn't
const MAX_SAVE_DEPTH = 200;
const MAX_STRING_LEN = 4096;

export function sanitizeSave(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("save is not a valid object");
  let nodes = 0;
  const walk = (v, depth) => {
    if (depth > MAX_SAVE_DEPTH) throw new Error("save is too deeply nested");
    if (++nodes > MAX_SAVE_NODES) throw new Error("save is too large");
    if (v === null || typeof v === "number" || typeof v === "boolean") return;
    if (typeof v === "string") { if (v.length > MAX_STRING_LEN) throw new Error("save has an oversized string"); return; }
    if (Array.isArray(v)) { for (const el of v) walk(el, depth + 1); return; }
    if (typeof v === "object") {
      for (const k of Object.getOwnPropertyNames(v)) {   // getOwnPropertyNames also catches a non-enumerable __proto__
        if (FORBIDDEN_KEYS.has(k)) throw new Error(`save contains a forbidden key: ${k}`);
        walk(v[k], depth + 1);
      }
      return;
    }
    throw new Error("save contains an unsupported value");   // functions/symbols can't come from JSON, but be explicit
  };
  walk(input, 0);
  return input;
}

// --- load-time value validation --------------------------------------------
// sanitizeSave() guarantees the payload is plain, bounded JSON — but NOT that its
// values make sim sense. A version-valid save (hand-edited, or merely corrupted in
// storage) can still carry a string where a number belongs, a NaN coordinate, or an
// entity `type` that isn't a real unit/building. Those don't throw at load — they slip
// in and detonate on the FIRST tick, inside the rAF loop, AFTER load's try/catch has
// already returned success: the game boots, then silently freezes (updateUnit reads
// UNITS[type].role on an undefined def) or drifts (state.time += "100" concatenates).
// So we coerce/clamp the known numeric fields and drop entities of unknown type here,
// on the way in. Deterministic and DOM-free: a VALID save's fields are already finite
// numbers of real types, so every coercion below is the identity on them and the
// byte-identical replay guarantee (test/determinism.test.js) is untouched.
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

// Coerce one entity's numeric fields to finite values, defaulting hp/maxHp from its
// def and clamping coordinates into the map so a bad value can never poison the spatial
// hash (NaN,NaN buckets) or the hp accounting (an un-killable NaN-hp ghost).
function cleanEntity(e, def, map) {
  const maxHp = num(e.maxHp, def.hp);
  e.maxHp = maxHp > 0 ? maxHp : def.hp;
  e.hp = Math.max(0, Math.min(num(e.hp, e.maxHp), e.maxHp));
  e.x = Math.max(0, Math.min(num(e.x, 0), map.width));
  e.y = Math.max(0, Math.min(num(e.y, 0), map.height));
  // An order (and each queued waypoint) can carry target x/y coords that a tampered save could set to
  // NaN/huge/non-numeric garbage — which then flow straight into stepToward as the move destination
  // and NaN the unit's position (engine/sim.js, engine/combat.js), permanently poisoning the spatial
  // hash. Clamp any x/y an order carries the SAME way as the unit's own x/y; orders without coords
  // (gather/build/scout/attack-by-id) and a null/absent order are left untouched — identity for valid.
  const clampOrderCoords = o => {
    if (!o || typeof o !== "object") return;
    if (o.x !== undefined) o.x = Math.max(0, Math.min(num(o.x, 0), map.width));
    if (o.y !== undefined) o.y = Math.max(0, Math.min(num(o.y, 0), map.height));
  };
  clampOrderCoords(e.order);
  if (Array.isArray(e.orderQueue)) for (const o of e.orderQueue) clampOrderCoords(o);
  // A worker's `cargo` hold ({com, qty}) is untrusted too: coerce its qty to a finite value >= 0 (a
  // NaN/negative haul would poison the gather/haul/bank math on the first tick), and DROP the whole
  // cargo (→ null) when it isn't an object or names a bogus commodity — a `com` outside COM would
  // become a phantom treasury key the moment it's banked. An EMPTY hold (com:null) is the valid
  // resting state of every worker, so it's kept; a non-worker's cargo is already null and is left as
  // is. Identity for valid data.
  if (e.cargo !== undefined && e.cargo !== null) {
    if (typeof e.cargo !== "object" || (e.cargo.com != null && !COM[e.cargo.com])) e.cargo = null;
    else e.cargo.qty = Math.max(0, num(e.cargo.qty, 0));
  }
  // A freighter's `freight` hold is untrusted save data (a hand-edited file could smuggle in a
  // negative, NaN, or over-capacity haul, or a bogus commodity): keep only real commodities with a
  // positive finite qty, and clamp the total to the ship's cargoHold. A non-freighter can't carry
  // freight at all, so strip any that a tampered save bolted on.
  if (def.cargoHold) {
    const clean = {};
    let used = 0;
    if (e.freight && typeof e.freight === "object") {
      for (const com of Object.keys(e.freight)) {
        if (!COM[com] || used >= def.cargoHold) continue;
        const q = num(e.freight[com], 0);
        if (q > 0) { const take = Math.min(q, def.cargoHold - used); clean[com] = take; used += take; }
      }
    }
    e.freight = clean;
  } else if (e.freight !== undefined) {
    delete e.freight;
  }
  // A Plasma Rig's dig state is untrusted too: clamp digProgress into a sane band (a tampered huge
  // value would otherwise drive the dig loop to mint resources) and floor the dig counter.
  if (def.rig) {
    e.digProgress = Math.max(0, Math.min(num(e.digProgress, 0), 2));
    e.digCount = Math.max(0, Math.floor(num(e.digCount, 0)));
  }
  // A wonder's `charge` (a 0..1 float, engine/wonder.js) is untrusted: a hand-edited save could set it
  // huge, negative, NaN, or non-numeric — and an out-of-band charge trips an instant standalone-endless
  // win (engine/victory.js checkEndlessWin fires at charge >= 1) or corrupts the charge/HUD math. Clamp
  // it into [0,1] on load. Only touch a wonder that actually carries the field (an uncharged Gate has
  // none yet), and a legitimately-saved charge is already in [0,1] — so this is the identity.
  if (def.wonder && e.charge !== undefined) e.charge = Math.max(0, Math.min(num(e.charge, 0), 1));
  // A producer's output buffer (building.store) and a factory's input buffer (building.input) are
  // untrusted save data — a hand-edited file could smuggle in a bogus commodity, a negative/NaN qty,
  // or an over-capacity buffer. Keep only real commodities with a positive qty and clamp each buffer's
  // total to its capacity (storeCapOf / inputCapOf apply the factory defaults); a building with no such
  // buffer can't hold one, so strip any a tampered save bolted on.
  e.store = coerceBuffer(e.store, storeCapOf(e.type));
  e.input = coerceBuffer(e.input, inputCapOf(e.type));
  if (storeCapOf(e.type) <= 0) delete e.store;
  if (inputCapOf(e.type) <= 0) delete e.input;
  // A building's production queue is untrusted: a bogus/unknown unitType would deref undefined and
  // brick the game on the first tick (see engine/production.js). For buildings only (units carry no
  // queue), rebuild it from known-good jobs — real UNIT types, progress clamped to [0,1], the
  // paid-with-alt flag preserved, everything else dropped — and empty it for a building that can't
  // produce or whose queue isn't even an array. For a valid save this is the identity, so the
  // byte-identical round-trip is untouched.
  if (BUILDINGS[e.type]) {
    e.queue = (BUILDINGS[e.type].produces && Array.isArray(e.queue))
      ? e.queue.filter(j => j && UNITS[j.unitType]).map(j => ({
          unitType: j.unitType,
          progress: Math.max(0, Math.min(num(j.progress, 0), 1)),
          ...(j.alt ? { alt: true } : {}),
        }))
      : [];
    // A Datacenter's research queue is untrusted exactly like the production queue above: a non-array
    // `researchQueue` (e.g. the number 5) throws .length/.shift and bricks the game on the first
    // research tick (engine/techtree.js updateResearch), and a bogus techId derefs an undefined TECHS
    // def. When the field is present, rebuild it from known-good jobs — real TECHS ids, progress
    // clamped to [0,1] — or [] for a non-array. A building WITHOUT the field (every non-Datacenter,
    // and a Datacenter that never queued research) is left untouched, so it's the identity for a valid
    // save.
    if (e.researchQueue !== undefined) {
      e.researchQueue = Array.isArray(e.researchQueue)
        ? e.researchQueue.filter(j => j && TECHS[j.techId]).map(j => ({
            techId: j.techId,
            progress: Math.max(0, Math.min(num(j.progress, 0), 1)),
          }))
        : [];
    }
  }
  return e;
}

// Sanitize an untrusted commodity→qty buffer: real commodities only, positive finite qty,
// total clamped to `cap`. Returns {} for a zero/undefined cap.
function coerceBuffer(buf, cap) {
  const clean = {};
  if (cap <= 0 || !buf || typeof buf !== "object") return clean;
  let used = 0;
  for (const com of Object.keys(buf)) {
    if (!COM[com] || used >= cap) continue;
    const q = num(buf[com], 0);
    if (q > 0) { const take = Math.min(q, cap - used); clean[com] = take; used += take; }
  }
  return clean;
}

// Largest numeric suffix among the state's OWN-minted ids ("u12"/"b7" — the ids newId
// mints from the global counter; "g"-scheme galaxy ids come from a separate counter and
// are ignored here). Used to guarantee the restored counter can never mint an id that
// collides with a loaded entity, even if the save's nextEntityId is missing/low/garbage.
function maxOwnEntityId(state) {
  let m = 0;
  const scan = id => { const s = /^[ub](\d+)$/.exec(String(id)); if (s) { const n = +s[1]; if (n > m) m = n; } };
  for (const id of state.units.keys()) scan(id);
  for (const id of state.buildings.keys()) scan(id);
  return m;
}

function serPlayer(p) {
  return { id: p.id, faction: p.faction, isAI: p.isAI, color: p.color,
    resources: { ...p.resources }, upgrades: { ...p.upgrades } };
}

// The DYNAMIC per-planet payload — everything the seed can't regenerate. Shared by
// the skirmish save and every planet of a galaxy save. visible fog is NOT stored
// (recomputed on load); only `explored` (permanent scouted memory) persists. The
// global entity-id counter is NOT here — it's saved once by the caller.
function serPlanet(state) {
  return {
    seed: state.seed, planetId: state.planetId,
    sizeMult: state.sizeMult, resourceMult: state.resourceMult, endless: !!state.endless,
    time: state.time, tick: state.tick, over: state.over, winner: state.winner,
    players: { player: serPlayer(state.players.player), ai: serPlayer(state.players.ai) },
    // `_gi` is the grid broad-phase index — a transient stamped fresh onto every unit each tick
    // by buildUnitGrid, meaningless once saved. Strip it so it doesn't bloat the payload with a
    // per-unit integer that the next tick overwrites anyway. Shallow copy, only at save time.
    units: [...state.units.values()].map(({ _gi, repairTargetId, ...u }) => u),   // both transient (grid index; live repair pick)
    // `haulers`/`servers` (logistics tallies, engine/haul.js), `powered`/`fuel` (Generator fuel
    // state, engine/industry.js), `menderClaims` (auto-repair Mender tally, engine/sim.js) and
    // `lastYield`/`lastTier` (a Plasma Rig's last-strike HUD readout, engine/rig.js — regenerated on
    // the next dig) are all transient — stamped fresh each tick like a unit's `_gi` grid index — so
    // strip them from saves. (digProgress/digCount are the rig's REAL persisted dig state, kept.)
    buildings: [...state.buildings.values()].map(({ haulers, servers, powered, fuel, menderClaims, lastYield, lastTier, ...b }) => b),
    nodes: state.map.nodes.map(n => ({ id: n.id, amount: n.amount })),
    fog: [...state.fog.explored],
    fogAI: [...state.fogAI.explored],
    ai: {
      aiThink: state.ai.think ?? 0, aiScoutId: state.ai.scoutId ?? null,
      aiApm: state.ai.apm ?? null, aiMicro: !!state.ai.micro,
      aiActionBudget: state.ai.actionBudget ?? 0,
      aiAttackForce: state.ai.attackForce ?? 0, aiAttackDesperate: !!state.ai.attackDesperate,
      aiNextAttackAt: state.ai.nextAttackAt ?? null, aiUnitsBuilt: state.ai.unitsBuilt ?? 0,
      // Committed-wave counter (engine/ai.js): drives the economy-raid cadence
      // (aiWaveCount % RAID_EVERY). Omitting it reset the counter to 0 on every reload,
      // shifting all subsequent raid-vs-base decisions — the same continue-identically
      // break the aiNextWaveAt note below warns about. Additive + `|| 0`-defaulted in
      // ai.js, so old saves without it load fine.
      aiWaveCount: state.ai.waveCount ?? 0,
      // Odyssey offense cadence (engine/ai.js) — a scheduled future time. Must be
      // persisted or a reloaded hostile world fires its next probe a full cadence
      // early (undefined ?? 0 ⇒ immediately wave-ready), breaking continue-identically.
      aiNextWaveAt: state.ai.nextWaveAt ?? null,
      // Odyssey colony-ship expansion target (engine/ai.js) — the committed deploy spot
      // of an in-flight ship. Persisted so a reload doesn't recompute a different target.
      aiColonyTarget: state.ai.colonyTarget ?? null,
    },
  };
}

// Rebuild a single engine state from a per-planet payload: regenerate the
// deterministic map from the seed, overlay saved node amounts by id, restore
// entities/economies/AI bookkeeping, and recompute current visibility. Does NOT
// touch the global entity-id counter (the caller restores it once, last).
function rehydratePlanet(P) {
  const map = generateMap(P.planetId, mulberry32((P.seed ?? 0) >>> 0),
    { sizeMult: P.sizeMult, resourceMult: P.resourceMult });
  const amounts = new Map(P.nodes.map(n => [n.id, n.amount]));
  for (const n of map.nodes) if (amounts.has(n.id)) n.amount = amounts.get(n.id);

  const fog = createFog(map); fog.explored = Uint8Array.from(P.fog);
  const fogAI = createFog(map); fogAI.explored = Uint8Array.from(P.fogAI);

  // Keep only entities of a REAL type, coercing their numeric fields — an unknown
  // `type` makes UNITS[type]/BUILDINGS[type] undefined and throws on the first tick;
  // a NaN coord/hp silently corrupts the sim. Drop the former, clean the latter.
  const units = new Map();
  for (const u of P.units) { const def = UNITS[u.type]; if (def) units.set(u.id, cleanEntity(u, def, map)); }
  const buildings = new Map();
  for (const b of P.buildings) { const def = BUILDINGS[b.type]; if (def) buildings.set(b.id, cleanEntity(b, def, map)); }

  const state = {
    time: num(P.time, 0), tick: num(P.tick, 0), over: P.over, winner: P.winner,
    seed: P.seed, planetId: P.planetId, sizeMult: P.sizeMult, resourceMult: P.resourceMult,
    endless: !!P.endless,
    map,
    players: { player: P.players.player, ai: P.players.ai },
    units,
    buildings,
    selection: [],
    fog, fogAI,
    // Restore the AI controller's bookkeeping into the grouped `state.ai` (see engine/state.js).
    // Wire keys stay `aiThink`/`aiScoutId`/… under the save's `ai:` object for backward compat;
    // only the live shape is nested. The archetype is re-derived from the planet id, not persisted.
    ai: {
      scoutId: P.ai.aiScoutId, think: P.ai.aiThink,
      apm: P.ai.aiApm, micro: P.ai.aiMicro,
      actionBudget: P.ai.aiActionBudget,
      attackForce: P.ai.aiAttackForce, attackDesperate: P.ai.aiAttackDesperate,
      nextAttackAt: P.ai.aiNextAttackAt, unitsBuilt: P.ai.aiUnitsBuilt,
      waveCount: P.ai.aiWaveCount ?? 0,
      nextWaveAt: P.ai.aiNextWaveAt ?? undefined,
      colonyTarget: P.ai.aiColonyTarget ?? null,
      archetype: archetypeFor(P.planetId),
    },
    events: [],
  };
  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}

/* ---------- single skirmish ---------- */

// The plain, JSON-safe save payload (serPlanet already returns detached plain data). The two
// public paths differ only in the last step: serializeGame() returns a DETACHED OBJECT (a
// stringify/parse copy, so ticking the live game on after a save can't mutate it under a caller
// that keeps it — tests, importSave's shape sniff); serializeGameString() returns the JSON
// STRING directly. autoSave (the 12 s hot path) uses the string, so it stringifies ONCE instead
// of stringify→parse→stringify — the fog arrays are large, and the two extra passes were waste.
function gamePayload(state) { return { v: SAVE_VERSION, nextEntityId: peekEntityId(), ...serPlanet(state) }; }
export function serializeGame(state) { return JSON.parse(JSON.stringify(gamePayload(state))); }
export function serializeGameString(state) { return JSON.stringify(gamePayload(state)); }

export function deserializeGame(input) {
  sanitizeSave(input);                              // reject unsafe/oversized payloads before anything else
  const save = JSON.parse(JSON.stringify(input));   // detach + normalise
  if (save.v !== SAVE_VERSION) throw new Error(`unsupported save version ${save.v}`);
  const state = rehydratePlanet(save);
  // Never trust the saved counter as ground truth: mint from beyond BOTH the saved value
  // AND every loaded id, so a missing/low/garbage nextEntityId can't produce an id that
  // overwrites a live entity. For a valid save this is exactly save.nextEntityId (peeked
  // after all mints, so already > every suffix) — identity, determinism preserved.
  restoreEntityId(Math.max(num(save.nextEntityId, 0), maxOwnEntityId(state) + 1));
  return state;
}

/* ---------- whole Odyssey galaxy ---------- */

function galaxyPayload(galaxy) {
  return {
    v: GALAXY_SAVE_VERSION,
    seed: galaxy.seed, credits: galaxy.credits, activeId: galaxy.activeId, worlds: galaxy.worlds,
    settings: galaxy.settings,
    entitySeq: galaxy.entitySeq ?? 0, galaxyTick: galaxy.tick ?? 0,
    galaxyTime: galaxy.time ?? 0,                    // galaxy-wide clock — keys the relief cooldown (engine/galaxy.js)
    lastReliefTime: galaxy.lastReliefTime ?? null,   // when the last relief ship dropped, on that same clock
    pacified: [...(galaxy.pacified || [])], wonBy: galaxy.wonBy ?? null,   // conquest progress (additive; old saves default to none)
    reached: [...(galaxy.reached || [])],                                  // progress milestones already celebrated — so a reload doesn't replay their fireworks
    discovered: [...(galaxy.discovered || [])],                            // living galaxy: worlds the player has REACHED (starmap "explored" + free return-jump)
    claims: [...(galaxy.claims || [])],                                     // faction spread: [worldId, faction] pairs (checkExpansion) — the galactic politics on the starmap
    nextEntityId: peekEntityId(),                 // the ONE global entity counter, saved once
    planets: [...galaxy.planets.values()].map(state => ({
      ...serPlanet(state),
      background: !!state.background,
      market: { pressure: { ...state.market.pressure }, glut: { ...(state.market.glut || {}) } },
      diplomacy: { ...state.diplomacy },          // stance, depletion, lastAiUnits
    })),
  };
}
// Detached object (serializeGalaxy) vs the JSON string (serializeGalaxyString) — see the
// serializeGame note; autoSave uses the string to stringify the fog-heavy galaxy just once.
export function serializeGalaxy(galaxy) { return JSON.parse(JSON.stringify(galaxyPayload(galaxy))); }
export function serializeGalaxyString(galaxy) { return JSON.stringify(galaxyPayload(galaxy)); }

export function deserializeGalaxy(input) {
  sanitizeSave(input);                              // reject unsafe/oversized payloads before anything else
  const save = JSON.parse(JSON.stringify(input));
  if (save.v !== GALAXY_SAVE_VERSION) throw new Error(`unsupported galaxy save version ${save.v}`);
  // Reject structural nonsense HERE, while the running session is still intact and the
  // caller's try/catch can keep the current game. Without these, a save whose activeId
  // has no matching planet (or that carries no planets at all) parses "successfully",
  // the caller tears down the live game, and boot crashes reading a non-existent active
  // world — losing the running game to a bad file.
  if (!Array.isArray(save.worlds) || !save.worlds.length) throw new Error("galaxy save has no worlds");
  if (!Array.isArray(save.planets) || !save.planets.length) throw new Error("galaxy save has no planets");

  // The world roster and active id are save-derived strings that flow into the starmap
  // UI (planetName → node text). Constrain them to REAL world ids so a hand-crafted save
  // can never smuggle an arbitrary string through the roster (defence-in-depth behind the
  // starmap's own escaping); an unknown activeId then fails the has-planet check below.
  const known = new Set(ODYSSEY_WORLDS);
  const worlds = save.worlds.filter(id => known.has(id));
  if (!worlds.length) throw new Error("galaxy save has no recognised worlds");
  // Append any roster worlds the save predates (the roster is append-only, so this is
  // index-stable): a pre-Phase-4 save froze `worlds` at nine, permanently hiding the newer
  // worlds from the starmap AND — because the BG scheduler keys on worlds.indexOf(id) — any
  // planet missing from the roster would get index -1 and never tick again.
  for (const id of ODYSSEY_WORLDS) if (!worlds.includes(id)) worlds.push(id);

  const galaxy = {
    seed: save.seed, credits: num(save.credits, 0), activeId: save.activeId, worlds,
    planets: new Map(), settings: save.settings,
    tick: num(save.galaxyTick, 0), time: num(save.galaxyTime, 0), entitySeq: num(save.entitySeq, 0),
    lastReliefTime: Number.isFinite(save.lastReliefTime) ? save.lastReliefTime : undefined,
    colonyNotes: new Map(),   // transient UI bookkeeping — re-derived, never persisted
    pacified: new Set(save.pacified || []), pacifyNotes: [], wonBy: save.wonBy ?? null,
    reached: new Set(save.reached || []), milestones: [],   // celebrated milestones persist; the firework queue is transient
    // Worlds the player has reached. An OLD save predates the field AND the living galaxy, so it only
    // instantiated worlds the player had actually visited — recover `discovered` as exactly that set
    // (the planet ids present in the save), plus the active world. A NEW save carries the real set.
    discovered: new Set(save.discovered || [save.activeId, ...save.planets.map(P => P.planetId)]),
    // Faction spread (checkExpansion). Restored as a Map of [worldId, faction]; keep only real world
    // ids (defence-in-depth behind the roster filter). Old saves predate it → empty (no claims yet).
    claims: new Map((Array.isArray(save.claims) ? save.claims : [])
      .filter(e => Array.isArray(e) && ODYSSEY_WORLDS.includes(e[0]) && typeof e[1] === "string")),
    expansionNotes: [],   // transient UI queue — re-derived, never persisted
  };
  let maxId = 0;
  for (const P of save.planets) {
    if (!known.has(P.planetId)) continue;                    // skip a planet payload with an unrecognised id
    const state = rehydratePlanet(P);
    state.market = createMarket(state);                    // base recomputed from the (regenerated) nodes...
    Object.assign(state.market.pressure, P.market.pressure); // ...then overlay the saved running pressure...
    if (P.market.glut) Object.assign(state.market.glut, P.market.glut);   // ...and the slow produced-goods glut
    state.diplomacy = { ...createDiplomacy(), ...P.diplomacy };
    state.background = !!P.background;
    state.inGalaxy = true;                                    // galaxy member → galaxy-wide defeat (engine/galaxy.js)
    galaxy.planets.set(P.planetId, state);
    maxId = Math.max(maxId, maxOwnEntityId(state));
  }
  if (!galaxy.planets.has(galaxy.activeId)) throw new Error("galaxy save has no active planet");
  const active = galaxy.planets.get(galaxy.activeId);
  active.background = false;                                // the seat is never a background world
  // The galaxy `entitySeq` is the SEPARATE "g"-id counter — ids minted as "g"+entitySeq in
  // engine/galaxy.js for entities that cross worlds (jump riders, relief + colony ships). Unlike the
  // u/b counter (hardened above via maxOwnEntityId), it was restored as num(save.entitySeq,0) with NO
  // recompute — so a save with a low/missing entitySeq but a LIVE "g" entity (an in-flight colony
  // ship / freighter / relief ship) would later mint a COLLIDING "g"-id and clobber it. Scan every
  // unit/building id across ALL worlds for the g-scheme and lift entitySeq past the highest, mirroring
  // how maxOwnEntityId hardens the u/b counter. Identity for a valid save — its entitySeq already
  // exceeds every g-id, so the max is a no-op. The next mint pre-increments (galaxy.js), so we lift to
  // the max itself (not +1): entitySeq === g5 ⇒ next id is "g6".
  let maxGId = 0;
  const scanG = id => { const s = /^g(\d+)$/.exec(String(id)); if (s) { const n = +s[1]; if (n > maxGId) maxGId = n; } };
  for (const state of galaxy.planets.values()) {
    for (const id of state.units.keys()) scanG(id);
    for (const id of state.buildings.keys()) scanG(id);
  }
  galaxy.entitySeq = Math.max(num(save.entitySeq, 0), maxGId);
  // Mint beyond both the saved counter and every loaded id across ALL worlds (see the
  // skirmish note) — identity for a valid save, collision-proof for a corrupt one.
  restoreEntityId(Math.max(num(save.nextEntityId, 0), maxId + 1));
  return galaxy;
}
