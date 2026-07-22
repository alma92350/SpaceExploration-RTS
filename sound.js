/* ============================================================
   Procedural sound effects via the Web Audio API — no audio files,
   consistent with the rest of this repo's "no build step, no
   dependencies" approach. Each effect is a short synthesized tone with
   an exponential decay envelope, not a sample.

   The AudioContext can't start until a real user gesture (browsers
   block autoplay); unlockAudio() is called from the map-select click
   that starts a game, which counts. Each sound type is throttled so a
   big battle reads as a rapid patter instead of overlapping noise.
   ============================================================ */

"use strict";

let ctx = null;
let master = null;
let muted = false;
let volume = 0.9;
const lastPlayed = {};

function ensureContext() {
  if (!ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioContextClass();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);   // one master bus so every effect shares a level (and future mixing)
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function unlockAudio() {
  ensureContext();
}

export function setMuted(value) {
  muted = value;
}

export function isMuted() {
  return muted;
}

// 0..1 master level. Kept separate from mute so a future volume slider can
// ride on top of the mute toggle.
export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}
export function getVolume() {
  return volume;
}

function throttled(key, minGapMs, fn) {
  const now = performance.now();
  if (lastPlayed[key] !== undefined && now - lastPlayed[key] < minGapMs) return;
  lastPlayed[key] = now;
  fn();
}

// `pan` (-1 left .. +1 right) positions the sound in the stereo field, so you
// can hear which flank a fight is on. `jitter` detunes the base frequency a
// little each play, so repeated hits/spawns don't sound mechanically identical.
// `pan` (-1 left .. +1 right) positions the sound; `jitter` detunes a little each play. `when`
// is an offset (seconds) from now on the SAMPLE-ACCURATE audio clock — a multi-note cue passes
// when: 0, 0.11, 0.22 … to schedule its notes precisely, instead of setTimeout callbacks that
// the browser throttles under main-thread load (exactly when a big battle is on screen), which
// smears the rhythm.
function tone({ freq, duration, type = "sine", gain = 0.15, sweep = 0, pan = 0, jitter = 0.05, when = 0 }) {
  if (muted) return;
  const audio = ensureContext();
  const t0 = audio.currentTime + when;
  const osc = audio.createOscillator();
  const g = audio.createGain();
  const f = freq * (1 + (Math.random() - 0.5) * 2 * jitter);
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f + sweep), t0 + duration);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  if (pan && audio.createStereoPanner) {
    const p = audio.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(master);
  } else {
    g.connect(master);
  }
  osc.start(t0);
  osc.stop(t0 + duration);
}

export function playUnitSpawned(pan = 0) {
  throttled("spawn", 120, () => tone({ freq: 520, duration: 0.1, type: "triangle", gain: 0.12, sweep: 200, pan }));
}

export function playAttackHit(pan = 0) {
  throttled("hit", 70, () => tone({ freq: 180, duration: 0.06, type: "square", gain: 0.07, sweep: -60, pan }));
}

// Heavier, lower thud for siege rounds landing on a structure — a deeper
// "crump" the ear reads as bigger ordnance than the Skiff-scale attack hit.
export function playHeavyHit(pan = 0) {
  throttled("heavyHit", 120, () => tone({ freq: 90, duration: 0.14, type: "sawtooth", gain: 0.11, sweep: -40, pan }));
}

export function playEntityKilled(pan = 0) {
  throttled("kill", 150, () => tone({ freq: 140, duration: 0.28, type: "sawtooth", gain: 0.13, sweep: -100, pan }));
}

export function playBuildingComplete(pan = 0) {
  throttled("building", 200, () => tone({ freq: 400, duration: 0.18, type: "sine", gain: 0.13, sweep: 260, pan }));
}

// Short, bright acknowledgement that an order landed — the single most-missed
// cue. Kept quiet and heavily throttled so a rapid string of orders reads as
// one soft click, not a machine-gun.
export function playOrder() {
  throttled("order", 60, () => tone({ freq: 680, duration: 0.05, type: "triangle", gain: 0.05, sweep: 120, jitter: 0.02 }));
}

// A softer, higher blip when you select something.
export function playSelect() {
  throttled("select", 60, () => tone({ freq: 900, duration: 0.04, type: "sine", gain: 0.045, jitter: 0.02 }));
}

// A distinct two-blip alarm, heavily throttled at the module level (on
// top of whatever throttling the caller does for the banner/ping) so a
// sustained siege reads as a periodic alert, not a continuous buzz.
export function playUnderAttack() {
  throttled("underattack", 4000, () => {
    tone({ freq: 220, duration: 0.18, type: "square", gain: 0.16, sweep: -40 });
    tone({ freq: 220, duration: 0.18, type: "square", gain: 0.16, sweep: -40, when: 0.22 });   // second blip, on the audio clock
  });
}

// A short, low "denied" buzz when production is blocked on supply — a flat,
// unmusical square wave that reads as a warning, not an achievement.
export function playProductionBlocked() {
  throttled("blocked", 250, () => tone({ freq: 110, duration: 0.15, type: "square", gain: 0.1, sweep: -30 }));
}

export function playVictory() {
  if (muted) return;
  [523, 659, 784].forEach((freq, i) => tone({ freq, duration: 0.22, type: "triangle", gain: 0.15, when: i * 0.11 }));
}

export function playDefeat() {
  if (muted) return;
  [400, 320, 240].forEach((freq, i) => tone({ freq, duration: 0.3, type: "sawtooth", gain: 0.12, when: i * 0.14 }));
}
