import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding, makeUnit } from "../engine/state.js";
import { checkWinCondition, playerScore, scoreBreakdown, DEFAULT_MATCH_TIME_LIMIT } from "../engine/victory.js";
import { UNITS, BUILDINGS } from "../engine/entities.js";

function commandCenterOf(state, owner) {
  return [...state.buildings.values()].find(b => b.owner === owner && b.type === "command");
}

test("the game is not over while both sides still hold a Command Center", () => {
  const state = createGameState({ planetId: "ferros" });
  checkWinCondition(state);
  assert.equal(state.over, false);
});

test("losing your Command Center hands the win to the other side", () => {
  const state = createGameState({ planetId: "ferros" });
  state.buildings.delete(commandCenterOf(state, "player").id);

  checkWinCondition(state);

  assert.equal(state.over, true);
  assert.equal(state.winner, "ai");
  assert.equal(state.winReason, "elimination", "a last-side-standing win is reported as elimination, not a score decision");
});

test("losing one of two Command Centers doesn't end the game — losing both does", () => {
  const state = createGameState({ planetId: "ferros" });
  const seeded = commandCenterOf(state, "player");
  const expansion = makeBuilding("command", "player", 800, 500);
  state.buildings.set(expansion.id, expansion);

  state.buildings.delete(seeded.id);
  checkWinCondition(state);
  assert.equal(state.over, false, "the expansion still counts as a Command Center");

  state.buildings.delete(expansion.id);
  checkWinCondition(state);
  assert.equal(state.over, true);
  assert.equal(state.winner, "ai");
});

test("a still-constructing Command Center keeps a side in the game", () => {
  const state = createGameState({ planetId: "ferros" });
  const site = makeBuilding("command", "player", 800, 500, { constructing: true });
  state.buildings.set(site.id, site);
  state.buildings.delete(commandCenterOf(state, "player").id);

  checkWinCondition(state);

  assert.equal(state.over, false, "a founded expansion site is enough to stay in the fight");
});

test("a mutual Command Center wipeout resolves by score, not an arbitrary winner", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  state.buildings.clear();                      // neither side holds a Command Center — a true mutual wipe
  state.players.player.resources = { ore: 0, crystals: 0, radioactives: 0 };
  state.players.ai.resources = { ore: 0, crystals: 0, radioactives: 0 };
  for (let i = 0; i < 5; i++) {                  // only the AI has a fielded remnant force
    const u = makeUnit("skiff", "ai", 100 + i, 100);
    state.units.set(u.id, u);
  }
  assert.ok(playerScore(state, "ai") > playerScore(state, "player"), "the AI holds the clear score lead");

  checkWinCondition(state);

  assert.equal(state.over, true, "no side standing still ends the match");
  assert.equal(state.winner, "ai", "the higher-scoring side wins the mutual wipe — not an arbitrary default");
  assert.equal(state.winReason, "mutual-wipe-score", "neither side survived, so the decision is reported as a score call, not elimination");
});

test("a match that reaches the time limit with both bases intact is decided on score", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // Both keep their Command Center; push time past the limit and give the AI a
  // clear material edge — a stack of units it didn't have to fight for.
  state.players.ai.resources.ore += 500;
  for (let i = 0; i < 6; i++) {
    const u = makeUnit("bastion", "ai", state.map.bases.ai.x, state.map.bases.ai.y + i * 6);
    state.units.set(u.id, u);
  }
  state.time = DEFAULT_MATCH_TIME_LIMIT + 1;

  checkWinCondition(state);

  assert.equal(state.over, true, "the time limit ends an otherwise-endless stalemate");
  assert.equal(state.winner, "ai", "the side that out-massed and out-banked takes the tiebreak");
  assert.equal(state.winReason, "timeout-score", "both bases were still standing — the clock, not conquest, decided it");
});

test("an exact score tie at the time limit resolves to the first side listed in state.owners", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  // A freshly-seeded match is perfectly mirrored — same starting bank, same Command Center, same
  // three workers on each side — so both sides carry the exact same score into the tiebreak.
  assert.equal(playerScore(state, "player"), playerScore(state, "ai"), "a fresh match is a dead-even score");
  state.time = DEFAULT_MATCH_TIME_LIMIT + 1;

  checkWinCondition(state);

  assert.equal(state.over, true, "the time limit still ends an exact stalemate");
  assert.equal(state.winner, "player", "an exact tie goes to the first side listed in state.owners (the defender's edge)");
  assert.equal(state.winReason, "timeout-score", "a tie-break resolution is still a timeout-score decision, same as a clear score lead");
});

test("the score tiebreak values a fielded army over a hoarded bank", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  state.buildings.clear();
  // Player: a big idle stockpile, nothing on the board.
  state.players.player.resources = { ore: 2000, crystals: 0, radioactives: 0 };
  // AI: an army worth only 500 ore (5 Skiffs), banked nothing.
  state.players.ai.resources = { ore: 0, crystals: 0, radioactives: 0 };
  for (let i = 0; i < 5; i++) {
    const u = makeUnit("skiff", "ai", 100 + i, 100);
    state.units.set(u.id, u);
  }
  // Under the OLD rule (raw bank + raw cost) the 2000-ore hoard would win outright.
  // The reweight discounts the bank and rewards the fielded army, flipping it.
  assert.ok(playerScore(state, "ai") > playerScore(state, "player"),
    "500 ore of committed army out-scores a 2000-ore idle bank — turtling on resources shouldn't win");
});

