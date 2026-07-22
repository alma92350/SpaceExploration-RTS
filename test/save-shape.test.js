import { test } from "node:test";
import assert from "node:assert/strict";
import { isGalaxySave, resumableMode } from "../saveShape.js";

// These two decisions live in saveShape.js precisely so they can be tested without the DOM: a
// wrong branch here is a data-loss bug — an Odyssey save booted as a skirmish, or a scenario
// silently checkpointed over the player's real game.

test("isGalaxySave: a save with a planets array is an Odyssey galaxy, everything else a skirmish", () => {
  assert.equal(isGalaxySave({ v: 1, planets: [{ planetId: "ferros" }] }), true, "galaxy: has planets[]");
  assert.equal(isGalaxySave({ v: 1, planets: [] }), true, "even an empty planets array is the galaxy shape");
  assert.equal(isGalaxySave({ v: 1, seed: 5, units: [] }), false, "a skirmish carries no planets");
  assert.equal(isGalaxySave({ planets: { ferros: {} } }), false, "planets must be an ARRAY, not an object");
  assert.equal(isGalaxySave(null), false, "null is not a galaxy");
  assert.equal(isGalaxySave(undefined), false, "undefined is not a galaxy");
});

test("resumableMode: reports the checkpoint mode, or null when nothing is resumable", () => {
  assert.equal(resumableMode({ state: { over: false } }), "skirmish", "a live skirmish resumes as a skirmish");
  assert.equal(resumableMode({ state: { over: false }, galaxy: { seed: 1 } }), "galaxy",
    "a live game with a galaxy resumes as an Odyssey");

  assert.equal(resumableMode({ state: null }), null, "no state → nothing to resume");
  assert.equal(resumableMode({}), null, "an empty game handle → nothing to resume");
  assert.equal(resumableMode(), null, "no game handle at all → nothing to resume");
  assert.equal(resumableMode({ state: { over: true } }), null, "a finished match is not resumable");
  assert.equal(resumableMode({ state: { scenario: "escort" } }), null, "a scripted scenario can't be checkpointed");
  assert.equal(resumableMode({ state: { over: true }, galaxy: { seed: 1 } }), null,
    "a finished game is not resumable even in Odyssey mode");
});
