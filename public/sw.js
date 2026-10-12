/* Scramble service worker. Hand-written, no build step, no imports.
 *
 * Caches (versioned names; bump CACHE_VERSION only when the caching scheme changes, so a normal
 * deploy never throws away the pages and chunks a phone needs to open with no signal):
 *   pages   navigations: network-first (4 s), cached by URL without its search string
 *   static  /_next/static/*, /icon*, /apple-icon*, /manifest.webmanifest, /favicon.ico: cache-first
 *   photos  /api/photos/* and Supabase public storage objects: cache-first (opaque OK)
 * Everything else (other /api/*, non-GET, cross-origin) goes straight to the network.
 * Also: "warm" messages (cache given URLs), Web Push notifications and notification clicks.
 */
/* eslint-disable */
"use strict";

const CACHE_VERSION = "v1";
const PAGES = "scramble-pages-" + CACHE_VERSION;
const STATIC = "scramble-static-" + CACHE_VERSION;
const PHOTOS = "scramble-photos-" + CACHE_VERSION;
const CURRENT_CACHES = [PAGES, STATIC, PHOTOS];
const NAV_TIMEOUT_MS = 4000;
const MAX_ENTRIES = { [PAGES]: 40, [STATIC]: 600, [PHOTOS]: 400 };

// ------------------------------------------------------------------ lifecycle

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k.indexOf("scramble-") === 0 && CURRENT_CACHES.indexOf(k) === -1).map((k) => caches.delete(k)),
        );
      } catch (e) {
        /* ignore */
      }
      try {
        if (self.registration && self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      } catch (e) {
        /* ignore */
      }
      await self.clients.claim();
    })(),
  );
});

// ------------------------------------------------------------------ routing

function isPhotoUrl(url) {
  return url.pathname.indexOf("/storage/v1/object/public/") !== -1 || (url.origin === self.location.origin && url.pathname.indexOf("/api/photos/") === 0);
}

function isStaticPath(pathname) {
  return (
    pathname.indexOf("/_next/static/") === 0 ||
    pathname.indexOf("/icon") === 0 ||
    pathname.indexOf("/apple-icon") === 0 ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.ico"
  );
}

/** "page" | "static" | "photo" | null (null = network only, SW stays out of the way). */
function classify(request) {
  if (request.method !== "GET") return null;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isPhotoUrl(url)) return "photo";
  if (url.origin !== self.location.origin) return null;
  if (url.pathname.indexOf("/api/") === 0) return null;
  if (request.mode === "navigate") return "page";
  if (isStaticPath(url.pathname)) return "static";
  return null;
}

self.addEventListener("fetch", (event) => {
  const kind = classify(event.request);
  if (kind === "page") event.respondWith(handlePage(event));
  else if (kind === "static") event.respondWith(cacheFirst(event, STATIC, false));
  else if (kind === "photo") event.respondWith(cacheFirst(event, PHOTOS, true));
});

// ------------------------------------------------------------------ helpers

function pageKey(href) {
  const u = new URL(href, self.location.origin);
  return u.origin + u.pathname;
}

/** Safari refuses redirected responses for navigations: rebuild them as plain responses. */
async function cleanResponse(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function trim(cacheName) {
  try {
    const max = MAX_ENTRIES[cacheName];
    if (!max) return;
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    // Oldest first (insertion order).
    for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
  } catch (e) {
    /* ignore */
  }
}

async function putPage(href, res) {
  try {
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok || (type && type.indexOf("text/html") === -1)) return;
    const cache = await caches.open(PAGES);
    await cache.put(pageKey(href), await cleanResponse(res));
    await trim(PAGES);
  } catch (e) {
    /* quota or similar: ignore */
  }
}

const TRIP_PAGE_RE = /^\/t\/[^/]+\/?$/;

/** Cached page for this path, else any cached trip page, else "/". */
async function fallbackPage(href) {
  try {
    const cache = await caches.open(PAGES);
    const exact = await cache.match(pageKey(href), { ignoreSearch: true, ignoreVary: true });
    if (exact) return exact;
    const keys = await cache.keys();
    for (let i = keys.length - 1; i >= 0; i--) {
      const u = new URL(keys[i].url);
      if (TRIP_PAGE_RE.test(u.pathname)) {
        const hit = await cache.match(keys[i], { ignoreVary: true });
        if (hit) return hit;
      }
    }
    const home = await cache.match(self.location.origin + "/", { ignoreSearch: true, ignoreVary: true });
    if (home) return home;
  } catch (e) {
    /* ignore */
  }
  return null;
}

