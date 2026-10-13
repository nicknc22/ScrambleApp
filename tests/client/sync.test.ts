import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  flushOutbox,
  httpRequest,
  SyncWorker,
  uploadPhotos,
  type FlushResult,
  type PendingBlob,
  type PendingOp,
  type SyncHost,
  type Timers,
  type UploadHost,
} from "@/lib/client/sync";
import type { Op } from "@/lib/ops";

class ManualTimers implements Timers {
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
  fireAll(): void {
    for (const [id, t] of [...this.q]) {
      this.q.delete(id);
      t.fn();
    }
  }
}

const op = (id: string, photo?: string): PendingOp => ({
  id,
  seq: Number(id.replace(/\D/g, "")) || 0,
  op: { type: "tee.open", id, at: "2026-10-24T17:00:00.000Z", by: null, team_id: "t", hole: 1 } as Op,
  photo_paths: photo ? [photo] : [],
  attempts: 0,
  last_error: null,
});
const blob = (path: string, failures = 0): PendingBlob => ({
  path,
  blob: new Blob(["x"]),
  failures,
  permanentFailures: 0,
  created_at: "2026-10-24T17:00:00.000Z",
});

describe("backoffDelay", () => {
  it("is exponential from 1 s, jittered, and capped at 30 s", () => {
    for (let n = 1; n <= 20; n++) {
      for (const r of [0, 0.25, 0.5, 0.999, 1]) {
        const d = backoffDelay(n, () => r);
        expect(d).toBeGreaterThanOrEqual(1000);
        expect(d).toBeLessThanOrEqual(30_000);
      }
    }
    expect(backoffDelay(1, () => 0)).toBe(1000);
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 0)).toBe(2000);
    expect(backoffDelay(3, () => 1)).toBe(4000);
    expect(backoffDelay(10, () => 0)).toBe(15_000);
    expect(backoffDelay(10, () => 1)).toBe(30_000);
  });
});

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("photos never block ops", () => {
  it("flushOutbox sends every op in seq order, photo ops included, without touching uploads", async () => {
    const ops = [op("o1"), op("o2", "p1"), op("o3"), op("o4", "p2")];
    const sent: string[][] = [];
    const urls: string[] = [];
    const host: SyncHost = {
      code: "c",
      fetch: async (url, init) => {
        urls.push(url);
        const ids = (JSON.parse(String(init?.body)) as { ops: Array<{ id: string }> }).ops.map((o) => o.id);
        sent.push(ids);
        return jsonRes({ results: ids.map((id) => ({ id, status: "applied" })), snapshot: null });
      },
      timers: new ManualTimers(),
      ready: async () => undefined,
      pendingOps: () => ops,
      hasPending: () => true,
      onSending: () => undefined,
      onSendFailed: () => undefined,
      onResults: () => undefined,
      onPoisonOp: () => undefined,
      onNetwork: () => undefined,
      setSyncing: () => undefined,
    };
    const r = await flushOutbox(host);
    expect(r).toMatchObject({ failed: false, acked: 4, uploaded: 0 });
    expect(sent).toEqual([["o1", "o2", "o3", "o4"]]);
    expect(urls.every((u) => u.endsWith("/sync"))).toBe(true);
  });

  it("uploadPhotos retries later on failure but never reports the network as down", async () => {
    const blobs = [blob("p1"), blob("p2")];
    const events: string[] = [];
    let fail = true;
    const host: UploadHost = {
      code: "c",
      fetch: async (url) => {
        const path = new URL(url, "http://x").searchParams.get("path")!;
        events.push(`upload:${path}`);
        if (fail) throw new TypeError("Failed to fetch");
        return jsonRes({ path });
      },
      timers: new ManualTimers(),
      ready: async () => undefined,
      pendingBlobs: () => blobs,
      hasPending: () => blobs.length > 0,
      onUploaded: (path) => void events.push(`ok:${path}`),
      onUploadFailed: (path, permanent) => void events.push(`fail:${path}:${permanent}`),
    };
    const r1 = await uploadPhotos(host);
    expect(r1).toMatchObject({ failed: true, uploaded: 0, error: "Failed to fetch" });
    // The rest would fail too: one attempt per pass.
    expect(events).toEqual(["upload:p1", "fail:p1:false"]);
    fail = false;
    events.length = 0;
    const r2 = await uploadPhotos(host);
    expect(r2).toMatchObject({ failed: false, uploaded: 2 });
    expect(events).toEqual(["upload:p1", "ok:p1", "upload:p2", "ok:p2"]);
  });

  it("a permanent refusal (413) is reported as such and the pass moves on", async () => {
    const events: string[] = [];
    const host: UploadHost = {
      code: "c",
      fetch: async (url) => {
        const path = new URL(url, "http://x").searchParams.get("path")!;
        return path === "big" ? jsonRes({ error: "Too big" }, 413) : jsonRes({ path });
      },
      timers: new ManualTimers(),
      ready: async () => undefined,
      pendingBlobs: () => [blob("big"), blob("ok")],
      hasPending: () => true,
      onUploaded: (path) => void events.push(`ok:${path}`),
      onUploadFailed: (path, permanent, message) => void events.push(`fail:${path}:${permanent}:${message}`),
    };
    expect(await uploadPhotos(host)).toMatchObject({ failed: false, uploaded: 1 });
    expect(events).toEqual(["fail:big:true:Too big", "ok:ok"]);
  });
});

