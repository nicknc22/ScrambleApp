"use client";
// TripStore: the client's single source of UI state for one trip.
// view = snapshot.state with pending outbox ops applied (same reducer as the server);
// derived = engine.derive(view). Every action goes to the IndexedDB outbox first.
//
// Robustness rules (this runs on phones on a mountain with patchy signal):
// - An accepted op lives in memory immediately and is persisted to IndexedDB asynchronously;
//   if IndexedDB fails or hangs, the op stays in memory and persistence is retried. Ops are only
//   ever dropped on an explicit server answer (applied / duplicate / rejected) or cancelPending.
// - A fetched or synced snapshot is adopted only if its meta.server_time >= the current one's.
// - Pending ops are re-applied on top of every adopted snapshot, so ops dispatched while a sync
//   request was in flight survive the rebase.
import type { ISODate, Snapshot, TripState, UUID } from "../types";
import type { Op, OpInput, OpResult, RejectCode } from "../ops";
import type { Derived } from "../engine/types";
import { applyOp as reducerApplyOp, type ApplyCtx, type ApplyResult } from "../reducer";
import { derive as engineDerive } from "../engine";
import { newId as realNewId } from "../ids";
import { getDb, hasIndexedDb, outboxFor, putBlobRow, resetConnection, rowBlob, ScrambleDB, type OutboxRow } from "./db";
import { compressPhoto as realCompressPhoto, photoPathsOf } from "./photos";
import {
  errorMessage,
  flushOutbox,
  httpRequest,
  isSnapshot,
  realTimers,
  SyncWorker,
  uploadPhotos,
  type DocumentLike,
  type EventTargetLike,
  type FetchLike,
  type PendingBlob,
  type PendingOp,
  type SyncHost,
  type Timers,
  type UploadHost,
} from "./sync";
import { startLiveUpdates, type LiveController, type LiveOptions } from "./realtime";
import {
  loadCommissionerHint,
  loadMe,
  safeStorage,
  saveCommissionerHint,
  saveMe,
  setLastTripCode,
  type StorageLike,
} from "./identity";
import { ServerClock } from "./clock";
import { describeOp, loadSyncIssues, MAX_SYNC_ISSUES, saveSyncIssues, type SyncIssue } from "./sync-issues";

export type PhotoKind = "drinks" | "ld" | "ctp" | "posts";

export interface ClientState {
  code: string;
  /** A snapshot (cached or fresh) is available. */
  loaded: boolean;
  /** Fatal load error (e.g. unknown trip code and nothing cached). */
  loadError: string | null;
  snapshot: Snapshot | null;
  /** Optimistic state: snapshot + pending ops. null until loaded. */
  view: TripState | null;
  derived: Derived | null;
  /** Ops + photo uploads not yet acknowledged by the server. Drives "Offline, X changes waiting". */
  pendingCount: number;
  /** navigator.onLine AND the last op sync / state fetch didn't fail (photo uploads don't count). */
  online: boolean;
  /** An op sync request is out (photo uploads run in their own lane and don't set this). */
  syncing: boolean;
  lastSyncAt: ISODate | null;
  /** Player chosen on this device ("tap your name"). Stored in localStorage per trip code. */
  meId: UUID | null;
  /** Commissioner cookie is valid (checked via GET /api/t/<code>/commissioner). */
  isCommissioner: boolean;
  /** Changes the server refused (newest last, at most 20), kept across reloads until dismissed. */
  rejected: SyncIssue[];
}

export type DispatchResult = { ok: true; op: Op } | { ok: false; code: RejectCode; reason: string };

/** Injectable dependencies (tests). Every field is optional; defaults use the real modules. */
export interface TripStoreDeps {
  fetch?: FetchLike;
  /** Dexie instance, database name, or null for memory-only (no IndexedDB). */
  db?: ScrambleDB | string | null;
  /** Epoch ms. */
  now?: () => number;
  newId?: () => UUID;
  applyOp?: (state: TripState, op: Op, ctx: ApplyCtx) => ApplyResult;
  derive?: (state: TripState) => Derived;
  storage?: StorageLike | null;
  /** navigator.onLine */
  online?: () => boolean;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  random?: () => number;
  /** Live-update factory (null = none). */
  realtime?: ((opts: LiveOptions) => LiveController) | null;
  compressPhoto?: (file: Blob) => Promise<Blob>;
  createObjectURL?: ((blob: Blob) => string) | null;
  revokeObjectURL?: ((url: string) => void) | null;
  /** window-like target for "online"/"offline"/"focus" (null = none). */
  win?: EventTargetLike | null;
  /** document-like target for "visibilitychange" (null = none). */
  doc?: DocumentLike | null;
  /** Override timeouts/intervals. */
  config?: Partial<StoreConfig>;
}

export interface StoreConfig {
  syncTimeoutMs: number;
  uploadTimeoutMs: number;
  requestTimeoutMs: number;
  flushDebounceMs: number;
  pendingIntervalMs: number;
  /** How long to wait for IndexedDB before showing whatever we have. */
  restoreTimeoutMs: number;
  /** Per IndexedDB write before treating it as failed. */
  persistTimeoutMs: number;
  /** Keep a local preview object URL this long after its photo uploaded. */
  previewGraceMs: number;
}

