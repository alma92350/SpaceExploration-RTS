import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, checkDomination, galaxyStatus, DOMINATION_TARGET } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding } from "../engine/state.js";

// Eliminate the AI's foothold on a world — its Command Center AND its (undeployed)
// colony ship. A world isn't conquered while the neighbour still holds a colony ship it
// could re-found from (engine/galaxy.js hasAiCommand), so razing only the CC no longer
// pacifies — you must also destroy the ship, which is what "drove them off" means now.
function razeAiCommand(state) {
  for (const [id, b] of [...state.buildings]) if (b.owner === "ai" && b.type === "command") state.buildings.delete(id);
  for (const [id, u] of [...state.units]) if (u.owner === "ai" && u.type === "colonyship") state.units.delete(id);
}

test("razing a neighbour's Command Center pacifies that world (and queues a toast)", () => {
  const g = createGalaxy({ seed: 30 });
  assert.equal(galaxyStatus(g).pacified, 0, "nothing conquered at the start");
  razeAiCommand(activeState(g));
  checkDomination(g);
  assert.ok(g.pacified.has(g.activeId), "the world is pacified once its capital falls");
  assert.equal(galaxyStatus(g).pacified, 1);
  assert.ok(g.pacifyNotes.includes(g.activeId), "and is queued for a UI toast");
});

test("pacification is sticky — a rebuilt capital can't un-conquer a world", () => {
  const g = createGalaxy({ seed: 31 });
  const s = activeState(g);
  razeAiCommand(s);
  checkDomination(g);
  assert.ok(g.pacified.has(g.activeId));
  const cc = makeBuilding("command", "ai", 100, 100);   // the neighbour rebuilds
  s.buildings.set(cc.id, cc);
  checkDomination(g);
  assert.ok(g.pacified.has(g.activeId), "still conquered — pacification is permanent");
  assert.ok(!activeState(g).over, "one world is not a Domination win");
});

test("conquering DOMINATION_TARGET worlds wins by Domination", () => {
  const g = createGalaxy({ seed: 32 });
  for (const id of g.worlds.slice(0, DOMINATION_TARGET)) {
    const s = g.planets.get(id) || addPlanet(g, id);   // visit it (seeds an AI capital)...
    razeAiCommand(s);                                   // ...then raze that capital
  }
  checkDomination(g);
  assert.equal(g.pacified.size, DOMINATION_TARGET);
  assert.ok(activeState(g).over && activeState(g).winner === "player", "the galaxy is conquered");
  assert.equal(g.wonBy, "domination", "won by the military path, not the Gate");
});

test("a fresh, un-razed world is never accidentally pacified", () => {
  const g = createGalaxy({ seed: 34 });
  addPlanet(g, g.worlds.find(w => w !== g.activeId));   // a visited world with its AI capital intact
  checkDomination(g);
  assert.equal(g.pacified.size, 0, "no capital razed → nothing conquered");
});

test("Domination progress survives a save/load", () => {
  const g = createGalaxy({ seed: 33 });
  razeAiCommand(activeState(g));
  checkDomination(g);
  assert.equal(g.pacified.size, 1);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  assert.ok(restored.pacified.has(g.activeId), "the conquered world persists");
  assert.equal(restored.pacified.size, 1);
});
