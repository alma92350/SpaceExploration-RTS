/* ============================================================
   AI — the military brain: defend a pressed base, else muster and commit the
   next wave (aiMilitary / aiOffense), optional tactical focus-fire and the
   scout sweep, plus the target/mix helpers (chooseAttackTarget, raidTarget,
   pickNextUnitType and the counter-pick). Depends on aiCommon (action budget)
   and aiWorkers (effectiveMix); nothing in aiEconomy/aiIndustry depends back on
   it except through the exported pickNextUnitType, so there's no import cycle.
   ============================================================ */

"use strict";

import { UNITS } from "./entities.js";
import { issueAttackMove, issueMove } from "./commands.js";
import { isVisibleAt, isExploredAt, nearestUnexploredPoint } from "./fog.js";
import { hostility } from "./diplomacy.js";
import { chargingPlayerWonder } from "./wonder.js";
import { canAct, spend } from "./aiCommon.js";
import { effectiveMix } from "./aiWorkers.js";

const COUNTER_EVERY = 3;   // 1 in every 3 units built reacts to the player's army instead of following the mix

// Derived once from each unit's bonusVs table (entities.js), rather than
// hardcoded here, so this stays correct automatically if the roster or
// its counter relationships ever change: COUNTER_OF['lancer'] === 'skiff'
// means Skiff is the type that holds bonus damage against Lancer.
const COUNTER_OF = Object.values(UNITS).reduce((map, def) => {
  if (def.bonusVs) for (const targetType of Object.keys(def.bonusVs)) map[targetType] = def.id;
  return map;
}, {});

const PROBE_MIN = 3;              // Odyssey: smallest wave a wary neighbour sends — it harasses, never doomstacks
const WAVE_CADENCE_FRAC = 0.3;    // Odyssey: probe spacing as a fraction of attackTimeout, tightening with hostility

// DEFENSE first: if enemy combat is seen pressing a building, recall the army (bar the scout) to meet it. Otherwise OFFENSE: retreat a ground-down wave, then muster and commit the next one (skirmish armyAttackSize, or an Odyssey hostility-paced probe).
/** @param {State} state @param {AiContext} ctx */
export function aiMilitary(state, ctx) {
  const { army, threats } = ctx;
  // DEFENSE first: if the AI can SEE enemy combat units pressing one of its
  // buildings, the whole army (bar the scout) drops what it's doing and rushes
  // that spot — including units already committed forward. This is the recall
  // that makes "absorb the wave, then counter" no longer a free win: hit the
  // AI's base and it brings its force home to meet you, instead of marching on
  // regardless while its economy burns. Exempt from the APM budget, same as the
  // attack commit, so a slow AI still always defends. Once the threat clears
  // vision, the army re-forms at home and the offensive logic below takes over.
  const nonScout = army.filter(u => u.id !== state.ai.scoutId);
  if (threats.length > 0) {
    if (nonScout.length > 0) {
      const focus = threatCentroid(threats);
      if (state.ai.micro && nonScout.length > threats.length * 2) {
        // FEINT-RESISTANT (Tactical): a small poke can no longer yank the whole
        // army out of position. Commit only a proportionate defence — the closest
        // units, ~2x the seen threat — and leave the rest on their assignment, so
        // a one-unit feint costs the AI a couple of defenders, not its whole push.
        // A genuinely large attack (threat >= half the army) falls through to the
        // full recall below. Tactical-only, and a passive player never threatens,
        // so the resolves-to-a-winner guarantee is untouched.
        const need = Math.min(nonScout.length, threats.length * 2 + 1);
        const defenders = nonScout.slice()
          .sort((a, b) => Math.hypot(a.x - focus.x, a.y - focus.y) - Math.hypot(b.x - focus.x, b.y - focus.y))
          .slice(0, need);
        issueAttackMove(defenders, focus.x, focus.y);
      } else {
        issueAttackMove(nonScout, focus.x, focus.y);   // Standard (or a serious attack): the whole army rushes home
      }
    }
  } else {
    aiOffense(state, ctx, nonScout);
  }
}

