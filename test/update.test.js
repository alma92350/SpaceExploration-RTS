import { test } from "node:test";
import assert from "node:assert/strict";

/* ============================================================
   update.js is imported by ZERO tests anywhere in the suite before this file. Read in full
   before writing anything here: it exports two functions — checkForUpdate() (fetches
   version.json, compares it to APP_VERSION, and raises the banner unless dismissed) and
   showBanner(manifest) (builds the actual banner DOM, including the honest save-compatibility
   line, version.js saveImpact) — plus, at the very BOTTOM of the file, an UNCONDITIONAL
   module-scope kickoff:

     showVersionChip();
     setTimeout(checkForUpdate, 4000);
     setInterval(checkForUpdate, CHECK_INTERVAL_MS);      // CHECK_INTERVAL_MS = 30 minutes

   Unlike saveload.js's equivalent bottom section (its autosave timer/listener wiring), this one
   carries NO `typeof window !== "undefined"` guard. Confirmed EMPIRICALLY (not just by reading
   it) before touching the source: importing update.js as-is under plain `node --test` arms a
   real, never-cleared 30-minute setInterval — a live timer that keeps the event loop (and so
   `node --test`) alive indefinitely, well past every test in this file finishing. The fix
   (applied to update.js itself, in the SAME commit as this test file) wraps that whole kickoff
   block in `if (typeof window !== "undefined") { ... }` — textually identical in spirit to
   saveload.js's own guard around its autosave `setInterval`/`addEventListener` calls. Zero
   behavior change in the browser (where `window` always exists, so the guarded code still runs
   exactly as before); under Node, with `window` left undefined below, the whole block now simply
   never runs, and this file's own passing, fast (non-hanging) run is the proof.

   --- import setup -----------------------------------------------------------------------------
   update.js imports saveload.js (`import { storedSaveVersions } from "./saveload.js"`), which
   imports boot.js, which imports the same large transitive graph test/boot.test.js's and
   test/saveload.test.js's own header comments trace in full (render.js, minimap.js, hud.js,
   hudSelection.js, setup.js, input.js, engine/*, landingPicker.js, data.js, sound.js, …) — the
   identical unguarded module-scope DOM calls (hud.js's repairBtn/departBtn, boot.js's
   underAttackEl, saveload.js's own saveBtn/loadBtn/homeBtn) that test/saveload.test.js's own
   header comment traces and fixes with a fake `document`. The FakeElement/fakeDocument below is
   modelled on that same shape, extended with real children-tracking + prepend() + parent-based
   remove() (test/hudSelection.test.js's own FakeElement idiom, adapted the same way
   test/overlays.test.js's copy is) — needed to actually walk into the DOM tree showBanner builds
   and read back which of its three compat-message branches rendered, and to simulate a real
   click on its "Later" button (checkForUpdate's dismissal test below). `window` is deliberately
   left undefined throughout — every `typeof window !== "undefined"` guard anywhere in the whole
   imported graph (saveload.js's autosave timer, overlays.js's help-toggle wiring, and now
   update.js's own kickoff) stays off, so importing this module starts no real browser-only
   listener or timer.
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
  // Real per-instance parent tracking, same reasoning/shape as test/overlays.test.js's copy:
  // showBanner's own "replace any prior banner" line calls `.remove()` directly on an element,
  // and this file's dismissal test below needs a genuine `.prepend()` (banner.prepend into #app)
  // to actually land the built banner somewhere this test can walk back into.
  appendChild(c) { c._parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => { c._parent = this; this.children.push(c); }); }
  prepend(c) { c._parent = this; this.children.unshift(c); return c; }
  remove() {
    if (!this._parent) return;
    const i = this._parent.children.indexOf(this);
    if (i !== -1) this._parent.children.splice(i, 1);
    this._parent = null;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getContext() { return null; }
  click() { this.dispatchEvent(new Event("click")); }
}

function fakeDocument() {
  const byId = new Map();
  const body = new FakeElement("body");
  return {
    getElementById(id) { if (!byId.has(id)) byId.set(id, new FakeElement("div")); return byId.get(id); },
    createElement(tag) { return new FakeElement(tag); },
    body,
  };
}

globalThis.document = fakeDocument();

// A minimal in-memory localStorage — Node has no such global by default under plain `node --test`
// (test/saveload.test.js's own header comment confirms this empirically: bare `localStorage`
// throws, undeclared, on this Node install), and update.js's readDismissed/writeDismissed
// (and saveload.js's storedSaveVersions, which showBanner calls into) reference the bare global
// directly — not `globalThis.localStorage` — so assigning it here is enough to make it resolve.
function fakeLocalStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
  };
}
globalThis.localStorage = fakeLocalStorage();

const { checkForUpdate, showBanner } = await import("../update.js");
const SAVE_KEY = "stellarfrontier.save.v1";   // saveload.js's own literal key (pinned the same way
                                               // test/saveload.test.js's own "documented literal
                                               // storage keys" test does — not exported)

function resetApp() {
  document.getElementById("app").children.length = 0;
}
function appFirstChild() {
  return document.getElementById("app").children[0] || null;
}
// banner.children = [text, actions]; text.children = [head, notes?, compat] — update.js's own
// showBanner DOM order. Found by class, not position, so an unrelated reorder can't silently
// break this lookup.
function compatOf(banner) {
  const text = banner.children.find(c => c.className.includes("update-text"));
  return text.children.find(c => c.className.includes("update-compat"));
}

/* ---------- showBanner: the three save-compatibility message branches ---------- */

