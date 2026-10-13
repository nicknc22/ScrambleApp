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

export type LocationPermissionState = "granted" | "denied" | "prompt" | "unknown";

/**
 * Get the browser's "Allow location?" prompt answered BEFORE a sampling window starts. Nothing asks
 * for location up front, so the first Measure drive triggers the prompt, and sampleBestPosition's
 * timers start at the tap: a player who read the prompt for 6 s got the first coarse fix (weak, a
 * wasted try) and one who took 11 s got "GPS took too long" (another). So when the permission isn't
 * known to be granted, ask with a one-shot request and wait for the answer (its reading is thrown
 * away). "denied" when the answer is no, else "ready". Never rejects.
 */
export async function primeLocationPermission(
  opts: {
    geolocation?: GeolocationLike | null;
    storage?: StorageLike | null;
    permissionState?: () => Promise<LocationPermissionState>;
    /** Stop waiting after this long (some browsers never call back on a dismissed prompt). Default 60 s. */
    maxWaitMs?: number;
  } = {},
): Promise<"ready" | "denied"> {
  if (getGpsSimulation(opts.storage === undefined ? safeStorage() : opts.storage)) return "ready";
  const geo = opts.geolocation === undefined ? defaultGeolocation() : opts.geolocation;
  if (!geo) return "ready"; // sampling says "unsupported"
  const state = await (opts.permissionState ?? getLocationPermissionState)();
  if (state === "granted") return "ready";
  if (state === "denied") return "denied";
  return new Promise<"ready" | "denied">((resolve) => {
    let settled = false;
    const done = (v: "ready" | "denied") => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(v);
    };
    const t = setTimeout(() => done("ready"), opts.maxWaitMs ?? 60_000);
    try {
      geo.getCurrentPosition(
        () => done("ready"),
        (err) => done(errorCode(err) === "permission_denied" ? "denied" : "ready"),
        // Any position will do (it's only the prompt we're after): cached and coarse is fastest.
        { enableHighAccuracy: false, maximumAge: Number.POSITIVE_INFINITY, timeout: 15_000 },
      );
    } catch {
      done("ready");
    }
  });
}

/**
 * What Measure drive calls: primeLocationPermission, then sampleBestPosition, so the sampling
 * window starts only once the permission prompt is answered. Rejects like sampleBestPosition
 * (permission_denied when the answer was no).
 */
export async function measurePosition(
  opts: SampleOptions & { permissionState?: () => Promise<LocationPermissionState>; maxPromptWaitMs?: number } = {},
): Promise<GeoReading> {
  const primed = await primeLocationPermission({
    geolocation: opts.geolocation,
    storage: opts.storage,
    permissionState: opts.permissionState,
    maxWaitMs: opts.maxPromptWaitMs,
  });
  if (primed === "denied") throw new GeoError("permission_denied");
  return sampleBestPosition(opts);
}

/**
 * Permission state without prompting, where the Permissions API exists. (Nothing asks for location
 * up front: the first Measure drive asks (primeLocationPermission), and the long-drive sheet says
 * why before they tap.)
 */
export async function getLocationPermissionState(): Promise<LocationPermissionState> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
    const s = await navigator.permissions.query({ name: "geolocation" as PermissionName });
    return s.state;
  } catch {
    return "unknown";
  }
}
