// Output shape of the scoring engine. The engine is pure TypeScript shared by
// client and server: derive(state) recomputes everything from raw rows on every
// change, so edits, moves and deletes are always safe.

import type {
  ContestEntry,
  ContestKind,
  Hole,
  HoleContest,
  ISODate,
  Player,
  PotKey,
  RoundStatus,
  Team,
  UUID,
  DrinkType,
} from "../types";

export type AwardKey =
  | "champions"
  | "didnt_need_the_beer"
  | "most_drinks"
  | "ghost_whisperers"
  | "longest_drive"
  | "closest_pin"
  | "biggest_beer_save"
  | "worst_hole"
  | "mulligan_merchant"
  | "edit_bandit"
  | "most_suspicious";

export interface Award {
  key: AwardKey;
  title: string;
  emoji: string;
  /** Winning team(s) for team awards (ties share). */
  team_ids: UUID[];
  /** Winning player(s) for individual awards (ties share). */
  player_ids: UUID[];
  /** e.g. "-14 net", "11 drinks (2 shotguns, 1 shot)", "287 yd", "3' 4\"". Empty when nobody qualifies. */
  value_label: string;
  /** Optional one-liner flavor text. */
  detail: string | null;
  /** Photo for Longest Drive / Closest Pin. */
  photo_path: string | null;
  /** false when nobody qualifies (e.g. no AI flags) — UI shows "Nobody. Boring." */
  awarded: boolean;
}

/** Per-drink derived value (ghost beer math). */
export interface DrinkValue {
  drink_id: UUID;
  team_id: UUID;
  player_id: UUID;
  hole: number;
  type: DrinkType;
  /** credit(d) - credit(d-1) where credit(d) = floor(base * d / n). */
  value: number;
  /** value > 1 */
  ghost: boolean;
  /** 1-based position among the team's active drinks ordered by (logged_at, id). */
  seq: number;
}

/** One line of a team's scorecard. Always 18 entries, hole 1..18. */
export interface TeamHoleLine {
  hole: number;
  par: number;
  contest: HoleContest;
  strokes: number | null;
  tee_shot_player_id: UUID | null;
  /** Active drinks credited to this hole. */
  drinks: number;
  /** Sum of drink values credited to this hole. */
  credit: number;
  /** strokes - credit; null when strokes not entered. Zero/negative allowed. */
  net: number | null;
  /** strokes - par; null when strokes not entered. */
  gross_to_par: number | null;
  /** net - par; null when strokes not entered. */
  net_to_par: number | null;
  edit_count: number;
}

export interface StandingRow {
  team_id: UUID;
  /** 1-based; tied teams share pos. Teams with thru 0 rank after all started teams. */
  pos: number;
  /** "1", "T2", or "–" when the team has not scored a hole. */
  pos_label: string;
  /** Holes with strokes entered. */
  thru: number;
  /** "F" when complete with 18 scored, "–" when 0, else String(thru). */
  thru_label: string;
  gross: number;
  /** Active drinks (all holes, including the open hole). */
  drinks: number;
  /** Sum of all drink credit (all holes, including the open hole). */
  credit: number;
  /** gross - credit */
  net: number;
  /** Sum of par over holes with strokes entered. */
  par_played: number;
  /** net - par_played. Sort key (equals sorting by net once everyone is thru 18). */
  net_to_par: number;
  gross_to_par: number;
  ghost_beers: number;
  status: RoundStatus;
  open_hole: number | null;
}

export type DriveLevel = "ok" | "soft" | "hard" | "impossible";

export interface DriveNineStatus {
  nine: 1 | 2;
  /** [1..9] or [10..18] */
  holes: number[];
  /** player_id -> tee shots used on this nine (par 3s count). Includes every current member (0 if none). */
  counts: Record<UUID, number>;
  /** Members with 0 drives on this nine. */
  needing: UUID[];
  /**
   * Holes on this nine, at or after the team's current hole, with no tee shot recorded yet.
   * 0 once the team has moved past the nine.
   */
  remaining: number;
  /**
   * ok: nobody needs a drive or plenty of holes left.
   * soft (yellow): someone needs a drive and remaining <= 3 (and remaining > needing.length).
   * hard (red): remaining === needing.length (> 0).
   * impossible (red): remaining < needing.length and the nine isn't closed.
   */
  level: DriveLevel;
  /** The team has moved past this nine (open_hole beyond it / round complete), or every hole on it has a tee shot. */
  closed: boolean;
  /** Members at 0 when the nine closed. */
  missed: UUID[];
}

export interface TeamDriveStatus {
  team_id: UUID;
  /** Nine containing the team's current hole (1 if not started). */
  current_nine: 1 | 2;
  nines: [DriveNineStatus, DriveNineStatus];
}

export interface MulliganBank {
  team_id: UUID;
  /** Active shotgun + shot drinks for the team. */
  earned: number;
  /** Active mulligan uses with source "earned". */
  used_earned: number;
  /** max(0, earned - used_earned) */
  available: number;
  groom_on_team: boolean;
  groom_used: boolean;
  groom_available: boolean;
  /** All active uses (earned + groom). */
  used_total: number;
}

