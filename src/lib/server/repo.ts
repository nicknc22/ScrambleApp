// Repository: every SQL statement that touches trip data. Generic over the tables in TripState,
// driven by the column specs below (adding a table = one entry in ROW_SPECS + the migration).
//
// The sync agent's server flow (src/lib/server/apply.ts) is expected to be:
//   db.tx(async (t) => {
//     await lockTrip(t, trip.id);                       // serialize writers per trip
//     const seen = await getAppliedOps(t, trip.id, ids);  // exactly-once
//     let state = await loadTripState(t, trip.id);
//     ... applyOp(state, op, ctx) → check validateWrites(trip.id, writes) → collect writes ...
//     await persistWrites(t, trip.id, writes);
//     await recordAppliedOps(t, rows);
//   })
import type { Db } from "./db";
import type { Write } from "@/lib/reducer";
import type { OpResultStatus } from "@/lib/ops";
import { ROW_TABLES, type FeedEvent, type RowOf, type RowTable, type Trip, type TripState, type UUID } from "@/lib/types";

// ---------------------------------------------------------------------------
// Column specs
// ---------------------------------------------------------------------------

type Scalar = "uuid" | "text" | "int" | "float" | "bool" | "ts" | "jsonb" | "int[]";
/** Column type; a trailing "?" means nullable. Enums list their allowed values. */
export type ColDef = Scalar | `${Scalar}?` | { enum: readonly string[]; nullable?: boolean };

type Spec<Row> = { readonly [K in keyof Row]-?: ColDef };

export interface TableSpec<Row = Record<string, unknown>> {
  /** Every column of the row type, in table order (the mapped type makes omissions a compile error). */
  columns: Spec<Row>;
  /** ORDER BY for loadTripState (deterministic). */
  orderBy: string;
}

const TRIP_STATUS = ["setup", "live", "final"] as const;

/** Client-visible trip columns (never commissioner_pin_hash). */
export const TRIP_SPEC: Spec<Trip> = {
  id: "uuid",
  code: "text",
  name: "text",
  app_name: "text",
  status: { enum: TRIP_STATUS },
  base_team_size: "int",
  settings: "jsonb",
  is_demo: "bool",
  created_at: "ts",
  started_at: "ts?",
  finalized_at: "ts?",
  updated_at: "ts",
};

