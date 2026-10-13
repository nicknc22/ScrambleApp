// Demo mode: a fake "Demo Scramble" trip with 10 fake degenerates, 3 teams (4/3/3), antes, venmo
// handles, tee/green points for all 18 holes and (unless mode "setup") a simulated round.
//
// The round is SIMULATED, not faked: every action is a real Op (tee.open, drink.log, score.set,
// contest.submit, mulligan.use, post.create, reaction.set, commissioner overrides...) applied with
// applyOpsToTrip, the exact pipeline behind POST /api/t/<code>/sync. So feed events, ghost beers,
// lead changes, drive-minimum callouts, pots and awards come out exactly as they would on Saturday.
//
//   createDemoTrip(db, {mode, code?, seed?})  new is_demo trip (fails if the code is taken)
//   resetDemoTrip(db, code, {mode?})          only for is_demo trips: delete (cascade) + recreate
//
// Modes: "partial" leaves the round live with teams on holes 15, 12 and 7; "full" plays all 18 for
// every team and finalizes; "setup" stops before the round starts (for poking at Setup).
//
// Determinism: row ids derive from the trip code (players, teams, ops, photos), and the trip id
// from the code too, so a reset keeps every phone's "who am I", the commissioner cookie and the
// Realtime topic working. Gameplay randomness comes from a seeded PRNG (default seed fixed, so
// "Reset demo" really resets to the same round). Simulated times end just before `now`.
import { JACK_FROST_CENTER, JACK_FROST_HOLES } from "@/lib/course";
import { haversineYards } from "@/lib/engine/geo";
import { deriveId, newTripCode } from "@/lib/ids";
import type { Op, OpInput, OpResult } from "@/lib/ops";
import type { Write } from "@/lib/reducer";
import {
  DEFAULT_SETTINGS,
  type DrinkType,
  type FeedEvent,
  type PotKey,
  type ReactionKind,
  type Trip,
  type TripState,
  type UUID,
} from "@/lib/types";
import { applyOpsToTrip } from "./apply";
import { hashPin } from "./auth";
import { pgErrorCode, UNIQUE_VIOLATION, type Db } from "./db";
import { deleteTrip, findTripByCode, insertTrip, persistWrites } from "./repo";
import { putPhoto, type PhotoKind } from "./storage";
import { DEFAULT_APP_NAME, normalizeCode, seedHoles } from "./trips";

export type DemoMode = "partial" | "full" | "setup";
export const DEMO_MODES: readonly DemoMode[] = ["partial", "full", "setup"];
export const DEMO_TRIP_NAME = "Demo Scramble";
/** Commissioner PIN of every demo trip (shown in Settings on demo trips). */
export const DEMO_PIN = "0000";
/** Default PRNG seed: same seed, same round. */
export const DEFAULT_DEMO_SEED = 1024;
/** Partial mode: the hole each team (A, B, C) is on right now. */
export const PARTIAL_CURRENT_HOLES = [15, 12, 7] as const;

export function isDemoMode(v: unknown): v is DemoMode {
  return typeof v === "string" && (DEMO_MODES as readonly string[]).includes(v);
}

export interface DemoOptions {
  mode: DemoMode;
  /** Fixed join code (CLI/tests). Default: "demo" + 8 random characters. */
  code?: string;
  seed?: number;
  /** Real "now" the simulated round ends at (tests). Default: the current time. */
  now?: Date;
  /** Upload the demo photos (default true). false = no photos at all. */
  photos?: boolean;
}

export interface DemoStats {
  batches: number;
  ops: number;
  applied: number;
  /** Ops the reducer refused. Should always be empty; logged when not. */
  rejected: OpResult[];
  photos: number;
  photo_failures: number;
  ms: number;
}

export interface DemoResult {
  trip: Trip;
  code: string;
  url: string;
  mode: DemoMode;
  stats: DemoStats;
}

export class DemoError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: "invalid" | "not_demo" | "not_found" | "taken" | "busy",
  ) {
    super(message);
    this.name = "DemoError";
  }
}

// ---------------------------------------------------------------------------
// Cast
// ---------------------------------------------------------------------------

interface DemoPlayerDef {
  key: string;
  name: string;
  nickname: string;
  groom?: boolean;
  /** Relative odds of being the one drinking. */
  thirst: number;
  /** Relative odds of the team using this player's tee shot. */
  drive: number;
}

const PLAYERS: readonly DemoPlayerDef[] = [
  { key: "nick", name: "Nick", nickname: "Captain Mulligan", groom: true, thirst: 1.2, drive: 1.2 },
  { key: "mike", name: "Mike", nickname: "Shank Sinatra", thirst: 1, drive: 0.7 },
  { key: "tony", name: "Tony", nickname: "Two-Putt Tony", thirst: 1.3, drive: 1.6 },
  { key: "chris", name: "Chris", nickname: "Lip-Out King", thirst: 0.8, drive: 1 },
  { key: "matt", name: "Matt", nickname: "Foot Wedge", thirst: 1.1, drive: 1.3 },
  { key: "ryan", name: "Ryan", nickname: "Shotgun", thirst: 1.7, drive: 1.1 },
  { key: "kevin", name: "Kevin", nickname: "Bunker Mentality", thirst: 0.9, drive: 0.6 },
  { key: "jake", name: "Jake", nickname: "The Snowman", thirst: 1.2, drive: 1 },
  { key: "pat", name: "Pat", nickname: "Hazard Pay", thirst: 1, drive: 1.3 },
  { key: "steve", name: "Steve", nickname: "Breakfast Ball", thirst: 1.4, drive: 0.9 },
];

interface DemoTeamDef {
  key: "A" | "B" | "C";
  name: string;
  members: readonly string[];
  /** Usually the one entering scores. */
  scorer: string;
  /** Minutes after the first tee time. */
  tee_offset_min: number;
}

const TEAMS: readonly DemoTeamDef[] = [
  { key: "A", name: "Grip It & Sip It", members: ["nick", "mike", "tony", "chris"], scorer: "chris", tee_offset_min: 0 },
  { key: "B", name: "Ghost Beer Gang", members: ["matt", "ryan", "kevin"], scorer: "matt", tee_offset_min: 10 },
  { key: "C", name: "The Shank Redemption", members: ["jake", "pat", "steve"], scorer: "pat", tee_offset_min: 20 },
];

