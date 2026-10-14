// Pure view-model helpers for the Leaderboard tab. No React, no I/O: everything here is
// derived from engine output (Derived) so it can be unit tested with fixtures.
import type { ContestKind, Player, UUID } from "@/lib/types";
import type {
  ContestHoleSummary,
  Derived,
  DriveLevel,
  DrinkerRow,
  StandingRow,
  TeamHoleLine,
} from "@/lib/engine/types";
import { formatFeetInches, formatToPar, ordinal } from "@/lib/engine/format";

export const DASH = "–";

/** Up to two initials for tight spots: "Big Nick" -> "BN", "T-Bone" -> "TB", "Jimbo" -> "JI". */
export function shortInitials(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    const chars = Array.from(words[0]);
    return (chars[0] + (chars[1] ?? "")).toUpperCase();
  }
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// Standings table
// ---------------------------------------------------------------------------

export interface StandingView {
  team_id: UUID;
  pos_label: string;
  thru_label: string;
  /** "–" before the team has scored a hole. */
  gross: string;
  drinks: string;
  credit: string;
  net: string;
  to_par: string;
  /** Raw net to par, for coloring (null before the team has scored). */
  to_par_value: number | null;
  /**
   * Drinks on holes without a score yet (normally the open hole): not in drinks / credit / net
   * until the hole is scored. "+1 🍺 banked" marker; null when there are none.
   */
  banked: string | null;
  banked_drinks: number;
  banked_credit: number;
  ghost_beers: number;
  started: boolean;
  /** At position 1 among teams that have scored. */
  leader: boolean;
  mine: boolean;
  complete: boolean;
}

/** Display strings for every standings row (same order as derived.standings). */
export function standingsView(standings: readonly StandingRow[], myTeamId: UUID | null): StandingView[] {
  return standings.map((r) => {
    const started = r.thru > 0;
    const bankedDrinks = r.pending_drinks ?? 0;
    return {
      team_id: r.team_id,
      pos_label: r.pos_label,
      thru_label: r.thru_label,
      gross: started ? String(r.gross) : DASH,
      drinks: String(r.drinks),
      credit: r.credit > 0 ? `-${r.credit}` : "0",
      net: started ? String(r.net) : DASH,
      to_par: started ? formatToPar(r.net_to_par) : DASH,
      to_par_value: started ? r.net_to_par : null,
      banked: bankedDrinks > 0 ? `+${bankedDrinks} 🍺 banked` : null,
      banked_drinks: bankedDrinks,
      banked_credit: r.pending_credit ?? 0,
      ghost_beers: r.ghost_beers,
      started,
      leader: started && r.pos === 1,
      mine: myTeamId !== null && r.team_id === myTeamId,
      complete: r.status === "complete",
    };
  });
}

/** Tailwind text color for a net-to-par value: under par is good (fairway), over is bad (flag). */
export function toParTone(v: number | null): "under" | "even" | "over" | "none" {
  if (v === null) return "none";
  if (v < 0) return "under";
  if (v > 0) return "over";
  return "even";
}

/**
 * Positions moved since the previous order: team_id -> places gained (positive = moved up).
 * Teams that are new or didn't move are omitted.
 */
export function positionDeltas(prev: readonly UUID[], next: readonly UUID[]): Record<UUID, number> {
  const before = new Map<UUID, number>();
  prev.forEach((id, i) => before.set(id, i));
  const out: Record<UUID, number> = {};
  next.forEach((id, i) => {
    const was = before.get(id);
    if (was === undefined || was === i) return;
    out[id] = was - i;
  });
  return out;
}

/**
 * Net to par in words, for people who don't read golf: -16 -> "16 under", 0 -> "Even", 3 -> "3 over".
 * (The table keeps the compact "-16"; banners and cards say it out loud.)
 */
export function toParWords(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "Even";
  return n < 0 ? `${-n} under` : `${n} over`;
}

export interface LeaderHeadline {
  kind: "none" | "solo" | "tie";
  names: string[];
  /** "-16" (compact). */
  to_par: string;
  /** The leaders' net to par (0 when nobody has scored). */
  to_par_value: number;
  thru: string;
}

/** One-line headline for the top of the board. */
export function leaderHeadline(d: Pick<Derived, "standings" | "teamById">): LeaderHeadline {
  const leaders = d.standings.filter((r) => r.thru > 0 && r.pos === 1);
  if (leaders.length === 0) return { kind: "none", names: [], to_par: DASH, to_par_value: 0, thru: DASH };
  return {
    kind: leaders.length > 1 ? "tie" : "solo",
    names: leaders.map((r) => d.teamById[r.team_id]?.name || "Unnamed team"),
    to_par: formatToPar(leaders[0].net_to_par),
    to_par_value: leaders[0].net_to_par,
    thru: leaders[0].thru_label,
  };
}

