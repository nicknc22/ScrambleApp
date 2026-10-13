// applyOp: the ONE place op semantics live. Pure and immutable (returns new arrays for changed
// tables; untouched tables keep identity). Used by the client (optimistic view = snapshot + pending
// ops) and by the server (inside a per-trip lock; `writes` are persisted to Postgres).
// Semantics are specified in CLAUDE.md "Reducer semantics".
import {
  DEFAULT_SETTINGS,
  REACTION_KINDS,
  type AiConfidence,
  type AnyRow,
  type ContestEntry,
  type Drink,
  type FeedEvent,
  type Hole,
  type HoleContest,
  type HoleScore,
  type ISODate,
  type Mulligan,
  type Player,
  type PotOptout,
  type Reaction,
  type RowOf,
  type RowTable,
  type Team,
  type TeamMember,
  type TeamRoundState,
  type TeeSet,
  type Trip,
  type TripSettings,
  type TripState,
  type UUID,
} from "./types";
import {
  COMMISSIONER_ONLY_OPS,
  type ContestDeleteOp,
  type ContestReviewOp,
  type ContestSubmitOp,
  type DrinkDeleteOp,
  type DrinkLogOp,
  type DrinkMoveOp,
  type FeedDeleteOp,
  type HoleUpdateOp,
  type MulliganUndoOp,
  type MulliganUseOp,
  type Op,
  type OpType,
  type PlayerDeleteOp,
  type PlayerMuteOp,
  type PlayerUpsertOp,
  type PostCreateOp,
  type PotOptoutOp,
  type ReactionSetOp,
  type RejectCode,
  type RoundCompleteOp,
  type RoundSetStateOp,
  type ScoreSetOp,
  type TeamAssignOp,
  type TeamDeleteOp,
  type TeamUpsertOp,
  type TeeOpenOp,
  type TeeShotSetOp,
  type TripStartOp,
  type TripUpdateOp,
} from "./ops";
import { contestForPar } from "./course";
import { deriveId } from "./ids";
import { openWindowHole } from "./engine/windows";
import { isTripPhotoPath } from "./photos";

export interface ApplyCtx {
  /** Server time on the server; client time on the client. Used for created_at/updated_at/deleted_at. */
  now: ISODate;
  is_commissioner: boolean;
  side: "client" | "server";
}

export type Write =
  | { kind: "upsert"; table: RowTable; row: AnyRow }
  | { kind: "delete"; table: RowTable; id: UUID }
  | { kind: "trip"; row: Trip };

export type ApplyResult =
  | { ok: true; state: TripState; writes: Write[] }
  | { ok: false; code: RejectCode; reason: string };

/**
 * Play ops: require trip.status === "live" (or "final" for a commissioner override, or for a late
 * sync of something that happened before the commissioner finalized).
 */
export const PLAY_OPS: ReadonlySet<OpType> = new Set<OpType>([
  "tee.open",
  "round.complete",
  "score.set",
  "teeshot.set",
  "drink.log",
  "drink.delete",
  "mulligan.use",
  "mulligan.undo",
  "contest.submit",
  "contest.delete",
]);

export const MAX_STROKES = 20;
export const MAX_POST_CHARS = 1000;
export const MAX_TEAM_SIZE = 4;
export const MIN_TEAM_SIZE = 2;
export const CTP_MAX_FT = 200;
export const LD_MAX_YD = 700;
const MAX_NAME_CHARS = 80;
/**
 * Clock-skew allowance between phones and the server: a play op stamped up to this long after the
 * trip was finalized (or after its team tapped Round complete) still counts as "during the round".
 */
export const CLOCK_GRACE_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

class Rejection {
  constructor(
    readonly code: RejectCode,
    readonly reason: string,
  ) {}
}

