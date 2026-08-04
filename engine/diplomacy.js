/* ============================================================
   Odyssey diplomacy — a neighbour's stance toward you, driven by scarcity AND by
   your own aggression. Each world's AI holds a stance from -1 (hostile) to +1
   (allied). It drifts toward a target set by how depleted the world's deposits
   are: while the ground is rich the neighbour stays cordial and coexists; as the
   world mines out, competition for what's left pulls it toward hostility. On top
   of that, every ship of theirs you destroy sours the stance immediately — so you
   can break the peace yourself, and a mined-out world tips into war on its own.

   The stance gates the AI's OFFENSE only (engine/ai.js): at peace the neighbour
   still builds its economy and army and still defends itself, it just doesn't
   launch attacks on you. So a world can be shared in harmony for a while and then
   turn — as its resources run short, or as you draw first blood. Odyssey-only: a
   skirmish AI has no `state.diplomacy` and fights as before. Pure and
   deterministic (grievance is read from the change in the neighbour's unit count,
   so it's substep-safe — no double counting across catch-up ticks).

   Both DIRECTIONS are personality-flavoured, and by separate dials: how fast a
   world sours on you (grievanceMult) and how long it then holds the grudge
   (forgiveness — the recovery drift plus the provocation memory). A Warlord world
   turns on you twice as fast and lets go half as quickly as a patient trading one.
   ============================================================ */

"use strict";

import { chargingPlayerWonder } from "./wonder.js";
import { BUILDINGS, UNITS, clamp } from "./entities.js";
import { TECHS } from "./techtree.js";
import { strategyFor } from "./aiStrategy.js";
import { difficultyFor } from "./aiDifficulty.js";
import { mulberry32, hashStr } from "./rng.js";
import { TRADE_LOT, unitPrice } from "./market.js";

// Above this stance the neighbour holds its fire (peace); at or below it, war.
export const PEACE_THRESHOLD = -0.15;

// DEVELOPMENT keeps the peace (Odyssey): a neighbour investing in its OWN industry — Reactors,
// factories, a Plasma Rig, a Datacenter, and the research it completes (engine/ai.js aiIndustry) —
// makes its own goods instead of fighting you for the last surface seam, so it's less pressured as
// the world mines out. Each such asset lifts its war target, bounded — so development can DELAY and
// soften war, or hold it off on a world you don't strip-mine, but never force unconditional permanent
// peace: past the cap, scarcity and the late-game creep still bite, and the Gate finale still overrides.
const DEV_SOFT_PER = 0.05;   // stance-target lifted per industrial building / researched tech node
const DEV_SOFT_CAP = 0.4;    // ...capped, so a fully-mined world still tips to war even at full development

// How developed the neighbour is: its completed industrial buildings (power, factories, the Plasma
// Rig, the Datacenter) plus the tech nodes it has researched. Deterministic — reads only entity and
// upgrade state. Zero for a bare early neighbour (and for the whole skirmish path, which never calls
// this), so the stance maths is unchanged until the AI actually starts to develop. Exported so the
// galaxy layer's faction-expansion (engine/galaxy.js checkExpansion) can key off the same measure.
export function aiDevelopment(state) {
  let n = 0;
  for (const b of state.buildings.values()) {
    if (b.owner !== "ai" || b.constructing) continue;
    const def = BUILDINGS[b.type];
    if (def && (def.energyGrants || def.recipe || def.rig || b.type === "datacenter")) n++;
  }
  const ups = state.players.ai && state.players.ai.upgrades;
  if (ups) for (const k in TECHS) if (ups[k]) n++;
  return n;
}

const START_STANCE = 0.35;        // a new neighbour starts Cordial
const DRIFT_RATE = 0.05;          // how fast stance chases its scarcity target (per second)
const GRIEVANCE_PER_KILL = 0.04;  // stance lost per enemy ship you destroy on this world

// Unit roles that leave the world by being SPENT rather than by dying — a colony ship consumed
// founding a base (engine/colony.js), a Helium Bomb consumed being triggered (engine/bomb.js).
// The grievance below reads a unit-count delta, so these must not be counted or the neighbour's
// own expansion reads as your attack. See the comment at the count itself.
const CONSUMED_ROLES = new Set(["colony", "bomb"]);