function offlinePage() {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>Scramble — offline</title><style>body{font:18px/1.4 system-ui,sans-serif;margin:0;padding:32px 16px;background:#fff;color:#111}" +
    "h1{font-size:24px}button{font:inherit;font-weight:700;min-height:48px;padding:0 20px;border-radius:12px;border:0;background:#0a7d3e;color:#fff}</style></head>" +
    "<body><h1>No signal ⛳🍺</h1><p>This page hasn't been saved on this phone yet. Open the trip link once with signal and it'll work offline after that.</p>" +
    '<button onclick="location.reload()">Try again</button></body></html>';
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const TIMED_OUT = {};

async function handlePage(event) {
  const request = event.request;
  const href = request.url;

  const network = (async () => {
    let res = null;
    try {
      res = event.preloadResponse ? await event.preloadResponse : null;
    } catch (e) {
      res = null;
    }
    if (!res) res = await fetch(request);
    if (res && res.ok) {
      const copy = res.clone();
      event.waitUntil(putPage(href, copy));
    }
    return res;
  })();
  // Keep the SW alive until the network finishes (it refreshes the cache even if we served a cached copy).
  event.waitUntil(network.then(() => undefined, () => undefined));

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), NAV_TIMEOUT_MS);
  });

  try {
    const winner = await Promise.race([network, timeout]);
    if (winner !== TIMED_OUT) {
      clearTimeout(timer);
      // Server error: a cached copy beats an error page on the course.
      if (winner.status >= 500) {
        const cached = await fallbackPage(href);
        if (cached) return cached;
      }
      return await cleanResponse(winner);
    }
    // Slow network: serve the cached copy now if there is one, else keep waiting.
    const cached = await fallbackPage(href);
    if (cached) return cached;
    return await cleanResponse(await network);
  } catch (e) {
    clearTimeout(timer);
    const cached = await fallbackPage(href);
    return cached || offlinePage();
  }
}

async function cacheFirst(event, cacheName, allowOpaque) {
  const request = event.request;
  let cache = null;
  try {
    cache = await caches.open(cacheName);
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
  } catch (e) {
    cache = null;
  }
  try {
    let res = null;
    let crossOrigin = false;
    try {
      crossOrigin = new URL(request.url).origin !== self.location.origin;
    } catch (e) {
      crossOrigin = false;
    }
    if (allowOpaque && crossOrigin) {
      // <img> asks no-cors, and an opaque response hides a 404 (a photo referenced before its
      // upload landed would stay broken forever). Supabase public storage allows CORS: ask with
      // CORS to see the real status; fall back to the opaque request only if CORS itself fails.
      try {
        res = await fetch(new Request(request.url, { mode: "cors", credentials: "omit" }));
      } catch (e) {
        res = null;
      }
    }
    if (!res) res = await fetch(request);
    const cacheable = res.ok || (allowOpaque && res.type === "opaque");
    if (cache && cacheable) {
      const copy = res.clone();
      event.waitUntil(
        cache
          .put(request, copy)
          .then(() => trim(cacheName))
          .catch(() => undefined),
      );
    }
    return res;
  } catch (e) {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}

// ------------------------------------------------------------------ messages

async function warm(urls) {
  const seen = new Set();
  for (const raw of urls.slice(0, 300)) {
    let url;
    try {
      url = new URL(raw, self.location.origin);
    } catch (e) {
      continue;
    }
    if (url.origin !== self.location.origin || seen.has(url.href)) continue;
    seen.add(url.href);
    try {
      if (isStaticPath(url.pathname) || isPhotoUrl(url)) {
        const cacheName = isPhotoUrl(url) ? PHOTOS : STATIC;
        const cache = await caches.open(cacheName);
        if (await cache.match(url.href, { ignoreVary: true })) continue;
        const res = await fetch(url.href, { credentials: "same-origin" });
        if (res.ok) await cache.put(url.href, res);
      } else if (url.pathname.indexOf("/api/") !== 0 && !/\.[a-z0-9]+$/i.test(url.pathname)) {
        const res = await fetch(url.href, { credentials: "same-origin", headers: { accept: "text/html" } });
        await putPage(url.href, res);
      }
    } catch (e) {
      /* offline: try again next time */
    }
  }
  await trim(STATIC);
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "skipWaiting") {
    self.skipWaiting();
  } else if (data.type === "warm" && Array.isArray(data.urls)) {
    event.waitUntil(warm(data.urls.filter((u) => typeof u === "string")));
  }
});

// ------------------------------------------------------------------ push

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try {
      data = { body: event.data ? event.data.text() : "" };
    } catch (e2) {
      data = {};
    }
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Scramble";
  const options = {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: typeof data.url === "string" && data.url ? data.url : "/" },
  };
  // Same tag replaces the previous notification instead of stacking duplicates.
  if (typeof data.tag === "string" && data.tag) options.tag = data.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  let target;
  try {
    target = new URL(raw, self.location.origin);
  } catch (e) {
    target = new URL("/", self.location.origin);
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        let u;
        try {
          u = new URL(client.url);
        } catch (e) {
          continue;
        }
        if (u.origin === target.origin && u.pathname === target.pathname) {
          if (u.href !== target.href) {
            try {
              client.postMessage({ type: "open-url", url: target.href });
            } catch (e) {
              /* ignore */
            }
          }
          if ("focus" in client) return client.focus();
          return undefined;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target.href);
      return undefined;
    })(),
  );
});
