import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeUnit } from "../engine/state.js";
import { tick } from "../engine/sim.js";
import { updateCombat } from "../engine/combat.js";
import { issueEscort } from "../engine/commands.js";
import { escortSlot } from "../engine/movement.js";

// A minimal state (as the movement/combat tests use): just a unit Map + players, so we can drive
// updateCombat directly without the AI/win-checks of a full tick.
function miniState(...units) {
  return {
    units: new Map(units.map(u => [u.id, u])),
    buildings: new Map(),
    players: { player: { color: "#0ff", resources: {} }, ai: { color: "#f00", resources: {} } },
    events: [],   // performAttack (combat.js) pushes hit/kill events here
  };
}

test("issueEscort gives every unit an escort order with a stable slot", () => {
  const target = makeUnit("skiff", "player", 600, 600);
  const escorts = [makeUnit("skiff", "player", 200, 200), makeUnit("skiff", "player", 210, 200), makeUnit("ranger", "player", 220, 200)];
  issueEscort(escorts, target.id);
  escorts.forEach((u, i) => {
    assert.equal(u.order.type, "escort");
    assert.equal(u.order.targetId, target.id);
    assert.equal(u.order.slot, i);
    assert.equal(u.order.slots, 3);
  });
});

test("escortSlot places escorts on a ring around the target; null once it's gone", () => {
  const target = makeUnit("skiff", "player", 500, 500);
  const escorts = [makeUnit("skiff", "player", 0, 0), makeUnit("skiff", "player", 0, 0), makeUnit("skiff", "player", 0, 0), makeUnit("skiff", "player", 0, 0)];
  const s = miniState(target, ...escorts);
  issueEscort(escorts, target.id);
  const pts = escorts.map(u => escortSlot(s, u));
  for (const p of pts) {
    const r = Math.hypot(p.x - target.x, p.y - target.y);
    assert.ok(r > 12 && r < 200, `on a ring at a sane radius (${r.toFixed(1)})`);
  }
  assert.notEqual(`${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`, `${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`, "distinct slots → distinct points");
  s.units.delete(target.id);
  assert.equal(escortSlot(s, escorts[0]), null, "a vanished target → no slot (caller drops the order)");
});

test("a combat escort closes to formation and then trails a moving target (persistent follow)", () => {
  const target = makeUnit("skiff", "player", 600, 600);
  const u = makeUnit("skiff", "player", 200, 200);
  const s = miniState(target, u);
  issueEscort([u], target.id);

  for (let i = 0; i < 300; i++) updateCombat(s, u, 0.1);
  let slot = escortSlot(s, u);
  assert.ok(Math.hypot(u.x - slot.x, u.y - slot.y) < 8, "reached its formation slot beside the target");
  assert.ok(u.order && u.order.type === "escort", "still escorting — arrival never clears an escort");

  target.x = 1600; target.y = 1600;                       // the guarded ship is ordered far away
  for (let i = 0; i < 500; i++) updateCombat(s, u, 0.1);
  assert.ok(Math.hypot(u.x - target.x, u.y - target.y) < 90, "the escort trailed the target to its new position");
});

test("a combat escort auto-engages a threat near its charge, then reforms", () => {
  const target = makeUnit("skiff", "player", 600, 600);
  const u = makeUnit("skiff", "player", 560, 560);
  const s = miniState(target, u);
  issueEscort([u], target.id);
  for (let i = 0; i < 150; i++) updateCombat(s, u, 0.1);   // form up

  const enemy = makeUnit("skiff", "ai", u.x + 20, u.y);   // a raider right on the escort
  enemy.hp = enemy.maxHp = 100000;                        // a sponge, so it survives to be measured (no death-cleanup path)
  s.units.set(enemy.id, enemy);
  for (let i = 0; i < 80; i++) updateCombat(s, u, 0.1);    // only the escort acts; the enemy sits
  assert.ok(enemy.hp < enemy.maxHp, "the escort broke formation to defend the target and hit the threat");

  s.units.delete(enemy.id);                                // threat gone
  for (let i = 0; i < 300; i++) updateCombat(s, u, 0.1);
  const slot = escortSlot(s, u);
  assert.ok(Math.hypot(u.x - slot.x, u.y - slot.y) < 12, "with the threat cleared, the escort returns to formation");
});

test("an escort drops the order the moment its target dies", () => {
  const target = makeUnit("skiff", "player", 600, 600);
  const u = makeUnit("skiff", "player", 500, 500);
  const s = miniState(target, u);
  issueEscort([u], target.id);
  updateCombat(s, u, 0.1);
  assert.equal(u.order.type, "escort");
  s.units.delete(target.id);
  updateCombat(s, u, 0.1);
  assert.equal(u.order, null, "no target → the escort stops escorting (free to take a new order)");
});

test("a worker (non-combat) escort follows via the sim tick path", () => {
  const s = createGameState({ planetId: "ferros", seed: 2 });
  const cx = s.map.width / 2, cy = s.map.height / 2;      // mid-map, clear of both bases
  const target = makeUnit("skiff", "player", cx, cy);
  const worker = makeUnit("worker", "player", cx - 300, cy);
  s.units.set(target.id, target);
  s.units.set(worker.id, worker);
  issueEscort([worker], target.id);
  const d0 = Math.hypot(worker.x - target.x, worker.y - target.y);
  for (let i = 0; i < 120; i++) tick(s, 0.1);
  const d1 = Math.hypot(worker.x - target.x, worker.y - target.y);
  assert.ok(d1 < d0 - 100, `the worker escort closed on its target through the tick (${d0.toFixed(0)} → ${d1.toFixed(0)})`);
  assert.ok(worker.order && worker.order.type === "escort", "and it's still escorting");
});
