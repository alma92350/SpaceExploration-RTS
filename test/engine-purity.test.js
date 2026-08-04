import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";
import { walkJs } from "./_helpers.js";

// The sim's determinism rests on the engine drawing ALL randomness from the one
// seeded rng (engine/rng.js) and never reading the wall clock. This guard scans
// the engine for the usual nondeterminism leaks so a future edit can't quietly
// reintroduce one — the kind of regression the same-seed-twice test can only
// catch by luck. A line that is genuinely not the sim (an unseeded map default,
// the render loop's wall clock) opts out with a `deterministic-exempt` comment.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "engine");
const FORBIDDEN = /\bMath\.random\b|\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/;
const SPEC = /(?:import|export)[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

// The purity rules are transitive: the engine's determinism guarantee is only as strong as the
// modules it imports. `data.js` lives at the repo ROOT but is imported by nine engine modules
// (and is the repo's second-most-imported file), so a `Date.now()`-seeded default in a PLANETS
// entry would break same-seed replays while this guard stayed green and determinism.test.js
// failed cryptically, pointing away from the culprit. So: walk engine/ at every depth, then
// follow relative imports out of it to their fixed point. A side benefit — if an engine file
// ever imports a UI module, that module's DOM references fail the scan below, which is exactly
// the right alarm for an engine→view leak.
function purityScanFiles() {
  const files = walkJs(engineDir);
  const seen = new Set(files);
  for (let i = 0; i < files.length; i++) {
    const src = readFileSync(files[i], "utf8");
    for (const m of src.matchAll(SPEC)) {
      const path = m[1] || m[2];
      if (!path || !path.startsWith(".")) continue;
      const abs = resolve(dirname(files[i]), path);
      if (!abs.endsWith(".js") || seen.has(abs) || !existsSync(abs)) continue;
      seen.add(abs);
      files.push(abs);
    }
  }
  return files;
}

const label = f => relative(root, f);

test("the purity scan reaches every engine file at any depth, plus what the engine imports", () => {
  // A guard on the guards below. Both scans used a non-recursive readdirSync over engine/ only:
  // a file at engine/net/lockstep.js calling Math.random, Date.now, window.localStorage AND
  // document passed all of them. This pins the file set itself so that can't come back.
  const scanned = purityScanFiles().map(label);
  assert.ok(scanned.includes("engine/sim.js"), "the scan must cover engine/ itself");
  assert.ok(scanned.includes("data.js"),
    "the scan must follow the engine's own imports out of engine/ — data.js is imported by nine engine modules");
  assert.deepEqual(
    walkJs(engineDir).map(label).filter(f => !scanned.includes(f)), [],
    "every .js under engine/, at any depth, must be scanned");
});

test("engine/ contains no unsanctioned nondeterminism (Math.random / Date / performance.now)", () => {
  const offenders = [];
  for (const file of purityScanFiles()) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (FORBIDDEN.test(line) && !line.includes("deterministic-exempt")) {
        offenders.push(`${label(file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "nondeterministic call(s) in engine/ — route randomness through a seeded rng, or mark the line " +
    "`deterministic-exempt` if it genuinely isn't the sim:\n" + offenders.join("\n"));
});

// The engine is meant to be pure logic — no DOM, no browser globals — so the whole sim
// runs headless under `node --test` and could one day run server-side (netcode, replays).
// This guard catches a DOM/browser dependency creeping in (a stray `document.querySelector`,
// a `localStorage` read, a `fetch`). Unlike the determinism guard above it scans CODE ONLY:
// words like "window" (grace window) and "fetch" (fetch a colony ship) appear legitimately in
// prose, so comments are stripped first (newline-preserving, to keep line numbers). The one
// sanctioned browser seam — loop.js's requestAnimationFrame render driver, which touches no sim
// state — opts each line out with a `browser-exempt` marker.
const BROWSER_GLOBAL = /\b(document|window|localStorage|sessionStorage|navigator|XMLHttpRequest|requestAnimationFrame|cancelAnimationFrame|alert|history|location)\b|\bfetch\s*\(/;

// Blank out comments while preserving line count and columns: block comments become spaces
// (newlines kept), line comments are trimmed to end-of-line. Good enough for a source guard —
// engine code never hides a DOM call inside a string literal.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "))
    .split("\n").map(l => l.replace(/\/\/.*$/, "")).join("\n");
}

test("engine/ has no DOM or browser-global dependency (stays headless-pure)", () => {
  const offenders = [];
  for (const file of purityScanFiles()) {
    const raw = readFileSync(file, "utf8").split("\n");
    stripComments(raw.join("\n")).split("\n").forEach((code, i) => {
      // Match on the comment-free code, but read the exempt marker off the original line
      // (the marker lives in a comment, which stripping removed).
      if (BROWSER_GLOBAL.test(code) && !raw[i].includes("browser-exempt")) {
        offenders.push(`${label(file)}:${i + 1}  ${raw[i].trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "browser/DOM reference(s) in engine/ — the engine must stay pure logic (move UI code to a " +
    "non-engine module), or mark a genuine render-loop seam `browser-exempt`:\n" + offenders.join("\n"));
});
