// The authoritative server apply pipeline behind POST /api/t/<code>/sync.
//
//   db.tx:
//     lockTrip            per-trip advisory lock: writers of one trip run one at a time
//     getAppliedOps       exactly-once: an op id seen before is never re-evaluated: applied →
//                         "duplicate", rejected → the recorded rejection again (a phone whose
//                         response got lost still hears that its op was refused)
//     loadTripState       the state the whole batch builds on
//     demo budget         a demo trip past DEMO_MAX_APPLIED_OPS rejects every new op unrecorded
//     for each op, in order:
//       normalize         light shape check (uuid id, known type, ISO `at`), canonical `at`,
//                         clamped to server now + 2 min (a phone with a clock in the future must
//                         not win every last-write-wins comparison forever)
//       applyOp           the SAME reducer the phones run optimistically (side: "server")
//       validateWrites    rows the database would choke on reject this op only
//     deriveFeedEvents    feed rows from the accepted steps (new events + updated drink batches),
//                         plus an "overruled" score_edit for each dispute (team, hole, losing and
//                         winning value) a score.set lost last-write-wins (rejected ops make no
//                         steps, but the spec wants the dispute on the feed in either sync order)
//     persist             reducer writes + feed rows + applied_ops bookkeeping
//   → results (one per op, request order) + snapshot (final in-memory state + snapshotMeta)
//
// Normally a batch is ONE transaction and a handful of statements however many ops it has.
// Poison isolation: if that transaction fails with a deterministic data error (constraint
// violation, bad value) or a row id owned by another trip, the batch is split in halves, each
// applied in order in its own transaction, recursively, until the bad op stands alone; it is then
// retried without its feed events (in case only those were the problem) and otherwise rejected
// and recorded. Failing the request instead would make the phone resend the same poison batch
// forever and wedge its outbox. Anything else (connection loss, timeouts) fails the request: the
// phone retries later, which is safe because nothing was committed.
// (Splitting into separate transactions rather than using savepoints is deliberate: postgres.js
// remembers any failed query inside begin() and rethrows it at COMMIT, so a raw ROLLBACK TO
// SAVEPOINT can't rescue the transaction on real Postgres.)
//
// Everything inside a transaction uses the handle `t` it was given (never the root db: on PGlite
// that would deadlock, see db.ts).
import { applyOp, CLOCK_GRACE_MS, type ApplyCtx, type Write } from "@/lib/reducer";
import { deriveFeedEvents, overruledScoreEvent, type DeriveEventsResult, type OpStep } from "@/lib/events/derive";
import type { Op, OpResult, OpType, RejectCode } from "@/lib/ops";
import { ROW_TABLES, type FeedEvent, type RowTable, type Snapshot, type Trip, type TripState, type UUID } from "@/lib/types";
import { pgErrorCode, type Db } from "./db";
import {
  getAppliedOps,
  InvalidWriteError,
  isUuid,
  loadTripState,
  lockTrip,
  persistWrites,
  recordAppliedOps,
  ROW_SPECS,
  validateWrite,
  validateWrites,
  type AppliedOpRow,
  type ColDef,
  type PersistResult,
} from "./repo";
import { buildSnapshot, pushPublicKey, snapshotMeta } from "./trips";

/** Max ops per sync request (the phone sends ≤ 100 per batch). */
export const MAX_OPS_PER_SYNC = 200;
/** An op's client time is clamped to at most server now + this (clock skew allowance). */
export const MAX_CLOCK_SKEW_MS = CLOCK_GRACE_MS;
/**
 * Write budget of a demo trip (anyone can make one, no PIN): once it has this many applied_ops
 * rows (accepted + rejected), every further new op is rejected without being recorded, so
 * "Try the demo" can't fill the database the real round lives in. Reset demo starts over.
 * A fresh "partial" demo uses a few hundred.
 */
export const DEMO_MAX_APPLIED_OPS = 3000;
export const DEMO_FULL_REASON = "Demo's full. Hit Reset demo.";

