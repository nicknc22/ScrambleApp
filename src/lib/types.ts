// Raw data model. These are the rows stored in Postgres (snake_case columns) and
// shipped to the client as-is. Raw rows are the source of truth; everything else
// (drink values, nets, standings, pots, awards) is derived by src/lib/engine.

export type UUID = string;
/** ISO-8601 timestamp string, e.g. "2026-10-24T16:50:00.000Z". */
export type ISODate = string;

export type TripStatus = "setup" | "live" | "final";
export type TeeSet = "advanced" | "membership" | "forward";
export type ContestKind = "ctp" | "ld";
export type HoleContest = ContestKind | "none";
export type DrinkType = "drink" | "shotgun" | "shot";
export type RoundStatus = "not_started" | "playing" | "complete";
export type MulliganSource = "earned" | "groom";
export type EntryStatus = "ok" | "flagged" | "overridden";
export type AiConfidence = "low" | "medium" | "high";
export type ReactionKind = "fire" | "lol" | "beer" | "dead" | "goat" | "clown";

export const REACTION_KINDS: readonly ReactionKind[] = ["fire", "lol", "beer", "dead", "goat", "clown"];
export const REACTION_EMOJI: Record<ReactionKind, string> = {
  fire: "🔥",
  lol: "😂",
  beer: "🍺",
  dead: "💀",
  goat: "🐐",
  clown: "🤡",
};

export interface TripSettings {
  /** Which tee set's yardage to display. Display only. */
  tee_set: TeeSet;
  course_name: string;
  roasts_enabled: boolean;
  /** At most one roast per team every N holes (big events exempt). */
  roast_min_hole_gap: number;
  /** Hard cap on AI roasts per round. */
  roast_cap: number;
  /** Long drive: GPS accuracy limit in meters. */
  ld_accuracy_limit_m: number;
  /** Long drive sanity range in yards; outside = flagged for commissioner. */
  ld_min_yd: number;
  ld_max_yd: number;
  /** AI judge: claimed < ratio * estimate (and confidence != low) => suspicious. */
  judge_suspicious_ratio: number;
  /** Push throttle per player, seconds. */
  push_throttle_sec: number;
  /** Team match ante per player, in cents. */
  team_match_ante_cents: number;
  /** Contest ante per player per contest hole, in cents. */
  contest_ante_cents: number;
  /** Team match payout by place, in percent, must sum to 100. [100] = winner take all, [70, 30] = 1st/2nd. */
  team_match_payout: number[];
  /** null = no cap. */
  drink_cap: number | null;
}

export const DEFAULT_SETTINGS: TripSettings = {
  tee_set: "membership",
  course_name: "Jack Frost National",
  roasts_enabled: true,
  roast_min_hole_gap: 3,
  roast_cap: 40,
  ld_accuracy_limit_m: 12,
  ld_min_yd: 100,
  ld_max_yd: 400,
  judge_suspicious_ratio: 0.5,
  push_throttle_sec: 120,
  team_match_ante_cents: 0,
  contest_ante_cents: 0,
  team_match_payout: [100],
  drink_cap: null,
};

export interface Trip {
  id: UUID;
  /** Unguessable join code used in /t/<code>. 10 chars, [a-z0-9] minus lookalikes. */
  code: string;
  name: string;
  app_name: string;
  status: TripStatus;
  /** Ghost beer base team size (credit = floor(base * d / n)). Default 4. */
  base_team_size: number;
  settings: TripSettings;
  is_demo: boolean;
  created_at: ISODate;
  started_at: ISODate | null;
  finalized_at: ISODate | null;
  updated_at: ISODate;
}

export interface Player {
  id: UUID;
  trip_id: UUID;
  name: string;
  nickname: string | null;
  venmo_handle: string | null;
  is_groom: boolean;
  muted_push: boolean;
  sort_order: number;
  created_at: ISODate;
  deleted_at: ISODate | null;
}

export interface Team {
  id: UUID;
  trip_id: UUID;
  name: string;
  /** Local wall-clock tee time "HH:MM" (24h), display only. */
  tee_time: string | null;
  sort_order: number;
  created_at: ISODate;
  deleted_at: ISODate | null;
}

