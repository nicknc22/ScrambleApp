// Contest holes: closest to pin (par 3s) and long drive (par 5s). See spec "Contests".
//
// One summary per contest hole with every active entry, its official distance, validity and rank.
// Long drive distances are recomputed from the hole's CURRENT tee point, so moving the tee point
// on the Course screen re-measures every drive on that hole.
import type { ContestEntry, ContestKind, Hole, TripState, UUID } from "../types";
import type { ContestEntryView, ContestHoleSummary, RankPreview } from "./types";
import { haversineYards } from "./geo";
import { ordinal } from "./format";

/**
 * Comparable score for a contest distance; SMALLER is better for both kinds.
 * ctp: inches (closest wins, compared at inch precision, matching what players enter).
 * ld: negative whole yards (longest wins, compared at yard precision).
 */
export function contestScore(type: ContestKind, distance: number): number {
  return type === "ctp" ? Math.round(distance * 12) : -Math.round(distance);
}

/** Later (updated_at, created_at, id) wins when a player somehow has several active entries on a hole. */
function isLater(a: ContestEntry, b: ContestEntry): boolean {
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at;
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  return a.id > b.id;
}

/** Measured long-drive distance in whole yards, ignoring any commissioner override. */
function measuredYards(hole: Hole, e: ContestEntry): number {
  if (hole.tee_lat !== null && hole.tee_lng !== null && e.lat !== null && e.lng !== null) {
    return haversineYards({ lat: hole.tee_lat, lng: hole.tee_lng }, { lat: e.lat, lng: e.lng });
  }
  return Math.round(e.distance_value);
}

/** Official distance: ctp feet; ld whole yards. A commissioner override wins over everything. */
export function officialDistance(hole: Hole, e: ContestEntry, type: ContestKind): number {
  if (type === "ctp") return e.distance_override ?? e.distance_value;
  return e.distance_override !== null ? Math.round(e.distance_override) : measuredYards(hole, e);
}

function validity(
  hole: Hole,
  e: ContestEntry,
  type: ContestKind,
  distance: number,
  ldMin: number,
  ldMax: number,
): { valid: boolean; invalid_reason: string | null } {
  if (!Number.isFinite(distance) || distance < 0) return { valid: false, invalid_reason: "Bad distance" };
  if (e.status === "overridden") return { valid: true, invalid_reason: null };
  if (e.status === "flagged") {
    return { valid: false, invalid_reason: e.flag_reason ? `Needs commissioner review: ${e.flag_reason}` : "Needs commissioner review" };
  }
  // status "ok": long drives are re-checked against the sanity range (the tee point may have moved).
  // A commissioner override is a ruling, so only the measured distance is range-checked.
  if (type === "ld" && e.distance_override === null) {
    const yd = measuredYards(hole, e);
    if (yd < ldMin || yd > ldMax) return { valid: false, invalid_reason: `Out of range: ${yd} yd` };
  }
  return { valid: true, invalid_reason: null };
}

/**
 * Teams that actually play: active teams with at least one active member. A hole is closed once
 * every one of them is past it (open_hole > hole, or round complete). A team with no round state
 * hasn't passed anything.
 */
function closedHoles(state: TripState, teamOfPlayer: Record<UUID, UUID>): (hole: number) => boolean {
  if (state.trip.status === "final") return () => true;
  const activeTeams = new Set(state.teams.filter((t) => t.deleted_at === null).map((t) => t.id));
  const playing = new Set<UUID>();
  for (const teamId of Object.values(teamOfPlayer)) if (activeTeams.has(teamId)) playing.add(teamId);
  if (playing.size === 0) return () => false;
  const rsByTeam = new Map(state.team_round_state.map((rs) => [rs.team_id, rs]));
  const states = [...playing].map((t) => rsByTeam.get(t));
  return (hole) =>
    states.every((rs) => rs !== undefined && (rs.status === "complete" || (rs.open_hole !== null && rs.open_hole > hole)));
}

