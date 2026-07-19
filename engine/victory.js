"use strict";

import { UNITS, BUILDINGS } from "./entities.js";

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