// LATE-GAME CREEP (Tier 4): after the opening grace, a slow time-based resentment
// that grows without bound, so hostility never plateaus — overstay anywhere and the
// neighbour eventually turns, and a partly-mined world keeps sinking instead of
// parking at a mild "Wary". Tuned so war ONSET stays scarcity-driven (negligible at
// grace-end) and only the true late game bites; validated by a defended-base probe.
const CREEP_RATE = 0.0004;        // stance-target lost per second past grace

// THE FINALE (Tier 4): a charging player Gate is a bid to win the whole galaxy, so
// the neighbour drops diplomacy and mobilises — harder the closer the Gate is to
// firing. This only ever LOWERS the target and is applied LAST (below), so it
// overrides even a paid truce: you cannot buy your way out of the endgame.
const GATE_WAR_TARGET = -0.3;     // a charging Gate floors the target at war (h≈0.18) the moment it starts...
const GATE_WAR_SLOPE  = 0.7;      // ...sinking to fully hostile (-1.0, h=1) at full charge

// TRIBUTE (Tier 4): spend universal credits to appease the neighbour for a while.
// A stopgap, never a subscription — the truce window decays and each tribute costs
// geometrically more, so permanent bought peace is arithmetically impossible.
export const APPEASE_TIME = 120;      // seconds a tribute holds the neighbour's fire (~one wave cadence)
const APPEASE_FLOOR = 0.0;            // the truce target: holds fire (Neutral), stops short of friendship
export const TRIBUTE_BASE_COST = 200; // credits for the first appeasement
const TRIBUTE_COST_GROWTH = 1.55;     // each further tribute costs 1.55× more

// GOODWILL (Tier 4b — gifts): the OTHER lever, and the only one that can push a stance past
// Cordial into Allied (stanceLabel's >= 0.6 band) — tribute's own APPEASE_FLOOR caps out at
// Neutral by design. A gift (offerGift, below) converts local stockpile value into this decaying
// pool, which lifts the drift TARGET the same bounded way aiDevelopment's DEV_SOFT_CAP already
// does (a second additive term, not a direct stance snap) — so a single huge dump can't buy
// +1.0 outright: the pool itself clamps at a cap (stacking gifts back-to-back returns
// diminishing goodwill), and the ordinary DRIFT_RATE still has to chase the lifted target like
// every other pull on this dial.
export const GOODWILL_CAP = 0.8;        // …but big enough, sustained, to out-vote even a fairly
                                         // depleted scarcity target and reach Allied — unlike tribute
const GOODWILL_PER_CREDIT = 0.0001;     // stance-pool gained per credit of local market value gifted
const GOODWILL_DECAY = 1 / 240;         // relaxes back toward 0 over ~4 minutes absent further gifts —
                                         // the same exponential-decay idiom as the market's own
                                         // pressure/glut (engine/market.js updateMarket)

// FAVOR REQUESTS (Tier 4b): every few minutes, a PEACEFUL neighbour asks for whatever commodity
// its own market prices richest right now (the scarcest good on this world) — fulfilling it
// (fulfillRequest, below) before the deadline pays a premium in credits plus a GOODWILL bump, the
// active counterpart to tribute's passive brake. Deterministic: seeded off this WORLD's own seed
// (state.seed, already a planetSeed-style hash of the galaxy seed + planetId — see
// engine/galaxy.js's own planetSeed) plus a coarse TIME BUCKET, via mulberry32/hashStr
// (engine/rng.js) — no wall clock, so a replay from the same seed rolls the identical schedule.
export const FAVOR_INTERVAL = 240;      // a fresh roll every ~4 minutes ("every few minutes")
const FAVOR_CHANCE = 0.6;               // …not guaranteed every interval, so the cadence isn't a metronome
export const FAVOR_WINDOW = 90;         // seconds to fulfill before the ask is withdrawn, unfulfilled
const FAVOR_QTY_LOTS_MIN = 1, FAVOR_QTY_LOTS_MAX = 4;   // 1-4 TRADE_LOTs — the same range the bulk-trade
                                                          // UI itself now offers (Sell x4 / Sell All)
