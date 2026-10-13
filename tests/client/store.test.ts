import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { makeTrip } from "../fixtures";
import { TripStore, type TripStoreDeps } from "@/lib/client/store";
import { ScrambleDB, outboxFor } from "@/lib/client/db";
import type { FetchLike } from "@/lib/client/sync";
import type { StorageLike } from "@/lib/client/identity";
import type { ApplyCtx, ApplyResult } from "@/lib/reducer";
import type { Op, OpInput, OpResult, SyncRequest } from "@/lib/ops";
import type { Drink, FeedEvent, HoleScore, Reaction, Snapshot, TripState } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";

// ----------------------------------------------------------------------------- harness

const CODE = "testcode42";

/** Tiny reducer for unit isolation (the real one gets its own integration test below). */
function simpleApply(state: TripState, op: Op, ctx: ApplyCtx): ApplyResult {
  const ok = (s: TripState): ApplyResult => ({ ok: true, state: s, writes: [] });
  switch (op.type) {
    case "drink.log": {
      if (op.hole === 99) return { ok: false, code: "no_window", reason: "No open window" };
      if (state.drinks.some((d) => d.id === op.drink_id)) return ok(state);
      const row: Drink = {
        id: op.drink_id,
        trip_id: state.trip.id,
        team_id: op.team_id,
        player_id: op.player_id,
        hole: op.hole,
        type: op.drink_type,
        photo_path: op.photo_path,
        logged_by: op.by,
        logged_at: op.at,
        created_at: ctx.now,
        deleted_at: null,
        deleted_by: null,
        moved_from_hole: null,
      };
      return ok({ ...state, drinks: [...state.drinks, row] });
    }
    case "drink.delete": {
      const d = state.drinks.find((x) => x.id === op.drink_id);
      if (!d) return { ok: false, code: "not_found", reason: "No such drink" };
      if (d.deleted_at) return ok(state);
      return ok({ ...state, drinks: state.drinks.map((x) => (x.id === op.drink_id ? { ...x, deleted_at: ctx.now, deleted_by: op.by } : x)) });
    }
    case "score.set": {
      if (op.strokes < 1 || op.strokes > 20) return { ok: false, code: "invalid", reason: "Strokes out of range" };
      const existing = state.hole_scores.find((s) => s.team_id === op.team_id && s.hole === op.hole);
      if (existing?.strokes_at && existing.strokes_at > op.at) return ok(state);
      const row: HoleScore = {
        id: existing?.id ?? `hs-${op.team_id}-${op.hole}`,
        trip_id: state.trip.id,
        team_id: op.team_id,
        hole: op.hole,
        strokes: op.strokes,
        tee_shot_player_id: existing?.tee_shot_player_id ?? null,
        strokes_at: op.at,
        tee_shot_at: existing?.tee_shot_at ?? null,
        edit_count: existing && existing.strokes !== null && existing.strokes !== op.strokes ? existing.edit_count + 1 : (existing?.edit_count ?? 0),
        updated_by: op.by,
        updated_at: ctx.now,
      };
      return ok({ ...state, hole_scores: [...state.hole_scores.filter((s) => s.id !== row.id), row] });
    }
    case "post.create": {
      if (state.feed_events.some((e) => e.id === op.event_id)) return ok(state);
      const ev: FeedEvent = {
        id: op.event_id,
        trip_id: state.trip.id,
        type: "post",
        team_id: null,
        player_id: op.by,
        actor_id: op.by,
        payload: {},
        photo_path: op.photo_path,
        text: op.text,
        dedupe_key: null,
        created_at: ctx.now,
        updated_at: ctx.now,
        deleted_at: null,
      };
      return ok({ ...state, feed_events: [...state.feed_events, ev] });
    }
    case "reaction.set": {
      const r: Reaction = {
        id: `rx-${op.feed_event_id}-${op.player_id}-${op.kind}`,
        trip_id: state.trip.id,
        feed_event_id: op.feed_event_id,
        player_id: op.player_id,
        kind: op.kind,
        created_at: ctx.now,
        deleted_at: op.on ? null : ctx.now,
      };
      return ok({ ...state, reactions: [...state.reactions.filter((x) => x.id !== r.id), r] });
    }
    case "trip.update": {
      if (!ctx.is_commissioner) return { ok: false, code: "forbidden", reason: "Commissioner only" };
      return ok({ ...state, trip: { ...state.trip, name: op.patch.name ?? state.trip.name } });
    }
    default:
      return ok(state);
  }
}

const simpleDerive = (s: TripState) =>
  ({
    activeDrinks: s.drinks.filter((d) => !d.deleted_at).length,
    posts: s.feed_events.length,
  }) as unknown as Derived;

type DerivedLite = { activeDrinks: number; posts: number };

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

