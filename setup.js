/* ============================================================
   The splash / map-select screen: the skirmish setup panel (difficulty,
   faction, map size, resources, seed) and the battlefield cards. Owns the
   shared `setup` config object that boot.js reads when it starts a game.
   The initial renderMapSelect() kickoff is called by main.js; the game-over
   "choose another battlefield" button (hud.js) re-invokes it via boot.
   ============================================================ */

"use strict";

import { mapSelectEl } from "./dom.js";
import { PLANETS } from "./data.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { archetypeFor, PLANET_ARCHETYPE } from "./engine/aiArchetypes.js";
import { FACTIONS, PLAYABLE_FACTIONS } from "./engine/factions.js";
import { hasSave, loadGame, hasOdysseySave, loadOdyssey } from "./saveload.js";
import { startGame, startScenario, startRaider, startBounty, startOdyssey } from "./boot.js";
import * as sound from "./sound.js";

// The curated roster and its order both come from the AI archetype table, so
// the picker, the opponent temperament, and the tests all agree on one list.
const MAP_CHOICES = Object.keys(PLANET_ARCHETYPE);

// Splash-screen game setup, carried across "choose another battlefield"
// restarts. sizeMult scales the map (map.js); resourceMult scales every
// deposit's amount; aiApm caps the opponent's actions per minute (ai.js).
const SIZE_OPTIONS = [
  { label: "Small", mult: 1, note: "1600×1000" },
  { label: "Standard", mult: 2, note: "2× · room to expand" },
  { label: "Large", mult: 3, note: "3× · long game" },
  { label: "Gigantic", mult: 4, note: "4× · sprawling war" },
];
const RESOURCE_OPTIONS = [
  { label: "Rare", mult: 0.6, note: "lean deposits" },
  { label: "Normal", mult: 1.0, note: "balanced" },
  { label: "Abundant", mult: 1.5, note: "rich deposits" },
];
// Difficulty bundles the two dials — how FAST the opponent acts (aiApm) and
// whether it MICROS its army (aiMicro) — into one Easy/Medium/Hard pick. The
// aiApm/aiMicro values themselves live with startGame (boot.js).
const DIFFICULTY_OPTIONS = [
  { label: "Easy", mult: "easy", note: "slow · no micro" },
  { label: "Medium", mult: "medium", note: "a fair fight" },
  { label: "Hard", mult: "hard", note: "fast · focus-fire · kite" },
];
// Playable factions for the setup picker — a passive-trait identity for your side
// (engine/factions.js). Each option's `mult` is the faction id, its note the short
// tagline of its edge. The AI's faction comes from the world's archetype instead.
const FACTION_OPTIONS = PLAYABLE_FACTIONS.map(id => ({
  label: FACTIONS[id].short, mult: id,
  note: { frontier: "faster · sees farther", miners: "richer · builds faster", syndicate: "hits harder · lean economy" }[id],
}));
export const setup = { mode: "skirmish", difficulty: "medium", faction: "frontier", sizeMult: 1, resourceMult: 1, seed: null };

// The game modes the splash toggles between.
const MODES = [
  { key: "skirmish", label: "⚔ Skirmish", note: "Destroy the enemy base" },
  { key: "odyssey", label: "🌌 Odyssey", note: "Open world — settle and grow, endlessly" },
  { key: "escort", label: "🚚 Convoy Escort", note: "Protect freighters to the destination" },
  { key: "raider", label: "🏴‍☠️ Pirate Raider", note: "Raid the convoy before it escapes" },
  { key: "bounty", label: "⭐ Bounty Marshal", note: "Hunt pirate camps before the clock" },
];

// The scenario modes that pick a world from the card grid (Odyssey lands on a
// random world instead, and skirmish is a normal match).
const SCENARIOS = ["escort", "raider", "bounty"];

