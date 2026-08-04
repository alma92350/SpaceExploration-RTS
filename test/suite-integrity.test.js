/* ============================================================
   A guard on the SUITE. CONTRIBUTING.md's hard rules are only "enforced by the test suite"
   for as long as the tests enforcing them keep existing and keep running — and nothing
   checked either. Delete a guard file and CI stays green with a smaller test count nobody
   reads; rely on implicit test-file discovery and a Node upgrade can quietly change what
   gets run. Both are cheap to pin, so pin them.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every guard test CONTRIBUTING.md names still exists", () => {
  // CONTRIBUTING.md cites specific files as the executable form of each hard rule ("a change
  // that breaks one fails `npm test` rather than shipping"). If one is renamed or deleted, the
  // doc keeps promising a guarantee that nothing checks any more — worse than never having
  // claimed it. Parsing the names out of the doc means the doc itself stays the source of truth.
  const doc = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
  const named = [...new Set([...doc.matchAll(/test\/[\w.-]+\.test\.js/g)].map(m => m[0]))].sort();
  assert.ok(named.length >= 6, `expected CONTRIBUTING.md to name several guard tests, found ${named.length}`);
  assert.deepEqual(named.filter(f => !existsSync(join(root, f))), [],
    "CONTRIBUTING.md names guard test file(s) that no longer exist — either restore them or update the doc");
});

test("npm test discovers its files explicitly, not by implicit globbing", () => {
  // `node --test` with no path relies on Node's built-in discovery, which has changed across
  // 18/20/22 — and CI runs a two-version matrix. A shell-expanded `test/*.test.js` makes the set
  // of files run a property of this repo rather than of whichever Node happens to be installed.
  // (A bare directory argument is NOT portable: Node 22 tries to load `test/` as a module.) It
  // also stops `_helpers.js` being spawned as a test file in its own right.
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /(^|\s)test\//,
    `package.json's test script should name the test files explicitly, got: ${pkg.scripts.test}`);
});
