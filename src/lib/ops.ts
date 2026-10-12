// The op vocabulary: every change to a trip is an Op. Players' phones write ops
// to a local outbox (IndexedDB) and apply them optimistically; the sync worker
// POSTs them to /api/t/<code>/sync where the server applies them with the SAME
// reducer (src/lib/reducer.ts) inside a per-trip lock. Ops are idempotent by id:
// re-sending an op that was already applied is a no-op ("duplicate").

import type {
  ContestKind,
  DrinkType,
  Hole,
  ISODate,
  MulliganSource,
  Player,
  PotKey,
  ReactionKind,
  RoundStatus,
  Team,
  TripSettings,
  UUID,
  EntryStatus,
} from "./types";

export interface OpBase {
  /** Client-generated uuid. Idempotency key. */
  id: UUID;
  /** Client time the action happened. Used for LWW on hole scores and drink order. */
  at: ISODate;
  /** The player acting on this device (null for commissioner-only setup before joining). */
  by: UUID | null;
  /** Set when the commissioner is acting with override powers (requires the commissioner cookie). */
  as_commissioner?: boolean;
}

// ---- Play (any player on the team, trip must be live) ----

/** "On the tee" for hole N: opens hole N's drink window (closes N-1). open_hole only moves forward. */
export interface TeeOpenOp extends OpBase {
  type: "tee.open";
  team_id: UUID;
  hole: number;
}

/** "Round complete": closes hole 18's window. */
export interface RoundCompleteOp extends OpBase {
  type: "round.complete";
  team_id: UUID;
}

/** Set team strokes on a hole (LWW by `at`). Entering data for open_hole+1 also opens that hole. */
export interface ScoreSetOp extends OpBase {
  type: "score.set";
  team_id: UUID;
  hole: number;
  strokes: number;
}

/** Whose tee shot was used (LWW by `at`). null clears it. */
export interface TeeShotSetOp extends OpBase {
  type: "teeshot.set";
  team_id: UUID;
  hole: number;
  player_id: UUID | null;
}

export interface DrinkLogOp extends OpBase {
  type: "drink.log";
  drink_id: UUID;
  team_id: UUID;
  player_id: UUID;
  /** The hole whose window was open on the logging device. */
  hole: number;
  drink_type: DrinkType;
  photo_path: string | null;
}

/** Soft delete (undo, or commissioner fix). */
export interface DrinkDeleteOp extends OpBase {
  type: "drink.delete";
  drink_id: UUID;
}

/** Commissioner only. */
export interface DrinkMoveOp extends OpBase {
  type: "drink.move";
  drink_id: UUID;
  hole: number;
}

export interface MulliganUseOp extends OpBase {
  type: "mulligan.use";
  mulligan_id: UUID;
  team_id: UUID;
  hole: number;
  source: MulliganSource;
}

/** Soft delete a mulligan use (undo). */
export interface MulliganUndoOp extends OpBase {
  type: "mulligan.undo";
  mulligan_id: UUID;
}

/** Submit or replace a contest entry. Replaces (soft-deletes) the player's other active entry on that hole. */
export interface ContestSubmitOp extends OpBase {
  type: "contest.submit";
  entry_id: UUID;
  hole: number;
  player_id: UUID;
  contest_type: ContestKind;
  /** ctp: feet (decimal). ld: yards measured on device. */
  distance_value: number;
  angle_deg: number | null;
  lat: number | null;
  lng: number | null;
  gps_accuracy_m: number | null;
  low_accuracy: boolean;
  photo_path: string | null;
}

export interface ContestDeleteOp extends OpBase {
  type: "contest.delete";
  entry_id: UUID;
}

/** Commissioner only: approve/flag an entry or set the official distance. */
export interface ContestReviewOp extends OpBase {
  type: "contest.review";
  entry_id: UUID;
  status: EntryStatus;
  distance_override?: number | null;
}

/** Player post (text and/or photo). */
export interface PostCreateOp extends OpBase {
  type: "post.create";
  event_id: UUID;
  text: string | null;
  photo_path: string | null;
}

/** Commissioner, or the author of a post. */
export interface FeedDeleteOp extends OpBase {
  type: "feed.delete";
  event_id: UUID;
}

export interface ReactionSetOp extends OpBase {
  type: "reaction.set";
  feed_event_id: UUID;
  player_id: UUID;
  kind: ReactionKind;
  on: boolean;
}

/** Players may change their own opt-outs while the trip is in setup; commissioner any time. */
export interface PotOptoutOp extends OpBase {
  type: "pot.optout";
  pot_key: PotKey;
  player_id: UUID;
  out: boolean;
}