/** "16 under · thru 14" / "39 under · finished". */
export function leaderBannerLine(h: Pick<LeaderHeadline, "to_par_value" | "thru">): string {
  return `${toParWords(h.to_par_value)} · ${h.thru === "F" ? "finished" : `thru ${h.thru}`}`;
}

/**
 * The viewer's own spot under the leader banner: "You: T2, 3 back". null when the viewer has no
 * team, hasn't scored yet, or is (co-)leading.
 */
export function myChaseLine(standings: readonly StandingRow[], myTeamId: UUID | null): string | null {
  if (!myTeamId) return null;
  const mine = standings.find((r) => r.team_id === myTeamId);
  if (!mine || mine.thru <= 0 || mine.pos === 1) return null;
  const leader = standings.find((r) => r.thru > 0 && r.pos === 1);
  if (!leader) return null;
  const back = mine.net_to_par - leader.net_to_par;
  // "T2" stays as is; a lone place reads as an ordinal ("3rd"), never a bare number that looks like a score.
  const place = /^\d+$/.test(mine.pos_label) ? ordinal(mine.pos) : mine.pos_label;
  return `You: ${place}, ${back > 0 ? `${back} back` : "level with the lead"}`;
}

// ---------------------------------------------------------------------------
// Team scorecard (hole-by-hole)
// ---------------------------------------------------------------------------

export interface CardSum {
  label: "OUT" | "IN" | "TOT";
  par: number;
  /** Par over holes with strokes entered (for to-par math). */
  par_played: number;
  /** Sum of strokes entered; null when no hole in range has strokes. */
  strokes: number | null;
  /** Drinks / credit on SCORED holes (like the leaderboard's Drk / Cred, so TOT matches its row). */
  drinks: number;
  credit: number;
  /** Sum of hole nets over scored holes (= the leaderboard's net for TOT). null when none is scored. */
  net: number | null;
  /** Holes with strokes entered. */
  played: number;
  /** Drinks / credit on holes without a score yet ("banked": they join the net once scored). */
  banked_drinks: number;
  banked_credit: number;
}

export function sumLines(lines: readonly TeamHoleLine[], label: CardSum["label"]): CardSum {
  let par = 0;
  let parPlayed = 0;
  let strokes = 0;
  let played = 0;
  let drinks = 0;
  let credit = 0;
  let bankedDrinks = 0;
  let bankedCredit = 0;
  for (const l of lines) {
    par += l.par;
    if (l.strokes !== null) {
      strokes += l.strokes;
      parPlayed += l.par;
      played += 1;
      drinks += l.drinks;
      credit += l.credit;
    } else {
      bankedDrinks += l.drinks;
      bankedCredit += l.credit;
    }
  }
  return {
    label,
    par,
    par_played: parPlayed,
    strokes: played > 0 ? strokes : null,
    drinks,
    credit,
    net: played > 0 ? strokes - credit : null,
    played,
    banked_drinks: bankedDrinks,
    banked_credit: bankedCredit,
  };
}

export interface CardSection {
  lines: TeamHoleLine[];
  sum: CardSum;
}

/** Front nine + OUT, back nine + IN, and the round total. */
export function scorecardSections(lines: readonly TeamHoleLine[]): { front: CardSection; back: CardSection; total: CardSum } {
  const sorted = [...lines].sort((a, b) => a.hole - b.hole);
  const front = sorted.filter((l) => l.hole <= 9);
  const back = sorted.filter((l) => l.hole >= 10);
  return {
    front: { lines: front, sum: sumLines(front, "OUT") },
    back: { lines: back, sum: sumLines(back, "IN") },
    total: sumLines(sorted, "TOT"),
  };
}

export type ScoreShape = "albatross" | "eagle" | "birdie" | "par" | "bogey" | "double" | "none";

/** Classic scorecard notation for gross strokes vs par. */
export function scoreShape(strokes: number | null, par: number): ScoreShape {
  if (strokes === null) return "none";
  const d = strokes - par;
  if (d <= -3) return "albatross";
  if (d === -2) return "eagle";
  if (d === -1) return "birdie";
  if (d === 0) return "par";
  if (d === 1) return "bogey";
  return "double";
}

// ---------------------------------------------------------------------------
// Drinkers
// ---------------------------------------------------------------------------

export interface DrinkerView extends DrinkerRow {
  /** Competition ranking on total (ties share): "1", "T2". "–" when the player has 0. */
  rank_label: string;
  rank: number;
}

