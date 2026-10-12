"use client";
// TripStore: the client's single source of UI state for one trip.
// view = snapshot.state with pending outbox ops applied (same reducer as the server);
// derived = engine.derive(view). Every action goes to the IndexedDB outbox first.
import type { ISODate, Snapshot, TripState, UUID } from "../types";
import type { Op, OpInput, OpResult, RejectCode } from "../ops";
import type { Derived } from "../engine/types";

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
  /** navigator.onLine AND the last request didn't fail with a network error. */
  online: boolean;
  syncing: boolean;
  lastSyncAt: ISODate | null;
  /** Player chosen on this device ("tap your name"). Stored in localStorage per trip code. */
  meId: UUID | null;
  /** Commissioner cookie is valid (checked via GET /api/t/<code>/commissioner). */
  isCommissioner: boolean;
  /** Recent server rejections (newest last), for toasts. */
  rejected: OpResult[];
}

export type DispatchResult = { ok: true; op: Op } | { ok: false; code: RejectCode; reason: string };

export class TripStore {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
  /** Load cached snapshot from IndexedDB, fetch fresh state, subscribe to realtime, start the sync worker. */
  start(): void {
    throw new Error("not implemented");
  }
  stop(): void {
    throw new Error("not implemented");
  }
  getState(): ClientState {
    throw new Error("not implemented");
  }
  subscribe(listener: () => void): () => void {
    void listener;
    throw new Error("not implemented");
  }
  /**
   * Fill id/at/by (by = meId), run the reducer against the current view (side "client").
   * Rejected -> nothing is queued, returns the reason (UI shows a toast/roast).
   * Accepted -> written to the outbox, view/derived update synchronously, flush scheduled.
   */
  dispatch(input: OpInput): DispatchResult {
    void input;
    throw new Error("not implemented");
  }
  /** Remove a not-yet-synced op from the outbox if still pending; returns false if already sent. */
  cancelPending(opId: UUID): Promise<boolean> {
    void opId;
    throw new Error("not implemented");
  }
  setMe(playerId: UUID | null): void {
    void playerId;
    throw new Error("not implemented");
  }
  /** Refetch GET /api/t/<code>/state. */
  refresh(): Promise<void> {
    throw new Error("not implemented");
  }
  /** Flush the outbox now (uploads first, then ops). */
  flush(): Promise<void> {
    throw new Error("not implemented");
  }
  /**
   * Compress (1600px longest side, JPEG 0.7) and queue a photo upload. Returns the storage path
   * `trips/<trip_id>/<kind>/<uuid>.jpg` to put in an op. A local preview is available immediately
   * via photoUrl(path).
   */
  addPhoto(file: Blob, kind: PhotoKind): Promise<string> {
    void file; void kind;
    throw new Error("not implemented");
  }
  /** URL to display a stored photo: local object URL while pending, else meta.photo_base_url + path. */
  photoUrl(path: string | null | undefined): string | null {
    void path;
    throw new Error("not implemented");
  }
  unlockCommissioner(pin: string): Promise<boolean> {
    void pin;
    throw new Error("not implemented");
  }
  lockCommissioner(): Promise<void> {
    throw new Error("not implemented");
  }
}
