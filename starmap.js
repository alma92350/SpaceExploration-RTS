/* ============================================================
   The Odyssey starmap — a full-screen overview of the galaxy. Every world sits
   on a ring, coloured by your relationship to it: your active capital, a colony
   you hold (with its neighbour's stance), or somewhere still unexplored. If your
   capital has a Spaceport and the credits for fuel, clicking a world jumps there
   straight from the map. Opened from the topbar button or the M key.

   Pure view over engine/galaxy.js's galaxyStatus() — it reads the live galaxy at
   open time and rebuilds, so it always reflects the current state.
   ============================================================ */

"use strict";

import { starmapEl, starmapBtn } from "./dom.js";
import { game } from "./session.js";
import { galaxyStatus, canJump, activeState, JUMP_COST, jumpCost } from "./engine/galaxy.js";
import { performJump, surrenderOdyssey } from "./boot.js";
import { showGalaxyToast } from "./overlays.js";
import { planetName as worldName } from "./data.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { stanceLabel } from "./engine/diplomacy.js";

export function renderStarmap() {
  const g = game.galaxy;
  if (!g) return;
  const status = galaxyStatus(g);
  const canLaunch = canJump(activeState(g));
  starmapEl.innerHTML = "";

  const head = document.createElement("div");
  head.className = "starmap-head";
  const hint = canLaunch
    ? `Click a world to jump — free to a colony you hold, ◈${JUMP_COST} fuel to settle a new one`
    : "Build a Spaceport to jump between worlds";
  head.innerHTML = `<h2>Galaxy</h2>`
    + `<p>Visited ${status.visited}/${status.total} · Conquered ${status.pacified}/${status.dominationTarget} · ◈ ${Math.floor(g.credits)} · ${hint}</p>`;
  starmapEl.appendChild(head);

  const field = document.createElement("div");
  field.className = "starmap-field";
  const n = status.worlds.length;
  status.worlds.forEach((w, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const node = document.createElement("button");
    node.className = "starmap-world " + w.status;
    node.style.left = `${50 + Math.cos(ang) * 38}%`;
    node.style.top = `${50 + Math.sin(ang) * 40}%`;
    const sub = w.status === "seat" ? (w.pacified ? "◉ you are here · pacified" : "◉ you are here")
      : w.status === "pacified" ? "⚔ conquered"
      : w.status === "colony" ? `your colony · +${w.income} ◈/min`
      : w.status === "contested" ? `contested · ${stanceLabel(w.stance)}`
      : archetypeFor(w.id).name;
    // Industry drives factory speed + finished-good prices; Tech drives research
    // speed — so the badge is what makes "where to settle" an informed decision.
    const stats = `<span class="sm-stats">⚙ ${w.industry} · 🔬 ${w.tech}</span>`;
    node.innerHTML = `<span class="sm-name">${worldName(w.id)}</span><span class="sm-sub">${sub}</span>${stats}`;
    node.addEventListener("click", () => onWorldClick(w));
    field.appendChild(node);
  });
  starmapEl.appendChild(field);

  const foot = document.createElement("p");
  foot.className = "starmap-foot";
  foot.textContent = "M or Esc to close · the Odyssey never ends unless you surrender";
  starmapEl.appendChild(foot);

  // Surrender — the ONLY way to end the Odyssey (a wipeout just sends relief). Two-click confirm
  // so it can't be hit by accident; the armed state lives on this element until the map re-renders.
  const surrender = document.createElement("button");
  surrender.className = "starmap-surrender";
  surrender.textContent = "🏳 Surrender Odyssey";
  let armed = false;
  surrender.addEventListener("click", () => {
    if (!armed) { armed = true; surrender.textContent = "🏳 Click again to confirm surrender"; surrender.classList.add("armed"); return; }
    closeStarmap();
    surrenderOdyssey();
  });
  starmapEl.appendChild(surrender);
}

function onWorldClick(w) {
  const g = game.galaxy;
  if (!g || w.id === g.activeId) return;
  if (!canJump(activeState(g))) { showGalaxyToast("Build a Spaceport to jump between worlds.", "warn"); return; }
  const cost = jumpCost(g, w.id);   // free to a world you hold, JUMP_COST to reach a new one
  if (g.credits < cost) { showGalaxyToast(`Need ◈${cost} fuel to jump to ${worldName(w.id)}.`, "warn"); return; }
  closeStarmap();
  performJump(w.id);   // carries the staged expedition (Colony Ship and/or army) to the world, repoints the view
}

export function openStarmap() { if (!game.galaxy) return; renderStarmap(); starmapEl.classList.remove("hidden"); }
export function closeStarmap() { starmapEl.classList.add("hidden"); }
function toggleStarmap() { if (starmapEl.classList.contains("hidden")) openStarmap(); else closeStarmap(); }

// Self-wired, like the other overlays: the topbar button and the M key toggle it
// (M only in Odyssey — there's no galaxy otherwise), Esc closes it. Clicking the
// backdrop (the overlay itself, not a world button) also closes.
starmapBtn.addEventListener("click", toggleStarmap);
starmapEl.addEventListener("click", e => { if (e.target === starmapEl) closeStarmap(); });
window.addEventListener("keydown", e => {
  if ((e.key === "m" || e.key === "M") && game.galaxy) { e.preventDefault(); toggleStarmap(); }
  else if (e.key === "Escape" && !starmapEl.classList.contains("hidden")) closeStarmap();
});
