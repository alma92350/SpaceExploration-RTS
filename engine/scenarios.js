/* ============================================================
   Scenario / mission mode — a real-time layer over the skirmish engine that
   swaps the "raze the enemy Command Center" objective for a scripted mission.
   This file hosts the CONVOY ESCORT scenario: a convoy of defenceless freighters
   travels a multi-leg route across the map, docking at stations between legs;
   the player controls a small escort fleet and must keep the freighters alive
   through pirate raids (spawned per leg by that leg's risk) before a global
   mission clock runs out. Repairing at a station costs from a mission budget,
   and the score rewards freighters delivered, legs survived, risk faced, and
   the budget left unspent.

   Determinism: all randomness (pirate counts, spawn positions, compositions)
   flows through a seeded RNG stored on the scenario, so the same seed replays
   the same mission — same guarantee as the skirmish sim. The tick pump calls
   updateScenario() in place of runAI() when state.scenario is set (see sim.js);
   the skirmish path is untouched.
   ============================================================ */

"use strict";

import { createGameState, makeUnit } from "./state.js";
import { mulberry32 } from "./rng.js";
import { updateFog } from "./fog.js";

/* ---------- tuning ---------- */
const PREP_TIME = 12;          // seconds to position escorts before the convoy departs
const STATION_RADIUS = 90;     // a freighter within this of a station counts as arrived / docked
const FIRST_SPAWN_DELAY = 5;   // seconds into a leg before its first pirate wave
const SPAWN_INTERVAL = 6;      // seconds between waves within a leg
const PIRATES_PER_RISK = 5;    // a leg of risk r spawns ~r*this raiders across its waves
const STEER_INTERVAL = 1.5;    // how often pirates re-aim at the lead freighter
const REPAIR_COST_PER_HP = 0.4;// credits per hit point restored at a station

const SCORE = { perFreighter: 300, perLeg: 120, perRisk: 220, timeDivisor: 8 };

// Easy/Medium/Hard tune the escort you're given, the per-leg risk, the clock and
// the repair budget. legRisk length is the number of legs (route has legRisk+1
// stations, start..destination).
export const ESCORT_DIFFICULTY = {
  easy:   { escorts: { skiff: 3, bastion: 1, mender: 1 }, legRisk: [0.3, 0.5, 0.7], timeLimit: 320, budget: 520, dockTime: 16 },
  medium: { escorts: { skiff: 2, bastion: 1, mender: 1 }, legRisk: [0.4, 0.7, 1.0], timeLimit: 280, budget: 420, dockTime: 14 },
  hard:   { escorts: { skiff: 2, lancer: 1 },             legRisk: [0.6, 1.0, 1.4], timeLimit: 240, budget: 300, dockTime: 12 },
};

/* ---------- setup ---------- */

// Build a Convoy Escort game state on `planetId`. Reuses createGameState for the
// map / fog / players scaffold, then strips the skirmish seeding (no CCs, no
// economy) and lays out the route, the freighters, and the player's escort.
export function setupEscort({ planetId = "ferros", seed = 1, difficulty = "medium" } = {}) {
  const diff = ESCORT_DIFFICULTY[difficulty] || ESCORT_DIFFICULTY.medium;
  const state = createGameState({ planetId, seed, rng: mulberry32(seed >>> 0) });
  state.units.clear();
  state.buildings.clear();

  const { width, height } = state.map;
  const y = height * 0.5;
  // Stations evenly spaced left→right; legs = the gaps between them.
  const n = diff.legRisk.length;                 // number of legs
  const route = [];
  for (let i = 0; i <= n; i++) route.push({ x: width * (0.08 + (0.86 * i) / n), y });

  const start = route[0];
  // Four freighters clustered at the start station.
  for (let i = 0; i < 4; i++) {
    const f = makeUnit("freighter", "player", start.x + (i % 2) * 26 - 13, start.y + Math.floor(i / 2) * 30 - 15);
    state.units.set(f.id, f);
  }
  // The escort fleet, just behind the freighters.
  let ei = 0;
  for (const [type, count] of Object.entries(diff.escorts)) {
    for (let k = 0; k < count; k++) {
      const u = makeUnit(type, "player", start.x - 55 - (ei % 3) * 22, start.y + (ei - 2) * 26);
      state.units.set(u.id, u);
      ei++;
    }
  }

  state.scenario = {
    type: "escort",
    difficulty,
    phase: "prep",                 // prep → travel ⇄ docked → done
    phaseTimer: PREP_TIME,
    route,
    legRisk: diff.legRisk,
    legIndex: 0,                   // leg currently being (or about to be) travelled
    timeLimit: diff.timeLimit,
    dockTime: diff.dockTime,
    budget: diff.budget,
    freightersTotal: 4,
    delivered: 0,
    legsDone: 0,
    riskFaced: 0,
    score: 0,
    outcome: null,                 // null | "win" | "loss"
    repairedThisStop: false,
    rng: mulberry32((seed ^ 0x9e3779b9) >>> 0),   // scenario RNG, decoupled from map-gen draws
    spawn: { remaining: 0, timer: 0 },
    steerTimer: 0,
    banner: "Prep — position your escorts, then the convoy departs.",
  };

  updateFog(state, state.fog, "player");
  updateFog(state, state.fogAI, "ai");
  return state;
}

