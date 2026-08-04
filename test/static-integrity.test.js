import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep } from "node:path";
import { walkJs } from "./_helpers.js";

// This project has NO build step — the files in the repo are the files the browser loads. So a
// syntax slip, a mistyped element id, or an import pointing at a moved file isn't caught by a
// compiler; it's a blank white screen the moment someone opens index.html. These are cheap
// static guards that turn each of those silent breakages into a failing test.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every JS file the app ships, at any depth: the root modules, the engine, and tools/. This used
// to list exactly two directories non-recursively, so anything in a subdirectory escaped the
// parse check and the import check together. (test/ is excluded — `node --test` already parses
// and runs it. docs/ and dot-directories carry no shipped code.)
function shippedJs() {
  return walkJs(root).filter(f => !relative(root, f).startsWith("test" + sep));
}

// The subset the BROWSER loads: shipped code minus tools/, which are Node CLI benches
// (tools/ailab.js, tools/selfplay.js, tools/serve.js) that index.html never reaches.
function browserJs() {
  return shippedJs().filter(f => !relative(root, f).startsWith("tools" + sep));
}

// Every way a module can name another module: `... from "x"`, `import("x")`, and the bare
// SIDE-EFFECT form `import "x"`. That last alternative is load-bearing and was missing: main.js
// reaches starmap.js, techChart.js and update.js only through side-effect imports (they self-wire
// their buttons and hotkeys at module-load time), so a regex without it both misreports them as
// unreachable and would miss a side-effect import left pointing at a deleted file.
const IMPORT_SPEC = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
const specPath = m => m[1] || m[2] || m[3];