// OFFENSE: retreat a ground-down, non-desperation wave that's still facing live opposition, then
// muster and commit the next one. Two regimes split on state.diplomacy: SKIRMISH musters
// armyAttackSize (throwing everything on the desperation timeout — the resolves-to-a-winner path);
// ODYSSEY paces escalating probes by hostility. Always keeps a home guard unless it's a timeout commit.
/** @param {State} state @param {AiContext} ctx @param {Unit[]} nonScout */
function aiOffense(state, ctx, nonScout) {
  const { buildings, archetype } = ctx;
    // OFFENSE. "Home" army is whatever hasn't already been sent off to attack —
    // a freshly produced or still-idle unit has order null/'move' (its walk to
    // the rally point), while a committed one is mid attack-move (see combat.js).
    // Filtering on that means each new batch automatically forms the next wave
    // once the threshold is met again, so the AI keeps attacking in waves.
    const homeArmy = nonScout.filter(u => !u.order || u.order.type === "move");
    const attackers = nonScout.filter(u => u.order && u.order.type === "attack-move");
    const cc = buildings.find(b => b.type === "command" && !b.constructing) || buildings[0];

    // RETREAT: a committed, non-desperation attack that's been ground down to a
    // fraction of what was sent — and is STILL facing live opposition — pulls its
    // survivors home instead of feeding the last of them into a lost fight. So an
    // engagement trades (both sides keep a remnant) rather than ending in a wipe,
    // and the saved veterans re-form into the next wave. Two guards preserve the
    // resolves-to-a-winner guarantee: a desperation (timeout) commit never
    // retreats, and a retreat only fires while the AI can SEE enemy combat units
    // near the fight — so against an undefended base (every headless resolve
    // test) it never triggers and the AI razes the base exactly as before.
    if (!state.ai.attackDesperate && state.ai.attackForce > 0 && attackers.length > 0
        && attackers.length < state.ai.attackForce * RETREAT_FRACTION && cc) {
      const focus = threatCentroid(attackers);
      if (visibleEnemyCombatNear(state, focus.x, focus.y, RETREAT_SIGHT) >= attackers.length) {
        issueMove(attackers, cc.x, cc.y);   // plain move disengages: combat.js skips auto-acquire on a 'move' order
        state.ai.attackForce = 0;
      }
    }

    const nextAttackAt = state.ai.nextAttackAt ?? archetype.attackTimeout;
    const timedOut = state.time >= nextAttackAt;

    // Build this cycle's strike force. Two regimes, split on whether this world has
    // an Odyssey neighbour (state.diplomacy):
    //  • SKIRMISH (no diplomacy) — byte-for-byte as before: muster armyAttackSize,
    //    or throw everything on the desperation timeout (the resolves-to-a-winner
    //    path). A home guard is kept unless it's a timeout commit.
    //  • ODYSSEY — a hostility ramp (diplomacy.js). At peace (h===0) it holds fire;
    //    once wary it probes on a cadence with a small slice; as the stance sinks
    //    toward fully hostile the muster, the committed fraction and the cadence all
    //    climb, so a banked army bleeds out in escalating waves — never one doomstack.
    let strike = [], desperate = false;
    if (cc) {
      if (!state.diplomacy) {
        const readyToAttack = homeArmy.length > 0 && (homeArmy.length >= archetype.armyAttackSize || timedOut);
        if (readyToAttack) {
          strike = withoutHomeGuard(homeArmy, cc, timedOut ? 0 : (archetype.garrison || 0));
          desperate = timedOut;
        }
      } else {
        const h = hostility(state);
        const pm = (archetype.odyssey && archetype.odyssey.probeMin) || PROBE_MIN;   // archetype's Odyssey probe floor (Rusher 5 > Economist 4 > default 3)
        const muster = Math.max(pm, Math.round(archetype.armyAttackSize * h));
        const waveReady = state.time >= (state.ai.nextWaveAt ?? 0);
        if (h > 0 && waveReady && homeArmy.length >= muster) {
          const available = withoutHomeGuard(homeArmy, cc, archetype.garrison || 0);   // always hold the home guard
          const commit = Math.min(available.length, Math.max(pm, Math.round(available.length * h)));
          strike = available.slice(available.length - commit);   // send the forward-most; the rest reinforce
        }
      }
    }

    if (strike.length > 0) {
      // ECONOMY RAID (Tactical): every RAID_EVERY-th wave, if it can see the
      // player's worker line, this one goes for the economy instead of grinding the
      // defended main base — sniping production the way a human harasses. A
      // desperation (timeout) commit always goes for the base so the game resolves.
      state.ai.waveCount = (state.ai.waveCount || 0) + 1;
      // ODYSSEY FINALE: once the AI can SEE the player's charging Gate, every wave
      // converges on it — razing the galaxy-ender outranks even an economy raid. Still
      // fog-gated (it has to have eyes on the Gate) and Odyssey-only: in a skirmish
      // state.diplomacy is undefined, so `gate` is falsy and the target pick below is
      // byte-for-byte the original `raid || chooseAttackTarget(...)`.
      const charging = state.diplomacy && chargingPlayerWonder(state);
      const gate = charging && isVisibleAt(state.fogAI, charging.x, charging.y) ? charging : null;
      const raid = !gate && state.ai.micro && !desperate && state.ai.waveCount % RAID_EVERY === 0 && raidTarget(state);
      const target = gate || raid || chooseAttackTarget(state, cc);
      issueAttackMove(strike, target.x, target.y);
      // Cadence: a skirmish keeps the single attackTimeout clock (unchanged);
      // Odyssey paces the NEXT probe by hostility on its own timer — sparse when
      // merely wary, tight when hostile — so the skirmish clock is never touched.
      if (state.diplomacy) {
        state.ai.nextWaveAt = state.time + archetype.attackTimeout * WAVE_CADENCE_FRAC * (1 - 0.5 * hostility(state));
      } else {
        state.ai.nextAttackAt = state.time + archetype.attackTimeout;
      }
      // Reset the retreat baseline to the whole committed force (survivors of a
      // prior wave plus this reinforcement) so a topped-up wave doesn't read as
      // "ground down".
      state.ai.attackForce = attackers.length + strike.length;
      state.ai.attackDesperate = desperate;
    }
}

