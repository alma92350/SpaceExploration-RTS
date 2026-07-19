/* ============================================================
   Scripted AI opponent: keep workers on the nearest spendable node, keep
   population growing, put up a Barracks once it can afford one, then cycle
   through its archetype's unit mix (Skiff/Bastion/Lancer/Breacher — see
   entities.js for the rock-paper-scissors relationship) across every
   Barracks it owns, and throw its home army at the player's base in
   repeated waves, once each wave is big enough (or the game's dragged on
   long enough that it should commit anyway). Along the way it fortifies
   with Sentinel Turrets on the approach vector, expands to a second
   Command Center when its home ore runs thin, puts up a Refinery, and
   researches both upgrades — so the player isn't the only side that gets to
   use crystals/radioactives, expansions, or defenses.

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
   from state.aiArchetype (see engine/aiArchetypes.js), which is picked by
   which planet the match is on. This file just executes whatever profile it's
   handed; every Tier 4 field is read with a use-site default so a legacy
   profile that predates them still runs.
   ============================================================ */

"use strict";

import { queueProduction, researchUpgrade } from "./production.js";
import { issueBuild, issueAttackMove, issueMove } from "./commands.js";
import { findPlacement } from "./colliders.js";
import { BUILDINGS, UNITS, UPGRADES, canAfford } from "./entities.js";
import { supplyUsed, supplyCap } from "./supply.js";
import { isVisibleAt, isNodeDiscovered } from "./fog.js";
import { playerBuildings, playerUnits } from "./state.js";

const THINK_INTERVAL = 1.5;
const COUNTER_EVERY = 3;   // 1 in every 3 units built reacts to the player's army instead of following the mix
const APM_BURST_FRAC = 1 / 15;   // a busy AI can bank at most ~4 seconds' worth of unspent actions

// Derived once from each unit's bonusVs table (entities.js), rather than
// hardcoded here, so this stays correct automatically if the roster or
// its counter relationships ever change: COUNTER_OF['lancer'] === 'skiff'
// means Skiff is the type that holds bonus damage against Lancer.
const COUNTER_OF = Object.values(UNITS).reduce((map, def) => {
  if (def.bonusVs) for (const targetType of Object.keys(def.bonusVs)) map[targetType] = def.id;
  return map;
}, {});

const HOME_RADIUS = 420;          // nodes this close to an AI CC count as "home" economy
const CLAIM_RADIUS = 260;         // a cluster with any CC this close is already claimed
const CLUSTER_RADIUS = 160;       // nodes within this of an anchor sum into its cluster score
const EXPANSION_STANDOFF = 70;    // CC-to-anchor-node placement distance (26 CC radius + 16 node radius + clearance)
const BARRACKS_BUFFER = 150;      // bank kept when adding a barracks so the mix doesn't starve

// Every commodity that anything the AI builds actually costs — computed once.
// assignIdleWorkers prefers nodes of these types so a poor-economy world's AI
// (Glacius: ice/gas it can never spend) doesn't mine dead-end commodities.
const SPENDABLE = (() => {
  const coms = new Set();
  for (const d of [...Object.values(UNITS), ...Object.values(BUILDINGS), ...Object.values(UPGRADES)])
    for (const com of Object.keys(d.cost || {})) coms.add(com);
  return coms;
})();

