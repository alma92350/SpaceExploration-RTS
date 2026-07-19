# Stellar Frontier: RTS

A real-time strategy game set in the same universe as [Stellar Frontier](https://github.com/alma92350/SpaceExploration) (the turn-based space trading/exploration game) — a separate, standalone game, not a mode bolted onto the original.

## Why a separate repo

The original game has no build step and no module system: ~30 script-tag files all read and mutate one global state singleton, built entirely around discrete player-action "cycles." A real-time game needs a wall-clock delta-time loop and a different state/update model, so retrofitting it into that engine would mean a large, risky rewrite of a game that already works. This repo starts clean instead — same universe, new engine.

## What carried over from the original repo, and what didn't

- **`data.js` — copied verbatim.** Genuinely pure data (factions, the commodity catalog, production recipes, the 20 charted worlds) with zero dependency on the original's turn/state engine. Safe to reuse as-is.
- **`style.css` palette** — the `:root` color variables only, so the two games read as the same universe. The rest of the original's stylesheet is laid out for a turn-based tab/panel UI and doesn't apply here.
- **`catalogs.js` and `galaxygen.js` were *not* copied.** Both looked like reusable content tables at a glance, but on inspection they're logic-coupled to the original's global `S` state and its turn/political systems (`policyActive`, office terms, per-cycle frontier generation, etc.) — copying them would just import dead or broken references. Anything worth reusing from them (ship upgrade tiers, tech tree shape, mission structure) is design inspiration to rebuild deliberately for a real-time model, not code to drag over.

## Status

A 1v1 skirmish against a scripted AI on one of nine charted worlds, picked at the start of each match. Gather ore/crystals/radioactives with Workers, build a Barracks, produce a mixed army, expand and fortify, fight under fog of war, and win by destroying the enemy's last Command Center (or lose yours). No tech tree, no multiplayer yet — see `engine/` for the sim (fixed-timestep loop, movement + local avoidance, gather, combat, production, supply, placement validation, fog of war, AI) and `render.js`/`input.js`/`camera.js` for the canvas view, camera, and mouse/keyboard controls.

Four combat units. Three of them form a genuine rock-paper-scissors triangle, not just a single hard counter: Skiff (fast, cheap) beats Lancer, Bastion (slow, short-ranged, tanky) beats Skiff, and Lancer (long-ranged, armor-piercing) beats Bastion — each unit's bonus damage targets exactly the matchup that would otherwise be its worst, and nothing beats all three at once. The fourth, the Breacher, sits deliberately *outside* the triangle: a slow siege platform that outranges static defenses and tears through buildings, but has the worst anti-unit damage in the game and dies to a single Skiff at half its cost — a turtle-breaker that's helpless without an escort. Scouting what the enemy is building, and countering it, matters.

Controls: left-drag to select your units, right-click to move (ignores enemies) or gather/assist-build/attack/set-rally-point depending on what's selected and under the cursor, Ctrl+right-click to queue that order as a waypoint (chain several to lay down a path — combat units attack-move along it, engaging anything encountered), mouse wheel to zoom, WASD/arrow keys to pan. Click a Worker or a completed building for build/produce/research options in the side panel. Sound can be muted from the top bar.

Fog of war hides enemy units and buildings outside your current vision. The charted surface deposits near each base are always shown — they're map knowledge, not battlefield intel — but the map also hides several resource **caches** out in the contested middle and along the edges: extra deposits the survey missed, invisible until one of your units scouts their location, then marked permanently once found. They often hold the crystals or radioactives a world's surface lacks, so scouting can unlock a resource — and the tech that needs it — you'd otherwise have no access to.

The AI plays under its own fog too — it is not omniscient. It keeps a scout ranging across the map, and only reacts to what it has actually seen: it counter-builds against your army only once it spots it, and it can only mine or expand to caches it has discovered. Both sides start knowing only their own corner and have to explore for the rest.

A Refinery (built by a Worker, like the Barracks) researches two one-time upgrades once you're gathering crystals/radioactives: Reinforced Plating (less damage taken) and Overcharged Weapons (more damage dealt) — both apply live to your whole army, not just future production. Crystals and radioactives also fund the two new structures below, so they no longer dead-end once the upgrades are bought. Not every world has both resources (Korrath has no crystals, Vesper no radioactives), so which of those options is even available depends on where you're fighting.

**Expanding and fortifying.** The Command Center is buildable now (steep — 400 ore, slow to raise), so taking a second base is a real mid-game decision: nodes deplete, and a fresh field plus a fresh drop-off point is how you outlast a drained home economy. The Sentinel Turret is static defense (crystal-funded) that makes raids cost something and base layout matter; the Breacher is the answer to a wall of them.

**Supply.** Army size is capped by supply, not just ore: every unit costs some, Command Centers grant a baseline, and a cheap Habitat raises the ceiling. It's a genuine macro choice (army now vs. infrastructure now), a raidable weak point (burn a Habitat and push someone over their cap), and it keeps late-game battles bounded. Losing a Habitat can leave you legally over cap — nothing dies, but production blocks until you rebuild.

Each world gives the AI a different temperament — Rusher (small economy, commits early), Economist (out-scales before attacking, expands and turtles behind turrets), or Balanced — and it plays the whole toolkit: it attacks in repeated waves, not just once (a fresh batch of units becomes the next wave once it's big enough or the timeout comes back around); it scouts, building the direct counter to whatever combat type the player fields most every third unit; and it expands when its home ore runs thin, fortifies the approach lane with turrets, runs multiple Barracks, and raises Habitats to stay under supply. Six of the nine worlds also carry a single rule modifier that applies to both sides — Glacius's ice slows everyone, Nimbus's storms shorten sight, Pyralis's open dunes lengthen it, Helix packs an extra crystal field, Oort's deposits run rich, and Forge's industry speeds construction — so where you fight changes how the fight plays, not just what you can build.

A minimap (bottom-left) shows the whole map at a glance — fog, resource deposits, and every unit/building you can currently see — and doubles as a camera shortcut: click anywhere on it to jump the main view there. An "Under Attack" banner (with its own alarm sound and a pulsing ping on both the main view and the minimap) fires when the AI hits something of yours, so a raid on an unwatched flank doesn't go unnoticed. Combat itself is legible at a glance too: a tracer flashes from attacker to target on every hit (colored by weapon type), and a brief ring marks a kill.

Placing a building shows a live green/red footprint preview under the cursor before you click — invalid spots (off the map, overlapping another building, too close to a resource node) are rejected with no cost and no need to reselect. The selection panel shows what's queued at a selected Command Center or Barracks (with live progress on the in-progress job) and lets you cancel any queued unit for a full refund; selecting a group of units collapses the panel to one row per type ("12× Skiff — 84% hp") instead of one per unit.

## Running it

No build step, but the game loads as ES modules, which browsers block over `file://`. Serve the directory locally, e.g. `npx serve .` or `python3 -m http.server`, and open the printed URL.

## Tests

`npm test` runs `engine/`'s unit and integration tests (`node --test`), including a full simulated skirmish that plays out to a winner.
