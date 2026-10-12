"use client";
// IndexedDB (Dexie) for the offline-first client: the op outbox, the last snapshot per trip,
// queued photo blobs, and a small key/value table. Everything here is best-effort from the
// store's point of view: the store keeps its own in-memory copy and retries persistence, so a
// broken/hung IndexedDB (it happens on iOS) never loses an action within a session.
import Dexie, { type DexieOptions, type Table } from "dexie";
import type { ISODate, Snapshot, UUID } from "../types";
import type { Op } from "../ops";

export const DB_NAME = "scramble";

export interface OutboxRow {
  /** = op.id */
  id: UUID;
  code: string;
  /** Monotonic per device; ops are sent in seq order. */
  seq: number;
  op: Op;
  /** Times this op was put on the wire (any outcome). >0 means it may already be on the server. */
  attempts: number;
  last_error: string | null;
  /** Photo paths this op references; it waits for those uploads first. */
  photo_paths: string[];
}

export interface SnapshotRow {
  code: string;
  snapshot: Snapshot;
  saved_at: ISODate;
}

export interface BlobRow {
  path: string;
  code: string;
  /**
   * The compressed JPEG. Normally a Blob; stored as an ArrayBuffer instead when the browser
   * refuses to clone Blobs into IndexedDB (some private modes / old WebKit). Read via rowBlob().
   */
  blob: Blob | ArrayBuffer;
  type?: string;
  created_at: ISODate;
}

export interface KvRow {
  key: string;
  value: unknown;
}

export class ScrambleDB extends Dexie {
  outbox!: Table<OutboxRow, string>;
  snapshots!: Table<SnapshotRow, string>;
  blobs!: Table<BlobRow, string>;
  kv!: Table<KvRow, string>;

  /** `options` lets tests inject an IndexedDB factory (e.g. one whose open() stalls like iOS's sometimes does). */
  constructor(name: string = DB_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      outbox: "&id, code, seq, [code+seq]",
      snapshots: "&code",
      blobs: "&path, code",
      kv: "&key",
    });
  }
}

const instances = new Map<string, ScrambleDB>();

/** Shared Dexie instance per database name (one connection per tab). */
export function getDb(name: string = DB_NAME): ScrambleDB {
  let db = instances.get(name);
  if (!db) {
    db = new ScrambleDB(name);
    instances.set(name, db);
  }
  return db;
}

/** Whether IndexedDB exists at all in this environment. */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Blob view of a stored photo row. */
export function rowBlob(row: BlobRow): Blob {
  if (row.blob instanceof Blob) return row.blob;
  return new Blob([row.blob], { type: row.type ?? "image/jpeg" });
}

/** Outbox rows for one trip in seq order. */
export function outboxFor(db: ScrambleDB, code: string): Promise<OutboxRow[]> {
  return db.outbox.where("[code+seq]").between([code, Dexie.minKey], [code, Dexie.maxKey]).toArray();
}

/**
 * Put a photo row; falls back to an ArrayBuffer copy when the Blob can't be cloned into IDB.
 */
export async function putBlobRow(db: ScrambleDB, row: { path: string; code: string; blob: Blob; created_at: ISODate }): Promise<void> {
  try {
    await db.blobs.put({ ...row, type: row.blob.type || "image/jpeg" });
  } catch (e) {
    const name = (e as { name?: string })?.name ?? "";
    if (name !== "DataCloneError" && !/clone|blob/i.test(String((e as Error)?.message ?? ""))) throw e;
    const buf = await row.blob.arrayBuffer();
    await db.blobs.put({ ...row, blob: buf, type: row.blob.type || "image/jpeg" });
  }
}

export async function kvGet<T = unknown>(key: string, db: ScrambleDB = getDb()): Promise<T | undefined> {
  try {
    const row = await db.kv.get(key);
    return row?.value as T | undefined;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown, db: ScrambleDB = getDb()): Promise<boolean> {
  try {
    await db.kv.put({ key, value });
    return true;
  } catch {
    return false;
  }
}

/**
 * After an IndexedDB failure, drop the connection so the next operation reopens it. Fixes
 * Safari's "Connection to Indexed Database server lost" state without a page reload.
 */
export function resetConnection(db: ScrambleDB): void {
  try {
    db.close({ disableAutoOpen: false });
  } catch {
    /* ignore */
  }
}
