import { test } from "node:test";
import assert from "node:assert/strict";
import { createGalaxy, activeState, addPlanet, jumpCapital, galaxyStatus, stepGalaxy, BG_STEP, ODYSSEY_WORLDS,
         upgradeToCapital, jumpVessel, canJump, CAPITAL_UPGRADE_COST, CAPITAL_HP_MULT } from "../engine/galaxy.js";
import { checkEndlessLoss } from "../engine/victory.js";
import { serializeGalaxy, deserializeGalaxy } from "../engine/persist.js";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip, hasColonyShip } from "../engine/colony.js";
import { tick } from "../engine/sim.js";

const commandCenters = (state, owner) =>
  [...state.buildings.values()].filter(b => b.owner === owner && b.type === "command");
// Odyssey now starts each side with a colony ship, not a placed CC. Deploying both
// reconstitutes the classic layout (a CC + 3 workers at each base) — used by tests that
// exercise DOWNSTREAM mechanics (jump/cargo/capital/domination), not the opening itself.
function settle(state) {
  for (const u of [...state.units.values()]) if (u.type === "colonyship") deployColonyShip(state, u.id);
  return state;
}
const playerBuildings = (state, type) =>
  [...state.buildings.values()].filter(b => b.owner === "player" && (!type || b.type === type));

// Stand a finished Spaceport beside the capital so a jump can launch, and return it.
function addSpaceport(state) {
  const cc = commandCenters(state, "player")[0];
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);   // no { constructing } ⇒ finished
  state.buildings.set(sp.id, sp);
  return sp;
}

test("createGalaxy lands the player on one world with a colony ship (no CC yet)", () => {
  const g = createGalaxy({ seed: 7, difficulty: "medium" });
  assert.ok(ODYSSEY_WORLDS.includes(g.activeId), "the start world is one of the roster");
  assert.equal(g.planets.size, 1, "Phase 1: exactly one planet");
  assert.ok(g.credits > 0, "you start with a credit stipend to fund the first jump");
  const s = activeState(g);
  assert.equal(s.endless, true, "the active planet is an endless (Odyssey) state");
  assert.equal(commandCenters(s, "player").length, 0, "no Command Center is placed yet — you deploy one");
  assert.ok(hasColonyShip(s, "player"), "the player starts with a mobile colony ship");
  assert.ok(hasColonyShip(s, "ai"), "the neighbour likewise starts with a colony ship");
  settle(s);
  assert.equal(commandCenters(s, "player").length, 1, "deploying the ship founds exactly one Command Center");
  assert.ok(commandCenters(s, "ai").length >= 1, "a neighbour is present to coexist / clash with");
});

test("endless mode never ends by conquest — razing the enemy CC does not win", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  for (const b of commandCenters(s, "ai")) s.buildings.delete(b.id);   // wipe the neighbour's CC
  checkEndlessLoss(s);
  assert.equal(s.over, false, "losing the enemy CC is not a victory in the open world");
});

test("endless mode ends in defeat only when the player's last foothold is lost", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  checkEndlessLoss(s);
  assert.equal(s.over, false, "a lone colony ship is a foothold — not a tick-1 defeat");
  settle(s);                                                    // deploy the ship → a CC + workers
  for (const b of commandCenters(s, "player")) s.buildings.delete(b.id);   // the capital falls (no ship left, it deployed)
  checkEndlessLoss(s);
  assert.equal(s.over, true, "with no CC and no colony ship, the Odyssey is over");
  assert.equal(s.winner, "ai");
});

test("a second Command Center is an expansion — losing one doesn't end the Odyssey", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const first = commandCenters(s, "player")[0];
  const second = makeBuilding("command", "player", first.x + 300, first.y + 200);   // an expansion base
  s.buildings.set(second.id, second);
  assert.equal(commandCenters(s, "player").length, 2, "the player can hold multiple CCs in Odyssey");
  s.buildings.delete(first.id);                     // the original capital falls…
  checkEndlessLoss(s);
  assert.equal(s.over, false, "…but the expansion CC keeps the Odyssey alive");
  s.buildings.delete(second.id);                    // now the last one falls
  checkEndlessLoss(s);
  assert.equal(s.over, true, "only the LAST Command Center ends the run");
});