/* ---------- per-tick brain (called in place of runAI) ---------- */

export function updateScenario(state, dt) {
  const sc = state.scenario;
  if (!sc || sc.outcome) return;

  const freighters = liveFreighters(state);

  // Terminal checks first — read live entity counts (so a freighter lost to the
  // previous tick's combat is seen here).
  if (freighters.length === 0 && sc.delivered === 0) { endScenario(state, "loss", "The convoy was wiped out."); return; }
  if (state.time >= sc.timeLimit && sc.phase !== "done") {
    endScenario(state, sc.delivered > 0 ? "win" : "loss",
      sc.delivered > 0 ? "Out of time — the mission ends here." : "Out of time — the convoy never made it.");
    return;
  }

  switch (sc.phase) {
    case "prep":
      sc.phaseTimer -= dt;
      if (sc.phaseTimer <= 0) startLeg(state, 0);
      break;

    case "travel": {
      const target = sc.route[sc.legIndex + 1];
      // Keep the freighters trundling toward the leg's station.
      for (const f of freighters) {
        const o = f.order;
        if (!o || o.type !== "move" || o.x !== target.x || o.y !== target.y) f.order = { type: "move", x: target.x, y: target.y };
      }
      updatePirateSpawns(state, dt);
      steerPirates(state, freighters, dt);

      // Arrived when every surviving freighter is at the station.
      if (freighters.every(f => Math.hypot(f.x - target.x, f.y - target.y) <= STATION_RADIUS)) {
        sc.legsDone += 1;
        sc.riskFaced += sc.legRisk[sc.legIndex] || 0;
        if (sc.legIndex + 1 >= sc.route.length - 1) {
          deliverConvoy(state, freighters);
        } else {
          sc.legIndex += 1;
          sc.phase = "docked";
          sc.phaseTimer = sc.dockTime;
          sc.repairedThisStop = false;
          sc.banner = `Docked at station ${sc.legIndex} — Repair, or Depart when ready.`;
        }
      }
      break;
    }

    case "docked":
      for (const f of freighters) f.order = null;   // hold at the station
      sc.phaseTimer -= dt;
      if (sc.phaseTimer <= 0) startLeg(state, sc.legIndex);
      break;
  }
}

// Begin (or resume) travelling leg `i`: aim the freighters at route[i+1] and roll
// this leg's pirate budget from its risk.
function startLeg(state, i) {
  const sc = state.scenario;
  sc.legIndex = i;
  sc.phase = "travel";
  const risk = sc.legRisk[i] || 0;
  sc.spawn = { remaining: Math.round(risk * PIRATES_PER_RISK), timer: FIRST_SPAWN_DELAY };
  const legNo = i + 1, legs = sc.route.length - 1;
  sc.banner = `Leg ${legNo}/${legs} — piracy risk ${riskLabel(risk)}. Protect the freighters.`;
}

function deliverConvoy(state, freighters) {
  const sc = state.scenario;
  sc.delivered = freighters.length;
  for (const f of freighters) state.units.delete(f.id);   // they dock safe at the destination
  endScenario(state, "win", `Convoy delivered — ${sc.delivered}/${sc.freightersTotal} freighters made it.`);
}

function endScenario(state, outcome, banner) {
  const sc = state.scenario;
  sc.outcome = outcome;
  sc.banner = banner;
  sc.timeUsed = state.time;
  sc.score = computeScore(sc);
  sc.phase = "done";
  state.over = true;
  state.winner = outcome === "win" ? "player" : "ai";
}

function computeScore(sc) {
  const s = sc.delivered * SCORE.perFreighter
    + sc.legsDone * SCORE.perLeg
    + sc.riskFaced * SCORE.perRisk
    + Math.max(0, Math.round(sc.budget))
    - Math.floor((sc.timeUsed || 0) / SCORE.timeDivisor);
  return Math.max(0, Math.round(s));
}

