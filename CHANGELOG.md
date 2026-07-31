# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **Patrol orders.** Combat and scout units can now be sent on a looping attack-move circuit
  instead of going idle at the end of a waypoint chain — select a unit with an existing move/
  attack-move order queued and press R to convert it into a loop.
- **The counter-triangle is finally visible where it matters.** Attacks that land a hard counter
  (Skiff on Lancer, Bastion on Skiff, Lancer on Bastion, a Breacher on a building) now draw a
  hotter, thicker tracer and impact flash, and unit tooltips and selection rows spell out what
  a unit is strong or weak against — derived straight from the data, not hand-written. Every
  weapon also got its own tracer shape and a muzzle flash, instead of one shared red line.
- **Gatherers no longer idle when a node runs dry.** They now roll onto the nearest same-
  commodity node you've discovered, the same self-healing the AI already had. Node saturation
  (too many workers on one seam) is now visible too — a ring on the map and a line in the panel.
- **Doctrine research now takes time to develop** instead of landing the instant it's paid for,
  scaled by the world's tech rating — a Refinery mid-research is a raidable window, and Bulwark's
  structure shielding (it already reduced damage to turrets and buildings, not just units) is now
  documented and tested rather than an accident of how damage math was written.
- **Odyssey: pick your starting world, or reroll it** — a card row like skirmish's, instead of
  always landing on a random one. Asymmetric skirmish worlds (Oort, Nimbus) also get a side-swap
  toggle so either half of the matchup is playable. Starmap nodes now show a world's deposits and
  rule modifiers before you jump, not just after you land.
- **A reactive opening checklist** replaces the old static 30-second objectives banner — it tracks
  what you've actually done (workers trained, a Barracks up, a doctrine picked, a Habitat raised)
  and checks items off live.
- **The clock is an honest, configurable endgame now.** The final five minutes flip the elapsed-
  time readout to a countdown with a live two-sided score bar, the post-game screen tells you the
  *real* reason the match ended (elimination vs. the score tiebreak — it used to claim the enemy's
  last Command Center fell even when a timeout decided it), and skirmish setup gets a Quick/
  Standard/Marathon match-length option.
- **The Leviathan has a real hull.** The endgame flagship used to fall through to the generic
  fallback silhouette; it now has a bespoke twin-spine capital-ship render befitting the biggest
  thing you'll ever build. A new full-roster render smoke test guards every unit and building type
  against silently falling back to a generic shape again.
- **A fourth AI archetype, the Technologist,** gives Kybernet — the Odyssey's research-capital
  world — its own small, teched-up elite-army temperament instead of playing as a generic
  Economist, and is the first archetype whose mix ever fields the Colossus.
- `tools/ailab.js` (the AI bench) gained a `tech` sparring opponent that climbs the Foundry/
  Arsenal gate and fields a real Tier-2/3 composition instead of Skiffs only, and a `--apm`
  flag so a probe can exercise a difficulty row's real APM throttle instead of always running
  unthrottled.

### Changed

- **The AI's counter-pick logic is unified and sharper.** It used to go blind the moment your
  army's dominant type fell outside the Skiff/Bastion/Lancer triangle (a massed Breacher,
  Dreadnought, Wraith, Aegis, or Colossus army drew no reaction at all), and it never once
  factored in static defense — the test suite already proved a turret wall was fully
  uncounterable. It now falls back to each unit's documented cost-efficiency answer when it has
  no hard counter, and reads a turret wall the same way it reads an army, answering with
  Breachers once the wall is the bigger threat. Difficulty now shapes *how* it counter-picks, not
  just how fast: Easy never counter-picks (a learnable, exploitable army), Hard reacts nearly
  twice as often as Medium.
- **A graduated Hard Rusher now actually re-arms for the tier it graduated into.** It could
  already climb the tech ladder all the way to a Leviathan while its Barracks kept cycling
  Tier-1 Skiffs and Bastions forever; its unit mix now extends alongside its industry.
- The Helium Bomb's blast radius is now measured to a target's rim instead of its center, so the
  header's claim that it can one-shot even the Antimatter Gate is finally true at point-blank
  range instead of geometrically impossible; the AI also no longer detonates its own offensive
  bomb short of the kill band. Its offensive delivery now travels inside an actual committed
  attack wave instead of walking in alone to be shot down before it arrives.

