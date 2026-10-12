"use client";
// Location sampling for long drive / tee points.
// sampleBestPosition watches high-accuracy GPS for a few seconds and keeps the reading with the
// smallest reported accuracy. A dev-only GPS simulator (localStorage "scramble:gps-sim") lets you
// fake a position anywhere on the course.
import { readItem, safeStorage, writeItem, type StorageLike } from "./identity";

export const GPS_SIM_KEY = "scramble:gps-sim";

export interface GeoReading {
  lat: number;
  lng: number;
  /** Reported accuracy radius in meters. */
  accuracy: number;
  /** Epoch ms of the reading. */
  timestamp: number;
  /** true when it came from the GPS simulator. */
  simulated?: boolean;
}

export type GeoErrorCode = "permission_denied" | "unavailable" | "timeout" | "unsupported";

export class GeoError extends Error {
  readonly code: GeoErrorCode;
  constructor(code: GeoErrorCode, message?: string) {
    super(message ?? GEO_ERROR_MESSAGES[code]);
    this.name = "GeoError";
    this.code = code;
  }
}

export const GEO_ERROR_MESSAGES: Record<GeoErrorCode, string> = {
  permission_denied: "Location is blocked. Allow location for this site in Settings to measure drives.",
  unavailable: "Can't get a GPS fix right now. Step out from under the trees and try again.",
  timeout: "GPS took too long. Try again in a few seconds.",
  unsupported: "This browser has no GPS access.",
};

export interface GpsSimulation {
  lat: number;
  lng: number;
  accuracy: number;
}

