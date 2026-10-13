// Per-device UI preferences in localStorage: "Get set up" card hidden, recent trips, dev mode.
// Every access is wrapped: private mode / full storage / SSR must never crash the app.

const NS = "scramble:";
/** Per trip (`scramble:get-set-up-hidden:<code>`): hiding it on the dry run doesn't hide it on Saturday's trip. */
export const getSetUpHiddenKey = (code: string) => `${NS}get-set-up-hidden:${code}`;
export const RECENT_TRIPS_KEY = `${NS}recent-trips`;
export const DEV_KEY = `${NS}dev`;
const MAX_RECENT = 6;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPref(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    const s = storage();
    if (!s) return;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage full or blocked: preferences are best effort */
  }
}

// ---------- "Get set up" card (Home Screen + notifications; full pre-round, one row on Play) ----------

/** Somebody tapped Hide on this trip's "Get set up" card on this device. */
export function isGetSetUpHidden(code: string): boolean {
  return readPref(getSetUpHiddenKey(code)) === "1";
}

export function setGetSetUpHidden(code: string, hidden = true): void {
  writePref(getSetUpHiddenKey(code), hidden ? "1" : null);
}

// ---------- Recent trips ----------

export interface RecentTrip {
  code: string;
  name: string | null;
  /** ms epoch of the last visit. */
  at: number;
}

export function getRecentTrips(): RecentTrip[] {
  const raw = readPref(RECENT_TRIPS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentTrip[] = [];
    for (const r of parsed) {
      if (!r || typeof r !== "object") continue;
      const rec = r as Record<string, unknown>;
      const code = typeof rec.code === "string" ? normalizeTripCode(rec.code) : null;
      if (!code) continue;
      out.push({
        code,
        name: typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : null,
        at: typeof rec.at === "number" && Number.isFinite(rec.at) ? rec.at : 0,
      });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Remember a trip as most recent (keeps the old name when `name` is not given). */
export function rememberTrip(code: string, name?: string | null, now: number = Date.now()): RecentTrip[] {
  const c = normalizeTripCode(code);
  if (!c) return getRecentTrips();
  const list = getRecentTrips();
  const prev = list.find((t) => t.code === c);
  const next: RecentTrip[] = [
    { code: c, name: name?.trim() || prev?.name || null, at: now },
    ...list.filter((t) => t.code !== c),
  ].slice(0, MAX_RECENT);
  writePref(RECENT_TRIPS_KEY, JSON.stringify(next));
  return next;
}

export function forgetTrip(code: string): RecentTrip[] {
  const next = getRecentTrips().filter((t) => t.code !== normalizeTripCode(code));
  writePref(RECENT_TRIPS_KEY, JSON.stringify(next));
  return next;
}

/**
 * Turn whatever someone typed or pasted into a trip code: accepts the bare code or a full
 * link (".../t/<code>?tab=..."). Lowercase [a-z0-9] only; null when nothing usable is left.
 */
export function normalizeTripCode(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  const m = s.match(/\/t\/([^/?#\s]+)/i);
  if (m) s = m[1];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.length < 3 || s.length > 64) return null;
  return s;
}

// ---------- Device / environment ----------

/** Dev tools (GPS simulator) visible: non-production builds, or localStorage "scramble:dev" = "1". */
export function isDevMode(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return readPref(DEV_KEY) === "1";
}

/** Running as an installed Home Screen app. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    if (window.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  } catch {
    /* ignore */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type Platform = "ios" | "android" | "other";

/** Rough platform for install instructions. iPadOS reports as Mac, so check touch points too. */
export function detectPlatform(ua?: string, maxTouchPoints?: number): Platform {
  const agent = ua ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const touch = maxTouchPoints ?? (typeof navigator !== "undefined" ? navigator.maxTouchPoints : 0);
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  if (/Macintosh/i.test(agent) && touch > 1) return "ios";
  if (/Android/i.test(agent)) return "android";
  return "other";
}

/** App version shown in Settings. */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0";
export const APP_BUILD: string | null = (process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null;