export interface ApplyOpsArgs {
  db: Db;
  trip: Pick<Trip, "id">;
  /** Ops as received (parsed JSON); each one is shape-checked here. */
  ops: readonly unknown[];
  /** The request carries a valid commissioner cookie for this trip. */
  isCommissioner: boolean;
  /** Server clock override (tests). Default: the time the trip lock was acquired. */
  now?: Date;
}

export interface ApplyOpsResult {
  /** One per op, in request order. */
  results: OpResult[];
  /** The trip after the batch (every row, in loadTripState order) + runtime meta. */
  snapshot: Snapshot;
  /** Feed rows persisted by this batch (latest version of each) and the roast/push triggers they fire. */
  events: DeriveEventsResult;
  /** The ops that were applied, normalized (canonical, clamped `at`; `by` null when absent), in order. */
  applied: Op[];
}

export class TooManyOpsError extends Error {
  constructor(readonly count: number) {
    super(`Too many ops in one sync: ${count} (max ${MAX_OPS_PER_SYNC})`);
    this.name = "TooManyOpsError";
  }
}

/** ApplyOpsArgs plus what applyOpsToTrip resolves once per request, outside the transactions. */
interface SegmentArgs extends ApplyOpsArgs {
  /** Snapshot meta's push key (pushPublicKey). */
  vapidPublicKey: string | null;
}

const NO_EVENTS: DeriveEventsResult = { feed: [], roast_triggers: [], push_triggers: [] };

// ---------------------------------------------------------------------------
// Op shape check + normalization
// ---------------------------------------------------------------------------

/** Every op type the reducer knows (a Record so a new OpType is a compile error until listed). */
const OP_TYPES: Record<OpType, true> = {
  "tee.open": true,
  "round.complete": true,
  "score.set": true,
  "teeshot.set": true,
  "drink.log": true,
  "drink.delete": true,
  "drink.move": true,
  "mulligan.use": true,
  "mulligan.undo": true,
  "contest.submit": true,
  "contest.delete": true,
  "contest.review": true,
  "post.create": true,
  "feed.delete": true,
  "reaction.set": true,
  "pot.optout": true,
  "player.mute": true,
  "player.upsert": true,
  "player.delete": true,
  "team.upsert": true,
  "team.delete": true,
  "team.assign": true,
  "hole.update": true,
  "trip.update": true,
  "trip.start": true,
  "trip.finalize": true,
  "trip.reopen": true,
  "round.set_state": true,
};

function isOpType(v: unknown): v is OpType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(OP_TYPES, v);
}

/** ISO-8601 with an explicit zone (a zoneless time means different things to JS and Postgres). */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const rawIdOf = (raw: unknown): string => (isPlainObject(raw) && typeof raw.id === "string" ? raw.id : "");

type Normalized = { ok: true; op: Op } | { ok: false; reason: string };

/**
 * Light shape check; the reducer validates the payload. Returns a copy with `at` canonical
 * (toISOString, so the in-memory state matches what Postgres hands back) and clamped to
 * now + MAX_CLOCK_SKEW_MS, and `by` defaulting to null.
 */
function normalizeOp(raw: Record<string, unknown>, nowMs: number): Normalized {
  if (!isUuid(raw.id)) return { ok: false, reason: "That op has no valid id. Somebody's phone is drunk." };
  if (!isOpType(raw.type)) return { ok: false, reason: "Unknown op. The app doesn't speak that language." };
  const at = raw.at;
  const t = typeof at === "string" && ISO_RE.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return { ok: false, reason: "That op has no valid timestamp. Check your phone's clock." };
  const by = raw.by === undefined ? null : raw.by;
  if (by !== null && !isUuid(by)) return { ok: false, reason: "That op came from nobody we know." };
  const clamped = Math.min(t, nowMs + MAX_CLOCK_SKEW_MS);
  return { ok: true, op: { ...raw, at: new Date(clamped).toISOString(), by } as unknown as Op };
}

// ---------------------------------------------------------------------------
// Running ops through the reducer (pure)
// ---------------------------------------------------------------------------

type AppliedOpRecord = Omit<AppliedOpRow, "applied_at">;

