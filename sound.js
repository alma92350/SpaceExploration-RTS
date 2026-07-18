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
let muted = false;
const lastPlayed = {};

function ensureContext() {
  if (!ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioContextClass();
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

function throttled(key, minGapMs, fn) {
  const now = performance.now();
  if (lastPlayed[key] !== undefined && now - lastPlayed[key] < minGapMs) return;
  lastPlayed[key] = now;
  fn();
}

function tone({ freq, duration, type = "sine", gain = 0.15, sweep = 0 }) {
  if (muted) return;
  const audio = ensureContext();
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audio.currentTime);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + sweep), audio.currentTime + duration);
  g.gain.setValueAtTime(gain, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);
  osc.connect(g);
  g.connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duration);
}

export function playUnitSpawned() {
  throttled("spawn", 120, () => tone({ freq: 520, duration: 0.1, type: "triangle", gain: 0.12, sweep: 200 }));
}

export function playAttackHit() {
  throttled("hit", 70, () => tone({ freq: 180, duration: 0.06, type: "square", gain: 0.07, sweep: -60 }));
}

// Heavier, lower thud for siege rounds landing on a structure — a deeper
// "crump" the ear reads as bigger ordnance than the Skiff-scale attack hit.
export function playHeavyHit() {
  throttled("heavyHit", 120, () => tone({ freq: 90, duration: 0.14, type: "sawtooth", gain: 0.11, sweep: -40 }));
}

export function playEntityKilled() {
  throttled("kill", 150, () => tone({ freq: 140, duration: 0.28, type: "sawtooth", gain: 0.13, sweep: -100 }));
}

export function playBuildingComplete() {
  throttled("building", 200, () => tone({ freq: 400, duration: 0.18, type: "sine", gain: 0.13, sweep: 260 }));
}

export function playVictory() {
  if (muted) return;
  [523, 659, 784].forEach((freq, i) => setTimeout(() => tone({ freq, duration: 0.22, type: "triangle", gain: 0.15 }), i * 110));
}

export function playDefeat() {
  if (muted) return;
  [400, 320, 240].forEach((freq, i) => setTimeout(() => tone({ freq, duration: 0.3, type: "sawtooth", gain: 0.12 }), i * 140));
}
