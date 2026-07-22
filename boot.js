/* ============================================================
   The running game session: startGame (fresh) and bootState (fresh OR loaded)
   wire a state to input, the camera, the fixed-timestep loop and the HUD; the
   render loop also pumps this frame's sim events into sound + visual effects and
   the under-attack alert. Split out of main.js — `state`/`input` now live on the
   shared session (session.js); the loop reads them live so a restart is picked
   up automatically (the previous loop is always stopped first).
   ============================================================ */

"use strict";

import { game } from "./session.js";
import { canvas, ctx, minimapCtx, mapSelectEl, gameOverEl, underAttackEl, pauseBtn, MINIMAP_W, MINIMAP_H } from "./dom.js";
import { createGameState } from "./engine/state.js";
import { mulberry32 } from "./engine/rng.js";
import { createLoop } from "./engine/loop.js";
import { tick } from "./engine/sim.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { isVisibleAt } from "./engine/fog.js";
import { drawFrame, resetFacing } from "./render.js";
import { drawMinimap } from "./minimap.js";
import { clampCamera } from "./camera.js";
import { attachInput } from "./input.js";
import { addTracer, addDeathFlash, addUnderAttackPing, addFireworks, resetEffects } from "./effects.js";
import { renderHUD, resetPanelSignature } from "./hud.js";
import { showObjectives, hideObjectives, showSeedChip, showFactionChip, showGameOver, showScenarioEnd, showGalaxyToast } from "./overlays.js";
import { renderMapSelect, setup } from "./setup.js";
import { setupEscort, setupRaider, setupBounty } from "./engine/scenarios.js";
import { createGalaxy, activeState, jumpCapital, sweepColonies, stepGalaxy, surrenderGalaxy, DOMINATION_TARGET } from "./engine/galaxy.js";
import { TECHS } from "./engine/techtree.js";
import { planetName } from "./data.js";
import * as sound from "./sound.js";

const UNDER_ATTACK_THROTTLE_MS = 4000;
const UNDER_ATTACK_BANNER_MS = 2500;

// Difficulty → the two AI dials. Kept here with startGame (the sole consumer);
// the setup screen's Easy/Medium/Hard labels live in setup.js.
const DIFFICULTY = {
  easy: { aiApm: 20, aiMicro: false },
  medium: { aiApm: 65, aiMicro: false },
  hard: { aiApm: 140, aiMicro: true },
};

// Runtime bookkeeping — module-local because only the loop / frame-event pump
// touch them (state + input live on the shared session instead).
let loop, announced, lastHud, lastUnderAttackAt, underAttackTimer;
// Highest Antimatter Gate charge milestone (25/50/75/100%) already announced, so the
// wonderCharging event (which fires every tick) toasts once per threshold, not per frame.
let gateMilestone = 0;
// Where the last under-attack alert fired — clicking the banner jumps there, so a
// raid on the far side of a big map is one click away instead of a frantic scroll.
let lastAttackAt = null;
underAttackEl.addEventListener("click", () => {
  if (!lastAttackAt || !game.input || !game.state) return;
  const cam = game.input.getCamera();
  cam.x = lastAttackAt.x;
  cam.y = lastAttackAt.y;
  clampCamera(cam, game.state.map, canvas.clientWidth, canvas.clientHeight);
});

