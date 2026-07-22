# Stellar Frontier: RTS

A browser-based real-time strategy game set in the same universe as
[Stellar Frontier](https://github.com/alma92350/SpaceExploration) (the turn-based space
trading/exploration game) — a separate, standalone game, not a mode bolted onto the original.
Vanilla JavaScript, ES modules, **no build step, no dependencies**. Play a 1v1 skirmish against a
scripted AI, or an open-ended **Odyssey** that strings worlds together into a galaxy you settle,
trade across, and conquer.

## Running it

The game has no build step, but it loads as ES modules, which browsers refuse to import over
`file://` — so it needs to be served over HTTP. A zero-dependency dev server ships with the repo:

```
npm start          # serves at http://localhost:8080
```

Nothing to install first — no `npm install`. (Any static server works too: `npx serve .` or
`python3 -m http.server`.) Then open the printed URL. Requires Node ≥ 20.

## Tests

```
npm test
```

Runs the full suite (`node --test`): the engine's unit and integration tests — including a full
simulated skirmish played out to a winner and a galaxy played across multiple worlds — plus the
determinism, purity, and static-integrity guards. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
invariants those guard.

## The skirmish

A 1v1 real-time match against a scripted AI on one of nine charted worlds, picked at the start.
Gather ore/crystals/radioactives with Workers, build a Barracks, produce a mixed army, expand and
fortify, fight under fog of war, and win by destroying the enemy's last Command Center (or lose
yours). A defensive stall can't run forever: if neither side is finished off, a match time limit
settles it on score (banked resources plus the built value of everything you own), so there's
always a terminal state.

The splash screen configures the skirmish before you pick a world. **AI speed** is a 1–150
actions-per-minute cap on the opponent — every command it takes (produce, build, expand, research,
scout) spends one action, so a low setting is a sluggish, forgiving foe and a high one relentless
(its attack commit is exempt, so it always resolves the game). **Map size** scales the field from
Small (1600×1000) up to Gigantic (4×) with more caches in the bigger space, and **Resources**
(Rare / Normal / Abundant) scales every deposit's yield. Whatever the world, every map guarantees a
near-base surface source of ore, crystals, and radioactives so all builds are possible — the
planet's own deposit table just shapes how much of each there is.

**Units.** Four combat units. Three form a genuine rock-paper-scissors triangle, not just a single
hard counter: Skiff (fast, cheap) beats Lancer, Bastion (slow, short-ranged, tanky) beats Skiff,
and Lancer (long-ranged, armor-piercing) beats Bastion — each unit's bonus damage targets exactly
the matchup that would otherwise be its worst, and nothing beats all three at once. The fourth, the
Breacher, sits deliberately *outside* the triangle: a slow siege platform that outranges static
defenses and tears through buildings, but has the worst anti-unit damage in the game and folds to
massed Skiffs for a fraction of its cost — a turtle-breaker that's helpless without an escort.
Scouting what the enemy is building, and countering it, matters.

**Tech: doctrines and structures.** A Refinery (built by a Worker, like the Barracks) researches
army-wide upgrades — applied live to your whole army, not just future production — but they're two
**mutually-exclusive doctrines**, so this is a real commitment, not a buy-both. **Assault**
(Overcharged Weapons → Overcharged Core) stacks more damage dealt; **Bulwark** (Reinforced Plating
→ Reinforced Bulwark) stacks less damage taken. Researching either one locks the other out, and
each has a Tier-2 that deepens your chosen path. Assault costs radioactives and Bulwark crystals,
so a world's deposit specialty (Korrath has no crystals, Vesper no radioactives) tilts which
doctrine comes easier. Beyond the Refinery, a Foundry and a Datacenter open further research —
crystals and radioactives fund all of it, so those deposits never dead-end.

**Expanding and fortifying.** The Command Center is buildable (steep — 400 ore, slow to raise), so
taking a second base is a real mid-game decision: nodes deplete, and a fresh field plus a fresh
drop-off point is how you outlast a drained home economy. The Sentinel Turret is static defense
(crystal-funded) that makes raids cost something and base layout matter; the Breacher is the answer
to a wall of them.

**Supply.** Army size is capped by supply, not just ore: every unit costs some, Command Centers
grant a baseline, and a cheap Habitat raises the ceiling. It's a genuine macro choice (army now vs.
infrastructure now), a raidable weak point (burn a Habitat and push someone over their cap), and it
keeps late-game battles bounded. Losing a Habitat can leave you legally over cap — nothing dies,
but production blocks until you rebuild.

**The AI.** Each world gives the AI a different temperament — Rusher (small economy, commits
early), Economist (out-scales before attacking, expands and turtles behind turrets), or Balanced —
and it plays the whole toolkit: it attacks in repeated waves, not just once; it scouts and builds
the direct counter to whatever combat type you field most; and it expands when its home ore runs
thin, fortifies the approach lane with turrets, runs multiple Barracks, and raises Habitats to stay
under supply. It plays under its own fog too — not omniscient — reacting only to what it has
actually seen.

