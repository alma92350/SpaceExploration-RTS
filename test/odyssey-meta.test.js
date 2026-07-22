/* ============================================================
   Odyssey meta-layer fixes (Tier 2 review): a re-founded colony re-arms its alerts, a
   background world's war declaration is surfaced, the world roster is repaired on load of
   an older save, and pacifying every world is celebrated.
   ============================================================ */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, sweepColonies, checkDomination, ODYSSEY_WORLDS } from "../engine/galaxy.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { makeBuilding } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";

function backgroundColony(g, id) {
  const colony = addPlanet(g, id, { unsettled: true });
  colony.background = true;
  const cc = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  colony.buildings.set(cc.id, cc);
  colony.events.length = 0;
  return colony;
}

test("a re-founded colony re-arms its lost alert (the latch no longer mutes it forever)", () => {
  const g = createGalaxy({ seed: 50 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  sweepColonies(g, 0.1);                                   // records hadColony

  const razeAll = () => { for (const b of [...colony.buildings.values()]) if (b.owner === "player") colony.buildings.delete(b.id); };
  razeAll();
  assert.ok(sweepColonies(g, 0.1).some(n => n.type === "lost" && n.planetId === id), "first loss fires a lost note");

  const cc2 = makeBuilding("command", "player", colony.map.bases.player.x, colony.map.bases.player.y);
  colony.buildings.set(cc2.id, cc2);
  sweepColonies(g, 0.1);                                   // rebuilt → latch resets
  razeAll();
  assert.ok(sweepColonies(g, 0.1).some(n => n.type === "lost" && n.planetId === id),
    "a SECOND loss after rebuilding fires again (was permanently muted before)");
});

test("a background colony surfaces its neighbour's war declaration instead of silently draining it", () => {
  const g = createGalaxy({ seed: 51 });
  const id = g.worlds.find(w => w !== g.activeId);
  const colony = backgroundColony(g, id);
  colony.events.push({ type: "neighbourHostile" });       // the diplomacy event that used to have no consumer
  const notes = sweepColonies(g, 0.1);
  assert.ok(notes.some(n => n.type === "hostile" && n.planetId === id), "the war declaration surfaces as a hostile note");
});

test("loading an older galaxy save repairs the world roster (the newer worlds reappear)", () => {
  const g = createGalaxy({ seed: 52 });
  for (const u of [...activeState(g).units.values()]) if (u.type === "colonyship") deployColonyShip(activeState(g), u.id);
  const save = JSON.parse(JSON.stringify(serializeGalaxy(g)));
  const extras = ODYSSEY_WORLDS.slice(9);                 // kybernet/verdani, appended after the skirmish nine
  assert.ok(extras.length >= 1, "there ARE worlds beyond the skirmish nine");
  save.worlds = ODYSSEY_WORLDS.slice(0, 9);               // simulate a pre-Phase-4 roster missing them
  const g2 = deserializeGalaxy(save);
  for (const id of extras) assert.ok(g2.worlds.includes(id), `${id} reappears on load so it can tick and show on the map`);
});

test("pacifying every world fires the grand domination:all milestone", () => {
  const g = createGalaxy({ seed: 53 });
  for (const id of g.worlds) if (!g.planets.has(id)) addPlanet(g, id, { unsettled: true });
  // Strip every AI foothold everywhere → every world is pacified.
  for (const [, s] of g.planets) {
    for (const b of [...s.buildings.values()]) if (b.owner === "ai") s.buildings.delete(b.id);
    for (const [uid, u] of [...s.units]) if (u.owner === "ai") s.units.delete(uid);
  }
  checkDomination(g);
  assert.equal(g.pacified.size, g.worlds.length, "every world is pacified");
  assert.ok(g.reached.has("domination:all"), "the every-world milestone is reached (not just the 4-world one)");
  assert.ok(g.reached.has("domination"), "…and the earlier 4-world milestone too");
});
