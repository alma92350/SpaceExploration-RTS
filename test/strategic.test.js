import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";
import { updateProduction } from "../engine/industry.js";
import { queueProduction } from "../engine/production.js";
import { BUILDINGS, UNITS, prereqsMet } from "../engine/entities.js";
import { generateMap } from "../engine/map.js";
import { mulberry32 } from "../engine/rng.js";
import { ODYSSEY_WORLDS } from "../engine/galaxy.js";

// An endless world with a Reactor so the strategic forges have Power.
function odysseyState(planetId = "kybernet") {
  const s = createGameState({ planetId, endless: true });
  for (const u of [...s.units.values()]) if (u.type === "colonyship") deployColonyShip(s, u.id);   // settle: CC + workers + supply
  const reactor = makeBuilding("reactor", "player", 600, 480);
  s.buildings.set(reactor.id, reactor);
  return s;
}

test("the AI Foundry manufactures AI Cores from electronics + crystals in its larder", () => {
  const s = odysseyState();
  const f = makeBuilding("aifoundry", "player", 660, 520);
  f.input = { electronics: 100, crystals: 100 };   // inputs are carried into the local larder now
  s.buildings.set(f.id, f);
  for (let i = 0; i < 50; i++) updateProduction(s, f, 0.1);
  assert.ok((f.store?.ai || 0) > 0, "AI Cores got manufactured into its output buffer");
  assert.ok(f.input.electronics < 100, "…consuming electronics from its larder");
});

test("the Torpedo Works manufactures Plasma Torpedoes from antimatter + alloys + radioactives", () => {
  const s = odysseyState();
  const t = makeBuilding("torpedoworks", "player", 660, 520);
  t.input = { antimatter: 100, alloys: 100, radioactives: 100 };
  s.buildings.set(t.id, t);
  for (let i = 0; i < 50; i++) updateProduction(s, t, 0.1);
  assert.ok((t.store?.plasmatorp || 0) > 0, "Plasma Torpedoes got manufactured into its output buffer");
});

test("the Leviathan is built at a Star Dock, costed in strategic goods you must make", () => {
  const s = odysseyState();
  const dock = makeBuilding("stardock", "player", 660, 520);
  const hab = makeBuilding("habitat", "player", 700, 520);   // an 8-supply capital ship needs the room
  s.buildings.set(dock.id, dock);
  s.buildings.set(hab.id, hab);
  assert.equal(prereqsMet(s, "player", UNITS.leviathan), true, "a Star Dock unlocks the Leviathan");
  Object.assign(s.players.player.resources, { ore: 1000, ai: 10, plasmatorp: 10 });
  assert.equal(queueProduction(s, dock.id, "leviathan"), true, "it queues when you can pay the strategic-good cost");
  assert.ok(s.players.player.resources.ai < 10 && s.players.player.resources.plasmatorp < 10, "the strategic goods were spent");
});

test("the AI Foundry and Torpedo Works are gated behind the aicores research node", () => {
  assert.ok(BUILDINGS.aifoundry.requires.includes("aicores"));
  assert.ok(BUILDINGS.torpedoworks.requires.includes("aicores"));
  const s = createGameState({ planetId: "kybernet", endless: true });
  const chip = makeBuilding("chipfab", "player", 600, 500);
  s.buildings.set(chip.id, chip);
  assert.equal(prereqsMet(s, "player", BUILDINGS.aifoundry), false, "no aicores research → AI Foundry locked");
  s.players.player.upgrades.aicores = true;
  assert.equal(prereqsMet(s, "player", BUILDINGS.aifoundry), true, "researched → unlocked");
});

test("the Strategic tier is Odyssey-only and byte-identical-safe for the skirmish AI", () => {
  for (const t of ["aifoundry", "torpedoworks", "stardock"]) assert.equal(BUILDINGS[t].odysseyOnly, true, `${t} is Odyssey-only`);
  assert.ok(!UNITS.leviathan.bonusVs, "the Leviathan sits outside the rock-paper-scissors triangle");
  // The Leviathan's ai/plasmatorp cost enters ai.js SPENDABLE, but that only ever
  // steers workers toward node commodities — and no world DEPOSITS a strategic good,
  // so the AI's behaviour (and the byte-identical skirmish replay) is unchanged.
  const strategic = new Set(["ai", "plasmatorp", "antimatter", "drones"]);
  for (const id of ODYSSEY_WORLDS) {
    const map = generateMap(id, mulberry32(1), { sizeMult: 1, resourceMult: 1 });
    for (const n of map.nodes) assert.ok(!strategic.has(n.com), `${id} must not deposit a strategic good (found ${n.com})`);
  }
});