/** Timers that only fire when the test says so. */
class ManualTimers {
  private seq = 0;
  readonly q = new Map<number, { fn: () => void; ms: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.q.set(id, { fn, ms });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.q.delete(h as number);
  };
  delays(): number[] {
    return [...this.q.values()].map((t) => t.ms);
  }
  /** Fire every timer currently queued with a delay in [min, max]. */
  fire(min = 0, max = Number.POSITIVE_INFINITY): number {
    let n = 0;
    for (const [id, t] of [...this.q]) {
      if (t.ms >= min && t.ms <= max) {
        this.q.delete(id);
        t.fn();
        n++;
      }
    }
    return n;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** In-memory server: an idempotent op log, uploads, snapshots, plus failure knobs. */
class FakeServer {
  time = Date.parse("2026-10-24T17:00:00.000Z");
  online = true;
  /** op id -> result of first processing (exactly-once log). */
  processed = new Map<string, OpResult>();
  /** Op ids in the order the server applied them. */
  appliedOrder: string[] = [];
  /** Every op id received, duplicates included. */
  received: string[] = [];
  events: string[] = [];
  uploads = new Map<string, Blob>();
  requests: Array<{ method: string; path: string; keepalive?: boolean }> = [];
  batchSizes: number[] = [];
  failSync = 0;
  failUpload = 0;
  /** Uploads hang (a weak uplink) until released or aborted by the client's timeout. */
  hangUploads = false;
  private uploadWaiters: Array<() => void> = [];
  uploadAttempts = 0;
  loseNextSyncResponse = false;
  rejectIds = new Set<string>();
  poisonIds = new Set<string>();
  gate: Promise<void> | null = null;
  waiting = false;
  gateHits = 0;
  /** Next GET /state answers with a snapshot older than the last one. */
  staleNext = false;
  isCommissioner = false;

  constructor(
    public state: TripState,
    private readonly apply: (s: TripState, op: Op, ctx: ApplyCtx) => ApplyResult = simpleApply,
  ) {}

  snapshot(timeMs?: number): Snapshot {
    if (timeMs === undefined) this.time += 1000;
    return {
      state: this.state,
      meta: {
        server_time: new Date(timeMs ?? this.time).toISOString(),
        photo_base_url: "https://cdn.test/photos/",
        realtime: null,
        vapid_public_key: null,
        ai_enabled: false,
        push_enabled: false,
      },
    };
  }

  /** Let hanging uploads through. */
  releaseUploads(): void {
    this.hangUploads = false;
    for (const w of this.uploadWaiters.splice(0)) w();
  }

  appliedCount(id: string): number {
    return this.appliedOrder.filter((x) => x === id).length;
  }

  fetch: FetchLike = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url, "http://local.test");
    this.requests.push({ method, path: u.pathname, keepalive: init.keepalive });
    if (!this.online) throw new TypeError("Failed to fetch");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const m = u.pathname.match(/^\/api\/t\/([^/]+)\/(state|sync|upload|commissioner)$/);
    if (!m || m[1] !== CODE) return json({ error: "not found" }, 404);
    switch (m[2]) {
      case "state": {
        if (this.staleNext) {
          this.staleNext = false;
          return json(this.snapshot(this.time - 60_000));
        }
        return json(this.snapshot());
      }
      case "upload": {
        this.uploadAttempts++;
        if (this.hangUploads) {
          await new Promise<void>((resolve, reject) => {
            this.uploadWaiters.push(resolve);
            init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
          });
        }
        if (this.failUpload > 0) {
          this.failUpload--;
          return json({ error: "storage down" }, 503);
        }
        const path = u.searchParams.get("path")!;
        this.uploads.set(path, init.body as Blob);
        this.events.push(`upload:${path}`);
        return json({ path });
      }
      case "sync": {
        const { ops } = JSON.parse(String(init.body)) as SyncRequest;
        if (this.gate) {
          this.waiting = true;
          this.gateHits++;
          await this.gate;
          this.waiting = false;
        }
        if (this.failSync > 0) {
          this.failSync--;
          return json({ error: "db down" }, 503);
        }
        if (ops.some((o) => this.poisonIds.has(o.id))) return json({ error: "unparseable op" }, 400);
        this.batchSizes.push(ops.length);
        const results: OpResult[] = [];
        for (const op of ops) {
          this.received.push(op.id);
          const prev = this.processed.get(op.id);
          if (prev) {
            results.push(prev.status === "rejected" ? prev : { id: op.id, status: "duplicate" });
            continue;
          }
          let r: OpResult;
          if (this.rejectIds.has(op.id)) {
            r = { id: op.id, status: "rejected", code: "conflict", reason: "Server says no" };
          } else {
            const res = this.apply(this.state, op, { now: new Date(this.time).toISOString(), is_commissioner: this.isCommissioner, side: "server" });
            if (res.ok) {
              this.state = res.state;
              this.appliedOrder.push(op.id);
              this.events.push(`op:${op.id}`);
              r = { id: op.id, status: "applied" };
            } else {
              r = { id: op.id, status: "rejected", code: res.code, reason: res.reason };
            }
          }
          this.processed.set(op.id, r);
          results.push(r);
        }
        if (this.loseNextSyncResponse) {
          this.loseNextSyncResponse = false;
          throw new TypeError("The network connection was lost.");
        }
        return json({ results, snapshot: this.snapshot() });
      }
      case "commissioner": {
        if (method === "GET") return json({ is_commissioner: this.isCommissioner });
        if (method === "POST") {
          const { pin } = JSON.parse(String(init.body)) as { pin: string };
          if (pin !== "2468") return json({ ok: false }, 401);
          this.isCommissioner = true;
          return json({ ok: true });
        }
        this.isCommissioner = false;
        return json({ ok: true });
      }
    }
    return json({ error: "nope" }, 404);
  };
}

let idSeq = 0;
const newTestId = () => `id-${++idSeq}`;
const stores: TripStore[] = [];

function makeStore(server: FakeServer, opts: Partial<TripStoreDeps> & { dbName?: string } = {}) {
  const timers = new ManualTimers();
  let urlSeq = 0;
  const revoked: string[] = [];
  const clock = { now: Date.parse("2026-10-24T17:05:00.000Z") };
  const store = new TripStore(CODE, {
    fetch: server.fetch,
    db: opts.db ?? opts.dbName ?? `scramble-test-${Math.random().toString(36).slice(2)}`,
    now: () => clock.now,
    newId: newTestId,
    applyOp: simpleApply,
    derive: simpleDerive,
    storage: new MemStorage(),
    online: () => true,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    random: () => 0.5,
    realtime: null,
    compressPhoto: async (b) => new Blob([await b.arrayBuffer()], { type: "image/jpeg" }),
    createObjectURL: () => `blob:test/${++urlSeq}`,
    revokeObjectURL: (u) => void revoked.push(u),
    win: null,
    doc: null,
    ...opts,
  });
  stores.push(store);
  // Clock moves 1 s per read so ops get distinct timestamps.
  const tick = () => (clock.now += 1000);
  return { store, timers, revoked, clock, tick };
}

async function started(server: FakeServer, opts: Parameters<typeof makeStore>[1] = {}) {
  const h = makeStore(server, opts);
  h.store.start();
  await until(() => h.store.getState().loaded);
  return h;
}

function lite(store: TripStore): DerivedLite {
  return store.getState().derived as unknown as DerivedLite;
}

afterEach(() => {
  while (stores.length) stores.pop()!.stop();
});

function drinkInput(f: ReturnType<typeof makeTrip>, extra: Partial<Extract<OpInput, { type: "drink.log" }>> = {}): OpInput {
  return {
    type: "drink.log",
    drink_id: newTestId(),
    team_id: f.team.A,
    player_id: f.player.A1,
    hole: 1,
    drink_type: "drink",
    photo_path: null,
    ...extra,
  };
}

// ----------------------------------------------------------------------------- tests