const FAVOR_REWARD_MULT = 1.6;          // paid at a premium over the going local sell rate
export const FAVOR_GOODWILL = 0.15;     // stance-pool gain per fulfilled favor — a deliberate one-off
                                         // reward, bigger than a single small gift

// Odyssey is an economy-builder: the win path is ~25–35 minutes, so the neighbour
// must give you room to establish before it can turn. A GRACE window floors the
// scarcity target at cordial for the opening (empirically, two economies sharing a
// world mine it to the old ~23%-depletion war threshold in ~4 minutes — far too
// soon), and the target slope below is much gentler, so war arrives in the mid-game
// and escalates toward the endgame instead of ending the run before it starts.
export const GRACE_TIME = 420;    // 7 minutes of guaranteed cordiality to establish an economy + defence
const GRACE_FLOOR = 0.2;          // the stance target can't fall below this during grace

// COMPOSITION BOUNDS. graceMult and grievanceMult each collect a factor from the archetype's
// Odyssey overlay, the player-picked strategy AND the difficulty, and all three MULTIPLY — which
// is the intended design (an Aggressive Rusher on Hard should be the galaxy's shortest fuse), but
// unbounded it stopped expressing that and started expressing an accident: 0.5 × 0.2 × 0.9 took
// the documented 7-minute opening grace down to 37.8 seconds, on a combination the setup screen
// hands out freely. The layers still compose; they just can't compound past these
// (docs/odyssey-ai-review.md §2.6).
export const MIN_GRACE_FRAC = 0.4;       // ≥ 168s of opening window, whatever the stack
export const MAX_GRIEVANCE_MULT = 2.5;   // …and a hard ceiling on how fast losses sour a neighbour

// FORGIVENESS — how long a neighbour holds a grudge, and the one part of its temperament the
// diplomacy layer used to leave flat. Souring was already personality-flavoured (grievanceMult),
// but COOLING OFF was identical everywhere: a Warlord world and a research capital recovered from
// being bled at the same rate, and once provoked, every neighbour stayed provoked for ever. This
// dial drives both halves of that cooldown — the drift back UP toward the scarcity target, and
// how long the AI keeps treating you as an active aggressor (provoked(), below). Above 1 forgives
// faster and forgets sooner; below 1 nurses the grudge. Composed across archetype × strategy ×
// difficulty and bounded, exactly like the two above.
export const MIN_FORGIVENESS = 0.3;
export const MAX_FORGIVENESS = 2.5;

// Seconds of quiet, at forgiveness 1, before a neighbour stops counting you as an active
// aggressor. Scaled by 1/forgiveness, so a Warlord world remembers roughly twice as long as a
// patient one. Long enough that it can't lapse mid-engagement: a wave cadence is tens of seconds,
// so you have to genuinely stop fighting, not just pause between pushes.
export const PROVOKE_MEMORY = 300;

// FACTION MEMORY (Tier 4c): diplomacy stopped being 11 sealed dyads the moment factions started
// spreading across the galaxy (engine/galaxy.js checkExpansion) — so a faction should react as a
// BODY POLITIC, not eleven strangers who happen to share a name. Two directions, both DRIVEN from
// the galaxy layer (engine/galaxy.js: checkDomination for the grievance below, updateFactionWarmth
// for the Allied lift), since only that layer can see across worlds; this file only ever consumes
// what it's handed, the same arm's-length relationship it already has with aiDevelopment.
//
// GRIEVANCE: razing one world's neighbour capital (checkDomination) doesn't just pacify that
// world — every OTHER unpacified world of the same faction takes a bounded, ONE-TIME stance hit.
// checkDomination applies it directly to dip.stance (not the target), so it can't fight the
// ordinary scarcity/development drift — it just yanks the current reading down once — and the
// world recovers more slowly for a while afterward: forgiveness composes at
// FACTION_ECHO_FORGIVE_MULT for FACTION_ECHO_DURATION seconds (dip.factionEchoUntil, keyed off
// this world's own state.time — no wall clock). A domination spree now visibly snowballs
// resistance across a faction instead of leaving its other worlds exactly as cordial as before.
export const FACTION_ECHO_PENALTY = 0.2;          // stance lost, once, by each unpacified faction-mate
export const FACTION_ECHO_DURATION = 180;         // seconds the slower recovery lasts afterward
export const FACTION_ECHO_FORGIVE_MULT = 0.8;     // forgiveness composes at this multiplier while it lasts

