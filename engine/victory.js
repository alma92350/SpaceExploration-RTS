"use strict";

import { UNITS, BUILDINGS } from "./entities.js";
import { hasColonyShip } from "./colony.js";

// The world's side ids, in canonical order. createGameState / rehydratePlanet set
// state.owners; a few narrow unit-test states are hand-built without it, so fall
// back to the classic pair. Ordering matters — it's the tie-break precedence in
// scoreLeader (first side listed wins an exact score tie: the defender's edge).
function ownersOf(state) { return state.owners || ["player", "ai"]; }

// A stalemate breaker: if neither side has lost its last Command Center after
// this many seconds, the match is decided on score instead of running forever.
// It sits far beyond a normal game (which resolves in a few minutes), so it
// only ever fires on a genuine turtle-vs-turtle deadlock — the point is that
// there IS a terminal state, so a defensive stall can't stretch to infinity.
// state.matchTimeLimit can override it (e.g. a future "quick match" option).
export const DEFAULT_MATCH_TIME_LIMIT = 2400;   // 40 minutes of sim time

// Skirmish ends the moment only one side still holds a Command Center — that
// side wins. A mutual loss on the same tick (no side left standing), or the
// time limit with several still standing, is settled by score. Last-side-
// standing over state.owners: for the classic player-vs-ai pair this is exactly
// the old three-branch check (player-only alive ⇒ player wins, ai-only ⇒ ai,
// neither ⇒ score), byte-identical, and it already reads for N sides.
export function checkWinCondition(state) {
  if (state.over) return;
  const standing = ownersOf(state).filter(o => hasCommandCenter(state, o));

  if (standing.length === 0) { finish(state, scoreLeader(state)); return; }   // mutual wipe → score
  if (standing.length === 1) { finish(state, standing[0]); return; }          // last side standing wins

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
  // In a galaxy there is NO defeat at all — the Odyssey plays forever unless you surrender, and a
  // total wipeout sends a relief colony ship instead (engine/galaxy.js checkGalaxyRescue). So the
  // per-world check must NOT fire here; it still governs a standalone endless state (tests). A
  // foothold is a Command Center OR an undeployed colony ship, so the CC-less Odyssey start isn't
  // a tick-1 defeat and a lone ship can still re-found.
  if (state.inGalaxy) return;
  if (!hasCommandCenter(state, "player") && !hasColonyShip(state, "player")) finish(state, "ai");
}

// Standalone-endless WIN check — an Antimatter Gate finishing at full charge. In an actual
// Odyssey GALAXY there are NO wins (the play-forever sandbox): a completed Gate is a
// milestone firework, not a victory (engine/galaxy.js checkGalaxyProgress), so this is
// suppressed for galaxy states (state.inGalaxy) and only ever resolves a standalone endless
// state — a test fixture, and the twin of checkEndlessLoss. Skirmishes use checkWinCondition.
export function checkEndlessWin(state) {
  if (state.over || state.inGalaxy) return;
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

// Highest score wins; an exact tie goes to the FIRST side listed in state.owners
// (a defender edge — the human "player" is always first, so state.winner still
// resolves to "player" on a dead heat, as the rest of the game expects). A strict
// `>` keeps the first-seen leader on a tie, so for the player-vs-ai pair this is
// exactly `ai > player ? "ai" : "player"` — byte-identical.
function scoreLeader(state) {
  let best = null, bestScore = -Infinity;
  for (const o of ownersOf(state)) {
    const s = playerScore(state, o);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return best;
}