describe("TripStore offline-first sync", () => {
  it("Airplane mode: log 10 mixed actions, reconnect, and every action syncs exactly once", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const dbName = `scramble-airplane-${Date.now()}`;
    const storage = new MemStorage();
    const a = await started(server, { dbName, storage });
    a.store.setMe(f.player.A1);

    // Airplane mode on.
    server.online = false;
    const photoPath = await a.store.addPhoto(new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }), "drinks");
    expect(photoPath).toMatch(new RegExp(`^trips/${f.state.trip.id}/drinks/[^/]+\\.jpg$`));
    expect(a.store.photoUrl(photoPath)).toMatch(/^blob:test\//);

    const firstDrink = newTestId();
    const postId = newTestId();
    const inputs: OpInput[] = [
      drinkInput(f, { drink_id: firstDrink }),
      drinkInput(f, { photo_path: photoPath, player_id: f.player.A2 }),
      { type: "score.set", team_id: f.team.A, hole: 1, strokes: 4 },
      { type: "teeshot.set", team_id: f.team.A, hole: 1, player_id: f.player.A3 },
      { type: "post.create", event_id: postId, text: "Airplane mode is undefeated", photo_path: null },
      { type: "reaction.set", feed_event_id: postId, player_id: f.player.A1, kind: "fire", on: true },
      drinkInput(f, { drink_type: "shotgun", player_id: f.player.A4 }),
      { type: "drink.delete", drink_id: firstDrink },
      { type: "score.set", team_id: f.team.A, hole: 1, strokes: 5 },
      { type: "tee.open", team_id: f.team.A, hole: 2 },
    ];
    const dispatched: Op[] = [];
    for (const input of inputs) {
      a.tick();
      const r = a.store.dispatch(input);
      expect(r.ok).toBe(true);
      if (r.ok) dispatched.push(r.op);
    }
    expect(dispatched.every((op) => op.by === f.player.A1)).toBe(true);
    expect(a.store.getState().pendingCount).toBe(11);
    // Optimistic view: 3 drinks logged, 1 undone.
    expect(lite(a.store).activeDrinks).toBe(2);

    // Sync attempts while offline keep everything.
    await a.store.flush();
    await a.store.flush();
    expect(a.store.getState().online).toBe(false);
    expect(a.store.getState().pendingCount).toBe(11);
    expect(server.received).toHaveLength(0);

    // Restart the app (new store instance, same IndexedDB), still offline.
    await a.store.settled();
    a.store.stop();
    const b = await started(server, { dbName, storage });
    expect(b.store.getState().meId).toBe(f.player.A1);
    expect(b.store.getState().pendingCount).toBe(11);
    expect(lite(b.store).activeDrinks).toBe(2);
    expect(b.store.photoUrl(photoPath)).toMatch(/^blob:test\//);

    // Reconnect.
    server.online = true;
    await b.store.flush({ photos: true });
    expect(b.store.getState().pendingCount).toBe(0);
    expect(b.store.getState().online).toBe(true);
    expect(b.store.getState().lastSyncAt).not.toBeNull();
    for (const op of dispatched) expect(server.appliedCount(op.id)).toBe(1);
    expect(server.appliedOrder).toEqual(dispatched.map((op) => op.id));
    expect(new Set(server.received).size).toBe(server.received.length);
    // The photo went up exactly once (in its own lane; the op carried its path without waiting).
    const photoOp = dispatched[1];
    expect(server.uploads.has(photoPath)).toBe(true);
    expect(server.events.filter((e) => e === `upload:${photoPath}`)).toHaveLength(1);
    // Server state now matches the optimistic view.
    expect(lite(b.store).activeDrinks).toBe(2);
    expect(b.store.getState().view!.drinks.find((d) => d.id === (photoOp as Extract<Op, { type: "drink.log" }>).drink_id)?.photo_path).toBe(photoPath);

    // The outbox and blob store are empty on disk too.
    await b.store.settled();
    const db = new ScrambleDB(dbName);
    expect(await outboxFor(db, CODE)).toHaveLength(0);
    expect(await db.blobs.where("code").equals(CODE).count()).toBe(0);
    db.close();

    // Another flush sends nothing new.
    await b.store.flush();
    for (const op of dispatched) expect(server.appliedCount(op.id)).toBe(1);
  });

  it("retries with exponential backoff and never duplicates", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const ops: Op[] = [];
    for (let i = 0; i < 3; i++) {
      h.tick();
      const r = h.store.dispatch(drinkInput(f));
      if (r.ok) ops.push(r.op);
    }
    server.failSync = 3;
    await h.store.flush();
    expect(h.store.getState().online).toBe(false);
    expect(h.store.getState().pendingCount).toBe(3);
    expect(h.timers.delays()).toContain(1000); // 1st retry: 1 s
    await h.store.flush();
    expect(h.timers.delays()).toContain(1500); // 2nd: jittered within [1 s, 2 s]
    await h.store.flush();
    expect(h.timers.delays()).toContain(3000); // 3rd: within [2 s, 4 s]
    // The scheduled retry fires and succeeds.
    h.timers.fire(3000, 3000);
    await until(() => h.store.getState().pendingCount === 0);
    expect(h.store.getState().online).toBe(true);
    for (const op of ops) expect(server.appliedCount(op.id)).toBe(1);
    expect(server.received).toHaveLength(3);
  });

  it("a lost response after the server applied is resent, answered duplicate, and removed", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const r = h.store.dispatch(drinkInput(f));
    expect(r.ok).toBe(true);
    const op = (r as { ok: true; op: Op }).op;
    server.loseNextSyncResponse = true;
    await h.store.flush();
    expect(server.appliedCount(op.id)).toBe(1);
    expect(h.store.getState().pendingCount).toBe(1);
    expect(h.store.getState().online).toBe(false);
    // Already on the wire: can't be silently cancelled any more.
    expect(await h.store.cancelPending(op.id)).toBe(false);
    await h.store.flush();
    expect(h.store.getState().pendingCount).toBe(0);
    expect(server.received.filter((id) => id === op.id)).toHaveLength(2);
    expect(server.appliedCount(op.id)).toBe(1);
    expect(lite(h.store).activeDrinks).toBe(1);
    expect(h.store.getState().rejected).toHaveLength(0);
  });

  it("server-rejected ops are removed from the outbox and surfaced in rejected", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const good = h.store.dispatch(drinkInput(f));
    const bad = h.store.dispatch(drinkInput(f));
    if (!good.ok || !bad.ok) throw new Error("dispatch failed");
    server.rejectIds.add(bad.op.id);
    expect(lite(h.store).activeDrinks).toBe(2);
    await h.store.flush();
    const s = h.store.getState();
    expect(s.pendingCount).toBe(0);
    expect(s.rejected).toEqual([
      {
        id: bad.op.id,
        status: "rejected",
        code: "conflict",
        reason: "Server says no",
        op_type: "drink.log",
        description: "Drink for Player A1 · hole 1",
        at: "2026-10-24T17:05:00.000Z",
      },
    ]);
    expect(lite(h.store).activeDrinks).toBe(1);
    h.store.dismissRejected(bad.op.id);
    expect(h.store.getState().rejected).toHaveLength(0);
  });

  it("rejections persist per trip (newest 20) with op type, description and time, until dismissed", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const storage = new MemStorage();
    const a = await started(server, { storage });
    const ops: Op[] = [];
    for (let i = 1; i <= 25; i++) {
      a.tick();
      const r = a.store.dispatch({ type: "score.set", team_id: f.team.A, hole: 1, strokes: (i % 9) + 1 });
      if (!r.ok) throw new Error("dispatch failed");
      server.rejectIds.add(r.op.id);
      ops.push(r.op);
    }
    await a.store.flush();
    const rejected = a.store.getState().rejected;
    expect(rejected.map((r) => r.id)).toEqual(ops.slice(-20).map((o) => o.id));
    expect(rejected[19]).toMatchObject({ op_type: "score.set", description: "Hole 1 score: 8 · Team A", reason: "Server says no" });
    expect(Date.parse(rejected[19].at)).not.toBeNaN();
    a.store.dismissRejected(ops[24].id);
    a.store.stop();

    // A reload (new store, same localStorage) still lists them; other trips don't see them.
    const b = await started(server, { storage });
    expect(b.store.getState().rejected.map((r) => r.id)).toEqual(ops.slice(-20, -1).map((o) => o.id));
    expect(b.store.getState().rejected[0]).toMatchObject({ op_type: "score.set", description: expect.stringMatching(/^Hole 1 score: \d · Team A$/) });
    expect(storage.map.has("scramble:sync-issues:other")).toBe(false);
    b.store.dismissRejected();
    expect(b.store.getState().rejected).toEqual([]);
    const c = await started(server, { storage });
    expect(c.store.getState().rejected).toEqual([]);
  });

  it("a dispatch the reducer rejects queues nothing", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const dbName = `scramble-reject-${Date.now()}`;
    const h = await started(server, { dbName });
    let notified = 0;
    h.store.subscribe(() => notified++);
    const r = h.store.dispatch(drinkInput(f, { hole: 99 }));
    expect(r).toEqual({ ok: false, code: "no_window", reason: "No open window" });
    expect(h.store.getState().pendingCount).toBe(0);
    expect(notified).toBe(0);
    const forbidden = h.store.dispatch({ type: "trip.update", patch: { name: "Hijacked" } });
    expect(forbidden.ok).toBe(false);
    await h.store.settled();
    const db = new ScrambleDB(dbName);
    expect(await outboxFor(db, CODE)).toHaveLength(0);
    db.close();
    await h.store.flush();
    expect(server.received).toHaveLength(0);
  });

  it("dispatch before the trip is loaded is refused (not queued)", () => {
    const server = new FakeServer(makeTrip({ teams: [2, 2] }).state);
    const h = makeStore(server);
    const r = h.store.dispatch({ type: "tee.open", team_id: "x", hole: 1 });
    expect(r.ok).toBe(false);
    expect(h.store.getState().pendingCount).toBe(0);
  });

  it("ops dispatched while a sync is in flight survive the rebase", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const first = h.store.dispatch(drinkInput(f));
    if (!first.ok) throw new Error("dispatch failed");
    const gate1 = deferred();
    server.gate = gate1.promise;
    const flushing = h.store.flush();
    await until(() => server.gateHits === 1);
    expect(h.store.getState().syncing).toBe(true);
    h.tick();
    const second = h.store.dispatch(drinkInput(f, { player_id: f.player.A2 }));
    if (!second.ok) throw new Error("dispatch failed");
    expect(lite(h.store).activeDrinks).toBe(2);
    // Hold the follow-up request so we can look at the state right after the rebase.
    const gate2 = deferred();
    server.gate = gate2.promise;
    gate1.resolve();
    await until(() => server.gateHits === 2);
    let s = h.store.getState();
    expect(server.appliedCount(first.op.id)).toBe(1);
    expect(server.appliedCount(second.op.id)).toBe(0);
    // Rebased: first comes from the server snapshot, second is still pending on top of it.
    expect(s.snapshot!.state.drinks).toHaveLength(1);
    expect(s.pendingCount).toBe(1);
    expect(lite(h.store).activeDrinks).toBe(2);
    expect(s.view!.drinks.map((d) => d.id).sort()).toEqual(
      [(first.op as Extract<Op, { type: "drink.log" }>).drink_id, (second.op as Extract<Op, { type: "drink.log" }>).drink_id].sort(),
    );
    server.gate = null;
    gate2.resolve();
    await flushing;
    s = h.store.getState();
    expect(server.appliedCount(second.op.id)).toBe(1);
    expect(s.pendingCount).toBe(0);
    expect(s.snapshot!.state.drinks).toHaveLength(2);
    expect(lite(h.store).activeDrinks).toBe(2);
  });

  it("a flush requested during an in-flight flush runs again right after it", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const first = h.store.dispatch(drinkInput(f));
    const gate = deferred();
    server.gate = gate.promise;
    const p1 = h.store.flush();
    await until(() => server.waiting);
    const second = h.store.dispatch(drinkInput(f));
    const p2 = h.store.flush(); // joins + requests a re-run
    server.gate = null;
    gate.resolve();
    await Promise.all([p1, p2]);
    if (!first.ok || !second.ok) throw new Error("dispatch failed");
    expect(server.appliedCount(first.op.id)).toBe(1);
    expect(server.appliedCount(second.op.id)).toBe(1);
    expect(h.store.getState().pendingCount).toBe(0);
  });

  it("does not adopt a stale snapshot", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const before = h.store.getState().snapshot!;
    server.state = { ...server.state, trip: { ...server.state.trip, name: "Renamed" } };
    server.staleNext = true;
    await h.store.refresh();
    expect(h.store.getState().snapshot).toBe(before);
    expect(h.store.getState().view!.trip.name).toBe("Test Trip");
    await h.store.refresh();
    expect(h.store.getState().view!.trip.name).toBe("Renamed");
  });

  it("keeps view identity when a poll returns identical data", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const s1 = h.store.getState();
    await h.store.refresh();
    const s2 = h.store.getState();
    expect(s2.snapshot!.meta.server_time > s1.snapshot!.meta.server_time).toBe(true);
    expect(s2.view).toBe(s1.view);
    expect(s2.derived).toBe(s1.derived);
  });

  it("cancelPending removes an unsent op; returns false once it was sent", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const dbName = `scramble-cancel-${Date.now()}`;
    const h = await started(server, { dbName });
    const r = h.store.dispatch(drinkInput(f));
    if (!r.ok) throw new Error("dispatch failed");
    await h.store.settled();
    expect(await h.store.cancelPending(r.op.id)).toBe(true);
    expect(h.store.getState().pendingCount).toBe(0);
    expect(lite(h.store).activeDrinks).toBe(0);
    await h.store.settled();
    const db = new ScrambleDB(dbName);
    expect(await outboxFor(db, CODE)).toHaveLength(0);
    db.close();
    await h.store.flush();
    expect(server.received).toHaveLength(0);
    expect(await h.store.cancelPending(r.op.id)).toBe(false);

    // Sent but not acknowledged (offline attempt) -> false.
    const r2 = h.store.dispatch(drinkInput(f));
    if (!r2.ok) throw new Error("dispatch failed");
    server.online = false;
    await h.store.flush();
    expect(h.store.getState().pendingCount).toBe(1);
    // An offline attempt may still have reached the server (we can't know): not cancellable.
    expect(await h.store.cancelPending(r2.op.id)).toBe(false);
  });

  it("never loses an op when IndexedDB writes fail; retries persistence", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const dbName = `scramble-flaky-${Date.now()}`;
    const db = new ScrambleDB(dbName);
    let failOutbox = false;
    db.use({
      stack: "dbcore",
      name: "flaky",
      create: (down) => ({
        ...down,
        table: (name) => {
          const t = down.table(name);
          return {
            ...t,
            mutate: (req) => (failOutbox && name === "outbox" ? Promise.reject(new Error("disk on fire")) : t.mutate(req)),
          };
        },
      }),
    });
    const h = await started(server, { db });
    failOutbox = true;
    server.online = false;
    const r = h.store.dispatch(drinkInput(f));
    if (!r.ok) throw new Error("dispatch failed");
    await h.store.settled();
    expect(h.store.getState().pendingCount).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    // Disk recovers; the scheduled persistence retry writes it.
    failOutbox = false;
    const fired = h.timers.fire(500, 30_000);
    expect(fired).toBeGreaterThan(0);
    await h.store.settled();
    expect((await outboxFor(db, CODE)).map((row) => row.id)).toEqual([r.op.id]);
    // And it still syncs.
    server.online = true;
    await h.store.flush();
    expect(server.appliedCount(r.op.id)).toBe(1);
  });

  it("an IndexedDB that hangs doesn't block the app; rows that show up late are merged and synced", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const dbName = `scramble-hang-${Date.now()}`;
    const seed = new ScrambleDB(dbName);
    const oldOp = {
      type: "drink.log",
      id: "old-op",
      at: "2026-10-24T16:59:00.000Z",
      by: f.player.A1,
      drink_id: "old-drink",
      team_id: f.team.A,
      player_id: f.player.A1,
      hole: 1,
      drink_type: "drink",
      photo_path: null,
    } as Op;
    await seed.outbox.put({ id: "old-op", code: CODE, seq: 1, op: oldOp, attempts: 0, last_error: null, photo_paths: [] });
    seed.close();

    // iOS sometimes never completes indexedDB.open(): hold the open request until the gate opens.
    const gate = deferred();
    const realIdb = globalThis.indexedDB;
    const stallingIdb = {
      cmp: realIdb.cmp.bind(realIdb),
      deleteDatabase: realIdb.deleteDatabase.bind(realIdb),
      databases: realIdb.databases?.bind(realIdb),
      open(name: string, version?: number) {
        const stored: Record<string | symbol, unknown> = {};
        let real: IDBOpenDBRequest | null = null;
        void gate.promise.then(() => {
          real = realIdb.open(name, version);
          for (const k of Reflect.ownKeys(stored)) (real as unknown as Record<string | symbol, unknown>)[k] = stored[k];
        });
        return new Proxy(stored, {
          get: (t, k) => (real ? (real as unknown as Record<string | symbol, unknown>)[k] : t[k]),
          set: (t, k, v) => {
            t[k] = v;
            if (real) (real as unknown as Record<string | symbol, unknown>)[k] = v;
            return true;
          },
        });
      },
    };
    const db = new ScrambleDB(dbName, { indexedDB: stallingIdb, IDBKeyRange: globalThis.IDBKeyRange });
    const h = makeStore(server, { db });
    h.store.start();
    await until(() => h.store.getState().snapshot !== null);
    expect(h.store.getState().loaded).toBe(false); // still giving IndexedDB its chance
    expect(h.timers.fire(3000, 3000)).toBeGreaterThan(0); // restore timeout
    await until(() => h.store.getState().loaded);
    const r = h.store.dispatch(drinkInput(f));
    if (!r.ok) throw new Error("dispatch failed");
    expect(h.store.getState().pendingCount).toBe(1);
    // The disk wakes up: the old op from the last session appears and goes first.
    gate.resolve();
    await until(() => h.store.getState().pendingCount === 2);
    expect(lite(h.store).activeDrinks).toBe(2);
    await h.store.flush();
    expect(server.appliedOrder).toEqual(["old-op", r.op.id]);
    expect(h.store.getState().pendingCount).toBe(0);
  });

  it("sends at most 100 ops per request, in seq order", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const ops: Op[] = [];
    for (let i = 0; i < 250; i++) {
      const r = h.store.dispatch(drinkInput(f));
      if (r.ok) ops.push(r.op);
    }
    expect(h.store.getState().pendingCount).toBe(250);
    await h.store.flush();
    expect(server.batchSizes).toEqual([100, 100, 50]);
    expect(server.appliedOrder).toEqual(ops.map((o) => o.id));
    expect(h.store.getState().pendingCount).toBe(0);
  });

  it("remembers commissioner powers across an offline restart", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const storage = new MemStorage();
    const dbName = `scramble-commish-${Date.now()}`;
    const a = await started(server, { storage, dbName });
    expect(await a.store.unlockCommissioner("2468")).toBe(true);
    await a.store.settled();
    a.store.stop();
    server.online = false;
    const b = await started(server, { storage, dbName });
    expect(b.store.getState().isCommissioner).toBe(true);
    expect(b.store.dispatch({ type: "trip.update", patch: { name: "Offline fix" } }).ok).toBe(true);
  });

  it("works with no IndexedDB at all (memory only)", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server, { db: null });
    const r = h.store.dispatch(drinkInput(f));
    expect(r.ok).toBe(true);
    await h.store.flush();
    expect(h.store.getState().pendingCount).toBe(0);
    expect(server.appliedOrder).toHaveLength(1);
  });

  it("isolates a poison op (400) instead of blocking the queue", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const ops: Op[] = [];
    for (let i = 0; i < 5; i++) {
      const r = h.store.dispatch(drinkInput(f));
      if (r.ok) ops.push(r.op);
    }
    server.poisonIds.add(ops[2].id);
    await h.store.flush();
    expect(h.store.getState().pendingCount).toBe(0);
    expect(ops.filter((o) => server.appliedCount(o.id) === 1).map((o) => o.id)).toEqual([ops[0].id, ops[1].id, ops[3].id, ops[4].id]);
    expect(h.store.getState().rejected.map((r) => r.id)).toEqual([ops[2].id]);
  });

  it("treats 5xx/404 on sync as transient and keeps every op", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const r = h.store.dispatch(drinkInput(f));
    if (!r.ok) throw new Error("dispatch failed");
    const realFetch = server.fetch;
    const fetches: FetchLike[] = [
      async () => new Response("<html>Not Found</html>", { status: 404, headers: { "content-type": "text/html" } }),
      async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ];
    for (const fake of fetches) {
      server.fetch = fake;
      (h.store as unknown as { d: { fetch: FetchLike } }).d.fetch = fake;
      await h.store.flush();
      expect(h.store.getState().pendingCount).toBe(1);
      expect(h.store.getState().rejected).toHaveLength(0);
    }
    (h.store as unknown as { d: { fetch: FetchLike } }).d.fetch = realFetch;
    await h.store.flush();
    expect(server.appliedCount(r.op.id)).toBe(1);
  });

  it("photos: local preview while pending, remote URL after the grace period", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server, { config: { previewGraceMs: 10_000 } });
    expect(h.store.photoUrl(null)).toBeNull();
    expect(h.store.photoUrl(undefined)).toBeNull();
    expect(h.store.photoUrl("trips/x/posts/y.jpg")).toBe("https://cdn.test/photos/trips/x/posts/y.jpg");
    const path = await h.store.addPhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "posts");
    expect(h.store.getState().pendingCount).toBe(1);
    const local = h.store.photoUrl(path);
    expect(local).toMatch(/^blob:/);
    expect(h.store.photoUrl(path)).toBe(local); // cached per path
    const r = h.store.dispatch({ type: "post.create", event_id: newTestId(), text: null, photo_path: path });
    expect(r.ok).toBe(true);
    await h.store.flush({ photos: true });
    expect(h.store.getState().pendingCount).toBe(0);
    expect(server.uploads.get(path)).toBeInstanceOf(Blob);
    // Still the local preview right after upload (no flicker)...
    expect(h.store.photoUrl(path)).toBe(local);
    // ...then the remote URL once the grace period passed.
    h.clock.now += 11_000;
    h.store.dispatch(drinkInput(f));
    await h.store.flush({ photos: true });
    expect(h.store.photoUrl(path)).toBe(`https://cdn.test/photos/${path}`);
    expect(h.revoked).toContain(local);
  });

  it("ops never wait for a photo: a score logged after a photo drink syncs while the upload hangs, and the phone stays online", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    server.hangUploads = true;
    const path = await h.store.addPhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "drinks");
    const drink = h.store.dispatch(drinkInput(f, { photo_path: path }));
    const score = h.store.dispatch({ type: "score.set", team_id: f.team.A, hole: 1, strokes: 4 });
    if (!drink.ok || !score.ok) throw new Error("dispatch failed");
    expect(h.store.getState().pendingCount).toBe(3);
    // The debounced passes fire: the upload starts (and hangs), the ops go anyway.
    h.timers.fire(0, 250);
    await until(() => server.appliedCount(score.op.id) === 1);
    expect(server.appliedOrder).toEqual([drink.op.id, score.op.id]);
    expect(server.uploadAttempts).toBe(1);
    expect(server.uploads.has(path)).toBe(false);
    const s = h.store.getState();
    expect(s.online).toBe(true);
    expect(s.syncing).toBe(false);
    expect(s.pendingCount).toBe(1); // just the photo
    expect(s.view!.drinks.find((d) => d.photo_path === path)).toBeDefined();
    // flush() (e.g. before a commissioner import) returns once the ops are in, upload or not.
    await h.store.flush();
    expect(server.uploads.has(path)).toBe(false);
    // Another score while the upload is still out goes on the next debounce, not after the upload.
    const score2 = h.store.dispatch({ type: "score.set", team_id: f.team.A, hole: 1, strokes: 5 });
    if (!score2.ok) throw new Error("dispatch failed");
    h.timers.fire(250, 250);
    await until(() => server.appliedCount(score2.op.id) === 1);
    // The photo lands whenever the uplink manages it.
    server.releaseUploads();
    await until(() => server.uploads.has(path));
    await until(() => h.store.getState().pendingCount === 0);
    expect(server.events.indexOf(`upload:${path}`)).toBeGreaterThan(server.events.indexOf(`op:${score2.op.id}`));
  });

  it("a failing photo upload retries with its own backoff and never marks the phone offline", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const path = await h.store.addPhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "drinks");
    const before = h.store.dispatch(drinkInput(f));
    const withPhoto = h.store.dispatch(drinkInput(f, { photo_path: path }));
    if (!withPhoto.ok) throw new Error("dispatch failed");
    const undo = h.store.dispatch({ type: "drink.delete", drink_id: (withPhoto.op as Extract<Op, { type: "drink.log" }>).drink_id });
    const after = h.store.dispatch({ type: "score.set", team_id: f.team.A, hole: 1, strokes: 4 });
    if (!before.ok || !undo.ok || !after.ok) throw new Error("dispatch failed");
    server.failUpload = 100;
    await h.store.flush({ photos: true });
    // Every op went, in order (the undo never overtakes its drink); only the photo waits.
    expect(server.appliedOrder).toEqual([before.op.id, withPhoto.op.id, undo.op.id, after.op.id]);
    expect(h.store.getState().online).toBe(true);
    expect(h.store.getState().pendingCount).toBe(1);
    expect(h.store.getState().rejected).toEqual([]);
    expect(h.timers.delays()).toContain(1000); // the upload lane's first backoff retry
    await h.store.flush({ photos: true });
    await h.store.flush({ photos: true });
    expect(h.store.getState().online).toBe(true);
    server.failUpload = 0;
    await h.store.flush({ photos: true });
    expect(server.uploads.has(path)).toBe(true);
    expect(h.store.getState().pendingCount).toBe(0);
  });

  it("scores dispatched before and after a photo post both go without waiting for the upload", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    const score = h.store.dispatch({ type: "score.set", team_id: f.team.A, hole: 1, strokes: 4 });
    const path = await h.store.addPhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "posts");
    const post = h.store.dispatch({ type: "post.create", event_id: newTestId(), text: "look", photo_path: path });
    const score2 = h.store.dispatch({ type: "score.set", team_id: f.team.A, hole: 2, strokes: 3 });
    if (!score.ok || !post.ok || !score2.ok) throw new Error("dispatch failed");
    server.hangUploads = true;
    h.timers.fire(0, 250);
    await until(() => server.appliedCount(score2.op.id) === 1);
    expect(server.appliedOrder).toEqual([score.op.id, post.op.id, score2.op.id]);
    expect(server.uploads.has(path)).toBe(false);
    server.releaseUploads();
    await until(() => h.store.getState().pendingCount === 0);
  });

  it("interval polls keep running while only a photo upload is in flight", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    let poll: (() => unknown) | null = null;
    const h = await started(server, {
      realtime: (opts) => {
        poll = opts.poll ?? null;
        return { setConfig: () => undefined, poke: () => undefined, connected: false, stop: () => undefined };
      },
    });
    server.hangUploads = true;
    await h.store.addPhoto(new Blob(["jpeg"], { type: "image/jpeg" }), "drinks");
    h.timers.fire(0, 250);
    await until(() => server.uploadAttempts === 1);
    const statesBefore = server.requests.filter((r) => r.path.endsWith("/state")).length;
    await (poll as unknown as () => Promise<void> | undefined)();
    expect(server.requests.filter((r) => r.path.endsWith("/state")).length).toBe(statesBefore + 1);
    server.releaseUploads();
    await until(() => h.store.getState().pendingCount === 0);
  });

  it("undoing a photo drink before it synced drops its queued photo too (unless something else uses it)", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const dbName = `scramble-undo-photo-${Date.now()}`;
    const h = await started(server, { dbName });
    // A synced drink whose photo is still queued (its first upload attempt failed).
    const shared = await h.store.addPhoto(new Blob(["jpeg1"], { type: "image/jpeg" }), "drinks");
    const synced = h.store.dispatch(drinkInput(f, { photo_path: shared }));
    if (!synced.ok) throw new Error("dispatch failed");
    server.failUpload = 1;
    await h.store.flush({ photos: true });
    expect(server.appliedCount(synced.op.id)).toBe(1);
    expect(h.store.getState().pendingCount).toBe(1);
    // Undoing another op that carries the same photo keeps it: the synced drink still needs it.
    const again = h.store.dispatch(drinkInput(f, { photo_path: shared }));
    if (!again.ok) throw new Error("dispatch failed");
    expect(await h.store.cancelPending(again.op.id)).toBe(true);
    expect(h.store.getState().pendingCount).toBe(1);
    // Undoing a fresh photo drink drops its photo: no upload, no preview, nothing left on disk.
    const own = await h.store.addPhoto(new Blob(["jpeg2"], { type: "image/jpeg" }), "drinks");
    const preview = h.store.photoUrl(own);
    expect(preview).toMatch(/^blob:/);
    const r = h.store.dispatch(drinkInput(f, { photo_path: own }));
    if (!r.ok) throw new Error("dispatch failed");
    await h.store.settled();
    expect(h.store.getState().pendingCount).toBe(3);
    expect(await h.store.cancelPending(r.op.id)).toBe(true);
    expect(h.store.getState().pendingCount).toBe(1);
    expect(h.revoked).toContain(preview);
    expect(h.store.photoUrl(own)).toBe(`https://cdn.test/photos/${own}`);
    await h.store.settled();
    const db = new ScrambleDB(dbName);
    expect((await db.blobs.where("code").equals(CODE).toArray()).map((b) => b.path)).toEqual([shared]);
    db.close();
    await h.store.flush({ photos: true });
    expect(server.uploads.has(shared)).toBe(true);
    expect(server.uploads.has(own)).toBe(false);
    expect(h.store.getState().pendingCount).toBe(0);
  });

  it("identity: setMe persists per trip and notifies", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const storage = new MemStorage();
    const h = await started(server, { storage });
    let n = 0;
    h.store.subscribe(() => n++);
    h.store.setMe(f.player.B2);
    expect(n).toBe(1);
    expect(h.store.getState().meId).toBe(f.player.B2);
    expect(storage.getItem(`scramble:me:${CODE}`)).toBe(f.player.B2);
    expect(storage.getItem("scramble:last-trip")).toBe(CODE);
    const h2 = await started(server, { storage });
    expect(h2.store.getState().meId).toBe(f.player.B2);
    h2.store.setMe(null);
    expect(storage.getItem(`scramble:me:${CODE}`)).toBeNull();
  });

  it("commissioner: checked on start, unlock/lock round-trip, gates commissioner ops", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const h = await started(server);
    expect(h.store.getState().isCommissioner).toBe(false);
    expect(await h.store.unlockCommissioner("0000")).toBe(false);
    expect(h.store.getState().isCommissioner).toBe(false);
    expect(await h.store.unlockCommissioner("2468")).toBe(true);
    expect(h.store.getState().isCommissioner).toBe(true);
    const r = h.store.dispatch({ type: "trip.update", patch: { name: "Commish edit" } });
    expect(r.ok).toBe(true);
    expect(h.store.getState().view!.trip.name).toBe("Commish edit");
    await h.store.flush();
    expect(server.state.trip.name).toBe("Commish edit");
    await h.store.lockCommissioner();
    expect(h.store.getState().isCommissioner).toBe(false);
    expect(server.isCommissioner).toBe(false);
  });

  it("unknown trip with nothing cached -> loadError; offline with nothing cached -> retryable loadError", async () => {
    const server = new FakeServer(makeTrip({ teams: [2, 2] }).state);
    const h = makeStore(server);
    const s404 = new TripStore("nope", {
      fetch: server.fetch,
      db: null,
      realtime: null,
      win: null,
      doc: null,
      storage: new MemStorage(),
      applyOp: simpleApply,
      derive: simpleDerive,
    });
    stores.push(s404);
    s404.start();
    await until(() => s404.getState().loadError !== null);
    expect(s404.getState().loaded).toBe(false);
    expect(s404.getState().loadError).toMatch(/No trip/);

    server.online = false;
    h.store.start();
    await until(() => h.store.getState().loadError !== null);
    expect(h.store.getState().online).toBe(false);
    server.online = true;
    await h.store.refresh();
    expect(h.store.getState().loaded).toBe(true);
    expect(h.store.getState().loadError).toBeNull();
  });

  it("sends a keepalive flush when the page is hidden", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const listeners = new Map<string, Set<() => void>>();
    const doc = {
      visibilityState: "visible" as string,
      addEventListener: (t: string, l: () => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)!.add(l);
      },
      removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    };
    const h = await started(server, { doc });
    const r = h.store.dispatch(drinkInput(f));
    if (!r.ok) throw new Error("dispatch failed");
    doc.visibilityState = "hidden";
    for (const l of listeners.get("visibilitychange") ?? []) l();
    await until(() => h.store.getState().pendingCount === 0);
    expect(server.requests.find((q) => q.path.endsWith("/sync"))?.keepalive).toBe(true);
    expect(server.appliedCount(r.op.id)).toBe(1);
    h.store.stop();
    expect(listeners.get("visibilitychange")?.size ?? 0).toBe(0);
  });

  it("feeds meta.realtime to the live-update controller and stops it", async () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state);
    const configs: unknown[] = [];
    let stopped = 0;
    let refresh: (() => unknown) | null = null;
    const h = await started(server, {
      realtime: (opts) => {
        refresh = opts.refresh;
        return { setConfig: (c) => void configs.push(c), poke: () => undefined, connected: false, stop: () => void stopped++ };
      },
    });
    expect(configs.length).toBeGreaterThan(0);
    expect(configs[configs.length - 1]).toBeNull();
    server.state = { ...server.state, trip: { ...server.state.trip, name: "Live" } };
    await (refresh as unknown as () => Promise<void>)();
    expect(h.store.getState().view!.trip.name).toBe("Live");
    h.store.stop();
    expect(stopped).toBe(1);
  });
});

