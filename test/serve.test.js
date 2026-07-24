import { test } from "node:test";
import assert from "node:assert/strict";
import { sep } from "node:path";
import { resolveSafePath } from "../tools/serve.js";

// resolveSafePath() is the path-traversal guard behind `npm start`'s dev server: given the
// project root and a request pathname, it returns the on-disk path to serve, or null if the
// request would escape the root. These are regression tests for a broken version of that guard
// that used a bare `filePath.startsWith(ROOT)` prefix check — which a sibling directory whose
// name happens to start with the same string sails right through (no separator boundary), and
// which (if it ran before normalization) could also be fooled by literal ".." segments.

const ROOT = `${sep}home${sep}user${sep}SpaceExploration-RTS`;

test("resolveSafePath serves an ordinary in-root request", () => {
  assert.equal(resolveSafePath(ROOT, "/index.html"), `${ROOT}${sep}index.html`);
  assert.equal(resolveSafePath(ROOT, "/engine/loop.js"), `${ROOT}${sep}engine${sep}loop.js`);
});

test("resolveSafePath defaults \"/\" to index.html", () => {
  assert.equal(resolveSafePath(ROOT, "/"), `${ROOT}${sep}index.html`);
});

test("resolveSafePath rejects a sibling directory that merely shares ROOT as a string prefix", () => {
  // "/home/user/SpaceExploration-RTS-evil/secret.txt".startsWith("/home/user/SpaceExploration-RTS")
  // is true, so a naive prefix check lets this through. This is the exact shape of the bug.
  assert.equal(resolveSafePath(ROOT, "/../SpaceExploration-RTS-evil/secret.txt"), null);
});

test("resolveSafePath rejects plain \"..\" traversal out of the root", () => {
  assert.equal(resolveSafePath(ROOT, "/../../../../etc/passwd"), null);
  assert.equal(resolveSafePath(ROOT, "/..%2f..%2fetc/passwd".replace(/%2f/gi, "/")), null);
});

test("resolveSafePath rejects percent-encoded traversal", () => {
  assert.equal(resolveSafePath(ROOT, "/%2e%2e/%2e%2e/etc/passwd"), null);
});

test("resolveSafePath allows a request that resolves to ROOT itself", () => {
  // "/.." from ROOT lands one directory *above* ROOT (ROOT's parent) — outside the root, so it
  // must be rejected. "/subdir/.." folds back down to ROOT exactly, so the `filePath === root`
  // branch of the check (as opposed to the `startsWith(root + sep)` branch) must allow it.
  assert.equal(resolveSafePath(ROOT, "/.."), null);
  assert.equal(resolveSafePath(ROOT, "/subdir/.."), ROOT);
});

test("resolveSafePath allows traversal that stays within the root", () => {
  assert.equal(resolveSafePath(ROOT, "/engine/../index.html"), `${ROOT}${sep}index.html`);
});
