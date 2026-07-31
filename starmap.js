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
import { galaxyStatus, canJump, canJumpTo, activeState, jumpCost, playerSpaceports, spaceportTier,
         FUEL_DISCOUNT_BY_TIER } from "./engine/galaxy.js";
import { initiateJump, surrenderOdyssey, pauseLoop, resumeLoop } from "./boot.js";
import { showGalaxyToast } from "./overlays.js";
import { planetName as worldName, LORE_FACTIONS, PLANETS, COM } from "./data.js";
import { archetypeFor } from "./engine/aiArchetypes.js";
import { stanceLabel } from "./engine/diplomacy.js";
import { PLANET_MODIFIERS } from "./engine/map.js";
import { getColonyPolicy, setColonyPolicy } from "./engine/colonyPolicy.js";

export function renderStarmap() {
  const g = game.galaxy;
  if (!g) return;
  const status = galaxyStatus(g);
  const canLaunch = canJump(activeState(g));
  starmapEl.innerHTML = "";

  // The origin's best completed Spaceport tier discounts new-world fuel (FUEL_DISCOUNT_BY_TIER,
  // engine/galaxy.js jumpCost) — surfaced here too, since this hint is the other cost-preview
  // call site jumpCost feeds.
  const padTier = playerSpaceports(activeState(g)).reduce((max, sp) => Math.max(max, spaceportTier(sp)), 0);
  const fuelMult = FUEL_DISCOUNT_BY_TIER[padTier] ?? 1;

  const head = document.createElement("div");
  head.className = "starmap-head";
  const hint = canLaunch
    ? `Click a world to jump — free to a colony you hold, fuel scaled by distance to settle a new one`
      + (fuelMult < 1 ? ` (×${fuelMult} at your Tier ${padTier} pad)` : "")
    : "No Spaceport here — click a colony you already hold to fall back to it (build a Spaceport to reach new worlds)";
  // textContent, not innerHTML: `status` counts and credits derive from a (possibly
  // hand-edited) save, and building them as text can't inject markup even if a value
  // is hostile. The one static heading is a plain element.
  const h2 = document.createElement("h2");
  h2.textContent = "Galaxy";
  const p = document.createElement("p");
  p.textContent = `Visited ${status.visited}/${status.total} · Conquered ${status.pacified}/${status.dominationTarget} · ◈ ${Math.floor(g.credits)} · ${hint}`;
  head.append(h2, p);
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
      // An unexplored world that a faction has claimed (checkExpansion) reads as that faction's
      // sphere — so you watch factions spread across the frontier before you ever set foot there.
      : w.controlledBy ? `${LORE_FACTIONS[w.controlledBy]?.name || archetypeFor(w.id).name} space`
      : archetypeFor(w.id).name;
    // The world's faction emblem: the DYNAMIC controlling faction (checkExpansion spread) when one has
    // claimed it, else its native faction (data.js LORE_FACTIONS) — so the map's emblems shift as factions
    // colonise across it, a world reading by whoever holds it at a glance.
    const ico = (LORE_FACTIONS[w.controlledBy || w.faction]?.ico) || "🪐";
    // Build each span with textContent, not one innerHTML string: worldName(w.id) falls
    // back to the raw id for an unknown world (data.js), and a hostile save could park
    // markup there — as text it can only ever render as text. Industry/Tech drive the
    // "where to settle" decision, so the stats badge stays.
    const mk = (cls, text) => { const s = document.createElement("span"); s.className = cls; s.textContent = text; return s; };
    // World dossier: deposit icons + yield (data.js PLANETS, the same table the skirmish select
    // cards already print freely — setup.js) plus the world's PLANET_MODIFIERS rule label when
    // it has one (engine/map.js, imported UI-side exactly as setup.js already does). Charted
    // geography, not scouted intel — shown for every world regardless of `discovered` status,
    // same as the industry/tech badge above.
    const planet = PLANETS.find(pl => pl.id === w.id);
    const mod = PLANET_MODIFIERS[w.id];
    const depsText = planet
      ? Object.entries(planet.deposits).map(([c, y]) => `${COM[c]?.ico || "◆"} ${y.toFixed(1)}`).join(" · ")
      : "";
    const dossier = mod ? `${depsText} · ${mod.label}` : depsText;
    node.append(
      mk("sm-ico", ico),
      mk("sm-name", worldName(w.id)),
      mk("sm-sub", sub),
      mk("sm-stats", `⚙ ${w.industry} · 🔬 ${w.tech}`),
      mk("sm-deps", dossier),
    );
    node.addEventListener("click", () => onWorldClick(w));
    field.appendChild(node);
  });
  starmapEl.appendChild(field);

  renderColonyOrders(status);   // per-colony standing-orders quick toggle (engine/colonyPolicy.js)
  renderLaneOverlay(g);         // Freight Lanes summary (engine/galaxy.js runLanes)

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

