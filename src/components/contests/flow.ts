// Pure flow logic for the two contest entry sheets (no React, no DOM). Unit tested in
// tests/ui/contests-flow.test.ts.
//
// Long drive: a small GPS state machine (measure -> weak/error -> retry -> after 3 failed tries
// the best weak reading may go to the commissioner), then distance/rank/photo/submit.
// Closest to pin: a 3-step wizard (photo -> distance -> marker), then submit.
import type { ContestEntry, Hole, Player, TeamRoundState, TripSettings, TripStatus, UUID } from "@/lib/types";
import type { ContestHoleSummary, Derived, RankPreview } from "@/lib/engine/types";
import type { OpInput } from "@/lib/ops";
import { haversineYards, type LatLng } from "@/lib/engine/geo";
import { rankPreview } from "@/lib/engine/contests";
import type { GeoErrorCode, GeoReading } from "@/lib/client/geo";
import { feetInchesToFeet } from "./geometry";

// ---------------------------------------------------------------------------
// GPS state machine
// ---------------------------------------------------------------------------

/** Failed measure attempts before a weak reading may be submitted for commissioner review. */
export const MAX_GPS_TRIES = 3;

export type GpsPhase = "idle" | "measuring" | "weak" | "error" | "fixed";

export interface GpsFlow {
  phase: GpsPhase;
  /** Measure attempts started. */
  attempts: number;
  /** Attempts that ended weak, or with no fix at all (permission problems don't count). */
  failures: number;
  /** Most accurate reading across every attempt. */
  best: GeoReading | null;
  /** Best reading of the attempt in progress (live "±8 m" display). */
  live: GeoReading | null;
  error: GeoErrorCode | null;
  /** The reading the drive is measured from once phase is "fixed". */
  fix: GeoReading | null;
  /** The fix is a weak reading accepted after MAX_GPS_TRIES failures (goes to the commissioner). */
  lowAccuracy: boolean;
}

export type GpsEvent =
  | { type: "start" }
  | { type: "progress"; reading: GeoReading }
  | { type: "result"; reading: GeoReading; limitM: number }
  | { type: "error"; code: GeoErrorCode }
  | { type: "accept_weak" }
  | { type: "reset" };

export const GPS_INITIAL: GpsFlow = {
  phase: "idle",
  attempts: 0,
  failures: 0,
  best: null,
  live: null,
  error: null,
  fix: null,
  lowAccuracy: false,
};

function moreAccurate(a: GeoReading | null, b: GeoReading | null): GeoReading | null {
  if (!a) return b;
  if (!b) return a;
  return b.accuracy < a.accuracy ? b : a;
}

/** A reading is good enough when its accuracy radius is at most the limit (12 m by default). */
export function isAccurate(reading: Pick<GeoReading, "accuracy">, limitM: number): boolean {
  return Number.isFinite(reading.accuracy) && reading.accuracy <= limitM;
}

export function gpsReducer(s: GpsFlow, ev: GpsEvent): GpsFlow {
  switch (ev.type) {
    case "start":
      if (s.phase === "measuring") return s;
      return { ...s, phase: "measuring", attempts: s.attempts + 1, live: null, error: null, fix: null, lowAccuracy: false };
    case "progress":
      if (s.phase !== "measuring") return s;
      return { ...s, live: moreAccurate(s.live, ev.reading) };
    case "result": {
      if (s.phase !== "measuring") return s;
      const best = moreAccurate(s.best, ev.reading);
      if (isAccurate(ev.reading, ev.limitM)) {
        return { ...s, phase: "fixed", best, live: ev.reading, fix: ev.reading, lowAccuracy: false, error: null };
      }
      return { ...s, phase: "weak", best, live: ev.reading, failures: s.failures + 1, error: null };
    }
    case "error":
      if (s.phase !== "measuring") return s;
      return {
        ...s,
        phase: "error",
        error: ev.code,
        live: null,
        // Blocked location is a settings problem, not weak GPS: it never unlocks the review path.
        failures: ev.code === "permission_denied" || ev.code === "unsupported" ? s.failures : s.failures + 1,
      };
    case "accept_weak":
      if (!canAcceptWeak(s)) return s;
      return { ...s, phase: "fixed", fix: s.best, lowAccuracy: true };
    case "reset":
      return GPS_INITIAL;
  }
}

/** After MAX_GPS_TRIES failed tries with at least one reading, offer "Submit for commissioner review". */
export function canAcceptWeak(s: GpsFlow): boolean {
  return (s.phase === "weak" || s.phase === "error") && s.failures >= MAX_GPS_TRIES && s.best !== null && s.error !== "permission_denied";
}

/** Tries left before the review fallback shows up. */
export function triesLeft(s: GpsFlow): number {
  return Math.max(0, MAX_GPS_TRIES - s.failures);
}

// ---------------------------------------------------------------------------
// Long drive
// ---------------------------------------------------------------------------

