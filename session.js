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
  // The player's current formation choice (engine/formation.js FORMATION_SHAPES /
  // LEADER_POSITIONS) — a UI preference, not per-game state, so it's fine to just carry over
  // across a "choose another battlefield" restart like any other setup preference. Read by
  // input.js when issuing a move/attack-move/Hold-Formation order, and mutated directly by
  // hudSelection.js's formation picker buttons.
  formation: { shape: "grid", leaderPos: "front" },
  // Whether a builder's (Worker/Engineer/Technician) Build submenu is expanded — a UI
  // preference like `formation` above, not per-unit state, so collapsing it once keeps it
  // collapsed across every later selection until toggled back. Starts open (unchanged
  // behaviour) — collapsing is an opt-in way to shrink the panel, not a forced default.
  buildMenuOpen: true,
};