describe("TripStore clock correction", () => {
  it("stamps ops with server-corrected time when this phone's clock is minutes off", async () => {
    const f = makeTrip({ teams: [2, 2] });
    const server = new FakeServer(f.state);
    const h = makeStore(server);
    h.clock.now = server.time - 10 * 60_000; // phone 10 minutes slow
    h.store.start();
    await until(() => h.store.getState().loaded);
    await h.store.refresh();
    h.store.setMe(f.player.A1);
    const r = h.store.dispatch(drinkInput(f));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const skew = Date.parse(r.op.at) - server.time;
    expect(Math.abs(skew)).toBeLessThan(5_000);
  });
});

// ----------------------------------------------------------------------------- real reducer + engine

async function realModules() {
  const reducer = await import("@/lib/reducer");
  const engine = await import("@/lib/engine");
  const ids = await import("@/lib/ids");
  const probe = makeTrip({ teams: [2, 2] });
  try {
    reducer.applyOp(probe.state, { type: "tee.open", id: "probe", at: probe.state.trip.created_at, by: null, team_id: probe.team.A, hole: 1 }, { now: probe.state.trip.created_at, is_commissioner: false, side: "client" });
    engine.derive(probe.state);
    ids.newId();
  } catch (e) {
    if (String((e as Error)?.message).includes("not implemented")) return null;
    throw e;
  }
  return { applyOp: reducer.applyOp, derive: engine.derive, newId: ids.newId };
}