export function teePoint(hole: Pick<Hole, "tee_lat" | "tee_lng"> | null | undefined): LatLng | null {
  if (!hole || hole.tee_lat === null || hole.tee_lng === null) return null;
  if (!Number.isFinite(hole.tee_lat) || !Number.isFinite(hole.tee_lng)) return null;
  return { lat: hole.tee_lat, lng: hole.tee_lng };
}

/** Yards from the hole's tee point to the ball (rounded), null without a tee point. */
export function ldDistanceYards(hole: Pick<Hole, "tee_lat" | "tee_lng"> | null | undefined, ball: LatLng | null): number | null {
  const tee = teePoint(hole);
  if (!tee || !ball) return null;
  return haversineYards(tee, ball);
}

export type LdRange = "ok" | "short" | "long";

/** Outside settings.ld_min_yd..ld_max_yd goes to the commissioner instead of the board. */
export function ldRange(yards: number, settings: Pick<TripSettings, "ld_min_yd" | "ld_max_yd">): LdRange {
  if (yards < settings.ld_min_yd) return "short";
  if (yards > settings.ld_max_yd) return "long";
  return "ok";
}

/** Reducer's hard limit for a long drive (anything beyond is rejected outright). */
export const LD_HARD_MAX_YD = 700;

export interface LdVerdict {
  /** Will land as "flagged" (commissioner review) rather than on the board. */
  review: boolean;
  /** Can't be submitted at all (beyond the reducer's 700 yd limit). */
  blocked: boolean;
  /** Plain-language reason, null when it counts straight away. */
  reason: string | null;
}

export function ldVerdict(yards: number, lowAccuracy: boolean, settings: Pick<TripSettings, "ld_min_yd" | "ld_max_yd">): LdVerdict {
  if (!Number.isFinite(yards) || yards > LD_HARD_MAX_YD) {
    return {
      blocked: true,
      review: false,
      reason: `${Number.isFinite(yards) ? yards : "That"} yd? You're on the wrong hole (or the wrong planet). Check the tee point or move closer to your ball.`,
    };
  }
  const range = ldRange(yards, settings);
  if (range !== "ok") {
    return {
      blocked: false,
      review: true,
      reason:
        range === "short"
          ? `Under ${settings.ld_min_yd} yd goes to the commissioner instead of the board. Topped it? It happens.`
          : `Over ${settings.ld_max_yd} yd goes to the commissioner instead of the board. Bryson, is that you?`,
    };
  }
  if (lowAccuracy) return { blocked: false, review: true, reason: "Weak GPS: this one goes to the commissioner for review before it counts." };
  return { blocked: false, review: false, reason: null };
}

/** Rank preview for a distance, or null when there's no summary for the hole. */
export function previewRank(summary: ContestHoleSummary | undefined, playerId: UUID | null, distance: number): RankPreview | null {
  if (!summary || !playerId) return null;
  return rankPreview(summary, playerId, distance);
}

// ---------------------------------------------------------------------------
// Closest to pin wizard
// ---------------------------------------------------------------------------

export type CtpStep = "photo" | "distance" | "where";
export const CTP_STEPS: readonly CtpStep[] = ["photo", "distance", "where"];
/** Reducer limit for a closest-to-pin distance. */
export const CTP_MAX_FT = 200;

export interface CtpDraft {
  step: CtpStep;
  hasPhoto: boolean;
  /** Explicitly chose to go without a photo. */
  noPhoto: boolean;
  feet: number;
  inches: number;
  angle: number;
}

export function clampFeet(n: number): number {
  return Number.isFinite(n) ? Math.min(CTP_MAX_FT, Math.max(0, Math.trunc(n))) : 0;
}

export function clampInches(n: number): number {
  return Number.isFinite(n) ? Math.min(11, Math.max(0, Math.trunc(n))) : 0;
}

/** The ctp distance_value (decimal feet) the draft submits. */
export function ctpDistance(d: Pick<CtpDraft, "feet" | "inches">): number {
  return feetInchesToFeet(clampFeet(d.feet), clampInches(d.inches));
}

/** Can the wizard move past this step? */
export function ctpCanAdvance(d: CtpDraft): boolean {
  switch (d.step) {
    case "photo":
      return d.hasPhoto || d.noPhoto;
    case "distance":
      return ctpDistance(d) <= CTP_MAX_FT;
    case "where":
      return true;
  }
}

export function ctpNextStep(step: CtpStep): CtpStep | null {
  const i = CTP_STEPS.indexOf(step);
  return i >= 0 && i < CTP_STEPS.length - 1 ? CTP_STEPS[i + 1] : null;
}

export function ctpPrevStep(step: CtpStep): CtpStep | null {
  const i = CTP_STEPS.indexOf(step);
  return i > 0 ? CTP_STEPS[i - 1] : null;
}

// ---------------------------------------------------------------------------
// Who can enter, and for whom
// ---------------------------------------------------------------------------

/**
 * "Measuring for" choices: my team's members (me first). Not on a team (or not joined):
 * every player on a team, in team order.
 */
