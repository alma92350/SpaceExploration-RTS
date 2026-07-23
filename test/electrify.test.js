import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameState, makeBuilding } from "../engine/state.js";
import { updateProductionQueue } from "../engine/production.js";
import { supplyCap } from "../engine/supply.js";
import { electrifyBoost, powerDraw } from "../engine/industry.js";
import { isElectrifiable } from "../engine/entities.js";

// A powered Odyssey base: a Reactor (⚡20) with room to spare, plus whatever the test wires in.
function poweredBase() {
  const s = createGameState({ planetId: "ferros", endless: true });
  const r = makeBuilding("reactor", "player", 500, 500);   // grants ⚡20, on-grid
  s.buildings.set(r.id, r);
  return s;
}

test("isElectrifiable picks the non-power producers/houses, not the power economy", () => {
  // Producers and the Habitat can be wired in…
  for (const t of ["command", "barracks", "stardock", "habitat"]) assert.ok(isElectrifiable(t), `${t} electrifiable`);
  // …but anything already ON the power economy (grants it, runs a recipe, digs, or is a wonder) cannot,
  // nor can a plain turret / pure drop-off with nothing to boost.
  for (const t of ["reactor", "combustor", "smelter", "plasmarig", "antimatter_gate", "turret", "refinery"])
    assert.ok(!isElectrifiable(t), `${t} not electrifiable`);
});

test("an electrified Barracks trains ~30% faster while the grid can power it", () => {
  const run = (electrified) => {
    const s = poweredBase();
    const bar = makeBuilding("barracks", "player", 520, 500); s.buildings.set(bar.id, bar);
    bar.electrified = electrified;
    bar.queue = [{ unitType: "skiff", progress: 0 }];
    updateProductionQueue(s, bar, 0.1);
    return bar.queue[0].progress;
  };
  const on = run(true), off = run(false);
  assert.ok(on > off, `electrified trains faster (${on} > ${off})`);
  assert.ok(Math.abs(on / off - 1.3) < 0.01, `~30% faster on a full grid (ratio ${(on / off).toFixed(3)})`);
});

test("an electrified Habitat houses 30% more — its supply grant is lifted, powered", () => {
  const s = poweredBase();
  const hab = makeBuilding("habitat", "player", 520, 500); s.buildings.set(hab.id, hab);
  const before = supplyCap(s, "player");
  hab.electrified = true;
  const after = supplyCap(s, "player");
  assert.ok(after > before, "electrified Habitat grants more supply");
  assert.ok(Math.abs((after - before) - 8 * 0.3) < 1e-6, `+30% of its 8-supply grant (Δ ${(after - before).toFixed(2)})`);
});

test("electrifying draws Power — it competes with the factories on the grid", () => {
  const s = poweredBase();
  const bar = makeBuilding("barracks", "player", 520, 500); s.buildings.set(bar.id, bar);
  const before = powerDraw(s, "player");
  bar.electrified = true;
  const after = powerDraw(s, "player");
  assert.ok(after - before > 0, `an electrified building adds grid load (${before} → ${after})`);
});

test("under a strained grid the bonus tapers below +30% (it scales with the throttle)", () => {
  const s = poweredBase();   // one Reactor = ⚡20
  // Pile on electrified Habitats until the draw (4 each, on-grid) outruns the cap.
  for (let i = 0; i < 8; i++) {
    const h = makeBuilding("habitat", "player", 500 + i * 10, 520); h.electrified = true;
    s.buildings.set(h.id, h);
  }
  const boost = electrifyBoost(s, "player");   // 8×4 = 32 draw vs 20 cap → throttle 0.625 → 0.1875
  assert.ok(boost > 0 && boost < 0.3, `throttled boost sits between 0 and 30% (${boost.toFixed(3)})`);
});

test("no grid, no bonus: electrifying without a power source is inert (no free upgrade)", () => {
  const s = createGameState({ planetId: "ferros", endless: true });   // no Reactor built
  const hab = makeBuilding("habitat", "player", 520, 500); s.buildings.set(hab.id, hab);
  const before = supplyCap(s, "player");
  hab.electrified = true;
  assert.equal(supplyCap(s, "player"), before, "no Power → no supply bonus");
  assert.equal(electrifyBoost(s, "player"), 0, "the boost is zero off-grid");
});

test("quarantine: the flag is inert without a grid, so a skirmish stays byte-identical", () => {
  const s = createGameState({ planetId: "ferros" });   // skirmish, not endless — no reactors exist
  const cc = [...s.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const before = supplyCap(s, "player");
  cc.electrified = true;   // even if the flag were somehow set, there's no Power to cash it in
  assert.equal(supplyCap(s, "player"), before, "the skirmish supply cap is unchanged");
});
