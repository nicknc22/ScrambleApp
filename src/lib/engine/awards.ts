import type { TripState } from "../types";
import type { Award, Derived } from "./types";

/** All award cards (computed from current data; UI shows them when the trip is final). */
export function computeAwards(state: TripState, d: Omit<Derived, "awards" | "computed_at">): Award[] {
  void state; void d;
  throw new Error("not implemented");
}