test("every shipped .js file parses (no syntax errors reach the browser)", () => {
  const broken = [];
  for (const file of shippedJs()) {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (e) {
      broken.push(`${file.replace(root + "/", "")}: ${String(e.stderr || e.message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(broken, [], "syntax error(s) in shipped JS:\n" + broken.join("\n"));
});

// Assets index.html points at, as (attr, path) pairs. Kept as a function over a STRING rather
// than over the file so the test below can prove it actually reports a miss — pointing a
// resolver at a known-good tree only ever proves it stays quiet.
function htmlAssetRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(m => m[1])
    .filter(p => p && !/^(https?:)?\/\//.test(p) && !p.startsWith("data:") && !p.startsWith("#") && !p.startsWith("/"));
}

test("every asset index.html references exists on disk", () => {
  // index.html IS the entry point — there is no build step and no bundler to catch a rename.
  // Verified: changing `src="main.js"` to `src="mian.js"` used to survive the entire suite on
  // both Node versions plus the typecheck, and ship a blank white screen.
  const html = readFileSync(join(root, "index.html"), "utf8");
  const refs = htmlAssetRefs(html);
  assert.ok(refs.includes("main.js") && refs.includes("style.css"),
    "sanity: the resolver should see index.html's own script and stylesheet");
  assert.deepEqual(refs.filter(p => !existsSync(resolve(root, p))), [],
    "index.html references file(s) that don't exist — the page would load broken or blank");

  // And prove the resolver bites, so this test can never quietly become a no-op.
  const typo = htmlAssetRefs('<script type="module" src="mian.js"></script>');
  assert.deepEqual(typo.filter(p => !existsSync(resolve(root, p))), ["mian.js"],
    "the resolver must report a missing asset, not silently skip it");
});

test("every shipped browser module is reachable from index.html's entry point", () => {
  // With no build step, a module nobody imports is not a link error — it's a feature that
  // silently does nothing. This shipped: commit 2a07a69 fixed "Tech & Industry Chart never
  // opening: main.js never imported it", where the 📊 button and the T hotkey did nothing at all
  // and it was found by a human clicking. main.js still carries three side-effect-only imports
  // (starmap, techChart, update) whose whole purpose is reachability, and seven modules attach
  // their listeners at module-load time.
  const html = readFileSync(join(root, "index.html"), "utf8");
  const entries = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map(m => resolve(root, m[1]));
  assert.ok(entries.length >= 1, "index.html must declare at least one module entry point");

  const reached = new Set(entries);
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (!existsSync(file)) continue;                       // the test above owns missing-file reporting
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT_SPEC)) {
      const path = specPath(m);
      if (!path || !path.startsWith(".")) continue;
      const abs = resolve(dirname(file), path);
      if (reached.has(abs)) continue;
      reached.add(abs);
      queue.push(abs);
    }
  }

  // engine/types.js is JSDoc typedefs with no runtime code; it says so itself and is never
  // imported by design. tools/ are Node CLI benches, not browser code.
  const EXEMPT = new Set(["engine/types.js"]);
  const orphans = browserJs()
    .map(f => relative(root, f))
    .filter(f => !EXEMPT.has(f) && !reached.has(join(root, f)));
  assert.deepEqual(orphans, [],
    "shipped module(s) no import chain reaches from index.html — their code never runs in the browser:\n" +
    orphans.join("\n"));
});

test("every getElementById reference resolves to a real element id", () => {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

  // Some elements are built at runtime (e.g. the update banner) rather than living in index.html;
  // a JS `el.id = "foo"` assignment is a legitimate source of an id too. Allow those.
  const dynamicIds = new Set();
  const jsFiles = shippedJs();
  for (const f of jsFiles)
    for (const m of readFileSync(f, "utf8").matchAll(/\.id\s*=\s*["']([^"']+)["']/g)) dynamicIds.add(m[1]);

  const dangling = [];
  for (const f of jsFiles) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/getElementById\(["']([^"']+)["']\)/g)) {
      const id = m[1];
      if (!htmlIds.has(id) && !dynamicIds.has(id)) dangling.push(`${f.replace(root + "/", "")} → #${id}`);
    }
  }
  assert.deepEqual(dangling, [],
    "getElementById targets that exist in no HTML and are never created in JS (typo or removed element):\n" +
    dangling.join("\n"));
});

test("every relative import points at a file that exists", () => {
  const missing = [];
  for (const f of shippedJs()) {
    const src = readFileSync(f, "utf8");
    const dir = dirname(f);
    for (const m of src.matchAll(IMPORT_SPEC)) {
      const path = specPath(m);
      if (!path || !path.startsWith(".")) continue;    // bare/absolute specifiers aren't ours to resolve
      if (!existsSync(resolve(dir, path)))
        missing.push(`${f.replace(root + "/", "")} → ${path}`);
    }
  }
  assert.deepEqual(missing, [], "import(s) pointing at a file that no longer exists:\n" + missing.join("\n"));
});

// Regression guard for a real bug: data.js and engine/factions.js used to BOTH export a
// binding named `FACTIONS` (different shapes — lore/UI flavor vs. real gameplay traits), and
// coexisted only because every importer happened to grab the right one. data.js's export was
// renamed to LORE_FACTIONS so the two names can never again be confused for one another at an
// import site.
test("data.js's lore-flavor faction data has its own name — no duplicate FACTIONS export shared with engine/factions.js", () => {
  const dataSrc = readFileSync(join(root, "data.js"), "utf8");
  assert.match(dataSrc, /export const LORE_FACTIONS\s*=/,
    "data.js should export LORE_FACTIONS (its lore/UI faction flavor data: name/ico/color/desc)");
  assert.doesNotMatch(dataSrc, /export const FACTIONS\s*=/,
    "data.js must not export a FACTIONS binding — engine/factions.js already owns that name for the real playable-faction gameplay data");

  // No shipped file may import a `FACTIONS` binding FROM data.js (only LORE_FACTIONS); a bare
  // `FACTIONS` import is only valid from engine/factions.js.
  const offenders = [];
  for (const f of shippedJs()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*\bdata\.js)["']/g)) {
      if (/\bFACTIONS\b/.test(m[1])) offenders.push(`${f.replace(root + "/", "")} imports { FACTIONS } from ${m[2]}`);
    }
  }
  assert.deepEqual(offenders, [], "stale import of data.js's old FACTIONS name (should be LORE_FACTIONS):\n" + offenders.join("\n"));
});

