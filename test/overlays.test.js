import { test } from "node:test";
import assert from "node:assert/strict";

/* ============================================================
   overlays.js has no existing test file. This one covers showGalaxyToast's MAX_TOASTS=3 eviction
   policy (overlays.js's own header comment on the function, quoted here for reference): "Eviction
   rule at cap: drop the oldest NON-clickable toast; a plain toast never pushes out a clickable one
   (if it would have to, the plain one is dropped instead — it's non-critical)." Reading the
   function itself (overlays.js), that's actually a THREE-way branch once you also ask "what if the
   NEW toast is itself clickable":
     (a) at cap, a non-clickable toast is present -> it's evicted (the oldest ONE, by DOM/insertion
         order — `[...stack.children].find(c => !c._clickable)`), regardless of whether the new
         arrival is clickable or not.
     (b) at cap, ALL THREE existing toasts are clickable, and the new arrival is NOT clickable ->
         nothing is evicted; the new toast is simply never shown (`return null`).
     (c) at cap, ALL THREE existing toasts are clickable, and the new arrival IS clickable -> the
         oldest one overall (`stack.firstElementChild`) is evicted to make room.

   --- import setup -----------------------------------------------------------------------------
   overlays.js imports boot.js (`import { pauseLoop, resumeLoop, togglePause } from "./boot.js"`,
   overlays.js's own comment: "the boot↔overlays cycle resolves via live bindings") — the SAME
   large transitive graph test/boot.test.js's own header comment traces in full (render.js,
   minimap.js, hud.js, hudSelection.js, setup.js, saveload.js, input.js, engine/*, landingPicker.js,
   data.js, sound.js, …), with the same unguarded module-scope DOM calls (hud.js's repairBtn/
   departBtn, boot.js's underAttackEl, saveload.js's saveBtn/loadBtn/homeBtn — none of THOSE three
   guarded by `typeof window !== "undefined"` either, only by a truthy-button check). Proven
   already: hudSelection.js (line 44) imports boot.js directly too, AND hudSelection.js also
   imports overlays.js itself (line 46, for flashHint) — so test/hudSelection.test.js's own
   FakeElement/fakeDocument already imports this exact graph cleanly today, with `window` left
   deliberately UNDEFINED so every `typeof window !== "undefined"` guard anywhere in that graph
   (overlays.js's own help-toggle wiring included) stays off — no real timer/listener starts on
   import. Reused here almost verbatim; the two capabilities added beyond that file's copy:
   showGalaxyToast calls `.remove()` directly on a toast element (`evict.remove()` / `oldest.remove()`
   / the internal `remove` closure's `el.remove()`) — the real DOM's "detach yourself from your
   parent", not exercised by hudSelection.js — and reads `stack.firstElementChild`. Both need real
   parent-tracking, added to appendChild/append below.
   ============================================================ */

class FakeElement extends EventTarget {
  constructor(tag = "div") {
    super();
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._classes = new Set();
    this.classList = {
      add: (...c) => c.forEach(x => this._classes.add(x)),
      remove: (...c) => c.forEach(x => this._classes.delete(x)),
      toggle: (c, f) => { f === undefined ? (this._classes.has(c) ? this._classes.delete(c) : this._classes.add(c)) : (f ? this._classes.add(c) : this._classes.delete(c)); },
      contains: c => this._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  // Real per-instance parent tracking (beyond test/hudSelection.test.js's own copy, which never
  // needed it) — see the header comment: showGalaxyToast's eviction removes a CHILD toast
  // directly, the real DOM's Element.remove(), which needs to know its own parent to splice
  // itself out of.
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => { c._parent = this; this.children.push(c); }); }
  remove() {
    if (!this._parent) return;
    const i = this._parent.children.indexOf(this);
    if (i !== -1) this._parent.children.splice(i, 1);
    this._parent = null;
  }
  // children are pushed in append order, so index 0 IS the oldest — what showGalaxyToast's
  // all-clickable eviction branch (`stack.firstElementChild`) needs.
  get firstElementChild() { return this.children[0] || null; }
  set innerHTML(v) { if (v === "") this.children = []; }
  get innerHTML() { return ""; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getContext() { return null; }
  click() { this.dispatchEvent(new Event("click")); }
}

function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    // Real per-id identity, same reasoning as test/hudSelection.test.js's fakeDocument: dom.js
    // resolves each handle exactly ONCE at import time, and every later doc.getElementById(id)
    // here must keep returning that SAME object, or the exported `galaxyToastEl` this file
    // imports below would silently diverge from what showGalaxyToast is actually appending to.
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    body,
  };
}

globalThis.document = fakeDocument();
// `window` deliberately left undefined — see the header comment: every `typeof window !==
// "undefined"` guard anywhere in the imported graph (overlays.js's own help-toggle wiring,
// saveload.js's autosave timer) stays off, so importing this module starts no real timer or
// listener beyond the per-toast setTimeout the tests below explicitly clean up themselves.

const { showGalaxyToast } = await import("../overlays.js");
const { galaxyToastEl } = await import("../dom.js");

