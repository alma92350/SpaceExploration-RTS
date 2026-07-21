/* ============================================================
   App versioning + release/compatibility helpers (DOM-free, so it's unit-testable).

   APP_VERSION is the single source of truth for the running build's release number
   (semver). Bump it on each release/merge and keep version.json in sync — the
   auto-update check (update.js) fetches the deployed version.json and compares its
   `version` to this baked-in value to know whether a newer build is live.

   Save compatibility: engine/persist.js owns the save-format versions (SAVE_VERSION,
   GALAXY_SAVE_VERSION). A release manifest (version.json) additionally declares the
   OLDEST save format the new build can still read (minSaveVersion / minGalaxySaveVersion);
   saveImpact() compares those to the player's stored saves so the update banner can say,
   truthfully, whether their data carries over or would be orphaned by updating.
   ============================================================ */

"use strict";

import { SAVE_VERSION, GALAXY_SAVE_VERSION } from "./engine/persist.js";

// The running build's release version. Bump on each release/merge (and version.json with it).
export const APP_VERSION = "1.0.0";

// The save-format versions this build WRITES — owned by engine/persist.js, surfaced here so the
// manifest and the compatibility check share one source of truth.
export const SAVE_FORMAT = { save: SAVE_VERSION, galaxy: GALAXY_SAVE_VERSION };

// Parse "1.2.3" (ignoring any -prerelease suffix) → [1,2,3]; anything unparseable → 0.
export function parseVersion(s) {
  const core = String(s == null ? "" : s).trim().split("-")[0].split(".");
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) { const n = parseInt(core[i], 10); out[i] = Number.isFinite(n) ? n : 0; }
  return out;
}

// -1 if a<b, 0 if equal, 1 if a>b — compared by major, then minor, then patch.
export function compareVersions(a, b) {
  const A = parseVersion(a), B = parseVersion(b);
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] < B[i] ? -1 : 1;
  return 0;
}

// True when `remote` is a strictly newer release than the running build (or `current`).
export function isNewer(remoteVersion, current = APP_VERSION) {
  return compareVersions(remoteVersion, current) > 0;
}

// Decide which stored saves survive an update and which would be orphaned. `remote` is the release
// manifest (its minSaveVersion / minGalaxySaveVersion = the oldest formats the new build reads);
// `stored` is { skirmish: number|null, odyssey: number|null } — the format version of each save the
// player currently has (null = none). A save is "at risk" when its format is older than the new
// build's minimum readable version, i.e. the new build would refuse it — so the player should
// export it to a file first. Returns { risk:[...], safe:[...], hasSaves }.
export function saveImpact(remote, stored) {
  const minSave = Number.isFinite(remote?.minSaveVersion) ? remote.minSaveVersion : 1;
  const minGalaxy = Number.isFinite(remote?.minGalaxySaveVersion) ? remote.minGalaxySaveVersion : 1;
  const risk = [], safe = [];
  if (stored?.skirmish != null) (stored.skirmish < minSave ? risk : safe).push("skirmish");
  if (stored?.odyssey != null) (stored.odyssey < minGalaxy ? risk : safe).push("Odyssey");
  return { risk, safe, hasSaves: risk.length + safe.length > 0 };
}
