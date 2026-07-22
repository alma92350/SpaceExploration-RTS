# Contributing

Stellar Frontier: RTS is a vanilla-JavaScript, ES-module game with **no build step** and **no
runtime dependencies**. The files in the repo are exactly what the browser loads. That simplicity
is a feature — please keep it. A few rules are load-bearing; the test suite enforces them, so a
change that breaks one fails `npm test` rather than shipping.

## Getting set up

```
node --version      # must be >= 20
npm start           # serve the game at http://localhost:8080  (zero-dep static server)
npm test            # run the full suite (node --test)
```

There is nothing to install — no `npm install`, no bundler, no transpiler.

## The hard rules

These are invariants, not preferences. Each has a guarding test that will go red if you break it.

### 1. The engine is pure, deterministic, and DOM-free

Everything under `engine/` is the simulation: pure logic, no rendering, no browser. It must obey:

- **One source of randomness.** All randomness comes from the seeded PRNG in `engine/rng.js`
  (`mulberry32`, plus the `hashStr` tie-break helper). The engine may **never** call
  `Math.random`, `Date.now`, `new Date`, or `performance.now` — not even in a comment.
  (`test/engine-purity.test.js`.) A line that genuinely isn't the sim can opt out with a
  `deterministic-exempt` comment, but that should be vanishingly rare.
- **No DOM / browser globals.** No `document`, `window`, `localStorage`, `fetch`,
  `requestAnimationFrame`, etc. under `engine/`. The one sanctioned seam is the render loop in
  `engine/loop.js`, whose `requestAnimationFrame` lines carry a `browser-exempt` marker.
  (`test/engine-purity.test.js`.)
- **Same seed ⇒ same game.** Two runs from the same seed must produce byte-identical state, on
  every world. If you touch the engine, keep replays identical — watch iteration order and
  float-accumulation order especially. (`test/determinism.test.js`,
  `test/determinism-roster.test.js`.)

If you need a stable-but-varying value (a per-unit angle, a tie-break), hash an id through
`hashStr` — don't reach for a clock or `Math.random`.

### 2. No build step, ever

The browser loads the repo as-is. So:

- Ship plain ES modules the browser understands — no JSX, no TypeScript syntax, no bundler-only
  imports.
- Every `getElementById` target must exist in `index.html` (or be created in JS), every relative
  import must resolve, and every file must parse. (`test/static-integrity.test.js`.)
- UI modules should stay import-safe under Node (guard top-level `window`/`document` access), so
  their logic can be unit-tested. `dom.js` already resolves `document` defensively; follow that
  pattern.

### 3. Saves are versioned

Save data is untrusted input and is version-gated:

- `engine/persist.js` owns `SAVE_VERSION` (skirmish) and `GALAXY_SAVE_VERSION` (Odyssey). **Bump
  the relevant one whenever you change a save's shape**, and make the loader tolerate older saves
  (additive fields with sensible defaults) rather than rejecting them.
- Loading always sanitizes and coerces (`sanitizeSave`, `cleanEntity`) — never trust a field's
  type or range straight off the wire.

## Style

Match the surrounding code: the same comment density (this codebase explains *why*, not *what*),
the same naming, the same idioms. Prefer a small pure helper in the right module over a clever
one-liner. Add or update a test for any behavioural change.

## Commits

- Keep commits focused and their messages descriptive — say what changed and why, and note that
  the suite stays green.
- Every commit is signed off with:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

## Release checklist

When cutting a release:

1. `npm test` is green (determinism + purity + static-integrity included).
2. Smoke-test in a real browser (`npm start`) — start a skirmish and an Odyssey, save and reload
   both.
3. Bump `APP_VERSION` in `version.js` **and** `version` in `package.json` to the new semver, and
   keep `version.json` in sync (the auto-update check compares them). (`test/release-manifest.test.js`,
   `test/version.test.js`.)
4. If any save shape changed, confirm `SAVE_VERSION` / `GALAXY_SAVE_VERSION` were bumped and old
   saves still load.
5. Add a dated section to `CHANGELOG.md`.
6. Tag the release: `git tag vX.Y.Z && git push --tags`.