test("a jump carries a colony ship, NOT a deployed base — the bases stay behind as a colony", () => {
  const g = createGalaxy({ seed: 7 });
  const from = settle(activeState(g));
  const cc = commandCenters(from, "player")[0];
  const expansion = makeBuilding("command", "player", cc.x + 300, cc.y + 200);
  from.buildings.set(expansion.id, expansion);      // two deployed bases
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);   // the jump vessel, staged on the pad
  from.units.set(ship.id, ship);
  g.credits = 2000;
  const destId = g.worlds.find(w => w !== g.activeId);
  assert.ok(jumpCapital(g, destId), "the jump launched");
  const dest = activeState(g);
  assert.equal(commandCenters(dest, "player").length, 0, "NO deployed base teleported to the destination");
  assert.ok(hasColonyShip(dest, "player"), "the colony ship arrived — deploy it to settle here");
  assert.equal(commandCenters(from, "player").length, 2, "both deployed bases stayed behind on the colony");
});

test("a Command Center upgrades into the Capital — double HP, charged, one per owner", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const cc = commandCenters(s, "player")[0];
  const baseMax = cc.maxHp;
  s.players.player.resources.ore = 1000;
  assert.equal(upgradeToCapital(s, cc), true, "the upgrade succeeds when affordable");
  assert.equal(cc.capital, true, "it is now the Capital");
  assert.equal(cc.maxHp, baseMax * CAPITAL_HP_MULT, "double the HP");
  assert.equal(s.players.player.resources.ore, 1000 - CAPITAL_UPGRADE_COST.ore, "the cost was charged");

  const second = makeBuilding("command", "player", cc.x + 300, cc.y);
  s.buildings.set(second.id, second);
  s.players.player.resources.ore = 1000;
  assert.equal(upgradeToCapital(s, second), false, "only one Capital per owner");
  assert.ok(!second.capital, "the second CC stays a normal (jumping) base");
});

test("upgradeToCapital is refused without the resources or on a still-constructing CC", () => {
  const s = settle(createGameState({ planetId: "ferros", seed: 3, endless: true }));
  const cc = commandCenters(s, "player")[0];
  s.players.player.resources.ore = 10;                 // can't afford
  assert.equal(upgradeToCapital(s, cc), false);
  assert.ok(!cc.capital);
  const half = makeBuilding("command", "player", cc.x + 300, cc.y);
  half.constructing = true;
  s.buildings.set(half.id, half);
  s.players.player.resources.ore = 1000;
  assert.equal(upgradeToCapital(s, half), false, "a half-built CC can't be the Capital yet");
});

test("a jump needs a colony ship on the pad — a deployed base (even the Capital) never travels", () => {
  const g = createGalaxy({ seed: 7 });
  const from = settle(activeState(g));
  const cc = commandCenters(from, "player")[0];
  const sp = addSpaceport(from);
  g.credits = 2000;
  from.players.player.resources.ore = 1000;
  upgradeToCapital(from, cc);                           // a fortified base
  assert.equal(jumpVessel(from), null, "no colony ship staged → no vessel");
  assert.equal(canJump(from), false, "a Spaceport alone can't jump");
  const before = g.credits;
  assert.equal(jumpCapital(g, g.worlds.find(w => w !== g.activeId)), null, "the jump is refused");
  assert.equal(g.credits, before, "and no fuel was spent");

  const ship = makeUnit("colonyship", "player", sp.x, sp.y);   // park a colony ship on the pad
  from.units.set(ship.id, ship);
  assert.equal(jumpVessel(from)?.id, ship.id, "the staged colony ship is the vessel");
  assert.ok(canJump(from), "now a jump can launch");
  assert.ok(jumpCapital(g, g.worlds.find(w => w !== g.activeId)), "the jump runs");
  assert.equal(commandCenters(from, "player").length, 1, "the deployed base stayed put…");
  assert.equal(commandCenters(from, "player")[0].capital, true, "…still the fortified Capital");
});

test("the Capital (flag + raised HP) survives a galaxy save/load", () => {
  const g = createGalaxy({ seed: 5 });
  const s = settle(activeState(g));
  const cc = commandCenters(s, "player")[0];
  s.players.player.resources.ore = 1000;
  upgradeToCapital(s, cc);
  const restored = deserializeGalaxy(JSON.parse(JSON.stringify(serializeGalaxy(g))));
  const rcc = commandCenters(activeState(restored), "player")[0];
  assert.equal(rcc.capital, true, "the Capital flag round-trips");
  assert.equal(rcc.maxHp, cc.maxHp, "the raised HP round-trips");
});

test("an endless state has no time-limit resolution", () => {
  const s = createGameState({ planetId: "ferros", seed: 3, endless: true });
  s.time = 100000;   // far beyond any skirmish clock
  checkEndlessLoss(s);
  assert.equal(s.over, false, "the sandbox does not resolve on a clock while the capital stands");
});

