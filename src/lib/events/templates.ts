// Templated feed copy. Every automatic event renders funny text from its payload, so the
// feed works with AI off. Variant choice is deterministic per event id.
//
// House rules for copy: fully unhinged, profanity fine. Roast golf, drinking and on-course
// decisions ONLY. Never partners/fiancées, families, jobs or appearance (tests scan every variant).
import type { FeedEvent, FeedEventType, Player, TripState, UUID } from "../types";
import type { Derived } from "../engine/types";
import { formatFeetInches, formatToPar, ordinal } from "../engine/format";

export type FeedTone = "hype" | "roast" | "info" | "alert" | "fanfare";

export interface RenderedEvent {
  emoji: string;
  /** Short headline, e.g. "GHOST BEER 👻" */
  title: string;
  /** One or two sentences. */
  body: string;
  tone: FeedTone;
  /** Oversized card (Groom's Mulligan, final results, ghost beers...). */
  big: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit. Stable across client and server. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic variant for this event (salted per list so lists don't move in lockstep). */
function pick<T>(seed: string, key: string, list: readonly T[]): T {
  return list[hash(`${seed}:${key}`) % list.length];
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const ids = (v: unknown): UUID[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function findPlayer(state: TripState, id: UUID | null | undefined): Player | undefined {
  return id ? state.players.find((p) => p.id === id) : undefined;
}

/** Nickname (else name), with the groom's crown. Deleted players still resolve. */
function playerName(state: TripState, id: UUID | null | undefined, fallback = "Somebody"): string {
  const p = findPlayer(state, id);
  if (!p) return fallback;
  const name = p.nickname?.trim() || p.name;
  return p.is_groom ? `${name} 👑` : name;
}

function teamName(state: TripState, id: UUID | null | undefined, fallback = "Some team"): string {
  const t = id ? state.teams.find((x) => x.id === id) : undefined;
  return t ? t.name : fallback;
}

/** "A", "A and B", "A, B and C" */
function list(names: string[]): string {
  if (names.length === 0) return "nobody";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const nineName = (nine: number) => (nine === 2 ? "back nine" : "front nine");
const contestName = (kind: unknown) => (kind === "ld" ? "long drive" : "closest to pin");

function fmtDistance(distance: number, unit: unknown): string {
  return unit === "yd" ? `${Math.round(distance)} yd` : formatFeetInches(distance);
}

/** "1" -> "1st", "T2" -> "T2nd", anything else as-is. */
function posText(label: unknown): string {
  if (typeof label !== "string") return "somewhere";
  const m = /^(T?)(\d+)$/.exec(label);
  return m ? `${m[1]}${ordinal(Number(m[2]))}` : "unranked";
}

/** " (logged by X)" when someone else logged it. */
function loggedBy(state: TripState, playerId: UUID | null, loggedById: unknown): string {
  const by = str(loggedById);
  if (!by || by === playerId) return "";
  return ` (logged by ${playerName(state, by)})`;
}

/**
 * " Logged by X for Y and Z." for the drinks of a batch somebody logged for a teammate (spec: "the
 * feed shows who logged it"). drinkers/loggers are index-aligned; self-logged drinks say nothing.
 */
function loggedForOthers(state: TripState, drinkers: UUID[], loggers: (UUID | null)[]): string {
  const forWhom = new Map<UUID, UUID[]>();
  drinkers.forEach((drinker, i) => {
    const by = loggers[i];
    if (!by || by === drinker) return;
    const list = forWhom.get(by) ?? [];
    if (!list.includes(drinker)) list.push(drinker);
    forWhom.set(by, list);
  });
  return [...forWhom]
    .map(([by, whom]) => ` Logged by ${playerName(state, by)} for ${list(whom.map((id) => playerName(state, id)))}.`)
    .join("");
}

/** Where a drink's credit lands NOW (effective hole, or where the commissioner moved it); else the payload's hole. */
function drinkHole(d: Derived, drinkId: unknown, fallback: number): number {
  const id = str(drinkId);
  return (id && d.drinkValues[id]?.hole) || fallback;
}

type V<C> = readonly ((c: C) => string)[];

// ---------------------------------------------------------------------------
// Variant tables
// ---------------------------------------------------------------------------

interface DrinksC { team: string; phrase: string; names: string }
const DRINKS: V<DrinksC> = [
  (c) => `${c.phrase} (${c.names}). Hydration is for teams that are winning.`,
  (c) => `${c.team}: ${c.phrase}. ${c.names} chose violence.`,
  (c) => `${c.phrase}, courtesy of ${c.names}. The scorecard got lighter and so did the cooler.`,
  (c) => `${c.phrase}. ${c.names} drinking like the course owes them money.`,
  (c) => `${c.team} logs ${c.phrase} (${c.names}). Every can is a stroke. This is the way.`,
  (c) => `${c.phrase}. ${c.names} said "one more" and meant it as a threat.`,
];

interface SingleC { p: string; h: number; team: string; lb: string }
const SHOTGUN: V<SingleC> = [
  (c) => `${c.p} shotgunned a beer on hole ${c.h}${c.lb}. Mulligan banked for ${c.team}.`,
  (c) => `${c.p} punched a hole in a can and inhaled it on hole ${c.h}${c.lb}. That's a mulligan in the bank, you animal.`,
  (c) => `Shotgun on hole ${c.h}: ${c.p}${c.lb}. One stroke off and a mulligan banked. Science.`,
  (c) => `${c.p} shotgunned one on hole ${c.h}${c.lb} like it was a personal grudge. ${c.team} banks a mulligan.`,
  (c) => `${c.p} crushed a shotgun on hole ${c.h}${c.lb}. Liver: concerned. Mulligan: banked.`,
];
const SHOT: V<SingleC> = [
  (c) => `${c.p} took a shot on hole ${c.h}${c.lb}. Mulligan banked for ${c.team}.`,
  (c) => `${c.p} slammed a shot on hole ${c.h}${c.lb} and didn't even flinch. Mulligan banked.`,
  (c) => `Shot o'clock on hole ${c.h}: ${c.p}${c.lb}. ${c.team} banks a mulligan.`,
  (c) => `${c.p} fired one down the hatch on hole ${c.h}${c.lb}. One stroke off, one mulligan banked.`,
  (c) => `${c.p} took a shot on hole ${c.h}${c.lb}. Terrible decision, excellent golf strategy. Mulligan banked.`,
];

/** lb: " (logged by X)" when a teammate logged it, else "". */
interface GhostC { p: string; h: number; team: string; value: number; lb: string }
const GHOST: V<GhostC> = [
  (c) => `${c.p}'s drink on hole ${c.h}${c.lb} counted ${c.value}. ${c.team} is drinking for a teammate who doesn't exist.`,
  (c) => `The math says ${c.p}'s drink on hole ${c.h}${c.lb} is worth ${c.value} strokes. The math is drunk and so is ${c.p}.`,
  (c) => `${c.team} just got paid by a phantom teammate. ${c.p} on hole ${c.h}${c.lb}: worth ${c.value}.`,
  (c) => `Boo. ${c.p}'s drink on hole ${c.h}${c.lb} came back from the dead worth ${c.value}. Spooky scary scorecard.`,
  (c) => `${c.team}, short-handed and over-served: ${c.p} on hole ${c.h}${c.lb} counts ${c.value}.`,
  (c) => `${c.p} drank one on hole ${c.h}${c.lb}, the scorecard counted ${c.value}. ${c.team}'s invisible teammate is carrying again.`,
];

interface MulliganC { team: string; h: number; by: string; left: string }
const MULLIGAN: V<MulliganC> = [
  (c) => `${c.team} burned a mulligan on hole ${c.h}. ${c.left}. Golf is hard, apparently.`,
  (c) => `Do-over on hole ${c.h}: ${c.team} pretends that shot never happened. ${c.left}.`,
  (c) => `${c.by} cashed in a mulligan on hole ${c.h}. The first ball is in witness protection now. ${c.left}.`,
  (c) => `${c.team} paid for a mulligan in beer and spent it on hole ${c.h}. Worth it? Doubtful. ${c.left}.`,
  (c) => `Mulligan used on hole ${c.h}. ${c.team}'s first attempt has been memory-holed. ${c.left}.`,
];

interface GroomC { g: string; h: number; team: string }
const GROOM: V<GroomC> = [
  (c) => `${c.g} has invoked the Groom's Mulligan on hole ${c.h}. That shot never happened. Kneel.`,
  (c) => `By royal decree, ${c.g} gets a do-over on hole ${c.h}. The previous shot has been executed for treason.`,
  (c) => `The crown has spoken: ${c.g} takes the Groom's Mulligan on hole ${c.h}. ${c.team} rides with royalty.`,
  (c) => `${c.g} pulled the one-time-only Groom's Mulligan on hole ${c.h}. History will remember this. Nobody else gets one.`,
  (c) => `ALL RISE. ${c.g} burns the Groom's Mulligan on hole ${c.h}. The golf gods have been overruled.`,
];

interface LeadC { leaders: string; take: string; tp: string; knocked: string }
const LEAD: V<LeadC> = [
  (c) => `${c.leaders} ${c.take} at ${c.tp}.${c.knocked}`,
  (c) => `Leaderboard update: ${c.leaders} ${c.take} at ${c.tp}. Everybody else, drink accordingly.`,
  (c) => `${c.leaders} ${c.take} at ${c.tp}. Enjoy it, it won't last.${c.knocked}`,
  (c) => `${c.leaders} ${c.take} at ${c.tp}. Somebody audit that scorecard immediately.`,
  (c) => `Breaking: ${c.leaders} ${c.take} at ${c.tp}. The chasers are going to have to drink their way back.`,
];

interface TeeOffC { team: string }
const TEE_OFF: V<TeeOffC> = [
  (c) => `${c.team} just teed off. Lock up the beer cart.`,
  (c) => `${c.team} is underway. Their scorecard is clean for the last time today.`,
  (c) => `${c.team} has teed off. Drinks count now. Act accordingly.`,
  (c) => `${c.team} is off the first tee. Somebody warn the groundskeeper.`,
];

interface StartC { course: string; teams: number; players: number }
const ROUND_STARTED: V<StartC> = [
  (c) => `The round is live at ${c.course}. ${c.players} players, ${c.teams} teams, zero chance this goes well.`,
  (c) => `We are LIVE at ${c.course}. Drinks count once you're on the tee. Not before, you degenerates.`,
  (c) => `${c.course}, you've been warned: ${c.teams} teams are loose and the cooler is full.`,
  (c) => `It's on. ${c.teams} teams, ${c.players} players, one leaderboard. Pace of play is a suggestion.`,
];

interface ScoreC { team: string; h: number; s: number; par: number; tp: number; net: number; credit: number; pos: string; ntp: string }
const BIRDIE: V<ScoreC> = [
  (c) => `${c.team} birdied hole ${c.h} with a ${c.s}. Who are these people?`,
  (c) => `Birdie on ${c.h} for ${c.team}. Somebody is sandbagging.`,
  (c) => `${c.team} carded a ${c.s} on par-${c.par} hole ${c.h}. Birdie. Suspicious.`,
  (c) => `${c.team} with a birdie on hole ${c.h}. The beer is working.`,
  (c) => `Birdie, ${c.team}, hole ${c.h}. Even a blind squirrel finds a nut.`,
];
const EAGLE: V<ScoreC> = [
  (c) => `EAGLE. ${c.team} made a ${c.s} on hole ${c.h}. Call the authorities.`,
  (c) => `${c.team} just eagled hole ${c.h}. Drug test immediately.`,
  (c) => `A ${c.s} on a par ${c.par}. ${c.team} eagled hole ${c.h} and is now insufferable.`,
  (c) => `Eagle on ${c.h} for ${c.team}. Somebody check the scorecard, the cart and the cooler.`,
];
const ALBATROSS: V<ScoreC> = [
  (c) => `${c.team} made a ${c.s} on par-${c.par} hole ${c.h}. ALBATROSS. This has never happened in recorded history.`,
  (c) => `Albatross on hole ${c.h}. ${c.team} has angered the golf gods and we will all pay.`,
  (c) => `${c.team}: ${c.s} on a par ${c.par}. That's an albatross. Nobody believes you.`,
  (c) => `Hole ${c.h}, ${c.team}, albatross. Frame the scorecard. Then audit it.`,
];
const ACE: V<ScoreC> = [
  (c) => `HOLE IN ONE on ${c.h} for ${c.team}! Somebody is buying the whole bar.`,
  (c) => `${c.team} aced hole ${c.h}. Screenshots or it didn't happen.`,
  (c) => `ACE on hole ${c.h}. ${c.team} will not shut up about this for the rest of the trip.`,
  (c) => `One swing, one hole, ${c.team}. Hole ${c.h} is in shambles.`,
];
const DOUBLE: V<ScoreC> = [
  (c) => `${c.team} made a ${c.s} on par-${c.par} hole ${c.h}. Double bogey. Drink it off.`,
  (c) => `Double bogey on ${c.h} for ${c.team}. That hole is now a crime scene.`,
  (c) => `${c.team} carded a ${c.s} on hole ${c.h}. Every ball in the bag to choose from and still a double.`,
  (c) => `${c.team} doubled hole ${c.h}. The beer cart has been notified.`,
  (c) => `A ${c.s} on hole ${c.h}, ${c.team}? In a SCRAMBLE? Unreal.`,
];
const TRIPLE: V<ScoreC> = [
  (c) => `${c.team} made a ${c.s} on par-${c.par} hole ${c.h}. That's +${c.tp}. In a scramble. With multiple balls.`,
  (c) => `${c.team}: ${c.s} strokes on hole ${c.h}. Somebody send a search party.`,
  (c) => `+${c.tp} on hole ${c.h}. ${c.team} played that hole like it owed them money.`,
  (c) => `${c.team} took a ${c.s} on hole ${c.h}. Golf is not their sport. Drinking might be.`,
  (c) => `Hole ${c.h} just mugged ${c.team} for a ${c.s}. Drink twice, it's medicinal.`,
];
const NET_ZERO: V<ScoreC> = [
  (c) => `${c.team} drank hole ${c.h} down to a net ${c.net}. Gross ${c.s}, ${c.credit} in drink credit. The system works.`,
  (c) => `Net ${c.net} on hole ${c.h}. ${c.team} didn't golf that hole so much as drink it into submission.`,
  (c) => `${c.team}: ${c.s} strokes, ${c.credit} drink credit, net ${c.net} on hole ${c.h}. Pros hate this one trick.`,
  (c) => `A net ${c.net} on hole ${c.h} for ${c.team}. Livers: destroyed. Scorecard: immaculate.`,
  (c) => `${c.team} hit net ${c.net} on hole ${c.h}. The beer is carrying harder than the clubs.`,
];
const LAST_AT_TURN: V<ScoreC> = [
  (c) => `${c.team} makes the turn in dead last (${c.pos}, ${c.ntp}). The back nine can't possibly be worse. Right?`,
  (c) => `Halfway report: ${c.team} is last at ${c.ntp}. Drinks are strokes, gentlemen. Do the math.`,
  (c) => `${c.team} finished the front nine in last place. Nine more holes to blame the course.`,
  (c) => `Dead last at the turn: ${c.team} at ${c.ntp}. The halfway-house hot dog is the only thing going right.`,
];

interface EditC { who: string; phrase: string; forTeam: string; better: boolean }
const SCORE_EDIT: V<EditC> = [
  (c) => `${c.who} ${c.phrase}${c.forTeam}. Pencil-whipping in broad daylight.`,
  (c) => `${c.who} ${c.phrase}${c.forTeam}. Revisionist history, live on the feed.`,
  (c) => `Scorecard surgery: ${c.who} ${c.phrase}${c.forTeam}. We're all watching.`,
  (c) => `${c.who} ${c.phrase}${c.forTeam}. ${c.better ? "How convenient." : "Honesty? On a golf course?"}`,
  (c) => `${c.who} ${c.phrase}${c.forTeam}. The audit committee has been notified.`,
];

interface DriveC { team: string; names: string; nine: string; rem: number; holes: string; need: string; short: number }
const DRIVE_HARD: V<DriveC> = [
  (c) => `${c.team}: ${c.names} ${c.need} a drive on the ${c.nine} with ${c.rem} ${c.holes} left. Every remaining tee shot is spoken for.`,
  (c) => `RED ALERT for ${c.team}. ${c.rem} ${c.holes} left on the ${c.nine} and ${c.names} ${c.need} a drive. Wherever it goes, it's getting used.`,
  (c) => `Drive minimum math for ${c.team}: ${c.rem} ${c.holes} to go on the ${c.nine}. ${c.names}, you're up. No pressure. All the pressure.`,
  (c) => `${c.team}, ${c.names} ${c.need} a drive and the ${c.nine} has ${c.rem} ${c.holes} left. Whatever they hit, you're playing it.`,
  (c) => `The drive minimum is coming for ${c.team}: ${c.names} on the clock with ${c.rem} ${c.holes} to go on the ${c.nine}.`,
];
const DRIVE_IMPOSSIBLE: V<DriveC> = [
  (c) => `${c.team} is mathematically cooked on the ${c.nine}: ${c.names} ${c.need} drives and only ${c.rem} ${c.holes} remain. Commissioner's problem now.`,
  (c) => `It's over for ${c.team}'s drive minimum on the ${c.nine}. ${c.names} won't all get a drive in. Somebody wasn't counting.`,
  (c) => `${c.team} can't make the drive minimum on the ${c.nine} anymore: ${c.short} short with ${c.rem} ${c.holes} left, and ${c.names} still ${c.need} one. Bold strategy.`,
  (c) => `Drive minimum: impossible. ${c.team} left ${c.names} on the bench too long on the ${c.nine}.`,
];

interface MissC { team: string; names: string; nine: string }
const DRIVE_MISS: V<MissC> = [
  (c) => `${c.names} went the whole ${c.nine} without a drive for ${c.team}. Flagged for the commissioner.`,
  (c) => `${c.team} finished the ${c.nine} with ${c.names} at zero drives. The commissioner has been summoned.`,
  (c) => `Drive minimum missed: ${c.names} (${c.team}) never got a tee shot used on the ${c.nine}. Flagged. Lawyers are being consulted.`,
  (c) => `Zero drives for ${c.names} on the ${c.nine}. ${c.team}, that's a rules violation and a confidence problem. Flagged for the commissioner.`,
  (c) => `${c.team} straight up benched ${c.names} on the ${c.nine}. Drive minimum missed, commissioner flagged.`,
];

interface EntryC { p: string; h: number; dist: string; rank: string; reason: string }
const CTP_ENTRY: V<EntryC> = [
  (c) => `${c.p} put it ${c.dist} from the pin on hole ${c.h}. ${c.rank}`,
  (c) => `${c.p} claims ${c.dist} on hole ${c.h}. ${c.rank} Photo or it didn't happen.`,
  (c) => `Closest to pin, hole ${c.h}: ${c.p} at ${c.dist}. ${c.rank}`,
  (c) => `${c.p} stuck it to ${c.dist} on hole ${c.h}. ${c.rank} Pace it off again, we don't trust you.`,
];
const LD_ENTRY: V<EntryC> = [
  (c) => `${c.p} bombed one ${c.dist} on hole ${c.h}. ${c.rank}`,
  (c) => `Long drive, hole ${c.h}: ${c.p} at ${c.dist}. ${c.rank}`,
  (c) => `${c.p} sent it ${c.dist} on hole ${c.h}. ${c.rank} In the fairway, allegedly.`,
  (c) => `${c.p} hit a ${c.dist} drive on hole ${c.h}. ${c.rank} GPS doesn't lie. Players do.`,
];
const FLAGGED_ENTRY: V<EntryC> = [
  (c) => `${c.p} submitted ${c.dist} on hole ${c.h}. Awaiting commissioner review (${c.reason}).`,
  (c) => `${c.p} says ${c.dist} on hole ${c.h}. The commissioner will be the judge of that (${c.reason}).`,
  (c) => `${c.p} logged ${c.dist} on hole ${c.h}, pending commissioner review: ${c.reason}. Lawyers up.`,
  (c) => `${c.p}: ${c.dist} on hole ${c.h}. Doesn't count until the commissioner signs off (${c.reason}).`,
];

interface ContestLeadC { leaders: string; take: string; h: number; kind: string; dist: string; chase: string }
const CONTEST_LEAD: V<ContestLeadC> = [
  (c) => `${c.leaders} ${c.take} the hole ${c.h} ${c.kind} at ${c.dist}.`,
  (c) => `New ${c.kind} leader on hole ${c.h}: ${c.leaders} at ${c.dist}. Pot's looking juicy.`,
  (c) => `${c.leaders} ${c.take} hole ${c.h} at ${c.dist}. Everybody else: ${c.chase}.`,
  (c) => `Hole ${c.h} ${c.kind}: ${c.leaders} on top at ${c.dist}. The previous leader is in shambles.`,
];

interface OverrideC { who: string; summary: string }
const OVERRIDE: V<OverrideC> = [
  (c) => `${c.who} ${c.summary}. Transparency!`,
  (c) => `${c.who} ${c.summary}. Totally above board, definitely not rigged.`,
  (c) => `Commissioner powers activated: ${c.who} ${c.summary}.`,
  (c) => `${c.who} ${c.summary}. Absolute power, absolutely fine.`,
];

interface CompleteC { team: string; gross: number; net: number; ntp: string; pos: string; drinks: number }
const COMPLETE: V<CompleteC> = [
  (c) => `${c.team} is in: ${c.gross} gross, ${c.net} net (${c.ntp}). Sitting ${c.pos}.`,
  (c) => `${c.team} finished at ${c.ntp} net. ${c.drinks} drinks, ${c.gross} strokes, zero regrets. Currently ${c.pos}.`,
  (c) => `Round complete for ${c.team}: net ${c.net} (${c.ntp}), ${c.pos} on the board. The 19th hole is open.`,
  (c) => `${c.team} signed the card: ${c.gross} gross, ${c.net} net. ${c.pos} for now. To the bar.`,
];
const COMPLETE_LAST: V<CompleteC> = [
  (c) => `${c.team} finished dead last at ${c.ntp}. ${c.drinks} drinks and it still wasn't enough.`,
  (c) => `${c.team} is in, at the bottom: ${c.gross} gross, ${c.net} net (${c.ntp}). Golf 1, ${c.team} 0.`,
  (c) => `Round complete for ${c.team}. Last place, ${c.ntp}. Hold your heads high. Just not too high.`,
  (c) => `${c.team} closes it out in last at ${c.ntp}. Somebody hug them. Or don't.`,
];

interface FinalC { champs: string; win: string; ntp: string }
const FINAL: V<FinalC> = [
  (c) => `${c.champs} ${c.win} at ${c.ntp}. Everyone else: check the Money tab and start Venmo-ing.`,
  (c) => `It's official: ${c.champs} ${c.win} at ${c.ntp}. Awards are up. Settle your debts.`,
  (c) => `Final: ${c.champs} on top at ${c.ntp}. Losers buy the next round. That's not a rule, it's a law.`,
  (c) => `The scorecards are locked. ${c.champs} ${c.win} at ${c.ntp}. Check Awards for the hall of shame.`,
];

const NO_WINDOW: readonly string[] = [
  "Drinks before the first tee shot don't count. Tap On the tee for hole 1, you degenerate.",
  "Parking-lot beers are worth zero strokes. Get to the tee first, champ.",
  "That one doesn't count. Your round hasn't started yet. Pace yourself, it's a long day.",
  "No drink window open. Tee off first, then drink like it matters.",
  "Easy, tiger. Drinks only count once you're on the tee for hole 1.",
  "Pre-round drinking is a lifestyle, not a score. Tap On the tee first.",
];

/** Variant counts per table (tests assert every variant gets rendered and scanned). */
export const TEMPLATE_VARIANT_COUNTS: Readonly<Record<string, number>> = {
  drinks: DRINKS.length,
  shotgun: SHOTGUN.length,
  shot: SHOT.length,
  ghost_beer: GHOST.length,
  mulligan_used: MULLIGAN.length,
  groom_mulligan: GROOM.length,
  lead_change: LEAD.length,
  tee_off: TEE_OFF.length,
  round_started: ROUND_STARTED.length,
  "score_notable:birdie": BIRDIE.length,
  "score_notable:eagle": EAGLE.length,
  "score_notable:albatross": ALBATROSS.length,
  "score_notable:ace": ACE.length,
  "score_notable:double": DOUBLE.length,
  "score_notable:triple_plus": TRIPLE.length,
  "score_notable:net_zero": NET_ZERO.length,
  "score_notable:last_at_turn": LAST_AT_TURN.length,
  score_edit: SCORE_EDIT.length,
  "drive_warning:hard": DRIVE_HARD.length,
  "drive_warning:impossible": DRIVE_IMPOSSIBLE.length,
  drive_miss: DRIVE_MISS.length,
  "contest_entry:ctp": CTP_ENTRY.length,
  "contest_entry:ld": LD_ENTRY.length,
  "contest_entry:flagged": FLAGGED_ENTRY.length,
  contest_lead: CONTEST_LEAD.length,
  commissioner_override: OVERRIDE.length,
  round_complete: COMPLETE.length,
  "round_complete:last": COMPLETE_LAST.length,
  final_results: FINAL.length,
  no_window: NO_WINDOW.length,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BIG_TYPES: ReadonlySet<FeedEventType> = new Set<FeedEventType>(["groom_mulligan", "ghost_beer", "final_results", "lead_change"]);

type Body = Omit<RenderedEvent, "big">;

function render(ev: FeedEvent, state: TripState, d: Derived): Body {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const seed = ev.id;
  const team = teamName(state, ev.team_id);
  const hole = num(p.hole, 0);

  switch (ev.type) {
    case "post":
      return {
        emoji: ev.photo_path ? "📸" : "💬",
        title: playerName(state, ev.player_id ?? ev.actor_id, "Anonymous coward"),
        body: ev.text ?? "",
        tone: "info",
      };

    case "roast":
      return {
        emoji: "🔥",
        title: ev.team_id ? `Roast: ${team}` : "Roast",
        body: ev.text ?? "",
        tone: "roast",
      };

    case "round_started": {
      const c: StartC = {
        course: state.trip.settings.course_name || "the course",
        teams: num(p.team_count, d.teams.length),
        players: num(p.player_count, Object.keys(d.teamOfPlayer).length),
      };
      return { emoji: "🚦", title: "WE ARE LIVE", body: pick(seed, "start", ROUND_STARTED)(c), tone: "hype" };
    }

    case "tee_off": {
      let body = pick(seed, "tee", TEE_OFF)({ team });
      if (hole > 1) body += ` (They started on hole ${hole}. Bold.)`;
      return { emoji: "🏌️", title: `${team} teed off`, body, tone: "hype" };
    }

    case "score_notable":
      return renderNotable(ev, p, team, hole);

    case "score_edit": {
      const actorKnown = !!findPlayer(state, ev.actor_id);
      const from = num(p.from);
      const to = num(p.to);
      const c: EditC = {
        who: actorKnown ? playerName(state, ev.actor_id) : team,
        phrase: `changed hole ${hole} from a ${from} to a ${to}`,
        forTeam: actorKnown ? ` for ${team}` : "",
        better: to < from,
      };
      return { emoji: "✏️", title: "Scorecard edit", body: pick(seed, "edit", SCORE_EDIT)(c), tone: "alert" };
    }

    case "drinks": {
      const drinkIds = ids(p.drink_ids);
      const rows = drinkIds.map((id) => state.drinks.find((x) => x.id === id));
      // Count what's still active when we can see the rows; otherwise trust the payload.
      const known = rows.some((r) => r !== undefined);
      const active = rows.filter((r): r is NonNullable<typeof r> => r !== undefined && r.deleted_at === null);
      const count = known ? active.length : num(p.count, drinkIds.length);
      const playerIds = known ? active.map((r) => r.player_id) : ids(p.player_ids);
      const loggerIds: (UUID | null)[] = known
        ? active.map((r) => r.logged_by)
        : (Array.isArray(p.logged_by_ids) ? p.logged_by_ids : []).map((x) => str(x));
      const tally = new Map<UUID, number>();
      for (const id of playerIds) tally.set(id, (tally.get(id) ?? 0) + 1);
      const names = list([...tally].map(([id, n]) => `${playerName(state, id)}${n > 1 ? ` ×${n}` : ""}`));
      // The holes these drinks are credited to now (a stale phone's stamp or a commissioner move is resolved).
      const holes = [...new Set(active.map((r) => drinkHole(d, r.id, r.hole)))].sort((a, b) => a - b);
      const where = holes.length > 1 ? `holes ${list(holes.map(String))}` : `hole ${holes[0] ?? hole}`;
      const phrase = `${count} ${plural(count, "drink", "drinks")} on ${where}`;
      const body =
        count === 0
          ? `${phrase}. Somebody hit undo. Cowards.`
          : pick(seed, "drinks", DRINKS)({ team, phrase, names: playerIds.length ? names : team }) +
            loggedForOthers(state, playerIds, loggerIds);
      return { emoji: "🍺", title: `Drinks · ${team}`, body, tone: "hype" };
    }

    case "shotgun":
    case "shot": {
      const playerId = str(p.player_id) ?? ev.player_id;
      const c: SingleC = {
        p: playerName(state, playerId),
        h: drinkHole(d, p.drink_id, hole),
        team,
        lb: loggedBy(state, playerId, p.logged_by),
      };
      return ev.type === "shotgun"
        ? { emoji: "💥", title: "SHOTGUN", body: pick(seed, "shotgun", SHOTGUN)(c), tone: "hype" }
        : { emoji: "🥃", title: "SHOT", body: pick(seed, "shot", SHOT)(c), tone: "hype" };
    }

    case "ghost_beer": {
      const playerId = str(p.player_id) ?? ev.player_id;
      const c: GhostC = {
        p: playerName(state, playerId),
        h: drinkHole(d, p.drink_id, hole),
        team,
        value: num(p.value, 2),
        lb: loggedBy(state, playerId, p.logged_by),
      };
      return { emoji: "👻", title: "GHOST BEER", body: pick(seed, "ghost", GHOST)(c), tone: "fanfare" };
    }

    case "mulligan_used": {
      const left = num(p.available, 0);
      const c: MulliganC = {
        team,
        h: hole,
        by: playerName(state, str(p.used_by) ?? ev.player_id, team),
        left: left === 0 ? "The bank is empty" : `${left} left in the bank`,
      };
      return { emoji: "♻️", title: "Mulligan", body: pick(seed, "mulligan", MULLIGAN)(c), tone: "roast" };
    }

    case "groom_mulligan": {
      const groomId = str(p.groom_id) ?? ev.player_id ?? d.groomId;
      const c: GroomC = { g: playerName(state, groomId, "The groom 👑"), h: hole, team };
      return { emoji: "👑", title: "THE GROOM'S MULLIGAN", body: pick(seed, "groom", GROOM)(c), tone: "fanfare" };
    }

    case "lead_change": {
      const leaderIds = ids(p.leader_team_ids);
      const prevIds = ids(p.previous_leader_team_ids).filter((id) => !leaderIds.includes(id));
      const tie = leaderIds.length > 1;
      const c: LeadC = {
        leaders: list(leaderIds.map((id) => teamName(state, id))),
        take: tie ? "are tied for the lead" : "takes the lead",
        tp: formatToPar(num(p.net_to_par)),
        knocked: prevIds.length
          ? ` ${list(prevIds.map((id) => teamName(state, id)))} just got knocked off the top.`
          : "",
      };
      return {
        emoji: "🏆",
        title: tie ? "TIE FOR THE LEAD" : "NEW LEADER",
        body: pick(seed, "lead", LEAD)(c),
        tone: "fanfare",
      };
    }

    case "contest_entry":
      return renderEntry(ev, p, state, d, hole);

    case "contest_lead": {
      const leaderIds = ids(p.leader_ids);
      const tie = leaderIds.length > 1;
      const kind = contestName(p.contest_type);
      const c: ContestLeadC = {
        leaders: list(leaderIds.map((id) => playerName(state, id))),
        take: tie ? "are tied for" : "takes",
        h: hole,
        kind,
        dist: fmtDistance(num(p.distance), p.unit ?? (p.contest_type === "ld" ? "yd" : "ft")),
        chase: p.contest_type === "ld" ? "swing harder" : "get closer or get louder",
      };
      return {
        emoji: p.contest_type === "ld" ? "💣" : "🎯",
        title: `New leader · hole ${hole} ${kind}`,
        body: pick(seed, "clead", CONTEST_LEAD)(c),
        tone: "hype",
      };
    }

    case "ai_judge": {
      const entry = state.contest_entries.find((e) => e.id === p.entry_id);
      const who = playerName(state, entry?.player_id ?? ev.player_id);
      const h = hole || entry?.hole || 0;
      const claimed = optNum(p.claimed_ft) ?? optNum(p.distance) ?? entry?.distance_value ?? null;
      const estimate = optNum(p.estimate_ft) ?? entry?.ai_estimate_ft ?? null;
      const confidence = str(p.confidence) ?? entry?.ai_confidence ?? "unknown";
      const suspicious = p.suspicious === true || entry?.ai_suspicious === true;
      const roast = str(p.roast) ?? ev.text ?? entry?.ai_roast ?? null;
      const claimedText = claimed !== null ? formatFeetInches(claimed) : "something";
      const estText = estimate !== null ? `~${formatFeetInches(estimate)}` : "no clue";
      const verdict = suspicious
        ? `${who} claimed ${claimedText} on hole ${h}. The AI judge eyeballs it at ${estText} (${confidence} confidence). 🚩 Suspicious.`
        : `${who} claimed ${claimedText} on hole ${h}. The AI judge says ${estText} (${confidence} confidence). Checks out. For now.`;
      return {
        emoji: suspicious ? "🚩" : "⚖️",
        title: suspicious ? "AI JUDGE: SUSPICIOUS" : "AI JUDGE",
        body: roast ? `${verdict} ${roast}` : verdict,
        tone: suspicious ? "alert" : "info",
      };
    }

    case "drive_warning": {
      const needing = ids(p.needing);
      const rem = num(p.remaining);
      const impossible = p.level === "impossible";
      const c: DriveC = {
        team,
        names: list(needing.map((id) => playerName(state, id))),
        nine: nineName(num(p.nine, 1)),
        rem,
        holes: plural(rem, "hole", "holes"),
        need: plural(needing.length, "needs", "need"),
        short: Math.max(0, needing.length - rem),
      };
      return impossible
        ? { emoji: "🚨", title: "DRIVE MINIMUM: COOKED", body: pick(seed, "dimp", DRIVE_IMPOSSIBLE)(c), tone: "alert" }
        : { emoji: "🚨", title: "DRIVE MINIMUM: RED ALERT", body: pick(seed, "dhard", DRIVE_HARD)(c), tone: "alert" };
    }

    case "drive_miss": {
      const c: MissC = {
        team,
        names: list(ids(p.missed).map((id) => playerName(state, id))),
        nine: nineName(num(p.nine, 1)),
      };
      return { emoji: "❌", title: "DRIVE MINIMUM MISSED", body: pick(seed, "dmiss", DRIVE_MISS)(c), tone: "alert" };
    }

    case "commissioner_override": {
      const summary = str(p.summary) ?? `did something (${str(p.op_type) ?? "unknown"})`;
      const c: OverrideC = { who: playerName(state, ev.actor_id, "The commissioner"), summary };
      return { emoji: "🧑‍⚖️", title: "COMMISSIONER OVERRIDE", body: pick(seed, "override", OVERRIDE)(c), tone: "alert" };
    }

    case "round_complete": {
      const last = p.last === true;
      const c: CompleteC = {
        team,
        gross: num(p.gross),
        net: num(p.net),
        ntp: formatToPar(num(p.net_to_par)),
        pos: posText(p.pos_label),
        drinks: num(p.drinks),
      };
      return last
        ? { emoji: "🐌", title: `${team} is in. Last.`, body: pick(seed, "clast", COMPLETE_LAST)(c), tone: "roast" }
        : { emoji: "🏁", title: `${team} is in`, body: pick(seed, "complete", COMPLETE)(c), tone: "info" };
    }

    case "final_results": {
      const champIds = ids(p.champion_team_ids);
      const champs = champIds.length > 0 ? champIds : d.leaderTeamIds;
      const standings = Array.isArray(p.standings) ? (p.standings as Record<string, unknown>[]) : [];
      const top = standings.find((r) => r && r.team_id === champs[0]);
      const ntp = top ? num(top.net_to_par) : (d.standings.find((r) => r.team_id === champs[0])?.net_to_par ?? 0);
      if (champs.length === 0) {
        return { emoji: "🏆", title: "FINAL RESULTS", body: "It's final. Nobody scored a single hole, which is its own kind of achievement.", tone: "fanfare" };
      }
      const c: FinalC = {
        champs: list(champs.map((id) => teamName(state, id))),
        win: champs.length > 1 ? "share the title" : "wins",
        ntp: formatToPar(ntp),
      };
      return { emoji: "🏆", title: "FINAL RESULTS", body: pick(seed, "final", FINAL)(c), tone: "fanfare" };
    }

    default:
      return { emoji: "•", title: String(ev.type), body: ev.text ?? "", tone: "info" };
  }
}

function renderNotable(ev: FeedEvent, p: Record<string, unknown>, team: string, hole: number): Body {
  const s = num(p.strokes);
  const par = num(p.par, 4);
  const c: ScoreC = {
    team,
    h: hole,
    s,
    par,
    tp: num(p.to_par, s - par),
    net: num(p.net, s),
    credit: num(p.credit),
    pos: posText(p.pos_label),
    ntp: formatToPar(num(p.net_to_par)),
  };
  const seed = ev.id;
  const ace = p.ace === true && p.kind !== "net_zero" && p.kind !== "last_at_turn";
  if (ace) return { emoji: "🕳️", title: "HOLE IN ONE", body: pick(seed, "ace", ACE)(c), tone: "hype" };
  switch (p.kind) {
    case "albatross":
      return { emoji: "🦅", title: "ALBATROSS", body: pick(seed, "albatross", ALBATROSS)(c), tone: "hype" };
    case "eagle":
      return { emoji: "🦅", title: "EAGLE", body: pick(seed, "eagle", EAGLE)(c), tone: "hype" };
    case "birdie":
      return { emoji: "🐦", title: "BIRDIE", body: pick(seed, "birdie", BIRDIE)(c), tone: "hype" };
    case "double":
      return { emoji: "💩", title: "DOUBLE BOGEY", body: pick(seed, "double", DOUBLE)(c), tone: "roast" };
    case "triple_plus": {
      const title = c.tp === 3 ? "TRIPLE BOGEY" : c.tp === 4 ? "QUADRUPLE BOGEY" : `+${c.tp} ON ONE HOLE`;
      return { emoji: "☠️", title, body: pick(seed, "triple", TRIPLE)(c), tone: "roast" };
    }
    case "net_zero":
      return { emoji: "🍻", title: `NET ${c.net} ON HOLE ${hole}`, body: pick(seed, "netzero", NET_ZERO)(c), tone: "hype" };
    case "last_at_turn":
      return { emoji: "🐢", title: "DEAD LAST AT THE TURN", body: pick(seed, "turn", LAST_AT_TURN)(c), tone: "roast" };
    default:
      return { emoji: "⛳", title: `Hole ${hole}`, body: `${team} made a ${s} on hole ${hole}.`, tone: "info" };
  }
}

function renderEntry(ev: FeedEvent, p: Record<string, unknown>, state: TripState, d: Derived, hole: number): Body {
  const kind = p.contest_type === "ld" ? "ld" : "ctp";
  const unit = p.unit ?? (kind === "ld" ? "yd" : "ft");
  const entryId = str(p.entry_id);
  const entry = entryId ? state.contest_entries.find((e) => e.id === entryId) : undefined;
  // The engine's CURRENT view of the entry while it is still the player's entry: validity (the long
  // drive range is derived from the current tee point and settings), the official distance and any
  // commissioner ruling show up here. A replaced entry keeps what the payload said at the time.
  const view = entryId ? d.contests.find((s) => s.hole === (entry?.hole ?? hole))?.entries.find((v) => v.entry.id === entryId) : undefined;
  const rank = optNum(p.rank);
  const validCount = num(p.valid_count, 0);
  const valid = view ? view.valid : p.valid !== false && p.status !== "flagged";
  const stripReview = (r: string | null | undefined) => r?.replace(/^Needs commissioner review:?\s*/, "") || null;
  const c: EntryC = {
    p: playerName(state, ev.player_id),
    h: hole,
    dist: fmtDistance(view ? view.distance : num(p.distance), unit),
    rank: rank === null ? "" : rank === 1 ? (validCount <= 1 ? "First on the board." : "That's the new best.") : `Currently ${ordinal(rank)}.`,
    reason: (view ? stripReview(view.invalid_reason) : (str(p.flag_reason) ?? stripReview(str(p.invalid_reason)))) ?? "needs a look",
  };
  let body = valid
    ? pick(ev.id, `entry:${kind}`, kind === "ld" ? LD_ENTRY : CTP_ENTRY)(c)
    : pick(ev.id, "entry:flagged", FLAGGED_ENTRY)(c);
  body = body.replace(/\s+$/, "").replace(/ {2,}/g, " ");
  if (entry && entry.deleted_at !== null) body += " (Since re-measured.)";
  return {
    emoji: kind === "ld" ? "💣" : "🎯",
    title: `Hole ${hole} · ${contestName(kind)}`,
    body,
    tone: valid ? "info" : "alert",
  };
}

export function renderFeedEvent(ev: FeedEvent, state: TripState, d: Derived): RenderedEvent {
  const big = BIG_TYPES.has(ev.type);
  try {
    return { ...render(ev, state, d), big };
  } catch (err) {
    // Bad payload from an old row: show something rather than break the feed.
    console.error("[feed] render failed", ev.type, err);
    return { emoji: "•", title: String(ev.type), body: ev.text ?? "", tone: "info", big };
  }
}

/** Toast copy when a drink is logged before "On the tee" for hole 1 (or after round complete). */
export function noWindowRoast(seed: string): string {
  return pick(String(seed), "nowindow", NO_WINDOW);
}
