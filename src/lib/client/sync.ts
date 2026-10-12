"use client";
// The outbox sync worker. One flush pass:
//   a) send pending ops in seq order (batches of <= 100) up to the first op that references a
//      photo still waiting to upload (later ops may depend on it: a drink's undo, a mulligan
//      earned by a shotgun, ...), so scores never queue behind a slow upload,
//   b) upload pending photo blobs one by one (POST /api/t/<code>/upload?path=...),
//   c) send the ops that were waiting on those photos — the photo always lands first, unless
//      it failed to upload PHOTO_BLOCK_MAX_FAILURES times (then the op goes without it),
//   applied/duplicate -> dropped from the outbox; rejected -> dropped and surfaced;
//   network error / 5xx / timeout -> keep everything, mark offline, exponential backoff;
//   on success adopt the response snapshot (the store re-applies whatever is still pending).
// The worker is single-flight: a flush requested while one is running re-runs right after it.
// It never drops an op on an ambiguous failure: only an explicit per-op server rejection or a
// 400/422 JSON answer for that single op (a poison op) removes it.
import type { Snapshot, UUID } from "../types";
import type { Op, OpResult, RejectCode, SyncResponse } from "../ops";

export const SYNC_TIMEOUT_MS = 15_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
export const MAX_BATCH = 100;
/** An op stops waiting for its photo after this many failed upload attempts (photos never block scores for long). */
export const PHOTO_BLOCK_MAX_FAILURES = 3;
/** A photo the server permanently refuses (400/413/415/422) is dropped after this many attempts. */
export const PHOTO_MAX_PERMANENT_FAILURES = 3;
/** keepalive requests must stay under 64 KiB. */
export const KEEPALIVE_MAX_BYTES = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PendingOp {
  id: UUID;
  seq: number;
  op: Op;
  photo_paths: string[];
  attempts: number;
  last_error: string | null;
}

export interface PendingBlob {
  path: string;
  blob: Blob;
  /** Failed upload attempts (any reason). */
  failures: number;
  /** Failed attempts the server answered with a permanent 4xx. */
  permanentFailures: number;
  created_at: string;
}

// ---------------------------------------------------------------- HTTP helpers

export type HttpResult =
  | { kind: "network"; error: string }
  | { kind: "http"; status: number; ok: boolean; contentType: string; text: string; json: unknown };

export interface HttpOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  timeoutMs?: number;
  keepalive?: boolean;
}

/**
 * fetch with a hard timeout that covers headers AND body. Never throws: network errors, aborts
 * and timeouts come back as { kind: "network" }.
 */
