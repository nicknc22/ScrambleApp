// Drink windows. One open hole per team. See spec "Drink windows".
//
// A team's window for hole N opens when they tap "On the tee" for N (or enter any data for N while
// N-1 is open, see the reducer). It stays open until the next hole opens or, on 18, until "Round
// complete". Before hole 1 opens there is no window: pre-round drinks don't count.
import type { TeamRoundState } from "../types";

/** Hole whose drink window is open, or null (not started, or round complete). */
export function openWindowHole(rs: TeamRoundState | undefined | null): number | null {
  return rs && rs.status === "playing" ? rs.open_hole : null;
}

/** Hole the Play screen should show: open hole; 1 if not started; 18 if complete. */
export function currentHoleFor(rs: TeamRoundState | undefined | null): number {
  if (!rs) return 1;
  if (rs.status === "complete") return rs.open_hole ?? 18;
  if (rs.status === "playing") return rs.open_hole ?? 1;
  return 1;
}