const DEFAULT_CONFIG: StoreConfig = {
  syncTimeoutMs: 15_000,
  uploadTimeoutMs: 60_000,
  requestTimeoutMs: 15_000,
  flushDebounceMs: 250,
  pendingIntervalMs: 15_000,
  restoreTimeoutMs: 3_000,
  persistTimeoutMs: 8_000,
  previewGraceMs: 5 * 60_000,
};

interface Entry extends PendingOp {
  /** Bumped on every change; persisted when savedVersion catches up. */
  version: number;
  savedVersion: number;
}

interface BlobEntry extends PendingBlob {
  persisted: boolean;
}

type ResolvedDeps = {
  fetch: FetchLike;
  now: () => number;
  newId: () => UUID;
  applyOp: (state: TripState, op: Op, ctx: ApplyCtx) => ApplyResult;
  derive: (state: TripState) => Derived;
  storage: StorageLike | null;
  online: () => boolean;
  timers: Timers;
  random: () => number;
  realtime: ((opts: LiveOptions) => LiveController) | null;
  compressPhoto: (file: Blob) => Promise<Blob>;
  createObjectURL: ((blob: Blob) => string) | null;
  revokeObjectURL: ((url: string) => void) | null;
  win: EventTargetLike | null;
  doc: DocumentLike | null;
};

const LOADING_REASON = "Still loading the trip. Give it a second.";

function iso(ms: number): ISODate {
  return new Date(ms).toISOString();
}

function timeOf(s: Snapshot | null): number {
  if (!s) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(s.meta.server_time);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function withTimeout<T>(p: Promise<T>, ms: number, timers: Timers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const h = timers.setTimeout(() => reject(new Error("IndexedDB timed out")), ms);
    p.then(
      (v) => {
        timers.clearTimeout(h);
        resolve(v);
      },
      (e) => {
        timers.clearTimeout(h);
        reject(e);
      },
    );
  });
}

// JSON of state tables, cached per object so structural sharing costs one stringify per table.
const jsonCache = new WeakMap<object, string>();
function jsonOf(v: unknown): string {
  if (v && typeof v === "object") {
    const hit = jsonCache.get(v);
    if (hit !== undefined) return hit;
    const s = JSON.stringify(v);
    jsonCache.set(v, s);
    return s;
  }
  return JSON.stringify(v);
}

/**
 * Keep the previous objects for tables whose content didn't change, so memoized UI (and the
 * view/derived memo) survive a poll that returned identical data.
 */
export function shareStructure(prev: TripState | null, next: TripState): TripState {
  if (!prev) return next;
  const out: Record<string, unknown> = {};
  let same = Object.keys(prev).length === Object.keys(next).length;
  for (const key of Object.keys(next) as Array<keyof TripState>) {
    const a = prev[key];
    const b = next[key];
    if (a !== undefined && jsonOf(a) === jsonOf(b)) {
      out[key] = a;
    } else {
      out[key] = b;
      same = false;
    }
  }
  return same ? prev : (out as unknown as TripState);
}

export class TripStore {
  readonly code: string;
  private readonly d: ResolvedDeps;
  private readonly cfg: StoreConfig;
  private readonly db: ScrambleDB | null;
  /** Op sync lane. */
  private readonly worker: SyncWorker;
  /** Photo upload lane (independent: a slow upload never holds up ops). */
  private readonly uploader: SyncWorker;
  private live: LiveController | null = null;

  private snapshot: Snapshot | null = null;
  private snapshotVersion = 0;
  private snapshotSavedVersion = 0;
  private pending: Entry[] = [];
  private pendingVersion = 0;
  private readonly blobs = new Map<string, BlobEntry>();
  private readonly objectUrls = new Map<string, { url: string; expires: number | null }>();
  /** Outbox ids acked/cancelled but not yet deleted from IndexedDB. */
  private readonly removedIds = new Set<UUID>();
  /** Every id ever acked/cancelled in this session (a late restore must not resurrect them). */
  private readonly goneIds = new Set<UUID>();
  private readonly removedBlobPaths = new Set<string>();
  private readonly inFlight = new Set<UUID>();

  private meId: UUID | null = null;
  /** Corrects op timestamps when this phone's clock is clearly off (see clock.ts). */
  private clock!: ServerClock;
  private isCommissioner = false;
  private navOnline = true;
  private netOk = true;
  private syncing = false;
  private lastSyncAt: ISODate | null = null;
  private rejected: SyncIssue[] = [];
  private loadError: string | null = null;
  private restored = false;
  private restoring: Promise<void> | null = null;
  private started = false;
  private lastSeq = 0;

  private readonly listeners = new Set<() => void>();
  private cachedState: ClientState | null = null;
  private serverState: ClientState | null = null;
  private viewMemo: { state: TripState; version: number; commish: boolean; view: TripState } | null = null;
  private derivedMemo: { view: TripState; derived: Derived | null } | null = null;

  private refreshInflight: Promise<void> | null = null;
  private refreshAgain = false;
  private persistInflight: Promise<void> | null = null;
  private persistAgain = false;
  private persistFailures = 0;
  private persistTimer: unknown = null;