export function runAI(state, dt) {
  accrueActionBudget(state, dt);   // every tick, so credits build up between think cycles
  state.aiThink = (state.aiThink || 0) - dt;
  if (state.aiThink > 0) return;
  state.aiThink = THINK_INTERVAL;

  const archetype = state.aiArchetype;
  const ai = state.players.ai;
  const workers = playerUnits(state, "ai").filter(u => u.type === "worker");
  const army = playerUnits(state, "ai").filter(u => UNITS[u.type].role === "combat");
  const buildings = playerBuildings(state, "ai");
  const cc = buildings.find(b => b.type === "command" && !b.constructing);
  const barracks = buildings.find(b => b.type === "barracks");
  const refinery = buildings.find(b => b.type === "refinery");
  const allBarracks = buildings.filter(b => b.type === "barracks");
  let oreReserve = 0;

  updateScout(state, army);   // before worker assignment, so a worker-turned-scout isn't re-tasked to gather
  assignIdleWorkers(state, workers);

  // EXPANSION: once home ore runs thin, plant a second Command Center on the
  // richest unclaimed cluster. Runs before every ore-spending block so it can
  // reserve the CC's cost (oreReserve) to bank toward it. The reserve pauses
  // only the lower-priority infrastructure spends (a second Barracks, the
  // Refinery) — never unit production, so the army keeps flowing while the AI
  // saves. Gating units too would starve the army indefinitely on an ore-poor
  // world, where income can't outrun a 400-ore bank before the last seam dries
  // and it never actually expands. At most one expansion in flight.
  const ccCost = BUILDINGS.command.cost.ore;
  const threshold = archetype.expandWhenNodesBelow || 0;
  if (threshold > 0 && cc && workers.length > 0
      && !buildings.some(b => b.type === "command" && b.constructing)) {
    const myCCs = buildings.filter(b => b.type === "command" && !b.constructing);
    if (homeOreFraction(state, myCCs) < threshold) {
      const anchor = bestExpansionCluster(state, myCCs);
      if (anchor) {
        oreReserve = ccCost;   // bank toward the CC by pausing infrastructure spend
        if (ai.resources.ore >= ccCost) {
          const toward = Math.atan2(cc.y - anchor.y, cc.x - anchor.x);   // place on the home side of the cluster
          const spot = findPlacement(state, "command",
            anchor.x + Math.cos(toward) * EXPANSION_STANDOFF,
            anchor.y + Math.sin(toward) * EXPANSION_STANDOFF);
          if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "command", spot.x, spot.y)) {
            spend(state);
            oreReserve = 0;
          }
        }
      }
    }
  }

  if (cc && workers.length < archetype.workerTarget && cc.queue.length === 0 && canAct(state)) {
    if (queueProduction(state, cc.id, "worker")) spend(state);
  }

  // Near the cap (or over it after losing a Habitat) with none already
  // going up: put down a Habitat by the CC, or production stalls forever.
  // The `>= cap - 2` fires before a 2-supply unit can wedge the mix cycle
  // (the AI retries the same mix entry until it succeeds), and the same
  // condition covers the destroyed-Habitat over-cap case.
  const used = supplyUsed(state, "ai"), cap = supplyCap(state, "ai");
  const habitatConstructing = buildings.some(b => b.type === "habitat" && b.constructing);
  if (cc && workers.length > 0 && used >= cap - 2 && !habitatConstructing
      && canAfford(ai.resources, BUILDINGS.habitat.cost)) {
    const spot = findPlacement(state, "habitat", cc.x, cc.y + 90);
    if (spot && canAct(state) && issueBuild(state, workers[0].id, "habitat", spot.x, spot.y)) spend(state);
  }

  // First Barracks. Build spots are fixed offsets from the CC, so anything
  // already sitting there (a node, an earlier building) would make issueBuild
  // reject the same spot every think cycle and stall the order forever —
  // findPlacement slides the request to the nearest valid ground instead.
  if (!barracks && cc && workers.length > 0 && canAfford(ai.resources, BUILDINGS.barracks.cost)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y - 90);
    if (spot && canAct(state) && issueBuild(state, workers[0].id, "barracks", spot.x, spot.y)) spend(state);
  }

  // One shared production cycle across every completed Barracks: consecutive
  // barracks pick up consecutive mix entries, so two of them drain the same
  // sequence twice as fast rather than each running its own. Map insertion
  // order keeps the pick deterministic. pickNextUnitType layers the
  // counter-pick on top of the archetype mix. Unit production is deliberately
  // NOT gated by the expansion reserve — the army keeps growing while the AI
  // banks for a CC out of its infrastructure budget, never freezing on a poor
  // world.
  for (const b of allBarracks) {
    if (b.constructing || b.queue.length > 0) continue;
    if (!canAct(state)) break;   // out of action budget this cycle — no more units for now
    const nextType = pickNextUnitType(state, archetype);
    if (!canAfford(ai.resources, UNITS[nextType].cost)) continue;
    if (queueProduction(state, b.id, nextType)) {
      spend(state);
      state.aiUnitsBuilt = (state.aiUnitsBuilt || 0) + 1;
    }
  }

  // Sentinel Turrets straddling the approach lane between the CC and mid-map,
  // alternating sides and stepping outward as they multiply. Crystals-funded,
  // so it's outside the ore expansion reserve; inert on crystal-less worlds
  // (canAfford simply never passes there — accepted flavor).
  if (cc && barracks && workers.length > 0) {
    const turrets = buildings.filter(b => b.type === "turret");
    if (turrets.length < (archetype.turretCount || 0) && canAfford(ai.resources, BUILDINGS.turret.cost)) {
      const mx = state.map.width / 2, my = state.map.height / 2;
      const len = Math.hypot(mx - cc.x, my - cc.y) || 1;
      const dx = (mx - cc.x) / len, dy = (my - cc.y) / len;   // the approach vector
      const i = turrets.length, side = i % 2 === 0 ? 1 : -1;
      const spot = findPlacement(state, "turret",
        cc.x + dx * (140 + 80 * i) - dy * 30 * side,
        cc.y + dy * (140 + 80 * i) + dx * 30 * side);
      if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "turret", spot.x, spot.y)) spend(state);
    }
  }

  // A second Barracks once the first is up and the mix has a comfortable
  // buffer on top of any expansion reserve (allBarracks counts constructing
  // ones, so it never founds a third while the second is still going up).
  if (barracks && !barracks.constructing && cc && workers.length > 0
      && allBarracks.length < (archetype.maxBarracks || 1)
      && canAffordKeeping(ai.resources, BUILDINGS.barracks.cost, oreReserve + BARRACKS_BUFFER)) {
    const spot = findPlacement(state, "barracks", cc.x + 90, cc.y + 90);
    if (spot && canAct(state) && issueBuild(state, pickBuilder(workers, spot.x, spot.y).id, "barracks", spot.x, spot.y)) spend(state);
  }

  // Refinery — reserve-aware, and cc-guarded: cc is the completed-only find,
  // so once the AI can expand, a home CC destroyed mid-expansion leaves cc
  // undefined; without the guard cc.x below would throw.
  if (!refinery && barracks && !barracks.constructing && cc && workers.length > 0
      && canAffordKeeping(ai.resources, BUILDINGS.refinery.cost, oreReserve)) {
    const spot = findPlacement(state, "refinery", cc.x - 90, cc.y - 90);
    if (spot && canAct(state) && issueBuild(state, workers[0].id, "refinery", spot.x, spot.y)) spend(state);
  }

  if (refinery && !refinery.constructing && canAct(state)) {
    for (const upgradeId of Object.keys(UPGRADES)) {
      if (ai.upgrades[upgradeId]) continue;
      if (researchUpgrade(state, refinery.id, upgradeId)) { spend(state); break; }   // one purchase per think cycle is plenty
    }
  }

  // "Home" army is whatever hasn't already been sent off to attack — a
  // freshly produced or still-idle unit has order null/'move' (its walk
  // to the rally point), while a committed one is mid attack-move (see
  // combat.js: an attack-move order survives fighting along the way, and
  // only clears once the unit truly arrives with nothing left to fight).
  // Filtering on that instead of a one-shot flag means each new batch of
  // units automatically forms the next wave once the threshold is met
  // again, so the AI keeps attacking instead of throwing exactly one
  // army at the player for the whole match.
  // The lone scout is kept out of the wave (it's off revealing the map on a
  // 'move' order, which would otherwise read as "home army").
  const homeArmy = army.filter(u => u.id !== state.aiScoutId && (!u.order || u.order.type === "move"));
  const nextAttackAt = state.aiNextAttackAt ?? archetype.attackTimeout;
  const readyToAttack = homeArmy.length > 0 && (homeArmy.length >= archetype.armyAttackSize || state.time >= nextAttackAt);
  if (readyToAttack) {
    const target = state.map.bases.player;
    issueAttackMove(homeArmy, target.x, target.y);
    state.aiNextAttackAt = state.time + archetype.attackTimeout;
  }
}

