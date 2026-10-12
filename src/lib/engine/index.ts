// derive(state): recompute every derived value from raw rows. Pure; shared by client and server.
import type { Hole, Player, Team, TeamRoundState, TripState, UUID } from "../types";
import type { Award, ContestHoleSummary, Derived, MoneySummary } from "./types";
import { computeDrinkValues } from "./drinks";
import { activeTeamsSorted, compareSortOrderName, computeDrinkers, computeStandings, computeTeamHoles } from "./scoring";
import { computeDriveMin } from "./driveMin";
import { computeMulliganBanks } from "./mulligans";
import { currentHoleFor, openWindowHole } from "./windows";
import { computeContests } from "./contests";
import { computeMoney } from "./pots";
import { computeAwards } from "./awards";

export * from "./types";

export interface Roster {
  /** Active players sorted by sort_order, name. */
  players: Player[];
  /** Active teams sorted by sort_order, name. */
  teams: Team[];
  playerById: Record<UUID, Player>;
  teamById: Record<UUID, Team>;
  /** Active player -> active team. */
  teamOfPlayer: Record<UUID, UUID>;
  /** Every active team -> its active members sorted by sort_order, name (possibly empty). */
  membersOfTeam: Record<UUID, Player[]>;
  /** Every active team -> active member count. */
  teamSize: Record<UUID, number>;
  /** The active groom (first in roster order if the flag is somehow set twice). */
  groomId: UUID | null;
}

/** Players, teams and memberships, counting only active (not deleted) players and teams. */
export function computeRoster(state: TripState): Roster {
  const players = state.players.filter((p) => p.deleted_at === null).sort(compareSortOrderName);
  const teams = activeTeamsSorted(state);

  const playerById: Record<UUID, Player> = {};
  for (const p of players) playerById[p.id] = p;
  const teamById: Record<UUID, Team> = {};
  const membersOfTeam: Record<UUID, Player[]> = {};
  for (const t of teams) {
    teamById[t.id] = t;
    membersOfTeam[t.id] = [];
  }

  const teamOfPlayer: Record<UUID, UUID> = {};
  for (const m of state.team_members) {
    const p = playerById[m.player_id];
    const members = membersOfTeam[m.team_id];
    // One team per player: ignore a stray second membership row rather than double count.
    if (!p || !members || teamOfPlayer[p.id] !== undefined) continue;
    teamOfPlayer[p.id] = m.team_id;
    members.push(p);
  }

  const teamSize: Record<UUID, number> = {};
  for (const t of teams) {
    membersOfTeam[t.id].sort(compareSortOrderName);
    teamSize[t.id] = membersOfTeam[t.id].length;
  }

  const groom = players.find((p) => p.is_groom);
  return { players, teams, playerById, teamById, teamOfPlayer, membersOfTeam, teamSize, groomId: groom ? groom.id : null };
}

/**
 * Contests, money and awards are secondary views. If one of them throws on unexpected data,
 * derive() still returns scores, drinks and standings (the round must keep going) and the
 * failing view falls back to empty. opts.strict rethrows instead (tests, debugging).
 */
function guarded<T>(label: string, strict: boolean, fn: () => T, fallback: () => T): T {
  if (strict) return fn();
  try {
    return fn();
  } catch (err) {
    console.error(`[engine] ${label} failed; showing an empty view`, err);
    return fallback();
  }
}

export function derive(state: TripState, opts?: { now?: string; strict?: boolean }): Derived {
  const strict = opts?.strict ?? false;
  const roster = computeRoster(state);
  const holes: Hole[] = state.holes.slice().sort((a, b) => a.number - b.number);
  const holeByNumber: Record<number, Hole> = {};
  for (const h of holes) holeByNumber[h.number] = h;

  const drinkValues = computeDrinkValues(state, roster.teamSize);
  const teamHoles = computeTeamHoles(state, drinkValues);
  const standings = computeStandings(state, teamHoles, drinkValues);
  const leaderTeamIds = standings.filter((r) => r.thru > 0 && r.pos === 1).map((r) => r.team_id);

  const roundState = new Map<UUID, TeamRoundState>();
  for (const rs of state.team_round_state) roundState.set(rs.team_id, rs);
  const openWindow: Record<UUID, number | null> = {};
  const currentHole: Record<UUID, number> = {};
  for (const t of roster.teams) {
    const rs = roundState.get(t.id);
    openWindow[t.id] = openWindowHole(rs);
    currentHole[t.id] = currentHoleFor(rs);
  }

  const driveMin = computeDriveMin(state, roster.membersOfTeam);
  const mulligans = computeMulliganBanks(state, roster.teamOfPlayer, roster.groomId);
  const drinkers = computeDrinkers(state, roster.teamOfPlayer);

  const contests = guarded<ContestHoleSummary[]>("contests", strict, () => computeContests(state, roster.teamOfPlayer), () => []);
  const money = guarded<MoneySummary>(
    "money",
    strict,
    () => computeMoney(state, standings, contests, roster.teamOfPlayer),
    () => ({ final: state.trip.status === "final", pots: [], ledger: [], payments: [], total_in_play_cents: 0 }),
  );

  const partial: Omit<Derived, "awards" | "computed_at"> = {
    players: roster.players,
    teams: roster.teams,
    holes,
    playerById: roster.playerById,
    teamById: roster.teamById,
    holeByNumber,
    teamOfPlayer: roster.teamOfPlayer,
    membersOfTeam: roster.membersOfTeam,
    teamSize: roster.teamSize,
    groomId: roster.groomId,
    drinkValues,
    teamHoles,
    standings,
    leaderTeamIds,
    openWindow,
    currentHole,
    driveMin,
    mulligans,
    contests,
    drinkers,
    money,
  };
  const awards = guarded<Award[]>("awards", strict, () => computeAwards(state, partial), () => []);

  return { ...partial, awards, computed_at: opts?.now ?? state.trip.updated_at };
}
