// Server-side feed event generation. Runs after the reducer applied a batch of ops.
//
// Most events come from comparing each step's before/after states (so they fire on what actually
// changed, not on what an op asked for: idempotent re-sends and no-op ops post nothing). Leaderboard
// lead changes, contest lead changes and drive-minimum callouts compare the whole batch (first
// step's before vs last step's after). Auto events that must never repeat carry a dedupe_key
// (unique per trip); their id is deriveId(trip_id, dedupe_key). Everything else gets
// deriveId(op.id, type, extra). Pure: time comes from `now`, ids from ops.
import type { ContestEntry, Drink, FeedEvent, FeedEventType, ISODate, Mulligan, TripSettings, TripState, UUID } from "../types";
import { COMMISSIONER_ONLY_OPS, type Op, type OpType } from "../ops";
import { derive } from "../engine";
import type { Derived, DriveNineStatus, StandingRow } from "../engine/types";
import { formatCents, formatFeetInches } from "../engine/format";
import { deriveId } from "../ids";
import { renderFeedEvent } from "./templates";
import type {
  CommissionerOverridePayload,
  ContestEntryPayload,
  ContestLeadPayload,
  DriveMissPayload,
  DriveWarningPayload,
  DrinksPayload,
  FinalResultsPayload,
  GhostBeerPayload,
  GrossNotableKind,
  GroomMulliganPayload,
  LeadChangePayload,
  MulliganUsedPayload,
  RoundCompletePayload,
  RoundStartedPayload,
  ScoreEditPayload,
  ScoreNotablePayload,
  SingleDrinkPayload,
  TeeOffPayload,
} from "./payloads";

export interface OpStep {
  op: Op;
  /** State right before this op. */
  before: TripState;
  /** State right after this op (includes feed rows created by earlier steps' events? NO: reducer output only). */
  after: TripState;
  is_commissioner: boolean;
}

export interface RoastTrigger {
  feed_event_id: UUID;
  type: FeedEventType;
  team_id: UUID | null;
  hole: number | null;
  /** Big events ignore the per-team 3-hole gap (still count toward the cap). */
  big: boolean;
}

export interface PushTrigger {
  feed_event_id: UUID;
  title: string;
  body: string;
  /** "all" players, or only one team's players. */
  audience: { kind: "all" } | { kind: "team"; team_id: UUID };
  /** Duplicate events with the same collapse key are collapsed. */
  collapse_key: string;
}

export interface DeriveEventsResult {
  /** New feed rows, or updated existing rows (drink batches). Persist as upserts by id. */
  feed: FeedEvent[];
  roast_triggers: RoastTrigger[];
  push_triggers: PushTrigger[];
}

/** Plain drinks from the same team on the same hole join one post for this long after it was created. */
export const DRINK_BATCH_WINDOW_MS = 60_000;