/* ---------- pirates ---------- */

function updatePirateSpawns(state, dt) {
  const sc = state.scenario;
  const sp = sc.spawn;
  if (sp.remaining <= 0) return;
  sp.timer -= dt;
  if (sp.timer > 0) return;
  sp.timer = SPAWN_INTERVAL;

  const risk = sc.legRisk[sc.legIndex] || 0.5;
  const waveSize = Math.min(sp.remaining, 2 + (sc.rng() < risk - 0.5 ? 1 : 0));
  const convoy = centroid(liveFreighters(state)) || sc.route[sc.legIndex];
  const from = sc.route[sc.legIndex], to = sc.route[sc.legIndex + 1];
  const hx = to.x - from.x, hy = to.y - from.y;
  const hlen = Math.hypot(hx, hy) || 1;
  const dirx = hx / hlen, diry = hy / hlen;          // convoy heading
  const px = -diry, py = dirx;                       // perpendicular (a flank)

  for (let k = 0; k < waveSize; k++) {
    const ahead = 220 + sc.rng() * 220;
    const flank = (sc.rng() < 0.5 ? 1 : -1) * (110 + sc.rng() * 180);
    let x = convoy.x + dirx * ahead + px * flank;
    let y = convoy.y + diry * ahead + py * flank;
    x = Math.max(20, Math.min(state.map.width - 20, x));
    y = Math.max(20, Math.min(state.map.height - 20, y));
    const type = pirateType(risk, sc.rng);
    const u = makeUnit(type, "ai", x, y);
    u.order = { type: "attack-move", x: convoy.x, y: convoy.y };
    state.units.set(u.id, u);
  }
  sp.remaining -= waveSize;
}

function pirateType(risk, rng) {
  const r = rng();
  if (risk >= 1.0 && r < 0.2) return "lancer";
  if (r < 0.28) return "bastion";
  return "skiff";
}

// Every so often, re-aim each pirate at the freighter nearest the leg's station
// (the "lead" freighter) so they keep pressing the convoy as it moves — combat.js
// handles engaging the escorts they meet on the way.
function steerPirates(state, freighters, dt) {
  const sc = state.scenario;
  sc.steerTimer -= dt;
  if (sc.steerTimer > 0 || freighters.length === 0) return;
  sc.steerTimer = STEER_INTERVAL;
  const target = sc.route[sc.legIndex + 1];
  let lead = freighters[0], bestD = Infinity;
  for (const f of freighters) {
    const d = Math.hypot(f.x - target.x, f.y - target.y);
    if (d < bestD) { bestD = d; lead = f; }
  }
  for (const u of state.units.values()) {
    if (u.owner !== "ai") continue;
    u.order = { type: "attack-move", x: lead.x, y: lead.y };
  }
}

/* ---------- player actions (wired to the HUD) ---------- */

// Credits to fully repair every surviving player ship right now.
export function repairCost(state) {
  let missing = 0;
  for (const u of playerShips(state)) missing += Math.max(0, u.maxHp - u.hp);
  return Math.ceil(missing * REPAIR_COST_PER_HP);
}

// Repair the whole convoy + escort to full, once per stop, if the budget covers it.
export function repairConvoy(state) {
  const sc = state.scenario;
  if (!sc || sc.phase !== "docked" || sc.repairedThisStop) return false;
  const cost = repairCost(state);
  if (cost <= 0 || cost > sc.budget) return false;
  for (const u of playerShips(state)) u.hp = u.maxHp;
  sc.budget -= cost;
  sc.repairedThisStop = true;
  return true;
}

// Skip the rest of the dock timer and set off on the next leg.
export function departNow(state) {
  const sc = state.scenario;
  if (sc && sc.phase === "docked") sc.phaseTimer = 0;
}

/* ---------- helpers ---------- */

function liveFreighters(state) {
  const out = [];
  for (const u of state.units.values()) if (u.owner === "player" && u.type === "freighter") out.push(u);
  return out;
}
function playerShips(state) {
  const out = [];
  for (const u of state.units.values()) if (u.owner === "player") out.push(u);
  return out;
}
function centroid(list) {
  if (!list.length) return null;
  let x = 0, y = 0;
  for (const u of list) { x += u.x; y += u.y; }
  return { x: x / list.length, y: y / list.length };
}
function riskLabel(r) {
  return r < 0.45 ? "low" : r < 0.85 ? "moderate" : r < 1.2 ? "high" : "extreme";
}
