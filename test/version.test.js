import { test } from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION, parseVersion, compareVersions, isNewer, saveImpact, SAVE_FORMAT } from "../version.js";

test("parseVersion handles semver, prerelease, and junk", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("2.0.0-beta.1"), [2, 0, 0], "a prerelease suffix is ignored");
  assert.deepEqual(parseVersion("1"), [1, 0, 0]);
  assert.deepEqual(parseVersion("garbage"), [0, 0, 0]);
  assert.deepEqual(parseVersion(null), [0, 0, 0]);
});

test("compareVersions orders numerically by major/minor/patch", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("1.2.0", "1.10.0"), -1, "numeric, not lexical (2 < 10)");
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
});

test("isNewer is true only for a strictly greater release", () => {
  assert.equal(isNewer("1.0.1", "1.0.0"), true);
  assert.equal(isNewer("1.0.0", "1.0.0"), false);
  assert.equal(isNewer("0.9.0", "1.0.0"), false);
  assert.equal(isNewer(APP_VERSION, APP_VERSION), false, "the running build is never newer than itself");
});

test("saveImpact flags saves older than the new build's minimum readable format", () => {
  // Backward-compatible release (min stays at 1): current saves carry over.
  const compat = saveImpact({ minSaveVersion: 1, minGalaxySaveVersion: 1 }, { skirmish: 1, odyssey: 1 });
  assert.deepEqual(compat.risk, []);
  assert.deepEqual(compat.safe.slice().sort(), ["Odyssey", "skirmish"]);
  assert.equal(compat.hasSaves, true);

  // Breaking release (galaxy min bumped to 2): the v1 Odyssey save is orphaned, the skirmish still loads.
  const breaking = saveImpact({ minSaveVersion: 1, minGalaxySaveVersion: 2 }, { skirmish: 1, odyssey: 1 });
  assert.deepEqual(breaking.risk, ["Odyssey"]);
  assert.deepEqual(breaking.safe, ["skirmish"]);

  // No stored saves → nothing at stake.
  const none = saveImpact({ minSaveVersion: 2, minGalaxySaveVersion: 2 }, { skirmish: null, odyssey: null });
  assert.equal(none.hasSaves, false);
  assert.deepEqual(none.risk, []);
});

test("SAVE_FORMAT mirrors the persisted format versions", () => {
  assert.equal(typeof SAVE_FORMAT.save, "number");
  assert.equal(typeof SAVE_FORMAT.galaxy, "number");
});
