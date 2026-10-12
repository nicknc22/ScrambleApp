// Ghost beer math. credit(d) = floor(base * d / n); a drink's value = credit(d) - credit(d-1),
// d = the drink's 1-based position among the team's ACTIVE drinks ordered by (logged_at, id).
import type { TripState, UUID } from "../types";
import type { DrinkValue } from "./types";

/** floor(base * d / n). n = team size (>= 1). */
export function creditFor(d: number, teamSize: number, base: number): number {
  void d; void teamSize; void base;
  throw new Error("not implemented");
}

/** Values for every active (non-deleted) drink of every team. teamSize: team_id -> member count. */
export function computeDrinkValues(state: TripState, teamSize: Record<UUID, number>): Record<UUID, DrinkValue> {
  void state; void teamSize;
  throw new Error("not implemented");
}
