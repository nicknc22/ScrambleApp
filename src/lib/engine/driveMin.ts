// Drive minimum: each player's tee shot used at least once per nine (par 3s count).
import type { TripState, UUID } from "../types";
import type { TeamDriveStatus } from "./types";

export function computeDriveMin(
  state: TripState,
  membersOfTeam: Record<UUID, { id: UUID }[]>,
): Record<UUID, TeamDriveStatus> {
  void state; void membersOfTeam;
  throw new Error("not implemented");
}