  constructor(code: string, deps: TripStoreDeps = {}) {
    this.code = code;
    this.cfg = { ...DEFAULT_CONFIG, ...deps.config };
    const timers: Timers = {
      setTimeout: deps.setTimeout ?? realTimers.setTimeout,
      clearTimeout: deps.clearTimeout ?? realTimers.clearTimeout,
    };
    const hasWindow = typeof window !== "undefined";
    this.d = {
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      now: deps.now ?? (() => Date.now()),
      newId: deps.newId ?? realNewId,
      applyOp: deps.applyOp ?? reducerApplyOp,
      derive: deps.derive ?? ((s) => engineDerive(s)),
      storage: deps.storage === undefined ? safeStorage() : deps.storage,
      online:
        deps.online ??
        (() => {
          try {
            return typeof navigator === "undefined" || navigator.onLine !== false;
          } catch {
            return true;
          }
        }),
      timers,
      random: deps.random ?? Math.random,
      realtime: deps.realtime === undefined ? startLiveUpdates : deps.realtime,
      compressPhoto: deps.compressPhoto ?? ((f) => realCompressPhoto(f)),
      createObjectURL:
        deps.createObjectURL === undefined
          ? typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && hasWindow
            ? (b) => URL.createObjectURL(b)
            : null
          : deps.createObjectURL,
      revokeObjectURL:
        deps.revokeObjectURL === undefined
          ? typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function" && hasWindow
            ? (u) => URL.revokeObjectURL(u)
            : null
          : deps.revokeObjectURL,
      win: deps.win === undefined ? (hasWindow ? window : null) : deps.win,
      doc: deps.doc === undefined ? (typeof document !== "undefined" ? document : null) : deps.doc,
    };
    if (deps.db instanceof ScrambleDB) this.db = deps.db;
    else if (deps.db === null) this.db = null;
    else if (typeof deps.db === "string") this.db = hasIndexedDb() ? getDb(deps.db) : null;
    else this.db = hasIndexedDb() ? getDb() : null;

    const schedule = {
      timers,
      random: this.d.random,
      win: this.d.win,
      doc: this.d.doc,
      debounceMs: this.cfg.flushDebounceMs,
      intervalMs: this.cfg.pendingIntervalMs,
      onPass: () => this.sweepObjectUrls(),
    };
    const syncHost = this.syncHost();
    this.worker = new SyncWorker(syncHost, { ...schedule, run: (o) => flushOutbox(syncHost, o), keepaliveOnHide: true });
    const uploadHost = this.uploadHost();
    this.uploader = new SyncWorker(uploadHost, { ...schedule, run: () => uploadPhotos(uploadHost) });
  }

  // ------------------------------------------------------------------ lifecycle

  /** Load cached snapshot from IndexedDB, fetch fresh state, subscribe to realtime, start the sync worker. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.clock = new ServerClock(this.d.storage);
    const storedMe = loadMe(this.code, this.d.storage);
    if (storedMe) this.meId = storedMe;
    if (loadCommissionerHint(this.code, this.d.storage)) this.isCommissioner = true;
    this.rejected = mergeIssues(loadSyncIssues(this.code, this.d.storage), this.rejected);
    setLastTripCode(this.code, this.d.storage);
    this.navOnline = this.d.online();
    this.d.win?.addEventListener("online", this.onNavOnline);
    this.d.win?.addEventListener("offline", this.onNavOffline);
    if (!this.restoring) this.restoring = this.restore();
    this.worker.start();
    this.uploader.start();
    if (this.d.realtime) {
      try {
        this.live = this.d.realtime({
          refresh: () => this.refresh(),
          // Interval polls never queue behind a state fetch or op sync that's still out (weak
          // signal). A photo upload in flight doesn't hold them back.
          poll: () => (this.refreshInflight || this.syncing ? undefined : this.refresh()),
          timers: this.d.timers,
          win: this.d.win,
          doc: this.d.doc,
        });
        if (this.snapshot) this.live.setConfig(this.snapshot.meta.realtime);
      } catch (e) {
        console.error("[scramble] live updates failed to start", e);
        this.live = null;
      }
    }
    void this.refresh();
    void this.checkCommissioner();
    this.kickWorkers(0);
    this.changed();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.worker.stop();
    this.uploader.stop();
    this.live?.stop();
    this.live = null;
    this.d.win?.removeEventListener("online", this.onNavOnline);
    this.d.win?.removeEventListener("offline", this.onNavOffline);
    // Persistence keeps going: never lose an op because a component unmounted.
  }

  private readonly onNavOnline = () => {
    this.navOnline = true;
    this.changed();
  };
  private readonly onNavOffline = () => {
    this.navOnline = false;
    this.changed();
  };

  /** Resolves once the outbox is restored and every pending write reached IndexedDB (best effort; for tests/diagnostics). */
  async settled(): Promise<void> {
    if (this.restoring) await this.restoring;
    for (let i = 0; i < 20; i++) {
      if (this.persistInflight) {
        await this.persistInflight;
        continue;
      }
      if (!this.db || !this.isDirty()) return;
      await this.persistPass();
      if (this.isDirty() && this.persistFailures > 0) return;
    }
  }

  // ------------------------------------------------------------------ state

  getState(): ClientState {
    if (!this.cachedState) this.cachedState = this.buildState();
    return this.cachedState;
  }

