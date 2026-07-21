/* ============================================================
   The Odyssey research tree (Phase 2). Nodes are researched at a Datacenter,
   PAID IN GATHERED COMMODITIES (the game's law — the resources you gather are the
   resources you spend, no separate research currency) and DEVELOPED OVER TIME,
   scaled by the world's tech rating so a Syndicate hub out-researches a frontier
   rock. A researched node is an id in player.upgrades — the SAME bag the combat
   doctrines use — so it gates buildings/recipes through the existing prereqsMet
   primitive with zero new gating machinery. committedDoctrine/upgradeMult
   (entities.js) both guard on UPGRADES membership, so a tech id parked in upgrades
   is invisible to the doctrine system; the passive-effect nodes are read here via
   techMult instead.

   Odyssey-only and inert-by-construction: the Datacenter is `odysseyOnly`,
   updateResearch is a no-op for any other building, and the skirmish AI never
   builds one — so the skirmish sim/AI path is untouched and stays byte-identical
   (a tech id is never in a skirmish player.upgrades). Deterministic and DOM-free:
   accrual is dt-driven float math with no wall-clock and no unseeded randomness.
   ============================================================ */

"use strict";

import { PLANETS } from "../data.js";
import { canAfford, payCost, prereqsMet } from "./entities.js";

// The tree. `cost` is gathered commodities (paid on start); `time` is seconds to
// develop at a tech-5 world (scaled by researchTimeScale). `requires` are prereq
// tokens resolved by prereqsMet (a building type or another node). A node either
// UNLOCKS content (its id gates a building/recipe via `requires` elsewhere) or is
// a PASSIVE that multiplies industry (powerMult / rateMult / yieldMult, read by
// techMult). The three unlock nodes form the buildable spine; the three passives
// branch off it so "research next building" vs "boost what I have" is a real fork.
// `ico` reuses the data.js commodity icons where a node maps to a good (metals ⛓️, electronics
// 🖥️, antimatter 🌀, AI cores 🧠), or a thematic emoji for the pure boosts — so the research
// buttons carry the same iconography as the rest of the game (hud.js).
export const TECHS = {
  metallurgy: { id: "metallurgy", name: "Metallurgy", ico: "⛓️", cost: { crystals: 80 }, time: 20,
    desc: "Unlock the Assembly Plant — refine metals into alloys." },
  reactors: { id: "reactors", name: "Fusion Containment", ico: "⚡", cost: { crystals: 70 }, time: 18,
    powerMult: 1.5, desc: "+50% Power from every Reactor." },
  heavyalloys: { id: "heavyalloys", name: "Heavy Alloys", ico: "🔩", cost: { crystals: 110 }, time: 24, requires: ["metallurgy"],
    yieldMult: 1.4, desc: "+40% output from the Smelter and Assembly Plant." },
  electronics: { id: "electronics", name: "Microelectronics", ico: "🖥️", cost: { crystals: 120 }, time: 28, requires: ["metallurgy"],
    desc: "Unlock the Chip Fab — make electronics from crystals and metals." },
  automation: { id: "automation", name: "Factory Automation", ico: "🤖", cost: { crystals: 130, radioactives: 40 }, time: 30, requires: ["electronics"],
    rateMult: 1.25, desc: "+25% production speed at every factory." },
  machining: { id: "machining", name: "Precision Machining", ico: "🛠️", cost: { crystals: 150, radioactives: 60 }, time: 36, requires: ["electronics"],
    desc: "Unlock the Machine Works — build machinery from alloys and electronics." },
  // The strategic capstone (Phase 3): unlocks the Antimatter Forge, and with it the
  // Antimatter Gate — Odyssey's endgame. The deepest, priciest node on the tree.
  antimatter: { id: "antimatter", name: "Antimatter Containment", ico: "🌀", cost: { crystals: 220, radioactives: 100 }, time: 44, requires: ["machining"],
    desc: "Unlock the Antimatter Forge — the top of the chain, and the key to the Antimatter Gate." },
  // The full Strategic tier: the two remaining strategic goods, which fuel the
  // Antimatter Gate and the Leviathan capital ship.
  aicores: { id: "aicores", name: "Machine Minds", ico: "🧠", cost: { crystals: 260, radioactives: 130 }, time: 48, requires: ["antimatter"],
    desc: "Unlock the AI Foundry and Torpedo Works — cultivate AI Cores and Plasma Torpedoes." },
};