const FOCUS_RANGE = 340;   // only army units this close to the chosen target concentrate on it

// Point every nearby AI combat unit's focus at a single best enemy: the lowest-HP
// visible enemy combat unit (secure the kill, cut its DPS), tie-broken toward the
// more dangerous one, then by id for determinism. combat.js reads unit.focusId
// and prefers it while it's a live enemy in aggro (else falls back to the normal
// dispersed acquire). Cleared when nothing hostile is in sight, so the razing
// path uses ordinary targeting untouched.
export function applyFocusFire(state, army) {
  const enemies = [];
  for (const u of state.units.values()) {
    if (u.owner === "ai" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    enemies.push(u);
  }
  if (!enemies.length) { for (const a of army) a.focusId = null; return; }
  enemies.sort((a, b) => a.hp - b.hp
    || (UNITS[b.type].attack - UNITS[a.type].attack)
    || (a.id < b.id ? -1 : 1));
  const focus = enemies[0];
  for (const a of army) {
    a.focusId = Math.hypot(a.x - focus.x, a.y - focus.y) <= FOCUS_RANGE ? focus.id : null;
  }
}

const RETREAT_FRACTION = 0.4;   // a committed attack ground below this share of its launch size pulls back
const RETREAT_SIGHT = 260;      // ...if it can see at least as many enemy combat units this close (still losing)

// Player combat units the AI can currently SEE within `radius` of (x, y) — the
// live opposition at a fight. Zero against an undefended base, which is what
// makes the retreat safe for the resolves-to-a-winner guarantee.
function visibleEnemyCombatNear(state, x, y, radius) {
  let n = 0;
  for (const u of state.units.values()) {
    if (u.owner === "ai" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    if (Math.hypot(u.x - x, u.y - y) <= radius) n++;
  }
  return n;
}

const DEFEND_RADIUS = 340;   // enemy combat units this close to an AI building trigger a recall

// Enemy combat units the AI can currently SEE (its own fog) sitting within
// DEFEND_RADIUS of any building it owns. A lone scouting worker doesn't count —
// only real combat threats pull the army home, so the AI isn't yanked off an
// attack by a single drone. What it can't see, it can't react to.
export function visibleThreatsNearHome(state) {
  const myBuildings = [...state.buildings.values()].filter(b => b.owner === "ai");
  if (!myBuildings.length) return [];
  const threats = [];
  for (const u of state.units.values()) {
    if (u.owner === "ai" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    if (myBuildings.some(b => Math.hypot(b.x - u.x, b.y - u.y) <= DEFEND_RADIUS)) threats.push(u);
  }
  return threats;
}

function threatCentroid(threats) {
  let x = 0, y = 0;
  for (const t of threats) { x += t.x; y += t.y; }
  return { x: x / threats.length, y: y / threats.length };
}

// Hold back the `garrison` units closest to home; return the rest as the strike
// force. The near-home units make the standing defense, the forward ones push.
function withoutHomeGuard(homeArmy, cc, garrison) {
  if (!garrison || !cc || homeArmy.length <= garrison) {
    return homeArmy.length > garrison ? homeArmy.slice() : [];
  }
  const byDistHome = homeArmy.slice().sort((a, b) =>
    Math.hypot(a.x - cc.x, a.y - cc.y) - Math.hypot(b.x - cc.x, b.y - cc.y));
  return byDistHome.slice(garrison);   // drop the closest `garrison` — they stay home
}

// Where to send the wave. Prefer a seen enemy Command Center (the win
// condition), then any seen enemy building, then a seen enemy unit (raid the
// army or worker line). With nothing in sight it goes HUNTING: a player CC is
// still standing somewhere (the game isn't over), and the player can hold — and
// hide — several of them, so razing the first is not the win. It first marches on
// the player's start if it hasn't even charted it yet (the likeliest spot early,
// and the fast beeline that keeps the game resolving); once that's explored and
// empty, it sweeps the nearest unexplored ground, attack-moving to reveal fog,
// until it turns up a hidden expansion CC — instead of committing forever to a
// start coordinate the player has long since left.
const RAID_EVERY = 3;   // every Nth Tactical wave goes for the economy instead of the base

// The player's economy to snipe: the nearest player WORKER the AI can see. A
// Tactical raid peels a wave onto the worker line to cripple production rather
// than grinding the defended main base. Null when no worker is in sight — nothing
// to raid, so the caller falls back to the ordinary base assault.
function raidTarget(state) {
  const from = state.map.bases.ai;
  let best = null, bestD = Infinity;
  for (const u of state.units.values()) {
    if (u.owner !== "player" || u.type !== "worker") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;
    const d = Math.hypot(u.x - from.x, u.y - from.y);
    if (d < bestD) { bestD = d; best = u; }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function chooseAttackTarget(state, cc) {
  const from = cc || { x: state.map.bases.ai.x, y: state.map.bases.ai.y };
  const seen = e => e.owner === "player" && isVisibleAt(state.fogAI, e.x, e.y);
  const seenBuildings = [...state.buildings.values()].filter(seen);
  const ccs = seenBuildings.filter(b => b.type === "command");
  const nearestOf = list => {
    let best = null, bestD = Infinity;
    for (const e of list) {
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  };
  const target = nearestOf(ccs) || nearestOf(seenBuildings)
      || nearestOf([...state.units.values()].filter(seen));
  if (target) return target;
  const start = state.map.bases.player;
  if (!isExploredAt(state.fogAI, start.x, start.y)) return start;   // haven't looked at the start yet — go there
  return nearestUnexploredPoint(state.fogAI, from.x, from.y) || start;   // else search the map for a hidden CC
}

// The next unit to build: normally the next entry in the archetype's mix,
// but every COUNTER_EVERY-th unit it instead builds the hard counter to
// whatever the player fields most. Both draw from effectiveMix — the mix
// with entries this map can't pay for dropped (e.g. the Breacher on a world
// with no radioactives) — so the cycle never stalls on an unbuildable type,
// and a counter is only chosen when this map can actually build it.
export function pickNextUnitType(state, archetype) {
  const mix = effectiveMix(state, archetype);
  const built = state.ai.unitsBuilt || 0;
  if (built > 0 && built % COUNTER_EVERY === 0) {
    const counter = counterToPlayerArmy(state);
    if (counter && mix.includes(counter)) return counter;
  }
  return mix[built % mix.length];
}

// Whatever combat type the player currently fields the most of — among only
// the units the AI can actually SEE right now (its own fog) — mapped to its
// hard counter. No vision of the player's army means no counter-pick, so the
// AI has to scout or fight to earn that intel, the same as the player. Ties
// keep whichever type was seen first; there's no meaningfully "correct" pick
// between two equally common threats.
function counterToPlayerArmy(state) {
  const counts = {};
  for (const u of state.units.values()) {
    if (u.owner !== "player" || UNITS[u.type].role !== "combat") continue;
    if (!isVisibleAt(state.fogAI, u.x, u.y)) continue;   // can't counter what it hasn't seen
    counts[u.type] = (counts[u.type] || 0) + 1;
  }
  let best = null, bestCount = 0;
  for (const [type, count] of Object.entries(counts)) {
    if (count > bestCount) { bestCount = count; best = type; }
  }
  return best ? COUNTER_OF[best] : null;
}

// Keep one spare unit ranging across the contested middle so the AI earns its
// intel — uncovering hidden caches and spotting the player's forces — instead
// of knowing the map for free. Only lends a scout once the army can spare one;
// a box sweep of the centre laid down as plain-move waypoints (it reveals fog
// rather than diving into a fight), re-issued whenever the scout falls idle or
// dies. Runs before assignIdleWorkers so a scout is never re-tasked to gather.
export function updateScout(state, army, rangers, defending = false) {
  if (defending) return;   // base under attack — hold every unit home, don't lend a scout
  let scout;
  const ranger = (rangers && rangers.length) ? rangers[0] : null;
  if (ranger) {
    // Prefer a dedicated Ranger (Tactical builds one): it out-sees any fighter,
    // goes anywhere, and costs the army nothing. Leave it be while it's sweeping;
    // re-task only once it falls idle (or send it out the first time).
    if (ranger.order || (ranger.orderQueue && ranger.orderQueue.length)) return;
    scout = ranger;
  } else {
    // No Ranger: fall back to lending a combat unit, but only if one isn't already
    // out — don't pull a second fighter off the line.
    const current = state.ai.scoutId ? state.units.get(state.ai.scoutId) : null;
    if (current && (current.order || (current.orderQueue && current.orderQueue.length))) return;
    if (army.length < 4) { state.ai.scoutId = null; return; }   // need a genuine spare to lend
    scout = army.find(u => u.id !== state.ai.scoutId);
  }
  if (!scout || !canAct(state)) return;   // no spare, or no action budget to send one out yet
  spend(state);
  state.ai.scoutId = scout.id;
  const w = state.map.width, h = state.map.height;
  const home = { x: scout.x, y: scout.y };
  const pb = state.map.bases.player;
  issueMove([scout], w * 0.42, h * 0.22);
  issueMove([scout], w * 0.58, h * 0.22, true);
  issueMove([scout], w * 0.58, h * 0.78, true);
  issueMove([scout], w * 0.42, h * 0.78, true);
  // ...then swing toward the player's side to actually see the army it needs to
  // counter (a pure centre sweep can miss what's massing at the enemy base),
  // stopping short of diving into the base itself, before folding back home.
  issueMove([scout], home.x + (pb.x - home.x) * 0.6, home.y + (pb.y - home.y) * 0.6, true);
  issueMove([scout], home.x, home.y, true);   // and head home to fold back into the army
}
