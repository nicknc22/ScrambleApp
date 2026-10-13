// Typed payloads for every FeedEventType (FeedEvent.payload is stored as jsonb).
// Producers: src/lib/events/derive.ts (automatic events), the reducer (posts), the AI routes
// (ai_judge, roast). Consumer: src/lib/events/templates.ts, which reads every field defensively
// because rows come back from the database and may predate a field.
import type { ContestKind, DrinkType, FeedEvent, FeedEventType, ISODate, MulliganSource, UUID } from "../types";
import type { DriveLevel } from "../engine/types";

/** Player post: everything lives in FeedEvent.text / photo_path. */
export type PostPayload = Record<string, never>;

export interface RoundStartedPayload {
  team_count: number;
  player_count: number;
}

export interface TeeOffPayload {
  /** First hole the team opened (normally 1). */
  hole: number;
}

export type GrossNotableKind = "albatross" | "eagle" | "birdie" | "double" | "triple_plus";
/**
 * Gross kinds (from strokes vs par), net_zero (hole net <= 0 after drink credit), and
 * last_at_turn (a team finished hole 9 in last place; exists so the "last at the turn" roast
 * has an event to hang off).
 */
export type NotableKind = GrossNotableKind | "net_zero" | "last_at_turn";

export interface ScoreNotablePayload {
  kind: NotableKind;
  hole: number;
  par: number;
  strokes: number;
  /** strokes - par */
  to_par: number;
  /** Drink credit on the hole when posted. */
  credit: number;
  /** strokes - credit */
  net: number;
  /** strokes === 1 */
  ace: boolean;
  /** last_at_turn only: the team's leaderboard position label ("4", "T3"). */
  pos_label?: string;
  /** last_at_turn only: the team's round net to par. */
  net_to_par?: number;
}

export interface ScoreEditPayload {
  hole: number;
  from: number;
  to: number;
  par: number;
  /** hole_scores.edit_count after this edit. */
  edit_count: number;
}

/** Batched plain drinks: same team + hole within 60 s of the batch's first drink. */
export interface DrinksPayload {
  hole: number;
  /** Parallel arrays, one entry per drink, in logging order. */
  drink_ids: UUID[];
  player_ids: UUID[];
  logged_by_ids: (UUID | null)[];
  count: number;
}

/** shotgun / shot: one event per drink. */
export interface SingleDrinkPayload {
  drink_id: UUID;
  drink_type: DrinkType;
  hole: number;
  player_id: UUID;
  logged_by: UUID | null;
  /** Drink value when logged (2 = it was also a ghost beer). */
  value: number;
  /** Shotguns and shots always bank a mulligan for the team. */
  banked_mulligan: boolean;
  /** Team's available mulligans right after this drink. */
  mulligans_available: number;
}
export type ShotgunPayload = SingleDrinkPayload;
export type ShotPayload = SingleDrinkPayload;

export interface GhostBeerPayload {
  drink_id: UUID;
  drink_type: DrinkType;
  hole: number;
  player_id: UUID;
  logged_by: UUID | null;
  /** Drink value (> 1). */
  value: number;
  /** 1-based position among the team's active drinks. */
  seq: number;
  team_size: number;
  base_team_size: number;
  /** Team's ghost beers so far (including this one). */
  ghost_count: number;
}

export interface MulliganUsedPayload {
  mulligan_id: UUID;
  hole: number;
  source: MulliganSource;
  used_by: UUID | null;
  /** Earned mulligans left in the team bank after this use. */
  available: number;
}

export interface GroomMulliganPayload {
  mulligan_id: UUID;
  hole: number;
  source: "groom";
  used_by: UUID | null;
  groom_id: UUID | null;
}

export interface LeadChangePayload {
  leader_team_ids: UUID[];
  previous_leader_team_ids: UUID[];
  /** Leaders' round net to par. */
  net_to_par: number;
  /** Leaders' holes played (first leader). */
  thru: number;
}

