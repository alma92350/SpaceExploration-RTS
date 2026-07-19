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
import { hasSave, loadGame } from "./saveload.js";
import { startGame, startScenario } from "./boot.js";
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
  { key: "escort", label: "🚚 Convoy Escort", note: "Protect freighters to the destination" },
];

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

function renderSetupPanel(scenario) {
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
  hint.textContent = scenario
    ? "Higher difficulty means heavier piracy, a leaner escort, a tighter clock and a smaller repair budget."
    : "Easy is slow and holds formation; Medium fights at a fair pace; Hard is fast and micros its army — it focus-fires, kites, and scouts with a Ranger.";
  panel.appendChild(hint);

  // Faction / map size / resources only shape a skirmish economy — a convoy
  // escort has neither, so those rows are skipped in scenario mode.
  if (!scenario) {
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

    const sizeRow = document.createElement("div");
    sizeRow.className = "setup-row";
    const sizeLabel = document.createElement("span");
    sizeLabel.className = "setup-label";
    sizeLabel.textContent = "Map size";
    sizeRow.append(sizeLabel, optionGroup(setup.sizeMult, SIZE_OPTIONS, m => { setup.sizeMult = m; }));
    panel.appendChild(sizeRow);

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

export function renderMapSelect() {
  const scenario = setup.mode === "escort";
  mapSelectEl.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = scenario ? "Convoy Escort" : "Configure the skirmish";
  mapSelectEl.appendChild(title);

  // Mode toggle: skirmish vs the convoy-escort scenario. Picking one re-renders
  // this screen so the setup rows + card actions match the mode.
  mapSelectEl.appendChild(optionGroup(setup.mode, MODES.map(m => ({ label: m.label, mult: m.key, note: m.note })),
    key => { setup.mode = key; renderMapSelect(); }));

  // Offer to pick up a saved skirmish before starting a fresh one (skirmish only).
  if (!scenario && hasSave()) {
    const resume = document.createElement("button");
    resume.className = "btn resume-btn";
    resume.textContent = "▶ Resume saved game";
    resume.addEventListener("click", loadGame);
    mapSelectEl.appendChild(resume);
  }

  if (scenario) {
    const brief = document.createElement("p");
    brief.className = "setup-hint";
    brief.style.maxWidth = "560px";
    brief.textContent = "Shepherd four freighters across a multi-leg route to the destination gate. "
      + "Pirates raid each leg by its risk; dock at a station between legs to repair from your budget; "
      + "beat the mission clock. Score rewards freighters delivered, legs survived, risk faced, and budget saved.";
    mapSelectEl.appendChild(brief);
  }

  mapSelectEl.appendChild(renderSetupPanel(scenario));

  const subtitle = document.createElement("h3");
  subtitle.className = "cards-heading";
  subtitle.textContent = scenario ? "Choose the route (world to cross)" : "Then choose a battlefield";
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
      + (scenario ? "" : `<span class="ai-note">Opponent doctrine: ${archetypeFor(id).name}</span>`)
      + (mod ? `<span class="mod-note">${mod.label}</span>` : "");
    card.addEventListener("click", () => {
      sound.unlockAudio();   // this click is a real user gesture, so it's safe to start the AudioContext here
      mapSelectEl.classList.add("hidden");
      if (scenario) startScenario(id); else startGame(id);
    });
    cards.appendChild(card);
  });
  mapSelectEl.appendChild(cards);
}
