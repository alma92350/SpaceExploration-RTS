import { test } from "node:test";
import assert from "node:assert/strict";
import * as dom from "../dom.js";

// dom.js resolves `document` defensively (`const doc = typeof document !== "undefined" ?
// document : null;`) SPECIFICALLY so every UI module that imports it stays import-safe under
// Node (`node --test` has no `document` global) — its own header comment says so. This is a
// smoke test proving that contract actually holds, not a DOM-behavior test: there's no real
// `document` here to click buttons on or read layout from, only the guarantee that importing
// this file under Node never throws and every handle comes back `null` rather than blowing up
// on a `document.getElementById` call against a missing global.

// Every element-handle export dom.js resolves via `byId` — i.e. every export except the two
// plain numeric constants and the isTouchMode() predicate. Derived from the module's own export
// list (not hand-copied) so this test can't silently drift out of sync with dom.js as handles
// are added or removed.
const NON_ELEMENT_EXPORTS = new Set(["MINIMAP_W", "MINIMAP_H", "isTouchMode"]);
const elementHandleNames = Object.keys(dom).filter(k => !NON_ELEMENT_EXPORTS.has(k));

test("dom.js exports the full roster of element handles this suite expects", () => {
  // A sanity floor, not a hardcoded ceiling — the review that spawned this test counted
  // "about two dozen" handles; this just guards against the whole export list silently
  // collapsing to nothing (e.g. an import-order bug swallowing every export).
  assert.ok(elementHandleNames.length >= 20,
    `expected at least 20 element-handle exports, found ${elementHandleNames.length}: ${elementHandleNames.join(", ")}`);
  // A few load-bearing ones by name, so a typo'd/renamed export fails loudly here instead of
  // only showing up as a mysterious null deref somewhere deep in the UI layer.
  for (const name of ["canvas", "ctx", "minimapCanvas", "minimapCtx", "resourcesEl", "saveBtn", "loadBtn", "underAttackEl", "gateChipEl"]) {
    assert.ok(elementHandleNames.includes(name), `expected dom.js to export "${name}"`);
  }
});

test("every element handle resolves to null under Node (no document global)", () => {
  for (const name of elementHandleNames) {
    assert.equal(dom[name], null, `dom.${name} should be null when \`document\` is absent, got ${String(dom[name])}`);
  }
});

test("MINIMAP_W / MINIMAP_H are the documented literal dimensions", () => {
  assert.equal(dom.MINIMAP_W, 200);
  assert.equal(dom.MINIMAP_H, 125);
});

test("isTouchMode() is false with no document to carry the touch body-class", () => {
  assert.equal(dom.isTouchMode(), false);
});