export async function httpRequest(fetchFn: FetchLike, url: string, opts: HttpOptions, timers: Timers = realTimers): Promise<HttpResult> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let handle: unknown = null;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    handle = timers.setTimeout(() => {
      timedOut = true;
      try {
        ctrl?.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("timeout"));
    }, opts.timeoutMs ?? SYNC_TIMEOUT_MS);
  });
  timeout.catch(() => undefined);
  try {
    const res = await Promise.race([
      fetchFn(url, {
        method: opts.method ?? "GET",
        body: opts.body ?? undefined,
        headers: opts.headers,
        credentials: "same-origin",
        cache: "no-store",
        keepalive: opts.keepalive || undefined,
        signal: ctrl?.signal,
      }),
      timeout,
    ]);
    const text = await Promise.race([res.text(), timeout]);
    const contentType = res.headers?.get?.("content-type") ?? "";
    let json: unknown = undefined;
    if (text && (contentType.includes("json") || /^[\s]*[[{]/.test(text))) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { kind: "http", status: res.status, ok: res.ok, contentType, text, json };
  } catch (e) {
    return { kind: "network", error: timedOut ? "timeout" : errorMessage(e) };
  } finally {
    timers.clearTimeout(handle);
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** Exponential backoff 1 s .. 30 s with jitter (each delay is uniformly in [d/2, d], never under 1 s). */
export function backoffDelay(failures: number, random: () => number = Math.random, minMs = 1000, maxMs = 30_000): number {
  const n = Math.max(1, Math.floor(failures));
  const exp = Math.min(maxMs, minMs * 2 ** Math.min(n - 1, 30));
  const jittered = exp / 2 + random() * (exp / 2);
  return Math.round(Math.min(maxMs, Math.max(minMs, jittered)));
}

export function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot | null;
  return (
    !!s &&
    typeof s === "object" &&
    !!s.state &&
    typeof s.state === "object" &&
    !!s.state.trip &&
    typeof s.state.trip === "object" &&
    !!s.meta &&
    typeof s.meta === "object" &&
    typeof s.meta.server_time === "string"
  );
}

function isSyncResponse(v: unknown): v is SyncResponse {
  const r = v as SyncResponse | null;
  return !!r && typeof r === "object" && Array.isArray(r.results);
}

function reasonFrom(res: Extract<HttpResult, { kind: "http" }>): string {
  const j = res.json as { reason?: unknown; error?: unknown; message?: unknown } | undefined;
  const r = j?.reason ?? j?.error ?? j?.message;
  if (typeof r === "string" && r.trim()) return r;
  return `Server said ${res.status}`;
}

// ---------------------------------------------------------------- one flush pass

/** What the sync worker needs from the store. */
export interface SyncHost {
  readonly code: string;
  fetch: FetchLike;
  timers: Timers;
  syncTimeoutMs?: number;
  uploadTimeoutMs?: number;
  /** Resolves once the outbox has been restored from IndexedDB (or gave up waiting). */
  ready(): Promise<void>;
  pendingBlobs(): PendingBlob[];
  /** In seq order. */
  pendingOps(): PendingOp[];
  hasPending(): boolean;
  onUploaded(path: string): void;
  onUploadFailed(path: string, permanent: boolean, message: string): void;
  onSending(ids: UUID[]): void;
  onSendFailed(ids: UUID[], message: string): void;
  /** Server answered: drop acked ops, surface rejections, adopt the snapshot (if fresher). */
  onResults(results: OpResult[], snapshot: Snapshot | null): void;
  /** A single op the server refuses to even parse (400/422). Dropped and surfaced. */
  onPoisonOp(id: UUID, code: RejectCode, reason: string): void;
  /** ok=false: network error, timeout or 5xx. */
  onNetwork(ok: boolean, error?: string): void;
  setSyncing(on: boolean): void;
}

export interface FlushOptions {
  /** Use fetch keepalive (page is being hidden); skips photo uploads. */
  keepalive?: boolean;
  skipUploads?: boolean;
}

export interface FlushResult {
  /** A transient failure happened (network, timeout, 5xx); a retry is needed. */
  failed: boolean;
  uploaded: number;
  /** Ops acknowledged (applied, duplicate or rejected) by the server. */
  acked: number;
  error: string | null;
}

const PERMANENT_UPLOAD_STATUSES = new Set([400, 413, 415, 422]);

function uploadUrl(code: string, path: string): string {
  return `/api/t/${encodeURIComponent(code)}/upload?path=${encodeURIComponent(path)}`;
}

function syncUrl(code: string): string {
  return `/api/t/${encodeURIComponent(code)}/sync`;
}

/**
 * The ops that may be sent now: the seq-ordered prefix before the first op still waiting for a
 * photo. `strict` (before this pass tried the uploads): any pending photo blocks. Otherwise a
 * photo stops blocking after PHOTO_BLOCK_MAX_FAILURES failed upload attempts, so a photo that
 * won't upload can delay its op (and the ops after it) but never strand them.
 */
export function sendablePrefix(ops: PendingOp[], blobs: PendingBlob[], strict = false): PendingOp[] {
  const waiting = new Map(blobs.map((b) => [b.path, b]));
  const out: PendingOp[] = [];
  for (const p of ops) {
    const blocked = p.photo_paths.some((path) => {
      const b = waiting.get(path);
      return !!b && (strict || b.failures < PHOTO_BLOCK_MAX_FAILURES);
    });
    if (blocked) break;
    out.push(p);
  }
  return out;
}

type BatchOutcome = { kind: "ok"; acked: number } | { kind: "failed"; error: string };

async function sendBatch(host: SyncHost, batch: PendingOp[], keepalive: boolean): Promise<BatchOutcome> {
  const ids = batch.map((p) => p.id);
  const body = JSON.stringify({ ops: batch.map((p) => p.op) });
  host.onSending(ids);
  const res = await httpRequest(
    host.fetch,
    syncUrl(host.code),
    {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      timeoutMs: host.syncTimeoutMs ?? SYNC_TIMEOUT_MS,
      keepalive: keepalive && body.length < KEEPALIVE_MAX_BYTES,
    },
    host.timers,
  );
  if (res.kind === "network") {
    host.onSendFailed(ids, res.error);
    host.onNetwork(false, res.error);
    return { kind: "failed", error: res.error };
  }
  if (res.ok) {
    if (!isSyncResponse(res.json)) {
      const error = "Bad sync response";
      host.onSendFailed(ids, error);
      host.onNetwork(false, error);
      return { kind: "failed", error };
    }
    host.onNetwork(true);
    const wanted = new Set(ids);
    const results = res.json.results.filter((r) => r && typeof r.id === "string" && wanted.has(r.id));
    host.onResults(results, isSnapshot(res.json.snapshot) ? res.json.snapshot : null);
    return { kind: "ok", acked: results.length };
  }
  // Batch too large, or the server can't parse something in it: split to isolate a poison op.
  const poisonable =
    res.status === 413 || ((res.status === 400 || res.status === 422) && res.contentType.includes("json"));
  if (poisonable) {
    host.onNetwork(true);
    if (batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      let acked = 0;
      for (const half of [batch.slice(0, mid), batch.slice(mid)]) {
        const r = await sendBatch(host, half, keepalive);
        if (r.kind !== "ok") return r;
        acked += r.acked;
      }
      return { kind: "ok", acked };
    }
    host.onPoisonOp(batch[0].id, "invalid", reasonFrom(res));
    return { kind: "ok", acked: 1 };
  }
  // 5xx, 404 (deploy hiccup), 401/403 (proxy), 429, HTML error pages...: transient, keep everything.
  const error = `HTTP ${res.status}`;
  host.onSendFailed(ids, error);
  host.onNetwork(false, error);
  return { kind: "failed", error };
}

async function sendOps(host: SyncHost, ops: PendingOp[], keepalive: boolean, result: FlushResult): Promise<boolean> {
  for (let i = 0; i < ops.length; i += MAX_BATCH) {
    const r = await sendBatch(host, ops.slice(i, i + MAX_BATCH), keepalive);
    if (r.kind === "failed") {
      result.failed = true;
      result.error = r.error;
      return false;
    }
    result.acked += r.acked;
  }
  return true;
}

/**
 * One flush pass. Never throws.
 *   a) ops that don't wait on any photo (scores never queue behind a slow upload),
 *   b) photo uploads, one by one,
 *   c) the ops that were waiting on those photos (seq order is preserved throughout).
 */
export async function flushOutbox(host: SyncHost, opts: FlushOptions = {}): Promise<FlushResult> {
  const result: FlushResult = { failed: false, uploaded: 0, acked: 0, error: null };
  try {
    await host.ready();
  } catch {
    /* proceed with what we have */
  }
  const keepalive = !!opts.keepalive;

  // a) Everything before the first op referencing a not-yet-uploaded photo.
  const early = sendablePrefix(host.pendingOps(), host.pendingBlobs(), true);
  if (early.length > 0 && !(await sendOps(host, early, keepalive, result))) return result;
  if (opts.skipUploads || keepalive) return result;

  // b) Photos, one at a time.
  for (const b of host.pendingBlobs()) {
    const res = await httpRequest(
      host.fetch,
      uploadUrl(host.code, b.path),
      {
        method: "POST",
        body: b.blob,
        headers: { "content-type": "image/jpeg" },
        timeoutMs: host.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS,
      },
      host.timers,
    );
    if (res.kind === "http" && res.ok) {
      host.onNetwork(true);
      host.onUploaded(b.path);
      result.uploaded++;
      continue;
    }
    if (res.kind === "http" && PERMANENT_UPLOAD_STATUSES.has(res.status)) {
      host.onNetwork(true);
      host.onUploadFailed(b.path, true, reasonFrom(res));
      continue;
    }
    const error = res.kind === "network" ? res.error : `HTTP ${res.status}`;
    host.onUploadFailed(b.path, false, error);
    host.onNetwork(false, error);
    result.failed = true;
    result.error = error;
    // The rest would most likely fail too.
    break;
  }

  // c) Ops whose photos are up now (or that stopped waiting for a stuck photo).
  const late = sendablePrefix(host.pendingOps(), host.pendingBlobs(), false);
  if (late.length > 0) await sendOps(host, late, keepalive, result);
  return result;
}

// ---------------------------------------------------------------- the worker (scheduling)

export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface DocumentLike extends EventTargetLike {
  readonly visibilityState?: string;
}

export interface SyncWorkerOptions {
  timers?: Timers;
  random?: () => number;
  win?: EventTargetLike | null;
  doc?: DocumentLike | null;
  debounceMs?: number;
  intervalMs?: number;
  /** Called after every pass (success or not). */
  onPass?: (r: FlushResult) => void;
}

/**
 * Schedules flushes: on dispatch (debounced), window "online", page becoming visible, a 15 s
 * interval while anything is pending, backoff retries after failures, and manual flush().
 * When the page is hidden it fires a keepalive flush so ops logged right before locking the
 * phone still reach the server.
 */
export class SyncWorker {
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly win: EventTargetLike | null;
  private readonly doc: DocumentLike | null;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private inflight: Promise<FlushResult> | null = null;
  private rerun = false;
  private started = false;
  private debounceTimer: unknown = null;
  private retryTimer: unknown = null;
  private intervalTimer: unknown = null;
  /** Consecutive failed passes (drives the backoff). */
  failures = 0;
  lastResult: FlushResult | null = null;

  constructor(
    private readonly host: SyncHost,
    private readonly opts: SyncWorkerOptions = {},
  ) {
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.win = opts.win === undefined ? (typeof window !== "undefined" ? window : null) : opts.win;
    this.doc = opts.doc === undefined ? (typeof document !== "undefined" ? document : null) : opts.doc;
    this.debounceMs = opts.debounceMs ?? 250;
    this.intervalMs = opts.intervalMs ?? 15_000;
  }

  get running(): boolean {
    return this.inflight !== null;
  }

  private readonly onOnline = () => {
    this.failures = 0;
    this.clearRetry();
    void this.flush();
  };

  private readonly onVisibility = () => {
    const state = this.doc?.visibilityState;
    if (state === "hidden") {
      // Last chance before iOS freezes the page: push ready ops with keepalive (no photos).
      if (!this.inflight && this.host.pendingOps().length > 0) void this.flush({ keepalive: true });
    } else if (state === "visible") {
      void this.flush();
    }
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.win?.addEventListener("online", this.onOnline);
    this.doc?.addEventListener("visibilitychange", this.onVisibility);
    if (this.host.hasPending()) this.schedule(0);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.win?.removeEventListener("online", this.onOnline);
    this.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.clearTimer("debounceTimer");
    this.clearRetry();
    this.clearTimer("intervalTimer");
  }

  /** Debounced flush (default ~250 ms). Only while started. */
  schedule(delayMs: number = this.debounceMs): void {
    if (!this.started) return;
    if (this.debounceTimer !== null) return;
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, delayMs);
  }

  /** Flush now. Single-flight: if a pass is running, another runs right after it. */
  flush(opts: FlushOptions = {}): Promise<FlushResult> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    const p = (async () => {
      try {
        return await this.loop(opts);
      } finally {
        this.inflight = null;
        if (this.rerun) {
          // Requested after the loop's last check: run again soon.
          this.rerun = false;
          if (this.started) this.schedule(0);
        }
      }
    })();
    this.inflight = p;
    return p;
  }

  private async loop(first: FlushOptions): Promise<FlushResult> {
    let opts = first;
    let last: FlushResult = { failed: false, uploaded: 0, acked: 0, error: null };
    this.host.setSyncing(true);
    try {
      let rounds = 0;
      do {
        this.rerun = false;
        if (!this.host.hasPending()) break;
        try {
          last = await flushOutbox(this.host, opts);
        } catch (e) {
          last = { failed: true, uploaded: 0, acked: 0, error: errorMessage(e) };
        }
        opts = {};
        if (last.failed) break;
      } while (this.rerun && ++rounds < 25);
    } finally {
      this.host.setSyncing(false);
    }
    this.afterPass(last);
    return last;
  }

  private afterPass(r: FlushResult): void {
    this.lastResult = r;
    try {
      this.opts.onPass?.(r);
    } catch {
      /* ignore */
    }
    if (r.failed) {
      this.failures++;
      this.clearRetry();
      if (this.started) {
        this.retryTimer = this.timers.setTimeout(() => {
          this.retryTimer = null;
          void this.flush();
        }, backoffDelay(this.failures, this.random));
      }
    } else {
      this.failures = 0;
      this.clearRetry();
    }
    this.ensureInterval();
  }

  /** Safety net: while anything is pending, try every intervalMs. */
  ensureInterval(): void {
    if (!this.started || this.intervalTimer !== null || !this.host.hasPending()) return;
    this.intervalTimer = this.timers.setTimeout(() => {
      this.intervalTimer = null;
      if (!this.host.hasPending()) return;
      void this.flush();
      this.ensureInterval();
    }, this.intervalMs);
  }

  private clearRetry(): void {
    this.clearTimer("retryTimer");
  }

  private clearTimer(key: "debounceTimer" | "retryTimer" | "intervalTimer"): void {
    if (this[key] !== null) {
      this.timers.clearTimeout(this[key]);
      this[key] = null;
    }
  }
}
