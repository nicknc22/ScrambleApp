// Drink windows. One open hole per team. See spec "Drink windows".
import type { TeamRoundState } from "../types";

/** Hole whose drink window is open, or null (not started, or round complete). */
export function openWindowHole(rs: TeamRoundState | undefined | null): number | null {
  void rs;
  throw new Error("not implemented");
}

/** Hole the Play screen should show: open hole; 1 if not started; 18 if complete. */
export function currentHoleFor(rs: TeamRoundState | undefined | null): number {
  void rs;
  throw new Error("not implemented");
}
