import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMap, MAP_WIDTH, MAP_HEIGHT, PLANET_MODIFIERS, sideMod } from "../engine/map.js";
import { PLANET_ARCHETYPE } from "../engine/aiArchetypes.js";
import { PLANETS } from "../data.js";

// Tiny deterministic PRNG so two generateMap runs can share an identical
// rng sequence (() => 0.5 can't distinguish "same seed" from "constant").
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("generateMap only scatters surface nodes for commodities the planet actually deposits", () => {
  const map = generateMap("ferros", () => 0.5);
  const coms = new Set(map.nodes.filter(n => !n.hidden).map(n => n.com));   // hidden caches can add others
  assert.deepEqual([...coms].sort(), ["crystals", "ore", "radioactives"]);
});

test("generateMap mirrors clusters so both bases start with access to every deposit", () => {
  const map = generateMap("ferros", () => 0.5);
  const oreNodes = map.nodes.filter(n => n.com === "ore");
  assert.equal(oreNodes.length % 2, 0);
  const nearPlayer = oreNodes.filter(n => n.x < MAP_WIDTH / 2).length;
  const nearAi = oreNodes.filter(n => n.x >= MAP_WIDTH / 2).length;
  assert.equal(nearPlayer, nearAi);
});

test("generateMap places the two bases inside the map bounds", () => {
  const map = generateMap("ferros");
  for (const base of Object.values(map.bases)) {
    assert.ok(base.x >= 0 && base.x <= MAP_WIDTH);
    assert.ok(base.y >= 0 && base.y <= MAP_HEIGHT);
  }
});

test("generateMap throws on an unknown planet id", () => {
  assert.throws(() => generateMap("not-a-real-planet"));
});