### Fixed

- A worker whose gathering node hit exactly 0 mid-carry could strand its last partial load
  forever (never banked); this is now rare in practice, since the same fix that stops gatherers
  from idling at a dry node also gives it somewhere to carry the stranded load — the fully-idle
  fallback path can still lose it.

Twenty-one improvement proposals from `docs/improvement-proposals.md`'s Tier 1 and Tier 2 (per
`docs/improvement-roadmap.md`'s phased sequencing) shipped in this batch, built by parallel TDD
teams sharing one working tree. One of those changes (timed doctrine research) measurably deepens
an already-documented, deliberately-unfixed AI weakness — `docs/odyssey-ai-review.md` §2.9 has the
details and the repro.

### Added

- **Formations now rank by weapon range.** A wedge or line used to interleave whatever you selected
  in whatever order you clicked it; short-ranged units (Bastion, Skiff) now screen the front of a
  shaped formation while long-ranged ones (Lancer, Breacher, Colossus) trail behind, and an unarmed
  support unit (the Mender) sinks to the rearmost slot of all instead of leading the charge. The
  legacy grid-shape spread and the AI's own formation calls are untouched.
- **Per-building logistics priority.** A high/normal/low cycle on any factory or power station's
  panel now weights the auto-haulage scans toward (or away from) that building — high halves its
  effective distance and lifts its hauler/server cap by one; low quadruples its effective distance
  — instead of the previous flat nearest-first-with-a-hard-cap assignment being the only lever.
- **Bulk trading.** The Market panel gained Sell ×4 and Sell All buttons (quoting the real marginal
  proceeds before you click) alongside the original single-lot button, plus a trend glyph per row
  that tells a briefly-depressed price apart from a deep, slow-draining glut.
- **Grid Substation** — a cheap Odyssey-only relay that extends power-grid reach one hop from an
  active source, so an expansion's factories no longer have to sit inside one dense power blob or
  buy a whole second fuel-burning station just to stop paying the distance tax.
