// Mulligan banks. Mulligans are a tracked resource only: they never touch score math.
import type { TripState, UUID } from "../types";
import type { MulliganBank } from "./types";
import { countedDrinks } from "./drinks";

/** Earned = active shotgun/shot drinks; groom gets one Groom's Mulligan for the groom's team. */
export function computeMulliganBanks(
  state: TripState,
  teamOfPlayer: Record<UUID, UUID>,
  groomId: UUID | null,
): Record<UUID, MulliganBank> {
  const out: Record<UUID, MulliganBank> = {};
  const groomTeam = groomId !== null ? (teamOfPlayer[groomId] ?? null) : null;
  // One Groom's Mulligan per trip: any active groom use (on any team) spends it.
  const groomUsed = state.mulligans.some((m) => m.deleted_at === null && m.source === "groom");

  for (const t of state.teams) {
    if (t.deleted_at !== null) continue;
    const groomOnTeam = groomTeam === t.id;
    out[t.id] = {
      team_id: t.id,
      earned: 0,
      used_earned: 0,
      available: 0,
      groom_on_team: groomOnTeam,
      groom_used: groomUsed,
      groom_available: groomOnTeam && !groomUsed,
      used_total: 0,
    };
  }

  // A shotgun or shot after the team's Round complete doesn't count, so it banks nothing either.
  for (const d of countedDrinks(state)) {
    if (d.type !== "shotgun" && d.type !== "shot") continue;
    const bank = out[d.team_id];
    if (bank) bank.earned += 1;
  }
  for (const m of state.mulligans) {
    if (m.deleted_at !== null) continue;
    const bank = out[m.team_id];
    if (!bank) continue;
    bank.used_total += 1;
    if (m.source === "earned") bank.used_earned += 1;
  }
  for (const bank of Object.values(out)) bank.available = Math.max(0, bank.earned - bank.used_earned);
  return out;
}
