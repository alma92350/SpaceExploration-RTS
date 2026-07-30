# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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

### Changed

- The Refinery, Foundry, and Arsenal no longer double as forward resource drop-offs — they're
  ore-tech buildings only now (Refinery for doctrine research, Foundry/Arsenal as Tier-2/Tier-3
  gates). All gather and haul traffic runs straight to a Command Center; the AI no longer plants
  additional Refineries out at far ore seams as decentralized collection points.

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
