/* ============================================================
   Keeps engine/types.js honest about the shapes it claims to describe.

   CONTRIBUTING.md: "When you add or rename a field on a core shape, update its @typedef in
   engine/types.js in the same change." That rule was broken repeatedly and silently — twenty
   fields across seven typedefs had drifted out of the model, including State.playerAi, the
   central field of the self-play feature, omitted by the very commit that added it.

   Nothing caught it because the drift is INVISIBLE to the type checker: every factory assigns
   to a `const` before returning, so TypeScript never runs an excess-property check, and
   `checkJs` is off for files without the pragma. Worse, drift actively BLOCKS type adoption —
   annotating one function in engine/supply.js with @param {State} produced three errors in
   correct code, which teaches contributors that the checker is wrong.

   So this compares the declared @property names against the keys the factories ACTUALLY
   construct, at runtime. Runtime keys, not a text parse of the literal: it can't be fooled by
   formatting, and it is exactly the set a `// @ts-check`ed caller will try to read.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { createGameState, createAiController } from "../engine/state.js";
import { createDiplomacy } from "../engine/diplomacy.js";
import { createGalaxy } from "../engine/galaxy.js";
import { walkJs } from "./_helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesSrc = readFileSync(join(root, "engine", "types.js"), "utf8");

// The @property names declared under one `@typedef {Object} <Name>` block. A block runs to the
// end of its JSDoc comment, so a later typedef's properties can't leak in.
function declaredProps(typedefName) {
  const start = typesSrc.indexOf(`@typedef {Object} ${typedefName}\n`);
  assert.notEqual(start, -1, `engine/types.js declares no @typedef {Object} ${typedefName}`);
  const block = typesSrc.slice(start, typesSrc.indexOf("*/", start));
  return new Set([...block.matchAll(/@property\s+\{.*\}\s+\[?([A-Za-z_$][\w$]*)\]?/g)].map(m => m[1]));
}

const CASES = [
  ["State", () => createGameState({ planetId: "ferros", seed: 1 })],
  ["AiState", () => createAiController("ferros")],
  ["Diplomacy", () => createDiplomacy()],
  ["Galaxy", () => createGalaxy({ seed: 1 })],
  ["GalaxySettings", () => createGalaxy({ seed: 1 }).settings],
];

for (const [name, build] of CASES) {
  test(`every field ${name}'s factory constructs is declared on the ${name} typedef`, () => {
    const declared = declaredProps(name);
    const constructed = Object.keys(build()).sort();
    assert.ok(constructed.length > 0, `fixture sanity: the ${name} factory returned an empty object`);
    assert.deepEqual(constructed.filter(k => !declared.has(k)), [],
      `engine/types.js's ${name} typedef is missing @property lines for field(s) its factory ` +
      `constructs — a // @ts-check'ed caller reading one gets a spurious error in correct code`);
  });
}

test("every // @ts-check file actually annotates its exported functions", () => {
  // The pragma alone buys nothing. jsconfig.json sets strict:false and noImplicitAny:false, so an
  // un-annotated `state`/`unit`/`building` param is `any` — measured, twelve of the biggest engine
  // files (sim.js, persist.js, combat.js among them) can adopt the pragma for ZERO errors and gain
  // zero checking. engine/recycle.js was already in exactly that state in-tree: pragma on line 1,
  // seven exports, not one @param. Without this guard a coverage push raises the percentage and
  // catches nothing. Annotation density is the real metric, so that is what's asserted.
  const bare = [];
  for (const file of walkJs(root)) {
    const rel = relative(root, file);
    if (rel.startsWith("test" + sep) || rel.startsWith("tools" + sep)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    if (!lines[0].includes("@ts-check")) continue;
    lines.forEach((line, i) => {
      const m = line.match(/^export (?:async )?function (\w+)/);
      if (!m) return;
      let j = i - 1, doc = "";
      while (j >= 0 && /^\s*(\*|\/\*)/.test(lines[j])) { doc = lines[j] + "\n" + doc; j--; }
      if (!/@(param|returns)\s*\{/.test(doc)) bare.push(`${rel} → ${m[1]}`);
    });
  }
  assert.deepEqual(bare, [],
    "exported function(s) in a // @ts-check'ed file with no typed @param/@returns — the pragma is " +
    "on but checks nothing for them:\n" + bare.join("\n"));
});

test("the contract check actually bites — an undeclared field is reported by name", () => {
  // Without this, the tests above would keep passing if declaredProps ever silently returned
  // "everything" (a broken regex, a renamed typedef). Give it an object carrying a field no
  // typedef declares and require it to be named.
  const declared = declaredProps("Diplomacy");
  assert.ok(declared.has("stance"), "sanity: the parser found a known Diplomacy property");
  const withExtra = { ...createDiplomacy(), notADeclaredField: 1 };
  assert.deepEqual(Object.keys(withExtra).filter(k => !declared.has(k)), ["notADeclaredField"]);
});
