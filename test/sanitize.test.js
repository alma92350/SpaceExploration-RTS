import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSave, deserializeGalaxy } from "../engine/persist.js";

test("sanitizeSave passes a plain, bounded save object through unchanged", () => {
  const ok = { v: 1, seed: 5, planets: [{ units: [], buildings: [] }], nested: { a: [1, 2, "x"], b: null, c: true } };
  assert.equal(sanitizeSave(ok), ok, "valid data is returned as-is");
});

test("sanitizeSave rejects a prototype-polluting key (and doesn't pollute)", () => {
  const evil = JSON.parse('{"v":1,"__proto__":{"polluted":true}}');
  assert.throws(() => sanitizeSave(evil), /forbidden key/);
  assert.equal(({}).polluted, undefined, "Object.prototype stays clean");
});

test("sanitizeSave rejects constructor/prototype keys nested deep", () => {
  assert.throws(() => sanitizeSave({ v: 1, a: { b: { constructor: 1 } } }), /forbidden key/);
  assert.throws(() => sanitizeSave({ v: 1, a: { prototype: {} } }), /forbidden key/);
});

test("sanitizeSave rejects non-objects and oversized strings", () => {
  assert.throws(() => sanitizeSave(null), /not a valid object/);
  assert.throws(() => sanitizeSave("a string"), /not a valid object/);
  assert.throws(() => sanitizeSave([1, 2, 3]), /not a valid object/);
  assert.throws(() => sanitizeSave({ v: 1, s: "x".repeat(5000) }), /oversized string/);
});

test("sanitizeSave rejects a node bomb (too many values)", () => {
  const big = { v: 1, arr: [] };
  for (let i = 0; i < 601000; i++) big.arr.push(i);   // just past MAX_SAVE_NODES
  assert.throws(() => sanitizeSave(big), /too large/);
});

test("sanitizeSave rejects an over-deep structure", () => {
  let root = {}, cur = root;
  for (let i = 0; i < 300; i++) { cur.n = {}; cur = cur.n; }
  assert.throws(() => sanitizeSave({ v: 1, deep: root }), /too deeply nested/);
});

test("the deserializer sanitizes first, then still guards its version", () => {
  assert.throws(() => deserializeGalaxy({ v: 999, planets: [] }), /unsupported galaxy save/);
  const evil = JSON.parse('{"v":1,"__proto__":{"x":1}}');
  assert.throws(() => deserializeGalaxy(evil), /forbidden key/, "a hostile save never reaches rehydration");
});
