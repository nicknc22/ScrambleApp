// Pure helpers for the commissioner's live-round tools (unit-tested in tests/ui/course-commish.test.ts).
import type { ContestEntry, Drink, Player, RoundStatus, Team, TeamRoundState, TripState, UUID } from "@/lib/types";
import type { ContestEntryView, ContestHoleSummary, Derived } from "@/lib/engine/types";
import { formatFeetInches } from "@/lib/engine/format";

// ---------------------------------------------------------------------------
// Contest review
// ---------------------------------------------------------------------------

export interface ReviewItem {
  view: ContestEntryView;
  hole: number;
  /** Why it needs a look (empty when it doesn't). */
  reasons: string[];
  needsReview: boolean;
}

export function formatDistance(distance: number, unit: "ft" | "yd"): string {
  return unit === "ft" ? formatFeetInches(distance) : `${Math.round(distance)} yd`;
}

/** Reasons an entry deserves the commissioner's eyes. Approved (overridden) entries are settled. */
export function reviewReasons(v: ContestEntryView): string[] {
  const e = v.entry;
  const out: string[] = [];
  if (e.status === "overridden") return out;
  if (e.status === "flagged") out.push(e.flag_reason ? `Flagged: ${e.flag_reason}` : "Flagged for review");
  if (e.low_accuracy && e.status !== "flagged") out.push("GPS was weak");
  if (!v.valid && v.invalid_reason && e.status !== "flagged") out.push(v.invalid_reason);
  if (e.type === "ld" && e.gps_accuracy_m !== null && e.gps_accuracy_m > 12 && !e.low_accuracy) {
    out.push(`GPS ±${Math.round(e.gps_accuracy_m)} m`);
  }
  if (v.suspicious) {
    out.push(
      e.ai_estimate_ft !== null
        ? `AI judge smells a rat: claimed ${formatFeetInches(e.distance_value)}, looks like ~${formatFeetInches(e.ai_estimate_ft)}`
        : "AI judge flagged it as suspicious",
    );
  }
  return out;
}

/** Every active entry by contest hole, plus whether it needs review. */
export function reviewItems(contests: readonly ContestHoleSummary[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const c of contests) {
    for (const v of c.entries) {
      const reasons = reviewReasons(v);
      out.push({ view: v, hole: c.hole, reasons, needsReview: reasons.length > 0 });
    }
  }
  return out;
}

/** The queue: entries needing review, by hole then submission time. */
export function reviewQueue(contests: readonly ContestHoleSummary[]): ReviewItem[] {
  return reviewItems(contests)
    .filter((i) => i.needsReview)
    .sort((a, b) => a.hole - b.hole || a.view.entry.created_at.localeCompare(b.view.entry.created_at));
}

export function entryStatusLabel(e: Pick<ContestEntry, "status">): string {
  return e.status === "overridden" ? "Approved" : e.status === "flagged" ? "Flagged" : "OK";
}

/** Feet + inches typed into two boxes -> decimal feet (null when unusable). Max 200 ft like the reducer. */
export function feetFromParts(ft: string, inches: string): number | null {
  const f = ft.trim() === "" ? 0 : Number(ft);
  const i = inches.trim() === "" ? 0 : Number(inches);
  if (!Number.isFinite(f) || !Number.isFinite(i) || f < 0 || i < 0 || i >= 12) return null;
  if (ft.trim() === "" && inches.trim() === "") return null;
  const v = round2(f + i / 12);
  return v <= 200 ? v : null;
}

/** Decimal feet -> whole feet + inches (rounded to the nearest inch). */
export function partsFromFeet(feet: number): { ft: number; inches: number } {
  const total = Math.max(0, Math.round(feet * 12));
  return { ft: Math.floor(total / 12), inches: total % 12 };
}

/** Yards typed by the commissioner (0..700, whole yards), null when unusable. */
export function yardsFromText(raw: string): number | null {
  if (raw.trim() === "") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 700) return null;
  return Math.round(v);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