describe("httpRequest", () => {
  it("returns network on fetch rejection", async () => {
    const r = await httpRequest(async () => {
      throw new TypeError("Failed to fetch");
    }, "/x", {});
    expect(r).toEqual({ kind: "network", error: "Failed to fetch" });
  });

  it("times out a request that never answers (and aborts it)", async () => {
    const timers = new ManualTimers();
    let aborted = false;
    const p = httpRequest(
      (_u, init) =>
        new Promise<Response>(() => {
          init?.signal?.addEventListener("abort", () => (aborted = true));
        }),
      "/x",
      { timeoutMs: 15_000 },
      timers,
    );
    await Promise.resolve();
    timers.fireAll();
    expect(await p).toEqual({ kind: "network", error: "timeout" });
    expect(aborted).toBe(true);
  });

  it("times out a body that stalls after the headers arrived", async () => {
    const timers = new ManualTimers();
    const stalled = new ReadableStream({ start() {} });
    const p = httpRequest(async () => new Response(stalled, { status: 200 }), "/x", {}, timers);
    await new Promise((r) => setTimeout(r, 5));
    timers.fireAll();
    expect(await p).toMatchObject({ kind: "network", error: "timeout" });
  });

  it("parses JSON and reports status", async () => {
    const r = await httpRequest(
      async () => new Response(JSON.stringify({ a: 1 }), { status: 422, headers: { "content-type": "application/json" } }),
      "/x",
      {},
    );
    expect(r).toMatchObject({ kind: "http", status: 422, ok: false, json: { a: 1 } });
  });
});

function fakeHost(over: Partial<SyncHost> = {}) {
  const calls: string[] = [];
  let pending = 1;
  const host: SyncHost = {
    code: "c",
    fetch: async () => {
      calls.push("fetch");
      pending = 0;
      return new Response(JSON.stringify({ results: [], snapshot: null }), { status: 200, headers: { "content-type": "application/json" } });
    },
    timers: new ManualTimers(),
    ready: async () => undefined,
    pendingOps: () => (pending ? [op("o1")] : []),
    hasPending: () => pending > 0,
    onSending: () => undefined,
    onSendFailed: () => undefined,
    onResults: () => undefined,
    onPoisonOp: () => undefined,
    onNetwork: () => undefined,
    setSyncing: (on) => void calls.push(on ? "syncing" : "idle"),
    ...over,
  };
  return { host, calls, setPending: (n: number) => (pending = n) };
}