// Every showGalaxyToast call arms a REAL setTimeout (5s plain / 8s clickable, overlays.js) to
// auto-dismiss — left alone, those are live timers that would keep `node --test` from exiting
// promptly after this file's last test (the exact hazard test/boot.test.js's own header comment
// describes for overlays.js's unrelated 30s objectives timer). Clears every toast's timer and
// empties the stack, so each test starts clean and none leak a live timer past this file's last
// test. Called at the START of every test below (not only at the end) so a test that fails
// partway through can never leak stale toasts into the next one.
function resetToasts() {
  for (const c of [...galaxyToastEl.children]) clearTimeout(c._timer);
  galaxyToastEl.children.length = 0;
  galaxyToastEl.classList.add("hidden");
}

test("showGalaxyToast: a single toast is appended, unhides the stack, and is returned", () => {
  resetToasts();
  const el = showGalaxyToast("Hello", "good");
  assert.ok(el, "returns the created element");
  assert.equal(galaxyToastEl.children.length, 1);
  assert.equal(galaxyToastEl.children[0], el, "the SAME element that was returned is what's in the stack");
  assert.equal(el.textContent, "Hello");
  assert.equal(el.className, "galaxy-toast good", "no onClick -> not clickable, so no 'clickable' class");
  assert.equal(el._clickable, false);
  assert.equal(galaxyToastEl.classList.contains("hidden"), false, "showing a toast unhides the stack");
  resetToasts();
});

test("showGalaxyToast: passing an onClick makes a toast clickable — the 'clickable' class and internal flag both flip", () => {
  resetToasts();
  const el = showGalaxyToast("Click me", "warn", () => {});
  assert.equal(el._clickable, true);
  assert.equal(el.className, "galaxy-toast warn clickable");
  resetToasts();
});

test("eviction (a): at cap with a non-clickable toast present, a new toast evicts THAT oldest non-clickable one — never the oldest overall", () => {
  resetToasts();
  showGalaxyToast("A", "warn", () => {});   // clickable — the oldest toast overall; must survive
  showGalaxyToast("B", "warn");             // NOT clickable — the one that should be evicted
  showGalaxyToast("C", "warn", () => {});   // clickable
  assert.equal(galaxyToastEl.children.length, 3, "sanity: at cap");

  const d = showGalaxyToast("D", "warn");   // a 4th, plain toast arrives at cap
  assert.ok(d, "the new toast is shown — a non-clickable slot existed to evict");

  const texts = galaxyToastEl.children.map(x => x.textContent);
  assert.equal(galaxyToastEl.children.length, 3, "still capped at MAX_TOASTS");
  assert.ok(!texts.includes("B"), "the non-clickable toast (B) was evicted");
  assert.deepEqual(texts, ["A", "C", "D"],
    "A and C (both clickable) survive untouched, in their original order, with D appended — " +
    "proves the rule is specifically 'oldest NON-clickable', not 'oldest overall' (A is the " +
    "oldest overall and is clickable, so it must NOT be the one evicted)");
  resetToasts();
});

test("eviction (b): at cap with ALL THREE toasts clickable, a new NON-clickable toast is not shown at all — nothing is evicted", () => {
  resetToasts();
  showGalaxyToast("A", "warn", () => {});
  showGalaxyToast("B", "warn", () => {});
  showGalaxyToast("C", "warn", () => {});
  assert.equal(galaxyToastEl.children.length, 3, "sanity: at cap, all clickable");

  const result = showGalaxyToast("D", "warn");   // plain — no onClick
  assert.equal(result, null, "a plain toast that would have to evict a clickable one is simply never shown");

  const texts = galaxyToastEl.children.map(x => x.textContent);
  assert.equal(galaxyToastEl.children.length, 3, "still exactly 3 — no eviction happened");
  assert.deepEqual(texts, ["A", "B", "C"], "every clickable toast survives untouched, in original order");
  assert.ok(!texts.includes("D"), "the rejected plain toast never entered the stack");
  resetToasts();
});

test("eviction (c): at cap with ALL THREE toasts clickable, a new CLICKABLE toast DOES evict the oldest one", () => {
  resetToasts();
  showGalaxyToast("A", "warn", () => {});
  showGalaxyToast("B", "warn", () => {});
  showGalaxyToast("C", "warn", () => {});
  assert.equal(galaxyToastEl.children.length, 3, "sanity: at cap, all clickable");

  const d = showGalaxyToast("D", "warn", () => {});   // clickable
  assert.ok(d, "a clickable toast that has to evict another clickable one is still shown");

  const texts = galaxyToastEl.children.map(x => x.textContent);
  assert.equal(galaxyToastEl.children.length, 3, "still capped at MAX_TOASTS");
  assert.ok(!texts.includes("A"), "the OLDEST toast (A) was evicted to make room");
  assert.deepEqual(texts, ["B", "C", "D"], "B and C survive, D is appended");
  resetToasts();
});

test("eviction never triggers below the cap: three toasts with a non-clickable one among them all survive together", () => {
  // A companion sanity check for (a): confirms the eviction branch is genuinely gated on
  // `stack.children.length >= MAX_TOASTS`, not merely "a non-clickable toast exists somewhere".
  resetToasts();
  const a = showGalaxyToast("A", "warn", () => {});
  const b = showGalaxyToast("B", "warn");
  assert.equal(galaxyToastEl.children.length, 2);
  assert.deepEqual(galaxyToastEl.children.map(x => x.textContent), ["A", "B"]);
  assert.ok(a && b, "both shown — no eviction below MAX_TOASTS");
  resetToasts();
});