- **Gifts and favor requests give diplomacy an actual road to Allied.** Tribute still only buys a
  truce; you can now hand a neighbour commodities to build lasting goodwill (with diminishing
  returns, so one dump can't buy friendship outright) and fulfill occasional favor requests for
  credits and stance — and an Allied world's market spread tightens, so alliance finally pays for
  itself instead of being a HUD word nothing reads.
- **Bigger maps grow a contested middle, not just distance.** Large and Gigantic worlds now seed a
  mirrored frontier belt of full-size deposit clusters in the map's contested band, one extra belt
  per size step, instead of the same near-base economy stretched over a larger empty map.
- **High ground now extends weapon range, not just sight.** A unit or turret holding a mesa or ridge
  could already see farther than the README promised — it can finally shoot that far too.
- **Attack pings on the minimap**, plus a Backspace hotkey that jumps the camera to the most recent
  one — a raid on a far flank used to be findable only within the under-attack banner's few-second
  window.
- **Space now cycles through every base** on repeated presses instead of always landing on the
  first Command Center, and a new topbar chip surfaces idle production buildings the same way the
  idle-worker chip already does.
- **Alt+click / Alt+drag subtracts from the current selection**, and Ctrl+double-click extends
  select-all-of-type to the whole map instead of just the visible viewport.
- **A Tech & Industry Chart overlay (hotkey T)** finally makes the unlock ladder visible in-game —
  every building, unit gate, and tech node as tier columns, colored by whether it's built,
  affordable now, or locked (with its full prerequisite chain spelled out), with a link to the full
  field manual that was previously linked from nowhere in the app.
- The landing picker now charts the destination's rough and high terrain from orbit instead of
  showing nothing but fog — you still can't see deposits, units, or the fog state, only the ground.
- **Research can be canceled for a full refund**, at the Datacenter or the Refinery, instead of a
  mis-click stranding the cost until completion.
- Reactor, Combustion Generator, and Biomass Reactor get bespoke hull art instead of sharing one
  generic hexagon, and a running factory now shows a subtle work pulse — previously a humming base
  and a dead one looked identical.
- **Autosaves now keep two generations.** A corrupted or interrupted write used to mean losing an
  entire Odyssey campaign; loading now falls back to the previous generation automatically, and
  three consecutive save failures surface a one-time warning instead of failing silently forever.

### Changed

- Heavy Alloys now only boosts the Smelter and Assembly Plant it advertises, instead of silently
  boosting every recipe building in the game including the Antimatter Forge and AI Foundry.
- **A standing Foundry and Arsenal now speed up military production** (~8% each) instead of going
  inert the moment their gate is unlocked, so they're worth defending and raiding past that point.
  This applies through the same shared production code both sides use, so it retunes Tier-2 tempo
  symmetrically for the player and the AI alike — worth knowing if a build or matchup suddenly
  feels faster-paced than before.

### Fixed

- A shaped formation's range-ranking fallback for a unit with no declared weapon range sorted it to
  the *front* of the formation instead of the rear — harmless for most of the roster, but it put
  the unarmed Mender in the most exposed slot of all, backwards from the point of a healer.

Seventeen more proposals from Tier 2 of `docs/improvement-proposals.md` shipped in this batch (per
`docs/improvement-roadmap.md`'s Phase 3), again built by parallel TDD teams sharing one working
tree. Every team that hit an unexpected test failure this round verified it against a clean
baseline instead of assuming it was unrelated — one real, fully-anticipated interaction (the
Foundry/Arsenal tempo change above, applied to a fixed-seed AI bench test) surfaced this way and
was fixed at the test, not the feature.


- **How long a neighbour holds a grudge is now part of its personality.** Souring was already
  flavoured by temperament — a Warlord world turns on you twice as fast as a patient one — but
  *cooling off* was identical everywhere, and once you had drawn blood a neighbour stayed
  primed against you for the rest of the session. A new `forgiveness` dial drives both halves of
  that cooldown: how fast a soured stance drifts back up, and how long the world keeps treating
  you as an active aggressor. It composes across world × AI Strategy × difficulty and is bounded,
  so the spread runs from about 17 minutes of grudge on an Aggressive Warlord world at Hard down
  to about 2 on a patient trading world with an Economic opponent on Easy. Souring is untouched —
  a personality that forgives slowly does not also turn hostile slowly. A charging Antimatter Gate
  still provokes for as long as it charges, whatever the memory says, and every fresh loss re-arms
  the clock so a running war never quietly cools off underneath you.
- The Refinery, Foundry, and Arsenal no longer double as forward resource drop-offs — they're
  ore-tech buildings only now (Refinery for doctrine research, Foundry/Arsenal as Tier-2/Tier-3
  gates). All gather and haul traffic runs straight to a Command Center; the AI no longer plants
  additional Refineries out at far ore seams as decentralized collection points.

### Fixed

- **The Odyssey AI no longer freezes solid in a long session.** Its Habitat trigger was sized for
  a 2-supply unit while the Odyssey roster has 4- and 8-supply ones, and the unit-mix cycle retries
  the same entry until it succeeds — so a developed neighbour could wedge permanently with an empty
  production queue and tens of thousands of unspent ore. The supply margin is now sized from what
  the AI is actually trying to build, supply already under construction is credited, and Habitats
  are placed at any of its Command Centers rather than only the capital.
- **The AI develops on worlds where it never used to.** Unit production ran before industry with no
  ore held back, so a cheap-unit archetype spent itself below a Reactor's cost every think cycle and
  never built one; Hard's rusher graduation landed roughly 30 minutes past its own trigger. A
  bounded bootstrap reserve now banks for the power grid and the first two factories.
- **A rich neighbour spends its income instead of hoarding it.** Sustained surplus opens extra
  Barracks, and — for strategies that cap their standing army — funds a colony ship regardless of
  home depletion, so the build order no longer terminates in a mode that doesn't.
- **A neighbour dragged to Hostile can now act on it.** The Economic and Force Parity strategies
  could never attack under any circumstances, and Odyssey hands one of them to roughly half the
  galaxy's worlds — so half a galaxy read "Hostile" and never sent anything. In Odyssey those
  strategies now mean "doesn't start fights": they still answer a player who has destroyed their
  ships or begun charging an Antimatter Gate. Skirmish behaviour is unchanged.
- **The opening grace window can't collapse any more.** The archetype, strategy and difficulty
  grace/grievance multipliers all compounded, cutting the documented 7-minute window to under 40
  seconds on an Aggressive + Hard combination the setup screen offers directly. The layers still
  compose; they're now bounded.
- A neighbour deploying its own colony ship (or triggering its own Helium Bomb) counted as you
  destroying one of its ships, so it soured its own stance for founding a colony.

### Added

- `tools/ailab.js` — a headless bench for the Odyssey AI. Runs the real sim for 30–60 sim-minutes
  per world (seconds of wall clock), drives the player side with scripted sparring bots, and
  scores the opponent on development / growth / pressure / thrift / liveness / survival. Candidate
  AIs are injected as JSON into the archetype, strategy and difficulty tables (`--overrides`), so
  the whole space can be searched without touching `engine/`. Subcommands: `probe`, `sweep`,
  `compare`, `search`, `check`. Four scripted sparring opponents, including a `skirmisher` that
  actually attacks.
- `docs/odyssey-ai-review.md` — a measured review of how the AI plays in Odyssey, with the
  findings the bench turned up (a supply deadlock that permanently freezes a developed AI, a
  terminating build order, a Rusher that never develops, and a non-initiating half of the galaxy),
  plus the tuning loop to run against them.
- `docs/improvement-proposals.md` — a full-game improvement catalog from a fanned-out review
  team: 71 proposals across nine dimensions (combat, economy, tech/industry, defense/victory,
  AI, Odyssey meta, worlds, UX, presentation/platform), each anchored to the game's progression
  ladder (T1 Opening → T2 Developed → T3 Advanced → Strategic Endgame, plus cross-tier), graded
  by effort and impact, and grounded in the exact files and functions a change would start from.
  A critic's pass over the whole set closes it out: duplicate proposals to merge, collisions to
  decide before scheduling (three dimensions independently patching `counterToPlayerArmy`, the
  free-vs-paid world-intel doctrine, Gate-charge economics), coverage gaps no dimension owned
  (scenarios, replays, post-match debrief, accessibility, audio, modding-by-data), and a
  twelve-item shortlist ranked on player impact per unit of effort.

## [1.0.0] — 2026-07-22

First tagged release. A complete, self-contained real-time strategy game plus an open-world
Odyssey meta-layer, with no build step and no runtime dependencies.

### Skirmish

- 1v1 real-time battles against a fog-limited scripted AI on one of nine charted worlds, with a
  fixed-timestep sim decoupled from render (render interpolation for smooth play on high-refresh
  displays).
- A rock-paper-scissors combat triangle (Skiff / Bastion / Lancer) plus the out-of-triangle
  Breacher siege unit; local-avoidance movement with a separation safety net.
- Economy with worker gather/haul, saturation-limited nodes, scouted resource caches, and a
  supply cap raised by Habitats.
- A real tech layer: Refinery mutually-exclusive Assault/Bulwark doctrines (each with a Tier-2),
  a Foundry tech gate, and Datacenter research.
- Terrain (rough ground and high ground) on six worlds, per-world rule modifiers, and two
  asymmetric matchups; a match time-limit score resolution guarantees a terminal state.
- Three AI temperaments (Rusher / Economist / Balanced) that scout, counter-build, expand,
  fortify, and attack in repeated waves.

### Odyssey (open-world meta)

- A galaxy of worlds you jump between via Spaceports, carrying universal credits and settling new
  worlds with colony ships; worlds you leave become background colonies that pay passive income.
- Per-world diplomacy (grace, grievance, tribute truces), a commodity market for funding jumps,
  and a play-forever design where progress is marked by fireworks/milestones (colonies founded,
  the Antimatter Gate coming online, conquest domination) rather than a hard win.

### Platform & hygiene

- Deterministic engine (`same seed ⇒ same game`) with purity and determinism guards; the whole
  sim runs headless under `node --test`.
- Versioned, sanitized saves (skirmish and galaxy), autosave to localStorage with file
  import/export, and an in-app update check.
- Zero-dependency local dev server (`npm start`), 560+ tests covering the engine, persistence,
  determinism roster sweep, and static integrity (syntax, DOM-id and import resolution).