export interface ContestEntryView {
  entry: ContestEntry;
  player_id: UUID;
  team_id: UUID;
  type: ContestKind;
  /**
   * Official distance. ctp: feet (distance_override ?? distance_value).
   * ld: yards (distance_override ?? haversine(hole tee point, entry lat/lng) when both exist ?? distance_value), rounded to the nearest yard.
   */
  distance: number;
  unit: "ft" | "yd";
  /** Counts toward winning. */
  valid: boolean;
  /** e.g. "Needs commissioner review: GPS was weak", "Out of range: 412 yd". null when valid. */
  invalid_reason: string | null;
  /** 1-based rank among valid entries (ties share), null when invalid. */
  rank: number | null;
  /** AI judge flagged it. Never affects validity. */
  suspicious: boolean;
}

export interface ContestHoleSummary {
  hole: number;
  type: ContestKind;
  pot_key: PotKey;
  /** All active entries: valid first (best first), then invalid. One active entry per player. */
  entries: ContestEntryView[];
  /** Player ids of the best valid entry (several on a tie). Empty when no valid entries. */
  leader_ids: UUID[];
  /** Best valid distance, null if none. */
  best: number | null;
  /** Every team has moved past this hole (open_hole > hole or round complete). */
  closed: boolean;
}

export interface RankPreview {
  /** 1-based rank the new distance would have among current valid entries (excluding the player's own existing entry). */
  rank: number;
  /** Current leader (excluding the player's own existing entry), null if none. */
  leader: ContestEntryView | null;
  /** Ordinal label: "1st", "T2nd", ... */
  label: string;
}

export type PotStatus = "pending" | "won" | "rolled" | "refunded";

export interface PotView {
  key: PotKey;
  type: "team_match" | "contest";
  hole: number | null;
  contest_type: ContestKind | null;
  /** "Team match", "Hole 3 · Closest to pin" */
  label: string;
  ante_cents: number;
  /** Players in this pot (not opted out, on a team). */
  participants: UUID[];
  /** ante_cents * participants.length */
  base_cents: number;
  rollover_in_cents: number;
  rolled_from: PotKey[];
  /** base + rollover_in */
  total_cents: number;
  /**
   * pending: contest hole not reached by every team and no valid entries yet (excluded from the ledger).
   * won: has winner(s) (projected while the trip isn't final).
   * rolled: no eligible valid entries once closed -> rolled into rolled_to.
   * refunded: nobody can win and nowhere to roll (antes returned).
   */
  status: PotStatus;
  rolled_to: PotKey | null;
  /** Player ids receiving money. */
  winners: UUID[];
  /** player_id -> cents won from this pot. Sums to total_cents when status is won. */
  payouts: Record<UUID, number>;
}

export interface LedgerRow {
  player_id: UUID;
  antes_cents: number;
  winnings_cents: number;
  /** winnings - antes. All rows sum to exactly 0. */
  net_cents: number;
}

export interface Payment {
  from_player_id: UUID;
  to_player_id: UUID;
  amount_cents: number;
}

export interface MoneySummary {
  /** true once the trip status is final (otherwise projected). */
  final: boolean;
  pots: PotView[];
  ledger: LedgerRow[];
  /** Minimized payments: repeatedly match biggest debtor with biggest creditor. */
  payments: Payment[];
  /** Sum of total_cents over won + refunded pots (= total antes charged = total paid out; rolled money counted once). */
  total_in_play_cents: number;
}

export interface DrinkerRow {
  player_id: UUID;
  team_id: UUID | null;
  drinks: number;
  shotguns: number;
  shots: number;
  /** drinks + shotguns + shots */
  total: number;
  /** Drink logs with a photo of the empty. */
  photos: number;
}

export interface Derived {
  /** Active players sorted by sort_order, name. */
  players: Player[];
  /** Active teams sorted by sort_order, name. */
  teams: Team[];
  /** Holes sorted by number. */
  holes: Hole[];
  playerById: Record<UUID, Player>;
  teamById: Record<UUID, Team>;
  holeByNumber: Record<number, Hole>;
  /** player_id -> team_id */
  teamOfPlayer: Record<UUID, UUID>;
  /** team_id -> active members sorted by sort_order, name */
  membersOfTeam: Record<UUID, Player[]>;
  /** team_id -> member count (2..4) */
  teamSize: Record<UUID, number>;
  groomId: UUID | null;
  drinkValues: Record<UUID, DrinkValue>;
  /** team_id -> 18 lines */
  teamHoles: Record<UUID, TeamHoleLine[]>;
  /** Sorted: started teams by net_to_par then name; not-started teams last. */
  standings: StandingRow[];
  /** Team ids at pos 1 among teams with thru > 0. Empty before anyone scores. */
  leaderTeamIds: UUID[];
  /** team_id -> hole whose drink window is open, null if none (not started / complete). */
  openWindow: Record<UUID, number | null>;
  /** team_id -> the hole the Play screen should show (open hole, 1 if not started, 18 if complete). */
  currentHole: Record<UUID, number>;
  driveMin: Record<UUID, TeamDriveStatus>;
  mulligans: Record<UUID, MulliganBank>;
  /** One per contest hole, sorted by hole. */
  contests: ContestHoleSummary[];
  /** Sorted by total desc. Every active player on a team. */
  drinkers: DrinkerRow[];
  money: MoneySummary;
  /** Computed from current data; the UI shows them once the trip is final. */
  awards: Award[];
  computed_at: ISODate;
}