// Regression guard: boot.js used to keep its own hand-maintained easy/medium/hard -> {aiApm,
// aiMicro} map, entirely separate from the list driving the Easy/Medium/Hard picker. If the two
// ever drifted — a difficulty key added to one list but not the other —
// `DIFFICULTY[setup.difficulty] || DIFFICULTY.medium` silently downgraded an unrecognised
// difficulty to Medium instead of erroring. engine/aiDifficulty.js's DIFFICULTY_OPTIONS is the
// one list carrying the AI dials (and, going forward, any economic difficulty fields) — setup.js
// imports it for the picker rather than keeping its own copy, and boot.js derives from it too.
test("engine/aiDifficulty.js's DIFFICULTY_OPTIONS is the single source of every difficulty's AI dials; setup.js and boot.js derive from it", () => {
  const difficultySrc = readFileSync(join(root, "engine", "aiDifficulty.js"), "utf8");
  const setupSrc = readFileSync(join(root, "setup.js"), "utf8");
  const bootSrc = readFileSync(join(root, "boot.js"), "utf8");

  const optionsBlock = difficultySrc.match(/export const DIFFICULTY_OPTIONS\s*=\s*\[([\s\S]*?)\n\];/);
  assert.ok(optionsBlock, "engine/aiDifficulty.js must export DIFFICULTY_OPTIONS");
  const entries = [...optionsBlock[1].matchAll(/\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(entries.length >= 3, "expected at least the three Easy/Medium/Hard entries");
  for (const entry of entries) {
    assert.match(entry, /mult:\s*"[a-z]+"/, `difficulty option missing its key: ${entry}`);
    assert.match(entry, /aiApm:\s*\d+/, `difficulty option missing its aiApm dial (must live in the canonical list): ${entry}`);
    assert.match(entry, /aiMicro:\s*(true|false)/, `difficulty option missing its aiMicro dial (must live in the canonical list): ${entry}`);
  }

  assert.doesNotMatch(setupSrc, /export const DIFFICULTY_OPTIONS\s*=\s*\[/,
    "setup.js must not keep its own copy of DIFFICULTY_OPTIONS — that duplication is exactly the drift this guards against");
  assert.match(setupSrc, /import\s*\{[^}]*\bDIFFICULTY_OPTIONS\b[^}]*\}\s*from\s*["']\.\/engine\/aiDifficulty\.js["']/,
    "setup.js should import DIFFICULTY_OPTIONS from engine/aiDifficulty.js");
  assert.match(bootSrc, /import\s*\{[^}]*\bDIFFICULTY_OPTIONS\b[^}]*\}\s*from\s*["']\.\/setup\.js["']/,
    "boot.js should import DIFFICULTY_OPTIONS from setup.js rather than hardcoding its own difficulty list");
  assert.doesNotMatch(bootSrc, /easy:\s*\{\s*aiApm/,
    "boot.js must not keep its own separate easy/medium/hard -> {aiApm,aiMicro} map (that duplication is exactly the drift this guards against)");
});

// Regression guard: boot.js used to copy-paste the exact seed-resolution expression
// `(setup.seed != null ? setup.seed : Math.floor(Math.random()*0x100000000)) >>> 0` at five
// separate call sites (startGame, startScenario, startRaider, startBounty, startOdyssey) — one
// fix to the replay-determinism logic could easily miss the other four. It's now a single
// named helper (resolveSeed) called from all five.
test("boot.js resolves the seed through one shared helper, not copy-pasted at every call site", () => {
  const bootSrc = readFileSync(join(root, "boot.js"), "utf8");
  const rawExpr = "Math.floor(Math.random() * 0x100000000)) >>> 0";
  const rawOccurrences = bootSrc.split(rawExpr).length - 1;
  assert.equal(rawOccurrences, 1,
    `the seed-resolution expression should appear exactly once now (inside its helper), found ${rawOccurrences} — it must not be copy-pasted at call sites again`);

  const helperCalls = [...bootSrc.matchAll(/\bresolveSeed\(setup\)/g)].length;
  assert.ok(helperCalls >= 5,
    `expected resolveSeed(setup) to be called at every start* site (>=5: skirmish, escort, raider, bounty, Odyssey), found ${helperCalls}`);
});