export interface ContestEntryPayload {
  entry_id: UUID;
  hole: number;
  contest_type: ContestKind;
  /** Official distance at submit time (ctp feet, ld whole yards). */
  distance: number;
  unit: "ft" | "yd";
  /** 1-based rank among valid entries (ties share), null when not valid. */
  rank: number | null;
  valid: boolean;
  status: "ok" | "flagged" | "overridden";
  flag_reason: string | null;
  /** e.g. "Needs commissioner review: GPS was weak". */
  invalid_reason: string | null;
  /** The player had an earlier entry on this hole that this one replaced. */
  replaced: boolean;
  /** Valid entries on the hole after this one. */
  valid_count: number;
}

export interface ContestLeadPayload {
  hole: number;
  contest_type: ContestKind;
  leader_ids: UUID[];
  previous_leader_ids: UUID[];
  /** Best valid distance. */
  distance: number;
  unit: "ft" | "yd";
}

/** Written by the AI judge route (not by derive). Templates read it leniently. */
export interface AiJudgePayload {
  entry_id: UUID;
  hole: number;
  claimed_ft: number;
  estimate_ft: number;
  confidence: "low" | "medium" | "high";
  suspicious: boolean;
  roast: string | null;
}

export interface DriveWarningPayload {
  nine: 1 | 2;
  level: Extract<DriveLevel, "hard" | "impossible">;
  remaining: number;
  needing: UUID[];
}

export interface DriveMissPayload {
  nine: 1 | 2;
  missed: UUID[];
  /** Always true: drive-minimum misses are flagged for the commissioner (no automatic penalty). */
  commissioner_flag: boolean;
}

export interface CommissionerOverridePayload {
  op_type: string;
  /** Human summary, e.g. "moved a drink from hole 6 to hole 7". Rendered after the actor's name. */
  summary: string;
}

export interface RoundCompletePayload {
  gross: number;
  net: number;
  net_to_par: number;
  gross_to_par: number;
  pos_label: string;
  thru: number;
  drinks: number;
  ghost_beers: number;
  /** Last place among started teams when they finished. */
  last: boolean;
}

export interface FinalStandingSnapshot {
  team_id: UUID;
  pos: number;
  pos_label: string;
  thru: number;
  gross: number;
  net: number;
  net_to_par: number;
  drinks: number;
}

export interface FinalResultsPayload {
  finalized_at: ISODate;
  standings: FinalStandingSnapshot[];
  champion_team_ids: UUID[];
  champion_player_ids: UUID[];
}

/** AI roast (written by the roast route). The roast text is FeedEvent.text. */
export interface RoastPayload {
  trigger_event_id: UUID;
  trigger_type?: FeedEventType;
  /** Hole the roast is about (used for the per-team roast gap). */
  hole?: number | null;
}

export interface FeedPayloadMap {
  post: PostPayload;
  round_started: RoundStartedPayload;
  tee_off: TeeOffPayload;
  score_notable: ScoreNotablePayload;
  score_edit: ScoreEditPayload;
  drinks: DrinksPayload;
  shotgun: ShotgunPayload;
  shot: ShotPayload;
  ghost_beer: GhostBeerPayload;
  mulligan_used: MulliganUsedPayload;
  groom_mulligan: GroomMulliganPayload;
  lead_change: LeadChangePayload;
  contest_entry: ContestEntryPayload;
  contest_lead: ContestLeadPayload;
  ai_judge: AiJudgePayload;
  drive_warning: DriveWarningPayload;
  drive_miss: DriveMissPayload;
  commissioner_override: CommissionerOverridePayload;
  round_complete: RoundCompletePayload;
  final_results: FinalResultsPayload;
  roast: RoastPayload;
}

// Compile-time check: every FeedEventType has a payload type and nothing extra.
type _MissingPayload = Exclude<FeedEventType, keyof FeedPayloadMap>;
type _ExtraPayload = Exclude<keyof FeedPayloadMap, FeedEventType>;
const _payloadMapIsComplete: [_MissingPayload, _ExtraPayload] extends [never, never] ? true : false = true;
void _payloadMapIsComplete;

export type FeedPayload<T extends FeedEventType> = FeedPayloadMap[T];

/**
 * Typed view of an event's payload. Trusts the producer; consumers that read rows from the
 * database should still treat fields as possibly missing (templates do).
 */
export function payloadOf<T extends FeedEventType>(ev: FeedEvent & { type: T }): Partial<FeedPayloadMap[T]> {
  return ev.payload as Partial<FeedPayloadMap[T]>;
}
