/* ============================================================
   STELLAR FRONTIER: RTS — shared universe data
   Carried over verbatim from the original Stellar Frontier (turn-based)
   game's data.js: meta resources, factions, the commodity catalog,
   production recipes, and the 20 charted worlds. Pure data, no game
   logic, so it dropped in unchanged as the shared-flavor seed for this
   real-time game. See README.md for what else did (and didn't) carry
   over from the original repo.
   ============================================================ */

"use strict";

/* ---------- Meta resources (not cargo, shown in the top bar) ---------- */
export const META = {
  credits:   { name: "Credits",   ico: "💰" },
  fuel:      { name: "Fuel",      ico: "⛽" },
  tech:      { name: "Tech Pts",  ico: "🔬" },
  influence: { name: "Influence", ico: "🏛️" },
};

/* ---------- Factions ---------- */
export const FACTIONS = {
  core:      { name: "Core Authority",     ico: "⚖️", color: "#3b82f6",
               desc: "Lawful government of the inner worlds. Hates smugglers." },
  miners:    { name: "Mining Guild",       ico: "⛏️", color: "#b45309",
               desc: "Controls ore, metals and heavy industry." },
  agri:      { name: "Agri-Combine",       ico: "🌾", color: "#16a34a",
               desc: "Feeds the sector; values relief and fair trade." },
  syndicate: { name: "Tech Syndicate",     ico: "🔬", color: "#8b5cf6",
               desc: "Masters of electronics, research and... discretion." },
  frontier:  { name: "Frontier Coalition", ico: "🛰️", color: "#06b6d4",
               desc: "Free traders of the rim. Friendly to smugglers." },
};

/* ---------- Commodity catalog (tiered) ----------
   tier:    Raw | Refined | Component | Finished | Luxury | Strategic
   base:    reference price
   extract: mine | forage | capture | exploit  (raw resources only)
   illegalAt: list of planet ids where carrying/selling is contraband
   hazard:  true if dangerous to carry without a Shielded Hold
*/
export const COM = {
  // ----- RAW -----
  ore:         { name: "Ore",            ico: "🪨", tier: "Raw", base: 9,  extract: "mine" },
  crystals:    { name: "Crystals",       ico: "💎", tier: "Raw", base: 30, extract: "mine" },
  radioactives:{ name: "Radioactives",   ico: "☢️", tier: "Raw", base: 36, extract: "mine",
                 illegalAt: ["terra", "verdani"], hazard: true },
  ice:         { name: "Ice",            ico: "🧊", tier: "Raw", base: 8,  extract: "mine" },
  biomass:     { name: "Biomass",        ico: "🌿", tier: "Raw", base: 7,  extract: "forage" },
  spice:       { name: "Spice",          ico: "🌶️", tier: "Raw", base: 34, extract: "forage" },
  gas:         { name: "Helium-3",       ico: "🎈", tier: "Raw", base: 18, extract: "capture" },
  relics:      { name: "Relics",         ico: "🏺", tier: "Raw", base: 52, extract: "exploit",
                 illegalAt: ["terra", "verdani", "kybernet", "forge"], hazard: false },
  // ----- REFINED -----
  metals:      { name: "Metals",         ico: "⛓️", tier: "Refined", base: 22 },
  energy:      { name: "Energy Cells",   ico: "⚡", tier: "Refined", base: 9 },
  fuel:        { name: "Fuel",           ico: "⛽", tier: "Refined", base: 14, isFuel: true },
  chemicals:   { name: "Chemicals",      ico: "⚗️", tier: "Refined", base: 16 },
  medicine:    { name: "Medicine",       ico: "💊", tier: "Refined", base: 78 },
  // ----- COMPONENTS -----
  alloys:      { name: "Alloys",         ico: "🔩", tier: "Component", base: 80 },
  electronics: { name: "Electronics",    ico: "🖥️", tier: "Component", base: 95 },
  // ----- FINISHED -----
  goods:       { name: "Consumer Goods", ico: "📦", tier: "Finished", base: 130 },
  machinery:   { name: "Machinery",      ico: "⚙️", tier: "Finished", base: 250 },
  weapons:     { name: "Weapons",        ico: "🔫", tier: "Finished", base: 270,
                 illegalAt: ["terra", "verdani"], hazard: true },
  // ----- LUXURY / STRATEGIC -----
  luxury:      { name: "Luxury Goods",   ico: "💠", tier: "Luxury", base: 220 },
  drones:      { name: "Combat Drones",  ico: "🛸", tier: "Component", base: 140 },
  ai:          { name: "AI Cores",       ico: "🧠", tier: "Strategic", base: 380,
                 illegalAt: ["terra", "verdani"] },
  antimatter:  { name: "Antimatter",     ico: "🌀", tier: "Strategic", base: 420,
                 illegalAt: ["terra", "verdani", "kybernet", "forge", "glacius"], hazard: true },
  plasmatorp:  { name: "Plasma Torpedoes", ico: "💥", tier: "Strategic", base: 460,
                 illegalAt: ["terra", "verdani", "kybernet", "forge", "glacius"], hazard: true },
};
export const COM_IDS = Object.keys(COM);
export const CARGO_IDS = COM_IDS.filter(id => !COM[id].isFuel); // everything except fuel uses the ship's cargo hold
export const STORE_IDS = CARGO_IDS.concat(["fuel"]);            // base/colony storage & the trade network also hold/move fuel
export const TIERS = ["Raw", "Refined", "Component", "Finished", "Luxury", "Strategic"];