// The two scenarios' splash copy — the setup-panel difficulty hint, the brief
// blurb above the cards, and the screen title/subtitle. Keyed by setup.mode.
const SCENARIO_COPY = {
  escort: {
    title: "Convoy Escort",
    diffHint: "Higher difficulty means heavier piracy, a leaner escort, a tighter clock and a smaller repair budget.",
    brief: "Shepherd four freighters across a multi-leg route to the destination gate. "
      + "Pirates raid each leg by its risk; dock at a station between legs to repair from your budget; "
      + "beat the mission clock. Score rewards freighters delivered, legs survived, risk faced, and budget saved.",
    subtitle: "Choose the route (world to cross)",
  },
  raider: {
    title: "Pirate Raider",
    diffHint: "Higher difficulty means a tougher, better-escorted convoy, a leaner raider fleet, and a higher kill quota.",
    brief: "You are the pirates. An AI convoy runs a multi-leg route for the gate under escort; "
      + "lie in wait, then dive past the escort to sink freighters. Hit the kill quota before the convoy "
      + "escapes or the clock runs out. Score rewards freighters sunk, escorts destroyed, and raiders left alive.",
    subtitle: "Choose the route (world to raid)",
  },
  bounty: {
    title: "Bounty Marshal",
    diffHint: "Higher difficulty means a leaner posse, more and tougher camps, a higher clear quota, and less time.",
    brief: "You are the law. Pirate camps are scattered across the sector, each marked with its bounty. "
      + "Lead your posse from camp to camp and clear your quota before the clock runs out — pick your targets "
      + "and your order carefully. Score rewards bounty banked, camps cleared fast, and posse left standing.",
    subtitle: "Choose the sector (world to hunt)",
  },
  odyssey: {
    title: "Odyssey — open world",
    diffHint: "Difficulty sets how fast and fiercely your neighbours expand — from a calm frontier to a hostile sector.",
    brief: "The open-world campaign. Land on a random world with a mobile colony ship — deploy it to found your "
      + "first Command Center, your relocatable capital — then build your economy beside your neighbours, in peace or "
      + "war. Expand by building more colony ships and deploying them; only a Command Center jumps between worlds (via "
      + "a Spaceport). No clock and no victory screen: you play on while a foothold stands.",
  },
};

