import type { TripState, UUID } from "../types";
import type { MulliganBank } from "./types";

/** Earned = active shotgun/shot drinks; groom gets one Groom's Mulligan for the groom's team. */
export function computeMulliganBanks(
  state: TripState,
  teamOfPlayer: Record<UUID, UUID>,
  groomId: UUID | null,
): Record<UUID, MulliganBank> {
  void state; void teamOfPlayer; void groomId;
  throw new Error("not implemented");
}
