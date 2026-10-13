// Drink windows. One open hole per team. See spec "Drink windows".
//
// A team's window for hole N opens when they tap "On the tee" for N (or enter any data for N while
// N-1 is open, see the reducer). It stays open until the next hole opens or, on 18, until "Round
// complete". Before hole 1 opens there is no window: pre-round drinks don't count.
import type { Drink, TeamRoundState } from "../types";

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

/**
 * The hole a drink's credit goes to (spec: "the hole whose window was open when the drink was
 * logged"). A phone stamps the hole it last saw open, which is stale when a teammate's phone opened
 * the next hole first (dead zone, not refetched yet). So: the highest hole whose window had opened
 * by `logged_at` per the team's `hole_opened_at` times, never earlier than the stamped hole (a
 * missing or late-synced tee.open can't drag a drink backwards). A drink the commissioner moved
 * (`moved_from_hole` set) stays exactly where they put it.
 */
export function effectiveDrinkHole(
  drink: Pick<Drink, "hole" | "logged_at" | "moved_from_hole">,
  rs: Pick<TeamRoundState, "hole_opened_at"> | undefined | null,
): number {
  if (drink.moved_from_hole !== null || !rs) return drink.hole;
  const loggedAt = Date.parse(drink.logged_at);
  if (Number.isNaN(loggedAt)) return drink.hole;
  let hole = drink.hole;
  for (const [key, openedAt] of Object.entries(rs.hole_opened_at ?? {})) {
    const h = Number(key);
    if (!Number.isInteger(h) || h <= hole || h < 1 || h > 18) continue;
    const t = Date.parse(openedAt);
    if (!Number.isNaN(t) && t <= loggedAt) hole = h;
  }
  return hole;
}
