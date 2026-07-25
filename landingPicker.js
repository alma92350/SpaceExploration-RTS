/* ============================================================
   The landing-site picker: a blocking modal shown before a jump lands on a
   world with no player Spaceport standing on it (engine/galaxy.js's
   landingZone falls back to a player-chosen point in exactly that case — see
   its header comment). With no beacon to home in on, the player picks an
   approximate touchdown spot themselves, blind: the canvas here draws NO
   terrain, fog, enemy units/buildings or resource nodes — genuinely nothing
   but a faint reference grid — because a world you've never set foot on (the
   overwhelmingly common case this fires for) really is a total unknown. The
   pick itself is necessarily coarse (a minimap click, not a coordinate
   field), and engine/galaxy.js's snapLandingPoint further snaps it onto a
   fixed grid — so the dashed ring drawn around the marker previews that same
   imprecision rather than promising a precision the landing won't actually
   have.

   This picker isn't ONLY reached for total unknowns, though: `needsPick`
   (boot.js's initiateJump) fires whenever no COMPLETED player Spaceport
   stands here — which also covers a colony you already hold whose pad is
   still under construction, or was lost. On worlds like that the player's
   own buildings and units are already known intel (never fogged to their
   owner — same rule the main minimap.js follows), so the chart marks them:
   a bigger circle for a Spaceport (built or not — it's still the landmark
   you're aiming relative to), small squares for other buildings, and dots
   for units. A genuinely unvisited world owns none of these, so it stays as
   blind as before with no special-casing needed.

   A leaf UI module: no import of boot.js (or anything else that imports
   this file), so it stays free of the pause/resume and jump-execution
   decisions — those are the caller's job (boot.js's initiateJump), passed in
   as plain callbacks. Modelled on saveload.js's goHome confirm modal (same
   overlay/card/dialog/focus-trap/Esc-dismiss idiom).
   ============================================================ */

"use strict";

import { minimapToWorld } from "./minimap.js";
import { LANDING_PICK_GRID } from "./engine/galaxy.js";

const PICKER_MAX_W = 480;