// --- pause -------------------------------------------------------------------
// The sim pauses while a blocking overlay is up (Help, the Home-confirm modal) and on a
// manual P toggle. Reasons are refcounted so closing Help doesn't resume a game the player
// ALSO paused with P. Pausing just gates the update() callback — render keeps drawing the
// frozen frame (and the camera still pans, so you can look around) with overlays on top.
// The loop's own backlog-drop (engine/loop.js: `if (acc > dtFixed) acc = 0`) bounds the
// accumulator while update() is skipped, so no sim time is lost or spiralled on resume and
// the fixed-dt tick sequence — hence replay determinism — is untouched. The PAUSED banner
// (style.css body.paused) shows only for the MANUAL pause; Help/Home carry their own UI.
const pauseReasons = new Set();
function syncPause() {
  const manual = pauseReasons.has("manual");
  document.body.classList.toggle("paused", manual);   // the centered PAUSED banner (style.css) — manual only
  if (pauseBtn) pauseBtn.textContent = manual ? "▶ Resume" : "⏸ Pause";   // the topbar affordance (touch has no P key)
}
function clearPause() { pauseReasons.clear(); syncPause(); }
export function pauseLoop(reason = "manual") { pauseReasons.add(reason); syncPause(); }
export function resumeLoop(reason = "manual") { pauseReasons.delete(reason); syncPause(); }
export function togglePause() {
  if (!game.state || game.state.over) return;   // nothing to pause on the menu or after the match has ended
  if (pauseReasons.has("manual")) resumeLoop("manual"); else pauseLoop("manual");
}
if (pauseBtn) pauseBtn.addEventListener("click", togglePause);   // touch-reachable pause (mirrors the P key)

