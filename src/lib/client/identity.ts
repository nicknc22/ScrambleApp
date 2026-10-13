"use client";
// Per-device identity: which player this phone belongs to ("tap your name"), stored in
// localStorage per trip code. Every accessor is defensive: localStorage can be missing
// (SSR), throw (Safari private mode / disabled storage) or be full.
import type { UUID } from "../types";
import type { Platform } from "./ui-prefs";

/** Minimal localStorage-like interface (injectable for tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const meKey = (code: string) => `scramble:me:${code}`;
export const commissionerKey = (code: string) => `scramble:commish:${code}`;
/** Last trip opened on this device, so "/" (the PWA start_url) can jump straight back into it. */
export const LAST_TRIP_KEY = "scramble:last-trip";

/** window.localStorage, or null when unavailable (SSR, blocked storage). Never throws. */
export function safeStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readItem(key: string, storage: StorageLike | null = safeStorage()): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false when the write failed (quota, private mode). */
export function writeItem(key: string, value: string | null, storage: StorageLike | null = safeStorage()): boolean {
  if (!storage) return false;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadMe(code: string, storage: StorageLike | null = safeStorage()): UUID | null {
  const v = readItem(meKey(code), storage);
  return v && v.trim() ? v : null;
}

export function saveMe(code: string, playerId: UUID | null, storage: StorageLike | null = safeStorage()): boolean {
  return writeItem(meKey(code), playerId, storage);
}

export function loadCommissionerHint(code: string, storage: StorageLike | null = safeStorage()): boolean {
  return readItem(commissionerKey(code), storage) === "1";
}

export function saveCommissionerHint(code: string, on: boolean, storage: StorageLike | null = safeStorage()): void {
  writeItem(commissionerKey(code), on ? "1" : null, storage);
}

export function getLastTripCode(storage: StorageLike | null = safeStorage()): string | null {
  return readItem(LAST_TRIP_KEY, storage);
}

export function setLastTripCode(code: string | null, storage: StorageLike | null = safeStorage()): void {
  writeItem(LAST_TRIP_KEY, code, storage);
}

// ---------- Carrying "who you are" into the Home Screen app ----------
// iOS gives a Home Screen app storage separate from Safari's, so the player picked in Safari is
// unknown there. On iPhone/iPad only, the trip page puts the player in the URL (?me=<id>) and in its
// manifest link (/t/<code>/manifest.webmanifest?me=<id>, whose start_url carries it too); whichever
// iOS saves, the first standalone launch adopts it (adoptMeFromLaunch). Everywhere else the URL
// never carries a player, and a `me` that isn't this phone's own is dropped on sight
// (withoutForeignMe), so a shared link can't be installed or launched as the sender.

export const ME_PARAM = "me";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A player id from a URL (`?me=`): a uuid (lowercased), else null. */
export function parseMeParam(raw: string | null | undefined): UUID | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  return UUID_RE.test(v) ? v.toLowerCase() : null;
}