/* ---------- Production recipes ----------
   out: commodity produced, qty: per-batch yield, in: input map, req: tech id
   kind: "refine" | "make" (for grouping); boosted differently by modules
*/
export const RECIPES = [
  { id: "smelt",   out: "metals",      qty: 2, in: { ore: 2, energy: 2 },                         kind: "refine" },
  { id: "biogen",  out: "energy",      qty: 2, in: { biomass: 2 },                                kind: "refine" },
  { id: "gasgen",  out: "energy",      qty: 3, in: { gas: 1 },                                    kind: "refine" },
  { id: "reactor", out: "energy",      qty: 5, in: { radioactives: 1 }, req: "reactors",          kind: "refine", reactor: true },
  { id: "crackice",out: "fuel",        qty: 2, in: { ice: 3 },                                    kind: "refine" },
  { id: "crackgas",out: "fuel",        qty: 2, in: { gas: 1 }, req: "gasfuel",                    kind: "refine" },
  { id: "chem",    out: "chemicals",   qty: 2, in: { biomass: 2, energy: 1 },                     kind: "refine" },
  { id: "medlab",  out: "medicine",    qty: 1, in: { spice: 1, chemicals: 1, energy: 1 }, req: "biotech", kind: "make" },
  { id: "alloy",   out: "alloys",      qty: 1, in: { metals: 2, energy: 2 }, req: "metallurgy",   kind: "make" },
  { id: "chipfab", out: "electronics", qty: 1, in: { crystals: 1, metals: 1, energy: 2 }, req: "electronics", kind: "make" },
  { id: "consumer",out: "goods",       qty: 1, in: { alloys: 1, chemicals: 1, energy: 1 },        kind: "make" },
  { id: "machine", out: "machinery",   qty: 1, in: { alloys: 1, electronics: 1, energy: 1 },      kind: "make" },
  { id: "weapfab", out: "weapons",     qty: 1, in: { alloys: 1, electronics: 1, radioactives: 1 }, req: "weapontech", kind: "make" },
  { id: "luxefab", out: "luxury",      qty: 1, in: { spice: 2, electronics: 1, energy: 1 },       kind: "make" },
  { id: "dronefab",out: "drones",      qty: 1, in: { alloys: 1, electronics: 1, energy: 1 }, req: "dronetech",  kind: "make" },
  { id: "aifab",   out: "ai",          qty: 1, in: { electronics: 2, crystals: 1, energy: 3 }, req: "aicores",   kind: "make" },
  { id: "antifab", out: "antimatter",  qty: 1, in: { relics: 2, electronics: 1, energy: 3 }, req: "antimatter", kind: "make" },
  { id: "plasmafab", out: "plasmatorp", qty: 1, in: { antimatter: 1, alloys: 2, radioactives: 2 }, req: "antimatter", kind: "make" },
];