export const ROW_SPECS: { readonly [T in RowTable]: TableSpec<RowOf<T>> } = {
  players: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      name: "text",
      nickname: "text?",
      venmo_handle: "text?",
      is_groom: "bool",
      muted_push: "bool",
      sort_order: "int",
      created_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
  teams: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      name: "text",
      tee_time: "text?",
      sort_order: "int",
      created_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
  team_members: {
    columns: { id: "uuid", trip_id: "uuid", team_id: "uuid", player_id: "uuid", created_at: "ts" },
    orderBy: "created_at, id",
  },
  holes: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      number: "int",
      par: "int",
      stroke_index: "int",
      yardage: "jsonb",
      tee_lat: "float?",
      tee_lng: "float?",
      green_lat: "float?",
      green_lng: "float?",
      contest: { enum: ["ctp", "ld", "none"] },
      updated_at: "ts",
    },
    orderBy: "number, id",
  },
  team_round_state: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      team_id: "uuid",
      open_hole: "int?",
      started_holes: "int[]",
      hole_opened_at: "jsonb",
      status: { enum: ["not_started", "playing", "complete"] },
      completed_at: "ts?",
      updated_at: "ts",
    },
    orderBy: "team_id, id",
  },
  hole_scores: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      team_id: "uuid",
      hole: "int",
      strokes: "int?",
      tee_shot_player_id: "uuid?",
      strokes_at: "ts?",
      tee_shot_at: "ts?",
      edit_count: "int",
      updated_by: "uuid?",
      updated_at: "ts",
    },
    orderBy: "team_id, hole, id",
  },
  drinks: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      team_id: "uuid",
      player_id: "uuid",
      hole: "int",
      type: { enum: ["drink", "shotgun", "shot"] },
      photo_path: "text?",
      logged_by: "uuid?",
      logged_at: "ts",
      created_at: "ts",
      deleted_at: "ts?",
      deleted_by: "uuid?",
      moved_from_hole: "int?",
    },
    orderBy: "created_at, id",
  },
  mulligans: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      team_id: "uuid",
      source: { enum: ["earned", "groom"] },
      used_on_hole: "int",
      used_by: "uuid?",
      used_at: "ts",
      created_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
  contest_entries: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      hole: "int",
      player_id: "uuid",
      team_id: "uuid",
      type: { enum: ["ctp", "ld"] },
      distance_value: "float",
      unit: { enum: ["ft", "yd"] },
      distance_override: "float?",
      angle_deg: "float?",
      lat: "float?",
      lng: "float?",
      gps_accuracy_m: "float?",
      low_accuracy: "bool",
      photo_path: "text?",
      ai_estimate_ft: "float?",
      ai_confidence: { enum: ["low", "medium", "high"], nullable: true },
      ai_suspicious: "bool?",
      ai_roast: "text?",
      status: { enum: ["ok", "flagged", "overridden"] },
      flag_reason: "text?",
      created_at: "ts",
      updated_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
  pot_optouts: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      pot_key: "text",
      player_id: "uuid",
      created_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
  feed_events: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      type: {
        enum: [
          "post",
          "round_started",
          "tee_off",
          "score_notable",
          "score_edit",
          "drinks",
          "shotgun",
          "shot",
          "ghost_beer",
          "mulligan_used",
          "groom_mulligan",
          "lead_change",
          "contest_entry",
          "contest_lead",
          "ai_judge",
          "drive_warning",
          "drive_miss",
          "commissioner_override",
          "round_complete",
          "final_results",
          "roast",
        ],
      },
      team_id: "uuid?",
      player_id: "uuid?",
      actor_id: "uuid?",
      payload: "jsonb",
      photo_path: "text?",
      text: "text?",
      dedupe_key: "text?",
      created_at: "ts",
      updated_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
  reactions: {
    columns: {
      id: "uuid",
      trip_id: "uuid",
      feed_event_id: "uuid",
      player_id: "uuid",
      kind: { enum: ["fire", "lol", "beer", "dead", "goat", "clown"] },
      created_at: "ts",
      deleted_at: "ts?",
    },
    orderBy: "created_at, id",
  },
};

/** Column names of a row table, in table order. */
export function columnsOf(table: RowTable): string[] {
  return Object.keys(ROW_SPECS[table].columns);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const colList = (cols: string[]) => cols.map(q).join(", ");
const TRIP_COLUMNS = Object.keys(TRIP_SPEC);

// ---------------------------------------------------------------------------
// Validation (so a malformed row can be rejected as one op instead of failing a whole batch)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** null when `v` fits the column, else a short description of the problem. */
export function checkValue(def: ColDef, v: unknown): string | null {
  let nullable: boolean;
  let base: Scalar | "enum";
  if (typeof def === "object") {
    nullable = !!def.nullable;
    base = "enum";
  } else {
    nullable = def.endsWith("?");
    base = (nullable ? def.slice(0, -1) : def) as Scalar;
  }
  if (v === null || v === undefined) return nullable ? null : "is required";
  switch (base) {
    case "enum":
      return typeof v === "string" && (def as { enum: readonly string[] }).enum.includes(v) ? null : `bad value ${JSON.stringify(v)}`;
    case "uuid":
      return isUuid(v) ? null : `not a uuid (${JSON.stringify(String(v).slice(0, 40))})`;
    case "text":
      // (NUL characters and lone surrogates are cleaned by the db layer, see cleanString.)
      return typeof v === "string" ? null : "not text";
    case "int":
      return typeof v === "number" && Number.isInteger(v) && v >= INT_MIN && v <= INT_MAX ? null : "not an integer";
    case "float":
      return typeof v === "number" && Number.isFinite(v) ? null : "not a finite number";
    case "bool":
      return typeof v === "boolean" ? null : "not a boolean";
    case "ts":
      return typeof v === "string" && ISO_RE.test(v) && Number.isFinite(Date.parse(v)) ? null : "not an ISO timestamp";
    case "int[]":
      return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isInteger(x) && x >= INT_MIN && x <= INT_MAX)
        ? null
        : "not an integer array";
    case "jsonb": {
      if (typeof v !== "object") return "not a JSON object";
      let s: string | undefined;
      try {
        s = JSON.stringify(v);
      } catch {
        return "not serializable";
      }
      return s === undefined ? "not serializable" : null;
    }
  }
}