describe("TripStore with the real reducer and engine", () => {
  it("offline round: tee off, drinks, scores; reconnect; server and client agree", async (ctx) => {
    const real = await realModules();
    if (!real) {
      ctx.skip("src/lib/reducer.ts / engine still throw 'not implemented'");
      return;
    }
    const f = makeTrip({ teams: [4, 3, 3] });
    const server = new FakeServer(f.state, real.applyOp);
    const h = await started(server, { applyOp: real.applyOp, derive: (s) => real.derive(s), newId: real.newId });
    h.store.setMe(f.player.A1);
    server.online = false;
    const inputs: OpInput[] = [
      { type: "tee.open", team_id: f.team.A, hole: 1 },
      { type: "drink.log", drink_id: real.newId(), team_id: f.team.A, player_id: f.player.A1, hole: 1, drink_type: "drink", photo_path: null },
      { type: "drink.log", drink_id: real.newId(), team_id: f.team.A, player_id: f.player.A2, hole: 1, drink_type: "shotgun", photo_path: null },
      { type: "score.set", team_id: f.team.A, hole: 1, strokes: 4 },
      { type: "teeshot.set", team_id: f.team.A, hole: 1, player_id: f.player.A3 },
      { type: "score.set", team_id: f.team.A, hole: 2, strokes: 5 },
    ];
    for (const input of inputs) {
      h.tick();
      const r = h.store.dispatch(input);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    }
    // Drink with no open window is refused on the client by the real reducer.
    const noWindow = h.store.dispatch({ type: "drink.log", drink_id: real.newId(), team_id: f.team.B, player_id: f.player.B1, hole: 1, drink_type: "drink", photo_path: null });
    expect(noWindow).toMatchObject({ ok: false, code: "no_window" });

    const before = h.store.getState().derived!;
    const rowA = before.standings.find((r) => r.team_id === f.team.A)!;
    expect(rowA.thru).toBe(2);
    expect(rowA.gross).toBe(9);
    expect(rowA.drinks).toBe(2);
    expect(h.store.getState().pendingCount).toBe(inputs.length);

    server.online = true;
    await h.store.flush();
    expect(h.store.getState().pendingCount).toBe(0);
    expect(h.store.getState().rejected).toEqual([]);
    const after = h.store.getState().derived!;
    const rowA2 = after.standings.find((r) => r.team_id === f.team.A)!;
    expect(rowA2.gross).toBe(9);
    expect(rowA2.drinks).toBe(2);
    expect(rowA2.net).toBe(rowA.net);
    // The server's state is exactly the client's view now.
    expect(h.store.getState().view).toEqual(server.state);
  });

  it("a queued drink stays in the view when another phone completes the round before this one syncs", async (ctx) => {
    const real = await realModules();
    if (!real) {
      ctx.skip("src/lib/reducer.ts / engine still throw 'not implemented'");
      return;
    }
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 18);
    const server = new FakeServer(f.state, real.applyOp);
    const h = await started(server, { applyOp: real.applyOp, derive: (s) => real.derive(s), newId: real.newId });
    h.store.setMe(f.player.A1);
    server.online = false;
    h.tick();
    const drinkId = real.newId();
    const r = h.store.dispatch({ type: "drink.log", drink_id: drinkId, team_id: f.team.A, player_id: f.player.A1, hole: 18, drink_type: "drink", photo_path: null });
    expect(r).toMatchObject({ ok: true });
    // Meanwhile a teammate's phone taps "Round complete" and the server has it.
    const done = real.applyOp(
      server.state,
      // (after this phone's drink: a drink logged after completion + 2 min is refused by design)
      { type: "round.complete", id: real.newId(), at: new Date(h.clock.now + 1000).toISOString(), by: f.player.A2, team_id: f.team.A },
      { now: new Date(server.time).toISOString(), is_commissioner: false, side: "server" },
    );
    if (!done.ok) throw new Error(done.reason);
    server.state = done.state;
    // This phone's own sync is stuck in flight; it only sees the fresh snapshot.
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    server.online = true;
    void h.store.flush();
    await h.store.refresh();
    const view = h.store.getState().view!;
    expect(view.team_round_state.find((s) => s.team_id === f.team.A)!.status).toBe("complete");
    expect(view.drinks.some((d) => d.id === drinkId)).toBe(true);
    server.gate = null;
    release();
    await until(() => h.store.getState().pendingCount === 0);
    expect(server.state.drinks.some((d) => d.id === drinkId && d.hole === 18)).toBe(true);
  });
});
