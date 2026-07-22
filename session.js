/* ============================================================
   The live game session — the single mutable holder the UI modules read
   and boot.js reassigns. Before the split these were module-level `let`
   bindings in main.js that every function closed over; now they live on one
   shared object so hud / boot / save / the top-level listeners all see the
   same current game across a "choose another battlefield" restart.

   Read at CALL time (never destructured at module scope), exactly as the old
   closure vars were, so a fresh game swapped in by bootState is picked up by
   every consumer automatically.
   ============================================================ */

"use strict";

export const game = {
  state: null,   // the current engine game state (engine/state.js), or null on the splash screen
  input: null,   // the current input controller (input.js attachInput), or null before a game
  // The Odyssey galaxy (engine/galaxy.js) when in open-world mode, else null. In
  // Odyssey `state` is the active planet's state = galaxy.planets.get(activeId);
  // credits + the other planets live on the galaxy. Read at call time like the rest.
  galaxy: null,
  // Timestamp until which the supply readout flashes red after a blocked
  // production attempt: written by boot.js's frame-event pump, read by hud.js's
  // renderHUD. Kept here because it crosses that module boundary.
  supplyBlockedUntil: 0,
  // Control groups, keyed per planet id → { digit: [unitIds] }. Lives on the session (not
  // in the per-game input controller) so a group survives an Odyssey jump — which tears down
  // and rebuilds attachInput — and can be shown in the HUD and persisted UI-side. Never part
  // of the deterministic sim; kept out of engine/persist.js's sanitized save payload.
  groups: {},
};