// Research develops faster on a high-tech world (data.js PLANETS.tech, 1..10) and
// slower on a frontier rock — clamped so no world is punishing. Pure data lookup;
// the sole reason WHERE you research is a strategic choice. Deterministic.
export function researchTimeScale(state) {
  const t = PLANETS.find(p => p.id === state.planetId)?.tech ?? 5;
  const s = 5 / t;                       // tech 5 → 1.0×, tech 10 → 0.5×, tech 1 → 5× (clamped)
  return s < 0.5 ? 0.5 : s > 2 ? 2 : s;
}

// Product of a passive node's multiplier field across a player's researched techs
// (1 when none apply) — the tech-tree twin of entities.js upgradeMult, reading
// TECHS instead of UPGRADES. Inert in skirmish (no TECH id is ever in a skirmish
// player.upgrades).
export function techMult(upgrades, field) {
  let m = 1;
  if (!upgrades) return m;
  for (const id in upgrades) if (upgrades[id] && TECHS[id] && TECHS[id][field]) m *= TECHS[id][field];
  return m;
}

// Advance a Datacenter's research QUEUE by dt — a no-op for anything that isn't a
// completed Datacenter with a queued job. Develops the head of the queue; on
// completion the node lands in player.upgrades (where prereqsMet/techMult read it),
// the job is dropped, and the next queued node begins. Same dt-driven float pattern
// as buildProgress — deterministic, engine-pure.
export function updateResearch(state, building, dt) {
  if (building.constructing || building.type !== "datacenter") return;
  const queue = building.researchQueue;
  if (!queue || queue.length === 0) return;
  const job = queue[0];
  const def = TECHS[job.techId];
  if (!def) { queue.shift(); return; }
  job.progress += dt / (def.time * researchTimeScale(state));
  if (job.progress >= 1) {
    state.players[building.owner].upgrades[job.techId] = true;
    queue.shift();
    state.events.push({ type: "researchComplete", techId: def.id, x: building.x, y: building.y, owner: building.owner });
  }
}

// Queue a node for research at a Datacenter: needs a completed Datacenter, the node
// not already owned or queued, its prereqs met OR already queued AHEAD of it (so a
// whole path can be lined up at once and stop being babysat one node at a time),
// and affordability — then pay (gathered commodities, on enqueue like the
// production queue) and append it. Mirrors production.js researchUpgrade, but timed
// and queued rather than instant and single.
export function researchTech(state, buildingId, techId) {
  const building = state.buildings.get(buildingId);
  if (!building || building.type !== "datacenter" || building.constructing) return false;
  const player = state.players[building.owner];
  if (player.upgrades[techId]) return false;                     // already researched
  const queue = building.researchQueue || (building.researchQueue = []);
  if (queue.some(j => j.techId === techId)) return false;        // already queued
  const def = TECHS[techId];
  if (!def) return false;
  // A prereq counts as met if it's researched, a completed building, OR queued
  // ahead on this same Datacenter (it'll finish first). prereqsMet covers the first
  // two; filter out the queued-ahead tokens before delegating to it.
  const queuedAhead = new Set(queue.map(j => j.techId));
  const remaining = (def.requires || []).filter(r => !queuedAhead.has(r));
  if (!prereqsMet(state, building.owner, { requires: remaining })) return false;
  if (!canAfford(player.resources, def.cost)) return false;
  payCost(player.resources, def.cost);
  queue.push({ techId, progress: 0 });
  return true;
}
