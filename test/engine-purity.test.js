import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The sim's determinism rests on the engine drawing ALL randomness from the one
// seeded rng (engine/rng.js) and never reading the wall clock. This guard scans
// engine/*.js for the usual nondeterminism leaks so a future edit can't quietly
// reintroduce one — the kind of regression the same-seed-twice test can only
// catch by luck. A line that is genuinely not the sim (an unseeded map default,
// the render loop's wall clock) opts out with a `deterministic-exempt` comment.
const engineDir = join(dirname(fileURLToPath(import.meta.url)), "..", "engine");
const FORBIDDEN = /\bMath\.random\b|\bDate\.now\b|\bnew Date\b|\bperformance\.now\b/;

test("engine/ contains no unsanctioned nondeterminism (Math.random / Date / performance.now)", () => {
  const offenders = [];
  for (const file of readdirSync(engineDir)) {
    if (!file.endsWith(".js")) continue;
    readFileSync(join(engineDir, file), "utf8").split("\n").forEach((line, i) => {
      if (FORBIDDEN.test(line) && !line.includes("deterministic-exempt")) {
        offenders.push(`${file}:${i + 1}  ${line.trim()}`);
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
  for (const file of readdirSync(engineDir)) {
    if (!file.endsWith(".js")) continue;
    const raw = readFileSync(join(engineDir, file), "utf8").split("\n");
    stripComments(raw.join("\n")).split("\n").forEach((code, i) => {
      // Match on the comment-free code, but read the exempt marker off the original line
      // (the marker lives in a comment, which stripping removed).
      if (BROWSER_GLOBAL.test(code) && !raw[i].includes("browser-exempt")) {
        offenders.push(`${file}:${i + 1}  ${raw[i].trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    "browser/DOM reference(s) in engine/ — the engine must stay pure logic (move UI code to a " +
    "non-engine module), or mark a genuine render-loop seam `browser-exempt`:\n" + offenders.join("\n"));
});