/** Ops that never post a commissioner override: not game edits, or covered by their own event. */
const NO_OVERRIDE_OPS: ReadonlySet<OpType> = new Set<OpType>([
  "post.create",
  "reaction.set",
  "player.mute",
  "trip.start", // round_started (and it only works from setup anyway)
  "trip.finalize", // final_results
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isActive = (r: { deleted_at: ISODate | null }) => r.deleted_at === null;
const sortIds = (ids: readonly string[]) => [...ids].sort();
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Parsed ISO time; unparseable sorts first. (DB rows may not use toISOString's exact format.) */
const timeOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
};
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function byId<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

/** op.by when it names a known player (feed rows reference players), else null. */
function actorOf(s: TripState, by: UUID | null | undefined): UUID | null {
  return typeof by === "string" && s.players.some((p) => p.id === by) ? by : null;
}

/** Display name for summaries: nickname, else name. Deleted players still resolve. */
function playerLabel(s: TripState, id: UUID | null | undefined): string {
  const p = id ? s.players.find((x) => x.id === id) : undefined;
  return p ? p.nickname?.trim() || p.name : "somebody";
}

function teamLabel(s: TripState, id: UUID | null | undefined): string {
  const t = id ? s.teams.find((x) => x.id === id) : undefined;
  return t ? t.name : "a team";
}

function parOf(s: TripState, hole: number): number {
  return s.holes.find((h) => h.number === hole)?.par ?? 4;
}

function fmtDistance(distance: number, unit: "ft" | "yd"): string {
  return unit === "ft" ? formatFeetInches(distance) : `${Math.round(distance)} yd`;
}

const contestName = (kind: string) => (kind === "ctp" ? "closest to pin" : "long drive");

function grossKind(strokes: number, par: number): GrossNotableKind | null {
  const d = strokes - par;
  if (d <= -3) return "albatross";
  if (d === -2) return "eagle";
  if (d === -1) return "birdie";
  if (d === 2) return "double";
  if (d >= 3) return "triple_plus";
  return null;
}

/**
 * Last place among teams that have scored: at the highest position, with at least two scoring teams
 * and not everyone tied (if everybody is tied, nobody is last).
 */
function isLast(standings: StandingRow[], teamId: UUID): boolean {
  const started = standings.filter((r) => r.thru > 0);
  if (started.length < 2) return false;
  const row = started.find((r) => r.team_id === teamId);
  if (!row) return false;
  const maxPos = Math.max(...started.map((r) => r.pos));
  return row.pos === maxPos && started.some((r) => r.pos !== maxPos);
}

/** One failure must never sink the batch (the server must still commit the ops). */
function safely(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[feed] ${label} failed; skipping its events`, err);
  }
}

// ---------------------------------------------------------------------------
// Feed builder: the feed as of "now" in the batch, plus what we emit
// ---------------------------------------------------------------------------

class FeedBuilder {
  /** Every known row by id: existing feed, reducer changes during the batch, our new/updated rows. */
  private readonly rows = new Map<UUID, FeedEvent>();
  private readonly keys = new Set<string>();
  /** Rows to persist (new or updated), latest version, in first-touch order. */
  private readonly touched = new Map<UUID, FeedEvent>();
  private readonly created = new Set<UUID>();
  /** Rows that appeared during the batch without us (e.g. an ai_judge row), for triggers. */
  readonly foreign: FeedEvent[] = [];

  constructor(existing: readonly FeedEvent[]) {
    for (const ev of existing) this.remember(ev);
  }

  private remember(ev: FeedEvent): void {
    this.rows.set(ev.id, ev);
    if (ev.dedupe_key) this.keys.add(ev.dedupe_key);
  }

  hasKey(key: string): boolean {
    return this.keys.has(key);
  }

  all(): FeedEvent[] {
    return [...this.rows.values()];
  }

  /** Latest (created_at, then insertion order) row matching `pred`. */
  latest(pred: (ev: FeedEvent) => boolean): FeedEvent | null {
    let best: FeedEvent | null = null;
    let bestAt = -Infinity;
    for (const ev of this.rows.values()) {
      if (!pred(ev)) continue;
      const t = timeOf(ev.created_at);
      if (!best || t >= bestAt) {
        best = ev;
        bestAt = t;
      }
    }
    return best;
  }

  /** Add a new row unless its dedupe key or id already exists. Returns the row, or null when skipped. */
  create(ev: FeedEvent): FeedEvent | null {
    if (ev.dedupe_key !== null && this.keys.has(ev.dedupe_key)) return null;
    if (this.rows.has(ev.id)) return null;
    this.remember(ev);
    this.touched.set(ev.id, ev);
    this.created.add(ev.id);
    return ev;
  }

  update(ev: FeedEvent): void {
    this.rows.set(ev.id, ev);
    this.touched.set(ev.id, ev);
  }

  softDelete(ev: FeedEvent, now: ISODate): void {
    if (ev.deleted_at !== null) return;
    this.update({ ...ev, deleted_at: now, updated_at: now });
  }

  /**
   * Fold in the reducer's own feed changes from one step (post.create inserts, feed.delete soft
   * deletes). If we already updated a row the reducer then deleted, keep our version but carry the
   * deletion so our upsert never resurrects it.
   */
  absorbReducerFeed(before: readonly FeedEvent[], after: readonly FeedEvent[]): void {
    const prev = byId(before);
    for (const row of after) {
      if (prev.get(row.id) === row) continue;
      const mine = this.touched.get(row.id);
      if (mine) {
        if (mine.deleted_at !== row.deleted_at) this.update({ ...mine, deleted_at: row.deleted_at });
        continue;
      }
      if (!this.rows.has(row.id)) this.foreign.push(row);
      this.remember(row);
    }
  }

  output(): FeedEvent[] {
    return [...this.touched.values()];
  }

  /** Rows created in this batch (latest version), in creation order. */
  createdRows(): FeedEvent[] {
    return [...this.touched.values()].filter((ev) => this.created.has(ev.id));
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface Ctx {
  tripId: UUID;
  now: ISODate;
  nowMs: number;
  fb: FeedBuilder;
  /** Memoized derive (states are immutable; reducer no-ops keep identity). */
  d(s: TripState): Derived;
}

interface NewEvent {
  type: FeedEventType;
  team_id?: UUID | null;
  player_id?: UUID | null;
  actor_id?: UUID | null;
  payload: object;
  photo_path?: string | null;
  dedupe_key?: string | null;
  /** For unkeyed events: deriveId(op_id, type, ...id_extra). */
  op_id?: UUID;
  id_extra?: string[];
}

function emit(ctx: Ctx, e: NewEvent): FeedEvent | null {
  const dedupe = e.dedupe_key ?? null;
  const id = dedupe !== null ? deriveId(ctx.tripId, dedupe) : deriveId(e.op_id ?? "", e.type, ...(e.id_extra ?? []));
  return ctx.fb.create({
    id,
    trip_id: ctx.tripId,
    type: e.type,
    team_id: e.team_id ?? null,
    player_id: e.player_id ?? null,
    actor_id: e.actor_id ?? null,
    payload: { ...e.payload } as Record<string, unknown>,
    photo_path: e.photo_path ?? null,
    text: null,
    dedupe_key: dedupe,
    created_at: ctx.now,
    updated_at: ctx.now,
    deleted_at: null,
  });
}

// ---------------------------------------------------------------------------
// Per-step events
// ---------------------------------------------------------------------------

function eventsForStep(ctx: Ctx, step: OpStep): void {
  const { op, before: B, after: A } = step;
  const actor = actorOf(A, op.by);
  const override = isCommissionerOverride(step);

  if (override) {
    const s = overrideSummary(op, B, A);
    if (s) {
      const payload: CommissionerOverridePayload = { op_type: op.type, summary: s.summary };
      emit(ctx, {
        type: "commissioner_override",
        team_id: s.team_id,
        player_id: s.player_id,
        actor_id: actor,
        payload,
        op_id: op.id,
      });
    }
  }

  if (A.trip.status !== B.trip.status) tripTransition(ctx, step, actor);
  if (A.team_round_state !== B.team_round_state) teeOffs(ctx, step, actor);
  if (A.hole_scores !== B.hole_scores) scoreChanges(ctx, step, actor, override);
  if (A.drinks !== B.drinks) drinkChanges(ctx, step, actor);
  if (A.mulligans !== B.mulligans) mulliganChanges(ctx, step, actor);
  if (A.contest_entries !== B.contest_entries) contestChanges(ctx, step, actor);
  // Anything that can move a hole net: strokes, drinks, team sizes (ghost credit), base team size.
  const netsMayMove =
    A.hole_scores !== B.hole_scores ||
    A.drinks !== B.drinks ||
    A.team_members !== B.team_members ||
    A.players !== B.players ||
    A.teams !== B.teams ||
    A.trip !== B.trip;
  if (netsMayMove && A.trip.status !== "setup") netZero(ctx, step, actor);
  if (A.team_round_state !== B.team_round_state) completions(ctx, step, actor);
}

function isCommissionerOverride(step: OpStep): boolean {
  const { op, before } = step;
  if (!step.is_commissioner) return false;
  if (!op.as_commissioner && !COMMISSIONER_ONLY_OPS.has(op.type)) return false;
  if (NO_OVERRIDE_OPS.has(op.type)) return false;
  // Setup-phase edits are just setup.
  return before.trip.status === "live" || before.trip.status === "final";
}

function tripTransition(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const { before: B, after: A, op } = step;
  if (B.trip.status === "setup" && A.trip.status === "live") {
    const d = ctx.d(A);
    const payload: RoundStartedPayload = {
      team_count: d.teams.length,
      player_count: Object.keys(d.teamOfPlayer).length,
    };
    emit(ctx, { type: "round_started", actor_id: actor, payload, dedupe_key: "round_started", op_id: op.id });
  }
  if (B.trip.status === "live" && A.trip.status === "final") {
    const d = ctx.d(A);
    const champions = d.leaderTeamIds;
    const payload: FinalResultsPayload = {
      finalized_at: A.trip.finalized_at ?? ctx.now,
      standings: d.standings.map((r) => ({
        team_id: r.team_id,
        pos: r.pos,
        pos_label: r.pos_label,
        thru: r.thru,
        gross: r.gross,
        net: r.net,
        net_to_par: r.net_to_par,
        drinks: r.drinks,
      })),
      champion_team_ids: [...champions],
      champion_player_ids: champions.flatMap((t) => (d.membersOfTeam[t] ?? []).map((p) => p.id)),
    };
    emit(ctx, {
      type: "final_results",
      team_id: champions.length === 1 ? champions[0] : null,
      actor_id: actor,
      payload,
      dedupe_key: `final:${payload.finalized_at}`,
    });
  }
}

/** A team's round goes from not started (no open hole) to started. */
function teeOffs(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const { before: B, after: A, op } = step;
  const prev = new Map(B.team_round_state.map((rs) => [rs.team_id, rs]));
  for (const rs of A.team_round_state) {
    const old = prev.get(rs.team_id);
    if (old === rs || rs.open_hole === null || (old && old.open_hole !== null)) continue;
    if (!A.teams.some((t) => t.id === rs.team_id && isActive(t))) continue;
    const payload: TeeOffPayload = { hole: rs.open_hole };
    emit(ctx, {
      type: "tee_off",
      team_id: rs.team_id,
      actor_id: actor,
      payload,
      dedupe_key: `teeoff:${rs.team_id}`,
      op_id: op.id,
    });
  }
}

/** A team's round becomes complete. */
function completions(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const { before: B, after: A } = step;
  const prev = new Map(B.team_round_state.map((rs) => [rs.team_id, rs]));
  for (const rs of A.team_round_state) {
    const old = prev.get(rs.team_id);
    if (rs.status !== "complete" || old?.status === "complete") continue;
    const d = ctx.d(A);
    const row = d.standings.find((r) => r.team_id === rs.team_id);
    if (!row) continue; // deleted team
    const payload: RoundCompletePayload = {
      gross: row.gross,
      net: row.net,
      net_to_par: row.net_to_par,
      gross_to_par: row.gross_to_par,
      pos_label: row.pos_label,
      thru: row.thru,
      drinks: row.drinks,
      ghost_beers: row.ghost_beers,
      last: isLast(d.standings, rs.team_id),
    };
    emit(ctx, {
      type: "round_complete",
      team_id: rs.team_id,
      actor_id: actor,
      payload,
      dedupe_key: `complete:${rs.team_id}`,
    });
  }
}

function scoreChanges(ctx: Ctx, step: OpStep, actor: UUID | null, override: boolean): void {
  const { before: B, after: A, op } = step;
  const prev = byId(B.hole_scores);
  for (const row of A.hole_scores) {
    const old = prev.get(row.id);
    if (old === row) continue;
    const from = old?.strokes ?? null;
    const to = row.strokes;
    if (to === null || to === from) continue;
    const par = parOf(A, row.hole);

    // "changed hole 6 from a 5 to a 4". A commissioner override already says exactly this.
    if (from !== null && !override) {
      const payload: ScoreEditPayload = { hole: row.hole, from, to, par, edit_count: row.edit_count };
      emit(ctx, {
        type: "score_edit",
        team_id: row.team_id,
        actor_id: actor,
        payload,
        op_id: op.id,
        id_extra: [row.team_id, String(row.hole)],
      });
    }

    const line = ctx.d(A).teamHoles[row.team_id]?.[row.hole - 1];
    const credit = line?.credit ?? 0;
    const kind = grossKind(to, par);
    if (kind) {
      const payload: ScoreNotablePayload = {
        kind,
        hole: row.hole,
        par,
        strokes: to,
        to_par: to - par,
        credit,
        net: to - credit,
        ace: to === 1,
      };
      emit(ctx, {
        type: "score_notable",
        team_id: row.team_id,
        actor_id: actor,
        payload,
        dedupe_key: `notable:${row.team_id}:${row.hole}:${kind}`,
      });
    }

    // Finishing the front nine in last place (first time hole 9 gets a score).
    if (row.hole === 9 && from === null) {
      const d = ctx.d(A);
      if (isLast(d.standings, row.team_id)) {
        const standing = d.standings.find((r) => r.team_id === row.team_id)!;
        const payload: ScoreNotablePayload = {
          kind: "last_at_turn",
          hole: 9,
          par,
          strokes: to,
          to_par: to - par,
          credit,
          net: to - credit,
          ace: to === 1,
          pos_label: standing.pos_label,
          net_to_par: standing.net_to_par,
        };
        emit(ctx, {
          type: "score_notable",
          team_id: row.team_id,
          actor_id: actor,
          payload,
          dedupe_key: `turn:${row.team_id}`,
        });
      }
    }
  }
}

/** Every scored hole whose net is <= 0 posts once (drinks after the score can get it there too). */
function netZero(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const d = ctx.d(step.after);
  for (const team of d.teams) {
    for (const line of d.teamHoles[team.id] ?? []) {
      if (line.strokes === null || line.net === null || line.net > 0) continue;
      const key = `netzero:${team.id}:${line.hole}`;
      if (ctx.fb.hasKey(key)) continue;
      const payload: ScoreNotablePayload = {
        kind: "net_zero",
        hole: line.hole,
        par: line.par,
        strokes: line.strokes,
        to_par: line.strokes - line.par,
        credit: line.credit,
        net: line.net,
        ace: line.strokes === 1,
      };
      emit(ctx, { type: "score_notable", team_id: team.id, actor_id: actor, payload, dedupe_key: key });
    }
  }
}

// ---- Drinks ----

function drinkChanges(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const { before: B, after: A } = step;
  const prev = byId(B.drinks);
  for (const drink of A.drinks) {
    const old = prev.get(drink.id);
    if (old === drink) continue;
    if (!old && isActive(drink)) drinkLogged(ctx, step, drink, actor);
    else if (old && isActive(old) && !isActive(drink)) drinkDeleted(ctx, step, drink);
  }
}

function drinkLogged(ctx: Ctx, step: OpStep, drink: Drink, actor: UUID | null): void {
  const { after: A, op } = step;
  const dA = ctx.d(A);
  const value = dA.drinkValues[drink.id]?.value ?? 1;
  const loggedBy = drink.logged_by;

  if (drink.type === "drink") {
    // A plain drink worth more than 1 is a ghost beer and gets only the ghost post (below).
    if (value <= 1) addToDrinkBatch(ctx, op, drink, actor);
  } else {
    const payload: SingleDrinkPayload = {
      drink_id: drink.id,
      drink_type: drink.type,
      hole: drink.hole,
      player_id: drink.player_id,
      logged_by: loggedBy,
      value,
      banked_mulligan: true,
      mulligans_available: dA.mulligans[drink.team_id]?.available ?? 0,
    };
    emit(ctx, {
      type: drink.type,
      team_id: drink.team_id,
      player_id: drink.player_id,
      actor_id: actor,
      payload,
      photo_path: drink.photo_path,
      op_id: op.id,
      id_extra: [drink.id],
    });
  }

  ghostBeers(ctx, step, drink, actor);
}

/**
 * Plain drinks batch per team + hole: join the latest active "drinks" post for that team and hole
 * if it was created within 60 s of now (server time). A batch carries at most one photo.
 */
function addToDrinkBatch(ctx: Ctx, op: Op, drink: Drink, actor: UUID | null): void {
  // Already posted (the same steps derived twice): never count a drink twice.
  if (ctx.fb.all().some((ev) => ev.type === "drinks" && strArr(ev.payload.drink_ids).includes(drink.id))) return;
  const target = ctx.fb.latest(
    (ev) => ev.type === "drinks" && isActive(ev) && ev.team_id === drink.team_id && ev.payload.hole === drink.hole,
  );
  const age = target ? ctx.nowMs - Date.parse(target.created_at) : Infinity;
  if (target && age <= DRINK_BATCH_WINDOW_MS && (target.photo_path === null || drink.photo_path === null)) {
    const p = target.payload as Partial<DrinksPayload>;
    const drinkIds = [...strArr(p.drink_ids), drink.id];
    const payload: DrinksPayload = {
      hole: drink.hole,
      drink_ids: drinkIds,
      player_ids: [...strArr(p.player_ids), drink.player_id],
      logged_by_ids: [...(Array.isArray(p.logged_by_ids) ? p.logged_by_ids : []), drink.logged_by],
      count: drinkIds.length,
    };
    ctx.fb.update({
      ...target,
      payload: { ...target.payload, ...payload },
      photo_path: target.photo_path ?? drink.photo_path,
      updated_at: ctx.now,
    });
    return;
  }
  const payload: DrinksPayload = {
    hole: drink.hole,
    drink_ids: [drink.id],
    player_ids: [drink.player_id],
    logged_by_ids: [drink.logged_by],
    count: 1,
  };
  emit(ctx, {
    type: "drinks",
    team_id: drink.team_id,
    player_id: drink.player_id,
    actor_id: actor,
    payload,
    photo_path: drink.photo_path,
    op_id: op.id,
    id_extra: [drink.id],
  });
}

function teamGhosts(d: Derived, teamId: UUID) {
  return Object.values(d.drinkValues)
    .filter((v) => v.team_id === teamId && v.ghost)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Ghost beers: post when the team's ghost count goes up. Normally the drink just logged is the
 * new ghost; when an offline drink syncs late with an earlier time it shifts the order and an
 * existing drink becomes the ghost instead, so we credit that one.
 */
function ghostBeers(ctx: Ctx, step: OpStep, drink: Drink, actor: UUID | null): void {
  const { before: B, after: A } = step;
  const dA = ctx.d(A);
  const before = new Set(teamGhosts(ctx.d(B), drink.team_id).map((v) => v.drink_id));
  const after = teamGhosts(dA, drink.team_id);
  let gained = after.length - before.size;
  if (gained <= 0) return;
  const candidates = after.filter((v) => !before.has(v.drink_id) && !ctx.fb.hasKey(`ghost:${v.drink_id}`));
  // Prefer the drink just logged, else the latest newly-ghost drink.
  candidates.sort((a, b) => (a.drink_id === drink.id ? 1 : b.drink_id === drink.id ? -1 : a.seq - b.seq));
  const drinksById = byId(A.drinks);
  while (gained > 0 && candidates.length > 0) {
    gained -= 1;
    const v = candidates.pop()!;
    const row = drinksById.get(v.drink_id);
    const payload: GhostBeerPayload = {
      drink_id: v.drink_id,
      drink_type: v.type,
      hole: v.hole,
      player_id: v.player_id,
      logged_by: row?.logged_by ?? null,
      value: v.value,
      seq: v.seq,
      team_size: dA.teamSize[drink.team_id] ?? 0,
      base_team_size: A.trip.base_team_size,
      ghost_count: after.length,
    };
    emit(ctx, {
      type: "ghost_beer",
      team_id: v.team_id,
      player_id: v.player_id,
      actor_id: actor,
      payload,
      // Shotgun/shot photos already ride on their own post.
      photo_path: v.drink_id === drink.id && drink.type === "drink" ? drink.photo_path : null,
      dedupe_key: `ghost:${v.drink_id}`,
    });
  }
}

/** Undo / commissioner delete: take the drink out of its posts so the feed stays truthful. */
function drinkDeleted(ctx: Ctx, step: OpStep, drink: Drink): void {
  const { before: B, after: A } = step;
  const fb = ctx.fb;
  for (const ev of fb.all()) {
    if (!isActive(ev)) continue;
    if ((ev.type === "shotgun" || ev.type === "shot") && ev.payload.drink_id === drink.id) {
      fb.softDelete(ev, ctx.now);
    } else if (ev.type === "drinks") {
      const p = ev.payload as Partial<DrinksPayload>;
      const ids = strArr(p.drink_ids);
      const i = ids.indexOf(drink.id);
      if (i < 0) continue;
      const without = <T,>(xs: unknown): T[] => (Array.isArray(xs) ? (xs as T[]).filter((_, j) => j !== i) : []);
      const drinkIds = ids.filter((_, j) => j !== i);
      const next: FeedEvent = {
        ...ev,
        payload: {
          ...ev.payload,
          drink_ids: drinkIds,
          player_ids: without<string>(p.player_ids),
          logged_by_ids: without<string | null>(p.logged_by_ids),
          count: drinkIds.length,
        },
        // The batch photo belonged to this drink: drop it with the drink.
        photo_path: drink.photo_path !== null && ev.photo_path === drink.photo_path ? null : ev.photo_path,
        updated_at: ctx.now,
      };
      if (drinkIds.length === 0) next.deleted_at = ctx.now;
      fb.update(next);
    }
  }

  // If the team lost a ghost beer, retire one ghost post (this drink's, else the latest whose drink
  // is no longer a ghost). If the ghost just moved to another drink the count is unchanged: keep it.
  const lost = teamGhosts(ctx.d(B), drink.team_id).length - teamGhosts(ctx.d(A), drink.team_id).length;
  if (lost <= 0) return;
  const stillGhost = new Set(teamGhosts(ctx.d(A), drink.team_id).map((v) => v.drink_id));
  const posts = fb
    .all()
    .filter((ev) => ev.type === "ghost_beer" && isActive(ev) && ev.team_id === drink.team_id)
    .filter((ev) => !stillGhost.has(String(ev.payload.drink_id)));
  posts.sort((a, b) => {
    if (a.payload.drink_id === drink.id) return 1;
    if (b.payload.drink_id === drink.id) return -1;
    return timeOf(a.created_at) - timeOf(b.created_at);
  });
  for (let n = 0; n < lost && posts.length > 0; n++) fb.softDelete(posts.pop()!, ctx.now);
}

// ---- Mulligans ----

function mulliganChanges(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const { before: B, after: A, op } = step;
  const prev = byId(B.mulligans);
  for (const m of A.mulligans) {
    const old = prev.get(m.id);
    if (old === m) continue;
    if (!old && isActive(m)) mulliganUsed(ctx, A, op, m, actor);
    else if (old && isActive(old) && !isActive(m)) {
      // Undo: the post goes away with it.
      for (const ev of ctx.fb.all()) {
        if ((ev.type === "mulligan_used" || ev.type === "groom_mulligan") && isActive(ev) && ev.payload.mulligan_id === m.id) {
          ctx.fb.softDelete(ev, ctx.now);
        }
      }
    }
  }
}

function mulliganUsed(ctx: Ctx, A: TripState, op: Op, m: Mulligan, actor: UUID | null): void {
  const d = ctx.d(A);
  if (m.source === "groom") {
    const payload: GroomMulliganPayload = {
      mulligan_id: m.id,
      hole: m.used_on_hole,
      source: "groom",
      used_by: m.used_by,
      groom_id: d.groomId,
    };
    emit(ctx, {
      type: "groom_mulligan",
      team_id: m.team_id,
      player_id: d.groomId,
      actor_id: actor,
      payload,
      op_id: op.id,
      id_extra: [m.id],
    });
    return;
  }
  const payload: MulliganUsedPayload = {
    mulligan_id: m.id,
    hole: m.used_on_hole,
    source: m.source,
    used_by: m.used_by,
    available: d.mulligans[m.team_id]?.available ?? 0,
  };
  emit(ctx, {
    type: "mulligan_used",
    team_id: m.team_id,
    player_id: m.used_by,
    actor_id: actor,
    payload,
    op_id: op.id,
    id_extra: [m.id],
  });
}

// ---- Contests ----

function contestChanges(ctx: Ctx, step: OpStep, actor: UUID | null): void {
  const { before: B, after: A, op } = step;
  const prev = byId(B.contest_entries);
  for (const e of A.contest_entries) {
    const old = prev.get(e.id);
    if (old === e) continue;
    if (!old && isActive(e)) contestEntered(ctx, step, e, actor);
    else if (old && isActive(old) && !isActive(e) && op.type === "contest.delete" && op.entry_id === e.id) {
      // Withdrawn (not replaced by a re-measure): its post goes away.
      for (const ev of ctx.fb.all()) {
        if (ev.type === "contest_entry" && isActive(ev) && ev.payload.entry_id === e.id) ctx.fb.softDelete(ev, ctx.now);
      }
    }
  }
}

function contestEntered(ctx: Ctx, step: OpStep, e: ContestEntry, actor: UUID | null): void {
  const { before: B, after: A, op } = step;
  const summary = ctx.d(A).contests.find((c) => c.hole === e.hole);
  const view = summary?.entries.find((v) => v.entry.id === e.id);
  const replaced = B.contest_entries.some((x) => x.player_id === e.player_id && x.hole === e.hole && isActive(x));
  const payload: ContestEntryPayload = {
    entry_id: e.id,
    hole: e.hole,
    contest_type: e.type,
    distance: view?.distance ?? e.distance_value,
    unit: e.unit,
    rank: view?.rank ?? null,
    valid: view?.valid ?? e.status !== "flagged",
    status: e.status,
    flag_reason: e.flag_reason,
    invalid_reason: view?.invalid_reason ?? null,
    replaced,
    valid_count: summary ? summary.entries.filter((v) => v.valid).length : 0,
  };
  emit(ctx, {
    type: "contest_entry",
    team_id: e.team_id,
    player_id: e.player_id,
    actor_id: actor,
    payload,
    photo_path: e.photo_path,
    op_id: op.id,
    id_extra: [e.id],
  });
}

// ---------------------------------------------------------------------------
// Commissioner override summaries
// ---------------------------------------------------------------------------

interface OverrideSummary {
  summary: string;
  team_id: UUID | null;
  player_id: UUID | null;
}

const SETTING_LABELS: { [K in keyof TripSettings]: string } = {
  tee_set: "the tees",
  course_name: "the course name",
  roasts_enabled: "AI roasts",
  roast_min_hole_gap: "the roast gap",
  roast_cap: "the roast cap",
  ld_accuracy_limit_m: "the long drive GPS limit",
  ld_min_yd: "the long drive minimum",
  ld_max_yd: "the long drive maximum",
  judge_suspicious_ratio: "the AI judge threshold",
  push_throttle_sec: "the push throttle",
  team_match_ante_cents: "the team match ante",
  contest_ante_cents: "the contest ante",
  team_match_payout: "the team match payout",
  drink_cap: "the drink cap",
};

function settingPhrase(key: keyof TripSettings, v: unknown): string {
  const label = SETTING_LABELS[key];
  switch (key) {
    case "roasts_enabled":
      return `turned AI roasts ${v ? "on" : "off"}`;
    case "team_match_ante_cents":
    case "contest_ante_cents":
      return `set ${label} to ${formatCents(Number(v))}`;
    case "drink_cap":
      return v === null ? "removed the drink cap" : `set the drink cap to ${String(v)}`;
    case "team_match_payout":
      return `set ${label} to ${Array.isArray(v) ? v.map((x) => `${x}%`).join("/") : String(v)}`;
    case "ld_min_yd":
    case "ld_max_yd":
      return `set ${label} to ${String(v)} yd`;
    default:
      return `set ${label} to ${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
  }
}

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What the commissioner did, as a phrase that follows their name. null = nothing worth posting. */
function overrideSummary(op: Op, B: TripState, A: TripState): OverrideSummary | null {
  const P = (id: UUID | null | undefined) => playerLabel(B, id) === "somebody" ? playerLabel(A, id) : playerLabel(B, id);
  const T = (id: UUID | null | undefined) => teamLabel(B, id) === "a team" ? teamLabel(A, id) : teamLabel(B, id);
  const res = (summary: string, team_id: UUID | null = null, player_id: UUID | null = null): OverrideSummary => ({
    summary,
    team_id,
    player_id,
  });

  switch (op.type) {
    case "score.set": {
      const old = B.hole_scores.find((r) => r.team_id === op.team_id && r.hole === op.hole);
      const from = old?.strokes ?? null;
      return from !== null
        ? res(`changed ${T(op.team_id)} hole ${op.hole} from a ${from} to a ${op.strokes}`, op.team_id)
        : res(`entered a ${op.strokes} for ${T(op.team_id)} on hole ${op.hole}`, op.team_id);
    }
    case "teeshot.set":
      return op.player_id
        ? res(`set ${T(op.team_id)}'s hole ${op.hole} tee shot to ${P(op.player_id)}`, op.team_id, op.player_id)
        : res(`cleared ${T(op.team_id)}'s hole ${op.hole} tee shot`, op.team_id);
    case "tee.open":
      return res(`opened hole ${op.hole} for ${T(op.team_id)}`, op.team_id);
    case "round.complete":
      return res(`marked ${T(op.team_id)}'s round complete`, op.team_id);
    case "drink.log":
      return res(`logged a ${op.drink_type} for ${P(op.player_id)} on hole ${op.hole}`, op.team_id, op.player_id);
    case "drink.delete": {
      const dr = B.drinks.find((x) => x.id === op.drink_id);
      if (!dr) return null;
      return res(`deleted ${P(dr.player_id)}'s ${dr.type} on hole ${dr.hole}`, dr.team_id, dr.player_id);
    }
    case "drink.move": {
      const dr = B.drinks.find((x) => x.id === op.drink_id);
      if (!dr) return null;
      return res(
        `moved a drink from hole ${dr.hole} to hole ${op.hole} (${P(dr.player_id)}, ${T(dr.team_id)})`,
        dr.team_id,
        dr.player_id,
      );
    }
    case "mulligan.use":
      return res(
        `used ${op.source === "groom" ? "the Groom's Mulligan" : "a banked mulligan"} for ${T(op.team_id)} on hole ${op.hole}`,
        op.team_id,
      );
    case "mulligan.undo": {
      const m = B.mulligans.find((x) => x.id === op.mulligan_id);
      if (!m) return null;
      return res(`took back ${T(m.team_id)}'s mulligan on hole ${m.used_on_hole}`, m.team_id);
    }
    case "contest.submit": {
      const unit = op.contest_type === "ctp" ? "ft" : "yd";
      return res(
        `entered ${P(op.player_id)}'s ${contestName(op.contest_type)} on hole ${op.hole}: ${fmtDistance(op.distance_value, unit)}`,
        A.contest_entries.find((e) => e.id === op.entry_id)?.team_id ?? null,
        op.player_id,
      );
    }
    case "contest.delete": {
      const e = B.contest_entries.find((x) => x.id === op.entry_id);
      if (!e) return null;
      return res(`deleted ${P(e.player_id)}'s ${contestName(e.type)} entry on hole ${e.hole}`, e.team_id, e.player_id);
    }
    case "contest.review": {
      const e = B.contest_entries.find((x) => x.id === op.entry_id);
      if (!e) return null;
      const verb = op.status === "flagged" ? "flagged" : "approved";
      let s = `${verb} ${P(e.player_id)}'s ${contestName(e.type)} entry on hole ${e.hole}`;
      const after = A.contest_entries.find((x) => x.id === op.entry_id);
      if (after && after.distance_override !== e.distance_override) {
        s += after.distance_override === null
          ? " and cleared the official distance"
          : ` and set the official distance to ${fmtDistance(after.distance_override, e.unit)}`;
      }
      return res(s, e.team_id, e.player_id);
    }
    case "feed.delete": {
      const ev = B.feed_events.find((x) => x.id === op.event_id);
      if (!ev) return null;
      return ev.type === "post"
        ? res(`deleted a post by ${P(ev.player_id)}`, ev.team_id, ev.player_id)
        : res("deleted a feed item", ev.team_id, null);
    }
    case "pot.optout": {
      const pot = op.pot_key === "team_match" ? "team match pot" : `hole ${op.pot_key.slice("contest:".length)} contest pot`;
      return res(`opted ${P(op.player_id)} ${op.out ? "out of" : "back into"} the ${pot}`, null, op.player_id);
    }
    case "player.upsert": {
      const id = op.player.id;
      const old = B.players.find((p) => p.id === id);
      const now = A.players.find((p) => p.id === id);
      if (!now) return null;
      if (!old) return res(`added ${now.name} to the roster`, null, id);
      const parts: string[] = [];
      if (old.name !== now.name) parts.push(`renamed ${old.name} to ${now.name}`);
      if (old.nickname !== now.nickname) {
        parts.push(now.nickname ? `nicknamed ${now.name} "${now.nickname}"` : `dropped ${now.name}'s nickname`);
      }
      if (old.is_groom !== now.is_groom) parts.push(now.is_groom ? `made ${now.name} the groom` : `un-groomed ${now.name}`);
      if (old.venmo_handle !== now.venmo_handle) parts.push(`updated ${now.name}'s Venmo`);
      if (old.sort_order !== now.sort_order) parts.push("reordered the roster");
      // Groom moves also touch the previous groom; those are covered by "made X the groom".
      return parts.length ? res(joinPhrases(parts), null, id) : null;
    }
    case "player.delete":
      return res(`removed ${P(op.player_id)} from the roster`, null, op.player_id);
    case "team.upsert": {
      const id = op.team.id;
      const old = B.teams.find((t) => t.id === id);
      const now = A.teams.find((t) => t.id === id);
      if (!now) return null;
      if (!old) return res(`created ${now.name}`, id);
      const parts: string[] = [];
      if (old.name !== now.name) parts.push(`renamed ${old.name} to ${now.name}`);
      if (old.tee_time !== now.tee_time) parts.push(now.tee_time ? `moved ${now.name}'s tee time to ${now.tee_time}` : `cleared ${now.name}'s tee time`);
      if (old.sort_order !== now.sort_order) parts.push("reordered the teams");
      return parts.length ? res(joinPhrases(parts), id) : null;
    }
    case "team.delete":
      return res(`deleted ${T(op.team_id)}`, op.team_id);
    case "team.assign":
      if (op.team_id === null) {
        const old = B.team_members.find((m) => m.player_id === op.player_id);
        return res(`took ${P(op.player_id)} off ${old ? T(old.team_id) : "their team"}`, old?.team_id ?? null, op.player_id);
      }
      return res(`moved ${P(op.player_id)} to ${T(op.team_id)}`, op.team_id, op.player_id);
    case "hole.update": {
      const old = B.holes.find((h) => h.number === op.hole);
      const now = A.holes.find((h) => h.number === op.hole);
      if (!old || !now) return null;
      const n = op.hole;
      const parts: string[] = [];
      if (old.par !== now.par) parts.push(`changed hole ${n} from a par ${old.par} to a par ${now.par}`);
      if (old.contest !== now.contest) {
        parts.push(now.contest === "none" ? `took the contest off hole ${n}` : `made hole ${n} a ${contestName(now.contest)} hole`);
      }
      if (old.tee_lat !== now.tee_lat || old.tee_lng !== now.tee_lng) parts.push(`moved the hole ${n} tee point`);
      if (old.green_lat !== now.green_lat || old.green_lng !== now.green_lng) parts.push(`moved the hole ${n} green point`);
      if (old.stroke_index !== now.stroke_index) parts.push(`changed hole ${n}'s stroke index`);
      if (JSON.stringify(old.yardage) !== JSON.stringify(now.yardage)) parts.push(`updated hole ${n}'s yardage`);
      return parts.length ? res(joinPhrases(parts)) : null;
    }
    case "trip.update": {
      const o = B.trip;
      const t = A.trip;
      const parts: string[] = [];
      if (o.name !== t.name) parts.push(`renamed the trip to ${t.name}`);
      if (o.app_name !== t.app_name) parts.push(`renamed the app to ${t.app_name}`);
      if (o.base_team_size !== t.base_team_size) {
        parts.push(`changed the ghost beer base team size from ${o.base_team_size} to ${t.base_team_size}`);
      }
      for (const key of Object.keys(SETTING_LABELS) as (keyof TripSettings)[]) {
        if (JSON.stringify(o.settings[key]) !== JSON.stringify(t.settings[key])) parts.push(settingPhrase(key, t.settings[key]));
      }
      return parts.length ? res(joinPhrases(parts)) : null;
    }
    case "trip.reopen":
      return res("reopened the round");
    case "round.set_state": {
      const team = T(op.team_id);
      if (op.status === "complete") return res(`marked ${team}'s round complete`, op.team_id);
      if (op.status === "not_started") return res(`reset ${team} to not started`, op.team_id);
      return res(`put ${team} on hole ${op.open_hole ?? "?"}`, op.team_id);
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Batch-level state diffs
// ---------------------------------------------------------------------------

/** Leaderboard lead vs the latest lead_change post (or nobody). */
function leadChange(ctx: Ctx, last: TripState, lastOp: Op): void {
  const d = ctx.d(last);
  const leaders = sortIds(d.leaderTeamIds);
  if (leaders.length === 0) return; // nobody has scored
  const prevEv = ctx.fb.latest((ev) => ev.type === "lead_change");
  const prev = prevEv ? sortIds(strArr(prevEv.payload.leader_team_ids)) : [];
  if (sameIds(prev, leaders)) return;
  const row = d.standings.find((r) => r.team_id === leaders[0]);
  // Present leaders in leaderboard order.
  const ordered = d.standings.filter((r) => leaders.includes(r.team_id)).map((r) => r.team_id);
  const payload: LeadChangePayload = {
    leader_team_ids: ordered,
    previous_leader_team_ids: prev,
    net_to_par: row?.net_to_par ?? 0,
    thru: row?.thru ?? 0,
  };
  emit(ctx, {
    type: "lead_change",
    team_id: ordered.length === 1 ? ordered[0] : null,
    payload,
    op_id: lastOp.id,
  });
}

function contestLeads(ctx: Ctx, first: TripState, last: TripState, actorByHole: Map<number, UUID | null>): void {
  const before = new Map(ctx.d(first).contests.map((c) => [c.hole, c]));
  for (const c of ctx.d(last).contests) {
    const cur = sortIds(c.leader_ids);
    if (cur.length === 0 || c.best === null) continue;
    const prevSummary = before.get(c.hole);
    const prev = prevSummary && prevSummary.type === c.type ? sortIds(prevSummary.leader_ids) : [];
    if (sameIds(prev, cur)) continue;
    // Leaderboard order (earliest submission first among ties).
    const leaderViews = c.entries.filter((v) => v.valid && v.rank === 1);
    const leaderView = leaderViews[0];
    const payload: ContestLeadPayload = {
      hole: c.hole,
      contest_type: c.type,
      leader_ids: leaderViews.map((v) => v.player_id),
      previous_leader_ids: prev,
      distance: c.best,
      unit: c.type === "ctp" ? "ft" : "yd",
    };
    emit(ctx, {
      type: "contest_lead",
      team_id: leaderView?.team_id ?? null,
      player_id: payload.leader_ids[0] ?? null,
      actor_id: actorByHole.get(c.hole) ?? null,
      payload,
      photo_path: payload.leader_ids.length === 1 ? (leaderView?.entry.photo_path ?? null) : null,
      dedupe_key: `ctplead:${c.hole}:${cur.join(",")}`,
    });
  }
}

/**
 * Drive minimum. Hard (remaining === players needing): one post per remaining count, so each hole
 * where it's still on the edge says so. Impossible: once when it gets there. Misses: once per nine.
 */
function driveMinimum(ctx: Ctx, first: TripState, last: TripState, actorByTeam: Map<UUID, UUID | null>): void {
  if (last.trip.status === "setup") return;
  const dPrev = ctx.d(first).driveMin;
  for (const st of Object.values(ctx.d(last).driveMin)) {
    const teamId = st.team_id;
    for (const nine of st.nines) {
      const prev: DriveNineStatus | undefined = dPrev[teamId]?.nines[nine.nine - 1];
      if (last.trip.status === "live" && (nine.level === "hard" || nine.level === "impossible")) {
        const post = nine.level === "hard" || prev?.level !== "impossible";
        if (post) {
          const payload: DriveWarningPayload = {
            nine: nine.nine,
            level: nine.level,
            remaining: nine.remaining,
            needing: [...nine.needing],
          };
          emit(ctx, {
            type: "drive_warning",
            team_id: teamId,
            actor_id: actorByTeam.get(teamId) ?? null,
            payload,
            dedupe_key: `drivehard:${teamId}:${nine.nine}:${nine.remaining}`,
          });
        }
      }
      if (nine.closed && nine.missed.length > 0) {
        const payload: DriveMissPayload = { nine: nine.nine, missed: [...nine.missed], commissioner_flag: true };
        emit(ctx, {
          type: "drive_miss",
          team_id: teamId,
          actor_id: actorByTeam.get(teamId) ?? null,
          payload,
          dedupe_key: `drivemiss:${teamId}:${nine.nine}`,
        });
      }
    }
  }
}

/** Team and contest hole an op touched (for attributing batch-level events). */
function opTargets(op: Op, B: TripState): { team: UUID | null; contestHole: number | null } {
  const entryOf = (id: UUID) => B.contest_entries.find((e) => e.id === id);
  switch (op.type) {
    case "drink.delete":
    case "drink.move":
      return { team: B.drinks.find((x) => x.id === op.drink_id)?.team_id ?? null, contestHole: null };
    case "mulligan.undo":
      return { team: B.mulligans.find((x) => x.id === op.mulligan_id)?.team_id ?? null, contestHole: null };
    case "contest.submit":
      return { team: B.team_members.find((m) => m.player_id === op.player_id)?.team_id ?? null, contestHole: op.hole };
    case "contest.delete":
    case "contest.review": {
      const e = entryOf(op.entry_id);
      return { team: e?.team_id ?? null, contestHole: e?.hole ?? null };
    }
    default:
      return { team: "team_id" in op && typeof op.team_id === "string" ? op.team_id : null, contestHole: null };
  }
}

// ---------------------------------------------------------------------------
// Roast and push triggers
// ---------------------------------------------------------------------------

/** Spec "AI roasts" triggers. Exported so routes that create events themselves (AI judge) can reuse it. */
export function roastTriggerFor(ev: FeedEvent): RoastTrigger | null {
  if (ev.deleted_at !== null) return null;
  const p = ev.payload ?? {};
  const hole = typeof p.hole === "number" ? p.hole : null;
  const t = (big: boolean): RoastTrigger => ({ feed_event_id: ev.id, type: ev.type, team_id: ev.team_id, hole, big });
  switch (ev.type) {
    case "score_notable":
      return p.kind === "double" || p.kind === "triple_plus" || p.kind === "last_at_turn" ? t(false) : null;
    case "round_complete":
      return p.last === true ? t(true) : null;
    case "ai_judge":
      return p.suspicious === true ? t(false) : null;
    case "ghost_beer":
      return t(false);
    case "drive_miss":
    case "lead_change":
    case "groom_mulligan":
      return t(true);
    default:
      return null;
  }
}

/** Spec "Push notifications". Exported for routes that create events themselves (AI judge, roasts). */
export function pushTriggerFor(ev: FeedEvent, state: TripState, d: Derived): PushTrigger | null {
  if (ev.deleted_at !== null) return null;
  const p = ev.payload ?? {};
  let audience: PushTrigger["audience"] = { kind: "all" };
  let collapse: string;
  switch (ev.type) {
    case "lead_change":
      collapse = "lead";
      break;
    case "contest_lead":
      collapse = `ctplead:${String(p.hole)}`;
      break;
    case "groom_mulligan":
      collapse = "groom";
      break;
    case "final_results":
      collapse = "final";
      break;
    case "ai_judge":
      if (p.suspicious !== true) return null;
      collapse = `judge:${typeof p.entry_id === "string" ? p.entry_id : ev.id}`;
      break;
    case "roast":
      if (!ev.team_id) return null;
      audience = { kind: "team", team_id: ev.team_id };
      collapse = `roast:${ev.team_id}`;
      break;
    default:
      return null;
  }
  let title: string = ev.type;
  let body = "";
  try {
    const r = renderFeedEvent(ev, state, d);
    title = `${r.emoji} ${r.title}`.trim();
    body = r.body;
  } catch (err) {
    console.error("[feed] push copy failed", err);
  }
  return { feed_event_id: ev.id, title, body, audience, collapse_key: collapse };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * steps: applied (not duplicate, not rejected) ops in order with their before/after states.
 * existingFeed: the feed as of before the batch (to dedupe and to find drink batches).
 */
export function deriveFeedEvents(args: {
  steps: OpStep[];
  existingFeed: FeedEvent[];
  now: ISODate;
}): DeriveEventsResult {
  const { steps, existingFeed, now } = args;
  if (steps.length === 0) return { feed: [], roast_triggers: [], push_triggers: [] };

  const cache = new WeakMap<TripState, Derived>();
  const parsedNow = Date.parse(now);
  const ctx: Ctx = {
    tripId: steps[0].before.trip.id,
    now,
    nowMs: Number.isFinite(parsedNow) ? parsedNow : 0,
    fb: new FeedBuilder(existingFeed),
    d(s) {
      let d = cache.get(s);
      if (!d) {
        d = derive(s, { now });
        cache.set(s, d);
      }
      return d;
    },
  };

  const actorByTeam = new Map<UUID, UUID | null>();
  const actorByContestHole = new Map<number, UUID | null>();
  for (const step of steps) {
    if (step.after.feed_events !== step.before.feed_events) {
      ctx.fb.absorbReducerFeed(step.before.feed_events, step.after.feed_events);
    }
    if (step.after === step.before) continue; // the op changed nothing
    safely(`${step.op.type} ${step.op.id}`, () => eventsForStep(ctx, step));
    const targets = opTargets(step.op, step.before);
    const actor = actorOf(step.after, step.op.by);
    if (targets.team) actorByTeam.set(targets.team, actor);
    if (targets.contestHole !== null) actorByContestHole.set(targets.contestHole, actor);
  }

  const first = steps[0].before;
  const last = steps[steps.length - 1].after;
  if (last !== first) {
    safely("lead change", () => leadChange(ctx, last, steps[steps.length - 1].op));
    safely("contest leads", () => contestLeads(ctx, first, last, actorByContestHole));
    safely("drive minimum", () => driveMinimum(ctx, first, last, actorByTeam));
  }

  const roast_triggers: RoastTrigger[] = [];
  const push_triggers: PushTrigger[] = [];
  safely("triggers", () => {
    const d = ctx.d(last);
    for (const ev of [...ctx.fb.createdRows(), ...ctx.fb.foreign]) {
      const r = roastTriggerFor(ev);
      if (r) roast_triggers.push(r);
      const p = pushTriggerFor(ev, last, d);
      if (p) push_triggers.push(p);
    }
  });

  return { feed: ctx.fb.output(), roast_triggers, push_triggers };
}
