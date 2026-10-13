// Pure helpers for the commissioner's live-round tools (unit-tested in tests/ui/course-commish.test.ts).
import type { ContestEntry, ContestKind, Drink, DrinkType, Player, RoundStatus, Team, TeamRoundState, TripState, UUID } from "@/lib/types";
import type { ContestEntryView, ContestHoleSummary, Derived, PotView } from "@/lib/engine/types";
import type { OpInput } from "@/lib/ops";
import { contestScore } from "@/lib/engine/contests";
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

/**
 * Queue items whose ruling can move money, for the finalize check, judged against each contest
 * pot's participants (`pots` = derived.money.pots; a player who opted out of a hole's pot can't
 * win it): entries that don't count yet (flagged, out of range) but would take or tie the pot if
 * approved, and AI-suspicious entries that currently win it. Informational items (weak-GPS note on
 * a drive that already counts, a suspicious entry that isn't winning, anything by a player outside
 * the pot) can't change a pot and stay out. Without pots, every player counts as in the pot.
 */
export function pendingRulings(contests: readonly ContestHoleSummary[], pots: readonly PotView[] = []): ReviewItem[] {
  const potByKey = new Map(pots.map((p) => [p.key, p]));
  const out: ReviewItem[] = [];
  for (const c of contests) {
    const pot = potByKey.get(c.pot_key);
    const inPot = pot ? new Set(pot.participants) : null;
    const entries = c.entries.filter((v) => !inPot || inPot.has(v.player_id));
    const best = entries.filter((v) => v.valid).reduce((min, v) => Math.min(min, contestScore(c.type, v.distance)), Number.POSITIVE_INFINITY);
    for (const v of entries) {
      const reasons = reviewReasons(v);
      if (reasons.length === 0) continue;
      const wouldTake = !v.valid && Number.isFinite(v.distance) && contestScore(c.type, v.distance) <= best;
      const suspiciousWinner = v.valid && v.suspicious && (pot ? pot.winners.includes(v.player_id) : v.rank === 1);
      if (wouldTake || suspiciousWinner) out.push({ view: v, hole: c.hole, reasons, needsReview: true });
    }
  }
  return out.sort((a, b) => a.hole - b.hole || a.view.entry.created_at.localeCompare(b.view.entry.created_at));
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
  /** Hole the drink counts on (engine's effective hole; can differ from the phone-stamped drink.hole). */
  hole: number;
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
    .filter((x) => (filter.teamId === null || x.team_id === filter.teamId) && (filter.hole === null || (d.drinkValues[x.id]?.hole ?? x.hole) === filter.hole))
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at) || b.id.localeCompare(a.id))
    .map((drink) => {
      const dv = d.drinkValues[drink.id];
      return {
        drink,
        player: players.get(drink.player_id) ?? null,
        team: teams.get(drink.team_id) ?? null,
        loggedBy: drink.logged_by ? (players.get(drink.logged_by) ?? null) : null,
        hole: dv?.hole ?? drink.hole,
        value: dv?.value ?? 1,
        ghost: dv?.ghost ?? false,
      };
    });
}

export const DRINK_EMOJI: Record<Drink["type"], string> = { drink: "🍺", shotgun: "🥫", shot: "🥃" };
export const DRINK_LABEL: Record<Drink["type"], string> = { drink: "Drink", shotgun: "Shotgun", shot: "Shot" };

// ---------------------------------------------------------------------------
// Commissioner adds (day-of fallback: a dead phone, the cart kept paper)
// ---------------------------------------------------------------------------

/** Where an added drink most likely belongs: the team's open hole (18 once done), else hole 1. */
export function defaultAddHole(rs: Pick<TeamRoundState, "status" | "open_hole"> | null | undefined): number {
  if (!rs || rs.status === "not_started" || rs.open_hole === null) return 1;
  return rs.open_hole;
}

export interface AddDrinkDraft {
  teamId: UUID | null;
  playerId: UUID | null;
  hole: number | null;
  type: DrinkType;
}

/**
 * drink.log for a drink the commissioner adds after the fact: any team, player, hole and type,
 * window open or not (as_commissioner skips the window check and the drink cap). null until complete.
 */
export function addDrinkInput(d: AddDrinkDraft, drinkId: UUID): OpInput | null {
  if (!d.teamId || !d.playerId || d.hole === null || !Number.isInteger(d.hole) || d.hole < 1 || d.hole > 18) return null;
  return {
    type: "drink.log",
    drink_id: drinkId,
    team_id: d.teamId,
    player_id: d.playerId,
    hole: d.hole,
    drink_type: d.type,
    photo_path: null,
    as_commissioner: true,
  };
}

export interface AddEntryDraft {
  hole: number | null;
  type: ContestKind | null;
  playerId: UUID | null;
  /** ctp: decimal feet; ld: whole yards (feetFromParts / yardsFromText). */
  distance: number | null;
}

/**
 * contest.submit for an entry the commissioner types in for anyone (no GPS, no photo): the distance
 * as given. Replaces that player's current entry on the hole, like a re-measure. null until complete.
 */
export function addEntryInput(d: AddEntryDraft, entryId: UUID): OpInput | null {
  if (d.hole === null || !d.type || !d.playerId || d.distance === null || !Number.isFinite(d.distance) || d.distance < 0) return null;
  return {
    type: "contest.submit",
    entry_id: entryId,
    hole: d.hole,
    player_id: d.playerId,
    contest_type: d.type,
    distance_value: d.distance,
    angle_deg: null,
    lat: null,
    lng: null,
    gps_accuracy_m: null,
    low_accuracy: false,
    photo_path: null,
    as_commissioner: true,
  };
}

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