// ALLIED LIFT: the mirror — holding Allied on one world lifts its faction-mates' drift TARGET a
// little, the same bounded-additive shape aiDevelopment's DEV_SOFT_PER/DEV_SOFT_CAP already use
// (a raw count times a per-unit weight, capped), just fed by a different count. Unlike the
// grievance echo above this isn't a one-time event — it's a continuously-held CONDITION, so
// engine/galaxy.js recomputes dip.factionWarmth (how many of a world's OTHER faction-mates are
// currently Allied) on its own throttled scan rather than latching it from an event; this file
// only ever reads the count.
export const ALLY_ECHO_PER = 0.05;
export const ALLY_ECHO_CAP = 0.15;


// The composed-and-bounded grace/grievance multipliers for this world. Exported so the bounds are
// testable directly rather than only through 40 minutes of drift.
export function effectiveDiplomacyMults(state) {
  const od = state.ai.archetype && state.ai.archetype.odyssey;
  const st = strategyFor(state);
  const df = difficultyFor(state);
  return {
    graceMult: Math.max(MIN_GRACE_FRAC,
      ((od && od.graceMult) || 1) * (st.graceMult || 1) * (df.graceMult || 1)),
    grievanceMult: Math.min(MAX_GRIEVANCE_MULT,
      ((od && od.grievanceMult) || 1) * (st.grievanceMult || 1) * (df.grievanceMult || 1)),
    forgiveness: clamp(((od && od.forgiveness) || 1) * (st.forgiveness || 1) * (df.forgiveness || 1),
      MIN_FORGIVENESS, MAX_FORGIVENESS),
  };
}

export function createDiplomacy() {
  return { stance: START_STANCE, depletion: 0, tributes: 0, provokedAt: null,
           goodwill: 0, request: null, lastFavorBucket: -1 };
}

// Has the PLAYER done something to this neighbour that a strategy which "never attacks
// unprovoked" is entitled to answer? Two things count, both unambiguously the player's doing:
// destroying its ships (dip.provoked, latched below by the same unit-count delta the grievance
// reads) and charging an Antimatter Gate — a bid to win the whole galaxy.
//
// This is what makes engine/aiStrategy.js's `neverInitiates` mean "unprovoked" rather than
// "never" in ODYSSEY. It has to stay strictly action-based: the bug that flag was introduced to
// fix was an Economic AI raiding a player who had built nothing, purely because enough time had
// passed, so elapsed time and stance alone must never appear here. A skirmish has no
// state.diplomacy, so this is always false there and the flag keeps its original absolute
// meaning on exactly the path the player report came from. See docs/odyssey-ai-review.md §2.1.
export function provoked(state) {
  const dip = state.diplomacy;
  if (!dip) return false;
  // A charging Gate is a STANDING provocation, not a memory — it provokes for as long as it
  // charges, however long ago the last shot was fired.
  if (chargingPlayerWonder(state)) return true;
  if (dip.provokedAt == null) return false;
  // …otherwise it's a memory that fades, at a rate this neighbour's temperament sets.
  return (state.time - dip.provokedAt) < PROVOKE_MEMORY / effectiveDiplomacyMults(state).forgiveness;
}

// Cost of the NEXT tribute, escalating geometrically with how many you've already
// paid — so appeasement is a stopgap that gets prohibitively expensive, never a
// permanent peace you can afford to renew forever.
export function tributeCost(dip) {
  return Math.round(TRIBUTE_BASE_COST * Math.pow(TRIBUTE_COST_GROWTH, (dip && dip.tributes) || 0));
}