**Worlds.** Six of the nine worlds carry a single rule modifier that applies to both sides —
Glacius's ice slows everyone, Nimbus's storms shorten sight, Pyralis's open dunes lengthen it, Helix
packs an extra crystal field, Oort's deposits run rich, and Forge's industry speeds construction.
Six also carry **terrain**: rough ground you cross slower (never impassable — it slows and shapes,
it doesn't wall) and high ground that sees farther and hits harder — real objectives to seize.
Terrain is mirrored, so both sides face the same ground, and you can't build on rough ground, so
base layout has to work around it. Two worlds are **asymmetric matchups** where the modifier hits
the sides *differently* (Oort: you out-mine, they out-build; Nimbus: you out-scout, they
out-tempo), so which corner you start in defines your plan. The three original worlds (Ferros,
Korrath, Vesper) stay clean open plains.

**Fog & caches.** Fog of war hides enemy units and buildings outside your vision. The charted
surface deposits near each base are always shown — map knowledge, not battlefield intel — but the
map also hides resource **caches** in the contested middle and along the edges: extra deposits the
survey missed, invisible until one of your units scouts their location, then marked permanently.
They often hold the crystals or radioactives a world's surface lacks, so scouting can unlock a
resource — and the tech that needs it — you'd otherwise have no access to.

### Controls

Left-drag to select (Ctrl+drag adds to the selection), right-click to move or
gather/assist-build/attack/set-rally depending on what's selected and under the cursor,
Ctrl+right-click to queue that order as a waypoint (chain several to lay down a path — combat units
attack-move along it), mouse wheel to zoom, WASD/arrow keys or the screen edge to pan. Control
groups bind with Shift+1–9 and recall with 1–9; double-click a unit to grab every on-screen unit of
that type; **Q** selects your whole army, **X** halts the selection, **`** cycles idle workers, and
**P** pauses. Right-click the minimap to order the selection somewhere off-screen. Click a Worker or
a completed building for build/produce/research options in the side panel (unaffordable options are
greyed out); a full controls reference sits in the panel whenever nothing is selected, and **F1**
or **?** opens the help overlay.

## The Odyssey

The Odyssey is the open-world meta-layer: instead of a single match, you play a whole galaxy. You
start on one world, and every world is a full skirmish map — but they never resolve by conquest or
clock. Instead you hold **universal credits** that travel with you, build a **Spaceport**, and
**jump** to another world (jumps cost fuel, scaled by distance, funded by trading commodities at
the market). Settle a new world by carrying a **colony ship** on the jump and deploying it into a
Command Center; the world you leave becomes a **background colony** that keeps working and pays you
passive income while you're away.

Each world's neighbour has its own **diplomacy** — a grace period, grievances if you strip-mine or
attack, and paid tribute truces to buy time — so how you treat a world shapes whether it turns
hostile and sends waves after you. There's no hard win: the Odyssey is a **play-forever sandbox**,
and progress is marked by milestone fireworks — colonies founded, an **Antimatter Gate** coming
online, and **conquest domination** as you pacify neighbour after neighbour — that you keep playing
past. The world roster is the nine skirmish worlds plus two Odyssey-only extras (a research capital
and an agri world).

## Saves

Because the sim is deterministic and seed-driven, a save is just the serialized dynamic state — the
map regenerates from the seed on load, so saves stay small. Two channels:

- **Autosave** keeps the current game in browser `localStorage` on a timer (and on tab-hide /
  unload), so the map-select **Continue** buttons resume exactly where you left off — no manual
  save. Skirmish and Odyssey each have their own slot.
- **Save / Load** buttons move a save to and from a `.json` **file** — an explicit backup or
  transfer you keep on disk. A file import auto-detects whether it's a skirmish or a whole galaxy by
  its shape.

Saves are untrusted input: every load is sanitized and coerced (bad types dropped, numbers clamped)
before it touches the running game, and a save from an incompatible format version is rejected
rather than loaded into a broken state.

## Versioning

`version.js` holds `APP_VERSION` (the running build's semver) and is kept in sync with
`version.json`; an in-app update check compares the deployed `version.json` against the baked-in
value and tells you when a newer build is live — and whether it keeps your saves. Save-format
versions (`SAVE_VERSION` for skirmish, `GALAXY_SAVE_VERSION` for Odyssey) live in
`engine/persist.js` and are bumped independently whenever a save's shape changes; loaders stay
backward-tolerant of older saves. See [CHANGELOG.md](CHANGELOG.md) for release history.

## Project layout

- `engine/` — the simulation: pure, deterministic, DOM-free logic. Fixed-timestep loop, movement +
  local avoidance, gather, combat, production, supply, placement validation, fog of war, AI, the
  market, diplomacy, colony/jump mechanics, and save serialization. Runs headless under
  `node --test`.
- `render.js` / `minimap.js` / `input.js` / `camera.js` / `hud.js` / `overlays.js` / `setup.js` —
  the canvas view, minimap, mouse/keyboard controls, camera, and UI chrome.
- `boot.js` / `session.js` / `saveload.js` — wiring the sim to the page, session state, and
  save/load.
- `data.js` — pure content (factions, the commodity catalog, production recipes, the charted
  worlds).
- `tools/serve.js` — the zero-dependency dev server behind `npm start`.

## Background: why a separate repo

The original game has no build step and no module system: ~30 script-tag files all read and mutate
one global state singleton, built entirely around discrete player-action "cycles." A real-time game
needs a wall-clock delta-time loop and a different state/update model, so retrofitting it would mean
a large, risky rewrite of a game that already works. This repo starts clean instead — same universe,
new engine.

What carried over: `data.js` (copied verbatim — genuinely pure data with zero dependency on the
original's turn/state engine) and the `style.css` `:root` colour palette (so the two games read as
the same universe). `catalogs.js` and `galaxygen.js` were **not** copied — they look like reusable
content tables but are logic-coupled to the original's global state and turn/political systems, so
copying them would just import dead or broken references. Anything worth reusing from them is design
inspiration to rebuild deliberately for a real-time model, not code to drag over.

## License

[MIT](LICENSE).