export function startGame(planetId) {
  // Seed the sim so the match is reproducible: a player can note the seed and
  // re-enter it to replay the exact same map. The seed itself is drawn from the
  // UI layer (Math.random is fine here — it's not the sim); everything downstream
  // flows from the seeded mulberry32, so same seed ⇒ same world.
  const seed = (setup.seed != null ? setup.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
  const diff = DIFFICULTY[setup.difficulty] || DIFFICULTY.medium;
  // The player picks their faction; the AI's comes from this world's archetype
  // (aiArchetypes.js), so the opponent's identity is part of the world's character.
  const aiFaction = archetypeFor(planetId).faction || "neutral";
  const fresh = createGameState({ planetId, seed, rng: mulberry32(seed),
    aiApm: diff.aiApm, aiMicro: diff.aiMicro, sizeMult: setup.sizeMult, resourceMult: setup.resourceMult,
    playerFaction: setup.faction, aiFaction });
  bootState(fresh, { intro: true });
}

// Start a Convoy Escort scenario on `planetId` at the chosen difficulty. Shares
// the seed/boot machinery with a skirmish; the scenario state carries its own
// objective (engine/scenarios.js), so bootState wires it the same way.
export function startScenario(planetId) {
  const seed = (setup.seed != null ? setup.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
  const fresh = setupEscort({ planetId, seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult });
  bootState(fresh, { intro: false });
}

// Start a Pirate Raider scenario on `planetId` — the mirror of Escort (you raid
// the AI convoy). Same boot machinery; the scenario carries its own objective.
export function startRaider(planetId) {
  const seed = (setup.seed != null ? setup.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
  const fresh = setupRaider({ planetId, seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult });
  bootState(fresh, { intro: false });
}

// Start a Bounty Marshal scenario on `planetId` — hunt scattered pirate camps
// across the sector against a clock. Same boot machinery.
export function startBounty(planetId) {
  const seed = (setup.seed != null ? setup.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
  const fresh = setupBounty({ planetId, seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult });
  bootState(fresh, { intro: false });
}

// Start an Odyssey — the open-world campaign. Builds a galaxy (Phase 1: one
// randomly-chosen starting world), boots its active planet, and parks the galaxy
// on the session so the HUD/credits and the later jump machinery can reach it.
export function startOdyssey() {
  const seed = (setup.seed != null ? setup.seed : Math.floor(Math.random() * 0x100000000)) >>> 0;
  const diff = DIFFICULTY[setup.difficulty] || DIFFICULTY.medium;
  bootGalaxy(createGalaxy({
    seed, difficulty: setup.difficulty, sizeMult: setup.sizeMult, resourceMult: setup.resourceMult,
    playerFaction: setup.faction, aiApm: diff.aiApm, aiMicro: diff.aiMicro,
  }), { intro: true });
}

// Boot a galaxy (fresh from startOdyssey, or rehydrated from a save by
// saveload.js). bootState clears game.galaxy and rewires input/camera/HUD to the
// active world; the loop reads game.galaxy live, so the background worlds resume
// on their own once it's set right after.
export function bootGalaxy(galaxy, { intro = false } = {}) {
  bootState(activeState(galaxy), { intro });
  game.galaxy = galaxy;
}

// Launch an interplanetary jump to `destId` — relocate the capital + staged
// units (engine/galaxy.js), then repoint the running loop at the new world. The
// loop keeps running and keeps ticking the world you left (now a background
// colony), so this only swaps what's rendered and controlled.
export function performJump(destId) {
  if (!game.galaxy) return null;
  const result = jumpCapital(game.galaxy, destId);
  if (!result) return null;   // couldn't launch (no Spaceport here, or too poor for a new world)
  focusActivePlanet();
  return result;
}

// Voluntarily end the Odyssey — the ONLY way it ends (a wipeout just sends relief). Marks the
// active seat over; the render loop's over-poll then shows the game-over (surrender) screen.
export function surrenderOdyssey() {
  if (!game.galaxy) return;
  surrenderGalaxy(game.galaxy);
}

// Per-world UI bookkeeping that must NOT carry across a world change (a fresh boot or a
// jump): the Gate-progress high-water mark, the remembered under-attack hit + banner, and
// the supply-warning window. Shared by bootState and focusActivePlanet so the next field
// added can't drift between them — the bug this fixes was focusActivePlanet resetting none
// of it, so after a jump the old world's Gate% swallowed the new world's toasts and the
// under-attack click panned to stale coordinates on the wrong map.
function resetWorldUiBookkeeping() {
  gateMilestone = 0;
  lastAttackAt = null;
  lastUnderAttackAt = -Infinity;
  game.supplyBlockedUntil = 0;
  underAttackEl.classList.add("hidden");
  clearTimeout(underAttackTimer);
}

// Repoint the view/input at the galaxy's active planet without restarting the
// loop (used after a jump). Mirrors bootState's per-state wiring, minus creating
// the loop and minus touching game.galaxy.
function focusActivePlanet() {
  const state = activeState(game.galaxy);
  game.state = state;
  if (game.input) game.input.destroy();
  game.input = attachInput(canvas, state, () => renderHUD());
  const cc = [...state.buildings.values()].find(b => b.owner === "player" && b.type === "command");
  const openAt = cc || state.map.bases.player;
  const cam = game.input.getCamera();
  cam.x = openAt.x;
  cam.y = openAt.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
  resetEffects();
  resetFacing();
  resetPanelSignature();
  resetWorldUiBookkeeping();   // don't carry the previous world's Gate%, under-attack hit, or supply window
  showSeedChip(state.seed);
  showFactionChip(state);
  renderHUD();
}

// Re-open the map-select screen (the game-over "choose another battlefield"
// button, passed into overlays' showGameOver so that module needn't import setup;
// also the topbar Home button via saveload.js). Stops the running loop AND tears the
// session down: without clearing game.input/state/galaxy the old game stayed live behind
// the menu — its window-level hotkeys kept firing, the M key reopened the now-dead
// Odyssey starmap, and the timer/beforeunload autosave kept writing (so "Exit without
// Saving" saved anyway). destroy() aborts the input listeners; nulling the session makes
// snapshot() a no-op and the M-key/hotkey gates false. Every other game.state reader
// (minimap handlers, under-attack click, save/repair buttons) already null-guards. Callers
// that need to persist first (Save & Exit) run autoSave BEFORE this. Idempotent.
export function restartToMapSelect() {
  if (loop) loop.stop();
  if (game.input) { game.input.destroy(); game.input = null; }
  game.state = null;
  game.galaxy = null;
  clearPause();   // leaving a game clears any pause + the PAUSED banner
  pauseBtn.classList.add("hidden");   // …and the topbar pause control (no game to pause)
  renderMapSelect();
  mapSelectEl.classList.remove("hidden");
}

// Wire a state — freshly created OR loaded from a save — to input, camera, the
// fixed-timestep loop, and the HUD. The single boot path both startGame and
// loadGame funnel through.
export function bootState(newState, { intro }) {
  if (loop) loop.stop();
  if (game.input) game.input.destroy();
  mapSelectEl.classList.add("hidden");
  gameOverEl.classList.add("hidden");
  underAttackEl.classList.add("hidden");
  clearTimeout(underAttackTimer);
  hideObjectives();

  game.galaxy = null;   // cleared by default; startOdyssey re-sets it right after this returns
  game.groups = {};     // fresh game → fresh control groups (entity ids reset per game, so stale groups would mis-select)
  game.state = newState;
  const state = newState;   // alias for the synchronous setup below (identical to the original)
  // A scenario shows the scenario bar at the top-center; the body class drops the
  // under-attack banner below it (style.css) so a raid alert isn't hidden behind the bar.
  document.body.classList.toggle("scenario", !!state.scenario);
  showSeedChip(state.seed);
  showFactionChip(state);
  if (intro) showObjectives(state.endless);
  game.input = attachInput(canvas, state, () => renderHUD());
  const input = game.input;
  // Open on the player's own ships — the escort/convoy start station, the raider
  // fleet's ambush point, or the player's base in a skirmish — never the map
  // centre, which on a big map is empty space.
  const openAt = state.scenario ? (state.scenario.playerStart || state.scenario.route[0]) : state.map.bases.player;
  const cam = input.getCamera();
  cam.x = openAt.x;
  cam.y = openAt.y;
  clampCamera(cam, state.map, canvas.clientWidth, canvas.clientHeight);
  resetEffects();
  resetFacing();
  announced = false;
  lastHud = 0;
  resetPanelSignature();
  resetWorldUiBookkeeping();
  clearPause();   // a fresh game is never born paused (and clears a stale PAUSED banner)
  let lastFrame = performance.now();

  loop = createLoop({
    // Odyssey advances every world in the galaxy each tick (only the active one
    // is rendered), so the colonies you left keep evolving; otherwise just the
    // one match state ticks.
    update: dt => {
      if (pauseReasons.size) return;   // paused: skip the sim; render still draws the frozen frame + overlays
      if (game.galaxy) {
        stepGalaxy(game.galaxy, dt);   // active world full-rate, colonies on a coarser schedule
        for (const n of sweepColonies(game.galaxy, dt)) notifyColony(n);
        // Conquest progress: a freshly-razed neighbour capital → a toast + a small firework.
        if (game.galaxy.pacifyNotes.length) {
          for (const id of game.galaxy.pacifyNotes) {
            showGalaxyToast(`Conquered ${planetName(id)} — ${game.galaxy.pacified.size}/${DOMINATION_TARGET} worlds`, "good");
            addFireworks(3);
          }
          game.galaxy.pacifyNotes.length = 0;
        }
        // Progress milestones (engine/galaxy.js): a firework show + toast for each, in place of a
        // victory screen — the Odyssey is a play-forever sandbox, so you keep going.
        if (game.galaxy.milestones.length) {
          for (const m of game.galaxy.milestones) celebrateMilestone(m);
          game.galaxy.milestones.length = 0;
        }
        // Relief: a total wipeout is never a defeat — a fresh colony ship is dispatched so you
        // can re-found. Announce it so the player finds the ship at their landing zone.
        if (game.galaxy.reliefNote) {
          game.galaxy.reliefNote = false;
          showGalaxyToast("A relief colony ship has arrived at your landing zone — re-found your Odyssey.", "warn");
        }
      } else tick(game.state, dt);
    },
    render: () => {
      const now = performance.now();
      game.input.tickCamera((now - lastFrame) / 1000);
      lastFrame = now;

      drawFrame(ctx, game.state, game.input.getCamera(), canvas.clientWidth, canvas.clientHeight, game.input.getDragBox(), game.input.getBuildGhost());
      drawMinimap(minimapCtx, game.state, game.input.getCamera(), canvas.clientWidth, canvas.clientHeight, MINIMAP_W, MINIMAP_H);
      processFrameEvents();
      if (now - lastHud > 150) { lastHud = now; renderHUD(); }
      if (game.state.over && !announced) {
        announced = true;
        loop.stop();
        if (game.state.scenario) showScenarioEnd(game.state, restartToMapSelect);
        else showGameOver(game.state.winner, game.state.seed, restartToMapSelect,
          { odyssey: !!game.galaxy, wonBy: game.galaxy?.wonBy, surrendered: !!game.galaxy?.surrendered });
      }
    },
  });
  loop.start();
  renderHUD();
}

// Background-colony notifications from galaxy.sweepColonies. "Under attack" is
// throttled per planet so a sustained raid pings occasionally rather than every
// tick; "lost" fires once (sweepColonies only reports it once). Both toasts are
// clickable — clicking jumps straight to that world to defend or retake it (a
// free hop, since it's a world you've held). If no Spaceport stands on the world
// you're currently on, the jump can't launch, so the click explains why instead.
const COLONY_NOTE_THROTTLE_MS = 9000;
const lastColonyNote = {};
function notifyColony(n) {
  const name = planetName(n.planetId);
  const jumpThere = () => {
    if (!performJump(n.planetId))
      showGalaxyToast(`Build a Spaceport on your current world to jump to ${name}.`, "warn");
  };
  if (n.type === "lost") { showGalaxyToast(`⚠ Your colony on ${name} has fallen — click to retake ▸`, "bad", jumpThere); return; }
  // A background world's neighbour has just declared war (fires once — diplomacy latches it).
  // Surface it so the first warning isn't the colony already dying; clicking jumps to reinforce.
  if (n.type === "hostile") { showGalaxyToast(`⚔ The neighbour on ${name} has turned hostile — click to reinforce ▸`, "warn", jumpThere); return; }
  const now = performance.now();
  const last = lastColonyNote[n.planetId];
  if (last !== undefined && now - last < COLONY_NOTE_THROTTLE_MS) return;   // undefined ⇒ first alert always fires
  lastColonyNote[n.planetId] = now;
  showGalaxyToast(`⚔ Your colony on ${name} is under attack — click to defend ▸`, "warn", jumpThere);
}

// A reached progress milestone (engine/galaxy.js checkGalaxyProgress / checkDomination) →
// a firework show + a celebratory toast. The Odyssey has no victory screen any more
// (play-forever); these mark how far you've come instead. The two grand milestones — the
// Antimatter Gate coming online and conquering the galaxy — get a bigger show.
function celebrateMilestone(id) {
  const [kind, arg] = id.split(":");
  const dominAll = kind === "domination" && arg === "all";   // every world pacified — the maximal feat
  const grand = kind === "gate" || kind === "domination";
  const msg =
      kind === "world"      ? (arg === "1" ? "★ First colony founded — your Odyssey begins!"
                                           : `★ Colony #${arg} established — your reach grows.`)
    : kind === "capital"    ? "★ Capital fortified — your anchor world stands strong."
    : kind === "gate"       ? "★ Antimatter Gate online — a triumph of industry!"
    : dominAll              ? "★ Every world pacified — the galaxy is yours!"
    : kind === "domination" ? `★ ${DOMINATION_TARGET} worlds conquered — the galaxy trembles before your fleet!`
    :                         "★ Milestone reached!";
  addFireworks(dominAll ? 12 : grand ? 8 : 5);
  showGalaxyToast(msg, "good");
  sound.playBuildingComplete();
}

// Stereo pan (-1..1) for a world-x, relative to the camera: a fight off the
// left edge of the view is heard on the left. Clamped, and flattened toward
// center for things near the middle so it isn't distractingly hard-panned.
function panFor(worldX) {
  const { state, input } = game;
  if (!state || !input) return 0;
  const cam = input.getCamera();
  const halfW = canvas.clientWidth / (2 * cam.zoom) || 1;
  return Math.max(-1, Math.min(1, (worldX - cam.x) / halfW)) * 0.85;
}

// A sim event plays a sound (and spawns a matching visual effect — see
// effects.js) if it's the player's own, or if it happened somewhere
// currently visible — same "you can hear what you can see" rule as fog
// of war applies to rendering. Every AI-only skirmish happening off in
// the fogged dark stays silent. An attackHit whose attacker is the AI
// necessarily means the target is the player's (only two sides exist),
// so that's also the under-attack alert's trigger.
function processFrameEvents() {
  const { state } = game;
  for (const ev of state.events) {
    if (ev.owner !== "player" && !isVisibleAt(state.fog, ev.x, ev.y)) continue;
    const pan = panFor(ev.x);   // stereo-place the sound by where it happened on screen
    switch (ev.type) {
      case "unitSpawned":
        sound.playUnitSpawned(pan);
        break;
      case "attackHit":
        (ev.heavy ? sound.playHeavyHit : sound.playAttackHit)(pan);
        addTracer(ev.fromX, ev.fromY, ev.x, ev.y, ev.unitType);
        if (ev.owner === "ai") triggerUnderAttack(ev.x, ev.y);
        break;
      case "entityKilled":
        sound.playEntityKilled(pan);
        addDeathFlash(ev.x, ev.y);
        break;
      case "buildingComplete":
        sound.playBuildingComplete(pan);
        break;
      // Only the player's own supply block beeps and flashes — a visible
      // enemy stalling on supply is their problem, not a HUD alert of ours.
      case "productionBlocked":
        if (ev.owner === "player") {
          sound.playProductionBlocked();
          game.supplyBlockedUntil = performance.now() + 800;
        }
        break;
      // Odyssey research finishing was previously silent — announce the unlock so
      // the player connects the wait to the reward (and notices new build options).
      case "researchComplete":
        sound.playBuildingComplete(pan);
        showGalaxyToast(`Researched ${TECHS[ev.techId]?.name || ev.techId}`, "good");
        break;
      // The neighbour just crossed from peace into war — a one-time heads-up so the
      // first raid doesn't land unannounced (diplomacy.js fires this once per world).
      case "neighbourHostile":
        sound.playProductionBlocked();
        showGalaxyToast("⚔ Your neighbour has turned hostile — expect raids. Ready your defence.", "bad");
        break;
      // The Antimatter Gate charge (fires every tick) — toast once per 25% so the
      // multi-minute climb to the galaxy win is visible without selecting the Gate.
      case "wonderCharging": {
        const pct = Math.floor((ev.charge || 0) * 4) * 25;
        if (pct >= 25 && pct > gateMilestone) {
          gateMilestone = pct;
          showGalaxyToast(`Antimatter Gate charging — ${pct}%`, pct >= 75 ? "bad" : "warn");
        }
        break;
      }
    }
  }
  state.events.length = 0;
}

// Throttled independently of sound.js's own internal throttle (which
// only governs the alarm tone) so the banner and the minimap/world ping
// stay in lockstep with each other during a sustained siege instead of
// re-flashing on every single hit.
function triggerUnderAttack(x, y) {
  lastAttackAt = { x, y };   // remembered even while throttled, so a click always jumps to the freshest hit
  const now = performance.now();
  if (now - lastUnderAttackAt < UNDER_ATTACK_THROTTLE_MS) return;
  lastUnderAttackAt = now;

  sound.playUnderAttack();
  addUnderAttackPing(x, y);
  underAttackEl.classList.remove("hidden");
  clearTimeout(underAttackTimer);
  underAttackTimer = setTimeout(() => underAttackEl.classList.add("hidden"), UNDER_ATTACK_BANNER_MS);
}