function reject(code: RejectCode, reason: string): never {
  throw new Rejection(code, reason);
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/** Drop undefined values so a patch never overwrites a field with `undefined`. */
function defined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

const isActive = (r: { deleted_at: ISODate | null }) => r.deleted_at === null;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const time = (iso: ISODate) => Date.parse(iso);
/** a is strictly later than b (client timestamps; unparseable a never wins). */
const isAfter = (a: ISODate | null, b: ISODate) => a !== null && time(a) > time(b);
const uniqSorted = (xs: number[]) => Array.from(new Set(xs)).sort((x, y) => x - y);

function requireId(v: unknown, what: string): UUID {
  if (!isId(v)) reject("invalid", `Missing ${what} id. Somebody's phone is drunk.`);
  return v;
}

function requireHole(v: unknown): number {
  if (!isInt(v) || v < 1 || v > 18) {
    reject("invalid", `Hole ${String(v)}? There are 18 holes. The 19th is the bar.`);
  }
  return v;
}

/** Optional photo: null, or a `trips/<this trip>/<kind>/<uuid>.jpg` path (never a URL or data: URI). */
function optPhoto(s: TripState, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (!isTripPhotoPath(v, s.trip.id)) reject("invalid", "That photo isn't from this trip. Nice try, Photoshop.");
  return v;
}

/** `at` is more than CLOCK_GRACE_MS after `ref` (client timestamps). */
const pastGrace = (at: ISODate, ref: ISODate) => time(at) > time(ref) + CLOCK_GRACE_MS;

/**
 * AI judge rule (same as server/judge.ts isSuspicious): the claim is under `ratio` × the AI's
 * estimate and the AI isn't low-confidence.
 */
function isSuspiciousClaim(claimedFt: number, estimateFt: number, confidence: AiConfidence, ratio: number): boolean {
  const r = isFiniteNum(ratio) && ratio > 0 ? ratio : DEFAULT_SETTINGS.judge_suspicious_ratio;
  return confidence !== "low" && claimedFt < r * estimateFt;
}

function optFinite(v: unknown, what: string, min: number, max: number): number | null {
  if (v === null || v === undefined) return null;
  if (!isFiniteNum(v) || v < min || v > max) reject("invalid", `Bad ${what}.`);
  return v;
}

function requireName(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") reject("invalid", `${what} needs a name. "Hey you" won't fit on the leaderboard.`);
  const name = v.trim();
  if (name.length > MAX_NAME_CHARS) reject("invalid", `That name is longer than a par 5. Keep it under ${MAX_NAME_CHARS} characters.`);
  return name;
}

function contestLabel(c: HoleContest): string {
  return c === "ctp" ? "closest to pin" : c === "ld" ? "long drive" : "not a contest hole";
}

// ---------------------------------------------------------------------------
// State lookups
// ---------------------------------------------------------------------------

function activeTeam(s: TripState, id: unknown): Team | undefined {
  return s.teams.find((t) => t.id === id && t.deleted_at === null);
}

function requireTeam(s: TripState, id: unknown): Team {
  const team = activeTeam(s, requireId(id, "team"));
  if (!team) reject("not_found", "That team doesn't exist (anymore).");
  return team;
}

function activePlayer(s: TripState, id: unknown): Player | undefined {
  return s.players.find((p) => p.id === id && p.deleted_at === null);
}

function requirePlayer(s: TripState, id: unknown): Player {
  const player = activePlayer(s, requireId(id, "player"));
  if (!player) reject("not_found", "Who? That player isn't on the roster.");
  return player;
}

/** The player's team: their membership row on an active team. */
function teamIdOfPlayer(s: TripState, playerId: UUID): UUID | null {
  for (const m of s.team_members) {
    if (m.player_id === playerId && activeTeam(s, m.team_id)) return m.team_id;
  }
  return null;
}

/** Active players with a membership on the team. */
function membersOf(s: TripState, teamId: UUID): Player[] {
  const ids = new Set(s.team_members.filter((m) => m.team_id === teamId).map((m) => m.player_id));
  return s.players.filter((p) => p.deleted_at === null && ids.has(p.id));
}

function isMember(s: TripState, teamId: UUID, playerId: UUID): boolean {
  return s.team_members.some((m) => m.team_id === teamId && m.player_id === playerId);
}

function roundStateOf(s: TripState, teamId: UUID): TeamRoundState | undefined {
  return s.team_round_state.find((rs) => rs.team_id === teamId);
}

/** op.by when it names a known player (FK-safe), else null. */
function actorId(s: TripState, op: Op): UUID | null {
  return isId(op.by) && s.players.some((p) => p.id === op.by) ? op.by : null;
}

/** op.by plays on `teamId` (players act for themselves and teammates; anyone else needs the commissioner). */
function actsForTeam(s: TripState, op: Op, teamId: UUID): boolean {
  return isId(op.by) && teamIdOfPlayer(s, op.by) === teamId;
}

function teamName(s: TripState, teamId: UUID): string {
  return s.teams.find((t) => t.id === teamId)?.name ?? "another team";
}

// ---------------------------------------------------------------------------
// Transaction: accumulates the new state and the writes for one op
// ---------------------------------------------------------------------------

class Tx {
  state: TripState;
  private readonly writes = new Map<string, Write>();

  constructor(
    private readonly base: TripState,
    readonly ctx: ApplyCtx,
    readonly op: Op,
  ) {
    this.state = base;
  }

  get now(): ISODate {
    return this.ctx.now;
  }

  /** Commissioner acting with override powers (the gate already checked the cookie). */
  get override(): boolean {
    return !!this.op.as_commissioner && this.ctx.is_commissioner;
  }

  private rows<T extends RowTable>(table: T): RowOf<T>[] {
    return this.state[table] as unknown as RowOf<T>[];
  }

  private setRows<T extends RowTable>(table: T, rows: RowOf<T>[]): void {
    this.state = { ...this.state, [table]: rows } as TripState;
  }

  /** Insert a new row, or replace the row with the same id. No write when nothing changed. */
  put<T extends RowTable>(table: T, row: RowOf<T>): void {
    const rows = this.rows(table);
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0 && deepEqual(rows[i], row)) return;
    this.setRows(table, i >= 0 ? rows.map((r, j) => (j === i ? row : r)) : [...rows, row]);
    this.writes.set(`${table}:${row.id}`, { kind: "upsert", table, row });
  }

  /**
   * Merge `patch` into the latest version of `row`. No-op when nothing changes; otherwise stamps
   * updated_at (for tables that have it) with ctx.now.
   */
  patch<T extends RowTable>(table: T, row: RowOf<T>, patch: Partial<RowOf<T>>): void {
    const current = this.rows(table).find((r) => r.id === row.id) ?? row;
    const next = { ...current, ...defined(patch) } as RowOf<T>;
    if (deepEqual(next, current)) return;
    if ("updated_at" in next) (next as { updated_at: ISODate }).updated_at = this.now;
    this.put(table, next);
  }

  /** Hard delete (only team_members rows are ever hard-deleted). */
  remove(table: RowTable, id: UUID): void {
    const rows = this.rows(table);
    if (!rows.some((r) => r.id === id)) return;
    this.setRows(table, rows.filter((r) => r.id !== id));
    this.writes.set(`${table}:${id}`, { kind: "delete", table, id });
  }

  patchTrip(patch: Partial<Trip>): void {
    const current = this.state.trip;
    const next: Trip = { ...current, ...defined(patch) };
    if (deepEqual(next, current)) return;
    next.updated_at = this.now;
    this.state = { ...this.state, trip: next };
    this.writes.set("trip", { kind: "trip", row: next });
  }

  result(): ApplyResult {
    // A no-op returns the input state itself (identity preserved for memoization).
    if (this.writes.size === 0) return { ok: true, state: this.base, writes: [] };
    return { ok: true, state: this.state, writes: [...this.writes.values()] };
  }
}

// ---------------------------------------------------------------------------
// Row constructors (always complete rows)
// ---------------------------------------------------------------------------

function newRoundState(tx: Tx, id: UUID, teamId: UUID): TeamRoundState {
  return {
    id,
    trip_id: tx.state.trip.id,
    team_id: teamId,
    open_hole: null,
    started_holes: [],
    hole_opened_at: {},
    status: "not_started",
    completed_at: null,
    updated_at: tx.now,
  };
}

function newHoleScore(tx: Tx, teamId: UUID, hole: number): HoleScore {
  return {
    id: deriveId(teamId, String(hole)),
    trip_id: tx.state.trip.id,
    team_id: teamId,
    hole,
    strokes: null,
    tee_shot_player_id: null,
    strokes_at: null,
    tee_shot_at: null,
    edit_count: 0,
    updated_by: null,
    updated_at: tx.now,
  };
}

// ---------------------------------------------------------------------------
// Drink windows
// ---------------------------------------------------------------------------

/**
 * Open `hole` for the team: tee.open semantics after validation. The window only moves forward:
 * a hole at or before the current open hole is a no-op. Creates the round state row if missing.
 */
function openHole(tx: Tx, teamId: UUID, hole: number): void {
  const existing = roundStateOf(tx.state, teamId);
  if (existing && existing.open_hole !== null && hole <= existing.open_hole) return;
  const rs = existing ?? newRoundState(tx, tx.op.id, teamId);
  const key = String(hole);
  tx.put("team_round_state", {
    ...rs,
    open_hole: hole,
    started_holes: uniqSorted([...rs.started_holes, hole]),
    // Keep the first time a hole opened.
    hole_opened_at: rs.hole_opened_at[key] !== undefined ? rs.hole_opened_at : { ...rs.hole_opened_at, [key]: tx.op.at },
    status: "playing",
    // Only a commissioner can reopen a complete round this way; it's no longer complete.
    completed_at: rs.status === "complete" ? null : rs.completed_at,
    updated_at: tx.now,
  });
}

