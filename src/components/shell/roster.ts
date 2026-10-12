// Roster grouping straight from raw rows (no engine needed, so Join works even if derive fails).
import type { Player, Team, TripState } from "@/lib/types";

export interface RosterGroup {
  /** null = players without a team ("free agents"). */
  team: Team | null;
  players: Player[];
}

type RosterRows = Pick<TripState, "players" | "teams" | "team_members">;

const byOrderThenName = <T extends { sort_order: number; name: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name);

export function activePlayers(state: RosterRows): Player[] {
  return state.players.filter((p) => !p.deleted_at).sort(byOrderThenName);
}

export function activeTeams(state: RosterRows): Team[] {
  return state.teams.filter((t) => !t.deleted_at).sort(byOrderThenName);
}

/** player_id -> team (active teams only). */
export function teamByPlayer(state: RosterRows): Map<string, Team> {
  const teams = new Map(activeTeams(state).map((t) => [t.id, t]));
  const out = new Map<string, Team>();
  for (const m of state.team_members) {
    const t = teams.get(m.team_id);
    if (t) out.set(m.player_id, t);
  }
  return out;
}

export function teamOfPlayer(state: RosterRows, playerId: string | null | undefined): Team | null {
  if (!playerId) return null;
  return teamByPlayer(state).get(playerId) ?? null;
}

/** Teams in order with their active members, then unassigned players. */
export function rosterGroups(state: RosterRows, opts: { includeEmptyTeams?: boolean } = {}): RosterGroup[] {
  const players = activePlayers(state);
  const tOf = teamByPlayer(state);
  const groups: RosterGroup[] = activeTeams(state).map((team) => ({
    team,
    players: players.filter((p) => tOf.get(p.id)?.id === team.id),
  }));
  const free = players.filter((p) => !tOf.has(p.id));
  const out = opts.includeEmptyTeams ? groups : groups.filter((g) => g.players.length > 0);
  if (free.length > 0) out.push({ team: null, players: free });
  return out;
}

/** "13:05" -> "1:05 PM". Returns the input when it isn't HH:MM. */
export function formatTeeTime(hhmm: string | null | undefined): string | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  if (h > 23) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}