// A one-of-N pick rendered as a row of buttons; clicking one selects it and
// stores its value via onPick.
function optionGroup(current, options, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "opt-group";
  options.forEach(opt => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt-btn" + (opt.mult === current ? " active" : "");
    btn.innerHTML = `<span class="opt-label">${opt.label}</span><span class="opt-note">${opt.note}</span>`;
    btn.addEventListener("click", () => {
      onPick(opt.mult);
      wrap.querySelectorAll(".opt-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function renderSetupPanel(mode) {
  // Economy modes (skirmish + Odyssey) run a full base economy, so they get the
  // faction and resource dials; the scripted scenarios have neither.
  const economy = mode === "skirmish" || mode === "odyssey";
  const panel = document.createElement("div");
  panel.className = "setup";

  const diffRow = document.createElement("div");
  diffRow.className = "setup-row";
  const diffLabel = document.createElement("span");
  diffLabel.className = "setup-label";
  diffLabel.textContent = "Difficulty";
  diffRow.append(diffLabel, optionGroup(setup.difficulty, DIFFICULTY_OPTIONS, key => { setup.difficulty = key; }));
  panel.appendChild(diffRow);

  const hint = document.createElement("p");
  hint.className = "setup-hint";
  hint.textContent = mode === "skirmish"
    ? "Easy is slow and holds formation; Medium fights at a fair pace; Hard is fast and micros its army — it focus-fires, kites, and scouts with a Ranger."
    : SCENARIO_COPY[mode].diffHint;
  panel.appendChild(hint);

  // Faction and resources shape a base economy — offered in the economy modes
  // (skirmish + Odyssey), skipped in the scripted scenarios.
  if (economy) {
    const facHint = document.createElement("p");
    facHint.className = "setup-hint";
    facHint.id = "factionHint";
    // Filled now and on every faction pick, so the blurb tracks the selection.
    const renderFactionHint = () => { facHint.textContent = FACTIONS[setup.faction].blurb; };

    const facRow = document.createElement("div");
    facRow.className = "setup-row";
    const facLabel = document.createElement("span");
    facLabel.className = "setup-label";
    facLabel.textContent = "Faction";
    facRow.append(facLabel, optionGroup(setup.faction, FACTION_OPTIONS, key => { setup.faction = key; renderFactionHint(); }));
    panel.appendChild(facRow);
    panel.appendChild(facHint);
    renderFactionHint();
  }

  // Map size shapes both a skirmish and a scenario — a bigger map is a longer
  // convoy route / a wider sector to hunt, with the mission clock scaled to
  // match (engine/scenarios.js), so it's offered in every mode.
  const sizeRow = document.createElement("div");
  sizeRow.className = "setup-row";
  const sizeLabel = document.createElement("span");
  sizeLabel.className = "setup-label";
  sizeLabel.textContent = "Map size";
  sizeRow.append(sizeLabel, optionGroup(setup.sizeMult, SIZE_OPTIONS, m => { setup.sizeMult = m; }));
  panel.appendChild(sizeRow);

  if (economy) {
    const resRow = document.createElement("div");
    resRow.className = "setup-row";
    const resLabel = document.createElement("span");
    resLabel.className = "setup-label";
    resLabel.textContent = "Resources";
    resRow.append(resLabel, optionGroup(setup.resourceMult, RESOURCE_OPTIONS, m => { setup.resourceMult = m; }));
    panel.appendChild(resRow);
  }

  // Optional seed: leave blank for a fresh random map, or enter a seed (shown on
  // the seed chip / game-over screen) to replay the exact same world.
  const seedRow = document.createElement("div");
  seedRow.className = "setup-row";
  const seedLabel = document.createElement("span");
  seedLabel.className = "setup-label";
  seedLabel.textContent = "Seed";
  const seedInput = document.createElement("input");
  seedInput.type = "text"; seedInput.inputMode = "numeric"; seedInput.className = "seed-input";
  seedInput.placeholder = "random";
  seedInput.value = setup.seed != null ? String(setup.seed) : "";
  seedInput.addEventListener("input", () => {
    const v = seedInput.value.trim();
    const n = Number.parseInt(v, 10);
    setup.seed = (v === "" || Number.isNaN(n)) ? null : (n >>> 0);
  });
  seedRow.append(seedLabel, seedInput);
  panel.appendChild(seedRow);

  return panel;
}

// Which start function each scenario mode boots. Skirmish is handled separately.
const SCENARIO_START = { escort: startScenario, raider: startRaider, bounty: startBounty };

export function renderMapSelect() {
  const isScenario = SCENARIOS.includes(setup.mode);
  const odyssey = setup.mode === "odyssey";
  const copy = SCENARIO_COPY[setup.mode];   // defined for scenarios + Odyssey; undefined for skirmish
  mapSelectEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = copy ? copy.title : "Configure the skirmish";
  mapSelectEl.appendChild(title);

  // Mode toggle: skirmish, the open-world Odyssey, or a scripted scenario.
  // Picking one re-renders this screen so the setup rows + start action match.
  mapSelectEl.appendChild(optionGroup(setup.mode, MODES.map(m => ({ label: m.label, mult: m.key, note: m.note })),
    key => { setup.mode = key; renderMapSelect(); }));

  // Offer to pick up a saved skirmish before starting a fresh one (skirmish only).
  if (setup.mode === "skirmish" && hasSave()) {
    const resume = document.createElement("button");
    resume.className = "btn resume-btn";
    resume.textContent = "▶ Resume saved game";
    resume.addEventListener("click", loadGame);
    mapSelectEl.appendChild(resume);
  }

  // Scenarios and Odyssey get a brief blurb above the setup.
  if (copy) {
    const brief = document.createElement("p");
    brief.className = "setup-hint";
    brief.style.maxWidth = "560px";
    brief.textContent = copy.brief;
    mapSelectEl.appendChild(brief);
  }

  mapSelectEl.appendChild(renderSetupPanel(setup.mode));

  // Odyssey lands on a random world — one Begin button instead of the card grid,
  // plus a Resume button when a saved galaxy exists.
  if (odyssey) {
    if (hasOdysseySave()) {
      const resume = document.createElement("button");
      resume.className = "btn resume-btn";
      resume.textContent = "▶ Resume Odyssey";
      resume.addEventListener("click", () => { sound.unlockAudio(); mapSelectEl.classList.add("hidden"); loadOdyssey(); });
      mapSelectEl.appendChild(resume);
    }
    const begin = document.createElement("button");
    begin.className = "btn resume-btn";
    begin.textContent = "⏵ Begin Odyssey — land on a random world";
    begin.addEventListener("click", () => {
      sound.unlockAudio();
      mapSelectEl.classList.add("hidden");
      startOdyssey();
    });
    mapSelectEl.appendChild(begin);
    return;
  }

  const subtitle = document.createElement("h3");
  subtitle.className = "cards-heading";
  subtitle.textContent = isScenario ? copy.subtitle : "Then choose a battlefield";
  mapSelectEl.appendChild(subtitle);

  const cards = document.createElement("div");
  cards.className = "cards";
  MAP_CHOICES.forEach(id => {
    const planet = PLANETS.find(p => p.id === id);
    const mod = PLANET_MODIFIERS[id];
    const card = document.createElement("button");
    card.className = "map-card";
    // Skirmish cards advertise the opponent + the world modifier; scenario cards
    // just pick which world the convoy crosses.
    card.innerHTML = `<span class="name">${planet.name}</span><span class="tag">${planet.tag}</span><span class="desc">${planet.desc}</span>`
      + (isScenario ? "" : `<span class="ai-note">Opponent doctrine: ${archetypeFor(id).name}</span>`)
      + (mod ? `<span class="mod-note">${mod.label}</span>` : "");
    card.addEventListener("click", () => {
      sound.unlockAudio();   // this click is a real user gesture, so it's safe to start the AudioContext here
      mapSelectEl.classList.add("hidden");
      if (isScenario) SCENARIO_START[setup.mode](id); else startGame(id);
    });
    cards.appendChild(card);
  });
  mapSelectEl.appendChild(cards);
}
