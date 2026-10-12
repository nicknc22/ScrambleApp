import type { TripState, UUID } from "../types";
import type { DrinkValue, DrinkerRow, StandingRow, TeamHoleLine } from "./types";

/** team_id -> 18 scorecard lines (hole 1..18) for every active team. */
export function computeTeamHoles(state: TripState, drinkValues: Record<UUID, DrinkValue>): Record<UUID, TeamHoleLine[]> {
  void state; void drinkValues;
  throw new Error("not implemented");
}

/** Leaderboard rows, sorted, with tie-aware positions. See StandingRow docs. */
export function computeStandings(
  state: TripState,
  teamHoles: Record<UUID, TeamHoleLine[]>,
  drinkValues: Record<UUID, DrinkValue>,
): StandingRow[] {
  void state; void teamHoles; void drinkValues;
  throw new Error("not implemented");
}

/** Individual drinking leaderboard for every active player on a team. Sorted by total desc, then name. */
export function computeDrinkers(state: TripState, teamOfPlayer: Record<UUID, UUID>): DrinkerRow[] {
  void state; void teamOfPlayer;
  throw new Error("not implemented");
}