// Per-colony standing orders (engine/colonyPolicy.js): a quick toggle row for every world you
// currently hold a colony on, mirroring the fuller panel on that world's own Command Center
// (hudSelection.js renderColonyPolicy) — editable from the starmap so a policy for a world you've
// LEFT doesn't require jumping back just to change it.
function renderColonyOrders(status) {
  const g = game.galaxy;
  const colonies = status.worlds.filter(w => w.status === "colony");
  if (!colonies.length) return;

  const wrap = document.createElement("div");
  wrap.className = "starmap-side";
  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = "Colony standing orders";
  wrap.appendChild(head);

  for (const w of colonies) {
    const policy = getColonyPolicy(g, w.id);
    const row = document.createElement("div");
    row.className = "market-row";

    const label = document.createElement("span");
    label.className = "market-com";
    label.textContent = worldName(w.id);
    row.appendChild(label);

    const asBtn = document.createElement("button");
    asBtn.className = "market-btn";
    asBtn.textContent = policy.autoSell.enabled ? "Auto-sell: ON" : "Auto-sell: OFF";
    asBtn.title = "Sell stock above its floors into this colony's own market while you're away (set floors from its Command Center panel).";
    asBtn.addEventListener("click", () => { setColonyPolicy(g, w.id, { autoSell: { enabled: !policy.autoSell.enabled } }); renderStarmap(); });
    row.appendChild(asBtn);

    const wtLabel = document.createElement("span");
    wtLabel.className = "market-trend";
    wtLabel.textContent = `workers ${policy.workerTarget > 0 ? policy.workerTarget : "off"}`;
    row.appendChild(wtLabel);
    const dec = document.createElement("button");
    dec.className = "market-btn";
    dec.textContent = "−";
    dec.addEventListener("click", () => { setColonyPolicy(g, w.id, { workerTarget: Math.max(0, policy.workerTarget - 1) }); renderStarmap(); });
    row.appendChild(dec);
    const inc = document.createElement("button");
    inc.className = "market-btn";
    inc.textContent = "+";
    inc.addEventListener("click", () => { setColonyPolicy(g, w.id, { workerTarget: policy.workerTarget + 1 }); renderStarmap(); });
    row.appendChild(inc);

    wrap.appendChild(row);
  }
  starmapEl.appendChild(wrap);
}

// Freight Lanes overlay (engine/galaxy.js runLanes): one line per standing route, galaxy-wide —
// set up and edited at the source world's Spaceport panel (hudSelection.js renderLanes); this is
// a read-only summary so a route between two worlds you're not currently standing on is still
// visible at a glance.
function renderLaneOverlay(g) {
  const lanes = g.lanes || [];
  if (!lanes.length) return;

  const wrap = document.createElement("div");
  wrap.className = "starmap-side";
  const head = document.createElement("div");
  head.className = "market-head";
  head.textContent = "Freight Lanes";
  wrap.appendChild(head);

  for (const lane of lanes) {
    const row = document.createElement("div");
    row.className = "market-row";
    const label = document.createElement("span");
    label.className = "market-com";
    label.textContent = `${worldName(lane.from)} ▸ ${worldName(lane.to)}`;
    row.appendChild(label);
    const info = document.createElement("span");
    info.className = "market-trend";
    info.textContent = `${lane.shipIds.length} ship${lane.shipIds.length === 1 ? "" : "s"}`;
    row.appendChild(info);
    wrap.appendChild(row);
  }
  starmapEl.appendChild(wrap);
}

function onWorldClick(w) {
  const g = game.galaxy;
  if (!g || w.id === g.activeId) return;
  // With no Spaceport here you can still fall back to a world you hold — only a NEW world needs one.
  if (!canJumpTo(g, w.id)) {
    showGalaxyToast(`No Spaceport here — you can only fall back to a colony you already hold. Build a Spaceport to reach ${worldName(w.id)}.`, "warn");
    return;
  }
  const cost = jumpCost(g, w.id);   // free to a world you hold, JUMP_COST to reach a new one
  if (g.credits < cost) { showGalaxyToast(`Need ◈${cost} fuel to jump to ${worldName(w.id)}.`, "warn"); return; }
  closeStarmap();
  initiateJump(w.id);   // carries the expedition (or, if stranded, evacuates the force) to the world — may open a landing-site picker first
}

// Same dangling-gesture hazard as boot.js's initiateJump (see input.js's cancelGesture): a
// right-click-drag begun on the canvas just before the starmap opens would otherwise still
// resolve into a move order once released over it.
export function openStarmap() { if (!game.galaxy) return; if (game.input) game.input.cancelGesture(); renderStarmap(); starmapEl.classList.remove("hidden"); pauseLoop("starmap"); }   // hold the sim while the starmap is up
export function closeStarmap() { starmapEl.classList.add("hidden"); resumeLoop("starmap"); }
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