/** "Entering any data for hole N+1 closes N": score/tee shot on open_hole+1 opens it (hole 1 when not started). */
function implicitOpen(tx: Tx, teamId: UUID, hole: number): void {
  const rs = roundStateOf(tx.state, teamId);
  if (rs?.status === "complete") return;
  if (hole !== (rs?.open_hole ?? 0) + 1) return;
  openHole(tx, teamId, hole);
}

// ---------------------------------------------------------------------------
// Play ops
// ---------------------------------------------------------------------------

function teeOpen(tx: Tx, op: TeeOpenOp): void {
  const team = requireTeam(tx.state, op.team_id);
  const hole = requireHole(op.hole);
  const rs = roundStateOf(tx.state, team.id);
  if (rs?.status === "complete" && !tx.override) {
    reject("conflict", `${team.name} already finished the round. The 19th hole is the bar.`);
  }
  openHole(tx, team.id, hole);
}

function roundComplete(tx: Tx, op: RoundCompleteOp): void {
  const team = requireTeam(tx.state, op.team_id);
  const existing = roundStateOf(tx.state, team.id);
  if (existing?.status === "complete") return;
  const rs = existing ?? newRoundState(tx, op.id, team.id);
  // open_hole stays where it is (18 normally); the window closes because status is complete.
  tx.put("team_round_state", { ...rs, status: "complete", completed_at: op.at, updated_at: tx.now });
}

function scoreSet(tx: Tx, op: ScoreSetOp): void {
  const team = requireTeam(tx.state, op.team_id);
  const hole = requireHole(op.hole);
  if (!isInt(op.strokes) || op.strokes < 1 || op.strokes > MAX_STROKES) {
    reject("invalid", `Strokes must be a whole number from 1 to ${MAX_STROKES}. Pick up, my guy.`);
  }
  const existing = tx.state.hole_scores.find((r) => r.team_id === team.id && r.hole === hole);
  // LWW by client time: an older (e.g. offline) edit never clobbers a newer one. It's rejected
  // (so the losing phone hears about it) unless it agrees with the stored value. A commissioner
  // override always wins, so a phone with a clock set in the future can't lock a hole forever.
  if (existing && isAfter(existing.strokes_at, op.at) && !tx.override) {
    if (existing.strokes === op.strokes) return;
    reject("conflict", `Hole ${hole} already got a newer edit: ${existing.strokes ?? "no score"}. Your ${op.strokes} lost the race.`);
  }
  const by = actorId(tx.state, op);
  if (existing) {
    const changed = existing.strokes !== null && existing.strokes !== op.strokes;
    tx.patch("hole_scores", existing, {
      strokes: op.strokes,
      strokes_at: op.at,
      updated_by: by,
      edit_count: existing.edit_count + (changed ? 1 : 0),
    });
  } else {
    tx.put("hole_scores", { ...newHoleScore(tx, team.id, hole), strokes: op.strokes, strokes_at: op.at, updated_by: by });
  }
  implicitOpen(tx, team.id, hole);
}

function teeShotSet(tx: Tx, op: TeeShotSetOp): void {
  const team = requireTeam(tx.state, op.team_id);
  const hole = requireHole(op.hole);
  const playerId = op.player_id;
  if (playerId !== null) {
    const player = requirePlayer(tx.state, playerId);
    if (!isMember(tx.state, team.id, player.id)) {
      reject("invalid", `${player.name} isn't on ${team.name}. Their drive doesn't count here.`);
    }
  }
  const existing = tx.state.hole_scores.find((r) => r.team_id === team.id && r.hole === hole);
  // LWW, as in score.set.
  if (existing && isAfter(existing.tee_shot_at, op.at) && !tx.override) {
    if (existing.tee_shot_player_id === playerId) return;
    const current = tx.state.players.find((p) => p.id === existing.tee_shot_player_id)?.name ?? "nobody";
    reject("conflict", `Hole ${hole}'s tee shot already got a newer edit: ${current}.`);
  }
  const by = actorId(tx.state, op);
  if (existing) {
    tx.patch("hole_scores", existing, { tee_shot_player_id: playerId, tee_shot_at: op.at, updated_by: by });
  } else {
    tx.put("hole_scores", { ...newHoleScore(tx, team.id, hole), tee_shot_player_id: playerId, tee_shot_at: op.at, updated_by: by });
  }
  implicitOpen(tx, team.id, hole);
}

const DRINK_TYPES = ["drink", "shotgun", "shot"] as const;

function drinkLog(tx: Tx, op: DrinkLogOp): void {
  const s = tx.state;
  if (s.drinks.some((d) => d.id === op.drink_id)) return; // already logged: idempotent
  const id = requireId(op.drink_id, "drink");
  const team = requireTeam(s, op.team_id);
  const player = requirePlayer(s, op.player_id);
  if (!isMember(s, team.id, player.id)) {
    reject("invalid", `${player.name} isn't on ${team.name}. Log it on their own team, you thief.`);
  }
  const hole = requireHole(op.hole);
  if (!(DRINK_TYPES as readonly string[]).includes(op.drink_type)) reject("invalid", "Drink, Shotgun or Shot. Pick one.");
  const photo = optPhoto(s, op.photo_path);

  // The client refuses drinks with no open window. The server trusts the client-stamped hole so a
  // phone that was offline (and saw a window open at the time) never loses a drink, except a
  // drink logged after the team tapped Round complete (+ clock grace): hole 18's window was shut.
  // The commissioner can add a drink anywhere.
  if (!tx.override) {
    const rs = roundStateOf(s, team.id);
    const closed =
      tx.ctx.side === "client"
        ? openWindowHole(rs) === null
        : rs?.status === "complete" && rs.completed_at !== null && pastGrace(op.at, rs.completed_at);
    if (closed) {
      reject(
        "no_window",
        rs?.status === "complete"
          ? "Round's over. That one's just for fun now."
          : "Drinks before the first tee shot don't count. Tap On the tee for hole 1 first, you degenerate.",
      );
    }
  }

  const cap = s.trip.settings.drink_cap;
  if (cap !== null && cap !== undefined && !tx.override) {
    const count = s.drinks.filter((d) => d.player_id === player.id && isActive(d)).length;
    if (count >= cap) reject("conflict", `Drink cap reached (${cap}) for ${player.name}. Hydrate, legend.`);
  }

  const row: Drink = {
    id,
    trip_id: s.trip.id,
    team_id: team.id,
    player_id: player.id,
    hole,
    type: op.drink_type,
    photo_path: photo,
    logged_by: actorId(s, op),
    logged_at: op.at,
    created_at: tx.now,
    deleted_at: null,
    deleted_by: null,
    moved_from_hole: null,
  };
  tx.put("drinks", row);
}

