import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDINGS, UNITS, UPGRADES } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";

// `requires` is a stringly-typed union: a token is EITHER a building-type key (a completed building of
// that type) OR a research/upgrade id (a purchased UPGRADES entry or a researched TECHS node). It's
// resolved only at read time (entities.js prereqsMet) with no lookup table, so a typo — "assmbler"
// for "assembler", "arsenl" for "arsenal" — raises no error: prereqsMet just never matches it, and
// the def becomes PERMANENTLY unbuildable with no diagnostic. This static guard resolves every token
// on every def against the real key sets so a bad `requires` fails the suite loudly, naming the culprit.

test("every `requires` token on a building/unit def resolves to a real building type or research/upgrade token", () => {
  // The full set of legal tokens: building types + upgrade ids + tech ids — exactly the universe
  // prereqsMet checks (BUILDINGS[req] for the building branch, player.upgrades[req] for the rest,
  // which UPGRADES and TECHS both write into on completion).
  const known = new Set([...Object.keys(BUILDINGS), ...Object.keys(UPGRADES), ...Object.keys(TECHS)]);

  const bad = [];
  for (const [group, defs] of [["BUILDINGS", BUILDINGS], ["UNITS", UNITS]]) {
    for (const [key, def] of Object.entries(defs)) {
      for (const token of def.requires || []) {
        if (!known.has(token)) bad.push(`${group}.${key} requires "${token}" (unresolvable — not a building/upgrade/tech)`);
      }
    }
  }

  assert.deepEqual(bad, [], "unresolvable `requires` token(s) — a typo makes the def permanently unbuildable:\n" + bad.join("\n"));
});