test("an Odyssey galaxy runs without ending while both capitals stand, and is deterministic", () => {
  const fingerprint = () => {
    const g = createGalaxy({ seed: 4242, difficulty: "medium" });
    const s = activeState(g);
    for (let i = 0; i < 200; i++) tick(s, 0.1);
    return `${g.activeId}|${s.over}|${s.tick}|${s.units.size}|${Math.round(s.players.player.resources.ore || 0)}`;
  };
  const a = fingerprint();
  assert.match(a, /\|false\|/, "the sandbox is still running after 20s (no premature end)");
  assert.equal(a, fingerprint(), "same galaxy seed replays identically");
});

/* ---------- background-world scheduling (stepGalaxy) ---------- */

// Seed a galaxy with `n` background worlds added alongside the active seat.
function galaxyWithBackground(seed, n) {
  const g = createGalaxy({ seed });
  const others = g.worlds.filter(w => w !== g.activeId).slice(0, n);
  for (const w of others) addPlanet(g, w, { unsettled: true });
  return { g, bg: others.map(w => g.planets.get(w)) };
}

test("stepGalaxy ticks the active world every frame and colonies on a coarser step", () => {
  const { g, bg } = galaxyWithBackground(5, 2);
  const active = activeState(g);
  for (let i = 0; i < BG_STEP; i++) stepGalaxy(g, 0.1);
  assert.equal(active.tick, BG_STEP, "the active world ticks every galaxy tick");
  for (const s of bg) assert.equal(s.tick, 1, "a background world ticks once per BG_STEP window");
  // Sim time is conserved despite the coarser cadence.
  for (const s of bg) assert.ok(Math.abs(s.time - active.time) < 1e-9, "same sim time elapsed");
});

test("every background world ticks exactly once per BG_STEP window", () => {
  const { g, bg } = galaxyWithBackground(6, 5);
  for (let i = 0; i < BG_STEP; i++) stepGalaxy(g, 0.1);
  for (const s of bg) assert.equal(s.tick, 1, "each colony advanced exactly one coarse step");
});

test("stepGalaxy scheduling is deterministic for a given seed", () => {
  const run = () => {
    const { g, bg } = galaxyWithBackground(424242, 3);
    for (let i = 0; i < 40; i++) stepGalaxy(g, 0.1);
    const a = activeState(g);
    return `${a.tick}|${a.units.size}|${bg.map(s => `${s.tick}:${s.units.size}`).join(",")}|${Math.round(g.credits)}`;
  };
  assert.equal(run(), run(), "same seed + same stepGalaxy sequence replays identically");
});

test("addPlanet builds a distinct, deterministic world into the galaxy", () => {
  const g = createGalaxy({ seed: 11 });
  const other = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s1 = addPlanet(g, other);
  assert.equal(s1.endless, true);
  assert.equal(s1.planetId, other);
  // Rebuilding the same world from the same galaxy seed is identical (per-planet seed).
  const g2 = createGalaxy({ seed: 11 });
  const s2 = addPlanet(g2, other);
  assert.equal(s1.seed, s2.seed, "per-planet seed is stable across galaxies of the same seed");
});

test("an unsettled destination has only its neighbour — no auto-seeded player base", () => {
  const g = createGalaxy({ seed: 12 });
  const other = ODYSSEY_WORLDS.find(w => w !== g.activeId);
  const s = addPlanet(g, other, { unsettled: true });
  assert.equal(playerBuildings(s).length, 0, "no player buildings until you land");
  assert.equal([...s.units.values()].filter(u => u.owner === "player").length, 0, "no player units either");
  assert.ok([...s.units.values()].some(u => u.owner === "ai"), "the neighbour is intact (its colony ship)");
  assert.equal(s.background, true, "an unvisited world is a background world");
});

/* ---------- the interplanetary jump ---------- */

