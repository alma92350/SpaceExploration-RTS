"use strict";

// Skirmish ends the moment a side loses its Command Center.
export function checkWinCondition(state) {
  if (state.over) return;
  const playerHasCC = hasCommandCenter(state, "player");
  const aiHasCC = hasCommandCenter(state, "ai");
  if (!playerHasCC) { state.over = true; state.winner = "ai"; }
  else if (!aiHasCC) { state.over = true; state.winner = "player"; }
}

function hasCommandCenter(state, owner) {
  for (const b of state.buildings.values()) {
    if (b.owner === owner && b.type === "command") return true;
  }
  return false;
}
