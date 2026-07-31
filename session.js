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
  // World-space {x,y} of the most recent under-attack alert, or null before the first one this
  // game — written by boot.js's frame-event pump (triggerUnderAttack), read by input.js's
  // Backspace "jump to last alert" keybind and by boot.js's own under-attack banner click
  // handler. Kept here, next to supplyBlockedUntil above, for the same reason: it crosses that
  // same module boundary.
  lastAttackAt: null,
  // Live per-world alert badges for the Odyssey starmap (P6 "Starmap live colony ledger"):
  // planetId -> {type, at}, written by boot.js's notifyColony for every attack/hostile/lost
  // notification a background colony raises (engine/galaxy.js sweepColonies) — the SAME trigger
  // that already fires the transient toast, just remembered here too so starmap.js's
  // renderStarmap can badge a world at a glance instead of relying on whichever toast the player
  // happened to catch. `at` is a performance.now() timestamp; starmap.js treats an attack/hostile
  // entry as "live" only within its own ~30s window, while a "lost" entry persists as a badge
  // until boot.js's focusActivePlanet clears that ONE planet's entry — i.e. until the player
  // actually jumps back and looks. Reset to {} on every fresh boot (bootState), like `groups`
  // below; never part of the deterministic sim or the persisted save (same reasoning as
  // lastAttackAt above — this crosses the boot.js/starmap.js module boundary, nothing more).
  colonyAlerts: {},
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
  // Which collapsible panel sections (the Build submenu's per-category groups, the CC/Barracks
  // Produce lists, the Refinery/Datacenter Research lists, Market, the freighter Cargo list, the
  // Spaceport Jump list, …) the player has manually collapsed — a UI preference like `formation`
  // above, not per-unit/per-game state, so collapsing one keeps it collapsed across every later
  // selection until toggled back. A key ABSENT from the set means "expanded" (starts open,
  // unchanged behaviour) — so a new collapsible section needs zero migration code here, it just
  // starts expanded like everything else. Keys are the stable strings passed to hudSelection.js's
  // sectionToggle(), e.g. "build:economy", "cc:produce", "market".
  collapsedSections: new Set(),
};
