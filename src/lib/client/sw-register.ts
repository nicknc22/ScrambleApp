"use client";
// Service worker registration (public/sw.js, scope "/").
// - Production always; in dev only when localStorage "scramble:sw" === "1" (otherwise any old
//   registration is removed so dev never serves stale cached pages).
// - After registration, "warm" the SW cache with the current page and the assets it loaded
//   (the first visit isn't controlled by the SW yet, so nothing was cached by fetch handlers).
// - Updates: a new SW skips waiting; when the controller changes we reload once, but never
//   while someone is typing (deferred until the input loses focus or the page is hidden).
import { readItem, safeStorage, type StorageLike } from "./identity";

export const SW_URL = "/sw.js";
export const SW_DEV_FLAG = "scramble:sw";
const RELOAD_GUARD_KEY = "scramble:sw-reloaded-at";
const UPDATE_CHECK_EVERY_MS = 30 * 60_000;

export function shouldRegisterServiceWorker(
  env: string | undefined = process.env.NODE_ENV,
  storage: StorageLike | null = safeStorage(),
): boolean {
  if (env === "production") return true;
  return readItem(SW_DEV_FLAG, storage) === "1";
}

function swContainer(): ServiceWorkerContainer | null {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    return navigator.serviceWorker;
  } catch {
    return null;
  }
}

/** Same-origin URLs the current page depends on: the page itself plus scripts, styles, fonts, icons. */
export function collectWarmUrls(
  doc: Pick<Document, "querySelectorAll"> | null = typeof document !== "undefined" ? document : null,
  loc: Pick<Location, "href" | "origin"> | null = typeof location !== "undefined" ? location : null,
  perf: Pick<Performance, "getEntriesByType"> | null = typeof performance !== "undefined" ? performance : null,
): string[] {
  if (!loc) return [];
  const out = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    try {
      const u = new URL(raw, loc.href);
      if (u.origin !== loc.origin) return;
      if (u.pathname.startsWith("/api/") && !u.pathname.startsWith("/api/photos/")) return;
      out.add(u.href);
    } catch {
      /* ignore */
    }
  };
  add(loc.href);
  if (doc) {
    doc.querySelectorAll("script[src]").forEach((el) => add(el.getAttribute("src")));
    doc
      .querySelectorAll('link[rel="stylesheet"][href], link[rel="preload"][href], link[rel="modulepreload"][href], link[rel="icon"][href], link[rel="apple-touch-icon"][href], link[rel="manifest"][href]')
      .forEach((el) => add(el.getAttribute("href")));
  }
  if (perf) {
    try {
      for (const e of perf.getEntriesByType("resource")) {
        try {
          const u = new URL(e.name);
          if (u.origin === loc.origin && u.pathname.startsWith("/_next/static/")) add(u.href);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

/** Ask the active SW to cache these URLs (defaults: the current page and its assets). */
export async function warmServiceWorker(urls: string[] = collectWarmUrls()): Promise<void> {
  const sw = swContainer();
  if (!sw || urls.length === 0) return;
  try {
    const target = sw.controller ?? (await withTimeout(sw.ready, 10_000))?.active ?? null;
    target?.postMessage({ type: "warm", urls });
  } catch {
    /* best effort */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Is someone typing? (Never reload under their thumbs.) */
export function isEditing(doc: Document | null = typeof document !== "undefined" ? document : null): boolean {
  const el = doc?.activeElement as HTMLElement | null | undefined;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].includes(type);
  }
  return el.isContentEditable === true;
}

let registered: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register /sw.js once per page load. Never throws. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!registered) registered = doRegister();
  return registered;
}

async function doRegister(): Promise<ServiceWorkerRegistration | null> {
  const sw = swContainer();
  if (!sw) return null;
  if (!shouldRegisterServiceWorker()) {
    // Dev without the flag: make sure no stale SW keeps serving cached pages.
    try {
      const regs = await sw.getRegistrations();
      await Promise.all(
        regs.filter((r) => (r.active?.scriptURL ?? r.installing?.scriptURL ?? r.waiting?.scriptURL ?? "").endsWith(SW_URL)).map((r) => r.unregister()),
      );
    } catch {
      /* ignore */
    }
    return null;
  }

  const hadController = !!sw.controller;
  let reloadScheduled = false;
  const reload = () => {
    if (reloadScheduled) return;
    reloadScheduled = true;
    try {
      const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
      if (Date.now() - last < 30_000) return; // never loop
      sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch {
      /* sessionStorage unavailable: still reload once (reloadScheduled guards this page) */
    }
    // Give the store a beat to finish writing the outbox to IndexedDB.
    setTimeout(() => window.location.reload(), 800);
  };
  const reloadWhenSafe = () => {
    if (!isEditing()) {
      reload();
      return;
    }
    const retry = () => {
      if (document.visibilityState === "hidden" || !isEditing()) {
        document.removeEventListener("focusout", onFocusOut);
        document.removeEventListener("visibilitychange", retry);
        reload();
      }
    };
    const onFocusOut = () => setTimeout(retry, 400);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("visibilitychange", retry);
  };

  sw.addEventListener("controllerchange", () => {
    // First install claiming an uncontrolled page is not an update: no reload.
    if (!hadController) return;
    reloadWhenSafe();
  });

  let reg: ServiceWorkerRegistration;
  try {
    reg = await sw.register(SW_URL, { scope: "/", updateViaCache: "none" });
  } catch (e) {
    console.warn("[scramble] service worker registration failed", e);
    return null;
  }

  const promote = (worker: ServiceWorker | null) => {
    if (!worker) return;
    const tell = () => {
      if (worker.state === "installed" && sw.controller) worker.postMessage({ type: "skipWaiting" });
    };
    tell();
    worker.addEventListener("statechange", tell);
  };
  promote(reg.waiting);
  reg.addEventListener("updatefound", () => promote(reg.installing));

  let lastCheck = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - lastCheck < UPDATE_CHECK_EVERY_MS) return;
    lastCheck = Date.now();
    reg.update().catch(() => undefined);
  });

  void warmServiceWorker();
  return reg;
}