class FakeTarget {
  listeners = new Map<string, Set<() => void>>();
  visibilityState = "visible";
  addEventListener(t: string, l: () => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set());
    this.listeners.get(t)!.add(l);
  }
  removeEventListener(t: string, l: () => void) {
    this.listeners.get(t)?.delete(l);
  }
  emit(t: string) {
    for (const l of [...(this.listeners.get(t) ?? [])]) l();
  }
  count() {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

describe("SyncWorker", () => {
  it("flushes on the window 'online' event and on becoming visible; detaches on stop", async () => {
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const timers = new ManualTimers();
    const { host, calls, setPending } = fakeHost({ timers });
    const passes: FlushResult[] = [];
    const w = new SyncWorker(host, { run: (o) => flushOutbox(host, o), timers, win, doc, onPass: (r) => passes.push(r) });
    w.start();
    expect(win.count() + doc.count()).toBe(2);
    win.emit("online");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => c === "fetch")).toHaveLength(1);
    setPending(1);
    doc.emit("visibilitychange");
    await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => c === "fetch")).toHaveLength(2);
    expect(passes.every((p) => !p.failed)).toBe(true);
    w.stop();
    expect(win.count() + doc.count()).toBe(0);
  });

  it("is single-flight and debounces schedule()", async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    let fetches = 0;
    const { host } = fakeHost({
      timers,
      fetch: async () => {
        fetches++;
        await new Promise<void>((r) => (release = r));
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      hasPending: () => fetches < 2,
    });
    const w = new SyncWorker(host, { run: (o) => flushOutbox(host, o), timers, win: null, doc: null });
    w.start();
    w.schedule();
    w.schedule();
    expect(timers.q.size).toBe(1); // start()'s kick; both schedule() calls coalesce into it
    const a = w.flush();
    const b = w.flush();
    expect(a).toBe(b);
    await new Promise((r) => setTimeout(r, 5));
    expect(fetches).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 5));
    // The re-run requested by the second flush() happens right after.
    expect(fetches).toBe(2);
    release();
    await a;
    w.stop();
  });

  it("keeps an interval going while anything is pending", async () => {
    const timers = new ManualTimers();
    const { host } = fakeHost({
      timers,
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    const w = new SyncWorker(host, { run: (o) => flushOutbox(host, o), timers, win: null, doc: null, intervalMs: 15_000, random: () => 0 });
    w.start();
    await w.flush();
    const delays = [...timers.q.values()].map((t) => t.ms);
    expect(delays).toContain(15_000);
    expect(delays).toContain(1000);
    expect(w.failures).toBe(1);
    w.stop();
    expect(timers.q.size).toBe(0);
  });

  it("only a worker with keepaliveOnHide fires a keepalive pass when the page is hidden", async () => {
    const doc = new FakeTarget();
    const timers = new ManualTimers();
    const runs: Array<{ worker: string; keepalive: boolean }> = [];
    const host = { hasPending: () => true };
    const ops = new SyncWorker(host, {
      run: async (o) => {
        runs.push({ worker: "ops", keepalive: !!o.keepalive });
        return { failed: false, uploaded: 0, acked: 1, error: null };
      },
      keepaliveOnHide: true,
      timers,
      win: null,
      doc,
    });
    const photos = new SyncWorker(host, {
      run: async (o) => {
        runs.push({ worker: "photos", keepalive: !!o.keepalive });
        return { failed: false, uploaded: 1, acked: 0, error: null };
      },
      timers,
      win: null,
      doc,
    });
    ops.start();
    photos.start();
    doc.visibilityState = "hidden";
    doc.emit("visibilitychange");
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toEqual([{ worker: "ops", keepalive: true }]);
    ops.stop();
    photos.stop();
  });
});