function drinkDelete(tx: Tx, op: DrinkDeleteOp): void {
  const drink = tx.state.drinks.find((d) => d.id === op.drink_id);
  if (!drink) reject("not_found", "That drink doesn't exist. Did you dream it?");
  if (!isActive(drink)) return;
  if (!tx.override && !actsForTeam(tx.state, op, drink.team_id)) {
    reject("forbidden", `That's ${teamName(tx.state, drink.team_id)}'s drink. Only they (or the commissioner) can undo it.`);
  }
  tx.patch("drinks", drink, { deleted_at: tx.now, deleted_by: actorId(tx.state, op) });
}

function drinkMove(tx: Tx, op: DrinkMoveOp): void {
  const drink = tx.state.drinks.find((d) => d.id === op.drink_id);
  if (!drink || !isActive(drink)) reject("not_found", "That drink doesn't exist (or was undone).");
  const hole = requireHole(op.hole);
  if (drink.hole === hole) return;
  tx.patch("drinks", drink, { hole, moved_from_hole: drink.moved_from_hole ?? drink.hole });
}

function mulliganUse(tx: Tx, op: MulliganUseOp): void {
  const s = tx.state;
  if (s.mulligans.some((m) => m.id === op.mulligan_id)) return; // idempotent
  const id = requireId(op.mulligan_id, "mulligan");
  const team = requireTeam(s, op.team_id);
  const hole = requireHole(op.hole);
  // Unused mulligans expire at the end of the round (the server allows clock grace, like drinks).
  const rs = roundStateOf(s, team.id);
  if (rs?.status === "complete" && !tx.override) {
    if (tx.ctx.side === "client" || (rs.completed_at !== null && pastGrace(op.at, rs.completed_at))) {
      reject("conflict", `${team.name} already finished the round. Unused mulligans expired on 18.`);
    }
  }
  if (op.source === "earned") {
    // Bank = active shotgun + shot drinks minus active earned uses (deleting the drink voids it).
    const earned = s.drinks.filter((d) => d.team_id === team.id && isActive(d) && (d.type === "shotgun" || d.type === "shot")).length;
    const used = s.mulligans.filter((m) => m.team_id === team.id && isActive(m) && m.source === "earned").length;
    if (earned - used <= 0) reject("conflict", "No mulligans in the bank. Shotgun something.");
  } else if (op.source === "groom") {
    const grooms = s.players.filter((p) => isActive(p) && p.is_groom);
    if (!grooms.some((g) => teamIdOfPlayer(s, g.id) === team.id)) {
      reject("conflict", "The Groom's Mulligan rides with the groom's team only. Nice try, freeloader.");
    }
    if (s.mulligans.some((m) => isActive(m) && m.source === "groom")) {
      reject("conflict", "The Groom's Mulligan is already spent. One per round, like a vow.");
    }
  } else {
    reject("invalid", "Earned or Groom's. Those are the only mulligans.");
  }
  const row: Mulligan = {
    id,
    trip_id: s.trip.id,
    team_id: team.id,
    source: op.source,
    used_on_hole: hole,
    used_by: actorId(s, op),
    used_at: op.at,
    created_at: tx.now,
    deleted_at: null,
  };
  tx.put("mulligans", row);
}

function mulliganUndo(tx: Tx, op: MulliganUndoOp): void {
  const m = tx.state.mulligans.find((x) => x.id === op.mulligan_id);
  if (!m) reject("not_found", "That mulligan doesn't exist. Can't undo a do-over you never did.");
  if (!isActive(m)) return;
  if (!tx.override && !actsForTeam(tx.state, op, m.team_id)) {
    reject("forbidden", `That's ${teamName(tx.state, m.team_id)}'s mulligan. Only they (or the commissioner) can undo it.`);
  }
  tx.patch("mulligans", m, { deleted_at: tx.now });
}

type AiJudgement = Pick<ContestEntry, "ai_estimate_ft" | "ai_confidence" | "ai_suspicious" | "ai_roast">;
const UNJUDGED: AiJudgement = { ai_estimate_ft: null, ai_confidence: null, ai_suspicious: null, ai_roast: null };

/**
 * A closest-to-pin edit on the SAME photo keeps the AI judge's read of that photo and re-judges the
 * new claim against it (so retyping the number can't shed a suspicious flag). Otherwise unjudged:
 * the judge runs on the new entry's photo after commit.
 */
function keptJudgement(replaced: ContestEntry[], photo: string | null, claimedFt: number, ratio: number): AiJudgement {
  const prev = photo ? replaced.find((e) => e.photo_path === photo) : undefined;
  if (!prev || prev.ai_estimate_ft === null || prev.ai_confidence === null) return UNJUDGED;
  return {
    ai_estimate_ft: prev.ai_estimate_ft,
    ai_confidence: prev.ai_confidence,
    ai_suspicious: isSuspiciousClaim(claimedFt, prev.ai_estimate_ft, prev.ai_confidence, ratio),
    ai_roast: prev.ai_roast,
  };
}

function contestSubmit(tx: Tx, op: ContestSubmitOp): void {
  const s = tx.state;
  if (s.contest_entries.some((e) => e.id === op.entry_id)) return; // idempotent
  const id = requireId(op.entry_id, "entry");
  const holeNo = requireHole(op.hole);
  const hole = s.holes.find((h) => h.number === holeNo);
  if (!hole) reject("not_found", `Hole ${holeNo} isn't set up.`);
  const type = op.contest_type;
  if (type !== "ctp" && type !== "ld") reject("invalid", "Closest to pin or long drive. Pick one.");
  if (hole.contest !== type) {
    reject("invalid", `Hole ${holeNo} is ${contestLabel(hole.contest)}, not ${contestLabel(type)}.`);
  }
  const player = requirePlayer(s, op.player_id);
  const teamId = teamIdOfPlayer(s, player.id);
  if (!teamId) reject("conflict", `${player.name} isn't on a team, so no contests. Rules.`);
  // A submit replaces the player's entry, so it follows contest.delete's rule: the player or a
  // teammate (the commissioner can enter for anyone).
  if (!tx.override && !actsForTeam(s, op, teamId)) {
    reject("forbidden", `Only ${player.name}'s team can enter for ${player.name}. Or the commissioner.`);
  }

  const d = op.distance_value;
  if (type === "ctp" && (!isFiniteNum(d) || d < 0 || d > CTP_MAX_FT)) {
    reject("invalid", `Closest to pin must be 0 to ${CTP_MAX_FT} ft. Any further and it isn't close.`);
  }
  if (type === "ld" && (!isFiniteNum(d) || d < 0 || d > LD_MAX_YD)) {
    reject("invalid", `Long drive must be 0 to ${LD_MAX_YD} yd. You are not Bryson.`);
  }
  const angle = optFinite(op.angle_deg, "marker angle", -360, 360);
  const lat = optFinite(op.lat, "latitude", -90, 90);
  const lng = optFinite(op.lng, "longitude", -180, 180);
  const acc = optFinite(op.gps_accuracy_m, "GPS accuracy", 0, Number.MAX_VALUE);
  const photo = optPhoto(s, op.photo_path);
  const lowAccuracy = op.low_accuracy === true;

  // Long drive: a position we can't trust routes to the commissioner instead of counting. The
  // sanity range is NOT stored: the engine re-checks it against the current tee point and settings.
  let status: ContestEntry["status"] = "ok";
  let flagReason: string | null = null;
  if (type === "ld") {
    if (op.simulated === true && !tx.override && !s.trip.is_demo) {
      status = "flagged";
      flagReason = "Simulated GPS";
    } else if (lowAccuracy) {
      status = "flagged";
      flagReason = "GPS was weak";
    }
  }

  // Re-measure replaces: the player's other active entries on this hole go away.
  const replaced = s.contest_entries.filter((e) => e.player_id === player.id && e.hole === holeNo && isActive(e));
  for (const e of replaced) tx.patch("contest_entries", e, { deleted_at: tx.now });

  const ai = type === "ctp" ? keptJudgement(replaced, photo, d, s.trip.settings.judge_suspicious_ratio) : UNJUDGED;

  const row: ContestEntry = {
    id,
    trip_id: s.trip.id,
    hole: holeNo,
    player_id: player.id,
    team_id: teamId,
    type,
    distance_value: d,
    unit: type === "ctp" ? "ft" : "yd",
    distance_override: null,
    angle_deg: angle,
    lat,
    lng,
    gps_accuracy_m: acc,
    low_accuracy: lowAccuracy,
    photo_path: photo,
    ...ai,
    status,
    flag_reason: flagReason,
    created_at: tx.now,
    updated_at: tx.now,
    deleted_at: null,
  };
  tx.put("contest_entries", row);
}

