// Templated feed copy. Every automatic event renders funny text from its payload, so the
// feed works with AI off. Variant choice is deterministic per event id.
import type { FeedEvent, TripState } from "../types";
import type { Derived } from "../engine/types";

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

export function renderFeedEvent(ev: FeedEvent, state: TripState, d: Derived): RenderedEvent {
  void ev; void state; void d;
  throw new Error("not implemented");
}

/** Toast copy when a drink is logged before "On the tee" for hole 1 (or after round complete). */
export function noWindowRoast(seed: string): string {
  void seed;
  throw new Error("not implemented");
}
