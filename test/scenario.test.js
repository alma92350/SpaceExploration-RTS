import { test } from "node:test";
import assert from "node:assert/strict";
import { setupEscort, ESCORT_DIFFICULTY, repairCost, repairConvoy } from "../engine/scenarios.js";
import { tick } from "../engine/sim.js";
import { UNITS } from "../engine/entities.js";

const freighters = state => [...state.units.values()].filter(u => u.owner === "player" && u.type === "freighter");
const pirates = state => [...state.units.values()].filter(u => u.owner === "ai");

function runToEnd(state, maxTicks = 6000) {
  let t = 0;
  while (!state.over && t < maxTicks) { tick(state, 0.1); t++; }
  return t;
}

test("setupEscort lays out a convoy mission, not a skirmish", () => {
  const s = setupEscort({ planetId: "ferros", seed: 7, difficulty: "medium" });
  assert.equal(s.buildings.size, 0, "no Command Centers / economy in a scenario");
  assert.equal(freighters(s).length, 4, "four freighters at the start");
  const escorts = [...s.units.values()].filter(u => u.owner === "player" && u.type !== "freighter");
  assert.ok(escorts.length >= 3, "a player escort fleet");
  assert.ok(escorts.every(u => UNITS[u.type].role === "combat" || UNITS[u.type].role === "support"), "escorts are warships / support");
  assert.equal(s.scenario.route.length, ESCORT_DIFFICULTY.medium.legRisk.length + 1, "one more station than legs");
  assert.equal(s.scenario.phase, "prep");
  assert.equal(s.scenario.outcome, null);
});

test("a scenario always resolves to a win or loss within its time limit", () => {
  for (const difficulty of ["easy", "medium", "hard"]) {
    const s = setupEscort({ planetId: "ferros", seed: 3, difficulty });
    runToEnd(s);
    assert.equal(s.over, true, `${difficulty} should reach a terminal state`);
    assert.ok(["win", "loss"].includes(s.scenario.outcome), `${difficulty} has an outcome`);
    assert.ok(s.scenario.score >= 0, "a score is computed");
  }
});

test("a scenario is deterministic: same seed replays to the same outcome and score", () => {
  const run = () => {
    const s = setupEscort({ planetId: "ferros", seed: 999, difficulty: "medium" });
    const ticks = runToEnd(s);
    return `${s.scenario.outcome}|${s.scenario.score}|${s.tick}|${s.units.size}|${ticks}`;
  };
  assert.equal(run(), run(), "identical seed must replay identically");
});

test("a risk-free route delivers every freighter — a win", () => {
  const s = setupEscort({ planetId: "ferros", seed: 1, difficulty: "easy" });
  s.scenario.legRisk = s.scenario.legRisk.map(() => 0);   // no pirates this run
  runToEnd(s);
  assert.equal(s.scenario.outcome, "win");
  assert.equal(s.scenario.delivered, 4, "all four freighters arrive when nothing attacks them");
  assert.ok(s.scenario.score > 0);
});

test("an undefended convoy under heavy raiding is lost", () => {
  const s = setupEscort({ planetId: "ferros", seed: 4, difficulty: "hard" });
  // Strip the escort so the freighters are defenceless, and crank the risk.
  for (const u of [...s.units.values()]) if (u.owner === "player" && u.type !== "freighter") s.units.delete(u.id);
  s.scenario.legRisk = s.scenario.legRisk.map(() => 1.6);
  runToEnd(s);
  assert.equal(s.scenario.outcome, "loss", "no escort + heavy raids = a lost convoy");
  assert.ok(pirates(s).length > 0, "pirates actually spawned");
});

test("running out of time before delivery is a loss", () => {
  const s = setupEscort({ planetId: "ferros", seed: 2, difficulty: "easy" });
  s.scenario.legRisk = s.scenario.legRisk.map(() => 0);   // no combat, just too slow
  s.scenario.timeLimit = 6;                                // far too little to cross the map
  runToEnd(s);
  assert.equal(s.scenario.outcome, "loss");
  assert.ok(s.time >= 6, "the clock actually expired");
});

test("repair heals the convoy at a station and spends the budget once per stop", () => {
  const s = setupEscort({ planetId: "ferros", seed: 5, difficulty: "medium" });
  // Force a docked state with a damaged, cheap-to-fix convoy.
  s.scenario.phase = "docked";
  s.scenario.repairedThisStop = false;
  s.scenario.budget = 1000;
  const f = freighters(s)[0];
  f.hp = f.maxHp - 50;
  const before = s.scenario.budget;
  const cost = repairCost(s);
  assert.ok(cost > 0, "there is damage to pay for");
  assert.equal(repairConvoy(s), true, "repair succeeds when the budget covers it");
  assert.equal(f.hp, f.maxHp, "the freighter is back to full");
  assert.equal(s.scenario.budget, before - cost, "the cost came out of the budget");
  assert.equal(repairConvoy(s), false, "no second repair at the same stop");
});