// Open the picker for `dest` (the destination's engine state — always exists; the galaxy
// creates every world's state up front, see engine/galaxy.js createGalaxy). `worldLabel` is
// the display name shown in the heading. `onPick(point)` fires once, with the RAW world-space
// point the player clicked (engine/galaxy.js does the snapping/clamping) — the caller is
// expected to launch the jump with it. `onCancel()` fires instead if the player backs out.
// Exactly one of the two ever fires, and the modal is always removed either way.
export function openLandingPicker(dest, worldLabel, { onPick, onCancel }) {
  const map = dest.map;
  const mmW = PICKER_MAX_W, mmH = Math.round(map.height * (PICKER_MAX_W / map.width));
  // Whether the player already has a footprint here (see the header comment) — drives both the
  // marked-up chart below and this copy, which otherwise oversells the pick as totally blind.
  const hasFootprint = [...dest.buildings.values()].some(b => b.owner === "player")
    || [...dest.units.values()].some(u => u.owner === "player");

  const overlay = document.createElement("div");
  overlay.className = "landing-pick-confirm";
  const card = document.createElement("div");
  card.className = "landing-pick-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.tabIndex = -1;

  const h = document.createElement("h2");
  h.id = "landing-pick-title";
  h.textContent = `Choose a landing site — ${worldLabel}`;
  card.setAttribute("aria-labelledby", h.id);

  const p = document.createElement("p");
  p.textContent = hasFootprint
    ? "No completed Spaceport here to guide the fleet in. Your own buildings and units are marked on the chart below — pick an approximate site; a minimap pick is never exact."
    : "No Spaceport beacon here to guide the fleet in. Fog of war is total — pick an approximate site on the chart below; a minimap pick is never exact.";

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "landing-pick-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "landing-pick-canvas";
  canvas.width = mmW; canvas.height = mmH;
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", hasFootprint
    ? "Starmap chart marked with your own buildings and units — click to mark an approximate landing site"
    : "Blind starmap chart — click to mark an approximate landing site");
  canvasWrap.appendChild(canvas);

  const hint = document.createElement("p");
  hint.className = "landing-pick-hint";
  hint.textContent = "Click the chart to mark a landing site.";

  const actions = document.createElement("div");
  actions.className = "landing-pick-actions home-actions";
  const confirmBtn = document.createElement("button");
  confirmBtn.className = "btn primary";
  confirmBtn.textContent = "Confirm Landing";
  confirmBtn.disabled = true;
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn ghost";
  cancelBtn.textContent = "Cancel";
  actions.append(confirmBtn, cancelBtn);

  card.append(h, p, canvasWrap, hint, actions);
  overlay.appendChild(card);

  const ctx = canvas.getContext("2d");
  let picked = null;   // {x,y} in canvas pixel space, or null before the first click
  const draw = () => {
    ctx.fillStyle = "#05070f";
    ctx.fillRect(0, 0, mmW, mmH);
    // A faint reference grid — spatial context (roughly where on the chart you're clicking)
    // without revealing a single scouted thing about the world itself.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let gx = 1; gx < 4; gx++) { const x = (mmW / 4) * gx; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mmH); ctx.stroke(); }
    for (let gy = 1; gy < 4; gy++) { const y = (mmH / 4) * gy; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(mmW, y); ctx.stroke(); }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.strokeRect(0.5, 0.5, mmW - 1, mmH - 1);

    // The player's own footprint on this world, if any — see the header comment. Never
    // fog-gated (it's the player's own owned intel), and drawn every time regardless of
    // `picked` so it's visible before the first click, not just after.
    const sx = mmW / map.width, sy = mmH / map.height;
    ctx.fillStyle = dest.players?.player?.color || "#4fd1ff";
    for (const b of dest.buildings.values()) {
      if (b.owner !== "player") continue;
      const bx = b.x * sx, by = b.y * sy;
      if (b.type === "spaceport") {
        ctx.beginPath(); ctx.arc(bx, by, 7, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillRect(bx - 3, by - 3, 6, 6);
      }
    }
    for (const u of dest.units.values()) {
      if (u.owner !== "player") continue;
      ctx.beginPath(); ctx.arc(u.x * sx, u.y * sy, 2, 0, Math.PI * 2); ctx.fill();
    }

    if (!picked) return;
    // The dashed ring previews the picker's built-in imprecision (LANDING_PICK_GRID, the same
    // grid engine/galaxy.js's snapLandingPoint rounds onto) — "you'll land roughly here", not a
    // promise of the exact pixel clicked.
    const ringR = (LANDING_PICK_GRID / 2) * (mmW / map.width);
    ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.arc(picked.x, picked.y, ringR, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.arc(picked.x, picked.y, 4, 0, Math.PI * 2); ctx.fill();
  };
  draw();

  const pickAt = (clientX, clientY) => {
    const rect = canvas.getBoundingClientRect();
    const mx = Math.min(mmW, Math.max(0, ((clientX - rect.left) / rect.width) * mmW));
    const my = Math.min(mmH, Math.max(0, ((clientY - rect.top) / rect.height) * mmH));
    picked = { x: mx, y: my };
    hint.textContent = "Landing site marked — Confirm to launch, or click again to move it.";
    confirmBtn.disabled = false;
    draw();
  };
  canvas.addEventListener("click", e => pickAt(e.clientX, e.clientY));

  const previouslyFocused = document.activeElement;
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
  };
  const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); onCancel(); } };

  confirmBtn.addEventListener("click", () => {
    if (!picked) return;
    const world = minimapToWorld(map, mmW, mmH, picked.x, picked.y);
    close();
    onPick(world);
  });
  cancelBtn.addEventListener("click", () => { close(); onCancel(); });
  overlay.addEventListener("click", e => { if (e.target === overlay) { close(); onCancel(); } });
  window.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  canvas.focus();
}