export interface PlayerMuteOp extends OpBase {
  type: "player.mute";
  player_id: UUID;
  muted: boolean;
}

// ---- Commissioner setup / overrides (require commissioner cookie) ----

export interface PlayerUpsertOp extends OpBase {
  type: "player.upsert";
  player: Pick<Player, "id"> & Partial<Pick<Player, "name" | "nickname" | "venmo_handle" | "is_groom" | "sort_order">>;
}

export interface PlayerDeleteOp extends OpBase {
  type: "player.delete";
  player_id: UUID;
}

export interface TeamUpsertOp extends OpBase {
  type: "team.upsert";
  team: Pick<Team, "id"> & Partial<Pick<Team, "name" | "tee_time" | "sort_order">>;
}

export interface TeamDeleteOp extends OpBase {
  type: "team.delete";
  team_id: UUID;
}

/** Move a player to a team (null = unassigned). */
export interface TeamAssignOp extends OpBase {
  type: "team.assign";
  player_id: UUID;
  team_id: UUID | null;
}

export interface HoleUpdateOp extends OpBase {
  type: "hole.update";
  hole: number;
  patch: Partial<
    Pick<Hole, "par" | "stroke_index" | "yardage" | "tee_lat" | "tee_lng" | "green_lat" | "green_lng" | "contest">
  >;
}

export interface TripUpdateOp extends OpBase {
  type: "trip.update";
  patch: { name?: string; app_name?: string; base_team_size?: number; settings?: Partial<TripSettings> };
}

/** setup -> live. Creates team_round_state rows for every team. */
export interface TripStartOp extends OpBase {
  type: "trip.start";
}

/** live -> final. Pots become final. */
export interface TripFinalizeOp extends OpBase {
  type: "trip.finalize";
}

/** final -> live (undo finalize). */
export interface TripReopenOp extends OpBase {
  type: "trip.reopen";
}

/** Commissioner fix of a team's window/round status. */
export interface RoundSetStateOp extends OpBase {
  type: "round.set_state";
  team_id: UUID;
  open_hole: number | null;
  status: RoundStatus;
}

export type Op =
  | TeeOpenOp
  | RoundCompleteOp
  | ScoreSetOp
  | TeeShotSetOp
  | DrinkLogOp
  | DrinkDeleteOp
  | DrinkMoveOp
  | MulliganUseOp
  | MulliganUndoOp
  | ContestSubmitOp
  | ContestDeleteOp
  | ContestReviewOp
  | PostCreateOp
  | FeedDeleteOp
  | ReactionSetOp
  | PotOptoutOp
  | PlayerMuteOp
  | PlayerUpsertOp
  | PlayerDeleteOp
  | TeamUpsertOp
  | TeamDeleteOp
  | TeamAssignOp
  | HoleUpdateOp
  | TripUpdateOp
  | TripStartOp
  | TripFinalizeOp
  | TripReopenOp
  | RoundSetStateOp;

export type OpType = Op["type"];

/** Distributive Omit so `OpInput<"drink.log">` etc. keep their discriminant. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What UI code passes to `store.dispatch(...)`; the store fills id/at/by. */
export type OpInput = DistributiveOmit<Op, "id" | "at" | "by"> & { as_commissioner?: boolean };

/** Ops that always require the commissioner cookie. */
export const COMMISSIONER_ONLY_OPS: ReadonlySet<OpType> = new Set<OpType>([
  "drink.move",
  "contest.review",
  "player.upsert",
  "player.delete",
  "team.upsert",
  "team.delete",
  "team.assign",
  "hole.update",
  "trip.update",
  "trip.start",
  "trip.finalize",
  "trip.reopen",
  "round.set_state",
]);

// ---- Sync API contract: POST /api/t/<code>/sync ----

export interface SyncRequest {
  ops: Op[];
}

export type OpResultStatus = "applied" | "duplicate" | "rejected";

export interface OpResult {
  id: UUID;
  status: OpResultStatus;
  /** Machine code for rejections, see RejectCode. */
  code?: RejectCode;
  /** Human (funny) reason for rejections. */
  reason?: string;
}

export type RejectCode =
  | "not_live" // play op while trip is in setup/final
  | "forbidden" // commissioner-only op without commissioner cookie
  | "not_found" // referenced row doesn't exist
  | "invalid" // bad payload (hole out of range, strokes < 1, etc.)
  | "no_window" // drink with no open window (client-side check; server trusts stamped hole)
  | "conflict"; // violates a rule (e.g. groom mulligan already used, team size > 4)

export interface SyncResponse {
  results: OpResult[];
  /** Fresh snapshot after applying, so the client can drop synced ops and re-base. */
  snapshot: import("./types").Snapshot;
}