/** One team per player. Removing a player from a team hard-deletes the row. */
export interface TeamMember {
  id: UUID;
  trip_id: UUID;
  team_id: UUID;
  player_id: UUID;
  created_at: ISODate;
}

export interface Hole {
  id: UUID;
  trip_id: UUID;
  /** 1..18 */
  number: number;
  par: number;
  stroke_index: number;
  yardage: Record<TeeSet, number>;
  tee_lat: number | null;
  tee_lng: number | null;
  green_lat: number | null;
  green_lng: number | null;
  contest: HoleContest;
  updated_at: ISODate;
}

/**
 * Drives the drink window. open_hole only moves forward (except commissioner fixes).
 * The window for open_hole is open while status === "playing".
 */
export interface TeamRoundState {
  id: UUID;
  trip_id: UUID;
  team_id: UUID;
  /** null until the team taps "On the tee" for hole 1 (or enters data for hole 1). */
  open_hole: number | null;
  started_holes: number[];
  /** hole number (as string key) -> client time the window opened. */
  hole_opened_at: Record<string, ISODate>;
  status: RoundStatus;
  completed_at: ISODate | null;
  updated_at: ISODate;
}

/**
 * One row per (team_id, hole). Strokes and tee shot are last-write-wins
 * independently, ordered by the client timestamp of the op that set them.
 */
export interface HoleScore {
  id: UUID;
  trip_id: UUID;
  team_id: UUID;
  hole: number;
  strokes: number | null;
  tee_shot_player_id: UUID | null;
  /** Client time of the op that last set strokes (LWW key). */
  strokes_at: ISODate | null;
  /** Client time of the op that last set the tee shot (LWW key). */
  tee_shot_at: ISODate | null;
  /** Number of times strokes changed after first being set. */
  edit_count: number;
  updated_by: UUID | null;
  updated_at: ISODate;
}

/** Append-only. Value (1 or 2 for ghost beers) is derived, never stored. */
export interface Drink {
  id: UUID;
  trip_id: UUID;
  team_id: UUID;
  player_id: UUID;
  /** Hole whose window was open when logged (client-stamped), or moved by the commissioner. */
  hole: number;
  type: DrinkType;
  photo_path: string | null;
  logged_by: UUID | null;
  /** Client time it was logged. Ghost-beer order is by (logged_at, id). */
  logged_at: ISODate;
  created_at: ISODate;
  deleted_at: ISODate | null;
  deleted_by: UUID | null;
  /** Set when the commissioner moves a drink: the hole it was originally logged on. */
  moved_from_hole: number | null;
}

/**
 * One row per mulligan USE. Earned mulligans are derived from the team's active
 * shotgun/shot drinks (so deleting the drink voids the mulligan automatically).
 */
export interface Mulligan {
  id: UUID;
  trip_id: UUID;
  team_id: UUID;
  source: MulliganSource;
  used_on_hole: number;
  used_by: UUID | null;
  used_at: ISODate;
  created_at: ISODate;
  deleted_at: ISODate | null;
}

export interface ContestEntry {
  id: UUID;
  trip_id: UUID;
  hole: number;
  player_id: UUID;
  team_id: UUID;
  type: ContestKind;
  /** ctp: feet (decimal, inches/12). ld: yards as measured at submit time. */
  distance_value: number;
  unit: "ft" | "yd";
  /** Commissioner-set official distance (same unit). Wins over everything. */
  distance_override: number | null;
  /** ctp: marker angle around the pin, degrees, 0 = up (toward the back of the green), clockwise. */
  angle_deg: number | null;
  /** ld: ball position. */
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  /** ld: submitted after 3 weak-GPS tries. */
  low_accuracy: boolean;
  photo_path: string | null;
  ai_estimate_ft: number | null;
  ai_confidence: AiConfidence | null;
  ai_suspicious: boolean | null;
  ai_roast: string | null;
  /** ok = counts (ld also re-checked against sanity range); flagged = needs commissioner; overridden = commissioner approved. */
  status: EntryStatus;
  flag_reason: string | null;
  created_at: ISODate;
  updated_at: ISODate;
  deleted_at: ISODate | null;
}

