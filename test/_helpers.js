/* ============================================================
   Shared test fixtures + fingerprints. Two things live here so a dozen
   suites don't each re-roll them slightly differently:

   • A byte-exact deterministic FINGERPRINT of engine state (entitySnapshot)
     and of a whole galaxy (galaxySnapshot). Unlike an ad-hoc snapshot these
     capture every sim-owned fact at FULL precision, in a fixed field order
     that's immune to Map-iteration / JSON-key order — so `equal(a, b)` is a
     true "these two runs are identical down to the last float" oracle.

   • jumpReadyGalaxy(): the recurring "galaxy poised to launch an interplanetary
     jump" setup — start world settled, a finished Spaceport by the capital, a
     colony ship staged on the pad, credits to pay the fuel.
   ============================================================ */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createGalaxy, activeState } from "../engine/galaxy.js";
import { makeBuilding, makeUnit } from "../engine/state.js";
import { deployColonyShip } from "../engine/colony.js";

// Every .js file under `dir`, at ANY depth. The static guards (engine-purity, static-integrity)
// used a bare readdirSync, which is not recursive — so a file in an engine/ subdirectory escaped
// the determinism scan, the DOM scan, the parse check AND the import check all at once. Since
// engine-purity.test.js's own rationale is that the engine "could one day run server-side
// (netcode, replays)", the first thing that growth produces — engine/net/ — was exactly the
// blind spot. Both guards share this walker now so they can't drift apart again.
export function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

// mulberry32, kept local (identical to engine/rng.js): a test driving createGameState
// wants a varying-but-reproducible sequence without reaching into engine internals.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Full-precision fingerprint of ONE engine state. Every field a same-seed replay must
// reproduce bit-for-bit: each entity's id/type/owner/position/hp/cargo/order, both
// economies, and how much fog is revealed. Entities are joined in a FIXED field order
// (not object-key order) and sorted by id, so neither Map iteration order nor JSON key
// order can leak in — only genuine value differences show up.
export function entitySnapshot(state) {
  const units = [...state.units.values()].map(u =>
    [u.id, u.type, u.owner, u.x, u.y, u.hp,
     u.cargo ? u.cargo.qty : "-", u.cargo ? (u.cargo.com || "-") : "-",
     u.order ? JSON.stringify(u.order) : "-"].join("|")
  ).sort();
  const builds = [...state.buildings.values()].map(b =>
    [b.id, b.type, b.owner, b.hp, b.buildProgress ?? "-", b.constructing ? 1 : 0,
     (b.queue || []).length, b.tier || 0, b.charge ?? "-"].join("|")
  ).sort();
  const res = JSON.stringify(state.players.player.resources) + "/" + JSON.stringify(state.players.ai.resources);
  const fog = state.fog.explored.reduce((a, v) => a + v, 0);
  return JSON.stringify({ units, builds, res, fog, tick: state.tick, time: state.time, over: state.over, winner: state.winner });
}

// JSON.stringify with keys sorted, recursively. The header above promises these fingerprints are
// "immune to Map-iteration / JSON-key order" — true of entitySnapshot, whose tuples are joined in a
// fixed field order, but NOT of the two raw JSON.stringify calls below. Live diplomacy grows its
// fields in whatever order the sim happens to assign them, while a loaded one grows them in the
// deserializer's order; identical values in a different insertion order then read as a divergence.
// That's a false failure about the fingerprint, not the sim — exactly what the promise rules out.
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

// Full-precision fingerprint of a whole galaxy: the meta fields plus, per planet (sorted
// by id), its entitySnapshot AND the galaxy-side running state that also has to survive a
// jump/reload — diplomacy stance, market pressure, background flag, AI wave clocks.
export function galaxySnapshot(galaxy) {
  const planets = [...galaxy.planets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, s]) => [
      id, s.background ? 1 : 0,
      entitySnapshot(s),
      stableJson(s.diplomacy || {}),
      stableJson(s.market ? s.market.pressure : {}),
      // Normalise the AI wave clocks the way the engine (and serPlanet) do: an unset counter is
      // zero, an unscheduled wave is "none". Otherwise a live world's `undefined` vs a reloaded
      // world's serialize-defaulted 0/null would read as a difference when the sim treats them
      // identically — a false failure that isn't a real divergence.
      s.ai.nextWaveAt == null ? "-" : s.ai.nextWaveAt,
      Number(s.ai.waveCount) || 0,
    ].join("::"));
  // Freight Lanes + colony standing orders (P6 colony-economy rework): sorted by lane/planet id so
  // Map/array insertion order can't leak a false mismatch, only genuine value differences.
  const lanes = [...(galaxy.lanes || [])]
    .slice().sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(l => [l.id, l.from, l.to, l.commodities.join(","), l.shipIds.join(",")].join("::"));
  const colonyPolicies = [...(galaxy.colonyPolicies || [])]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, p]) => [id, stableJson(p)].join("::"));
  return JSON.stringify({
    seed: galaxy.seed, credits: galaxy.credits, activeId: galaxy.activeId,
    tick: galaxy.tick, time: galaxy.time, entitySeq: galaxy.entitySeq,
    pacified: [...(galaxy.pacified || [])].sort(),
    reached: [...(galaxy.reached || [])].sort(),
    planets, lanes, colonyPolicies,
  });
}

// Every unit of matter `owner` holds anywhere on this world: the treasury, plus every buffer the
// domain can park goods in — a factory's input larder and output backlog, a freighter's freight
// hold, a worker's carried cargo. The economy's defining property is that matter MOVES between
// these; it isn't created or destroyed except where a rule says so. Nothing asserted that anywhere
// (no test summed holdings at all), which is why a wonder that kept eating a finished Gate's feed
// and a deposit that overfilled a hold both lived inside green suites.
export function totalHoldings(state, owner) {
  const out = {};
  const add = bag => { if (bag) for (const com in bag) out[com] = (out[com] || 0) + (bag[com] || 0); };
  add(state.players[owner].resources);
  for (const b of state.buildings.values()) {
    if (b.owner !== owner) continue;
    add(b.store);
    add(b.input);
  }
  for (const u of state.units.values()) {
    if (u.owner !== owner) continue;
    add(u.freight);
    if (u.cargo && u.cargo.com && u.cargo.qty > 0) add({ [u.cargo.com]: u.cargo.qty });
  }
  return out;
}

// A galaxy poised to launch an interplanetary jump FROM the start world: its colony ships
// deployed into Command Centers (a real settled base), a finished Spaceport next to the
// capital, a colony ship staged on the pad, and enough credits to fund the hop. The staple
// fixture for jump + jump-persist tests.
export function jumpReadyGalaxy(seed = 1) {
  const g = createGalaxy({ seed });
  const from = activeState(g);
  for (const u of [...from.units.values()]) if (u.type === "colonyship") deployColonyShip(from, u.id);
  const cc = [...from.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const sp = makeBuilding("spaceport", "player", cc.x + 40, cc.y);
  from.buildings.set(sp.id, sp);
  const ship = makeUnit("colonyship", "player", sp.x, sp.y);
  from.units.set(ship.id, ship);
  g.credits = 2000;
  return g;
}