test("no two nodes overlap, even across different commodity types", () => {
  // rng() => 0.5 is the exact seed that used to land an ore cluster and a
  // crystals cluster on the identical point (each commodity picks its own
  // y-band independently, with no coordination between them).
  for (const planetId of ["ferros", "korrath", "vesper", "glacius", "helix"]) {
    const map = generateMap(planetId, () => 0.5);
    for (let i = 0; i < map.nodes.length; i++) {
      for (let j = i + 1; j < map.nodes.length; j++) {
        const a = map.nodes[i], b = map.nodes[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(dist >= 32 - 1e-6, `${planetId}: ${a.com} node and ${b.com} node are only ${dist.toFixed(1)} apart`);
      }
    }
  }
});

test("overlap resolution keeps every node inside the map bounds", () => {
  const map = generateMap("ferros", () => 0.5);
  for (const n of map.nodes) {
    assert.ok(n.x >= 0 && n.x <= MAP_WIDTH, `node x=${n.x} out of bounds`);
    assert.ok(n.y >= 0 && n.y <= MAP_HEIGHT, `node y=${n.y} out of bounds`);
  }
});

test("a world that deposits no ore still gets a mirrored ore cluster near each base", () => {
  const map = generateMap("glacius", () => 0.5);   // glacius deposits only ice and gas
  const oreNodes = map.nodes.filter(n => n.com === "ore");
  assert.ok(oreNodes.length > 0, "the guarantee should have inserted ore");
  assert.equal(oreNodes.length % 2, 0, "guaranteed ore should come as mirrored pairs");
  const left = oreNodes.filter(n => n.x < MAP_WIDTH / 2).length;
  const right = oreNodes.filter(n => n.x >= MAP_WIDTH / 2).length;
  assert.equal(left, right);
  for (const base of Object.values(map.bases)) {
    const near = oreNodes.some(n => Math.hypot(n.x - base.x, n.y - base.y) <= 500);
    assert.ok(near, "each base should have an ore node within reach");
  }
});

test("every charted world yields ore within reach of both bases", () => {
  for (const planet of PLANETS) {
    const map = generateMap(planet.id, () => 0.5);
    for (const base of Object.values(map.bases)) {
      const near = map.nodes.some(n => n.com === "ore" &&
        Math.hypot(n.x - base.x, n.y - base.y) <= 500);
      assert.ok(near, `${planet.id}: no ore within 500 of the base at (${base.x}, ${base.y})`);
    }
  }
});

test("the ore guarantee never fires on an ore-bearing world: ferros keeps its deposit-table node count", () => {
  const map = generateMap("ferros", () => 0.5);
  // surface deposit ore only — caches (hidden) and the fixed home cluster (home) are separate
  const oreNodes = map.nodes.filter(n => n.com === "ore" && !n.hidden && !n.home);
  assert.equal(oreNodes.length, Math.round(2.0 * 1.5) * 2);   // ferros' ore yieldMult drives exactly 3 mirrored clusters
});

test("generateMap is deterministic: the same planet and rng seed reproduce the same nodes", () => {
  const a = generateMap("glacius", lcg(42));
  const b = generateMap("glacius", lcg(42));
  assert.deepEqual(a.nodes, b.nodes);
});

test("asymmetric worlds apply per-side modifiers; symmetric worlds tilt both sides equally", () => {
  const oort = { map: generateMap("oort", () => 0.5) };
  assert.equal(sideMod(oort, "player", "gatherMult"), 1.2, "the player's richer claim banks more");
  assert.equal(sideMod(oort, "ai", "gatherMult", 1), 1, "the enemy gets no gather bonus");
  assert.equal(sideMod(oort, "ai", "buildTimeMult"), 0.82, "the enemy's factory builds faster");
  assert.equal(sideMod(oort, "player", "buildTimeMult"), 1, "the player builds at the normal rate");

  const nimbus = { map: generateMap("nimbus", () => 0.5) };
  assert.equal(sideMod(nimbus, "player", "sightMult"), 0.95, "the player sees through the thinning storm");
  assert.equal(sideMod(nimbus, "ai", "sightMult"), 0.75, "the enemy stays in the murk (the world's shared value)");
  assert.equal(sideMod(nimbus, "ai", "speedMult"), 1.12, "but the enemy strikes faster out of it");

  // A symmetric world tilts both sides equally, and an unmodified one is neutral.
  const glacius = { map: generateMap("glacius", () => 0.5) };
  assert.equal(sideMod(glacius, "player", "speedMult"), sideMod(glacius, "ai", "speedMult"), "glacius slows both sides the same");
  const ferros = { map: generateMap("ferros", () => 0.5) };
  assert.equal(sideMod(ferros, "player", "speedMult"), 1, "ferros has no modifier -> default");
});

test("generateMap attaches the planet's modifiers (empty for the unmodified worlds)", () => {
  assert.deepEqual(generateMap("ferros", () => 0.5).modifiers, {}, "ferros carries no modifiers");
  assert.equal(generateMap("glacius", () => 0.5).modifiers.speedMult, 0.9, "glacius slows every unit");
});

test("helix's dense belt adds one extra crystal cluster per side, on top of its deposit table", () => {
  const map = generateMap("helix", () => 0.5);
  const crystals = map.nodes.filter(n => n.com === "crystals" && !n.hidden);   // surface crystals only
  const left = crystals.filter(n => n.x < MAP_WIDTH / 2).length;
  const right = crystals.filter(n => n.x >= MAP_WIDTH / 2).length;
  // helix crystals yieldMult 1.4 -> round(1.4 * 1.5) = 2 deposit clusters per side, + 1 belt cluster.
  assert.equal(left, Math.round(1.4 * 1.5) + 1);
  assert.equal(right, Math.round(1.4 * 1.5) + 1);
});

test("oort's rich frontier makes its deposits hold 30% more", () => {
  const map = generateMap("oort", () => 0.5);
  // surface deposit ore only — home cluster and hidden caches size differently
  const oreNodes = map.nodes.filter(n => n.com === "ore" && !n.hidden && !n.home);
  assert.ok(oreNodes.length > 0);
  // oort deposits ore at 1.2, so the ore guarantee never fires here — every
  // surface ore node is a deposit-table node scaled by the 1.3 nodeAmountMult.
  for (const n of oreNodes) {
    assert.equal(n.max, Math.round(600 * 1.2 * 1.3));
  }
});

test("every world seeds hidden caches out in the field, away from both bases", () => {
  for (const id of ["ferros", "korrath", "glacius"]) {
    const map = generateMap(id, () => 0.5);
    const caches = map.nodes.filter(n => n.hidden);
    assert.ok(caches.length >= 6, `${id}: should scatter several discoverable caches`);
    for (const c of caches) {
      assert.ok(c.amount > 0 && c.max > 0, "a cache holds a real amount");
      assert.ok(["ore", "crystals", "radioactives"].includes(c.com), "caches hold spendable commodities");
      for (const base of Object.values(map.bases)) {
        assert.ok(Math.hypot(c.x - base.x, c.y - base.y) > 300, `${id}: a cache must sit out where you have to explore for it`);
      }
    }
  }
});

test("every world guarantees a near-base surface source of every build-critical resource", () => {
  // ore (all units/buildings), crystals (Turret, Reinforced Plating) and
  // radioactives (Breacher, Overcharged Weapons) must be buildable on any
  // world — even ones whose deposit table lacks them (korrath has no crystals,
  // vesper no radioactives) get a lean guaranteed seam near the base. The
  // planet's own deposits still shape how *much* of each there is.
  const near = 500 + 60;   // the near-base radius, plus slack for overlap relaxation
  for (const id of ["korrath", "vesper", "glacius", "nimbus", "ferros", "forge"]) {
    const map = generateMap(id, () => 0.5);
    for (const com of ["ore", "crystals", "radioactives"]) {
      const nearBase = map.nodes.some(n => n.com === com && !n.hidden &&
        Math.hypot(n.x - map.bases.player.x, n.y - map.bases.player.y) <= near);
      assert.ok(nearBase, `${id}: needs a surface ${com} source near the base for its builds`);
    }
  }
});

test("a world rich in a commodity keeps its big deposits; a world without it gets only the minimum", () => {
  // helix deposits crystals heavily; korrath deposits none. Both are buildable,
  // but helix's surface crystal total should dwarf korrath's guaranteed floor.
  const total = (id, com) => generateMap(id, () => 0.5).nodes
    .filter(n => n.com === com && !n.hidden).reduce((s, n) => s + n.amount, 0);
  assert.ok(total("helix", "crystals") > total("korrath", "crystals") * 2,
    "the planet's deposit table still drives how much of a resource it holds");
});

test("map size scales the dimensions, bases, and node bounds; sizeMult 1 is the Small default", () => {
  const small = generateMap("ferros", () => 0.5);
  assert.equal(small.width, MAP_WIDTH);
  assert.equal(small.height, MAP_HEIGHT);

  const big = generateMap("ferros", () => 0.5, { sizeMult: 3 });
  assert.equal(big.width, MAP_WIDTH * 3);
  assert.equal(big.height, MAP_HEIGHT * 3);
  assert.ok(Math.abs(big.bases.player.x - big.width * 0.1) < 1e-6, "player base stays at 10% in");
  assert.ok(Math.abs(big.bases.ai.x - big.width * 0.9) < 1e-6, "AI base stays at 90% in");
  for (const n of big.nodes) {
    assert.ok(n.x >= 0 && n.x <= big.width && n.y >= 0 && n.y <= big.height, "every node stays inside the bigger map");
  }
});

test("every base opens onto home ore at a fixed distance, on every map size and world", () => {
  // The whole point of the home cluster: the opening economy can't scale away
  // from the base as the map grows. On Small through Gigantic, and on a world
  // that deposits no ore at all, both bases must have reachable ore within a
  // fixed absolute radius — enough to fund a 400-ore second Command Center.
  const HOME_REACH = 260;   // ~165px offset + overlap-relaxation slack; independent of map size
  for (const size of [1, 2, 4]) {
    for (const id of ["ferros", "glacius"]) {   // glacius deposits no ore — only the home cluster can satisfy this
      const map = generateMap(id, () => 0.5, { sizeMult: size });
      for (const [side, base] of Object.entries(map.bases)) {
        const homeOre = map.nodes.filter(n => n.com === "ore" && n.home &&
          Math.hypot(n.x - base.x, n.y - base.y) <= HOME_REACH);
        assert.ok(homeOre.length > 0, `${id} ${size}x: ${side} base needs home ore within ${HOME_REACH}`);
        const total = homeOre.reduce((s, n) => s + n.amount, 0);
        assert.ok(total >= 400, `${id} ${size}x: ${side} home ore (${total}) must fund a second Command Center`);
      }
    }
  }
});

test("home ore is mirrored so both starts get the identical head start", () => {
  const map = generateMap("ferros", () => 0.5);
  const home = map.nodes.filter(n => n.home);
  const left = home.filter(n => n.x < MAP_WIDTH / 2);
  const right = home.filter(n => n.x >= MAP_WIDTH / 2);
  assert.equal(left.length, right.length, "same count of home nodes each side");
  assert.equal(left.reduce((s, n) => s + n.amount, 0), right.reduce((s, n) => s + n.amount, 0),
    "same total home ore each side");
});

test("sizeMult 1 / resourceMult 1 reproduces the original map byte-for-byte", () => {
  const a = generateMap("ferros", lcg(99));
  const b = generateMap("ferros", lcg(99), { sizeMult: 1, resourceMult: 1 });
  assert.deepEqual(a.nodes, b.nodes, "explicit defaults must match the implicit ones exactly");
});

test("the resource multiplier scales deposit amounts up (abundant) and down (rare)", () => {
  const oreTotal = mult => generateMap("ferros", () => 0.5, { resourceMult: mult }).nodes
    .filter(n => n.com === "ore").reduce((s, n) => s + n.amount, 0);
  const rare = oreTotal(0.6), normal = oreTotal(1), abundant = oreTotal(1.5);
  assert.ok(rare < normal && normal < abundant, "Rare < Normal < Abundant ore on the same world");
  assert.ok(Math.abs(abundant / normal - 1.5) < 0.05, "abundant is ~1.5x normal");
});

test("bigger maps seed more hidden caches to fill the larger contested space", () => {
  const caches = size => generateMap("ferros", () => 0.5, { sizeMult: size }).nodes.filter(n => n.hidden).length;
  assert.ok(caches(4) > caches(1), "a Gigantic map should hide more caches than a Small one");
});

test("every modified world is a real planet with a nonempty label, and has an archetype", () => {
  for (const [id, mod] of Object.entries(PLANET_MODIFIERS)) {
    assert.ok(PLANETS.some(p => p.id === id), `${id} should be a real planet`);
    assert.ok(id in PLANET_ARCHETYPE, `${id} should be in the picker roster`);
    assert.ok(mod.label && mod.label.length > 0, `${id} should carry a human-readable label`);
  }
});
