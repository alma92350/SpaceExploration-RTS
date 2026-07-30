# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- `tools/ailab.js` — a headless bench for the Odyssey AI. Runs the real sim for 30–60 sim-minutes
  per world (seconds of wall clock), drives the player side with scripted sparring bots, and
  scores the opponent on development / growth / pressure / thrift / liveness / survival. Candidate
  AIs are injected as JSON into the archetype, strategy and difficulty tables (`--overrides`), so
  the whole space can be searched without touching `engine/`. Subcommands: `probe`, `sweep`,
  `compare`, `search`, `check`. No engine behaviour changed.
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
