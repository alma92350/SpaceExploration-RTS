/* ============================================================
   Release-manifest sync guard. Three files independently name the build's version and
   its save-format numbers — version.js (APP_VERSION / SAVE_FORMAT, the running build's
   source of truth), version.json (the deployed manifest the update check fetches), and
   package.json (the npm identity). Nothing at runtime forces them to agree, and drift
   HAS already happened (package.json sat at 0.1.0 while the app shipped 1.0.0). This test
   is the CI gate that makes the invariant executable: a release bump that forgets one of
   the three fails here instead of silently making the in-app update banner lie.
   Tests may read files (the engine-purity grep only scans engine/), so no dependency.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_VERSION, SAVE_FORMAT } from "../version.js";

const read = rel => JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const manifest = read("../version.json");
const pkg = read("../package.json");

test("version.json version matches the running build's APP_VERSION", () => {
  assert.equal(manifest.version, APP_VERSION,
    "version.json must be bumped in lockstep with version.js APP_VERSION");
});

test("package.json version matches APP_VERSION", () => {
  assert.equal(pkg.version, APP_VERSION,
    "package.json version drifted from the app's version — bump it with each release");
});

test("manifest save-format numbers match what the build actually writes", () => {
  assert.equal(manifest.saveVersion, SAVE_FORMAT.save,
    "manifest.saveVersion must equal engine/persist.js SAVE_VERSION (surfaced via SAVE_FORMAT.save)");
  assert.equal(manifest.galaxySaveVersion, SAVE_FORMAT.galaxy,
    "manifest.galaxySaveVersion must equal engine/persist.js GALAXY_SAVE_VERSION (SAVE_FORMAT.galaxy)");
});

test("manifest minimums are well-formed (not newer than the current format)", () => {
  assert.ok(manifest.minSaveVersion <= manifest.saveVersion,
    "minSaveVersion can't exceed the format the build writes");
  assert.ok(manifest.minGalaxySaveVersion <= manifest.galaxySaveVersion,
    "minGalaxySaveVersion can't exceed the format the build writes");
});

test("minSaveVersion promise is backed by the loader", () => {
  // The deserializers accept ONLY the exact current save version (engine/persist.js:
  // `if (save.v !== SAVE_VERSION) throw`), so the ONLY format the build can actually read
  // is the current one. The manifest must say so, or saveImpact()/the update banner would
  // promise a player their older save carries over when the loader would in fact reject it.
  // Loosen these two ONLY when deserializeGame/deserializeGalaxy gain a real migration path
  // for older versions.
  assert.equal(manifest.minSaveVersion, SAVE_FORMAT.save,
    "no skirmish-save migration exists, so the oldest readable format IS the current one");
  assert.equal(manifest.minGalaxySaveVersion, SAVE_FORMAT.galaxy,
    "no galaxy-save migration exists, so the oldest readable format IS the current one");
});