// The next unit to build: normally the next entry in the archetype's mix,
// but every COUNTER_EVERY-th unit it instead builds the hard counter to
// whatever the player fields most. Both draw from effectiveMix — the mix
// with entries this map can't pay for dropped (e.g. the Breacher on a world
// with no radioactives) — so the cycle never stalls on an unbuildable type,
// and a counter is only chosen when this map can actually build it.
function pickNextUnitType(state, archetype) {
  const mix = effectiveMix(state, archetype);
  const built = state.aiUnitsBuilt || 0;
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

/* ---------- action budget (the configurable AI speed / APM) ---------- */

// The AI's "speed" is an actions-per-minute allowance, set from the splash
// screen (state.aiApm). Every command it issues — produce, build, expand,
// research, send the scout — costs one action; the attack commit is the one
// exemption, so a slow AI still throws whatever it has at you and the game
// always resolves. Credits accrue continuously and cap at a few seconds' worth,
// so a busy AI can't hoard a giant burst. When aiApm is null (the default, and
// every headless test) the AI is unthrottled — behaviour is exactly as before.
function accrueActionBudget(state, dt) {
  if (state.aiApm == null) return;
  const cap = Math.max(2, state.aiApm * APM_BURST_FRAC);
  state.aiActionBudget = Math.min((state.aiActionBudget || 0) + (state.aiApm / 60) * dt, cap);
}

function canAct(state) {
  return state.aiApm == null || (state.aiActionBudget || 0) >= 1;
}

function spend(state) {
  if (state.aiApm != null) state.aiActionBudget -= 1;
}

// Keep one spare unit ranging across the contested middle so the AI earns its
// intel — uncovering hidden caches and spotting the player's forces — instead
// of knowing the map for free. Only lends a scout once the army can spare one;
// a box sweep of the centre laid down as plain-move waypoints (it reveals fog
// rather than diving into a fight), re-issued whenever the scout falls idle or
// dies. Runs before assignIdleWorkers so a scout is never re-tasked to gather.
function updateScout(state, army) {
  const current = state.aiScoutId ? state.units.get(state.aiScoutId) : null;
  if (current && (current.order || (current.orderQueue && current.orderQueue.length))) return;   // still sweeping
  if (army.length < 4) { state.aiScoutId = null; return; }   // need a genuine spare to lend
  const scout = army.find(u => u.id !== state.aiScoutId);
  if (!scout || !canAct(state)) return;   // no spare, or no action budget to send one out yet
  spend(state);
  state.aiScoutId = scout.id;
  const w = state.map.width, h = state.map.height;
  issueMove([scout], w * 0.42, h * 0.22);
  issueMove([scout], w * 0.58, h * 0.22, true);
  issueMove([scout], w * 0.58, h * 0.78, true);
  issueMove([scout], w * 0.42, h * 0.78, true);
  issueMove([scout], scout.x, scout.y, true);   // and head home to fold back into the army
}

function assignIdleWorkers(state, workers) {
  // Only nodes the AI actually knows about: charted surface deposits (always)
  // plus any hidden cache it has scouted. It can't send workers to a cache it
  // hasn't discovered any more than the player can.
  const live = state.map.nodes.filter(n => n.amount > 0 && isNodeDiscovered(state.fogAI, n));
  if (!live.length) return;
  const oreLive = live.filter(n => n.com === "ore");
  const otherLive = live.filter(n => n.com !== "ore" && SPENDABLE.has(n.com));
  const nodeById = new Map(state.map.nodes.map(n => [n.id, n]));
  let secondaryMiners = 0;
  for (const w of workers) {
    const n = w.order && w.order.type === "gather" ? nodeById.get(w.order.nodeId) : null;
    if (n && n.com !== "ore" && SPENDABLE.has(n.com)) secondaryMiners++;
  }
  // Crystals/radioactives buy only optional extras (a couple of turrets, the
  // one-time upgrades, the occasional Breacher), so a small trickle funds them
  // — everyone else stays on ore, the currency the whole army and every
  // building actually run on. A flat "half on ore" split would over-divert on
  // an ore-rich world and under-fund ore on an ore-poor one; capping the
  // secondary crew keeps ore primary everywhere while still reaching the
  // extras. On a crystal-heavy map (Helix) this is what stops workers piling
  // onto crystals and starving the ore the army needs.
  const secondaryCap = Math.min(2, Math.floor(workers.length / 3));

  workers.forEach(w => {
    if (w.order) return;
    let pool;
    if (otherLive.length && oreLive.length && secondaryMiners < secondaryCap) {
      pool = otherLive; secondaryMiners++;   // fund the extras with a small crew...
    } else if (oreLive.length) {
      pool = oreLive;                         // ...but keep the bulk of workers on ore
    } else {
      pool = otherLive.length ? otherLive : live;   // ore's gone — take spendable, else any live node
    }
    let best = null, bestD = Infinity;
    for (const n of pool) {
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    if (best) w.order = { type: "gather", nodeId: best.id };
  });
}

// Fraction of home ore still in the ground: remaining/max summed over every
// ore node within HOME_RADIUS of one of this AI's Command Centers. No home ore
// at all reads as fully depleted — which is exactly what should trigger the
// first expansion the moment the starting seam runs dry.
function homeOreFraction(state, ccs) {
  let amt = 0, max = 0;
  for (const n of state.map.nodes) {
    if (n.com !== "ore") continue;
    if (!ccs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= HOME_RADIUS)) continue;
    amt += n.amount; max += n.max;
  }
  return max > 0 ? amt / max : 0;
}

// The ore node worth expanding to: richest surrounding cluster of live nodes,
// lightly penalized by distance from home so the AI grabs its own side first
// and only reaches across the map once the near ore is claimed or dry. Only
// nodes the AI has discovered count (surface ore always, hidden ore caches
// once scouted) — so on a map where the near ore is spent, the AI has to send
// its scout out to find somewhere to expand, just like the player. Skips
// anchors inside CLAIM_RADIUS of any CC (either owner, incl. constructing).
// Returns null when nothing known is available — which keeps the reserve from
// ever engaging in a no-room deadlock.
function bestExpansionCluster(state, myCCs) {
  const allCCs = [...state.buildings.values()].filter(b => b.type === "command");
  let best = null, bestScore = -Infinity;
  for (const n of state.map.nodes) {
    if (n.com !== "ore" || n.amount <= 0) continue;                                 // anchor on live ore
    if (!isNodeDiscovered(state.fogAI, n)) continue;                                // ...that the AI actually knows about
    if (allCCs.some(c => Math.hypot(c.x - n.x, c.y - n.y) <= CLAIM_RADIUS)) continue;
    let cluster = 0;
    for (const m of state.map.nodes)
      if (m.amount > 0 && isNodeDiscovered(state.fogAI, m) && Math.hypot(m.x - n.x, m.y - n.y) <= CLUSTER_RADIUS) cluster += m.amount;
    const dHome = Math.min(...myCCs.map(c => Math.hypot(c.x - n.x, c.y - n.y)));
    const score = cluster - 0.2 * dHome;   // richness first; keeps it on its own side unless dry
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return best;
}

// canAfford, but treating `oreReserve` ore as untouchable — used to bank for
// an expansion Command Center without letting the unit mix or a second
// barracks spend the ore out from under it.
function canAffordKeeping(resources, cost, oreReserve) {
  return Object.entries(cost).every(([com, qty]) =>
    (resources[com] || 0) - (com === "ore" ? oreReserve : 0) >= qty);
}

// The archetype's unit mix with entries this map can never pay for dropped —
// a cost commodity no SURFACE deposit produces (Vesper's surface has no
// radioactives, so its Breacher entry is skipped, leaving today's exact
// three-unit cycle). Hidden caches are deliberately excluded: they can hold a
// commodity the surface lacks, but they're far, contested, and may never be
// mined, so planning the whole cycle around one would just re-stall the mix on
// a unit the AI has no steady income for. Surface EXISTENCE, not remaining
// amount, is checked, so the surviving cycle is constant for the whole match
// (nodes drain, they never vanish) and the sequence stays deterministic. Falls
// back to plain Skiffs if the filter empties the mix entirely.
function effectiveMix(state, archetype) {
  const mix = (archetype.unitMix || []).filter(t =>
    UNITS[t]
    && BUILDINGS.barracks.produces?.includes(t)
    && Object.keys(UNITS[t].cost).every(com => state.map.nodes.some(n => n.com === com && !n.hidden)));
  return mix.length ? mix : ["skiff"];
}

// Nearest free worker to (x, y) to found a building, skipping any already
// mid-build so an in-progress site keeps its founder. Falls back to
// workers[0] — buildings self-construct at rate 1 even with nobody on-site,
// so a slightly-worse builder pick is never a stall.
function pickBuilder(workers, x, y) {
  let best = workers[0], bestD = Infinity;
  for (const w of workers) {
    if (w.order && w.order.type === "build") continue;   // don't churn an assigned builder
    const d = Math.hypot(w.x - x, w.y - y);
    if (d < bestD) { bestD = d; best = w; }
  }
  return best;
}