function contestDelete(tx: Tx, op: ContestDeleteOp): void {
  const e = tx.state.contest_entries.find((x) => x.id === op.entry_id);
  if (!e) reject("not_found", "That contest entry doesn't exist.");
  if (!isActive(e)) return;
  if (!tx.override && op.by !== e.player_id && !actsForTeam(tx.state, op, e.team_id)) {
    reject("forbidden", "Hands off another team's contest entry. Only its team (or the commissioner) can pull it.");
  }
  tx.patch("contest_entries", e, { deleted_at: tx.now });
}

function contestReview(tx: Tx, op: ContestReviewOp): void {
  const e = tx.state.contest_entries.find((x) => x.id === op.entry_id);
  if (!e || !isActive(e)) reject("not_found", "That contest entry doesn't exist (or was replaced).");
  if (op.status !== "ok" && op.status !== "flagged" && op.status !== "overridden") reject("invalid", "Bad review status.");
  const patch: Partial<ContestEntry> = { status: op.status };
  if (op.distance_override !== undefined) {
    const max = e.unit === "ft" ? CTP_MAX_FT : LD_MAX_YD;
    patch.distance_override = optFinite(op.distance_override, "official distance", 0, max);
  }
  tx.patch("contest_entries", e, patch);
}

// ---------------------------------------------------------------------------
// Feed, reactions, pots, mute (any status)
// ---------------------------------------------------------------------------

function postCreate(tx: Tx, op: PostCreateOp): void {
  const s = tx.state;
  if (s.feed_events.some((f) => f.id === op.event_id)) return; // idempotent
  const id = requireId(op.event_id, "post");
  if (op.text !== null && op.text !== undefined && typeof op.text !== "string") reject("invalid", "Bad post text.");
  const text = typeof op.text === "string" ? op.text.trim() : "";
  if (text.length > MAX_POST_CHARS) reject("invalid", `Keep it under ${MAX_POST_CHARS} characters, Hemingway.`);
  const photo = optPhoto(s, op.photo_path);
  if (!text && !photo) reject("invalid", "Say something (or post a photo). Silence isn't content.");
  const author = actorId(s, op);
  const row: FeedEvent = {
    id,
    trip_id: s.trip.id,
    type: "post",
    team_id: author ? teamIdOfPlayer(s, author) : null,
    player_id: author,
    actor_id: author,
    payload: {},
    photo_path: photo,
    text: text || null,
    dedupe_key: null,
    created_at: tx.now,
    updated_at: tx.now,
    deleted_at: null,
  };
  tx.put("feed_events", row);
}

function feedDelete(tx: Tx, op: FeedDeleteOp): void {
  const ev = tx.state.feed_events.find((f) => f.id === op.event_id);
  if (!ev) reject("not_found", "That post doesn't exist.");
  const isAuthor = ev.type === "post" && ev.player_id !== null && ev.player_id === op.by;
  if (!tx.ctx.is_commissioner && !isAuthor) {
    reject("forbidden", "You can only delete your own posts. The commissioner can delete anything.");
  }
  if (!isActive(ev)) return;
  tx.patch("feed_events", ev, { deleted_at: tx.now });
}

function reactionSet(tx: Tx, op: ReactionSetOp): void {
  const s = tx.state;
  const ev = s.feed_events.find((f) => f.id === op.feed_event_id && isActive(f));
  if (!ev) reject("not_found", "That post is gone. React to something else.");
  const player = requirePlayer(s, op.player_id);
  if (!REACTION_KINDS.includes(op.kind)) reject("invalid", "Not a real reaction. Six options, pick one.");
  if (typeof op.on !== "boolean") reject("invalid", "Bad reaction toggle.");
  // Unique per (event, player, kind): reuse the row, toggling deleted_at.
  const existing = s.reactions.find((r) => r.feed_event_id === ev.id && r.player_id === player.id && r.kind === op.kind);
  if (op.on) {
    if (!existing) {
      const row: Reaction = {
        id: requireId(op.id, "reaction"),
        trip_id: s.trip.id,
        feed_event_id: ev.id,
        player_id: player.id,
        kind: op.kind,
        created_at: tx.now,
        deleted_at: null,
      };
      tx.put("reactions", row);
    } else if (!isActive(existing)) {
      tx.patch("reactions", existing, { deleted_at: null });
    }
  } else if (existing && isActive(existing)) {
    tx.patch("reactions", existing, { deleted_at: tx.now });
  }
}

function validPotKey(s: TripState, key: unknown): key is PotOptout["pot_key"] {
  if (key === "team_match") return true;
  if (typeof key !== "string") return false;
  const m = /^contest:(\d{1,2})$/.exec(key);
  if (!m) return false;
  const n = Number(m[1]);
  const hole = s.holes.find((h) => h.number === n);
  return !!hole && hole.contest !== "none" && String(n) === m[1];
}