// Spend universal credits (galaxy.credits — NOT the local economy) to appease this
// world's neighbour: snap the stance up to the truce line and open a decaying window
// during which the drift target can't fall below it (see updateDiplomacy), so the
// drift won't instantly claw back what you paid for. Odyssey-only and a no-op without
// funds. Pure and deterministic given (galaxy, state) + state.time — no wall-clock,
// no RNG — so it's replay-safe as a player input. Returns whether it happened.
export function offerTribute(galaxy, state) {
  const dip = state && state.diplomacy;
  if (!dip || !galaxy) return false;                 // skirmish / no galaxy ⇒ no-op
  const cost = tributeCost(dip);
  if (galaxy.credits < cost) return false;           // can't afford ⇒ no spend, no-op
  galaxy.credits -= cost;
  dip.tributes = (dip.tributes || 0) + 1;
  dip.stance = clamp(Math.max(dip.stance, APPEASE_FLOOR), -1, 1);   // instant stand-down to the truce line
  dip.appeaseUntil = state.time + APPEASE_TIME;       // the floor that decays — bought peace is temporary
  dip.warAnnounced = false;                           // so a later relapse re-fires the war toast
  return true;
}

// Hand the neighbour `qty` of `com` from the player's LOCAL stockpile (engine/market.js's
// resources, capped by what's actually held — the same guard sell() uses; never a negative
// stockpile). A one-way GIFT, not a sale: it leaves the stockpile but earns no credits and applies
// no market slippage (that's sell()'s job). Its local market value (unitPrice's sell side) lifts
// the decaying goodwill pool by GOODWILL_PER_CREDIT, clamped at GOODWILL_CAP so a single big dump
// can't buy the whole climb to Allied at once — updateDiplomacy folds the pool into the stance's
// drift target every tick (bounded, same idiom as aiDevelopment's DEV_SOFT_CAP) and decays it back
// down absent further gifts. Odyssey-only (mirrors offerTribute's own gate) and needs a real
// market to price the gift against. Pure and deterministic — no RNG, no wall clock. Returns
// whether it happened.
export function offerGift(state, com, qty) {
  const dip = state && state.diplomacy;
  if (!dip || !state.market) return false;             // skirmish, or no market yet ⇒ no-op
  const res = state.players.player.resources;
  const amount = Math.min(qty, Math.floor(res[com] || 0));
  if (amount <= 0) return false;
  res[com] -= amount;
  const value = amount * unitPrice(state.market, com, "sell");
  dip.goodwill = clamp((dip.goodwill || 0) + value * GOODWILL_PER_CREDIT, 0, GOODWILL_CAP);
  return true;
}

// Pay off the neighbour's standing favor request (dip.request, generated by updateDiplomacy
// below): the EXACT quantity asked for, in full — no partial credit, this is a specific favor, not
// a market trade. Deducts the local stockpile, pays `reward` universal credits (galaxy.credits —
// the tribute idiom, not a local-economy cost) and bumps goodwill by FAVOR_GOODWILL (the same pool
// offerGift feeds), then clears the request so a fresh one can roll later. A no-op (false, nothing
// touched) with no galaxy/diplomacy, no live request, an already-expired one, or insufficient
// stock to cover it in full.
export function fulfillRequest(galaxy, state) {
  const dip = state && state.diplomacy;
  const req = dip && dip.request;
  if (!dip || !galaxy || !req || state.time >= req.until) return false;
  const res = state.players.player.resources;
  if (Math.floor(res[req.com] || 0) < req.qty) return false;
  res[req.com] -= req.qty;
  galaxy.credits += req.reward;
  dip.goodwill = clamp((dip.goodwill || 0) + FAVOR_GOODWILL, 0, GOODWILL_CAP);
  dip.request = null;
  return true;
}