/** Minimal Geolocation interface (injectable for tests). */
export interface GeolocationLike {
  watchPosition(
    success: (pos: GeolocationPosition) => void,
    error?: ((err: GeolocationPositionError) => void) | null,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
  getCurrentPosition(
    success: (pos: GeolocationPosition) => void,
    error?: ((err: GeolocationPositionError) => void) | null,
    options?: PositionOptions,
  ): void;
}

function defaultGeolocation(): GeolocationLike | null {
  try {
    if (typeof navigator === "undefined" || !navigator.geolocation) return null;
    return navigator.geolocation;
  } catch {
    return null;
  }
}

export function getGpsSimulation(storage: StorageLike | null = safeStorage()): GpsSimulation | null {
  const raw = readItem(GPS_SIM_KEY, storage);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GpsSimulation>;
    const lat = Number(v.lat);
    const lng = Number(v.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    const accuracy = Number.isFinite(Number(v.accuracy)) && Number(v.accuracy) >= 0 ? Number(v.accuracy) : 3;
    return { lat, lng, accuracy };
  } catch {
    return null;
  }
}

/** Set (or clear with null) the simulated GPS position used by sampleBestPosition. */
export function setGpsSimulation(sim: GpsSimulation | null, storage: StorageLike | null = safeStorage()): void {
  writeItem(GPS_SIM_KEY, sim ? JSON.stringify({ lat: sim.lat, lng: sim.lng, accuracy: sim.accuracy }) : null, storage);
}

function toReading(pos: GeolocationPosition): GeoReading {
  return {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : Number.POSITIVE_INFINITY,
    timestamp: pos.timestamp || Date.now(),
  };
}

function errorCode(err: { code?: number } | null | undefined): GeoErrorCode {
  // GeolocationPositionError: 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT
  if (err?.code === 1) return "permission_denied";
  if (err?.code === 3) return "timeout";
  return "unavailable";
}

export interface SampleOptions {
  /** Sampling window from the start; resolves with the best reading at its end (or the first one after it). Default 5000. */
  durationMs?: number;
  /** Give up when no reading at all arrived in this time. Default 10000. */
  timeoutMs?: number;
  /** Resolve early once a reading is at least this accurate (m). Default 5. */
  goodEnoughM?: number;
  /** Called with the best reading so far (for a live "±8 m" display). */
  onProgress?: (best: GeoReading) => void;
  geolocation?: GeolocationLike | null;
  storage?: StorageLike | null;
}

/**
 * Watch high-accuracy GPS and resolve with the most accurate reading seen in `durationMs`
 * (early when accuracy <= goodEnoughM). Rejects with GeoError on permission denied, or on
 * unavailable/timeout when no reading arrived at all.
 */
export function sampleBestPosition(opts: SampleOptions = {}): Promise<GeoReading> {
  const durationMs = opts.durationMs ?? 5000;
  const timeoutMs = Math.max(opts.timeoutMs ?? 10000, 1);
  const goodEnough = opts.goodEnoughM ?? 5;

  const sim = getGpsSimulation(opts.storage === undefined ? safeStorage() : opts.storage);
  if (sim) {
    const reading: GeoReading = { ...sim, timestamp: Date.now(), simulated: true };
    opts.onProgress?.(reading);
    return Promise.resolve(reading);
  }

  const geo = opts.geolocation === undefined ? defaultGeolocation() : opts.geolocation;
  if (!geo) return Promise.reject(new GeoError("unsupported"));

  return new Promise<GeoReading>((resolve, reject) => {
    let best: GeoReading | null = null;
    let lastError: GeoErrorCode | null = null;
    let done = false;
    let sampled = false; // durationMs elapsed
    let watchId: number | null = null;

    const cleanup = () => {
      done = true;
      if (watchId !== null) {
        try {
          geo.clearWatch(watchId);
        } catch {
          /* ignore */
        }
      }
      clearTimeout(sampleTimer);
      clearTimeout(overallTimer);
    };
    const finish = () => {
      if (done) return;
      cleanup();
      if (best) resolve(best);
      else reject(new GeoError(lastError === "unavailable" ? "unavailable" : "timeout"));
    };

    // After durationMs: resolve with the best reading so far, or with the first one to arrive.
    const sampleTimer = setTimeout(() => {
      sampled = true;
      if (best) finish();
    }, durationMs);
    // Nothing at all by timeoutMs: reject.
    const overallTimer = setTimeout(finish, Math.max(timeoutMs, durationMs));

    const onPosition = (pos: GeolocationPosition) => {
      if (done) return;
      const r = toReading(pos);
      if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return;
      if (!best || r.accuracy < best.accuracy) {
        best = r;
        opts.onProgress?.(best);
      }
      if (best.accuracy <= goodEnough || sampled) finish();
    };
    const onError = (err: GeolocationPositionError) => {
      if (done) return;
      const code = errorCode(err);
      if (code === "permission_denied") {
        cleanup();
        reject(new GeoError("permission_denied"));
        return;
      }
      // unavailable/timeout: keep watching; the timers decide.
      lastError = code;
    };

    try {
      const id = geo.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs });
      if (done) {
        // Resolved synchronously inside watchPosition.
        try {
          geo.clearWatch(id);
        } catch {
          /* ignore */
        }
      } else {
        watchId = id;
      }
    } catch {
      cleanup();
      reject(new GeoError("unsupported"));
    }
  });
}

export type LocationPermission = "granted" | "denied" | "unavailable" | "unsupported";

/**
 * One-shot location request for onboarding (so the permission prompt happens at join time, not
 * mid-shot). Never rejects.
 */
export function requestLocationPermission(
  opts: { geolocation?: GeolocationLike | null; timeoutMs?: number } = {},
): Promise<LocationPermission> {
  const geo = opts.geolocation === undefined ? defaultGeolocation() : opts.geolocation;
  if (!geo) return Promise.resolve("unsupported");
  return new Promise<LocationPermission>((resolve) => {
    let settled = false;
    const done = (v: LocationPermission) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // Some browsers never call back when the prompt is dismissed; don't hang onboarding.
    const t = setTimeout(() => done("unavailable"), (opts.timeoutMs ?? 10000) + 5000);
    try {
      geo.getCurrentPosition(
        () => {
          clearTimeout(t);
          done("granted");
        },
        (err) => {
          clearTimeout(t);
          done(errorCode(err) === "permission_denied" ? "denied" : "unavailable");
        },
        { enableHighAccuracy: true, timeout: opts.timeoutMs ?? 10000, maximumAge: 60_000 },
      );
    } catch {
      clearTimeout(t);
      done("unsupported");
    }
  });
}

/** Permission state without prompting, where the Permissions API exists. */
export async function getLocationPermissionState(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const s = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return s.state;
  } catch {
    return "unknown";
  }
}
