import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeoError,
  getGpsSimulation,
  GPS_SIM_KEY,
  requestLocationPermission,
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

describe("requestLocationPermission", () => {
  it("maps outcomes and never rejects", async () => {
    const geo = new FakeGeo();
    const ok = requestLocationPermission({ geolocation: geo });
    geo.emit(1, 2, 10);
    expect(await ok).toBe("granted");
    expect(geo.options).toMatchObject({ enableHighAccuracy: true, timeout: 10000 });

    const geo2 = new FakeGeo();
    const denied = requestLocationPermission({ geolocation: geo2 });
    geo2.fail(1);
    expect(await denied).toBe("denied");

    const geo3 = new FakeGeo();
    const silent = requestLocationPermission({ geolocation: geo3 });
    vi.advanceTimersByTime(16_000);
    expect(await silent).toBe("unavailable");

    expect(await requestLocationPermission({ geolocation: null })).toBe("unsupported");
  });
});