function potOptout(tx: Tx, op: PotOptoutOp): void {
  const s = tx.state;
  if (!tx.ctx.is_commissioner && s.trip.status !== "setup") {
    reject("conflict", "Pots are locked once the round starts. You're in, baby. Ask the commissioner.");
  }
  if (!validPotKey(s, op.pot_key)) reject("invalid", "That pot doesn't exist.");
  const player = requirePlayer(s, op.player_id);
  if (typeof op.out !== "boolean") reject("invalid", "Bad opt-out toggle.");
  // Unique per (pot_key, player): an active row means OUT.
  const existing = s.pot_optouts.find((o) => o.pot_key === op.pot_key && o.player_id === player.id);
  if (op.out) {
    if (!existing) {
      const row: PotOptout = {
        id: requireId(op.id, "opt-out"),
        trip_id: s.trip.id,
        pot_key: op.pot_key,
        player_id: player.id,
        created_at: tx.now,
        deleted_at: null,
      };
      tx.put("pot_optouts", row);
    } else if (!isActive(existing)) {
      tx.patch("pot_optouts", existing, { deleted_at: null });
    }
  } else if (existing && isActive(existing)) {
    tx.patch("pot_optouts", existing, { deleted_at: tx.now });
  }
}

function playerMute(tx: Tx, op: PlayerMuteOp): void {
  const player = requirePlayer(tx.state, op.player_id);
  if (typeof op.muted !== "boolean") reject("invalid", "Bad mute toggle.");
  tx.patch("players", player, { muted_push: op.muted });
}

// ---------------------------------------------------------------------------
// Commissioner: roster, teams, course, trip
// ---------------------------------------------------------------------------

function nextSortOrder(rows: { sort_order: number }[]): number {
  return rows.reduce((max, r) => Math.max(max, r.sort_order), -1) + 1;
}

function playerUpsert(tx: Tx, op: PlayerUpsertOp): void {
  const s = tx.state;
  const p = op.player;
  if (!p || typeof p !== "object") reject("invalid", "Bad player.");
  const id = requireId(p.id, "player");
  const existing = s.players.find((x) => x.id === id);
  if (existing && !isActive(existing)) reject("not_found", "That player was deleted.");

  const patch: Partial<Player> = {};
  if (p.name !== undefined) patch.name = requireName(p.name, "Every player");
  if (p.nickname !== undefined) {
    if (p.nickname !== null && typeof p.nickname !== "string") reject("invalid", "Bad nickname.");
    patch.nickname = p.nickname?.trim() || null;
  }
  if (p.venmo_handle !== undefined) {
    if (p.venmo_handle !== null && typeof p.venmo_handle !== "string") reject("invalid", "Bad Venmo handle.");
    patch.venmo_handle = p.venmo_handle?.trim().replace(/^@+/, "").trim() || null;
  }
  if (p.is_groom !== undefined) {
    if (typeof p.is_groom !== "boolean") reject("invalid", "Bad groom flag.");
    patch.is_groom = p.is_groom;
  }
  if (p.sort_order !== undefined) {
    if (!isInt(p.sort_order)) reject("invalid", "Bad sort order.");
    patch.sort_order = p.sort_order;
  }

  if (existing) {
    tx.patch("players", existing, patch);
  } else {
    if (patch.name === undefined) requireName(undefined, "A new player");
    const row: Player = {
      id,
      trip_id: s.trip.id,
      name: patch.name as string,
      nickname: patch.nickname ?? null,
      venmo_handle: patch.venmo_handle ?? null,
      is_groom: patch.is_groom ?? false,
      muted_push: false,
      sort_order: patch.sort_order ?? nextSortOrder(s.players),
      created_at: tx.now,
      deleted_at: null,
    };
    tx.put("players", row);
  }

  // One groom per trip.
  if (patch.is_groom === true) {
    for (const other of s.players) {
      if (other.id !== id && other.is_groom) tx.patch("players", other, { is_groom: false });
    }
  }
}

function playerDelete(tx: Tx, op: PlayerDeleteOp): void {
  const s = tx.state;
  const player = s.players.find((p) => p.id === op.player_id);
  if (!player) reject("not_found", "Who? That player isn't on the roster.");
  if (isActive(player)) tx.patch("players", player, { deleted_at: tx.now });
  for (const m of s.team_members) if (m.player_id === player.id) tx.remove("team_members", m.id);
}

/** "9:05" / "09:05" -> "09:05"; null stays null. */
function normalizeTeeTime(v: unknown): string | null {
  if (v === null || v === "") return null;
  const m = typeof v === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim()) : null;
  if (!m) reject("invalid", "Tee time must look like 12:50 (24h).");
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function teamUpsert(tx: Tx, op: TeamUpsertOp): void {
  const s = tx.state;
  const t = op.team;
  if (!t || typeof t !== "object") reject("invalid", "Bad team.");
  const id = requireId(t.id, "team");
  const existing = s.teams.find((x) => x.id === id);
  if (existing && !isActive(existing)) reject("not_found", "That team was deleted.");

  const patch: Partial<Team> = {};
  if (t.name !== undefined) patch.name = requireName(t.name, "Every team");
  if (t.tee_time !== undefined) patch.tee_time = normalizeTeeTime(t.tee_time);
  if (t.sort_order !== undefined) {
    if (!isInt(t.sort_order)) reject("invalid", "Bad sort order.");
    patch.sort_order = t.sort_order;
  }

  if (existing) {
    tx.patch("teams", existing, patch);
    return;
  }
  const row: Team = {
    id,
    trip_id: s.trip.id,
    name: patch.name ?? `Team ${s.teams.filter(isActive).length + 1}`,
    tee_time: patch.tee_time ?? null,
    sort_order: patch.sort_order ?? nextSortOrder(s.teams),
    created_at: tx.now,
    deleted_at: null,
  };
  tx.put("teams", row);
}

function teamDelete(tx: Tx, op: TeamDeleteOp): void {
  const s = tx.state;
  const team = s.teams.find((t) => t.id === op.team_id);
  if (!team) reject("not_found", "That team doesn't exist.");
  if (isActive(team)) {
    // Scores and drinks only exist once the round is live; deleting them would rewrite history.
    const hasScores = s.hole_scores.some((h) => h.team_id === team.id && h.strokes !== null);
    const hasDrinks = s.drinks.some((d) => d.team_id === team.id && isActive(d));
    if (hasScores || hasDrinks) reject("conflict", `${team.name} has scores or drinks on the books. Can't delete history.`);
    tx.patch("teams", team, { deleted_at: tx.now });
  }
  for (const m of s.team_members) if (m.team_id === team.id) tx.remove("team_members", m.id);
}

function teamAssign(tx: Tx, op: TeamAssignOp): void {
  const s = tx.state;
  const player = requirePlayer(s, op.player_id);
  const team = op.team_id === null ? null : requireTeam(s, op.team_id);
  const current = s.team_members.filter((m) => m.player_id === player.id);
  // Already there: nothing to do.
  if (team && current.length === 1 && current[0].team_id === team.id) return;
  if (!team && current.length === 0) return;
  if (team) {
    const others = membersOf(s, team.id).filter((p) => p.id !== player.id).length;
    if (others >= MAX_TEAM_SIZE) {
      reject("conflict", `${team.name} already has ${MAX_TEAM_SIZE}. It's a scramble, not a clown car.`);
    }
  }
  for (const m of current) tx.remove("team_members", m.id);
  if (team) {
    const row: TeamMember = { id: op.id, trip_id: s.trip.id, team_id: team.id, player_id: player.id, created_at: tx.now };
    tx.put("team_members", row);
  }
}

