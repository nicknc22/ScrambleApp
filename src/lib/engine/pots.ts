import type { TripState, UUID } from "../types";
import type { ContestHoleSummary, MoneySummary, StandingRow } from "./types";

/**
 * Pots, payouts, ledger and settle-up. All money in integer cents; every split
 * distributes remainder cents deterministically so the ledger sums to exactly 0.
 */
export function computeMoney(
  state: TripState,
  standings: StandingRow[],
  contests: ContestHoleSummary[],
  teamOfPlayer: Record<UUID, UUID>,
): MoneySummary {
  void state; void standings; void contests; void teamOfPlayer;
  throw new Error("not implemented");
}