  /** Initial state for SSR / hydration (useSyncExternalStore's getServerSnapshot). */
  getServerState(): ClientState {
    if (!this.serverState) {
      this.serverState = {
        code: this.code,
        loaded: false,
        loadError: null,
        snapshot: null,
        view: null,
        derived: null,
        pendingCount: 0,
        online: true,
        syncing: false,
        lastSyncAt: null,
        meId: null,
        isCommissioner: false,
        rejected: [],
      };
    }
    return this.serverState;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    this.cachedState = null;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        console.error("[scramble] store listener failed", e);
      }
    }
  }

  private isLoaded(): boolean {
    return this.snapshot !== null && this.restored;
  }

  private buildState(): ClientState {
    const loaded = this.isLoaded();
    const view = loaded ? this.computeView() : null;
    const derived = view ? this.computeDerived(view) : null;
    return {
      code: this.code,
      loaded,
      loadError: loaded ? null : this.loadError,
      snapshot: this.snapshot,
      view,
      derived,
      pendingCount: this.pending.length + this.blobs.size,
      online: this.navOnline && this.netOk,
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      meId: this.meId,
      isCommissioner: this.isCommissioner,
      rejected: this.rejected,
    };
  }

  private ctx(op: Op, side: ApplyCtx["side"] = "client"): ApplyCtx {
    return { now: op.at, is_commissioner: this.isCommissioner, side };
  }

  /**
   * snapshot.state + pending ops (rejected ones skipped but kept in the outbox; the server decides).
   * Re-application uses side "server": client-only checks (the drink window) already passed at
   * dispatch time, and the server trusts the stamped hole — so a queued drink must not vanish from
   * the view just because another phone completed the round before this one synced.
   */
  private computeView(): TripState {
    const base = this.snapshot!.state;
    const m = this.viewMemo;
    if (m && m.state === base && m.version === this.pendingVersion && m.commish === this.isCommissioner) return m.view;
    let view = base;
    for (const e of this.pending) {
      try {
        const r = this.d.applyOp(view, e.op, this.ctx(e.op, "server"));
        if (r.ok) view = r.state;
      } catch (err) {
        console.error("[scramble] reducer threw re-applying", e.op.type, err);
      }
    }
    this.viewMemo = { state: base, version: this.pendingVersion, commish: this.isCommissioner, view };
    return view;
  }

  private computeDerived(view: TripState): Derived | null {
    const m = this.derivedMemo;
    if (m && m.view === view) return m.derived;
    let derived: Derived | null;
    try {
      derived = this.d.derive(view);
    } catch (err) {
      console.error("[scramble] derive failed", err);
      // Keep showing the last good numbers rather than blanking the screen.
      derived = m?.derived ?? null;
    }
    this.derivedMemo = { view, derived };
    return derived;
  }

  // ------------------------------------------------------------------ actions

  /**
   * Fill id/at/by (by = meId), run the reducer against the current view (side "client").
   * Rejected -> nothing is queued, returns the reason (UI shows a toast/roast).
   * Accepted -> written to the outbox, view/derived update synchronously, flush scheduled.
   */
  dispatch(input: OpInput): DispatchResult {
    if (!this.isLoaded()) return { ok: false, code: "invalid", reason: LOADING_REASON };
    const nowMs = this.d.now();
    const at = iso(this.clock ? this.clock.now(nowMs) : nowMs);
    const op = { ...input, id: this.d.newId(), at, by: this.meId } as Op;
    const view = this.computeView();
    let res: ApplyResult;
    try {
      res = this.d.applyOp(view, op, this.ctx(op));
    } catch (err) {
      console.error("[scramble] reducer threw", op.type, err);
      return { ok: false, code: "invalid", reason: `That didn't work (${errorMessage(err)}).` };
    }
    if (!res.ok) return { ok: false, code: res.code, reason: res.reason };

    const entry: Entry = {
      id: op.id,
      seq: this.nextSeq(nowMs),
      op,
      photo_paths: photoPathsOf(op),
      attempts: 0,
      last_error: null,
      version: 1,
      savedVersion: 0,
    };
    this.pending = [...this.pending, entry];
    this.pendingVersion++;
    // Fast path: the new view is exactly the reducer's output on the old view.
    this.viewMemo = { state: this.snapshot!.state, version: this.pendingVersion, commish: this.isCommissioner, view: res.state };
    this.changed();
    this.schedulePersist();
    this.worker.schedule();
    return { ok: true, op };
  }

  /**
   * Remove a not-yet-synced op from the outbox if still pending; returns false if already sent.
   * A photo only that op referenced is dropped too (no point uploading an undone drink's photo).
   */
  async cancelPending(opId: UUID): Promise<boolean> {
    const e = this.pending.find((p) => p.id === opId);
    if (!e || e.attempts > 0 || this.inFlight.has(opId)) return false;
    this.removeEntries([opId]);
    for (const path of e.photo_paths) {
      if (this.blobs.has(path) && !this.isPhotoReferenced(path)) this.dropBlob(path);
    }
    this.changed();
    await this.persistSoon();
    return true;
  }

  setMe(playerId: UUID | null): void {
    this.meId = playerId;
    saveMe(this.code, playerId, this.d.storage);
    this.changed();
  }

  /** Dismiss surfaced rejections (all, or one by op id). */
  dismissRejected(opId?: UUID): void {
    const next = opId ? this.rejected.filter((r) => r.id !== opId) : [];
    if (next.length === this.rejected.length) return;
    this.rejected = next;
    saveSyncIssues(this.code, next, this.d.storage);
    this.changed();
  }

  /** Refetch GET /api/t/<code>/state. */
  refresh(): Promise<void> {
    if (this.refreshInflight) {
      this.refreshAgain = true;
      return this.refreshInflight;
    }
    const p = (async () => {
      try {
        let rounds = 0;
        do {
          this.refreshAgain = false;
          await this.fetchState();
        } while (this.refreshAgain && ++rounds < 5);
      } finally {
        this.refreshInflight = null;
      }
    })();
    this.refreshInflight = p;
    return p;
  }

  private async fetchState(): Promise<void> {
    const sentMs = this.d.now();
    const res = await httpRequest(
      this.d.fetch,
      `/api/t/${encodeURIComponent(this.code)}/state`,
      { method: "GET", timeoutMs: this.cfg.requestTimeoutMs },
      this.d.timers,
    );
    if (res.kind === "http" && res.ok && isSnapshot(res.json)) {
      this.netOk = true;
      this.clock?.observe(res.json.meta.server_time, sentMs, this.d.now());
      this.lastSyncAt = iso(this.d.now());
      this.loadError = null;
      this.adoptSnapshot(res.json, true);
      this.changed();
      return;
    }
    if (res.kind === "http" && res.status === 404) {
      this.netOk = true;
      if (!this.snapshot) {
        if (this.restoring) await this.restoring;
        if (!this.snapshot) this.loadError = "No trip with that code. Double-check the link from the group chat.";
      }
      this.changed();
      return;
    }
    this.netOk = false;
    if (!this.snapshot) {
      if (this.restoring) await this.restoring;
      if (!this.snapshot) {
        this.loadError =
          res.kind === "network"
            ? "No signal, and this trip isn't saved on this phone yet. Find a bar of service and it'll load."
            : `The server is having a moment (${res.kind === "http" ? res.status : "error"}). Retrying…`;
      }
    }
    this.changed();
  }

  /**
   * Push pending ops now and start a photo upload pass. Resolves when the ops pass is done; a
   * slow upload never holds that up unless `photos` asks to wait for the upload pass too.
   */
  async flush(opts: { photos?: boolean } = {}): Promise<void> {
    if (this.restoring) await this.restoring;
    const uploads = this.uploader.flush();
    await this.worker.flush();
    if (opts.photos) await uploads;
  }

  /**
   * Compress (1600px longest side, JPEG 0.7) and queue a photo upload. Returns the storage path
   * `trips/<trip_id>/<kind>/<uuid>.jpg` to put in an op. A local preview is available immediately
   * via photoUrl(path).
   */
  async addPhoto(file: Blob, kind: PhotoKind): Promise<string> {
    const tripId = this.snapshot?.state.trip.id;
    if (!tripId) throw new Error(LOADING_REASON);
    const blob = await this.d.compressPhoto(file);
    const path = `trips/${tripId}/${kind}/${this.d.newId()}.jpg`;
    this.blobs.set(path, {
      path,
      blob,
      failures: 0,
      permanentFailures: 0,
      created_at: iso(this.d.now()),
      persisted: false,
    });
    this.changed();
    // Best effort: get the photo on disk before the op that references it is dispatched.
    await this.persistSoon(2000);
    this.uploader.schedule();
    return path;
  }

  /** The photo is still queued on this phone (not uploaded yet). Re-render on pendingCount changes. */
  isPhotoPending(path: string | null | undefined): boolean {
    return !!path && this.blobs.has(path);
  }

  /** URL to display a stored photo: local object URL while pending, else meta.photo_base_url + path. */
  photoUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    if (/^(https?:|blob:|data:)/.test(path)) return path;
    const cached = this.objectUrls.get(path);
    if (cached) return cached.url;
    const pendingBlob = this.blobs.get(path);
    if (pendingBlob && this.d.createObjectURL) {
      try {
        const url = this.d.createObjectURL(pendingBlob.blob);
        this.objectUrls.set(path, { url, expires: null });
        return url;
      } catch {
        /* fall through to the remote URL */
      }
    }
    const base = this.snapshot?.meta.photo_base_url;
    return base === undefined || base === null ? null : base + path;
  }

  async unlockCommissioner(pin: string): Promise<boolean> {
    const res = await httpRequest(
      this.d.fetch,
      `/api/t/${encodeURIComponent(this.code)}/commissioner`,
      { method: "POST", body: JSON.stringify({ pin }), headers: { "content-type": "application/json" }, timeoutMs: this.cfg.requestTimeoutMs },
      this.d.timers,
    );
    if (res.kind === "network" || res.status >= 500) {
      this.netOk = false;
      this.changed();
      return false;
    }
    this.netOk = true;
    const ok = res.ok && (res.json as { ok?: unknown } | undefined)?.ok === true;
    if (ok) {
      this.setCommissioner(true);
      await this.checkCommissioner();
    } else {
      this.changed();
    }
    return ok;
  }

  async lockCommissioner(): Promise<void> {
    await httpRequest(
      this.d.fetch,
      `/api/t/${encodeURIComponent(this.code)}/commissioner`,
      { method: "DELETE", timeoutMs: this.cfg.requestTimeoutMs },
      this.d.timers,
    );
    this.setCommissioner(false);
    await this.checkCommissioner();
  }

  private async checkCommissioner(): Promise<void> {
    const res = await httpRequest(
      this.d.fetch,
      `/api/t/${encodeURIComponent(this.code)}/commissioner`,
      { method: "GET", timeoutMs: this.cfg.requestTimeoutMs },
      this.d.timers,
    );
    // Offline: keep the cached answer so the commissioner can still fix things with no signal.
    if (res.kind !== "http" || !res.ok) return;
    const v = (res.json as { is_commissioner?: unknown } | undefined)?.is_commissioner;
    if (typeof v === "boolean") this.setCommissioner(v);
  }

  private setCommissioner(on: boolean): void {
    saveCommissionerHint(this.code, on, this.d.storage);
    if (this.isCommissioner === on) return;
    this.isCommissioner = on;
    this.changed();
  }

  // ------------------------------------------------------------------ snapshot

  /** Adopt if at least as fresh as the current one. Returns whether it was adopted. */
  private adoptSnapshot(next: Snapshot, persist: boolean): boolean {
    if (!isSnapshot(next)) return false;
    if (this.snapshot && timeOf(next) < timeOf(this.snapshot)) return false;
    const state = shareStructure(this.snapshot?.state ?? null, next.state);
    const stateChanged = !this.snapshot || state !== this.snapshot.state;
    this.snapshot = { state, meta: next.meta };
    if (persist && stateChanged) {
      this.snapshotVersion++;
      this.schedulePersist();
    }
    try {
      this.live?.setConfig(next.meta.realtime);
    } catch {
      /* ignore */
    }
    return true;
  }

  // ------------------------------------------------------------------ outbox bookkeeping

  private nextSeq(nowMs: number): number {
    const s = Math.max(this.lastSeq + 1, Math.floor(nowMs) * 1000);
    this.lastSeq = s;
    return s;
  }

  /** Schedule each lane that has work. */
  private kickWorkers(delayMs?: number): void {
    if (this.pending.length > 0) this.worker.schedule(delayMs);
    if (this.blobs.size > 0) this.uploader.schedule(delayMs);
  }

  /** A pending op, or a row the server already has, still points at this photo. */
  private isPhotoReferenced(path: string): boolean {
    if (this.pending.some((e) => e.photo_paths.includes(path))) return true;
    const state = this.snapshot?.state;
    return !!state && Object.values(state).some((table) => jsonOf(table).includes(path));
  }

  /** Forget a queued photo (and its local preview). */
  private dropBlob(path: string): void {
    this.blobs.delete(path);
    this.removedBlobPaths.add(path);
    const cached = this.objectUrls.get(path);
    if (cached) {
      this.objectUrls.delete(path);
      try {
        this.d.revokeObjectURL?.(cached.url);
      } catch {
        /* ignore */
      }
    }
    this.schedulePersist();
  }

  private removeEntries(ids: UUID[]): void {
    if (ids.length === 0) return;
    const set = new Set(ids);
    const before = this.pending.length;
    this.pending = this.pending.filter((e) => !set.has(e.id));
    for (const id of ids) {
      this.removedIds.add(id);
      this.goneIds.add(id);
    }
    if (this.pending.length !== before) this.pendingVersion++;
    this.schedulePersist();
  }

  /** Surface rejections: describe each (while its op is still at hand) and persist the list. */
  private pushRejected(results: OpResult[], ops: ReadonlyMap<UUID, Op> = new Map(), opType?: string): void {
    if (results.length === 0) return;
    const at = iso(this.d.now());
    const state = this.snapshot?.state ?? null;
    const issues = results.map((r): SyncIssue => {
      const op = ops.get(r.id);
      let description = "A change";
      try {
        if (op) description = describeOp(op, state);
      } catch {
        /* keep the generic text */
      }
      return { ...r, status: "rejected", op_type: op?.type ?? opType ?? "unknown", description, at };
    });
    this.rejected = mergeIssues(this.rejected, issues);
    saveSyncIssues(this.code, this.rejected, this.d.storage);
  }

  private opsById(ids: readonly UUID[]): Map<UUID, Op> {
    const wanted = new Set(ids);
    return new Map(this.pending.filter((e) => wanted.has(e.id)).map((e) => [e.id, e.op]));
  }

  private syncHost(): SyncHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    return {
      code: this.code,
      get fetch() {
        return store.d.fetch;
      },
      get timers() {
        return store.d.timers;
      },
      syncTimeoutMs: this.cfg.syncTimeoutMs,
      ready: async () => {
        if (store.restoring) await store.restoring;
      },
      pendingOps: () => store.pending,
      hasPending: () => store.pending.length > 0,
      onSending: (ids) => {
        for (const e of store.pending) {
          if (ids.includes(e.id)) {
            e.attempts++;
            e.version++;
            store.inFlight.add(e.id);
          }
        }
        store.schedulePersist();
      },
      onSendFailed: (ids, message) => {
        for (const e of store.pending) {
          if (ids.includes(e.id)) {
            e.last_error = message;
            e.version++;
          }
        }
        for (const id of ids) store.inFlight.delete(id);
      },
      onResults: (results, snapshot) => {
        const done: UUID[] = [];
        const rejected: OpResult[] = [];
        for (const r of results) {
          store.inFlight.delete(r.id);
          if (r.status === "applied" || r.status === "duplicate") done.push(r.id);
          else if (r.status === "rejected") {
            done.push(r.id);
            rejected.push(r);
          }
        }
        // Nothing is on the wire after a response (passes and batches are sequential). Ops the
        // server didn't answer for stay pending and are resent later (idempotent by id).
        store.inFlight.clear();
        const ops = store.opsById(rejected.map((r) => r.id));
        store.removeEntries(done);
        store.pushRejected(rejected, ops);
        if (snapshot) store.adoptSnapshot(snapshot, true);
        store.lastSyncAt = iso(store.d.now());
        store.changed();
      },
      onPoisonOp: (id, code, reason) => {
        const ops = store.opsById([id]);
        store.inFlight.delete(id);
        store.removeEntries([id]);
        store.pushRejected([{ id, status: "rejected", code, reason }], ops);
        store.changed();
      },
      onNetwork: (ok) => {
        if (store.netOk === ok) return;
        store.netOk = ok;
        store.changed();
      },
      setSyncing: (on) => {
        if (store.syncing === on) return;
        store.syncing = on;
        store.changed();
      },
    };
  }

  private uploadHost(): UploadHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    return {
      code: this.code,
      get fetch() {
        return store.d.fetch;
      },
      get timers() {
        return store.d.timers;
      },
      uploadTimeoutMs: this.cfg.uploadTimeoutMs,
      ready: async () => {
        if (store.restoring) await store.restoring;
      },
      pendingBlobs: () => [...store.blobs.values()],
      hasPending: () => store.blobs.size > 0,
      onUploaded: (path) => {
        const b = store.blobs.get(path);
        store.blobs.delete(path);
        store.removedBlobPaths.add(path);
        const cached = store.objectUrls.get(path);
        if (cached) cached.expires = store.d.now() + store.cfg.previewGraceMs;
        else if (b && store.d.createObjectURL && store.cfg.previewGraceMs > 0) {
          // Keep a local preview briefly so the image doesn't flicker while the remote loads.
          try {
            store.objectUrls.set(path, { url: store.d.createObjectURL(b.blob), expires: store.d.now() + store.cfg.previewGraceMs });
          } catch {
            /* ignore */
          }
        }
        store.sweepObjectUrls();
        store.schedulePersist();
        store.changed();
      },
      onUploadFailed: (path, permanent, message) => {
        const b = store.blobs.get(path);
        if (!b) return;
        b.failures++;
        if (permanent) {
          b.permanentFailures++;
          if (b.permanentFailures >= 3) {
            store.blobs.delete(path);
            store.removedBlobPaths.add(path);
            store.pushRejected(
              [{ id: path, status: "rejected", code: "invalid", reason: `A photo couldn't be uploaded (${message}). Everything else was saved.` }],
              undefined,
              "photo",
            );
            store.schedulePersist();
            store.changed();
          }
        }
      },
    };
  }

  private sweepObjectUrls(): void {
    const now = this.d.now();
    for (const [path, v] of this.objectUrls) {
      if (v.expires !== null && v.expires <= now && !this.blobs.has(path)) {
        this.objectUrls.delete(path);
        try {
          this.d.revokeObjectURL?.(v.url);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ------------------------------------------------------------------ IndexedDB

  private async restore(): Promise<void> {
    const db = this.db;
    if (!db) {
      this.restored = true;
      this.changed();
      return;
    }
    const load = Promise.all([
      db.snapshots.get(this.code),
      outboxFor(db, this.code),
      db.blobs.where("code").equals(this.code).toArray(),
    ]);
    load.catch(() => undefined);
    try {
      const data = await withTimeout(load, this.cfg.restoreTimeoutMs, this.d.timers);
      this.mergeRestored(data[0]?.snapshot ?? null, data[1], data[2]);
    } catch (e) {
      console.warn("[scramble] IndexedDB restore failed or is slow; continuing in memory", e);
      // If it was only slow, merge whatever arrives later.
      load.then(
        (data) => {
          this.mergeRestored(data[0]?.snapshot ?? null, data[1], data[2]);
          this.changed();
        },
        () => resetConnection(db),
      );
    }
    this.restored = true;
    this.changed();
  }

  private mergeRestored(
    snap: Snapshot | null,
    rows: OutboxRow[],
    blobRows: Array<{ path: string; blob: Blob | ArrayBuffer; type?: string; created_at: string; code: string }>,
  ): void {
    if (snap) {
      this.adoptSnapshot(snap, false);
    }
    const have = new Set(this.pending.map((e) => e.id));
    const add: Entry[] = [];
    for (const row of rows) {
      if (!row || !row.op || have.has(row.id) || this.goneIds.has(row.id)) continue;
      add.push({
        id: row.id,
        seq: row.seq,
        op: row.op,
        photo_paths: Array.isArray(row.photo_paths) ? row.photo_paths : photoPathsOf(row.op),
        attempts: row.attempts ?? 0,
        last_error: row.last_error ?? null,
        version: 1,
        savedVersion: 1,
      });
      if (row.seq > this.lastSeq) this.lastSeq = row.seq;
    }
    if (add.length > 0) {
      this.pending = [...this.pending, ...add].sort((a, b) => a.seq - b.seq);
      this.pendingVersion++;
    }
    for (const b of blobRows) {
      if (!b || this.blobs.has(b.path) || this.removedBlobPaths.has(b.path)) continue;
      this.blobs.set(b.path, {
        path: b.path,
        blob: rowBlob(b),
        failures: 0,
        permanentFailures: 0,
        created_at: b.created_at,
        persisted: true,
      });
    }
    if (this.started) this.kickWorkers(0);
  }

  private isDirty(): boolean {
    if (this.removedIds.size > 0 || this.removedBlobPaths.size > 0) return true;
    if (this.snapshot && this.snapshotVersion !== this.snapshotSavedVersion) return true;
    for (const e of this.pending) if (e.version !== e.savedVersion) return true;
    for (const b of this.blobs.values()) if (!b.persisted) return true;
    return false;
  }

  private schedulePersist(): void {
    if (!this.db) return;
    if (this.persistInflight) {
      this.persistAgain = true;
      return;
    }
    if (this.persistTimer !== null) return; // a retry is already scheduled
    void this.runPersist();
  }

  private runPersist(): Promise<void> {
    if (this.persistInflight) {
      this.persistAgain = true;
      return this.persistInflight;
    }
    const p = (async () => {
      try {
        let rounds = 0;
        do {
          this.persistAgain = false;
          await this.persistPass();
        } while (this.persistAgain && this.persistFailures === 0 && ++rounds < 20);
      } finally {
        this.persistInflight = null;
      }
      if (this.persistFailures > 0) this.schedulePersistRetry();
      else if (this.persistAgain) void this.runPersist();
    })();
    this.persistInflight = p;
    return p;
  }

  /** Persist now and wait (bounded). Never throws. */
  private async persistSoon(maxWaitMs = 4000): Promise<void> {
    if (!this.db) return;
    const p = this.persistInflight ? this.persistInflight.then(() => this.runPersist()) : this.runPersist();
    await Promise.race([
      p.catch(() => undefined),
      new Promise<void>((resolve) => this.d.timers.setTimeout(resolve, maxWaitMs)),
    ]);
  }

  private schedulePersistRetry(): void {
    if (this.persistTimer !== null || !this.db) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.persistFailures, 6));
    this.persistTimer = this.d.timers.setTimeout(() => {
      this.persistTimer = null;
      void this.runPersist();
    }, delay);
  }

  /** One pass: write every dirty row. Failures leave rows dirty for the next attempt. */
  private async persistPass(): Promise<void> {
    const db = this.db;
    if (!db) return;
    const t = this.cfg.persistTimeoutMs;
    const timers = this.d.timers;
    try {
      // Outbox puts.
      const dirty = this.pending.filter((e) => e.version !== e.savedVersion);
      if (dirty.length > 0) {
        const versions = dirty.map((e) => e.version);
        const rows: OutboxRow[] = dirty.map((e) => ({
          id: e.id,
          code: this.code,
          seq: e.seq,
          op: e.op,
          attempts: e.attempts,
          last_error: e.last_error,
          photo_paths: e.photo_paths,
        }));
        await withTimeout(db.outbox.bulkPut(rows), t, timers);
        dirty.forEach((e, i) => {
          e.savedVersion = versions[i];
        });
      }
      // Outbox deletes (after puts, so a put still in flight can't resurrect a deleted row).
      if (this.removedIds.size > 0) {
        const ids = [...this.removedIds];
        await withTimeout(db.outbox.bulkDelete(ids), t, timers);
        for (const id of ids) this.removedIds.delete(id);
      }
      // Photo blobs.
      for (const b of [...this.blobs.values()]) {
        if (b.persisted) continue;
        await withTimeout(putBlobRow(db, { path: b.path, code: this.code, blob: b.blob, created_at: b.created_at }), t, timers);
        b.persisted = true;
        if (!this.blobs.has(b.path)) this.removedBlobPaths.add(b.path); // uploaded meanwhile
      }
      if (this.removedBlobPaths.size > 0) {
        const paths = [...this.removedBlobPaths];
        await withTimeout(db.blobs.bulkDelete(paths), t, timers);
        for (const p of paths) this.removedBlobPaths.delete(p);
      }
      // Snapshot.
      if (this.snapshot && this.snapshotVersion !== this.snapshotSavedVersion) {
        const v = this.snapshotVersion;
        await withTimeout(db.snapshots.put({ code: this.code, snapshot: this.snapshot, saved_at: iso(this.d.now()) }), t, timers);
        this.snapshotSavedVersion = v;
      }
      this.persistFailures = 0;
    } catch (e) {
      this.persistFailures++;
      if (this.persistFailures === 1 || this.persistFailures % 10 === 0) {
        console.warn("[scramble] IndexedDB write failed; keeping changes in memory and retrying", e);
      }
      resetConnection(db);
    }
  }
}

/** `base` plus `added` (an id already listed moves to the end), newest MAX_SYNC_ISSUES kept. */
function mergeIssues(base: readonly SyncIssue[], added: readonly SyncIssue[]): SyncIssue[] {
  const ids = new Set(added.map((r) => r.id));
  return [...base.filter((r) => !ids.has(r.id)), ...added].slice(-MAX_SYNC_ISSUES);
}

// ------------------------------------------------------------------ registry

const registry = new Map<string, TripStore>();

/**
 * One TripStore per trip code per tab (survives remounts, so state stays warm). During SSR a
 * throwaway store is returned (it only serves getServerState) so the server never accumulates
 * stores for arbitrary codes.
 */
export function getTripStore(code: string): TripStore {
  if (typeof window === "undefined") return new TripStore(code, { db: null, realtime: null, win: null, doc: null });
  let s = registry.get(code);
  if (!s) {
    s = new TripStore(code);
    registry.set(code, s);
  }
  return s;
}
