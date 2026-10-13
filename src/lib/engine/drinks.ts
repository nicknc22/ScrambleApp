// Ghost beer math. credit(d) = floor(base * d / n); a drink's value = credit(d) - credit(d-1),
// d = the drink's 1-based position among the team's ACTIVE drinks ordered by (logged_at, id).
import type { Drink, TeamRoundState, TripState, UUID } from "../types";
import type { DrinkValue } from "./types";
import { effectiveDrinkHole } from "./windows";

/** Spec default base team size, used only if the trip row carries something unusable. */
const DEFAULT_BASE = 4;

/** floor(base * d / n). n = team size (>= 1). */
export function creditFor(d: number, teamSize: number, base: number): number {
  if (!(d > 0)) return 0;
  const b = base > 0 ? base : DEFAULT_BASE;
  // A team with no active members (should never happen while live) counts as a full team.
  const n = teamSize > 0 ? teamSize : b;
  return Math.floor((b * d) / n);
}

/**
 * Parsed client time for ordering. Unparseable timestamps sort last (Infinity); the raw string
 * and then the id break ties, so the order is total and identical on client and server.
 */
function timeKey(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** Ghost-beer order: (logged_at, id). Exported so other modules can order drinks the same way. */
export function compareDrinkOrder(a: Drink, b: Drink): number {
  const ta = timeKey(a.logged_at);
  const tb = timeKey(b.logged_at);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.logged_at !== b.logged_at) return a.logged_at < b.logged_at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Values for every active (non-deleted) drink of every team. teamSize: team_id -> member count.
 * DrinkValue.hole is the EFFECTIVE hole (effectiveDrinkHole): every per-hole consumer reads it.
 */
export function computeDrinkValues(state: TripState, teamSize: Record<UUID, number>): Record<UUID, DrinkValue> {
  const base = state.trip.base_team_size;
  const activeTeams = new Set<UUID>();
  for (const t of state.teams) if (t.deleted_at === null) activeTeams.add(t.id);
  const roundState = new Map<UUID, TeamRoundState>();
  for (const rs of state.team_round_state) roundState.set(rs.team_id, rs);

  // Group active drinks of active teams by team.
  const byTeam = new Map<UUID, Drink[]>();
  for (const d of state.drinks) {
    if (d.deleted_at !== null || !activeTeams.has(d.team_id)) continue;
    let list = byTeam.get(d.team_id);
    if (!list) byTeam.set(d.team_id, (list = []));
    list.push(d);
  }

  const out: Record<UUID, DrinkValue> = {};
  for (const [teamId, list] of byTeam) {
    list.sort(compareDrinkOrder);
    const n = teamSize[teamId] ?? base;
    let prev = 0; // credit(seq - 1)
    list.forEach((d, i) => {
      const seq = i + 1;
      const credit = creditFor(seq, n, base);
      const value = credit - prev;
      prev = credit;
      out[d.id] = {
        drink_id: d.id,
        team_id: teamId,
        player_id: d.player_id,
        hole: effectiveDrinkHole(d, roundState.get(teamId)),
        type: d.type,
        value,
        ghost: value > 1,
        seq,
      };
    });
  }
  return out;
}