function meParamOf(search: string): UUID | null {
  try {
    const all = new URLSearchParams(search).getAll(ME_PARAM);
    // Two different players in one link: trust neither.
    const ids = new Set(all.map(parseMeParam));
    return ids.size === 1 ? ([...ids][0] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Only an iPhone/iPad carries the player in the URL. Its Home Screen app has storage separate from
 * Safari's, and iOS never opens a tapped link inside a Home Screen app, so the app's launch URL is
 * always the one saved at install. Android and desktop installs share storage with the browser
 * (nothing to carry), and an installed Android app DOES open tapped links in its scope in
 * standalone mode, so a shared link carrying the sender's `me` must never be adopted there.
 */
export function carriesIdentityInUrl(platform: Platform): boolean {
  return platform === "ios";
}

/**
 * First launch of the Home Screen app: adopt the player the launch URL carries (?me=<id>) so
 * nobody has to pick their name twice. Only on iOS (carriesIdentityInUrl), running standalone, AND
 * with no player stored for this trip yet: a link opened in a normal browser tab never changes who
 * you are (a copied link carrying someone else's `me` can't silently turn you into them), and a
 * stored identity is never overridden. An id that isn't on the roster is still stored; the shell
 * treats it like any stale identity and shows the join screen. Returns the adopted id, else null.
 * Never throws.
 */
export function adoptMeFromLaunch(opts: {
  code: string;
  /** location.search of the launch URL. */
  search: string;
  /** Running as an installed Home Screen app (isStandalone()). */
  standalone: boolean;
  /** detectPlatform(): only "ios" ever adopts. */
  platform: Platform;
  storage?: StorageLike | null;
}): UUID | null {
  if (!opts.standalone || !carriesIdentityInUrl(opts.platform)) return null;
  const storage = opts.storage === undefined ? safeStorage() : opts.storage;
  if (!storage) return null;
  if (loadMe(opts.code, storage)) return null;
  const id = meParamOf(opts.search);
  if (!id) return null;
  return saveMe(opts.code, id, storage) ? id : null;
}

/** The trip's manifest URL, carrying this device's player (so its start_url does too). */
export function tripManifestHref(code: string, meId: UUID | null): string {
  const base = `/t/${encodeURIComponent(code)}/manifest.webmanifest`;
  const id = parseMeParam(meId);
  return id ? `${base}?${ME_PARAM}=${id}` : base;
}

/**
 * `href` (path, search, hash) with `?me=` set to `meId` (or removed when null), every other param
 * kept. null when it already says that (nothing to replace).
 */
export function withMeParam(href: string, meId: UUID | null): string | null {
  let url: URL;
  try {
    url = new URL(href, "http://localhost");
  } catch {
    return null;
  }
  const id = parseMeParam(meId);
  const current = url.searchParams.getAll(ME_PARAM);
  if (id ? current.length === 1 && current[0] === id : current.length === 0) return null;
  if (id) url.searchParams.set(ME_PARAM, id);
  else url.searchParams.delete(ME_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `href` without a `me` that isn't `ownMe`: this phone's own player for the trip, or null on a phone
 * that never carries one (then any `me` goes). null when there's nothing to drop.
 */
export function withoutForeignMe(href: string, ownMe: UUID | null): string | null {
  let url: URL;
  try {
    url = new URL(href, "http://localhost");
  } catch {
    return null;
  }
  const all = url.searchParams.getAll(ME_PARAM);
  if (all.length === 0) return null;
  const own = parseMeParam(ownMe);
  if (own && all.length === 1 && parseMeParam(all[0]) === own) return null;
  return withMeParam(href, null);
}

/** The bits of window that syncHomeScreenIdentity / dropForeignMe touch (injectable for tests). */
export interface HomeScreenDom {
  document: {
    querySelectorAll(selector: string): ArrayLike<{ getAttribute(name: string): string | null; setAttribute(name: string, value: string): void }>;
    createElement(tag: "link"): HTMLLinkElement;
    head: { appendChild(node: HTMLLinkElement): unknown } | null;
  };
  location: { pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url?: string | null): void };
}

function defaultDom(): HomeScreenDom | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return { document, location: window.location, history: window.history };
}

/**
 * Before the trip has loaded: drop a `me` in the address bar that isn't `ownMe` (withoutForeignMe),
 * so a link carrying the sender's player is never what "Add to Home Screen" saves, even on the
 * splash or the no-signal error screen. Never throws.
 */
export function dropForeignMe(ownMe: UUID | null, dom: Pick<HomeScreenDom, "location" | "history"> | null = defaultDom()): void {
  if (!dom) return;
  try {
    const { pathname, search, hash } = dom.location;
    const next = withoutForeignMe(`${pathname}${search}${hash}`, ownMe);
    // null state, like useUrlTab: Next.js syncs its router with the new URL.
    if (next) dom.history.replaceState(null, "", next);
  } catch {
    /* best effort */
  }
}

/**
 * Point the page's <link rel="manifest"> and the address bar at this device's player (`?me=<id>`),
 * or drop the param when no player is picked (and on phones that don't carry it: pass null), so
 * "Add to Home Screen" carries who you are whether iOS saves the manifest's start_url or the current
 * page. Never throws.
 */
export function syncHomeScreenIdentity(code: string, meId: UUID | null, dom: HomeScreenDom | null = defaultDom()): void {
  if (!dom) return;
  const manifest = tripManifestHref(code, meId);
  try {
    const links = dom.document.querySelectorAll('link[rel="manifest"]');
    if (links.length === 0) {
      const link = dom.document.createElement("link");
      link.rel = "manifest";
      link.href = manifest;
      dom.document.head?.appendChild(link);
    }
    for (let i = 0; i < links.length; i++) {
      if (links[i].getAttribute("href") !== manifest) links[i].setAttribute("href", manifest);
    }
  } catch {
    /* best effort */
  }
  try {
    const { pathname, search, hash } = dom.location;
    const next = withMeParam(`${pathname}${search}${hash}`, meId);
    // null state, like useUrlTab: Next.js syncs its router with the new URL.
    if (next) dom.history.replaceState(null, "", next);
  } catch {
    /* best effort */
  }
}