// Recompute the world's depletion, apply grievance for the neighbour's fresh
// losses, then drift the stance toward the scarcity target: full deposits →
// +0.45 (cordial), ~30% mined out → hostile.
export function updateDiplomacy(state, dt) {
  const dip = state.diplomacy;
  const wasPeaceful = dip.stance > PEACE_THRESHOLD;

  // An aggressive archetype's Odyssey overlay (aiArchetypes.js) shortens its grace window and
  // sours it faster, so a "Warlord World" neighbour turns hostile sooner than a patient one —
  // the temperament the world advertises. Defaults (no overlay / bare test state) leave the
  // stock constants exactly as before.
  //
  // The player-picked STRATEGY (engine/aiStrategy.js) composes on top of that, multiplicatively —
  // the same relationship the archetype's own odyssey overlay already has with its skirmish base.
  // An Aggressive strategy shrinks grace and sharpens grievance further, on ANY archetype/world,
  // not just a Rusher's; "default" carries no override (`|| 1`), so this is a no-op until a match
  // actually opts into a strategy. DIFFICULTY (engine/aiDifficulty.js) layers on top again — Easy is
  // a touch more patient/forgiving, Hard a touch less — deliberately mild since it's a THIRD
  // multiplicative layer on an already-composed number; GRACE_FLOOR still floors the opening window
  // regardless of how short these three combine to make it.
  // …and BOUNDED (effectiveDiplomacyMults, above): three multiplicative layers stacking on the
  // same dial produced numbers nobody designed — a 37.8-second opening grace on a combination the
  // setup screen offers directly.
  const { graceMult, grievanceMult, forgiveness } = effectiveDiplomacyMults(state);
  const grace = GRACE_TIME * graceMult;
  const grievance = GRIEVANCE_PER_KILL * grievanceMult;
  const creep = CREEP_RATE * grievanceMult;

  let cur = 0, max = 0;
  for (const n of state.map.nodes) { cur += n.amount; max += n.max; }
  dip.depletion = max > 0 ? clamp(1 - cur / max, 0, 1) : 0;

  // Aggression: a drop in the neighbour's unit count since last tick is your
  // doing (only two sides fight), and each loss sours the stance at once. Read
  // from the count delta rather than kill events so multiple catch-up substeps
  // in one frame can't double-count. Rebuilding (count rising) grants nothing —
  // forgiveness comes only from the drift below.
  //
  // SELF-CONSUMING roles are excluded (CONSUMED_ROLES): a colony ship is spent founding a base
  // and a Helium Bomb is spent being triggered, so both leave the world without anyone killing
  // them. Counting them made the neighbour's own successful expansion read as an attack — it
  // soured its own stance for settling, and (since provocation latches on this same signal) it
  // handed itself standing to attack a player who had done nothing.
  let ai = 0;
  for (const u of state.units.values()) {
    if (u.owner !== "ai" || CONSUMED_ROLES.has(UNITS[u.type]?.role)) continue;
    ai++;
  }
  if (dip.lastAiUnits !== undefined && ai < dip.lastAiUnits) {
    dip.stance = clamp(dip.stance - (dip.lastAiUnits - ai) * grievance, -1, 1);
    // …and stamp PROVOKED (see provoked() above): drawing blood is what entitles a
    // never-initiating neighbour to answer in Odyssey. A timestamp rather than a latch, so the
    // memory fades over a quiet spell — and every fresh loss re-arms it, so a running war never
    // cools off underneath you. The stance still has to reach war on its own before a wave flies.
    dip.provokedAt = state.time;
  }
  dip.lastAiUnits = ai;

  // Scarcity target: full deposits → +0.6 (cordial); war (below PEACE_THRESHOLD)
  // only once the world is ~47% mined out, and full hostility only near total
  // depletion — a gentle mid-to-late-game slide, not a minute-4 cliff. Floored to
  // cordial during the opening grace window regardless of how fast you strip-mine.
  let target = 0.6 - dip.depletion * 1.6;

  // DEVELOPMENT keeps the peace: lift the war target by how developed the neighbour is (bounded), so a
  // self-sufficient industrial neighbour coexists markedly longer than a bare strip-miner at the same
  // depletion. Applied to the SCARCITY target before creep/grace/finale, so those still layer on top.
  target += Math.min(DEV_SOFT_CAP, aiDevelopment(state) * DEV_SOFT_PER);

  // GOODWILL (gifts, offerGift above): decays exponentially like the market's own pressure/glut
  // (engine/market.js updateMarket), then lifts the target the same bounded way development does
  // just above — a second additive term, not a separate mechanism — so a maintained gifting habit
  // can keep pushing toward Allied, but stop gifting and it fades back out.
  if (dip.goodwill) dip.goodwill = Math.max(0, dip.goodwill - dip.goodwill * Math.min(1, dt * GOODWILL_DECAY));
  target += Math.min(GOODWILL_CAP, dip.goodwill || 0);

  // FACTION MEMORY, allied direction: dip.factionWarmth is a raw count (how many of this world's
  // OTHER faction-mates are currently Allied), refreshed by engine/galaxy.js's updateFactionWarmth
  // on the same throttled scan checkDomination/checkExpansion run on — this file only ever reads
  // it, bounded the same additive way DEV_SOFT is, just above.
  target += Math.min(ALLY_ECHO_CAP, (dip.factionWarmth || 0) * ALLY_ECHO_PER);

  // LATE-GAME CREEP: past grace, resentment grows linearly and without bound, so the
  // hostility curve never plateaus. Zero at grace-end (onset stays scarcity-driven),
  // it only bites deep into a long game — an overstay turns lethal, a mined-out world
  // is already at -1 so this can't worsen the worst case, only the mild middle band.
  if (state.time > grace) target -= creep * (state.time - grace);

  // Opening grace: floor the target at cordial for the first 7 minutes so a fresh
  // world (incl. a Gate briefly charging on a new background colony) can't be dragged
  // to war before the player has established.
  if (state.time < grace) target = Math.max(target, GRACE_FLOOR);

  // PAID TRUCE (tribute): a decaying window in which the target can't fall below the
  // truce line, so the drift doesn't instantly undo an appeasement. Overridden by the
  // finale clause below — a tribute buys peace against scarcity/creep, never against a
  // galaxy-winning Gate.
  if (dip.appeaseUntil !== undefined && state.time < dip.appeaseUntil)
    target = Math.max(target, APPEASE_FLOOR);

  // THE FINALE, applied LAST so it overrides the paid truce (unappeasable) — but only
  // past grace, so it never provokes during the opening. A charging player Gate sinks
  // the target from just-past-war (charge→0) to fully hostile (charge→1). Math.min:
  // on an already-hostile world it changes nothing; on a still-rich world where the
  // player rushed a Gate, it's what guarantees the finale is fought, not waited out.
  const gate = chargingPlayerWonder(state);
  if (gate && state.time >= grace)
    target = Math.min(target, GATE_WAR_TARGET - GATE_WAR_SLOPE * gate.charge);

  // DOMINATION WITH TEETH: a world you've pacified (checkDomination, engine/galaxy.js) never drifts
  // back to war — its target is floored at APPEASE_FLOOR (Neutral) PERMANENTLY (dip.pacified never
  // clears, unlike the decaying tribute window above). Placed AFTER the finale clause so pacifying a
  // world is specifically what EXEMPTS it from Gate-mobilization: conquest becomes the military
  // counter to your own Gate's provocation, tying the two endgames together.
  if (dip.pacified) target = Math.max(target, APPEASE_FLOOR);

  // ASYMMETRIC drift: souring runs at the stock rate (grievanceMult is what flavours THAT), while
  // recovery — cooling off after you've bled them — runs at this neighbour's forgiveness. So the
  // two directions are separate dials, and a temperament that forgives slowly doesn't also turn
  // hostile slowly.
  //
  // FACTION MEMORY: while a fresh grievance echo is still live (dip.factionEchoUntil, stamped by
  // checkDomination), recovery composes at FACTION_ECHO_FORGIVE_MULT of that — the same forgiveness
  // dial, just temporarily reduced, not a second rate — so a domination spree's echo genuinely
  // stings for a while instead of drifting straight back out under the world's normal forgiveness.
  const echoedForgiveness = (dip.factionEchoUntil !== undefined && state.time < dip.factionEchoUntil)
    ? forgiveness * FACTION_ECHO_FORGIVE_MULT : forgiveness;
  const rate = DRIFT_RATE * (target > dip.stance ? echoedForgiveness : 1);
  dip.stance = clamp(dip.stance + (target - dip.stance) * Math.min(1, dt * rate), -1, 1);

  // The moment the neighbour crosses from peace into war, fire a one-time heads-up
  // (boot.js turns it into a toast) — the offensive ramp is silent otherwise, so a
  // first attack can land with no warning. Fires once per world (survives save/load
  // via the persisted flag); on a background colony the event is drained unused.
  if (wasPeaceful && dip.stance <= PEACE_THRESHOLD && !dip.warAnnounced) {
    dip.warAnnounced = true;
    state.events.push({ type: "neighbourHostile", owner: "player" });
  }

  // DETERMINISTIC FAVOR REQUESTS: every few minutes, while the neighbour is at peace, it asks for
  // whatever commodity its own market currently prices richest — the scarcest good on this world —
  // via fulfillRequest (above) before the deadline for a premium plus a goodwill bump. Seeded off
  // this WORLD's own seed (state.seed — already a planetSeed-style hash of the galaxy seed +
  // planetId, see engine/galaxy.js's own planetSeed) plus a coarse TIME BUCKET, so a replay from
  // the same seed rolls the identical schedule — no wall clock, no unseeded randomness. Needs a real
  // market to price "scarcest" against; a bare fixture with diplomacy but no market (several exist
  // in this test suite) simply never rolls one, same as any other Odyssey-only lever here that
  // reads state.market.
  if (state.market) {
    if (dip.request && state.time >= dip.request.until) dip.request = null;   // deadline passed, unfulfilled ⇒ withdrawn

    const bucket = Math.floor(state.time / FAVOR_INTERVAL);
    if (dip.stance > PEACE_THRESHOLD && !dip.request && bucket !== dip.lastFavorBucket) {
      dip.lastFavorBucket = bucket;
      const pick = mulberry32(hashStr(`${state.planetId}:${state.seed}:favor:${bucket}`));
      if (pick() < FAVOR_CHANCE) {
        let com = null, best = -Infinity;
        for (const c in state.market.base) if (state.market.base[c] > best) { best = state.market.base[c]; com = c; }
        const lots = FAVOR_QTY_LOTS_MIN + Math.floor(pick() * (FAVOR_QTY_LOTS_MAX - FAVOR_QTY_LOTS_MIN + 1));
        const qty = lots * TRADE_LOT;
        const reward = Math.round(qty * unitPrice(state.market, com, "sell") * FAVOR_REWARD_MULT);
        dip.request = { com, qty, until: state.time + FAVOR_WINDOW, reward };
      }
    }
  }
}

