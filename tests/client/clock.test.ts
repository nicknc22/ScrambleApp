import { describe, expect, it } from "vitest";
import { CLOCK_KEY, MAX_RTT_MS, MIN_CORRECTION_MS, ServerClock } from "@/lib/client/clock";
import type { StorageLike } from "@/lib/client/identity";

class MemStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const SERVER = Date.parse("2026-10-24T17:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("ServerClock", () => {
  it("leaves a normal phone alone (small offsets are noise)", () => {
    const c = new ServerClock(new MemStorage());
    c.observe(iso(SERVER), SERVER - 4_000, SERVER + 2_000); // 1 s off, 6 s round trip
    expect(c.offsetMs).toBe(0);
    expect(c.now(SERVER)).toBe(SERVER);
  });

  it("corrects a phone whose clock is minutes off, using the round trip's midpoint", () => {
    const store = new MemStorage();
    const c = new ServerClock(store);
    const local = SERVER - 7 * 60_000; // phone is 7 min slow
    c.observe(iso(SERVER), local - 200, local + 200);
    expect(c.offsetMs).toBe(7 * 60_000);
    expect(c.now(local)).toBe(SERVER);
    expect(store.getItem(CLOCK_KEY)).toBe(String(7 * 60_000));
  });

  it("uses the median so one weird response doesn't swing it, and ignores slow round trips", () => {
    const c = new ServerClock(new MemStorage());
    const off = -5 * 60_000; // phone 5 min fast
    for (let i = 0; i < 4; i++) c.observe(iso(SERVER + i * 1000), SERVER + i * 1000 - off, SERVER + i * 1000 - off);
    c.observe(iso(SERVER), SERVER + 3 * 3600_000, SERVER + 3 * 3600_000); // outlier
    expect(c.offsetMs).toBe(off);
    c.observe(iso(SERVER), SERVER, SERVER + MAX_RTT_MS + 1); // too slow to trust
    expect(c.offsetMs).toBe(off);
  });

  it("remembers the correction across restarts (offline launch) and drops it once the phone is fixed", () => {
    const store = new MemStorage();
    const first = new ServerClock(store);
    first.observe(iso(SERVER), SERVER - 120_000, SERVER - 120_000);
    const relaunched = new ServerClock(store);
    expect(relaunched.offsetMs).toBe(120_000);
    for (let i = 0; i < 7; i++) relaunched.observe(iso(SERVER), SERVER, SERVER); // clock fixed
    expect(relaunched.offsetMs).toBe(0);
    expect(store.getItem(CLOCK_KEY)).toBeNull();
    expect(MIN_CORRECTION_MS).toBeGreaterThanOrEqual(30_000);
  });
});
