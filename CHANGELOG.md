# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

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