function checkRow(spec: Spec<unknown> | Record<string, ColDef>, row: Record<string, unknown>): string | null {
  for (const [col, def] of Object.entries(spec as Record<string, ColDef>)) {
    const problem = checkValue(def, row[col]);
    if (problem) return `${col} ${problem}`;
  }
  return null;
}

/** null when the write can be persisted for this trip, else why not. */
export function validateWrite(tripId: UUID, w: Write): string | null {
  if (w.kind === "delete") {
    if (!(ROW_TABLES as readonly string[]).includes(w.table)) return `unknown table ${w.table}`;
    return isUuid(w.id) ? null : `${w.table}: id not a uuid`;
  }
  if (w.kind === "trip") {
    if (!w.row || w.row.id !== tripId) return "trip: wrong trip";
    const p = checkRow(TRIP_SPEC, w.row as unknown as Record<string, unknown>);
    return p ? `trip: ${p}` : null;
  }
  const spec = ROW_SPECS[w.table];
  if (!spec) return `unknown table ${w.table}`;
  const row = w.row as unknown as Record<string, unknown>;
  if (!row || typeof row !== "object") return `${w.table}: missing row`;
  if (row.trip_id !== tripId) return `${w.table}: row belongs to another trip`;
  const p = checkRow(spec.columns, row);
  return p ? `${w.table}: ${p}` : null;
}

/** Problems with a batch of writes (empty = all good). */
export function validateWrites(tripId: UUID, writes: readonly Write[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    const p = validateWrite(tripId, w);
    if (p) out.push(p);
  }
  return out;
}

export class InvalidWriteError extends Error {
  constructor(readonly problems: string[]) {
    super(`persistWrites: invalid writes: ${problems.slice(0, 5).join("; ")}`);
    this.name = "InvalidWriteError";
  }
}