interface BatchRun {
  results: OpResult[];
  steps: OpStep[];
  /** Writes of every accepted op, in order. */
  writes: Write[];
  applied: Op[];
  /** applied_ops rows to insert (accepted + rejected ops that have a uuid id). */
  records: AppliedOpRecord[];
  /** State after the last accepted op (reducer output only; derived feed rows not merged). */
  state: TripState;
  /** "Overruled" score_edit rows for score.set ops rejected as stale (see overruledScoreEvent). */
  overruled: FeedEvent[];
}

const BAD_DATA_REASON = "That one didn't compute. Malformed data?";

function rejectionRecord(tripId: UUID, id: string, opType: string, code: RejectCode, reason: string): AppliedOpRecord {
  return { id, trip_id: tripId, op_type: opType, status: "rejected", code, reason };
}

/** The answer for an op id processed before: "duplicate", or the rejection it got back then. */
function seenResult(id: string, prev: Pick<AppliedOpRow, "status" | "code" | "reason">): OpResult {
  if (prev.status !== "rejected") return { id, status: "duplicate" };
  return { id, status: "rejected", code: (prev.code ?? "invalid") as RejectCode, reason: prev.reason ?? "" };
}

/**
 * Run the ops in order against `initial`, exactly once by id. Pure. `budget`: how many more
 * applied_ops rows this trip may get (null = unlimited); past it, new ops are rejected unrecorded.
 */
function runOps(
  tripId: UUID,
  initial: TripState,
  ops: readonly unknown[],
  prior: ReadonlyMap<string, AppliedOpRow>,
  ctx: ApplyCtx,
  budget: number | null = null,
): BatchRun {
  const run: BatchRun = { results: [], steps: [], writes: [], applied: [], records: [], state: initial, overruled: [] };
  const nowMs = Date.parse(ctx.now);
  const seen = new Map<string, number>(); // lowercase id handled earlier in this batch -> its result's index

  const reject = (id: string, opType: string, code: RejectCode, reason: string) => {
    run.results.push({ id, status: "rejected", code, reason });
    // Recorded so a resend gets this same answer instead of being re-evaluated against a newer state.
    if (isUuid(id)) run.records.push(rejectionRecord(tripId, id, opType, code, reason));
  };

  for (const raw of ops) {
    if (!isPlainObject(raw)) {
      run.results.push({ id: "", status: "rejected", code: "invalid", reason: "That's not an op." });
      continue;
    }
    const rawId = rawIdOf(raw);
    const rawType = typeof raw.type === "string" ? raw.type : "unknown";

    // Exactly-once: decided by id alone, before anything else about the op.
    if (isUuid(rawId)) {
      const key = rawId.toLowerCase();
      const before = prior.get(rawId);
      if (before) {
        run.results.push(seenResult(rawId, before));
        continue;
      }
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        const first = run.results[earlier];
        run.results.push(first.status === "rejected" ? { ...first, id: rawId } : { id: rawId, status: "duplicate" });
        continue;
      }
      seen.set(key, run.results.length); // every path below pushes exactly one result
    }

    // A demo trip out of write budget: nothing new is evaluated or recorded (not even rejections).
    if (budget !== null && run.records.length >= budget) {
      run.results.push({ id: rawId, status: "rejected", code: "conflict", reason: DEMO_FULL_REASON });
      continue;
    }

    const n = normalizeOp(raw, nowMs);
    if (!n.ok) {
      reject(rawId, rawType, "invalid", n.reason);
      continue;
    }
    const op = n.op;

    const r = applyOp(run.state, op, ctx);
    if (!r.ok) {
      reject(op.id, op.type, r.code, r.reason);
      if (op.type === "score.set" && r.code === "conflict") {
        const ev = overruledScoreEvent(run.state, op, ctx.now);
        if (ev && !run.overruled.some((x) => x.id === ev.id)) run.overruled.push(ev);
      }
      continue;
    }
    if (r.writes.length > 0) {
      const problems = validateWrites(tripId, r.writes);
      if (problems.length > 0) {
        console.warn(`[sync] rejected ${op.type} ${op.id}: unsavable writes: ${problems.slice(0, 3).join("; ")}`);
        reject(op.id, op.type, "invalid", BAD_DATA_REASON);
        continue;
      }
    }

    run.steps.push({ op, before: run.state, after: r.state, is_commissioner: ctx.is_commissioner });
    run.writes.push(...r.writes);
    run.applied.push(op);
    run.results.push({ id: op.id, status: "applied" });
    run.records.push({ id: op.id, trip_id: tripId, op_type: op.type, status: "applied", code: null, reason: null });
    run.state = r.state;
  }
  return run;
}