export function entrantChoices(d: Pick<Derived, "teamOfPlayer" | "membersOfTeam" | "teams">, meId: UUID | null): Player[] {
  const myTeam = meId ? d.teamOfPlayer[meId] : undefined;
  if (myTeam) {
    const members = d.membersOfTeam[myTeam] ?? [];
    const me = members.find((p) => p.id === meId);
    return me ? [me, ...members.filter((p) => p.id !== meId)] : members;
  }
  return d.teams.flatMap((t) => d.membersOfTeam[t.id] ?? []);
}

/** Default "measuring for": me if I can enter, else the first choice. */
export function defaultEntrant(choices: readonly Player[], meId: UUID | null): UUID | null {
  if (meId && choices.some((p) => p.id === meId)) return meId;
  return choices[0]?.id ?? null;
}

export interface EntryAccess {
  /** Show an enabled entry button. */
  can: boolean;
  /** Why not (shown under a disabled button), null to hide the button entirely. */
  reason: string | null;
}

/** Has this team reached the hole (teed off on it, or beyond, or finished)? */
export function teamReachedHole(rs: Pick<TeamRoundState, "open_hole" | "started_holes" | "status"> | null | undefined, hole: number): boolean {
  if (!rs) return false;
  if (rs.status === "complete") return true;
  if (rs.open_hole !== null && rs.open_hole >= hole) return true;
  return rs.started_holes.includes(hole);
}

/**
 * Entry button state on the Contests tab for my team. Long drive: only on the team's current
 * hole while playing (you measure standing at your ball). Closest to pin: any hole the team has
 * reached (edits allowed).
 */
export function entryAccess(args: {
  type: "ctp" | "ld";
  hole: number;
  tripStatus: TripStatus;
  rs: Pick<TeamRoundState, "open_hole" | "started_holes" | "status"> | null | undefined;
  onTeam: boolean;
}): EntryAccess {
  const { type, hole, tripStatus, rs, onTeam } = args;
  if (!onTeam) return { can: false, reason: null };
  if (tripStatus === "setup") return { can: false, reason: "Opens when the round starts." };
  if (tripStatus === "final") return { can: false, reason: null };
  if (type === "ctp") {
    if (teamReachedHole(rs, hole)) return { can: true, reason: null };
    return { can: false, reason: `Unlocks when your group tees off hole ${hole}.` };
  }
  if (rs && rs.status === "playing" && rs.open_hole === hole) return { can: true, reason: null };
  if (teamReachedHole(rs, hole)) return { can: false, reason: "Your group's past this hole. Measuring is closed." };
  return { can: false, reason: `Measure on hole ${hole}, standing at your ball.` };
}

// ---------------------------------------------------------------------------
// Submit + undo
// ---------------------------------------------------------------------------

export interface LdSubmitArgs {
  entryId: UUID;
  hole: number;
  playerId: UUID;
  yards: number;
  fix: Pick<GeoReading, "lat" | "lng" | "accuracy">;
  lowAccuracy: boolean;
  photoPath: string;
}

export function ldSubmitInput(a: LdSubmitArgs): OpInput {
  return {
    type: "contest.submit",
    entry_id: a.entryId,
    hole: a.hole,
    player_id: a.playerId,
    contest_type: "ld",
    distance_value: a.yards,
    angle_deg: null,
    lat: a.fix.lat,
    lng: a.fix.lng,
    gps_accuracy_m: Number.isFinite(a.fix.accuracy) ? Math.round(a.fix.accuracy * 10) / 10 : null,
    low_accuracy: a.lowAccuracy,
    photo_path: a.photoPath,
  };
}

export interface CtpSubmitArgs {
  entryId: UUID;
  hole: number;
  playerId: UUID;
  feet: number;
  inches: number;
  angle: number;
  photoPath: string | null;
}

export function ctpSubmitInput(a: CtpSubmitArgs): OpInput {
  return {
    type: "contest.submit",
    entry_id: a.entryId,
    hole: a.hole,
    player_id: a.playerId,
    contest_type: "ctp",
    distance_value: ctpDistance(a),
    angle_deg: Math.round(a.angle),
    lat: null,
    lng: null,
    gps_accuracy_m: null,
    low_accuracy: false,
    photo_path: a.photoPath,
  };
}

/**
 * Undo after the submit already synced: delete the new entry and, if it replaced one, put the
 * previous entry's values back under a fresh id (statuses re-derive; a commissioner ruling on
 * the old entry doesn't come back).
 */
export function undoInputs(newEntryId: UUID, previous: ContestEntry | null, restoreId: UUID): OpInput[] {
  const ops: OpInput[] = [{ type: "contest.delete", entry_id: newEntryId }];
  if (previous && previous.deleted_at === null) {
    ops.push({
      type: "contest.submit",
      entry_id: restoreId,
      hole: previous.hole,
      player_id: previous.player_id,
      contest_type: previous.type,
      distance_value: previous.distance_value,
      angle_deg: previous.angle_deg,
      lat: previous.lat,
      lng: previous.lng,
      gps_accuracy_m: previous.gps_accuracy_m,
      low_accuracy: previous.low_accuracy,
      photo_path: previous.photo_path,
    });
  }
  return ops;
}
