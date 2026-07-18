# Stellar Frontier: RTS

A real-time strategy game set in the same universe as [Stellar Frontier](https://github.com/alma92350/SpaceExploration) (the turn-based space trading/exploration game) — a separate, standalone game, not a mode bolted onto the original.

## Why a separate repo

The original game has no build step and no module system: ~30 script-tag files all read and mutate one global state singleton, built entirely around discrete player-action "cycles." A real-time game needs a wall-clock delta-time loop and a different state/update model, so retrofitting it into that engine would mean a large, risky rewrite of a game that already works. This repo starts clean instead — same universe, new engine.

## What carried over from the original repo, and what didn't

- **`data.js` — copied verbatim.** Genuinely pure data (factions, the commodity catalog, production recipes, the 20 charted worlds) with zero dependency on the original's turn/state engine. Safe to reuse as-is.
- **`style.css` palette** — the `:root` color variables only, so the two games read as the same universe. The rest of the original's stylesheet is laid out for a turn-based tab/panel UI and doesn't apply here.
- **`catalogs.js` and `galaxygen.js` were *not* copied.** Both looked like reusable content tables at a glance, but on inspection they're logic-coupled to the original's global `S` state and its turn/political systems (`policyActive`, office terms, per-cycle frontier generation, etc.) — copying them would just import dead or broken references. Anything worth reusing from them (ship upgrade tiers, tech tree shape, mission structure) is design inspiration to rebuild deliberately for a real-time model, not code to drag over.

## Status

A 1v1 skirmish against a scripted AI on one of three charted worlds (Ferros Prime, Korrath, Vesper — picked at the start of each match). Gather ore/crystals/radioactives with Workers, build a Barracks, produce Skiffs and Bastions, fight under fog of war, win by destroying the enemy Command Center (or lose yours). No tech tree, no multiplayer yet — see `engine/` for the sim (fixed-timestep loop, movement + local avoidance, gather, combat, production, fog of war, AI) and `render.js`/`input.js`/`camera.js` for the canvas view, camera, and mouse/keyboard controls.

Three combat units forming a genuine rock-paper-scissors triangle, not just a single hard counter: Skiff (fast, cheap) beats Lancer, Bastion (slow, short-ranged, tanky) beats Skiff, and Lancer (long-ranged, armor-piercing) beats Bastion — each unit's bonus damage targets exactly the matchup that would otherwise be its worst, and nothing beats all three at once. Scouting what the enemy is building, and countering it, matters.

Controls: left-drag to select your units, right-click to move (ignores enemies) or gather/assist-build/attack/set-rally-point depending on what's selected and under the cursor, Shift+right-click for attack-move (engages anything encountered along the way), mouse wheel to zoom, WASD/arrow keys to pan. Click a Worker or a completed building for build/produce/research options in the side panel. Sound can be muted from the top bar.

Fog of war hides enemy units and buildings outside your current vision (resource deposits are always shown — they're charted map knowledge, not battlefield intel). The AI plays with full knowledge of the map; only the player's view and targeting are fogged.

A Refinery (built by a Worker, like the Barracks) researches two one-time upgrades once you're gathering crystals/radioactives: Reinforced Plating (less damage taken) and Overcharged Weapons (more damage dealt) — both apply live to your whole army, not just future production. Not every world has both resources (Korrath has no crystals, Vesper no radioactives), so which upgrade path is even available depends on where you're fighting.

Each of the three worlds also gives the AI a different temperament: Korrath's is a Rusher (small economy, commits early), Ferros's is an Economist (builds up before attacking), Vesper's is Balanced.

## Running it

No build step, but the game loads as ES modules, which browsers block over `file://`. Serve the directory locally, e.g. `npx serve .` or `python3 -m http.server`, and open the printed URL.

## Tests

`npm test` runs `engine/`'s unit and integration tests (`node --test`), including a full simulated skirmish that plays out to a winner.
