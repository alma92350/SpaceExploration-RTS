"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { hasColonyShip } from "./colony.js";

// A stalemate breaker: if neither side has lost its last Command Center after
// this many seconds, the match is decided on score instead of running forever.
// It sits far beyond a normal game (which resolves in a few minutes), so it
// only ever fires on a genuine turtle-vs-turtle deadlock — the point is that
// there IS a terminal state, so a defensive stall can't stretch to infinity.
// state.matchTimeLimit can override it (e.g. a future "quick match" option).
export const DEFAULT_MATCH_TIME_LIMIT = 2400;   // 40 minutes of sim time

// Skirmish ends the moment a side loses its Command Center; a mutual loss on
// the same tick, or the time limit, is settled by score.
export function checkWinCondition(state) {
  if (state.over) return;
  const playerHasCC = hasCommandCenter(state, "player");
  const aiHasCC = hasCommandCenter(state, "ai");

  if (!playerHasCC && !aiHasCC) { finish(state, scoreLeader(state)); return; }
  if (!playerHasCC) { finish(state, "ai"); return; }
  if (!aiHasCC) { finish(state, "player"); return; }

  const limit = state.matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT;
  if (state.time >= limit) finish(state, scoreLeader(state));
}

// Odyssey (open-world) terminal check: there is no victory by conquest and no
// time limit — the sandbox only ends when the player loses their single
// Command Center (their capital seat). Razing a neighbour's CC never ends the
// game; that world simply keeps evolving. Used in place of checkWinCondition
// for an endless state (see sim.js).
export function checkEndlessLoss(state) {
  if (state.over) return;
  // A foothold is a Command Center OR an undeployed colony ship — so the CC-less
  // Odyssey start (engine/state.js seedPlayer) isn't an instant tick-1 defeat, and a
  // player razed to a lone colony ship can still re-found. Only the loss of BOTH ends
  // it. hasColonyShip is always false in a skirmish, so this path is Odyssey-only.
  if (!hasCommandCenter(state, "player") && !hasColonyShip(state, "player")) finish(state, "ai");
}

// Odyssey's terminal WIN check — the twin of checkEndlessLoss. The player wins the
// galaxy when an Antimatter Gate they own finishes charging (engine/wonder.js): the
// endless sandbox's only victory, a megaproject you build and defend. Runs on the
// active seat (sim.js) and, for a Gate left charging on a colony, via
// galaxy.js checkGalaxyWin.
export function checkEndlessWin(state) {
  if (state.over) return;
  for (const b of state.buildings.values())
    if (b.owner === "player" && BUILDINGS[b.type]?.wonder && (b.charge || 0) >= 1) { finish(state, "player"); return; }
}

function finish(state, winner) {
  state.over = true;
  state.winner = winner;
}

function hasCommandCenter(state, owner) {
  for (const b of state.buildings.values()) {
    if (b.owner === owner && b.type === "command") return true;
  }
  return false;
}

// A side's "strength" for the tiebreak, weighted toward what's ON THE BOARD
// rather than what's hoarded in the bank. Committed value — the built cost of
// every unit and building — counts at full; unspent resources count at only
// BANK_WEIGHT, so a turtle that reaches the time limit sitting on a huge
// stockpile can't out-score an opponent who actually spent it on army and
// expansion. Combat units count a little extra (COMBAT_BONUS) so the side that
// pressed the fight edges out one that merely out-massed on workers and static
// defense. Still simple and symmetric. Exported so a HUD could show the score.
const BANK_WEIGHT = 0.25;      // idle resources are worth far less than committed ones
const COMBAT_BONUS = 1.35;     // an army in the field beats an equal-cost economy at the tiebreak
export function playerScore(state, owner) {
  let score = 0;
  const res = state.players[owner].resources;
  for (const com of Object.keys(res)) score += (res[com] || 0) * BANK_WEIGHT;
  for (const u of state.units.values()) {
    if (u.owner !== owner) continue;
    const def = UNITS[u.type];
    score += costValue(def?.cost) * (def?.role === "combat" ? COMBAT_BONUS : 1);
  }
  for (const b of state.buildings.values()) {
    if (b.owner === owner) score += costValue(BUILDINGS[b.type]?.cost);
  }
  return score;
}

function costValue(cost) {
  if (!cost) return 0;
  let v = 0;
  for (const com of Object.keys(cost)) v += cost[com];
  return v;
}

// Higher score wins; an exact tie goes to the player (a defender edge, and it
// keeps state.winner one of "player"/"ai" as the rest of the game expects).
function scoreLeader(state) {
  return playerScore(state, "ai") > playerScore(state, "player") ? "ai" : "player";
}