// True while the neighbour is holding its fire — read by tests / the HUD.
export function atPeace(state) {
  return !!state.diplomacy && state.diplomacy.stance > PEACE_THRESHOLD;
}

// Offensive intensity, 0..1, read by the AI's offense ramp (engine/ai.js): 0 while
// the neighbour is at peace, climbing linearly to 1 as the stance falls from the
// peace line to fully hostile (-1). Scales the AI's muster threshold, committed
// fraction, and wave cadence, so a peaceful world doesn't unleash a banked
// doomstack the instant it turns — it probes, then escalates. A skirmish has no
// state.diplomacy, so this returns 1 (full intensity) and the offense block
// collapses to its original size/timeout logic, leaving skirmish play unchanged.
export function hostility(state) {
  if (!state.diplomacy) return 1;
  const s = state.diplomacy.stance;
  if (s > PEACE_THRESHOLD) return 0;                                   // at peace: holds fire
  return clamp((PEACE_THRESHOLD - s) / (PEACE_THRESHOLD + 1), 0, 1);   // -0.15→0, -0.5→~0.41, -1→1
}

// The "Allied" stance band's own lower bound — exported so a cross-world reading (the faction
// echo's Allied lift, engine/galaxy.js updateFactionWarmth) tests the exact same boundary as the
// HUD's label below, rather than a second magic number that could quietly drift out of sync with it.
export const ALLIED_THRESHOLD = 0.6;

// A human-readable band for the HUD.
export function stanceLabel(stance) {
  if (stance <= -0.5) return "Hostile";
  if (stance <= PEACE_THRESHOLD) return "Wary";
  if (stance < 0.25) return "Neutral";
  if (stance < ALLIED_THRESHOLD) return "Cordial";
  return "Allied";
}