// ---------------------------------------------------------------------------
// Feed events
// ---------------------------------------------------------------------------

/** Derive feed rows for the accepted steps (+ overruled scores). Never throws (the ops must commit regardless). */
function deriveEvents(tripId: UUID, run: BatchRun, existingFeed: FeedEvent[], now: string): DeriveEventsResult {
  if (run.steps.length === 0 && run.overruled.length === 0) return NO_EVENTS;
  let ev: DeriveEventsResult;
  try {
    ev = deriveFeedEvents({ steps: run.steps, existingFeed, now });
  } catch (e) {
    console.error("[sync] deriving feed events failed; committing the ops without them", e);
    ev = NO_EVENTS;
  }
  if (run.overruled.length > 0) ev = { ...ev, feed: [...ev.feed, ...run.overruled] };
  // A malformed row would make persistWrites throw for the whole batch: drop it instead.
  const bad = new Set<UUID>();
  for (const row of ev.feed) {
    const problem = validateWrite(tripId, { kind: "upsert", table: "feed_events", row });
    if (problem) {
      console.error(`[sync] dropping unsavable ${row.type} feed event ${row.id}: ${problem}`);
      bad.add(row.id);
    }
  }
  return withoutEvents(ev, bad);
}

function withoutEvents(ev: DeriveEventsResult, drop: ReadonlySet<UUID>): DeriveEventsResult {
  if (drop.size === 0) return ev;
  return {
    feed: ev.feed.filter((e) => !drop.has(e.id)),
    roast_triggers: ev.roast_triggers.filter((r) => !drop.has(r.feed_event_id)),
    push_triggers: ev.push_triggers.filter((p) => !drop.has(p.feed_event_id)),
  };
}

/**
 * Upsert derived feed rows. Returns the ids persistWrites skipped (a dedupe_key that another
 * event already owns, e.g. inserted by a writer outside the trip lock): those never happened.
 */
async function persistFeed(db: Db, tripId: UUID, feed: FeedEvent[]): Promise<Set<UUID>> {
  if (feed.length === 0) return new Set();
  const res = await persistWrites(
    db,
    tripId,
    feed.map((row): Write => ({ kind: "upsert", table: "feed_events", row })),
  );
  return new Set(res.skipped.map((s) => s.id));
}