export class TripNotFoundError extends Error {
  constructor(readonly tripId: string) {
    super(`Trip ${tripId} not found`);
    this.name = "TripNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export interface TripWithPin {
  trip: Trip;
  pin_hash: string;
}

function splitPin(row: Record<string, unknown>): TripWithPin {
  const { commissioner_pin_hash, ...rest } = row;
  return { trip: rest as unknown as Trip, pin_hash: String(commissioner_pin_hash) };
}

/** The trip for a join code (exact match; callers lowercase it), with its PIN hash kept separate. */
export async function findTripByCode(db: Db, code: string): Promise<TripWithPin | null> {
  const rows = await db.query(
    `select ${colList(TRIP_COLUMNS)}, commissioner_pin_hash from trips where code = $1`,
    [code],
  );
  return rows[0] ? splitPin(rows[0]) : null;
}

export async function findTripById(db: Db, tripId: UUID): Promise<TripWithPin | null> {
  if (!isUuid(tripId)) return null;
  const rows = await db.query(
    `select ${colList(TRIP_COLUMNS)}, commissioner_pin_hash from trips where id = $1`,
    [tripId],
  );
  return rows[0] ? splitPin(rows[0]) : null;
}

/** Insert a brand-new trip row. Throws on a duplicate id/code (unique violation, code 23505). */
export async function insertTrip(db: Db, trip: Trip, pinHash: string): Promise<Trip> {
  const problem = checkRow(TRIP_SPEC, trip as unknown as Record<string, unknown>);
  if (problem) throw new InvalidWriteError([`trip: ${problem}`]);
  if (!pinHash) throw new InvalidWriteError(["trip: commissioner_pin_hash is required"]);
  const values = TRIP_COLUMNS.map((c) => (trip as unknown as Record<string, unknown>)[c]);
  const params = TRIP_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.query(
    `insert into trips (${colList(TRIP_COLUMNS)}, commissioner_pin_hash) values (${params}, $${TRIP_COLUMNS.length + 1})
     returning ${colList(TRIP_COLUMNS)}`,
    [...values, pinHash],
  );
  return rows[0] as unknown as Trip;
}

export async function setTripPinHash(db: Db, tripId: UUID, pinHash: string): Promise<boolean> {
  const rows = await db.query(
    "update trips set commissioner_pin_hash = $2, updated_at = now() where id = $1 returning id",
    [tripId, pinHash],
  );
  return rows.length === 1;
}

/** Delete a trip and (cascade) everything in it. For demo resets. */
export async function deleteTrip(db: Db, tripId: UUID): Promise<boolean> {
  if (!isUuid(tripId)) return false;
  const rows = await db.query("delete from trips where id = $1 returning id", [tripId]);
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Every row of a trip, soft-deleted ones included (the client and engine filter). For a
 * consistent snapshot run it inside a transaction (see readTripState); queries are issued
 * together so postgres.js pipelines them on the transaction's connection.
 */
export async function loadTripState(db: Db, tripId: UUID): Promise<TripState> {
  if (!isUuid(tripId)) throw new TripNotFoundError(tripId);
  const [tripRows, ...tables] = await Promise.all([
    db.query(`select ${colList(TRIP_COLUMNS)} from trips where id = $1`, [tripId]),
    ...ROW_TABLES.map((t) =>
      db.query(
        `select ${colList(columnsOf(t))} from ${q(t)} where trip_id = $1 order by ${ROW_SPECS[t].orderBy}`,
        [tripId],
      ),
    ),
  ]);
  if (!tripRows[0]) throw new TripNotFoundError(tripId);
  const state = { trip: tripRows[0] as unknown as Trip } as TripState;
  ROW_TABLES.forEach((t, i) => {
    (state as unknown as Record<string, unknown>)[t] = tables[i];
  });
  return state;
}

/** loadTripState in its own repeatable-read, read-only transaction (one consistent snapshot). */
export function readTripState(db: Db, tripId: UUID): Promise<TripState> {
  return db.tx((t) => loadTripState(t, tripId), { isolation: "repeatable read", readOnly: true });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface PersistResult {
  upserted: number;
  deleted: number;
  tripUpdated: boolean;
  /** Writes that were not applied (id owned by another trip, or a duplicate feed dedupe_key). */
  skipped: Array<{ table: RowTable; id: UUID; reason: string }>;
}

function upsertSql(table: RowTable): string {
  const cols = columnsOf(table);
  const updates = cols.filter((c) => c !== "id" && c !== "trip_id").map((c) => `${q(c)} = excluded.${q(c)}`);
  // jsonb_populate_recordset turns one JSON array param into typed rows (timestamptz from ISO,
  // int[] from JSON arrays, jsonb as-is), so any number of rows is one statement and one param.
  // The WHERE keeps a client-chosen id that collides with another trip's row from touching it.
  return (
    `insert into ${q(table)} (${colList(cols)}) ` +
    `select ${colList(cols)} from jsonb_populate_recordset(null::${q(table)}, $1::jsonb) ` +
    `on conflict (id) do update set ${updates.join(", ")} ` +
    `where ${q(table)}.trip_id = excluded.trip_id ` +
    `returning id`
  );
}

/** Rows reduced to exactly the table's columns (extra keys dropped, undefined → null). */
function pick(table: RowTable, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columnsOf(table)) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

/**
 * Persist reducer writes for one trip. Later writes to the same row win; all deletes run before
 * all upserts (so a moved player's old membership is gone before the new one lands). Validates
 * everything first and throws InvalidWriteError before touching the database if anything is
 * malformed — check ops with validateWrites() as you go to reject them individually instead.
 * Run inside the trip's transaction.
 */
export async function persistWrites(db: Db, tripId: UUID, writes: readonly Write[]): Promise<PersistResult> {
  const result: PersistResult = { upserted: 0, deleted: 0, tripUpdated: false, skipped: [] };
  const problems = validateWrites(tripId, writes);
  if (problems.length) throw new InvalidWriteError(problems);

  // Fold to the final action per row.
  const final = new Map<string, Write>();
  let tripRow: Trip | null = null;
  for (const w of writes) {
    if (w.kind === "trip") tripRow = w.row;
    else final.set(`${w.table}:${w.kind === "delete" ? w.id : w.row.id}`, w);
  }

  const deletes = new Map<RowTable, UUID[]>();
  const upserts = new Map<RowTable, Record<string, unknown>[]>();
  for (const w of final.values()) {
    if (w.kind === "delete") {
      const list = deletes.get(w.table) ?? [];
      list.push(w.id);
      deletes.set(w.table, list);
    } else if (w.kind === "upsert") {
      const list = upserts.get(w.table) ?? [];
      list.push(pick(w.table, w.row as unknown as Record<string, unknown>));
      upserts.set(w.table, list);
    }
  }

  for (const table of ROW_TABLES) {
    const ids = deletes.get(table);
    if (!ids?.length) continue;
    const rows = await db.query(`delete from ${q(table)} where trip_id = $1 and id = any($2::uuid[]) returning id`, [
      tripId,
      ids,
    ]);
    result.deleted += rows.length;
  }

  for (const table of ROW_TABLES) {
    let rows = upserts.get(table);
    if (!rows?.length) continue;
    if (table === "feed_events") rows = await dropDuplicateDedupeKeys(db, tripId, rows, result);
    if (!rows.length) continue;
    const saved = await db.query<{ id: string }>(upsertSql(table), [rows]);
    result.upserted += saved.length;
    if (saved.length !== rows.length) {
      const ok = new Set(saved.map((r) => r.id.toLowerCase()));
      for (const r of rows) {
        const id = String(r.id);
        if (!ok.has(id.toLowerCase())) {
          result.skipped.push({ table, id, reason: "id belongs to another trip" });
          console.warn(`persistWrites: skipped ${table} ${id}: id belongs to another trip`);
        }
      }
    }
  }

  if (tripRow) {
    const t = tripRow;
    const rows = await db.query(
      `update trips set name = $2, app_name = $3, status = $4, base_team_size = $5, settings = $6,
         started_at = $7, finalized_at = $8, updated_at = $9
       where id = $1 returning id`,
      [tripId, t.name, t.app_name, t.status, t.base_team_size, t.settings, t.started_at, t.finalized_at, t.updated_at],
    );
    result.tripUpdated = rows.length === 1;
  }
  return result;
}

/**
 * Feed events whose dedupe_key already belongs to a different event (in the DB or earlier in this
 * batch) are dropped: the partial unique index would otherwise abort the whole transaction.
 */
async function dropDuplicateDedupeKeys(
  db: Db,
  tripId: UUID,
  rows: Record<string, unknown>[],
  result: PersistResult,
): Promise<Record<string, unknown>[]> {
  const keys = rows.map((r) => r.dedupe_key).filter((k): k is string => typeof k === "string");
  if (!keys.length) return rows;
  const existing = await db.query<{ id: string; dedupe_key: string }>(
    "select id, dedupe_key from feed_events where trip_id = $1 and dedupe_key = any($2::text[])",
    [tripId, keys],
  );
  const owner = new Map(existing.map((e) => [e.dedupe_key, e.id.toLowerCase()]));
  const kept: Record<string, unknown>[] = [];
  for (const r of rows) {
    const key = r.dedupe_key;
    const id = String(r.id).toLowerCase();
    if (typeof key === "string") {
      const o = owner.get(key);
      if (o !== undefined && o !== id) {
        result.skipped.push({ table: "feed_events", id: String(r.id), reason: `dedupe_key ${key} already used` });
        continue;
      }
      owner.set(key, id);
    }
    kept.push(r);
  }
  return kept;
}

/**
 * Insert feed events outside the reducer (e.g. AI roasts posted after the fact). Events whose id
 * or dedupe_key already exists are silently skipped. Returns the ids actually inserted.
 */
export async function insertFeedEvents(db: Db, tripId: UUID, events: readonly FeedEvent[]): Promise<UUID[]> {
  if (!events.length) return [];
  const problems = validateWrites(
    tripId,
    events.map((row) => ({ kind: "upsert", table: "feed_events", row }) as Write),
  );
  if (problems.length) throw new InvalidWriteError(problems);
  const cols = columnsOf("feed_events");
  const rows = await db.query<{ id: string }>(
    `insert into feed_events (${colList(cols)}) ` +
      `select ${colList(cols)} from jsonb_populate_recordset(null::feed_events, $1::jsonb) ` +
      `on conflict do nothing returning id`,
    [events.map((e) => pick("feed_events", e as unknown as Record<string, unknown>))],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Exactly-once op bookkeeping
// ---------------------------------------------------------------------------

export interface AppliedOpRow {
  id: UUID;
  trip_id: UUID;
  op_type: string;
  status: OpResultStatus;
  code: string | null;
  reason: string | null;
  applied_at?: string;
}

/** Previously processed ops among `ids` for this trip (non-uuid ids are never found). */
export async function getAppliedOps(db: Db, tripId: UUID, ids: readonly string[]): Promise<Map<UUID, AppliedOpRow>> {
  const valid = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
  const out = new Map<UUID, AppliedOpRow>();
  if (!valid.length) return out;
  const rows = await db.query<AppliedOpRow>(
    "select id, trip_id, op_type, status, code, reason, applied_at from applied_ops where trip_id = $1 and id = any($2::uuid[])",
    [tripId, valid],
  );
  // Key by the caller's spelling too, so lookups with uppercase uuids work.
  const byLower = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  for (const id of ids) {
    const r = isUuid(id) ? byLower.get(id.toLowerCase()) : undefined;
    if (r) out.set(id, r);
  }
  return out;
}

export async function getAppliedOpIds(db: Db, tripId: UUID, ids: readonly string[]): Promise<Set<UUID>> {
  return new Set((await getAppliedOps(db, tripId, ids)).keys());
}

/** Record processed ops (first record wins; re-recording an id is a no-op). */
export async function recordAppliedOps(
  db: Db,
  rows: ReadonlyArray<Omit<AppliedOpRow, "applied_at" | "code" | "reason"> & { code?: string | null; reason?: string | null }>,
): Promise<number> {
  const valid = rows.filter((r) => isUuid(r.id) && isUuid(r.trip_id));
  if (!valid.length) return 0;
  const seen = new Set<string>();
  const unique = valid.filter((r) => {
    const k = r.id.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const inserted = await db.query(
    `insert into applied_ops (id, trip_id, op_type, status, code, reason)
     select id, trip_id, op_type, status, code, reason
     from jsonb_populate_recordset(null::applied_ops, $1::jsonb)
     on conflict (id) do nothing returning id`,
    [
      unique.map((r) => ({
        id: r.id,
        trip_id: r.trip_id,
        op_type: String(r.op_type ?? "unknown").slice(0, 100),
        status: r.status,
        code: r.code ?? null,
        reason: r.reason == null ? null : String(r.reason).slice(0, 2000),
      })),
    ],
  );
  return inserted.length;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Serialize writers of one trip until the surrounding transaction ends. MUST be called inside
 * db.tx() (a transaction-scoped advisory lock; outside a transaction it's released immediately).
 */
export async function lockTrip(db: Db, tripId: UUID): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [tripId]);
}
