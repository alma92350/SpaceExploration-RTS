# Stellar Frontier: RTS

A real-time strategy game set in the same universe as [Stellar Frontier](https://github.com/alma92350/SpaceExploration) (the turn-based space trading/exploration game) — a separate, standalone game, not a mode bolted onto the original.

## Why a separate repo

The original game has no build step and no module system: ~30 script-tag files all read and mutate one global state singleton, built entirely around discrete player-action "cycles." A real-time game needs a wall-clock delta-time loop and a different state/update model, so retrofitting it into that engine would mean a large, risky rewrite of a game that already works. This repo starts clean instead — same universe, new engine.

## What carried over from the original repo, and what didn't

- **`data.js` — copied verbatim.** Genuinely pure data (factions, the commodity catalog, production recipes, the 20 charted worlds) with zero dependency on the original's turn/state engine. Safe to reuse as-is.
- **`style.css` palette** — the `:root` color variables only, so the two games read as the same universe. The rest of the original's stylesheet is laid out for a turn-based tab/panel UI and doesn't apply here.
- **`catalogs.js` and `galaxygen.js` were *not* copied.** Both looked like reusable content tables at a glance, but on inspection they're logic-coupled to the original's global `S` state and its turn/political systems (`policyActive`, office terms, per-cycle frontier generation, etc.) — copying them would just import dead or broken references. Anything worth reusing from them (ship upgrade tiers, tech tree shape, mission structure) is design inspiration to rebuild deliberately for a real-time model, not code to drag over.

## Status

First playable vertical slice: a 1v1 skirmish against a scripted AI on Ferros Prime (a mining world from `data.js`). Gather ore/crystals/radioactives with Workers, build a Barracks, produce Skiffs, fight, win by destroying the enemy Command Center (or lose yours). No tech tree, no multiple maps, no multiplayer yet — see `engine/` for the sim (fixed-timestep loop, movement, gather, combat, production, AI) and `render.js`/`input.js` for the canvas view and mouse controls.

Controls: left-drag to select your units, right-click to move/gather/attack depending on what's under the cursor, click a Worker or a completed building for build/produce options in the side panel.

## Running it

No build step, but the game loads as ES modules, which browsers block over `file://`. Serve the directory locally, e.g. `npx serve .` or `python3 -m http.server`, and open the printed URL.

## Tests

`npm test` runs `engine/`'s unit and integration tests (`node --test`), including a full simulated skirmish that plays out to a winner.
