import { describe, expect, it } from "vitest";
import { startLiveUpdates, type RealtimeConfig, type RealtimeConnector } from "@/lib/client/realtime";
import type { Timers } from "@/lib/client/sync";

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
  delays() {
    return [...this.q.values()].map((t) => t.ms).sort((a, b) => a - b);
  }
  fire(ms: number): number {
    let n = 0;
    for (const [id, t] of [...this.q]) {
      if (t.ms === ms) {
        this.q.delete(id);
        t.fn();
        n++;
      }
    }
    return n;
  }
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

const CFG: RealtimeConfig = { url: "https://x.supabase.co", anon_key: "anon", topic: "trip:abc" };

function setup() {
  const timers = new ManualTimers();
  const win = new FakeTarget();
  const doc = new FakeTarget();
  let refreshes = 0;
  const connects: Array<{ cfg: RealtimeConfig; onChanged: () => void; onStatus?: (s: string) => void; disconnected: boolean }> = [];
  const connect: RealtimeConnector = async (cfg, onChanged, onStatus) => {
    const c = { cfg, onChanged, onStatus, disconnected: false };
    connects.push(c);
    return () => {
      c.disconnected = true;
    };
  };
  const live = startLiveUpdates({ refresh: () => void refreshes++, timers, win, doc, connect });
  return { timers, win, doc, live, connects, refreshes: () => refreshes };
}

describe("live updates", () => {
  it("polls every 3 s without Realtime, every 20 s with it", async () => {
    const t = setup();
    expect(t.timers.delays()).toEqual([3000]);
    t.timers.fire(3000);
    expect(t.refreshes()).toBe(1);
    expect(t.timers.delays()).toEqual([3000]);
    t.live.setConfig(null);
    expect(t.connects).toHaveLength(0);
    t.live.setConfig(CFG);
    await Promise.resolve();
    expect(t.connects).toHaveLength(1);
    expect(t.timers.delays()).toEqual([20_000]);
    t.timers.fire(20_000);
    expect(t.refreshes()).toBe(2);
    t.live.stop();
  });

  it("debounces 'changed' broadcasts (400 ms) and refetches on subscribe", async () => {
    const t = setup();
    t.live.setConfig(CFG);
    await Promise.resolve();
    const c = t.connects[0];
    c.onChanged();
    c.onChanged();
    c.onChanged();
    expect(t.timers.delays()).toEqual([400, 20_000]);
    t.timers.fire(400);
    expect(t.refreshes()).toBe(1);
    c.onStatus?.("SUBSCRIBED");
    expect(t.live.connected).toBe(true);
    t.timers.fire(0);
    expect(t.refreshes()).toBe(2);
    t.live.stop();
  });

  it("does not reconnect for the same config; reconnects when it changes", async () => {
    const t = setup();
    t.live.setConfig(CFG);
    t.live.setConfig({ ...CFG });
    await Promise.resolve();
    expect(t.connects).toHaveLength(1);
    t.live.setConfig({ ...CFG, topic: "trip:other" });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.connects).toHaveLength(2);
    expect(t.connects[0].disconnected).toBe(true);
    t.live.stop();
    expect(t.connects[1].disconnected).toBe(true);
  });

  it("refetches on focus, online and becoming visible; skips polls while hidden", () => {
    const t = setup();
    t.win.emit("focus");
    t.timers.fire(50);
    expect(t.refreshes()).toBe(1);
    t.win.emit("online");
    t.timers.fire(50);
    expect(t.refreshes()).toBe(2);
    t.doc.visibilityState = "hidden";
    t.timers.fire(3000);
    expect(t.refreshes()).toBe(2);
    t.doc.visibilityState = "visible";
    t.doc.emit("visibilitychange");
    t.timers.fire(50);
    expect(t.refreshes()).toBe(3);
    t.live.stop();
  });

  it("interval ticks use poll() when given; explicit triggers use refresh()", () => {
    const timers = new ManualTimers();
    const win = new FakeTarget();
    const calls: string[] = [];
    const live = startLiveUpdates({
      refresh: () => void calls.push("refresh"),
      poll: () => void calls.push("poll"),
      timers,
      win,
      doc: null,
      connect: async () => () => undefined,
    });
    timers.fire(3000);
    win.emit("focus");
    timers.fire(50);
    expect(calls).toEqual(["poll", "refresh"]);
    live.stop();
  });

  it("survives a connector that fails (offline first load) and cleans up on stop", async () => {
    const timers = new ManualTimers();
    const win = new FakeTarget();
    const doc = new FakeTarget();
    const live = startLiveUpdates({
      refresh: () => undefined,
      timers,
      win,
      doc,
      connect: async () => {
        throw new Error("chunk load failed");
      },
    });
    live.setConfig(CFG);
    await new Promise((r) => setTimeout(r, 5));
    expect(live.connected).toBe(false);
    expect(timers.delays()).toEqual([20_000]);
    live.stop();
    expect(timers.q.size).toBe(0);
    expect(win.count() + doc.count()).toBe(0);
  });

  it("a connect that resolves after stop is disconnected immediately", async () => {
    const timers = new ManualTimers();
    let resolveConnect!: (fn: () => void) => void;
    let disconnected = false;
    const live = startLiveUpdates({
      refresh: () => undefined,
      timers,
      win: null,
      doc: null,
      connect: () => new Promise((r) => (resolveConnect = r)),
    });
    live.setConfig(CFG);
    live.stop();
    resolveConnect(() => (disconnected = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(disconnected).toBe(true);
  });
});
