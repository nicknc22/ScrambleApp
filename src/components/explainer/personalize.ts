// Turns the trip's raw rows into the explainer's ExplainerInput: who's watching, the groom, team
// sizes for the ghost beer scene, names for the cartoons. Pure (rows in, plain object out).
import type { Player, TripState } from "@/lib/types";
import { displayName } from "@/components/ui/PlayerName";
import { activePlayers, activeTeams, teamByPlayer } from "@/components/shell/roster";
import type { ExplainerInput } from "./script";

type Rows = Pick<TripState, "trip" | "players" | "teams" | "team_members">;

const FALLBACK_TEAMS = ["Sand Baggers", "Ghost Riders", "Shank Redemption"];

/** Chips and stickers are small: keep names short ("Reitman" fits, "Christopher" becomes "Christo…"). */
export function shortName(name: string, max = 8): string {
  const n = name.trim();
  return n.length <= max ? n : `${n.slice(0, max - 1)}…`;
}

export function explainerInput(rows: Rows, meId: string | null, opts: { aiEnabled: boolean }): ExplainerInput {
  const players = activePlayers(rows);
  const me: Player | null = (meId && players.find((p) => p.id === meId)) || null;
  const groom = players.find((p) => p.is_groom) ?? null;
  const tOf = teamByPlayer(rows);
  const teams = activeTeams(rows);
  const sizes = new Map<string, number>();
  for (const p of players) {
    const t = tOf.get(p.id);
    if (t) sizes.set(t.id, (sizes.get(t.id) ?? 0) + 1);
  }
  const myTeam = me ? (tOf.get(me.id) ?? null) : null;
  const drivePlayers = myTeam ? players.filter((p) => tOf.get(p.id)?.id === myTeam.id) : players;
  const named = teams.filter((t) => (sizes.get(t.id) ?? 0) > 0 && t.name.trim());
  const real = named.length >= 2;
  const teamNames = named.map((t) => t.name.trim());
  // The board cartoon draws the first three teams; its settle-up line names their players.
  const drawn = real ? named.slice(0, 3) : [];
  const teamMembers = drawn.map((t) => players.filter((p) => tOf.get(p.id)?.id === t.id).map((p) => displayName(p)));
  const myIndex = myTeam ? drawn.findIndex((t) => t.id === myTeam.id) : -1;
  const settings = rows.trip.settings;
  return {
    playerName: me ? displayName(me) : null,
    isGroom: !!me?.is_groom,
    tripName: rows.trip.name,
    groomName: groom ? displayName(groom) : null,
    courseName: settings.course_name,
    baseTeamSize: rows.trip.base_team_size,
    teamSizes: teams.map((t) => sizes.get(t.id) ?? 0).filter((n) => n > 0),
    myTeamSize: myTeam ? (sizes.get(myTeam.id) ?? null) : null,
    driveNames: drivePlayers.slice(0, 4).map((p) => displayName(p)),
    teamNames: real ? teamNames.slice(0, 3) : FALLBACK_TEAMS,
    teamMembers,
    myTeamIndex: myIndex >= 0 ? myIndex : null,
    teamMatchAnteCents: settings.team_match_ante_cents,
    contestAnteCents: settings.contest_ante_cents,
    aiJudge: opts.aiEnabled,
    status: rows.trip.status,
  };
}
