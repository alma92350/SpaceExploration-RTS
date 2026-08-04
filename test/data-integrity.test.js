import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILDINGS, UNITS, UPGRADES } from "../engine/entities.js";
import { TECHS } from "../engine/techtree.js";
import { COM, RECIPES, PLANETS } from "../data.js";
import { ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { PLANET_ARCHETYPE, ODYSSEY_EXTRA_ARCHETYPE } from "../engine/aiArchetypes.js";

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

/* ---- C11: the other three data<->engine seams ------------------------------------------------
   The `requires`-token test above guards ONE stringly-typed cross-reference, and its own header
   explains why that matters: the reference "is resolved only at read time … with no lookup table,
   so a typo … raises no error". Three more seams have exactly that shape and nothing guarding
   them. All are clean today; these are the tests that keep them that way as the tables grow. */

test("every commodity key on a cost/upkeep/consumes/inputs resolves to a real COM id", () => {
  const bad = [];
  const check = (where, bag) => {
    if (!bag || typeof bag !== "object") return;
    for (const com of Object.keys(bag)) if (!COM[com] && com !== "energy") bad.push(`${where} → ${com}`);
  };
  for (const [table, defs] of [["BUILDINGS", BUILDINGS], ["UNITS", UNITS], ["UPGRADES", UPGRADES], ["TECHS", TECHS]])
    for (const [id, def] of Object.entries(defs))
      for (const field of ["cost", "altCost", "upkeep", "consumes", "inputs"])
        check(`${table}.${id}.${field}`, def[field]);
  for (const [id, r] of Object.entries(RECIPES)) {
    check(`RECIPES.${id}.in`, r.in);
    if (r.out && !COM[r.out]) bad.push(`RECIPES.${id}.out → ${r.out}`);
  }
  assert.deepEqual(bad, [],
    "commodity key(s) naming no real COM id — canAfford would compare against an undefined balance:\n" + bad.join("\n"));
});

test("every id in BUILDINGS[*].produces is a real UNITS key", () => {
  const bad = [];
  for (const [id, def] of Object.entries(BUILDINGS))
    for (const t of def.produces || []) if (!UNITS[t]) bad.push(`BUILDINGS.${id}.produces → ${t}`);
  assert.deepEqual(bad, [],
    "produces entr(ies) naming no real unit — the build button would produce nothing:\n" + bad.join("\n"));
});

test("every ODYSSEY_WORLD is a real PLANETS id with an explicitly-mapped archetype", () => {
  // Asserting on archetypeFor's RETURN can't tell "explicitly balanced" from "fell through the
  // `|| ARCHETYPES.balanced` default", so check the maps themselves.
  const mapped = { ...PLANET_ARCHETYPE, ...ODYSSEY_EXTRA_ARCHETYPE };
  const unmapped = ODYSSEY_WORLDS.filter(w => !(w in mapped));
  const planetIds = new Set(PLANETS.map(p => p.id));   // PLANETS is an ARRAY of defs, not an id-keyed map
  const unknown = ODYSSEY_WORLDS.filter(w => !planetIds.has(w));
  assert.deepEqual(unknown, [], "Odyssey world(s) with no PLANETS entry");
  assert.deepEqual(unmapped, [],
    "Odyssey world(s) silently falling through to the balanced archetype default:\n" + unmapped.join("\n"));
});