/** Obviously fake, so a "Pay with Venmo" tap in the demo can't send real money to a stranger. */
const venmoFor = (p: DemoPlayerDef) => `Demo-${p.name}-NotReal`;

const SETTINGS_PATCH = {
  team_match_ante_cents: 2000,
  contest_ante_cents: 500,
  team_match_payout: [70, 30],
};

/** Kevin sits out the hole-11 closest-to-pin pot (opt-outs work). */
const DEMO_OPTOUT: { player: string; pot: PotKey } = { player: "kevin", pot: "contest:11" };

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  weighted<T>(xs: readonly T[], weights: readonly number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < xs.length; i++) {
      r -= weights[i];
      if (r < 0) return xs[i];
    }
    return xs[xs.length - 1];
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Synthetic course: 18 tee/green points around the clubhouse
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DemoHolePoints {
  hole: number;
  /** Tee -> green bearing, degrees clockwise from north. */
  bearing: number;
  tee: LatLng;
  green: LatLng;
}

const EARTH_RADIUS_M = 6371008.8; // same sphere as the engine's haversine
const METERS_PER_YARD = 0.9144;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const round7 = (x: number) => Math.round(x * 1e7) / 1e7;

/** Point `meters` from `p` along `bearing` (great circle). */
export function destination(p: LatLng, bearing: number, meters: number): LatLng {
  const d = meters / EARTH_RADIUS_M;
  const t = toRad(bearing);
  const f1 = toRad(p.lat);
  const l1 = toRad(p.lng);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lat: toDeg(f2), lng: toDeg(l2) };
}

// Two loops that come back to the clubhouse: the front nine swings south-west, the back north-east.
const FRONT_BEARINGS = [200, 240, 285, 320, 0, 35, 75, 115, 150];
const BACK_BEARINGS = [20, 60, 100, 140, 175, 215, 250, 290, 330];
/** Green to next tee walk, yards. */
const WALK_YD = 45;

/**
 * Tee and green points for all 18 holes around JACK_FROST_CENTER. Tee -> green distance equals the
 * Membership yardage (to the yard, rounded to 7 decimals of a degree ≈ 1 cm).
 */
export function demoCourseLayout(): DemoHolePoints[] {
  const out: DemoHolePoints[] = [];
  let p = destination(JACK_FROST_CENTER, 200, 60);
  JACK_FROST_HOLES.forEach((h, i) => {
    if (i === 9) p = destination(JACK_FROST_CENTER, 20, 60); // 10th tee by the clubhouse
    const bearing = i < 9 ? FRONT_BEARINGS[i] : BACK_BEARINGS[i - 9];
    const tee = { lat: round7(p.lat), lng: round7(p.lng) };
    const g = destination(tee, bearing, h.yardage.membership * METERS_PER_YARD);
    const green = { lat: round7(g.lat), lng: round7(g.lng) };
    out.push({ hole: h.number, bearing, tee, green });
    p = destination(green, bearing + 70, WALK_YD * METERS_PER_YARD);
  });
  return out;
}