test("before the time limit, an even, both-bases-standing match keeps running", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.time = DEFAULT_MATCH_TIME_LIMIT - 1;
  checkWinCondition(state);
  assert.equal(state.over, false, "the tiebreak only fires at the limit, not before");
});

/* ---------- setup.js's Match length row (Quick 20 / Standard 40 / Marathon 60) plumbs an
   explicit opts.matchTimeLimit through createGameState onto state.matchTimeLimit — the field
   checkWinCondition already reads via `state.matchTimeLimit ?? DEFAULT_MATCH_TIME_LIMIT`. ---- */

test("createGameState honors an explicit opts.matchTimeLimit, and checkWinCondition's timeout-score decision respects the override", () => {
  const quick = createGameState({ planetId: "ferros", rng: () => 0.5, matchTimeLimit: 1200 });   // "Quick 20"
  assert.equal(quick.matchTimeLimit, 1200, "the explicit override lands on state.matchTimeLimit");

  quick.time = 1199;
  checkWinCondition(quick);
  assert.equal(quick.over, false, "not over yet — just short of the Quick 20 override");

  quick.time = 1201;
  checkWinCondition(quick);
  assert.equal(quick.over, true, "the SHORTER override ends the match well before the 40-minute default would");
  assert.equal(quick.winReason, "timeout-score");
});

test("createGameState with no matchTimeLimit option leaves it unset, so checkWinCondition still falls back to DEFAULT_MATCH_TIME_LIMIT", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  assert.equal(state.matchTimeLimit, null, "no override requested ⇒ null, not some silently-substituted number");

  state.time = 1201;   // well past the Quick-20 mark above, but short of the 40-minute default
  checkWinCondition(state);
  assert.equal(state.over, false, "with no override, the full 40-minute default still applies");
});

test("checkWinCondition is a no-op once the game is already over", () => {
  const state = createGameState({ planetId: "ferros" });
  state.over = true;
  state.winner = "player";
  state.winReason = "elimination";
  state.buildings.delete(commandCenterOf(state, "player").id);   // would flip it to "ai" if not short-circuited

  checkWinCondition(state);

  assert.equal(state.winner, "player");
  assert.equal(state.winReason, "elimination", "an already-decided match's reason must not be silently overwritten either");
});

/* ---------- scoreBreakdown (docs/improvement-proposals.md "Make the clock endgame visible,
   honest, and configurable" — showGameOver's "bank x0.25 / army x1.35 / structures" breakdown).
   playerScore's own comment already documents the weights (BANK_WEIGHT 0.25, COMBAT_BONUS 1.35);
   scoreBreakdown exposes the same three components playerScore sums, instead of only the total. ---- */

test("scoreBreakdown partitions playerScore into bank/army/structures that sum to the same total playerScore reports", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  state.buildings.clear();
  state.players.player.resources = { ore: 400, crystals: 0, radioactives: 0 };

  const skiff = makeUnit("skiff", "player", 10, 10);     // role:"combat" — the army bucket
  state.units.set(skiff.id, skiff);
  const worker = makeUnit("worker", "player", 20, 20);   // role:"worker" — NOT combat, so structures
  state.units.set(worker.id, worker);
  const barracks = makeBuilding("barracks", "player", 100, 100);
  state.buildings.set(barracks.id, barracks);

  const bd = scoreBreakdown(state, "player");
  const costTotal = c => Object.values(c).reduce((a, b) => a + b, 0);

  assert.equal(bd.bank, 400 * 0.25, "bank is the BANK_WEIGHT-scaled resource total");
  assert.equal(bd.army, costTotal(UNITS.skiff.cost) * 1.35, "army is the COMBAT_BONUS-scaled cost of combat-role units only");
  assert.equal(bd.structures, costTotal(UNITS.worker.cost) + costTotal(BUILDINGS.barracks.cost),
    "structures is buildings PLUS non-combat units, both at raw cost — exactly playerScore's own 'else' branch");
  assert.equal(bd.bank + bd.army + bd.structures, bd.total, "the three buckets add up to the reported total");
  assert.equal(bd.total, playerScore(state, "player"), "and that total must always agree with playerScore itself — no drift between the two");
});

test("scoreBreakdown of a side with nothing banked, fielded, or built is all zero", () => {
  const state = createGameState({ planetId: "ferros", rng: () => 0.5 });
  state.units.clear();
  state.buildings.clear();
  state.players.player.resources = { ore: 0, crystals: 0, radioactives: 0 };

  const bd = scoreBreakdown(state, "player");

  assert.deepEqual(bd, { bank: 0, army: 0, structures: 0, total: 0 });
});