/** Pots are virtual: "team_match" and "contest:<hole>" for each contest hole. */
export type PotKey = "team_match" | `contest:${number}`;

/** Default is all in. A row with deleted_at = null means the player is OUT of that pot. */
export interface PotOptout {
  id: UUID;
  trip_id: UUID;
  pot_key: PotKey;
  player_id: UUID;
  created_at: ISODate;
  deleted_at: ISODate | null;
}

export type FeedEventType =
  | "post" // player text/photo post
  | "round_started" // commissioner started the round
  | "tee_off" // team teed off hole 1
  | "score_notable" // birdie-or-better, double-or-worse, or net <= 0
  | "score_edit" // "changed hole 6 from a 5 to a 4"
  | "drinks" // batched plain drinks (same team+hole within 60s)
  | "shotgun"
  | "shot"
  | "ghost_beer"
  | "mulligan_used"
  | "groom_mulligan"
  | "lead_change"
  | "contest_entry"
  | "contest_lead"
  | "ai_judge"
  | "drive_warning" // hard warning (red)
  | "drive_miss" // nine ended with a player at zero drives
  | "commissioner_override"
  | "round_complete" // a team finished
  | "final_results" // commissioner finalized
  | "results_changed" // a late sync after finalize changed standings/payouts (loud notice)
  | "removed" // someone other than the logger removed a drink / contest entry / mulligan (transparency)
  | "roast"; // AI roast (payload.trigger_event_id)

export interface FeedEvent {
  id: UUID;
  trip_id: UUID;
  type: FeedEventType;
  team_id: UUID | null;
  player_id: UUID | null;
  /** Who caused it (the acting player), if anyone. */
  actor_id: UUID | null;
  /** Type-specific data. See src/lib/events/payloads.ts. */
  payload: Record<string, unknown>;
  photo_path: string | null;
  /** Player post text, or AI roast text. Templated events render from payload. */
  text: string | null;
  /** Unique per trip when set; prevents duplicate auto events. */
  dedupe_key: string | null;
  created_at: ISODate;
  updated_at: ISODate;
  deleted_at: ISODate | null;
}

export interface Reaction {
  id: UUID;
  trip_id: UUID;
  feed_event_id: UUID;
  player_id: UUID;
  kind: ReactionKind;
  created_at: ISODate;
  /** Toggled off. Unique (feed_event_id, player_id, kind). */
  deleted_at: ISODate | null;
}

/** Server-only tables (never shipped to clients). */
export interface PushSubscriptionRow {
  id: UUID;
  trip_id: UUID;
  player_id: UUID;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  created_at: ISODate;
}

/** Everything about one trip that clients see. Keys equal DB table names. */
export interface TripState {
  trip: Trip;
  players: Player[];
  teams: Team[];
  team_members: TeamMember[];
  holes: Hole[];
  team_round_state: TeamRoundState[];
  hole_scores: HoleScore[];
  drinks: Drink[];
  mulligans: Mulligan[];
  contest_entries: ContestEntry[];
  pot_optouts: PotOptout[];
  feed_events: FeedEvent[];
  reactions: Reaction[];
}

/** Tables that hold arrays in TripState (everything but trips). */
export type RowTable = Exclude<keyof TripState, "trip">;
export const ROW_TABLES: readonly RowTable[] = [
  "players",
  "teams",
  "team_members",
  "holes",
  "team_round_state",
  "hole_scores",
  "drinks",
  "mulligans",
  "contest_entries",
  "pot_optouts",
  "feed_events",
  "reactions",
];

export type RowOf<T extends RowTable> = TripState[T][number];
export type AnyRow = RowOf<RowTable>;

/** Runtime config the server sends along with the state. */
export interface SnapshotMeta {
  server_time: ISODate;
  /** Base URL photos are served from; photo URL = photo_base_url + photo_path. */
  photo_base_url: string;
  /** Supabase Realtime for broadcast invalidations; null = poll only. */
  realtime: { url: string; anon_key: string; topic: string } | null;
  vapid_public_key: string | null;
  ai_enabled: boolean;
  push_enabled: boolean;
}

export interface Snapshot {
  state: TripState;
  meta: SnapshotMeta;
}