export interface DrinkRow {
  drink: Drink;
  player: Player | null;
  team: Team | null;
  loggedBy: Player | null;
  /** Derived credit for this drink (2 for a ghost beer). */
  value: number;
  ghost: boolean;
}

export interface DrinkFilter {
  teamId: UUID | null;
  hole: number | null;
}

/** Active drinks matching the filter, newest first. */
export function drinkRows(state: Pick<TripState, "drinks" | "players" | "teams">, d: Pick<Derived, "drinkValues">, filter: DrinkFilter): DrinkRow[] {
  const players = new Map(state.players.map((p) => [p.id, p]));
  const teams = new Map(state.teams.map((t) => [t.id, t]));
  return state.drinks
    .filter((x) => x.deleted_at === null)
    .filter((x) => (filter.teamId === null || x.team_id === filter.teamId) && (filter.hole === null || x.hole === filter.hole))
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at) || b.id.localeCompare(a.id))
    .map((drink) => {
      const dv = d.drinkValues[drink.id];
      return {
        drink,
        player: players.get(drink.player_id) ?? null,
        team: teams.get(drink.team_id) ?? null,
        loggedBy: drink.logged_by ? (players.get(drink.logged_by) ?? null) : null,
        value: dv?.value ?? 1,
        ghost: dv?.ghost ?? false,
      };
    });
}

export const DRINK_EMOJI: Record<Drink["type"], string> = { drink: "🍺", shotgun: "🥫", shot: "🥃" };
export const DRINK_LABEL: Record<Drink["type"], string> = { drink: "Drink", shotgun: "Shotgun", shot: "Shot" };

// ---------------------------------------------------------------------------
// Drive minimum
// ---------------------------------------------------------------------------

export interface DriveFlag {
  team_id: UUID;
  nine: 1 | 2;
  /** missed: the nine closed with these players at 0. at_risk: still open, hard/impossible. */
  kind: "missed" | "at_risk";
  players: UUID[];
  remaining: number;
}

export function driveFlags(d: Pick<Derived, "driveMin" | "teams">): DriveFlag[] {
  const out: DriveFlag[] = [];
  for (const t of d.teams) {
    const s = d.driveMin[t.id];
    if (!s) continue;
    for (const n of s.nines) {
      if (n.closed && n.missed.length > 0) {
        out.push({ team_id: t.id, nine: n.nine, kind: "missed", players: [...n.missed], remaining: 0 });
      } else if (!n.closed && (n.level === "hard" || n.level === "impossible") && n.needing.length > 0) {
        out.push({ team_id: t.id, nine: n.nine, kind: "at_risk", players: [...n.needing], remaining: n.remaining });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Round state
// ---------------------------------------------------------------------------

export function roundStateLabel(rs: Pick<TeamRoundState, "status" | "open_hole"> | null | undefined): string {
  if (!rs || rs.status === "not_started") return "Not started";
  if (rs.status === "complete") return "Round complete";
  return rs.open_hole ? `On hole ${rs.open_hole}` : "Playing";
}

export interface RoundFix {
  status: RoundStatus;
  open_hole: number | null;
}

/** Normalize a round-state edit to what round.set_state accepts. */
export function normalizeRoundFix(fix: RoundFix): RoundFix {
  if (fix.status === "not_started") return { status: "not_started", open_hole: null };
  const hole = Math.min(18, Math.max(1, Math.round(fix.open_hole ?? 1)));
  return { status: fix.status, open_hole: hole };
}

export function sameRound(a: Pick<TeamRoundState, "status" | "open_hole"> | null | undefined, b: RoundFix): boolean {
  const cur: RoundFix = a ? { status: a.status, open_hole: a.open_hole } : { status: "not_started", open_hole: null };
  const n = normalizeRoundFix(b);
  return cur.status === n.status && (n.status === "not_started" || cur.open_hole === n.open_hole);
}
