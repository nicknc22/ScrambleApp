// Drive minimum: each player's tee shot used at least once per nine (par 3s count).
import type { TeamRoundState, TripState, UUID } from "../types";
import type { DriveLevel, DriveNineStatus, TeamDriveStatus } from "./types";
import { currentHoleFor } from "./windows";

const NINES: readonly { nine: 1 | 2; first: number; last: number }[] = [
  { nine: 1, first: 1, last: 9 },
  { nine: 2, first: 10, last: 18 },
];

/**
 * Status of one nine for one team.
 * teeShots: hole -> player whose tee shot was used (any player, member or not; null/undefined = none recorded).
 */
function nineStatus(
  nine: (typeof NINES)[number],
  memberIds: UUID[],
  teeShots: (UUID | null | undefined)[],
  currentHole: number,
  complete: boolean,
): DriveNineStatus {
  const holes: number[] = [];
  for (let h = nine.first; h <= nine.last; h++) holes.push(h);

  const members = new Set(memberIds);
  const counts: Record<UUID, number> = {};
  for (const id of memberIds) counts[id] = 0;
  let recorded = 0;
  let remaining = 0;
  for (const h of holes) {
    const shooter = teeShots[h];
    if (shooter == null) {
      if (h >= currentHole) remaining += 1;
      continue;
    }
    recorded += 1;
    // Tee shots by non-members (e.g. a player since moved off the team) don't count for anyone.
    if (members.has(shooter)) counts[shooter] += 1;
  }
  const needing = memberIds.filter((id) => counts[id] === 0);

  const pastNine = complete || currentHole > nine.last;
  const closed = pastNine || recorded === holes.length;
  if (pastNine) remaining = 0;

  let level: DriveLevel;
  if (needing.length === 0 || closed) level = "ok";
  else if (remaining < needing.length) level = "impossible";
  else if (remaining === needing.length) level = "hard";
  else if (remaining <= 3) level = "soft";
  else level = "ok";

  return {
    nine: nine.nine,
    holes,
    counts,
    needing,
    remaining,
    level,
    closed,
    missed: closed ? needing : [],
  };
}

export function computeDriveMin(
  state: TripState,
  membersOfTeam: Record<UUID, { id: UUID }[]>,
): Record<UUID, TeamDriveStatus> {
  const roundState = new Map<UUID, TeamRoundState>();
  for (const rs of state.team_round_state) roundState.set(rs.team_id, rs);

  // team_id -> hole -> tee shot player (only for teams we report on).
  const teeShots = new Map<UUID, (UUID | null)[]>();
  for (const teamId of Object.keys(membersOfTeam)) teeShots.set(teamId, []);
  for (const s of state.hole_scores) {
    const row = teeShots.get(s.team_id);
    if (!row || s.hole < 1 || s.hole > 18) continue;
    // If a (team, hole) ever had two rows, a recorded tee shot wins over an empty one.
    row[s.hole] = s.tee_shot_player_id ?? row[s.hole] ?? null;
  }

  const out: Record<UUID, TeamDriveStatus> = {};
  for (const [teamId, members] of Object.entries(membersOfTeam)) {
    const rs = roundState.get(teamId);
    const currentHole = currentHoleFor(rs) ?? 1;
    const complete = rs?.status === "complete";
    const memberIds = members.map((m) => m.id);
    const shots = teeShots.get(teamId)!;
    out[teamId] = {
      team_id: teamId,
      current_nine: currentHole <= 9 ? 1 : 2,
      nines: [
        nineStatus(NINES[0], memberIds, shots, currentHole, complete),
        nineStatus(NINES[1], memberIds, shots, currentHole, complete),
      ],
    };
  }
  return out;
}