const TEE_SETS: readonly TeeSet[] = ["advanced", "membership", "forward"];

function holeUpdate(tx: Tx, op: HoleUpdateOp): void {
  const holeNo = requireHole(op.hole);
  const hole = tx.state.holes.find((h) => h.number === holeNo);
  if (!hole) reject("not_found", `Hole ${holeNo} isn't set up.`);
  const p = op.patch;
  if (!p || typeof p !== "object") reject("invalid", "Bad hole patch.");

  const patch: Partial<Hole> = {};
  if (p.par !== undefined) {
    if (!isInt(p.par) || p.par < 3 || p.par > 6) reject("invalid", "Par must be 3 to 6. This isn't mini golf.");
    patch.par = p.par;
  }
  if (p.stroke_index !== undefined) {
    if (!isInt(p.stroke_index) || p.stroke_index < 1 || p.stroke_index > 18) reject("invalid", "Stroke index must be 1 to 18.");
    patch.stroke_index = p.stroke_index;
  }
  if (p.yardage !== undefined) {
    if (!p.yardage || typeof p.yardage !== "object") reject("invalid", "Bad yardage.");
    const yardage = { ...hole.yardage };
    for (const tee of TEE_SETS) {
      const y = (p.yardage as Partial<Record<TeeSet, unknown>>)[tee];
      if (y === undefined) continue;
      if (!isFiniteNum(y) || y < 0 || y > 1000) reject("invalid", "Yardage must be 0 to 1000.");
      yardage[tee] = y;
    }
    patch.yardage = yardage;
  }
  // Explicit null clears a point; undefined leaves it alone.
  if (p.tee_lat !== undefined) patch.tee_lat = optFinite(p.tee_lat, "tee latitude", -90, 90);
  if (p.tee_lng !== undefined) patch.tee_lng = optFinite(p.tee_lng, "tee longitude", -180, 180);
  if (p.green_lat !== undefined) patch.green_lat = optFinite(p.green_lat, "green latitude", -90, 90);
  if (p.green_lng !== undefined) patch.green_lng = optFinite(p.green_lng, "green longitude", -180, 180);
  if (p.contest !== undefined) {
    if (p.contest !== "ctp" && p.contest !== "ld" && p.contest !== "none") reject("invalid", "Contest must be ctp, ld or none.");
    patch.contest = p.contest;
  } else if (patch.par !== undefined && patch.par !== hole.par) {
    // Par 3 -> closest to pin, par 5 -> long drive, else none.
    patch.contest = contestForPar(patch.par);
  }
  // patch() only overwrites provided keys; nulls (cleared points) are kept, undefined is dropped.
  const current = tx.state.holes.find((h) => h.id === hole.id) ?? hole;
  const next: Hole = { ...current, ...patch };
  if (deepEqual(next, current)) return;
  tx.put("holes", { ...next, updated_at: tx.now });
}

type SettingCheck = (v: unknown) => boolean;
const nonNegInt: SettingCheck = (v) => isInt(v) && v >= 0;
const SETTING_CHECKS: { [K in keyof TripSettings]: SettingCheck } = {
  tee_set: (v) => TEE_SETS.includes(v as TeeSet),
  course_name: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 120,
  roasts_enabled: (v) => typeof v === "boolean",
  roast_min_hole_gap: nonNegInt,
  roast_cap: nonNegInt,
  ld_accuracy_limit_m: (v) => isFiniteNum(v) && v > 0,
  ld_min_yd: (v) => isFiniteNum(v) && v >= 0 && v <= LD_MAX_YD,
  ld_max_yd: (v) => isFiniteNum(v) && v >= 0 && v <= LD_MAX_YD,
  judge_suspicious_ratio: (v) => isFiniteNum(v) && v >= 0 && v <= 1,
  push_throttle_sec: nonNegInt,
  team_match_ante_cents: nonNegInt,
  contest_ante_cents: nonNegInt,
  team_match_payout: (v) =>
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((x) => isFiniteNum(x) && x >= 0) &&
    Math.abs((v as number[]).reduce((a, b) => a + b, 0) - 100) < 1e-9,
  drink_cap: (v) => v === null || (isInt(v) && v >= 1),
};