/* ---------- Planets (10) ----------
   deposits: { commodityId: yieldMult }  — what can be extracted HERE
   salvage / bounty: special capture actions available here
   enforce: 0..1 contraband enforcement strength
   faction: controlling faction id
*/
export const PLANETS = [
  { id: "terra", name: "Terra Nova", tag: "Capital • Garden World", color: "#3b82f6", x: 0,
    faction: "core", industry: 6, tech: 7, enforce: 0.92,
    desc: "Cradle of the colonies — lush, populous, politically dominant and mineral-poor. Smuggling here is suicide.",
    deposits: { biomass: 1.4, spice: 0.6 } },
  { id: "glacius", name: "Glacius", tag: "Ice World", color: "#7dd3fc", x: 2,
    faction: "core", industry: 2, tech: 3, enforce: 0.5,
    desc: "A frozen ball of water-ice. Crack it for fuel and life-support across the sector.",
    deposits: { ice: 2.0, gas: 0.4 } },
  { id: "ferros", name: "Ferros Prime", tag: "Mining World", color: "#b45309", x: 3,
    faction: "miners", industry: 4, tech: 3, enforce: 0.42,
    desc: "A scarred iron giant. Drowning in ore and radioactives, starved for food.",
    deposits: { ore: 2.0, crystals: 0.7, radioactives: 1.0 } },
  { id: "verdani", name: "Verdani", tag: "Agri-World", color: "#16a34a", x: 5,
    faction: "agri", industry: 3, tech: 4, enforce: 0.7,
    desc: "Endless terraced farms feed half the sector. Spice grows wild in the highlands.",
    deposits: { biomass: 2.0, spice: 1.0 } },
  { id: "helix", name: "Helix Belt", tag: "Asteroid Belt", color: "#9ca3af", x: 6,
    faction: "miners", industry: 3, tech: 4, enforce: 0.4, salvage: true,
    desc: "A glittering ring of rubble — ore, crystals and the wrecks of those who came before.",
    deposits: { ore: 1.6, crystals: 1.4, radioactives: 1.0 } },
  { id: "kybernet", name: "Kybernet", tag: "Tech Hub", color: "#8b5cf6", x: 8,
    faction: "syndicate", industry: 8, tech: 10, enforce: 0.6,
    desc: "A neon arcology of laboratories and fabricators. Highest tech, high prices, looser laws.",
    deposits: { crystals: 1.2 } },
  { id: "nimbus", name: "Nimbus", tag: "Gas Giant", color: "#f59e0b", x: 9,
    faction: "frontier", industry: 3, tech: 5, enforce: 0.3,
    desc: "A banded storm-world. Skim its clouds for Helium-3 — if your ship can take the pressure.",
    deposits: { gas: 2.0 } },
  { id: "forge", name: "Forge Station", tag: "Industrial World", color: "#ef4444", x: 11,
    faction: "miners", industry: 10, tech: 6, enforce: 0.6,
    desc: "A planet-sized factory. Turns raw materials into finished goods at unmatched scale.",
    deposits: { ore: 1.0 } },
  { id: "oort", name: "Oort Reach", tag: "Frontier Outpost", color: "#06b6d4", x: 15,
    faction: "frontier", industry: 2, tech: 2, enforce: 0.15, salvage: true, bounty: true,
    desc: "The lawless edge of charted space. Rich, dangerous, and the best place to move hot cargo.",
    deposits: { ore: 1.2, radioactives: 1.2, relics: 0.6 } },
  { id: "erebus", name: "Erebus", tag: "Ancient Ruins", color: "#a78bfa", x: 18,
    faction: "frontier", industry: 1, tech: 3, enforce: 0.05, salvage: true, bounty: true,
    desc: "A dead world wrapped in the ruins of a vanished civilisation. Relics for the brave, law for no one.",
    deposits: { relics: 1.3, radioactives: 0.6 } },
  { id: "aquaria", name: "Aquaria", tag: "Ocean World", color: "#0ea5e9", x: 4,
    faction: "agri", industry: 2, tech: 5, enforce: 0.65,
    desc: "A world of endless seas. Vast kelp farms and clean water keep the inner colonies alive.",
    deposits: { biomass: 1.6, ice: 1.0 } },
  { id: "pyralis", name: "Pyralis", tag: "Desert World", color: "#fbbf24", x: 7,
    faction: "core", industry: 4, tech: 5, enforce: 0.72,
    desc: "Sun-blasted dunes that glitter with crystal fields and hide isotopes beneath the sand.",
    deposits: { crystals: 1.4, radioactives: 0.8 } },
  { id: "cobalt", name: "Cobalt Hub", tag: "Free Port", color: "#6366f1", x: 10,
    faction: "syndicate", industry: 6, tech: 7, enforce: 0.45,
    desc: "A free-port arcology where every commodity changes hands. Deep markets, slim margins, few questions.",
    deposits: { crystals: 0.9, gas: 0.5 } },
  { id: "korrath", name: "Korrath", tag: "Warlord World", color: "#dc2626", x: 14,
    faction: "frontier", industry: 3, tech: 2, enforce: 0.1, salvage: true, bounty: true,
    desc: "A contested frontier world. Bounties posted on every screen, wrecks in every orbit, law a rumour.",
    deposits: { ore: 1.3, radioactives: 1.1, relics: 0.7 } },
  { id: "vesper", name: "Vesper", tag: "Twilight World", color: "#64748b", x: 17,
    faction: "miners", industry: 5, tech: 4, enforce: 0.45,
    desc: "A perpetual-dusk world straddling the asteroid lanes — ore and gas hauled out in equal measure.",
    deposits: { ore: 1.5, crystals: 1.0, gas: 0.6 } },

  // ---- Colonizable frontier worlds (undeveloped; you grow their economy) ----
  { id: "aurora", name: "Aurora", tag: "Untamed World", color: "#34d399", x: 13,
    faction: "frontier", industry: 1, tech: 1, enforce: 0.1, colonizable: true,
    desc: "A green, unclaimed world ripe for settlement. Fertile soil and shallow ore seams await a founder.",
    deposits: { biomass: 1.3, ore: 0.9 } },
  { id: "cinder", name: "Cinder", tag: "Volcanic World", color: "#f97316", x: 16,
    faction: "frontier", industry: 1, tech: 1, enforce: 0.08, colonizable: true,
    desc: "A restless volcanic world — harsh, but its crust is gorged with ore, crystals and isotopes.",
    deposits: { ore: 1.5, crystals: 1.1, radioactives: 1.0 } },

  // ---- Hidden worlds (revealed by Deep-Space Survey) ----
  { id: "pandora", name: "Pandora", tag: "Jungle World", color: "#22c55e", x: 21,
    faction: "frontier", industry: 1, tech: 2, enforce: 0.05, colonizable: true, hidden: true,
    desc: "A riotous jungle world rumoured beyond the Reach. Drips with biomass and rare spice.",
    deposits: { biomass: 1.8, spice: 1.4 } },
  { id: "tartarus", name: "Tartarus", tag: "Shattered World", color: "#b91c1c", x: 24,
    faction: "frontier", industry: 1, tech: 1, enforce: 0.03, colonizable: true, hidden: true, salvage: true,
    desc: "A broken planet of metal and bone at the edge of the charts — ore, isotopes and ancient relics.",
    deposits: { ore: 1.6, radioactives: 1.3, relics: 1.0 } },
  { id: "elysium", name: "Elysium", tag: "Paradise World", color: "#38bdf8", x: 28,
    faction: "frontier", industry: 1, tech: 2, enforce: 0.02, colonizable: true, hidden: true,
    desc: "A legendary garden world said to lie past the dark. The finest colony site in the galaxy.",
    deposits: { biomass: 2.0, spice: 1.2, crystals: 1.0 } },
];
// pristine snapshot of the charted 20's stats, captured once at parse time — every
// applyCoreVariance() call (in game.js) recomputes FROM this baseline, never from
// whatever the previous seed/playthrough left behind, so re-applying it (a mid-session
// New Game reuses these same 20 objects, unlike the frontier ring) can never compound drift.
export const CORE_BASELINE = PLANETS.map(p => ({ id: p.id, industry: p.industry, tech: p.tech, enforce: p.enforce, deposits: { ...p.deposits } }));
