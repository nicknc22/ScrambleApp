import type { TripState, UUID } from "../types";
import type { ContestHoleSummary, RankPreview } from "./types";

/** One summary per contest hole (holes with contest ctp/ld), sorted by hole. */
export function computeContests(state: TripState, teamOfPlayer: Record<UUID, UUID>): ContestHoleSummary[] {
  void state; void teamOfPlayer;
  throw new Error("not implemented");
}

/**
 * Where a new distance would rank ("You'd be 2nd") among current valid entries,
 * ignoring the player's own existing entry (re-measure replaces it).
 */
export function rankPreview(summary: ContestHoleSummary, playerId: UUID, distance: number): RankPreview {
  void summary; void playerId; void distance;
  throw new Error("not implemented");
}
