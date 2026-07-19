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
