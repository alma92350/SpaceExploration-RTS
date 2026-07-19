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
import { canvas, ctx, minimapCtx, mapSelectEl, gameOverEl, underAttackEl, MINIMAP_W, MINIMAP_H } from "./dom.js";
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
import { addTracer, addDeathFlash, addUnderAttackPing, resetEffects } from "./effects.js";
import { renderHUD, resetPanelSignature } from "./hud.js";
import { showObjectives, hideObjectives, showSeedChip, showFactionChip, showGameOver, showScenarioEnd } from "./overlays.js";
import { renderMapSelect, setup } from "./setup.js";
import { setupEscort, setupRaider, setupBounty } from "./engine/scenarios.js";
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

// Re-open the map-select screen (the game-over "choose another battlefield"
// button, passed into overlays' showGameOver so that module needn't import setup).
function restartToMapSelect() {
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

  game.state = newState;
  const state = newState;   // alias for the synchronous setup below (identical to the original)
  showSeedChip(state.seed);
  showFactionChip(state);
  if (intro) showObjectives();
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
  lastUnderAttackAt = -Infinity;
  game.supplyBlockedUntil = 0;
  let lastFrame = performance.now();

  loop = createLoop({
    update: dt => tick(game.state, dt),
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
        else showGameOver(game.state.winner, game.state.seed, restartToMapSelect);
      }
    },
  });
  loop.start();
  renderHUD();
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
