import { test } from "node:test";
import assert from "node:assert/strict";

/* ============================================================
   starmap.js has no existing test file — it's a leaf UI module ("self-wires the galaxy-map
   button + M key", only main.js imports it), so no other test file's DOM stub happens to cover
   it either. Same FakeElement/fakeDocument idiom as test/hudSelection.test.js (dom.js resolves
   getElementById ONCE at import time — dom.js:16-17 — so the stub must exist BEFORE the dynamic
   import, and every later getElementById(sameId) must keep returning the SAME object, or the
   exported starmapEl this file imports below would diverge from what renderStarmap actually
   appends to). starmap.js ALSO reaches for the bare `window` global unconditionally at module
   scope (`window.addEventListener("keydown", ...)` — no `typeof window !== "undefined"` guard,
   unlike input.js/overlays.js's own wiring) — same as test/boot.test.js's header comment
   documents for that exact pattern, `window` needs a stub in place before the import too, or
   just importing the module throws.

   Getting the IMPORT ORDER right matters more here than it looks. starmap.js imports boot.js
   (for initiateJump/surrenderOdyssey/pauseLoop/resumeLoop), which pulls in the same huge graph
   test/boot.test.js's own header comment traces (setup.js, saveload.js, hud.js, input.js, …).
   saveload.js's autosave wiring is properly guarded (`if (typeof window !== "undefined") {
   setInterval(autoSave, AUTOSAVE_INTERVAL_MS); … }`) — but that guard runs exactly ONCE, the
   first time saveload.js's module body executes, and ES module bodies never re-run on a later
   cached import. So if `window` already exists at that FIRST import, the interval really does
   get scheduled — a live, un-cleared setInterval that keeps `node --test` from ever exiting
   (proven empirically: stubbing `window` up front before importing this graph hangs past a 10s
   timeout with no other symptom). test/boot.test.js hits the identical constraint for the
   opposite reason (input.js needs a real `window`) and solves it the same way: import boot.js's
   whole graph FIRST, while `window` is still undefined (so saveload.js's guard skips the
   interval), THEN stub `window`, THEN import starmap.js itself — by which point boot.js's graph
   is already cached and won't re-execute.
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
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { this.children.push(...cs); }
  set innerHTML(v) { if (v === "") this.children = []; }   // the only value renderStarmap ever assigns it
  get innerHTML() { return ""; }
  _queryAll(selector) {
    const cls = selector.slice(1);
    const out = [];
    const walk = kids => { for (const c of kids) { if (c._classes?.has(cls)) out.push(c); if (c.children) walk(c.children); } };
    walk(this.children);
    return out;
  }
  querySelector(selector) { return this._queryAll(selector)[0] || null; }
  querySelectorAll(selector) { return this._queryAll(selector); }
  // dom.js unconditionally calls .getContext("2d") on the canvas/minimap handles at module
  // scope (dom.js:21,23) even though starmap.js itself never touches a canvas — null is enough.
  getContext() { return null; }
  click() { this.dispatchEvent(new Event("click")); }
}

function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    // Real per-id identity: dom.js resolves each handle exactly ONCE at import time, and every
    // later doc.getElementById(sameId) here must keep returning that SAME object, or the
    // exported starmapEl/starmapBtn would silently diverge from what renderStarmap appends to.
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    body,
  };
}

globalThis.document = fakeDocument();

// Pre-warm starmap.js's boot.js graph (which includes saveload.js) while `window` is still
// undefined, so saveload.js's guarded autosave `setInterval` never gets scheduled — see the
// header comment. The result is unused; only the caching side effect matters.
await import("../boot.js");

globalThis.window = { addEventListener() {}, removeEventListener() {} };

const { game } = await import("../session.js");
const { createGalaxy, galaxyStatus } = await import("../engine/galaxy.js");
const { PLANETS, COM } = await import("../data.js");
const { PLANET_MODIFIERS } = await import("../engine/map.js");
const { renderStarmap } = await import("../starmap.js");
const { starmapEl } = await import("../dom.js");

// The world-node button for `id`, in the exact order renderStarmap built the field (mirrors
// galaxyStatus's own world order, so this never depends on matching by rendered text).
function worldNode(g, id) {
  const field = starmapEl.children.find(c => c._classes.has("starmap-field"));
  const idx = galaxyStatus(g).worlds.findIndex(w => w.id === id);
  return field.children[idx];
}

test("renderStarmap lists each world's deposit icons and yield on a .sm-deps line", () => {
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  renderStarmap();

  const node = worldNode(g, "ferros");
  assert.ok(node, "the ferros node was rendered");
  const deps = node.querySelector(".sm-deps");
  assert.ok(deps, "every node carries a deposit dossier line");
  // ferros deposits ore 2.0 / crystals 0.7 / radioactives 1.0 (data.js) — every icon and yield
  // number must appear, in Object.entries order, with no modifier appended (ferros carries none).
  assert.equal(deps.textContent, `${COM.ore.ico} 2.0 · ${COM.crystals.ico} 0.7 · ${COM.radioactives.ico} 1.0`);

  game.galaxy = null;
});

test("a world with a PLANET_MODIFIERS entry appends its rule label to the dossier line", () => {
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  renderStarmap();

  const node = worldNode(g, "glacius");
  const deps = node.querySelector(".sm-deps");
  assert.ok(deps.textContent.endsWith(PLANET_MODIFIERS.glacius.label), "the world's rule-modifier label is appended");
  assert.ok(deps.textContent.includes(COM.ice.ico), "its deposit icons are still there too");

  game.galaxy = null;
});

test("a world with no PLANET_MODIFIERS entry shows only its deposits — no stray separator or 'undefined'", () => {
  const g = createGalaxy({ seed: 1 });
  game.galaxy = g;
  renderStarmap();

  // ferros/korrath/vesper deliberately carry no modifiers (engine/map.js's own header comment).
  for (const id of ["ferros", "korrath", "vesper"]) {
    const deps = worldNode(g, id).querySelector(".sm-deps");
    assert.ok(!/undefined/.test(deps.textContent), `${id}: no modifier -> no stray 'undefined' from a missing label`);
    assert.ok(!deps.textContent.endsWith("·"), `${id}: no dangling separator when there is no modifier to append`);
  }

  game.galaxy = null;
});

test("the dossier line shows even for a still-unexplored world — charted geography, not fog-gated intel", () => {
  const g = createGalaxy({ seed: 3 });
  game.galaxy = g;
  renderStarmap();

  const unexplored = g.worlds.find(w => w !== g.activeId);
  const node = worldNode(g, unexplored);
  assert.ok(node.className.includes("unexplored"), "sanity: this world really is unexplored");
  const deps = node.querySelector(".sm-deps");
  assert.ok(deps && deps.textContent.length > 0, "the deposit dossier is shown even before you've ever visited");

  game.galaxy = null;
});

test("renderStarmap is a no-op with no galaxy — never throws", () => {
  game.galaxy = null;
  assert.doesNotThrow(() => renderStarmap());
});