export function drinkerRanks(rows: readonly DrinkerRow[]): DrinkerView[] {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const counts = new Map<number, number>();
  for (const r of sorted) counts.set(r.total, (counts.get(r.total) ?? 0) + 1);
  let prev: DrinkerView | null = null;
  return sorted.map((r, i) => {
    const rank: number = prev && prev.total === r.total ? prev.rank : i + 1;
    const label = r.total === 0 ? DASH : (counts.get(r.total) ?? 0) > 1 ? `T${rank}` : String(rank);
    const v: DrinkerView = { ...r, rank, rank_label: label };
    prev = v;
    return v;
  });
}

// ---------------------------------------------------------------------------
// Contests
// ---------------------------------------------------------------------------

export function contestLabel(type: ContestKind): string {
  return type === "ld" ? "Long drive" : "Closest to pin";
}

export function formatContestDistance(distance: number | null, unit: "ft" | "yd" | ContestKind): string {
  if (distance === null || !Number.isFinite(distance)) return DASH;
  return unit === "ft" || unit === "ctp" ? formatFeetInches(distance) : `${Math.round(distance)} yd`;
}

export interface ContestView {
  hole: number;
  type: ContestKind;
  label: string;
  leader_ids: UUID[];
  distance: string;
  /** Some leading entry was flagged by the AI judge. */
  suspicious: boolean;
  entries: number;
  /** Active entries that don't count yet (flagged for review). */
  pending_review: number;
  closed: boolean;
  /** "no_entries" | "no_valid" | "leader" */
  state: "no_entries" | "no_valid" | "leader";
}

export function contestViews(contests: readonly ContestHoleSummary[]): ContestView[] {
  return [...contests]
    .sort((a, b) => a.hole - b.hole)
    .map((c) => {
      const leaders = c.entries.filter((e) => e.valid && c.leader_ids.includes(e.player_id) && e.rank === 1);
      const pending = c.entries.filter((e) => !e.valid).length;
      const state: ContestView["state"] = c.entries.length === 0 ? "no_entries" : c.leader_ids.length === 0 ? "no_valid" : "leader";
      return {
        hole: c.hole,
        type: c.type,
        label: contestLabel(c.type),
        leader_ids: c.leader_ids,
        distance: formatContestDistance(c.best, c.type === "ld" ? "yd" : "ft"),
        suspicious: leaders.some((e) => e.suspicious),
        entries: c.entries.length,
        pending_review: pending,
        closed: c.closed,
        state,
      };
    });
}

// ---------------------------------------------------------------------------
// Drives (drive minimum)
// ---------------------------------------------------------------------------

export type DriveCellState = "ok" | "needs" | "needs_soft" | "needs_hard" | "missed" | "idle";

export interface DrivePlayerView {
  player_id: UUID;
  front: number;
  back: number;
  front_state: DriveCellState;
  back_state: DriveCellState;
}

export interface DriveTeamView {
  team_id: UUID;
  current_nine: 1 | 2;
  /** Level of the current nine. */
  level: DriveLevel;
  remaining: number;
  needing: UUID[];
  players: DrivePlayerView[];
  /** Anyone missed on a closed nine. */
  missed_any: boolean;
}

function cellState(count: number, missed: boolean, closed: boolean, isCurrent: boolean, level: DriveLevel): DriveCellState {
  if (missed) return "missed";
  if (count > 0) return "ok";
  // A closed nine at 0 is normally "missed"; a 0 that isn't (e.g. joined mid-round) stays neutral.
  if (closed || !isCurrent) return "idle";
  if (level === "hard" || level === "impossible") return "needs_hard";
  if (level === "soft") return "needs_soft";
  return "needs";
}

export function driveViews(d: Pick<Derived, "teams" | "driveMin" | "membersOfTeam">): DriveTeamView[] {
  const out: DriveTeamView[] = [];
  for (const team of d.teams) {
    const st = d.driveMin[team.id];
    const members: Player[] = d.membersOfTeam[team.id] ?? [];
    if (!st) continue;
    const [front, back] = st.nines;
    const cur = st.current_nine === 2 ? back : front;
    out.push({
      team_id: team.id,
      current_nine: st.current_nine,
      level: cur.closed ? "ok" : cur.level,
      remaining: cur.remaining,
      needing: cur.closed ? [] : cur.needing,
      missed_any: front.missed.length > 0 || back.missed.length > 0,
      players: members.map((p) => {
        const f = front.counts[p.id] ?? 0;
        const b = back.counts[p.id] ?? 0;
        return {
          player_id: p.id,
          front: f,
          back: b,
          front_state: cellState(f, front.missed.includes(p.id), front.closed, st.current_nine === 1, front.level),
          back_state: cellState(b, back.missed.includes(p.id), back.closed, st.current_nine === 2, back.level),
        };
      }),
    });
  }
  return out;
}
