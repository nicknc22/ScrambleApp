// Server-side feed event generation. Runs after the reducer applied a batch of ops.
import type { FeedEvent, FeedEventType, ISODate, TripState, UUID } from "../types";
import type { Op } from "../ops";

export interface OpStep {
  op: Op;
  /** State right before this op. */
  before: TripState;
  /** State right after this op (includes feed rows created by earlier steps' events? NO: reducer output only). */
  after: TripState;
  is_commissioner: boolean;
}

export interface RoastTrigger {
  feed_event_id: UUID;
  type: FeedEventType;
  team_id: UUID | null;
  hole: number | null;
  /** Big events ignore the per-team 3-hole gap (still count toward the cap). */
  big: boolean;
}

export interface PushTrigger {
  feed_event_id: UUID;
  title: string;
  body: string;
  /** "all" players, or only one team's players. */
  audience: { kind: "all" } | { kind: "team"; team_id: UUID };
  /** Duplicate events with the same collapse key are collapsed. */
  collapse_key: string;
}

export interface DeriveEventsResult {
  /** New feed rows, or updated existing rows (drink batches). Persist as upserts by id. */
  feed: FeedEvent[];
  roast_triggers: RoastTrigger[];
  push_triggers: PushTrigger[];
}

/**
 * steps: applied (not duplicate, not rejected) ops in order with their before/after states.
 * existingFeed: the feed as of before the batch (to dedupe and to find drink batches).
 */
export function deriveFeedEvents(args: {
  steps: OpStep[];
  existingFeed: FeedEvent[];
  now: ISODate;
}): DeriveEventsResult {
  void args;
  throw new Error("not implemented");
}
