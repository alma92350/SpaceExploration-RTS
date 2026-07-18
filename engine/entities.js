/* ============================================================
   Unit & building definitions for the first skirmish slice.
   Costs are in the planet's own deposit commodities (see engine/map.js)
   so the resources you gather are the resources you spend — no separate
   RTS-only currency.
   ============================================================ */

"use strict";

export const BUILDINGS = {
  command: {
    id: "command", name: "Command Center", hp: 1000, radius: 26,
    cost: {}, buildTime: 0,          // pre-placed at game start, never queued
    produces: ["worker"],
    isCommandCenter: true,
    sight: 220,
  },
  barracks: {
    id: "barracks", name: "Barracks", hp: 500, radius: 20,
    cost: { ore: 150 }, buildTime: 20,
    produces: ["skiff", "bastion"],
    sight: 150,
  },
};

export const UNITS = {
  worker: {
    id: "worker", name: "Worker", hp: 40, radius: 6, speed: 60,
    cost: { ore: 50 }, buildTime: 8,
    role: "worker", gatherRate: 10, cargoCap: 10,
    sight: 110,
  },
  skiff: {
    id: "skiff", name: "Skiff", hp: 80, radius: 7, speed: 90,
    cost: { ore: 100 }, buildTime: 12,
    role: "combat", attack: 12, range: 40, cooldown: 1,
    sight: 160, aggroRange: 120,
  },
  bastion: {
    id: "bastion", name: "Bastion", hp: 160, radius: 9, speed: 60,
    cost: { ore: 160 }, buildTime: 18,
    role: "combat", attack: 10, range: 18, cooldown: 1.2,
    sight: 130, aggroRange: 100,
    bonusVs: { skiff: 14 },   // heavy armor built to tear through skiff hulls up close
  },
};

export function canAfford(resources, cost) {
  return Object.entries(cost).every(([com, qty]) => (resources[com] || 0) >= qty);
}

export function payCost(resources, cost) {
  Object.entries(cost).forEach(([com, qty]) => { resources[com] = (resources[com] || 0) - qty; });
}