function tripUpdate(tx: Tx, op: TripUpdateOp): void {
  const trip = tx.state.trip;
  const p = op.patch;
  if (!p || typeof p !== "object") reject("invalid", "Bad settings patch.");
  const patch: Partial<Trip> = {};
  if (p.name !== undefined) patch.name = requireName(p.name, "The trip");
  if (p.app_name !== undefined) patch.app_name = requireName(p.app_name, "The app");
  if (p.base_team_size !== undefined) {
    if (!isInt(p.base_team_size) || p.base_team_size < 2 || p.base_team_size > 4) {
      reject("invalid", "Base team size must be 2 to 4.");
    }
    patch.base_team_size = p.base_team_size;
  }
  if (p.settings !== undefined) {
    if (!p.settings || typeof p.settings !== "object") reject("invalid", "Bad settings.");
    const settings: TripSettings = { ...trip.settings };
    // Only known keys are merged; anything else is ignored.
    for (const key of Object.keys(SETTING_CHECKS) as (keyof TripSettings)[]) {
      const v = (p.settings as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (!SETTING_CHECKS[key](v)) {
        reject(
          "invalid",
          key === "team_match_payout"
            ? "Team match payout must add up to 100%. Math is hard after six beers."
            : `Bad value for ${key.replace(/_/g, " ")}.`,
        );
      }
      (settings as unknown as Record<string, unknown>)[key] = Array.isArray(v) ? [...v] : typeof v === "string" ? v.trim() : v;
    }
    if (settings.ld_min_yd > settings.ld_max_yd) reject("invalid", "Long drive minimum is above the maximum.");
    patch.settings = settings;
  }
  tx.patchTrip(patch);
}

function tripStart(tx: Tx, op: TripStartOp): void {
  const s = tx.state;
  if (s.trip.status === "live") return; // already started: harmless double tap
  if (s.trip.status !== "setup") reject("conflict", "This round is already final. Reopen it instead.");
  const teams = s.teams.filter(isActive);
  if (teams.length === 0) reject("conflict", "No teams yet. Golf is a team sport today.");
  const unassigned = s.players.filter((p) => isActive(p) && teamIdOfPlayer(s, p.id) === null);
  if (unassigned.length > 0) {
    reject("conflict", `Not on a team yet: ${unassigned.map((p) => p.name).join(", ")}. Everybody plays.`);
  }
  const badTeams = teams
    .map((t) => ({ t, n: membersOf(s, t.id).length }))
    .filter(({ n }) => n < MIN_TEAM_SIZE || n > MAX_TEAM_SIZE);
  if (badTeams.length > 0) {
    const list = badTeams.map(({ t, n }) => `${t.name} has ${n}`).join(", ");
    reject("conflict", `Teams need ${MIN_TEAM_SIZE} to ${MAX_TEAM_SIZE} players: ${list}.`);
  }
  tx.patchTrip({ status: "live", started_at: tx.now });
  for (const t of teams) {
    if (!roundStateOf(tx.state, t.id)) tx.put("team_round_state", newRoundState(tx, deriveId(op.id, t.id), t.id));
  }
}

function tripFinalize(tx: Tx): void {
  const status = tx.state.trip.status;
  if (status === "final") return;
  if (status !== "live") reject("conflict", "Can't finalize a round that never started.");
  tx.patchTrip({ status: "final", finalized_at: tx.now });
}

function tripReopen(tx: Tx): void {
  const status = tx.state.trip.status;
  if (status === "live") return;
  if (status !== "final") reject("conflict", "Nothing to reopen. The round hasn't even started.");
  tx.patchTrip({ status: "live", finalized_at: null });
}

function roundSetState(tx: Tx, op: RoundSetStateOp): void {
  const team = requireTeam(tx.state, op.team_id);
  const openHoleNo = op.open_hole === null ? null : requireHole(op.open_hole);
  const status = op.status;
  if (status !== "not_started" && status !== "playing" && status !== "complete") reject("invalid", "Bad round status.");
  if (status === "playing" && openHoleNo === null) reject("invalid", "Playing needs an open hole.");
  if (status === "not_started" && openHoleNo !== null) reject("invalid", "A team that hasn't started can't have an open hole.");

  const existing = roundStateOf(tx.state, team.id);
  const rs = existing ?? newRoundState(tx, op.id, team.id);
  let started = rs.started_holes;
  let opened = rs.hole_opened_at;
  if (status === "not_started") {
    started = [];
    opened = {};
  } else if (openHoleNo !== null) {
    // Holes after the (possibly moved back) open hole haven't really started; keep the rest.
    started = uniqSorted([...rs.started_holes.filter((h) => h <= openHoleNo), openHoleNo]);
    opened = Object.fromEntries(Object.entries(rs.hole_opened_at).filter(([h]) => Number(h) <= openHoleNo));
    if (opened[String(openHoleNo)] === undefined) opened[String(openHoleNo)] = op.at;
  }
  const next: TeamRoundState = {
    ...rs,
    open_hole: openHoleNo,
    status,
    started_holes: started,
    hole_opened_at: opened,
    completed_at: status === "complete" ? (rs.completed_at ?? op.at) : null,
  };
  if (existing && deepEqual(next, existing)) return;
  tx.put("team_round_state", { ...next, updated_at: tx.now });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

type Handlers = { [K in OpType]: (tx: Tx, op: Extract<Op, { type: K }>) => void };

const HANDLERS: Handlers = {
  "tee.open": teeOpen,
  "round.complete": roundComplete,
  "score.set": scoreSet,
  "teeshot.set": teeShotSet,
  "drink.log": drinkLog,
  "drink.delete": drinkDelete,
  "drink.move": drinkMove,
  "mulligan.use": mulliganUse,
  "mulligan.undo": mulliganUndo,
  "contest.submit": contestSubmit,
  "contest.delete": contestDelete,
  "contest.review": contestReview,
  "post.create": postCreate,
  "feed.delete": feedDelete,
  "reaction.set": reactionSet,
  "pot.optout": potOptout,
  "player.mute": playerMute,
  "player.upsert": playerUpsert,
  "player.delete": playerDelete,
  "team.upsert": teamUpsert,
  "team.delete": teamDelete,
  "team.assign": teamAssign,
  "hole.update": holeUpdate,
  "trip.update": tripUpdate,
  "trip.start": tripStart,
  "trip.finalize": tripFinalize,
  "trip.reopen": tripReopen,
  "round.set_state": roundSetState,
};

function applyOrThrow(state: TripState, op: Op, ctx: ApplyCtx): ApplyResult {
  if (!op || typeof op !== "object") reject("invalid", "That's not an op.");
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, op.type)) reject("invalid", "Unknown op. The app doesn't speak that language.");
  requireId(op.id, "op");
  if (typeof op.at !== "string" || Number.isNaN(time(op.at))) reject("invalid", "That op has no valid timestamp. Check your phone's clock.");

  // 1. Commissioner powers.
  if ((COMMISSIONER_ONLY_OPS.has(op.type) || op.as_commissioner) && !ctx.is_commissioner) {
    reject("forbidden", "Commissioner only. Nice try, though.");
  }
  // 2. Play ops need a live round. A commissioner override may also fix a final one, and a late
  //    sync of something that happened before the finalize (+ clock grace) still lands. A fresh
  //    dispatch on a phone that already shows the round final is not late: it's after.
  if (PLAY_OPS.has(op.type)) {
    const { status, finalized_at } = state.trip;
    const late = ctx.side === "server" && finalized_at !== null && !pastGrace(op.at, finalized_at);
    const allowed = status === "live" || (status === "final" && (!!op.as_commissioner || late));
    if (!allowed) {
      reject(
        "not_live",
        status === "setup" ? "The round hasn't started yet. Easy, tiger." : "The round is final. The scorecard is carved in stone.",
      );
    }
  }
  const tx = new Tx(state, ctx, op);
  (HANDLERS[op.type] as (tx: Tx, op: Op) => void)(tx, op);
  return tx.result();
}

export function applyOp(state: TripState, op: Op, ctx: ApplyCtx): ApplyResult {
  try {
    return applyOrThrow(state, op, ctx);
  } catch (e) {
    if (e instanceof Rejection) return { ok: false, code: e.code, reason: e.reason };
    // A malformed op that slipped past validation must not wedge the sync outbox (a thrown error
    // would 500 the batch and be retried forever); reject it instead.
    return { ok: false, code: "invalid", reason: "That one didn't compute. Malformed op?" };
  }
}

/** Apply many ops in order, skipping rejected ones. Returns the final state and per-op results. */
export function applyOps(
  state: TripState,
  ops: Op[],
  ctx: ApplyCtx,
): { state: TripState; results: Array<{ id: UUID; ok: boolean; code?: RejectCode; reason?: string }> } {
  let current = state;
  const results: Array<{ id: UUID; ok: boolean; code?: RejectCode; reason?: string }> = [];
  for (const op of ops) {
    const r = applyOp(current, op, ctx);
    if (r.ok) {
      current = r.state;
      results.push({ id: op.id, ok: true });
    } else {
      results.push({ id: op?.id, ok: false, code: r.code, reason: r.reason });
    }
  }
  return { state: current, results };
}
