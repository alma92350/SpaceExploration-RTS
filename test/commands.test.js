import { test } from "node:test";
import assert from "node:assert/strict";
import { issueMove, issueAttackMove, issueAttack, issueGather } from "../engine/commands.js";

function dummyUnits(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, order: null, cargo: { com: null, qty: 0 } }));
}

test("issueMove spreads a group across distinct destinations instead of one shared point", () => {
  const units = dummyUnits(6);
  issueMove(units, 900, 700);

  const dests = units.map(u => `${u.order.x},${u.order.y}`);
  assert.equal(new Set(dests).size, 6, "every unit should get its own destination");
});

test("issueMove leaves a lone unit's destination exactly on the clicked point", () => {
  const [unit] = dummyUnits(1);
  issueMove([unit], 500, 400);
  assert.deepEqual(unit.order, { type: "move", x: 500, y: 400 });
});

test("issueAttackMove centers the formation on the target point", () => {
  const units = dummyUnits(4);
  issueAttackMove(units, 900, 700);

  const avgX = units.reduce((s, u) => s + u.order.x, 0) / units.length;
  const avgY = units.reduce((s, u) => s + u.order.y, 0) / units.length;
  assert.equal(avgX, 900);
  assert.equal(avgY, 700);
  units.forEach(u => assert.equal(u.order.type, "attack-move"));
});

test("issueAttack sends every unit at the same explicit target id (focus fire, no spreading)", () => {
  const units = dummyUnits(3);
  issueAttack(units, "target-1");
  units.forEach(u => assert.deepEqual(u.order, { type: "attack", targetId: "target-1" }));
});

test("issueGather only assigns cargo-capable units", () => {
  const units = dummyUnits(2);
  units[1].cargo = null;   // simulate a non-worker slipping into the selection
  issueGather(units, "node-1");
  assert.deepEqual(units[0].order, { type: "gather", nodeId: "node-1" });
  assert.equal(units[1].order, null);
});