function compareViews(a: ContestEntryView, b: ContestEntryView): number {
  if (a.valid !== b.valid) return a.valid ? -1 : 1;
  if (a.valid) {
    const d = contestScore(a.type, a.distance) - contestScore(b.type, b.distance);
    if (d !== 0) return d;
  }
  // Earlier submission first among equals, then id for a total order.
  if (a.entry.created_at !== b.entry.created_at) return a.entry.created_at < b.entry.created_at ? -1 : 1;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

/** One summary per contest hole (holes with contest ctp/ld), sorted by hole. */
export function computeContests(state: TripState, teamOfPlayer: Record<UUID, UUID>): ContestHoleSummary[] {
  const { ld_min_yd: ldMin, ld_max_yd: ldMax } = state.trip.settings;
  const activePlayers = new Set(state.players.filter((p) => p.deleted_at === null).map((p) => p.id));
  const isClosed = closedHoles(state, teamOfPlayer);

  const contestHoles = state.holes
    .filter((h) => h.contest === "ctp" || h.contest === "ld")
    .sort((a, b) => a.number - b.number);

  // hole -> player -> latest active entry of the hole's contest type
  const latest = new Map<number, Map<UUID, ContestEntry>>();
  for (const h of contestHoles) latest.set(h.number, new Map());
  const typeOfHole = new Map(contestHoles.map((h) => [h.number, h.contest as ContestKind]));
  for (const e of state.contest_entries) {
    if (e.deleted_at !== null || !activePlayers.has(e.player_id)) continue;
    const byPlayer = latest.get(e.hole);
    // Entries of the wrong type (hole's par changed after submission) don't count.
    if (!byPlayer || typeOfHole.get(e.hole) !== e.type) continue;
    const prev = byPlayer.get(e.player_id);
    if (!prev || isLater(e, prev)) byPlayer.set(e.player_id, e);
  }

  return contestHoles.map((hole) => {
    const type = hole.contest as ContestKind;
    const views: ContestEntryView[] = [...latest.get(hole.number)!.values()].map((entry) => {
      const distance = officialDistance(hole, entry, type);
      const v = validity(hole, entry, type, distance, ldMin, ldMax);
      return {
        entry,
        player_id: entry.player_id,
        team_id: teamOfPlayer[entry.player_id] ?? entry.team_id,
        type,
        distance,
        unit: type === "ctp" ? "ft" : "yd",
        valid: v.valid,
        invalid_reason: v.invalid_reason,
        rank: null,
        suspicious: entry.ai_suspicious === true,
      };
    });
    views.sort(compareViews);

    // Standard competition ranking among valid entries (1, 1, 3).
    const valid = views.filter((v) => v.valid);
    valid.forEach((v, i) => {
      const prev = valid[i - 1];
      v.rank = prev && contestScore(type, prev.distance) === contestScore(type, v.distance) ? prev.rank : i + 1;
    });
    const leaders = valid.filter((v) => v.rank === 1);

    return {
      hole: hole.number,
      type,
      pot_key: `contest:${hole.number}` as const,
      entries: views,
      leader_ids: leaders.map((v) => v.player_id),
      best: leaders.length > 0 ? leaders[0].distance : null,
      closed: isClosed(hole.number),
    };
  });
}

/**
 * Where a new distance would rank ("You'd be 2nd") among current valid entries,
 * ignoring the player's own existing entry (re-measure replaces it).
 */
export function rankPreview(summary: ContestHoleSummary, playerId: UUID, distance: number): RankPreview {
  const others = summary.entries.filter((v) => v.valid && v.player_id !== playerId);
  const mine = contestScore(summary.type, distance);
  let better = 0;
  let tied = false;
  for (const v of others) {
    const s = contestScore(summary.type, v.distance);
    if (s < mine) better += 1;
    else if (s === mine) tied = true;
  }
  const rank = better + 1;
  // Entries are sorted best first, so the first remaining valid entry leads.
  return { rank, leader: others[0] ?? null, label: `${tied ? "T" : ""}${ordinal(rank)}` };
}