/** Where a drive of `yards` (with `sideYards` left/right of the line) ends up. */
function ballPosition(hole: DemoHolePoints, yards: number, sideYards: number): LatLng {
  const along = destination(hole.tee, hole.bearing, yards * METERS_PER_YARD);
  const p = destination(along, hole.bearing + 90, sideYards * METERS_PER_YARD);
  return { lat: round7(p.lat), lng: round7(p.lng) };
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const NS = "scramble-demo";

/** A demo trip's id is a function of its code, so resets keep cookies and Realtime topics. */
export function demoTripId(code: string): UUID {
  return deriveId(NS, code, "trip");
}

export function demoPlayerId(code: string, key: string): UUID {
  return deriveId(NS, code, "player", key);
}

export function demoTeamId(code: string, key: string): UUID {
  return deriveId(NS, code, "team", key);
}

/** "demo" + 8 characters of an unguessable trip code. */
export function newDemoCode(): string {
  return `demo${newTripCode().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Photos (tiny JPEGs drawn for the demo, embedded at the bottom of this file)
// ---------------------------------------------------------------------------

export type DemoPhotoAsset = "beer" | "shotgun" | "ctp" | "ld" | "sunset" | "snowman";

const photoCache = new Map<DemoPhotoAsset, Uint8Array>();

export function demoPhotoBytes(asset: DemoPhotoAsset): Uint8Array {
  let b = photoCache.get(asset);
  if (!b) {
    b = new Uint8Array(Buffer.from(DEMO_PHOTOS[asset], "base64"));
    photoCache.set(asset, b);
  }
  return b;
}

interface PhotoUpload {
  path: string;
  asset: DemoPhotoAsset;
}

/** Upload with a little concurrency. Returns the paths that failed (never throws). */
async function uploadPhotos(tripId: UUID, uploads: PhotoUpload[]): Promise<Set<string>> {
  const failed = new Set<string>();
  const queue = [...uploads];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      try {
        await putPhoto(tripId, u.path, demoPhotoBytes(u.asset));
      } catch (e) {
        failed.add(u.path);
        if (failed.size === 1) console.warn(`[demo] photo upload failed (${e instanceof Error ? e.message : String(e)}); continuing without it`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, uploads.length) }, worker));
  return failed;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Batch {
  /** Simulated server time the batch syncs at (>= every op's `at`). */
  t: number;
  commissioner: boolean;
  ops: Op[];
  /** Tie-break for batches at the same time (plan order). */
  seq: number;
}

/** Posts and reactions: ride along with the next batch that syncs after them. */
interface LooseOp {
  t: number;
  op: Op;
}

interface PlannedDrink {
  player: string;
  type: DrinkType;
  /** "start": logged with the hole's first sync; "end": with the score. */
  phase: "start" | "end";
  by?: string;
  photo?: DemoPhotoAsset;
}

/** Forced drinks (team key -> hole -> drinks) so every demo has ghost beers, shotguns and photos early. */
const FORCED_DRINKS: Record<string, Record<number, PlannedDrink[]>> = {
  A: {
    1: [{ player: "mike", type: "drink", phase: "end" }],
    2: [
      { player: "tony", type: "shotgun", phase: "start", photo: "shotgun" },
      { player: "nick", type: "drink", phase: "end", by: "chris" },
    ],
  },
  B: {
    1: [
      { player: "ryan", type: "shotgun", phase: "start" },
      { player: "matt", type: "drink", phase: "end" },
    ],
    2: [{ player: "kevin", type: "drink", phase: "start", by: "matt" }], // 3rd drink: ghost beer
    5: [{ player: "matt", type: "drink", phase: "end", photo: "beer" }],
  },
  C: {
    1: [
      { player: "jake", type: "drink", phase: "start" },
      { player: "pat", type: "drink", phase: "end" },
    ],
    2: [{ player: "steve", type: "shot", phase: "start" }], // 3rd drink: a ghost shot
    3: [{ player: "jake", type: "drink", phase: "end", photo: "beer" }],
  },
};

/** Forced strokes: team key -> hole -> strokes (first entry). */
const FORCED_STROKES: Record<string, Record<number, number>> = {
  A: { 5: 5 }, // edited to a 4 during hole 6 ("changed hole 5 from a 5 to a 4")
  B: { 6: 3 }, // the commissioner fixes it to a 4 (override)
  C: { 2: 6 }, // the double
};

/** Team B's front nine: Kevin's tee shot is never used (drive-minimum miss). */
const DRIVE_MISS = { team: "B", nine: 1, player: "kevin" };

interface PlanCtx {
  code: string;
  tripId: UUID;
  mode: DemoMode;
  nowMs: number;
  rng: Rng;
  holes: DemoHolePoints[];
  photos: boolean;
}

interface TeamTimeline {
  def: DemoTeamDef;
  /** starts[h] = when the team tapped On the tee for hole h (1-based); starts[19] = round end (full). */
  starts: number[];
  /** Holes fully played (scored). */
  played: number;
  /** Hole open right now (partial), else null. */
  current: number | null;
}

class Planner {
  readonly batches: Batch[] = [];
  readonly loose: LooseOp[] = [];
  readonly uploads: PhotoUpload[] = [];
  private opSeq = 0;
  private batchSeq = 0;
  private photoSeq = 0;
  private postSeq = 0;
  /** The weak-GPS long drive the commissioner reviews before finalizing. */
  weakEntryId: UUID | null = null;

  constructor(readonly ctx: PlanCtx) {}

  get rng(): Rng {
    return this.ctx.rng;
  }

  pid(key: string): UUID {
    return demoPlayerId(this.ctx.code, key);
  }

  tid(key: string): UUID {
    return demoTeamId(this.ctx.code, key);
  }

  op(input: OpInput, at: number, by: string | null): Op {
    const id = deriveId(NS, this.ctx.code, "op", String(++this.opSeq));
    return { ...input, id, at: iso(at), by: by === null ? null : this.pid(by) } as Op;
  }

  batch(t: number, ops: Op[], commissioner = false): void {
    if (ops.length === 0) return;
    // Within a batch, ops apply in time order (ghost beer order is by logged time).
    const sorted = ops.map((op, i) => ({ op, i })).sort((a, b) => Date.parse(a.op.at) - Date.parse(b.op.at) || a.i - b.i);
    this.batches.push({ t, commissioner, ops: sorted.map((x) => x.op), seq: ++this.batchSeq });
  }

  looseOp(t: number, op: Op): void {
    this.loose.push({ t, op });
  }

  photo(kind: PhotoKind, asset: DemoPhotoAsset): string | null {
    if (!this.ctx.photos) return null;
    const id = deriveId(NS, this.ctx.code, "photo", String(++this.photoSeq));
    const path = `trips/${this.ctx.tripId}/${kind}/${id}.jpg`;
    this.uploads.push({ path, asset });
    return path;
  }

  postId(): UUID {
    return deriveId(NS, this.ctx.code, "post", String(++this.postSeq));
  }
}

function membersOf(team: DemoTeamDef): DemoPlayerDef[] {
  return team.members.map((k) => PLAYERS.find((p) => p.key === k)!);
}

/** When each team stands on each tee. Simulated times all end before ctx.nowMs. */
function timelines(ctx: PlanCtx): TeamTimeline[] {
  const { mode, nowMs, rng } = ctx;
  return TEAMS.map((def, i) => {
    const starts: number[] = [];
    if (mode === "full") {
      const teeOff = nowMs - (290 - def.tee_offset_min) * MIN;
      const pace = 14.5 * MIN;
      for (let h = 1; h <= 19; h++) {
        const jitter = h === 1 || h === 19 ? 0 : rng.range(-1.2, 1.2) * MIN;
        starts[h] = teeOff + (h - 1) * pace + jitter;
      }
      return { def, starts, played: 18, current: null };
    }
    // partial: on PARTIAL_CURRENT_HOLES[i] right now. The Shank Redemption teed off late (hungover).
    const current = PARTIAL_CURRENT_HOLES[i];
    const teeOffAgo = [160, 150, 95][i];
    const currentAgo = [4, 7, 5][i];
    const teeOff = nowMs - teeOffAgo * MIN;
    const curStart = nowMs - currentAgo * MIN;
    const pace = (curStart - teeOff) / (current - 1);
    for (let h = 1; h <= current; h++) {
      const jitter = h === 1 || h === current ? 0 : rng.range(-1.2, 1.2) * MIN;
      starts[h] = teeOff + (h - 1) * pace + jitter;
    }
    return { def, starts, played: current - 1, current };
  });
}

/** Whose tee shot each hole used: everyone at least once per nine (early), except the planned miss. */
function teeShotPlan(team: DemoTeamDef, rng: Rng): Record<number, string> {
  const members = membersOf(team);
  const plan: Record<number, string> = {};
  for (const nine of [1, 2] as const) {
    const first = nine === 1 ? 1 : 10;
    const holes = Array.from({ length: 9 }, (_, i) => first + i);
    const missKey = DRIVE_MISS.team === team.key && DRIVE_MISS.nine === nine ? DRIVE_MISS.player : null;
    const eligible = members.filter((m) => m.key !== missKey);
    // Everyone eligible gets one of the first six holes of the nine.
    const early = rng.shuffle(holes.slice(0, 6));
    rng.shuffle(eligible).forEach((m, i) => {
      plan[early[i]] = m.key;
    });
    for (const h of holes) {
      if (plan[h]) continue;
      plan[h] = rng.weighted(
        eligible.map((m) => m.key),
        eligible.map((m) => m.drive),
      );
    }
  }
  return plan;
}

function sampleStrokes(par: number, rng: Rng): number {
  const r = rng.next();
  if (par === 3) return r < 0.2 ? 2 : r < 0.84 ? 3 : r < 0.97 ? 4 : 5;
  if (par === 4) return r < 0.3 ? 3 : r < 0.83 ? 4 : r < 0.97 ? 5 : 6;
  return r < 0.05 ? 3 : r < 0.48 ? 4 : r < 0.9 ? 5 : 6;
}

function randomDrinks(team: DemoTeamDef, rng: Rng): PlannedDrink[] {
  const members = membersOf(team);
  const n =
    members.length >= 4 ? rng.weighted([0, 1, 2, 3, 4], [22, 36, 26, 12, 4]) : rng.weighted([0, 1, 2, 3], [30, 40, 22, 8]);
  const out: PlannedDrink[] = [];
  for (let i = 0; i < n; i++) {
    const drinker = rng.weighted(
      members.map((m) => m.key),
      members.map((m) => m.thirst),
    );
    const type = rng.weighted<DrinkType>(["drink", "shotgun", "shot"], [84, 9, 7]);
    const by = rng.chance(0.7) ? drinker : rng.pick(members.filter((m) => m.key !== drinker)).key;
    out.push({ player: drinker, type, phase: rng.chance(0.45) ? "start" : "end", by });
  }
  return out;
}

/** Plan one team's holes: tee.open, drinks, mulligans, contest entries, scores, tee shots. */
function planTeam(p: Planner, tl: TeamTimeline): void {
  const { rng, holes } = p.ctx;
  const team = tl.def;
  const teamId = p.tid(team.key);
  const members = membersOf(team);
  const keys = members.map((m) => m.key);
  const shooters = teeShotPlan(team, rng);
  let banked = 0; // shotguns + shots on holes already finished
  let usedEarned = 0;
  const scorer = () => (rng.chance(0.7) ? team.scorer : rng.pick(keys));

  for (let h = 1; h <= tl.played; h++) {
    const s = tl.starts[h];
    const dur = tl.starts[h + 1] - s;
    const at = (f: number) => s + f * dur;
    const par = JACK_FROST_HOLES[h - 1].par;
    const geo = holes[h - 1];
    const startOps: Op[] = [];
    const endOps: Op[] = [];

    startOps.push(p.op({ type: "tee.open", team_id: teamId, hole: h }, at(0.01), rng.pick(keys)));

    // Drinks
    const drinks = FORCED_DRINKS[team.key]?.[h] ?? randomDrinks(team, rng);
    let holeEarned = 0;
    for (const d of drinks) {
      const when = d.phase === "start" ? at(rng.range(0.04, 0.28)) : at(rng.range(0.4, 0.84));
      const op = p.op(
        {
          type: "drink.log",
          drink_id: deriveId(NS, p.ctx.code, "drink", team.key, String(h), String(drinks.indexOf(d))),
          team_id: teamId,
          player_id: p.pid(d.player),
          hole: h,
          drink_type: d.type,
          photo_path: d.photo ? p.photo("drinks", d.photo) : null,
        },
        when,
        d.by ?? d.player,
      );
      (d.phase === "start" ? startOps : endOps).push(op);
      if (d.type !== "drink") holeEarned += 1;
    }

    // Mulligans: the Groom's on Grip It & Sip It's 4th (a par 5 tee shot), earned ones now and then.
    if (team.key === "A" && h === 4) {
      startOps.push(
        p.op(
          { type: "mulligan.use", mulligan_id: deriveId(NS, p.ctx.code, "mulligan", "groom"), team_id: teamId, hole: h, source: "groom" },
          at(0.08),
          "nick",
        ),
      );
    }
    const forcedEarned = team.key === "B" && h === 3;
    if (banked - usedEarned > 0 && (forcedEarned || rng.chance(0.22))) {
      usedEarned += 1;
      startOps.push(
        p.op(
          {
            type: "mulligan.use",
            mulligan_id: deriveId(NS, p.ctx.code, "mulligan", team.key, String(h)),
            team_id: teamId,
            hole: h,
            source: "earned",
          },
          at(0.16),
          rng.pick(keys),
        ),
      );
    }

    // Contests
    if (geo && par === 5) {
      const n = members.length >= 4 ? rng.int(1, 3) : rng.int(1, 2);
      const entrants = [shooters[h], ...rng.shuffle(keys.filter((k) => k !== shooters[h]))].slice(0, n);
      entrants.forEach((k, i) => {
        const weak = team.key === "C" && h === 4 && i === 0; // one for the commissioner's review queue
        // 220-320 yd down the hole's line (the odd bomb near 320), a few yards either side of it.
        const yards = Math.min(318, Math.max(222, rng.chance(0.1) ? rng.range(305, 318) : rng.range(228, 300) - i * 6));
        const ball = ballPosition(geo, yards, rng.range(-14, 14));
        const entryId = deriveId(NS, p.ctx.code, "ld", String(h), k);
        if (weak) p.weakEntryId = entryId;
        startOps.push(
          p.op(
            {
              type: "contest.submit",
              entry_id: entryId,
              hole: h,
              player_id: p.pid(k),
              contest_type: "ld",
              distance_value: haversineYards(geo.tee, ball),
              angle_deg: null,
              lat: ball.lat,
              lng: ball.lng,
              gps_accuracy_m: weak ? 23 : Math.round(rng.range(3, 9) * 10) / 10,
              low_accuracy: weak,
              photo_path: p.photo("ld", "ld"),
            },
            at(0.12 + i * 0.03),
            k,
          ),
        );
      });
    }
    if (par === 3) {
      const n = rng.weighted([0, 1, 2], [18, 52, 30]) || (h === 3 ? 1 : 0);
      const pool = rng.chance(0.75) ? [shooters[h], ...rng.shuffle(keys.filter((k) => k !== shooters[h]))] : rng.shuffle(keys);
      pool.slice(0, n).forEach((k, i) => {
        // 2 to 40 ft, to the inch.
        const feet = Math.round((2 + 38 * Math.pow(rng.next(), 1.3)) * 12) / 12;
        startOps.push(
          p.op(
            {
              type: "contest.submit",
              entry_id: deriveId(NS, p.ctx.code, "ctp", String(h), k),
              hole: h,
              player_id: p.pid(k),
              contest_type: "ctp",
              distance_value: feet,
              angle_deg: rng.int(0, 359),
              lat: null,
              lng: null,
              gps_accuracy_m: null,
              low_accuracy: false,
              photo_path: p.photo("ctp", "ctp"),
            },
            at(0.2 + i * 0.03),
            k,
          ),
        );
      });
    }

    // Score + tee shot
    const strokes = FORCED_STROKES[team.key]?.[h] ?? sampleStrokes(par, rng);
    const who = scorer();
    endOps.push(p.op({ type: "score.set", team_id: teamId, hole: h, strokes }, at(0.86), who));
    endOps.push(p.op({ type: "teeshot.set", team_id: teamId, hole: h, player_id: p.pid(shooters[h]) }, at(0.865), who));

    // The score edit: "changed hole 5 from a 5 to a 4" (they forgot the gimme).
    if (team.key === "A" && h === 6) {
      endOps.push(p.op({ type: "score.set", team_id: teamId, hole: 5, strokes: 4 }, at(0.87), "mike"));
    }
    if (h === 18) endOps.push(p.op({ type: "round.complete", team_id: teamId }, at(0.95), who));

    p.batch(at(0.3), startOps);
    p.batch(at(0.9), endOps);
    banked += holeEarned;
  }

  // Partial: standing on the current tee right now.
  if (tl.current !== null) {
    const s = tl.starts[tl.current];
    const ops: Op[] = [p.op({ type: "tee.open", team_id: teamId, hole: tl.current }, s + 10_000, rng.pick(keys))];
    if (members.length >= 4) {
      ops.push(
        p.op(
          {
            type: "drink.log",
            drink_id: deriveId(NS, p.ctx.code, "drink", team.key, String(tl.current), "0"),
            team_id: teamId,
            player_id: p.pid("nick"),
            hole: tl.current,
            drink_type: "drink",
            photo_path: null,
          },
          s + 40_000,
          "mike",
        ),
      );
    }
    p.batch(s + MIN, ops);
  }
}

interface DemoPost {
  team: string;
  /** Anchor: this team's hole start (or "final" / "setup"). */
  hole: number | "final" | "setup";
  /** Minutes after the anchor. */
  after_min: number;
  by: string;
  text: string;
  photo?: DemoPhotoAsset;
}

const POSTS: readonly DemoPost[] = [
  { team: "A", hole: "setup", after_min: 0, by: "mike", text: "Range session complete. Hit zero balls, drank two beers. Locked in." },
  {
    team: "A",
    hole: 3,
    after_min: 2,
    by: "chris",
    text: "Tony shotgunned a Busch Light on the 2nd tee and then striped it down the middle. Science can't explain this.",
  },
  { team: "C", hole: 3, after_min: 3, by: "pat", text: "Scorecard after two. We don't talk about hole 2.", photo: "snowman" },
  { team: "A", hole: 7, after_min: 3, by: "nick", text: "Hole 7. Mountains, beers, zero fairways. Perfect day.", photo: "sunset" },
  { team: "B", hole: 10, after_min: 2, by: "matt", text: "Kevin has not hit a tee shot we used in 9 holes. #FreeKevin" },
  { team: "B", hole: "final", after_min: 2, by: "ryan", text: "GG degenerates. Venmo requests incoming. Pay up or get roasted in the group chat forever." },
];

/** Build every batch of the demo, in the order they sync. */
function plan(ctx: PlanCtx): Planner {
  const p = new Planner(ctx);
  const { mode, nowMs, holes } = ctx;
  const tls = mode === "setup" ? [] : timelines(ctx);
  const firstTee = tls.length ? Math.min(...tls.map((t) => t.starts[1])) : nowMs;
  const setupAt = mode === "setup" ? nowMs - 25 * MIN : firstTee - 70 * MIN;

  // ---- Setup (commissioner): roster, teams, pots, course points ----
  const setup: Op[] = [];
  let tick = 0;
  const sAt = () => setupAt + (tick++ % 50) * 1000;
  PLAYERS.forEach((pl, i) => {
    setup.push(
      p.op(
        {
          type: "player.upsert",
          player: {
            id: p.pid(pl.key),
            name: pl.name,
            nickname: pl.nickname,
            venmo_handle: venmoFor(pl),
            is_groom: !!pl.groom,
            sort_order: i,
          },
        },
        sAt(),
        null,
      ),
    );
  });
  TEAMS.forEach((t, i) => {
    const mins = 12 * 60 + 50 + t.tee_offset_min;
    const teeTime = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
    setup.push(p.op({ type: "team.upsert", team: { id: p.tid(t.key), name: t.name, tee_time: teeTime, sort_order: i } }, sAt(), null));
  });
  for (const t of TEAMS) {
    for (const m of t.members) setup.push(p.op({ type: "team.assign", player_id: p.pid(m), team_id: p.tid(t.key) }, sAt(), null));
  }
  setup.push(p.op({ type: "trip.update", patch: { settings: { ...SETTINGS_PATCH } } }, sAt(), null));
  for (const h of holes) {
    setup.push(
      p.op(
        { type: "hole.update", hole: h.hole, patch: { tee_lat: h.tee.lat, tee_lng: h.tee.lng, green_lat: h.green.lat, green_lng: h.green.lng } },
        sAt(),
        null,
      ),
    );
  }
  setup.push(p.op({ type: "pot.optout", pot_key: DEMO_OPTOUT.pot, player_id: p.pid(DEMO_OPTOUT.player), out: true }, sAt(), DEMO_OPTOUT.player));
  p.batch(setupAt + MIN, setup, true);

  const anchor = (post: DemoPost): number | null => {
    if (post.hole === "setup") return mode === "setup" ? nowMs - 10 * MIN : firstTee - 30 * MIN;
    if (post.hole === "final") return mode === "full" ? nowMs - 4 * MIN : null;
    const tl = tls.find((x) => x.def.key === post.team);
    if (!tl || post.hole > (tl.current ?? tl.played)) return null;
    return tl.starts[post.hole];
  };
  for (const post of POSTS) {
    const a = anchor(post);
    if (a === null) continue;
    const t = a + post.after_min * MIN;
    const op = p.op(
      { type: "post.create", event_id: p.postId(), text: post.text, photo_path: post.photo ? p.photo("posts", post.photo) : null },
      t,
      post.by,
    );
    p.looseOp(t, op);
  }
  if (mode === "setup") return p;

  // ---- Start (commissioner, from the groom's phone) ----
  p.batch(firstTee - 5 * MIN, [p.op({ type: "trip.start" }, firstTee - 5 * MIN - 20_000, "nick")], true);

  // ---- Play ----
  for (const tl of tls) planTeam(p, tl);

  // ---- The commissioner fixes Ghost Beer Gang's "birdie" on 6 (during their 8th) ----
  const b = tls.find((x) => x.def.key === "B")!;
  const fixAt = b.starts[8] + 2 * MIN;
  p.batch(
    fixAt + 20_000,
    [p.op({ type: "score.set", team_id: p.tid("B"), hole: 6, strokes: 4, as_commissioner: true }, fixAt, "nick")],
    true,
  );

  // ---- Full: approve the weak-GPS drive, then finalize ----
  if (mode === "full") {
    const finalAt = nowMs - 4 * MIN;
    const ops: Op[] = [];
    if (p.weakEntryId) {
      ops.push(p.op({ type: "contest.review", entry_id: p.weakEntryId, status: "overridden" }, finalAt - 60_000, "nick"));
    }
    ops.push(p.op({ type: "trip.finalize" }, finalAt, "nick"));
    p.batch(finalAt + 10_000, ops, true);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Reactions (decided as events appear, like real people reading the feed)
// ---------------------------------------------------------------------------

function reactionPlan(ev: FeedEvent, rng: Rng): { p: number; kinds: ReactionKind[]; max: number } | null {
  switch (ev.type) {
    case "groom_mulligan":
      return { p: 1, kinds: ["goat", "clown", "fire"], max: 5 };
    case "ghost_beer":
      return { p: 0.7, kinds: ["beer", "fire", "goat"], max: 3 };
    case "shotgun":
    case "shot":
      return { p: 0.6, kinds: ["beer", "fire"], max: 3 };
    case "post":
      return { p: 0.95, kinds: ["lol", "fire", "dead"], max: 4 };
    case "drive_miss":
      return { p: 1, kinds: ["clown", "lol"], max: 3 };
    case "score_edit":
    case "commissioner_override":
      return { p: 0.8, kinds: ["clown", "lol"], max: 2 };
    case "final_results":
      return { p: 1, kinds: ["goat", "beer", "fire"], max: 4 };
    case "lead_change":
    case "contest_lead":
      return { p: 0.35, kinds: ["fire", "goat"], max: 2 };
    case "score_notable": {
      const kind = ev.payload.kind;
      if (kind === "double" || kind === "triple_plus" || kind === "last_at_turn") return { p: 0.9, kinds: ["dead", "lol", "clown"], max: 3 };
      if (kind === "eagle" || kind === "albatross") return { p: 1, kinds: ["fire", "goat"], max: 4 };
      return { p: rng.chance(0.5) ? 0.4 : 0.25, kinds: ["fire", "beer"], max: 2 };
    }
    default:
      return null;
  }
}

function scheduleReactions(p: Planner, ev: FeedEvent, t: number, endLimit: number): void {
  if (ev.deleted_at !== null) return;
  const rp = reactionPlan(ev, p.rng);
  if (!rp || !p.rng.chance(rp.p)) return;
  const exclude = new Set([ev.actor_id, ev.player_id].filter((x): x is string => !!x));
  const pool = p.rng.shuffle(PLAYERS.map((x) => x.key)).filter((k) => !exclude.has(p.pid(k)));
  const n = p.rng.int(1, rp.max);
  for (const key of pool.slice(0, n)) {
    const when = t + p.rng.range(0.5, 6) * MIN;
    if (when > endLimit) continue;
    p.looseOp(
      when,
      p.op({ type: "reaction.set", feed_event_id: ev.id, player_id: p.pid(key), kind: p.rng.pick(rp.kinds), on: true }, when, key),
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** The PIN hash shared by demo trips (scrypt once per process). */
let demoPinHashP: Promise<string> | null = null;
function demoPinHash(): Promise<string> {
  if (!demoPinHashP) {
    demoPinHashP = hashPin(DEMO_PIN);
    demoPinHashP.catch(() => {
      demoPinHashP = null;
    });
  }
  return demoPinHashP;
}

async function insertDemoTrip(db: Db, code: string, createdAt: number): Promise<Trip> {
  const pinHash = await demoPinHash();
  const nowIso = iso(createdAt);
  const trip: Trip = {
    id: demoTripId(code),
    code,
    name: DEMO_TRIP_NAME,
    app_name: DEFAULT_APP_NAME,
    status: "setup",
    base_team_size: 4,
    settings: { ...DEFAULT_SETTINGS, team_match_payout: [...DEFAULT_SETTINGS.team_match_payout] },
    is_demo: true,
    created_at: nowIso,
    started_at: null,
    finalized_at: null,
    updated_at: nowIso,
  };
  return db.tx(async (t) => {
    const saved = await insertTrip(t, trip, pinHash);
    const writes: Write[] = seedHoles(trip.id, nowIso).map((row) => ({ kind: "upsert", table: "holes", row }));
    await persistWrites(t, trip.id, writes);
    return saved;
  });
}

/** Replace failed photo uploads with no photo (a missing photo must never sink the demo). */
function dropPhotos(ops: Op[], failed: ReadonlySet<string>): Op[] {
  if (failed.size === 0) return ops;
  return ops.map((op) => {
    const path = (op as { photo_path?: unknown }).photo_path;
    return typeof path === "string" && failed.has(path) ? ({ ...op, photo_path: null } as Op) : op;
  });
}

async function simulate(db: Db, trip: Trip, ctx: PlanCtx): Promise<{ trip: Trip; stats: Omit<DemoStats, "ms"> }> {
  const p = plan(ctx);
  const failed = p.uploads.length ? await uploadPhotos(trip.id, p.uploads) : new Set<string>();

  const batches = [...p.batches].sort((a, b) => a.t - b.t || a.seq - b.seq);
  const endLimit = ctx.nowMs - 15_000;
  const seen = new Set<UUID>();
  const rejected: OpResult[] = [];
  let ops = 0;
  let applied = 0;
  let last: TripState | null = null;
  let count = 0;

  const run = async (t: number, batchOps: Op[], commissioner: boolean) => {
    const list = dropPhotos(batchOps, failed);
    // A batch is at most 200 ops on the wire (MAX_OPS_PER_SYNC); demo batches are far smaller.
    const out = await applyOpsToTrip({ db, trip, ops: list, isCommissioner: commissioner, now: new Date(Math.min(t, ctx.nowMs)) });
    count += 1;
    ops += list.length;
    for (const r of out.results) {
      if (r.status === "applied") applied += 1;
      else if (r.status === "rejected") rejected.push(r);
    }
    last = out.snapshot.state;
    for (const ev of out.events.feed) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      scheduleReactions(p, ev, t, endLimit);
    }
  };

  const takeLoose = (t: number): Op[] => {
    p.loose.sort((a, b) => a.t - b.t);
    const due: Op[] = [];
    while (p.loose.length && p.loose[0].t <= t) due.push(p.loose.shift()!.op);
    return due;
  };

  for (const b of batches) {
    await run(b.t, [...b.ops, ...takeLoose(b.t)], b.commissioner);
  }
  // Whatever is still pending (late reactions, the post-round post) syncs last.
  for (let guard = 0; p.loose.length && guard < 10; guard++) {
    p.loose.sort((a, b) => a.t - b.t);
    const due = p.loose.filter((l) => l.t <= endLimit);
    p.loose.length = 0;
    if (!due.length) break;
    const t = Math.min(endLimit, due[due.length - 1].t + 5_000);
    await run(t, due.map((l) => l.op), false);
  }

  if (rejected.length) {
    console.warn(`[demo] ${rejected.length} simulated ops were rejected: ${rejected.slice(0, 5).map((r) => `${r.code}: ${r.reason}`).join(" | ")}`);
  }
  const finalTrip = (last as TripState | null)?.trip ?? trip;
  return {
    trip: finalTrip,
    stats: { batches: count, ops, applied, rejected, photos: p.uploads.length - failed.size, photo_failures: failed.size },
  };
}

function validCode(raw: string): string {
  const code = normalizeCode(raw);
  if (!code) throw new DemoError("Trip codes are 3-64 letters and digits.", 400, "invalid");
  return code;
}

/**
 * Create a demo trip and (unless mode "setup") simulate its round. Throws DemoError(409) when a
 * fixed `code` is already taken (use resetDemoTrip for an existing demo).
 */
export async function createDemoTrip(db: Db, opts: DemoOptions): Promise<DemoResult> {
  const started = Date.now();
  const mode = opts.mode;
  if (!isDemoMode(mode)) throw new DemoError(`Demo mode must be one of: ${DEMO_MODES.join(", ")}.`, 400, "invalid");
  const nowMs = (opts.now ?? new Date()).getTime();
  const fixed = opts.code === undefined ? null : validCode(opts.code);

  let trip: Trip | null = null;
  let code = fixed ?? newDemoCode();
  for (let attempt = 0; !trip; attempt++) {
    try {
      // Created before any simulated setup op (setup runs 70 minutes before the first tee).
      trip = await insertDemoTrip(db, code, nowMs - 7 * 60 * MIN);
    } catch (e) {
      if (pgErrorCode(e) !== UNIQUE_VIOLATION) throw e;
      if (fixed) throw new DemoError(`Trip code "${fixed}" is taken.`, 409, "taken");
      if (attempt >= 4) throw e;
      code = newDemoCode();
    }
  }

  const ctx: PlanCtx = {
    code,
    tripId: trip.id,
    mode,
    nowMs,
    rng: new Rng(opts.seed ?? DEFAULT_DEMO_SEED),
    holes: demoCourseLayout(),
    photos: opts.photos !== false,
  };
  const sim = await simulate(db, trip, ctx);
  return { trip: sim.trip, code, url: `/t/${code}`, mode, stats: { ...sim.stats, ms: Date.now() - started } };
}

/** One reset per code at a time in this process (a double tap must not race itself). */
const G = globalThis as typeof globalThis & { __scrambleDemoLocks?: Set<string> };
const resetting: Set<string> = (G.__scrambleDemoLocks ??= new Set());

/**
 * Wipe a demo trip (cascade) and recreate it with the same code. Only for is_demo trips:
 * DemoError 404 when there's no such trip, 403 when it's a real trip, 409 while already resetting.
 */
export async function resetDemoTrip(db: Db, rawCode: string, opts: Omit<DemoOptions, "code"> = { mode: "partial" }): Promise<DemoResult> {
  const code = validCode(rawCode);
  if (!isDemoMode(opts.mode)) throw new DemoError(`Demo mode must be one of: ${DEMO_MODES.join(", ")}.`, 400, "invalid");
  if (resetting.has(code)) throw new DemoError("That demo is already being reset. Give it a sec.", 409, "busy");
  resetting.add(code);
  try {
    const found = await findTripByCode(db, code);
    if (!found) throw new DemoError("No demo trip with that code.", 404, "not_found");
    if (!found.trip.is_demo) throw new DemoError("That's a real trip. Demo tools don't touch real trips.", 403, "not_demo");
    await deleteTrip(db, found.trip.id);
    return await createDemoTrip(db, { ...opts, code });
  } finally {
    resetting.delete(code);
  }
}

/** Delete demo trips created more than `maxAgeMs` ago (default 7 days). Real trips are never touched. */
export async function pruneDemoTrips(db: Db, opts: { maxAgeMs?: number; limit?: number; now?: Date } = {}): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.maxAgeMs ?? 7 * 24 * 60 * MIN));
  const rows = await db.query<{ id: string }>(
    `delete from trips where id in (
       select id from trips where is_demo = true and created_at < $1 order by created_at limit $2
     ) and is_demo = true returning id`,
    [cutoff.toISOString(), Math.max(1, Math.min(opts.limit ?? 20, 200))],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Light per-process rate limit for POST /api/demo (a demo round is ~100 transactions)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const RATE_PER_CLIENT = 6;
const RATE_GLOBAL = 40;

const RG = globalThis as typeof globalThis & { __scrambleDemoRate?: Map<string, number[]> };
const hits: Map<string, number[]> = (RG.__scrambleDemoRate ??= new Map());

/** Seconds to wait before another demo create/reset from this client, or 0 (and the hit is counted). */
export function demoRateLimit(client: string, now: number = Date.now()): number {
  const recent = (key: string) => (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  const mine = recent(`c:${client}`);
  const all = recent("*");
  const limited = mine.length >= RATE_PER_CLIENT ? mine : all.length >= RATE_GLOBAL ? all : null;
  if (limited) return Math.max(1, Math.ceil((limited[0] + RATE_WINDOW_MS - now) / 1000));
  hits.set(`c:${client}`, [...mine, now]);
  hits.set("*", [...all, now]);
  if (hits.size > 2000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return 0;
}

/** Tests only. */
export function resetDemoRateLimit(): void {
  hits.clear();
}

// ---------------------------------------------------------------------------
// Embedded photos: 320x320 JPEGs drawn on a canvas for the demo (no real people, no real places).
// ---------------------------------------------------------------------------

const DEMO_PHOTOS: Record<DemoPhotoAsset, string> = {
  beer:
    "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",
  shotgun:
    "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",
  ctp:
    "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",
  ld:
    "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" +
    "rtRE7G/H1b07qWOjMqVjUXzWLIitE/JUEWr9J6a50+NJhxPVKuGL7VeryQ6HQ8n9p/7nTvxSf/U9noP+quN+J/8AqU4/rLqDH190EeFFLsx9yq9yVd16Pce1" +
    "0l1NpGm9PwYuZl+HMxz1VvhvWrcqp5olAZ8rrlMHXpsHKxE8COTYsrXeaJ669J6HVuhR63pjpofPKibvhVq+T0717z59qixatr2oTYrt7Hq58bqVL7ehTq+l" +
    "esMDH0aPF1TJWKaBdjVVjnbm+jsi9u3uJqb/ABx8UkuqNwdMjbT1kRnknl6kX81Pr7MVIcBMXHd4SMi8ON1XtpKRTgMDM6exOsJ9STOT6KrFfEngv8pHeSpW" +
    "32/FPUZ+rOqmZ6YmLoWbKjnPVZHx7419SJ6FrzX8hJISSPX0ToxujanHmxahI9WoqOYsaIjkVO3f3+4vr3TvpvT75mNuTFd4qfh7O/Lz9xxmU7XsbHfMusZT" +
    "kb5qjch9/M63T+sdGn0eGPUsvbO6LZMxYnra1S+aJXn394ll9E5S+nz5X5WYv0mCF+/Ha3fLEi2ldnKqdu3c9fD651rGajXyxZLU/is8/ilFdK63g9P6pmeK" +
    "sk2PJ9hkkbfQirSqi0vY6v6y6OzV8aRMFXr3WSHa732nmWTFkx6PTGtLrumLlPg8F7XrG5EW0VURFtPifOep9PVvVmbiYcKvVztzY40tfNqOWk96nb5XWWha" +
    "bibMJzZlalMhgjVrfjSIiHD4WryQdTRa1nxPcj3ueqMTuioqUl+oD90/qzWtLakDcjeyP7KRzN3bePX+Z23SPVM2vSzY+TjNjkiZv3x3tXzqqXt8T8+vulNW" +
    "p+UmOsn/AKiH7Se+v1MrepOmdKhc3FlgYnfZjxfeX3JXxA8H9oMLMfXdPyokRJJEp1enaqV869x+nm5mfN1Nrrcx0ax4sFJG1fUnn8VU9I5vNZrl81m4GLJj" +
    "ilj2yxtf6tyWZTA9253B5R4xou0rDct+FXscpUWnYkTrbCir63eZtA12v1rty+plijmZskYjm+pTX+rcP+AnxU2gSWz0S2en5DjxozwmxtSP0tryJ+qsFf8A" +
    "w7fiptRt2t5Uonap2rFj4sGMipBG1l969J+z40OQlTRNfXa07GQDb7Tb7aC6LgKv7lU9j1MkeFi4iXDC1Hf3l81+Km2YHu3O4L2t/q9uV/rHLEyZiskajmr6" +
    "FNf6tw/4CfFTaAls9LLZ6QyGOOPw2MajP7tGBdNw1X9w34qbQG02xjx8LHj3NZE1Gu+96bP36qwf+Xb8VNqNu1vKlDtfqdr9YsfFgxkVII2svvXpMoBn2m6E" +
    "SqmxUVLvypSzA9253AGm/TcN62sKIv8AhVU+R+N0vDb5+Dftcqm2Dfa/Wu3L6lsUbGbGsa1q+hE8jXXTcNV/cN+Km0CbYm2JxcSGFy+FGjb716T9k03Dler3" +
    "wNVy+ar5pZsRt2t5Uonana+2l9U4N39HT/qX+ZlhwMWCRHxQta5Oy96NgDtfp2v0VEc1UciKi+SopoyaZgol/R22vKm8YHu3O4Etnols9NZuFitYrUgZS97S" +
    "zE7SsNy34Vexym4DXa/V7X61YtOxInW2FFX1u8zZc1r27XNRyepUs/QS232ltvtrfVWHK7zhRPwqqGRmj4LHX4N/icqobkbdreVKHbl9Xvy+vxrWsajWNRrU" +
    "7IiUiH6AZZTI6m8qYCnu3O4JKAAAFxt3O4Qgzxt2t5UCgAQAABMjqbypgKe7c7gkoAAAXG3c7hCDPG3a3lQKABAAAEyOpvKmAp7tzuCSgAABcbdzuEIM8bdr" +
    "eVAoAEAAATI6m8qYCnu3O4JKAAAFxt3O4Qgzxt2t5UCgAQAAB//Z",
  sunset:
    "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",
  snowman:
    "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",
};