/** Events of consecutive segments as one result: latest version of each row, first-seen order. */
function mergeEvents(list: DeriveEventsResult[]): DeriveEventsResult {
  if (list.length === 1) return list[0];
  const feed = new Map<UUID, FeedEvent>();
  for (const ev of list) for (const row of ev.feed) feed.set(row.id, row);
  return {
    feed: [...feed.values()],
    roast_triggers: list.flatMap((ev) => ev.roast_triggers),
    push_triggers: list.flatMap((ev) => ev.push_triggers),
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Some reducer row landed on an id owned by another trip (persistWrites skipped it). */
class ForeignRowError extends Error {
  constructor(readonly skipped: PersistResult["skipped"]) {
    super(`rows owned by another trip: ${skipped.map((s) => `${s.table} ${s.id}`).join(", ")}`);
    this.name = "ForeignRowError";
  }
}

/**
 * A failure caused by the data being written, which fails the same way every time: SQLSTATE
 * class 22 (data exception), 23 (integrity constraint violation), 54 (program limit, e.g. an
 * index row too large), a write our own validation refused, or a row owned by another trip.
 */
function isDataFailure(e: unknown): boolean {
  if (e instanceof ForeignRowError || e instanceof InvalidWriteError) return true;
  const code = pgErrorCode(e);
  return !!code && /^(22|23|54)/.test(code);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Final state
// ---------------------------------------------------------------------------

type SortKey = { col: string; kind: "num" | "time" | "text" };

/** ORDER BY columns of each table (from ROW_SPECS, so the in-memory snapshot matches a reload). */
const SORT_KEYS: { [T in RowTable]: SortKey[] } = Object.fromEntries(
  ROW_TABLES.map((table) => {
    const cols = ROW_SPECS[table].columns as Record<string, ColDef>;
    const keys = ROW_SPECS[table].orderBy.split(",").map((s): SortKey => {
      const col = s.trim();
      const def = cols[col];
      const base = typeof def === "string" ? def.replace("?", "") : "text";
      return { col, kind: base === "int" || base === "float" ? "num" : base === "ts" ? "time" : "text" };
    });
    return [table, keys];
  }),
) as { [T in RowTable]: SortKey[] };

function compareValues(a: unknown, b: unknown, kind: SortKey["kind"]): number {
  // Postgres ASC puts NULLs last.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (kind === "num") return Number(a) - Number(b);
  if (kind === "time") return Date.parse(String(a)) - Date.parse(String(b));
  // uuids compare bytewise in Postgres = lowercase hex string order.
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Rows of every table in loadTripState's ORDER BY (copies; inputs untouched). */
export function sortLikeDb(state: TripState): TripState {
  const out = { ...state } as Record<string, unknown>;
  for (const table of ROW_TABLES) {
    const keys = SORT_KEYS[table];
    const rows = state[table] as unknown as Record<string, unknown>[];
    out[table] = [...rows].sort((a, b) => {
      for (const k of keys) {
        const c = compareValues(a[k.col], b[k.col], k.kind);
        if (c !== 0) return c;
      }
      return 0;
    });
  }
  return out as unknown as TripState;
}

function mergeFeed(state: TripState, feed: FeedEvent[]): TripState {
  if (feed.length === 0) return state;
  const byId = new Map(state.feed_events.map((e) => [e.id, e]));
  for (const ev of feed) byId.set(ev.id, ev);
  return { ...state, feed_events: [...byId.values()] };
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

interface Segment {
  results: OpResult[];
  events: DeriveEventsResult;
  applied: Op[];
  /** null when the segment only recorded a rejection (state unchanged, not loaded). */
  snapshot: Snapshot | null;
}

/** applied_ops rows of the trip (read under the trip lock: no other writer adds any meanwhile). */
async function countAppliedOps(t: Db, tripId: UUID): Promise<number> {
  const [row] = await t.query<{ n: number }>("select count(*)::int as n from applied_ops where trip_id = $1", [tripId]);
  return Number(row?.n ?? 0);
}

/** Lock, load, check ids. Shared prologue of every transaction here. */
async function begin(t: Db, args: ApplyOpsArgs, ops: readonly unknown[]) {
  await lockTrip(t, args.trip.id);
  // Taken under the lock so created_at follows commit order (drink batching compares it to now).
  const now = (args.now ?? new Date()).toISOString();
  const prior = await getAppliedOps(t, args.trip.id, ops.map(rawIdOf).filter(isUuid));
  return { now, prior };
}

/**
 * Apply `ops` in ONE transaction. Throws (rolling everything back) on any failure; `withFeed`
 * false skips deriving feed events (last resort for an op whose events can't be saved).
 */
function applySegment(args: SegmentArgs, ops: readonly unknown[], withFeed: boolean): Promise<Segment> {
  const tripId = args.trip.id;
  return args.db.tx(async (t) => {
    const { now, prior } = await begin(t, args, ops);
    const initial = await loadTripState(t, tripId);
    const ctx: ApplyCtx = { now, is_commissioner: args.isCommissioner, side: "server" };
    const budget = initial.trip.is_demo ? Math.max(0, DEMO_MAX_APPLIED_OPS - (await countAppliedOps(t, tripId))) : null;
    const run = runOps(tripId, initial, ops, prior, ctx, budget);
    let events = withFeed ? deriveEvents(tripId, run, initial.feed_events, now) : NO_EVENTS;

    if (run.writes.length > 0) {
      const res = await persistWrites(t, tripId, run.writes);
      if (res.skipped.length > 0) throw new ForeignRowError(res.skipped);
    }
    const dropped = await persistFeed(t, tripId, events.feed);
    events = withoutEvents(events, dropped);
    await recordAppliedOps(t, run.records);

    // Stamped last thing before COMMIT: every locked writer that committed before this time is
    // in the state (they held the lock before us), and so is this batch.
    const serverTime = new Date().toISOString();
    const state = sortLikeDb(mergeFeed(run.state, events.feed));
    return { results: run.results, events, applied: run.applied, snapshot: { state, meta: snapshotMeta(tripId, args.vapidPublicKey, serverTime) } };
  });
}

/** Record a single op the database refused (unless it was already recorded meanwhile). */
function rejectSegment(args: ApplyOpsArgs, raw: unknown, cause: unknown): Promise<Segment> {
  const id = rawIdOf(raw);
  const type = isPlainObject(raw) && typeof raw.type === "string" ? raw.type : "unknown";
  const [code, reason]: [RejectCode, string] =
    cause instanceof ForeignRowError
      ? ["conflict", "That id is already taken by another trip. Weird. Try again."]
      : ["invalid", "The scorebook refused that one. It's been tossed."];
  console.warn(`[sync] rejected ${type} ${id}: ${errorText(cause)}`);
  return args.db.tx(async (t) => {
    const { prior } = await begin(t, args, [raw]);
    const before = prior.get(id);
    if (before) return { results: [seenResult(id, before)], events: NO_EVENTS, applied: [], snapshot: null };
    await recordAppliedOps(t, [rejectionRecord(args.trip.id, id, type, code, reason)]);
    return { results: [{ id, status: "rejected", code, reason }], events: NO_EVENTS, applied: [], snapshot: null };
  });
}

/** applySegment, isolating ops whose data the database refuses (see the header comment). */
async function applyIsolating(args: SegmentArgs, ops: readonly unknown[]): Promise<Segment[]> {
  let failure: unknown;
  try {
    return [await applySegment(args, ops, true)];
  } catch (e) {
    if (!isDataFailure(e)) throw e;
    failure = e;
  }
  if (ops.length > 1) {
    console.warn(`[sync] ${ops.length} ops for trip ${args.trip.id} failed to save together (${errorText(failure)}); splitting to isolate the bad one`);
    const mid = Math.ceil(ops.length / 2);
    const first = await applyIsolating(args, ops.slice(0, mid));
    const second = await applyIsolating(args, ops.slice(mid));
    return [...first, ...second];
  }
  // One op left. Maybe only its feed events are unsavable: commit the op without them.
  try {
    const seg = await applySegment(args, ops, false);
    if (seg.applied.length > 0) {
      console.error(`[sync] op ${rawIdOf(ops[0])} committed without its feed events (${errorText(failure)})`);
    }
    return [seg];
  } catch (e) {
    if (!isDataFailure(e)) throw e;
    return [await rejectSegment(args, ops[0], e)];
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Apply a sync batch to a trip, exactly once per op id, under the trip lock: normally in one
 * transaction, split into several only to isolate ops the database refuses (header comment).
 * Per-op problems become "rejected" results; only infrastructure failures throw. The request then
 * fails and the phone retries the batch, which is safe: whatever did commit answers "duplicate".
 * Throws TripNotFoundError (from repo) when the trip is gone and TooManyOpsError past the limit.
 */
export async function applyOpsToTrip(args: ApplyOpsArgs): Promise<ApplyOpsResult> {
  const { db, trip, ops } = args;
  if (ops.length > MAX_OPS_PER_SYNC) throw new TooManyOpsError(ops.length);
  if (ops.length === 0) {
    // Nothing to write: a plain consistent read, no lock.
    return { results: [], snapshot: await buildSnapshot(db, trip), events: NO_EVENTS, applied: [] };
  }

  const segments = await applyIsolating({ ...args, vapidPublicKey: await pushPublicKey(db) }, ops);
  let snapshot: Snapshot | null = null;
  for (const s of segments) if (s.snapshot) snapshot = s.snapshot;
  return {
    results: segments.flatMap((s) => s.results),
    // Only a lone rejected op has no snapshot of its own; it changed nothing visible.
    snapshot: snapshot ?? (await buildSnapshot(db, trip)),
    events: mergeEvents(segments.map((s) => s.events)),
    applied: segments.flatMap((s) => s.applied),
  };
}