test("showBanner: a save older than the manifest's minimum renders the ⚠ at-risk warning", () => {
  resetApp();
  localStorage.clear();
  localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1 }));   // an old skirmish save
  const manifest = { version: "9.9.9", minSaveVersion: 5 };    // the new build can only read v5+

  showBanner(manifest);

  const banner = appFirstChild();
  assert.ok(banner && banner.id === "updateBanner", "sanity: a banner was actually built and attached");
  const compat = compatOf(banner);
  assert.ok(compat.className.includes("bad"), "the 'bad' class drives the at-risk styling");
  assert.equal(compat.textContent,
    "⚠ Your saved skirmish won't load in the new version — click Save to export it to a file first.");
  resetApp();
});

test("showBanner: a save that already meets the manifest's minimum renders the ✓ backward-compatible line", () => {
  resetApp();
  localStorage.clear();
  localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 9 }));   // well past the minimum
  const manifest = { version: "9.9.9", minSaveVersion: 1 };

  showBanner(manifest);

  const compat = compatOf(appFirstChild());
  assert.ok(compat.className.includes("ok"));
  assert.equal(compat.textContent, "✓ Backward compatible — your saved skirmish will carry over.");
  resetApp();
});

test("showBanner: no stored saves at all renders the neutral 'No saved games affected.' line", () => {
  resetApp();
  localStorage.clear();   // neither SAVE_KEY nor the Odyssey key is set -> storedSaveVersions() is {skirmish:null, odyssey:null}
  const manifest = { version: "9.9.9", minSaveVersion: 1 };

  showBanner(manifest);

  const compat = compatOf(appFirstChild());
  assert.ok(!compat.className.includes("bad") && !compat.className.includes("ok"),
    "neither compatibility class applies — this is the plain third branch");
  assert.equal(compat.textContent, "No saved games affected.");
  resetApp();
});

/* ---------- checkForUpdate: the exact-match dismissal check ---------- */

test("checkForUpdate: dismissing a version suppresses exactly that version, but a different (newer) one still shows", async () => {
  resetApp();
  localStorage.clear();
  let manifestVersion = "2.0.0";
  // checkForUpdate fetches `${MANIFEST_URL}?t=${Date.now()}` — the URL/cache option aren't the
  // point of this test, so the stub ignores its arguments and just serves whatever
  // `manifestVersion` currently is, letting the SAME closure answer differently across the three
  // calls below.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: manifestVersion, minSaveVersion: 1 }) });

  await checkForUpdate();
  const firstBanner = appFirstChild();
  assert.ok(firstBanner && firstBanner.id === "updateBanner", "nothing dismissed yet, and 2.0.0 is newer -> the banner shows");

  // Simulate the player clicking "Later" on it for real — update.js's own click handler is what
  // calls the module-private writeDismissed(manifest.version); exercised through its genuine DOM
  // wiring, not by poking the private localStorage key directly.
  const actions = firstBanner.children.find(c => c.className.includes("update-actions"));
  const later = actions.children.find(c => c.textContent === "Later");
  assert.ok(later, "sanity: found the real Later button");
  later.click();
  assert.equal(appFirstChild(), null, "clicking Later also removes the banner");

  await checkForUpdate();   // the EXACT same version again
  assert.equal(appFirstChild(), null,
    "readDismissed() === manifest.version -> the SAME version the player already dismissed must not show again");

  manifestVersion = "2.0.1";   // a different, newer release than the dismissed one
  await checkForUpdate();
  const secondBanner = appFirstChild();
  assert.ok(secondBanner && secondBanner.id === "updateBanner",
    "a DIFFERENT version — even though it's not the one that was dismissed — must still show");

  resetApp();
});
