import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeoError,
  getGpsSimulation,
  GPS_SIM_KEY,
  measurePosition,
  primeLocationPermission,
  sampleBestPosition,
  setGpsSimulation,
  type GeolocationLike,
} from "@/lib/client/geo";
import type { StorageLike } from "@/lib/client/identity";

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

class FakeGeo implements GeolocationLike {
  success: ((p: GeolocationPosition) => void) | null = null;
  error: ((e: GeolocationPositionError) => void) | null = null;
  options: PositionOptions | undefined;
  cleared: number[] = [];
  watchPosition(s: (p: GeolocationPosition) => void, e?: ((e: GeolocationPositionError) => void) | null, o?: PositionOptions) {
    this.success = s;
    this.error = e ?? null;
    this.options = o;
    return 7;
  }
  clearWatch(id: number) {
    this.cleared.push(id);
  }
  getCurrentPosition(s: (p: GeolocationPosition) => void, e?: ((e: GeolocationPositionError) => void) | null, o?: PositionOptions) {
    this.success = s;
    this.error = e ?? null;
    this.options = o;
  }
  emit(lat: number, lng: number, accuracy: number) {
    this.success?.({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: Date.now() } as unknown as GeolocationPosition);
  }
  fail(code: number) {
    this.error?.({ code, message: "x", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sampleBestPosition", () => {
  it("watches high-accuracy GPS and keeps the most accurate reading for durationMs", async () => {
    const geo = new FakeGeo();
    const progress: number[] = [];
    const p = sampleBestPosition({ geolocation: geo, storage: null, onProgress: (b) => progress.push(b.accuracy) });
    expect(geo.options).toMatchObject({ enableHighAccuracy: true, maximumAge: 0 });
    geo.emit(41.1, -75.5, 30);
    vi.advanceTimersByTime(1000);
    geo.emit(41.2, -75.6, 12);
    geo.emit(41.3, -75.7, 20);
    vi.advanceTimersByTime(4000);
    const r = await p;
    expect(r).toMatchObject({ lat: 41.2, lng: -75.6, accuracy: 12 });
    expect(progress).toEqual([30, 12]);
    expect(geo.cleared).toEqual([7]);
  });

  it("resolves early once accuracy <= 5 m", async () => {
    const geo = new FakeGeo();
    const p = sampleBestPosition({ geolocation: geo, storage: null });
    geo.emit(41, -75, 4);
    const r = await p;
    expect(r.accuracy).toBe(4);
    expect(geo.cleared).toEqual([7]);
  });

  it("resolves with the first reading that arrives after the sampling window", async () => {
    const geo = new FakeGeo();
    const p = sampleBestPosition({ geolocation: geo, storage: null, durationMs: 5000, timeoutMs: 10000 });
    vi.advanceTimersByTime(7000);
    geo.emit(41, -75, 25);
    expect((await p).accuracy).toBe(25);
  });

  it("rejects permission denied immediately with a typed error", async () => {
    const geo = new FakeGeo();
    const p = sampleBestPosition({ geolocation: geo, storage: null });
    geo.fail(1);
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(GeoError);
    expect(err.code).toBe("permission_denied");
    expect(geo.cleared).toEqual([7]);
  });

  it("rejects timeout / unavailable when no reading arrives", async () => {
    const geo = new FakeGeo();
    const p = sampleBestPosition({ geolocation: geo, storage: null });
    vi.advanceTimersByTime(10_000);
    expect((await p.catch((e) => e)).code).toBe("timeout");

    const geo2 = new FakeGeo();
    const p2 = sampleBestPosition({ geolocation: geo2, storage: null });
    geo2.fail(2);
    vi.advanceTimersByTime(10_000);
    expect((await p2.catch((e) => e)).code).toBe("unavailable");
  });

  it("a weak-signal error after a reading still resolves with that reading", async () => {
    const geo = new FakeGeo();
    const p = sampleBestPosition({ geolocation: geo, storage: null });
    geo.emit(41, -75, 15);
    geo.fail(3);
    vi.advanceTimersByTime(5000);
    expect((await p).accuracy).toBe(15);
  });

  it("unsupported without geolocation", async () => {
    const err = await sampleBestPosition({ geolocation: null, storage: null }).catch((e) => e);
    expect(err.code).toBe("unsupported");
  });

  it("uses the GPS simulator when set", async () => {
    const storage = new MemStorage();
    setGpsSimulation({ lat: 41.0567, lng: -75.6789, accuracy: 4 }, storage);
    expect(getGpsSimulation(storage)).toEqual({ lat: 41.0567, lng: -75.6789, accuracy: 4 });
    const geo = new FakeGeo();
    const r = await sampleBestPosition({ geolocation: geo, storage });
    expect(r).toMatchObject({ lat: 41.0567, lng: -75.6789, accuracy: 4, simulated: true });
    expect(geo.success).toBeNull();
    setGpsSimulation(null, storage);
    expect(getGpsSimulation(storage)).toBeNull();
    storage.setItem(GPS_SIM_KEY, "{not json");
    expect(getGpsSimulation(storage)).toBeNull();
    storage.setItem(GPS_SIM_KEY, JSON.stringify({ lat: 999, lng: 0 }));
    expect(getGpsSimulation(storage)).toBeNull();
  });
});

/**
 * A phone showing "Allow location?": nothing is delivered (one-shot or watch) until allow()/deny();
 * allow() hands every waiting callback the first coarse fix, like a real phone.
 */
class PromptGeo implements GeolocationLike {
  answer: "pending" | "allowed" | "denied" = "pending";
  once: Array<{ s: (p: GeolocationPosition) => void; e?: ((e: GeolocationPositionError) => void) | null }> = [];
  watchers = new Map<number, { s: (p: GeolocationPosition) => void; e?: ((e: GeolocationPositionError) => void) | null }>();
  oneShots: Array<PositionOptions | undefined> = [];
  private nextId = 1;
  watchPosition(s: (p: GeolocationPosition) => void, e?: ((e: GeolocationPositionError) => void) | null) {
    const id = this.nextId++;
    this.watchers.set(id, { s, e });
    if (this.answer === "denied") e?.(geoError(1));
    return id;
  }
  clearWatch(id: number) {
    this.watchers.delete(id);
  }
  getCurrentPosition(s: (p: GeolocationPosition) => void, e?: ((e: GeolocationPositionError) => void) | null, o?: PositionOptions) {
    this.oneShots.push(o);
    if (this.answer === "allowed") s(position(65));
    else if (this.answer === "denied") e?.(geoError(1));
    else this.once.push({ s, e });
  }
  allow(coarse = 65) {
    this.answer = "allowed";
    for (const c of this.once.splice(0)) c.s(position(coarse));
    for (const w of [...this.watchers.values()]) w.s(position(coarse));
  }
  deny() {
    this.answer = "denied";
    for (const c of this.once.splice(0)) c.e?.(geoError(1));
    for (const w of [...this.watchers.values()]) w.e?.(geoError(1));
  }
  emit(accuracy: number) {
    for (const w of [...this.watchers.values()]) w.s(position(accuracy));
  }
}

function position(accuracy: number): GeolocationPosition {
  return { coords: { latitude: 41.05, longitude: -75.67, accuracy }, timestamp: Date.now() } as unknown as GeolocationPosition;
}
function geoError(code: number): GeolocationPositionError {
  return { code, message: "x", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}
const prompt = async () => "prompt" as const;

describe("measurePosition (the first Measure drive asks for location)", () => {
  it("the Allow prompt doesn't eat the 5 s window: no coarse first fix, a real one", async () => {
    // The bug: sampling straight away while the prompt is up 6 s returns the first coarse fix (a weak try).
    const raw = new PromptGeo();
    const bad = sampleBestPosition({ geolocation: raw, storage: null, durationMs: 5000 });
    await vi.advanceTimersByTimeAsync(6000);
    raw.allow(65);
    expect((await bad).accuracy).toBe(65);

    const geo = new PromptGeo();
    const p = measurePosition({ geolocation: geo, storage: null, durationMs: 5000, permissionState: prompt });
    await vi.advanceTimersByTimeAsync(6000); // reading the prompt
    expect(geo.watchers.size).toBe(0); // sampling hasn't started
    expect(geo.oneShots).toHaveLength(1);
    geo.allow(65);
    await vi.advanceTimersByTimeAsync(0);
    expect(geo.watchers.size).toBe(1); // the 5 s window starts now
    await vi.advanceTimersByTimeAsync(1500);
    geo.emit(30);
    await vi.advanceTimersByTimeAsync(1500);
    geo.emit(8);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).accuracy).toBe(8);
  });

  it("a slow Allow (11 s) doesn't time out either", async () => {
    const raw = new PromptGeo();
    const bad = sampleBestPosition({ geolocation: raw, storage: null }).catch((e: GeoError) => e.code);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await bad).toBe("timeout");

    const geo = new PromptGeo();
    const p = measurePosition({ geolocation: geo, storage: null, permissionState: prompt });
    await vi.advanceTimersByTimeAsync(11_000);
    geo.allow();
    await vi.advanceTimersByTimeAsync(0);
    geo.emit(4);
    expect((await p).accuracy).toBe(4);
  });

  it("Don't Allow: permission_denied, and it never starts watching", async () => {
    const geo = new PromptGeo();
    const p = measurePosition({ geolocation: geo, storage: null, permissionState: prompt }).catch((e: GeoError) => e);
    await vi.advanceTimersByTimeAsync(3000);
    geo.deny();
    const err = await p;
    expect(err).toBeInstanceOf(GeoError);
    expect((err as GeoError).code).toBe("permission_denied");
    expect(geo.watchers.size).toBe(0);
    // Already denied in Settings: says so without a one-shot.
    const blocked = new PromptGeo();
    expect(await primeLocationPermission({ geolocation: blocked, storage: null, permissionState: async () => "denied" })).toBe("denied");
    expect(blocked.oneShots).toHaveLength(0);
  });

  it("already granted (or simulated): no one-shot, sampling starts at the tap", async () => {
    const geo = new PromptGeo();
    geo.answer = "allowed";
    const p = measurePosition({ geolocation: geo, storage: null, permissionState: async () => "granted" });
    await vi.advanceTimersByTimeAsync(0);
    expect(geo.oneShots).toHaveLength(0);
    geo.emit(5);
    expect((await p).accuracy).toBe(5);

    const storage = new MemStorage();
    setGpsSimulation({ lat: 41, lng: -75, accuracy: 3 }, storage);
    const sim = new PromptGeo();
    expect((await measurePosition({ geolocation: sim, storage, permissionState: prompt })).simulated).toBe(true);
    expect(sim.oneShots).toHaveLength(0);
  });

  it("no Permissions API: asks with the one-shot anyway; a prompt nobody answers stops waiting", async () => {
    const geo = new PromptGeo();
    const primed = primeLocationPermission({ geolocation: geo, storage: null, permissionState: async () => "unknown", maxWaitMs: 60_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await primed).toBe("ready");
    expect(geo.oneShots).toEqual([expect.objectContaining({ maximumAge: Number.POSITIVE_INFINITY })]);
    expect(await primeLocationPermission({ geolocation: null, storage: null, permissionState: prompt })).toBe("ready");
  });
});