test("a jump carries the colony ship + staged units and leaves the base as a colony", () => {
  const g = createGalaxy({ seed: 5, difficulty: "easy" });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);        from.units.set(ship.id, ship);   // the vessel
  const rider = makeUnit("skiff", "player", sp.x + 20, sp.y);       from.units.set(rider.id, rider);
  const stayer = makeUnit("worker", "player", sp.x + 900, sp.y);    from.units.set(stayer.id, stayer);

  const destId = g.worlds.find(w => w !== g.activeId);
  const res = jumpCapital(g, destId);
  assert.ok(res, "the jump ran");
  assert.equal(g.activeId, destId, "the destination is now active");

  const dest = activeState(g);
  assert.ok(hasColonyShip(dest, "player"), "the colony ship arrived at the destination");
  assert.ok([...dest.units.values()].some(u => u.owner === "player" && u.type === "skiff"), "the staged unit rode along");
  assert.equal(commandCenters(dest, "player").length, 0, "no deployed base teleported");

  assert.equal(from.background, true, "the origin is now a background colony");
  assert.equal(dest.background, false, "the destination is the active seat");
  assert.equal(commandCenters(from, "player").length, 1, "the origin KEEPS its base as a colony");
  assert.ok(playerBuildings(from, "spaceport").length === 1, "the Spaceport stays with the colony");
  assert.ok([...from.units.values()].some(u => u.owner === "player" && u.type === "worker" && u.x === stayer.x),
    "far units stay with the colony");
});

test("a jump destination receives the colony ship (and staged units), no teleported base", () => {
  const g = createGalaxy({ seed: 6 });
  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y); from.units.set(ship.id, ship);
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  const dest = g.planets.get(destId);
  assert.equal(playerBuildings(dest).length, 0, "no player building teleported — you deploy the ship to found one");
  assert.ok(hasColonyShip(dest, "player"), "the colony ship is the player's presence on arrival");
  assert.ok([...dest.units.values()].some(u => u.owner === "ai"), "the destination's neighbour is intact (its colony ship)");
});

test("after a jump the abandoned colony keeps evolving and never ends the game", () => {
  const g = createGalaxy({ seed: 7 });
  const from = settle(activeState(g));
  addSpaceport(from);
  const destId = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, destId);
  for (let i = 0; i < 100; i++) for (const s of g.planets.values()) tick(s, 0.1);
  assert.equal(from.over, false, "a colony with no capital is not 'over'");
  assert.equal(activeState(g).over, false, "the active seat with its capital keeps running");
});

test("galaxyStatus reports one seat and the rest unexplored, then a colony after a jump", () => {
  const g = createGalaxy({ seed: 21 });
  let st = galaxyStatus(g);
  assert.equal(st.total, ODYSSEY_WORLDS.length);
  assert.equal(st.visited, 1);
  assert.equal(st.worlds.filter(w => w.status === "seat").length, 1, "exactly one active seat");
  assert.equal(st.worlds.filter(w => w.status === "unexplored").length, ODYSSEY_WORLDS.length - 1, "everything else unexplored");
  assert.equal(st.worlds.find(w => w.status === "seat").id, g.activeId);

  const from = settle(activeState(g));
  const sp = addSpaceport(from);
  from.units.set(...(() => { const sh = makeUnit("colonyship", "player", sp.x, sp.y); return [sh.id, sh]; })());   // vessel
  g.credits = 1000;
  const dest = g.worlds.find(w => w !== g.activeId);
  jumpCapital(g, dest);
  st = galaxyStatus(g);
  assert.equal(st.visited, 2);
  assert.equal(st.worlds.find(w => w.id === dest).status, "seat", "the destination is the new seat");
  const colony = st.worlds.find(w => w.status === "colony");
  assert.ok(colony, "the world left behind is a colony");
  assert.ok(colony.income > 0, "a held colony reports passive income");

  // Raze that colony's buildings — it's no longer yours, so it reads "contested".
  const cs = activeState(g).planetId === colony.id ? null : g.planets.get(colony.id);
  for (const b of [...cs.buildings.values()]) if (b.owner === "player") cs.buildings.delete(b.id);
  st = galaxyStatus(g);
  assert.equal(st.worlds.find(w => w.id === colony.id).status, "contested", "a razed colony is contested, not yours");
});

test("the galaxy jump is deterministic", () => {
  const run = () => {
    const g = createGalaxy({ seed: 88, difficulty: "medium" });
    const home = settle(activeState(g));
    const sp = addSpaceport(home);
    home.units.set(...(() => { const sh = makeUnit("colonyship", "player", sp.x, sp.y); return [sh.id, sh]; })());
    const destId = g.worlds.find(w => w !== g.activeId);
    jumpCapital(g, destId);
    const dest = activeState(g), from = g.planets.get([...g.planets.keys()].find(k => k !== g.activeId));
    return `${g.activeId}|${dest.units.size}|${dest.buildings.size}|${from.units.size}|${from.buildings.size}`;
  };
  assert.equal(run(), run(), "same seed + same jump replays identically");
});
