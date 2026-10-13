// Runs the real public/sw.js in a vm sandbox with fake caches, fetch and clients.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://scramble.test";
const SW_SOURCE = readFileSync(path.resolve(__dirname, "../../public/sw.js"), "utf8");

type Req = { url: string; method: string; mode: string; headers: Headers };
type Res = Response | { type: "opaque"; ok: false; status: 0; redirected: false; headers: Headers; clone(): Res };

const keyOf = (r: string | Req) => (typeof r === "string" ? r : r.url);

class FakeCache {
  entries = new Map<string, Res>();
  async match(req: string | Req, opts: { ignoreSearch?: boolean } = {}) {
    const url = new URL(keyOf(req), ORIGIN);
    for (const [k, v] of this.entries) {
      const ku = new URL(k);
      const same = opts.ignoreSearch ? ku.origin + ku.pathname === url.origin + url.pathname : ku.href === url.href;
      if (same) return v.clone();
    }
    return undefined;
  }
  async put(req: string | Req, res: Res) {
    this.entries.set(new URL(keyOf(req), ORIGIN).href, res);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(req: string | Req) {
    return this.entries.delete(new URL(keyOf(req), ORIGIN).href);
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name)!;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  page(url: string) {
    return this.caches.get("scramble-pages-v1")?.entries.get(url);
  }
}

function html(body: string, status = 200) {
  return new Response(`<html>${body}</html>`, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function loadSw() {
  const handlers = new Map<string, (e: unknown) => void>();
  const caches = new FakeCacheStorage();
  const notifications: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const focused: string[] = [];
  const posted: unknown[] = [];
  const windows: Array<{ url: string; focus(): Promise<void>; postMessage(m: unknown): void }> = [];
  let skipped = 0;
  let claimed = 0;
  const net = {
    online: true,
    hang: false,
    handler: (req: Req): Res | Promise<Res> => html(`network ${new URL(req.url).pathname}`),
    requests: [] as string[],
  };
  const sandbox: Record<string, unknown> = {
    console,
    URL,
    Headers,
    Response,
    Request,
    Blob,
    Promise,
    // Scale timers down 100x so the 4 s navigation timeout takes 40 ms.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms / 100),
    clearTimeout,
    caches,
    fetch: async (input: string | Req) => {
      const req: Req = typeof input === "string" ? { url: new URL(input, ORIGIN).href, method: "GET", mode: "cors", headers: new Headers() } : input;
      net.requests.push(req.url);
      if (net.hang) return new Promise<Res>(() => undefined);
      if (!net.online) throw new TypeError("Failed to fetch");
      return net.handler(req);
    },
    location: new URL(ORIGIN + "/sw.js"),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void notifications.push({ title, options }),
      navigationPreload: { enable: async () => undefined },
    },
    clients: {
      claim: async () => void claimed++,
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
    },
    skipWaiting: () => void skipped++,
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: "sw.js" });

  async function dispatch(type: string, init: Record<string, unknown> = {}, waitAll = true) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Res> | undefined;
    const event = {
      ...init,
      waitUntil: (p: Promise<unknown>) => void waits.push(p),
      respondWith: (p: Promise<Res>) => void (response = p),
    };
    handlers.get(type)?.(event);
    const res = response ? await response : undefined;
    // Let waitUntil work (cache writes) finish; it may register more waitUntil calls.
    if (waitAll) for (let i = 0; i < waits.length; i++) await waits[i].catch(() => undefined);
    return { res, handled: response !== undefined };
  }
  const navigate = (p: string, waitAll = true) =>
    dispatch("fetch", { request: { url: ORIGIN + p, method: "GET", mode: "navigate", headers: new Headers() } }, waitAll);
  const get = (url: string, mode = "no-cors") =>
    dispatch("fetch", { request: { url: url.startsWith("http") ? url : ORIGIN + url, method: "GET", mode, headers: new Headers() } });

  return { handlers, caches, net, dispatch, navigate, get, notifications, opened, focused, posted, windows, counts: () => ({ skipped, claimed }) };
}

async function text(res: Res | undefined) {
  return res && "text" in res ? (res as Response).text() : "";
}

describe("service worker", () => {
  it("install skips waiting; activate deletes old scramble caches and claims clients", async () => {
    const sw = loadSw();
    await sw.dispatch("install");
    expect(sw.counts().skipped).toBe(1);
    await sw.caches.open("scramble-pages-v0");
    await sw.caches.open("scramble-static-v1");
    await sw.caches.open("someone-elses-cache");
    await sw.dispatch("activate");
    expect(await sw.caches.keys()).toEqual(["scramble-static-v1", "someone-elses-cache"]);
    expect(sw.counts().claimed).toBe(1);
  });

  it("navigations are network-first and cached under the URL without its search", async () => {
    const sw = loadSw();
    const { res } = await sw.navigate("/t/abc123?tab=feed");
    expect(await text(res)).toContain("network /t/abc123");
    expect(sw.caches.page(ORIGIN + "/t/abc123")).toBeDefined();
    // Offline: the cached page for that path (any search).
    sw.net.online = false;
    const off = await sw.navigate("/t/abc123?tab=money");
    expect(await text(off.res)).toContain("network /t/abc123");
  });

  it("offline fallback chain: same path, any cached trip page, '/', offline page", async () => {
    const sw = loadSw();
    await sw.navigate("/t/trip1");
    await sw.navigate("/");
    sw.net.online = false;
    expect(await text((await sw.navigate("/t/other")).res)).toContain("network /t/trip1");
    sw.caches.caches.get("scramble-pages-v1")!.entries.delete(ORIGIN + "/t/trip1");
    expect(await text((await sw.navigate("/t/other")).res)).toContain("network /<");
    sw.caches.caches.get("scramble-pages-v1")!.entries.clear();
    const last = await sw.navigate("/t/other");
    expect((last.res as Response).status).toBe(503);
    expect(await text(last.res)).toContain("No signal");
  });

  it("serves the cached page after a 4 s timeout on a hanging network", async () => {
    const sw = loadSw();
    await sw.navigate("/t/trip1");
    sw.net.hang = true;
    const t0 = Date.now();
    // (waitUntil(network) never settles while the network hangs; only the response must not.)
    const { res } = await Promise.race([
      sw.navigate("/t/trip1", false),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("SW waited forever")), 2000)),
    ]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await text(res)).toContain("network /t/trip1");
  });

  it("a 5xx from the server falls back to the cached page", async () => {
    const sw = loadSw();
    await sw.navigate("/t/trip1");
    sw.net.handler = () => html("Bad gateway", 502);
    expect(await text((await sw.navigate("/t/trip1")).res)).toContain("network /t/trip1");
    // Errors are not cached over the good copy.
    sw.net.online = false;
    expect(await text((await sw.navigate("/t/trip1")).res)).toContain("network /t/trip1");
  });

  it("static assets and icons are cache-first", async () => {
    const sw = loadSw();
    sw.net.handler = (req) => new Response(`asset ${new URL(req.url).pathname}`, { status: 200, headers: { "content-type": "application/javascript" } });
    for (const p of ["/_next/static/chunks/app.js", "/icon-192.png", "/apple-icon?x1"]) {
      const first = await sw.get(p, "cors");
      expect(first.handled).toBe(true);
      expect(await text(first.res)).toContain("asset");
    }
    const before = sw.net.requests.length;
    sw.net.online = false;
    const again = await sw.get("/_next/static/chunks/app.js", "cors");
    expect(await text(again.res)).toBe("asset /_next/static/chunks/app.js");
    expect(sw.net.requests.length).toBe(before);
  });

  it("photos (local and Supabase public objects) are cache-first", async () => {
    const sw = loadSw();
    const supa = "https://abc.supabase.co/storage/v1/object/public/photos/trips/t/drinks/u.jpg";
    let uploaded = false;
    sw.net.handler = (req) => {
      if (req.url.startsWith(ORIGIN)) return new Response("local-photo", { status: 200 });
      // Supabase answers CORS requests with a real status.
      expect(req.mode).toBe("cors");
      return uploaded ? new Response("supa-photo", { status: 200 }) : new Response("missing", { status: 404 });
    };
    // Not uploaded yet: 404 is passed through but NOT cached...
    expect(((await sw.get(supa)).res as Response).status).toBe(404);
    uploaded = true;
    // ...so once it exists it shows up, and is cached from then on.
    expect(await text((await sw.get(supa)).res)).toBe("supa-photo");
    expect((await sw.get("/api/photos/trips/t/drinks/u.jpg")).handled).toBe(true);
    sw.net.online = false;
    expect(await text((await sw.get(supa)).res)).toBe("supa-photo");
    expect(await text((await sw.get("/api/photos/trips/t/drinks/u.jpg")).res)).toBe("local-photo");
  });

  it("falls back to an opaque photo response when CORS isn't available, but never caches it (it may hide a 404)", async () => {
    const sw = loadSw();
    const supa = "https://abc.supabase.co/storage/v1/object/public/photos/trips/t/posts/p.jpg";
    const opaque: Res = { type: "opaque", ok: false, status: 0, redirected: false, headers: new Headers(), clone: () => opaque };
    sw.net.handler = (req) => {
      if (req.mode === "cors") throw new TypeError("CORS blocked");
      return opaque;
    };
    expect((await sw.get(supa)).res).toBe(opaque);
    expect(sw.caches.caches.get("scramble-photos-v1")?.entries.size ?? 0).toBe(0);
    sw.net.online = false;
    expect(((await sw.get(supa)).res as Response).status).toBe(504);
  });

  it("never caches a 404 or 5xx photo: the next view refetches it", async () => {
    const sw = loadSw();
    const local = "/api/photos/trips/t/drinks/late.jpg";
    let status = 404;
    sw.net.handler = () => (status === 200 ? new Response("late-photo", { status: 200 }) : new Response("nope", { status }));
    expect(((await sw.get(local)).res as Response).status).toBe(404);
    status = 503;
    expect(((await sw.get(local)).res as Response).status).toBe(503);
    expect(sw.caches.caches.get("scramble-photos-v1")?.entries.size ?? 0).toBe(0);
    status = 200;
    expect(await text((await sw.get(local)).res)).toBe("late-photo");
    sw.net.online = false;
    expect(await text((await sw.get(local)).res)).toBe("late-photo");
  });

  it("a non-OK photo left in the cache by an older version is refetched (and kept only as a last resort)", async () => {
    const sw = loadSw();
    const supa = "https://abc.supabase.co/storage/v1/object/public/photos/trips/t/ctp/c.jpg";
    const opaque: Res = { type: "opaque", ok: false, status: 0, redirected: false, headers: new Headers(), clone: () => opaque };
    await (await sw.caches.open("scramble-photos-v1")).put(supa, opaque);
    sw.net.handler = () => new Response("real-photo", { status: 200 });
    expect(await text((await sw.get(supa)).res)).toBe("real-photo");
    expect(sw.net.requests).toHaveLength(1);
    sw.net.online = false;
    expect(await text((await sw.get(supa)).res)).toBe("real-photo");
    // Offline with only the stale entry: better than nothing.
    await (await sw.caches.open("scramble-photos-v1")).put(supa, opaque);
    expect((await sw.get(supa)).res).toBe(opaque);
  });

  it("web manifests (the root one and each trip's) are network-first and work offline", async () => {
    const sw = loadSw();
    let name = "Scramble";
    sw.net.handler = (req) =>
      new Response(JSON.stringify({ name, start_url: new URL(req.url).pathname }), { status: 200, headers: { "content-type": "application/manifest+json" } });
    for (const p of ["/manifest.webmanifest", "/t/abc123/manifest.webmanifest"]) {
      const first = await sw.get(p, "cors");
      expect(first.handled).toBe(true);
      expect(JSON.parse(await text(first.res))).toMatchObject({ name: "Scramble" });
    }
    // Renamed: the network copy wins while online...
    name = "Bachelor Open";
    expect(JSON.parse(await text((await sw.get("/t/abc123/manifest.webmanifest", "cors")).res))).toMatchObject({ name: "Bachelor Open" });
    // ...and the last copy is served with no signal (or when the server errors).
    sw.net.online = false;
    expect(JSON.parse(await text((await sw.get("/t/abc123/manifest.webmanifest", "cors")).res))).toMatchObject({ name: "Bachelor Open" });
    sw.net.online = true;
    sw.net.handler = () => new Response("down", { status: 502 });
    expect(JSON.parse(await text((await sw.get("/manifest.webmanifest", "cors")).res))).toMatchObject({ name: "Scramble" });
  });

  it("API calls, non-GET and cross-origin requests go straight to the network", async () => {
    const sw = loadSw();
    expect((await sw.get("/api/t/abc/state", "cors")).handled).toBe(false);
    expect((await sw.dispatch("fetch", { request: { url: ORIGIN + "/api/t/abc/sync", method: "POST", mode: "cors", headers: new Headers() } })).handled).toBe(false);
    expect((await sw.get("https://elsewhere.test/x.js", "cors")).handled).toBe(false);
  });

  it("'warm' caches the given page (without search) and assets", async () => {
    const sw = loadSw();
    sw.net.handler = (req) =>
      req.url.includes("/_next/static/") ? new Response("chunk", { status: 200 }) : html(`warmed ${new URL(req.url).pathname}`);
    await sw.dispatch("message", {
      data: { type: "warm", urls: [ORIGIN + "/t/abc?x=1", ORIGIN + "/_next/static/chunks/a.js", ORIGIN + "/t/abc/manifest.webmanifest", "https://cdn.other/x.js", ORIGIN + "/api/t/abc/state"] },
    });
    expect(sw.caches.page(ORIGIN + "/t/abc")).toBeDefined();
    expect(sw.caches.caches.get("scramble-static-v1")?.entries.has(ORIGIN + "/_next/static/chunks/a.js")).toBe(true);
    expect(sw.caches.caches.get("scramble-static-v1")?.entries.has(ORIGIN + "/t/abc/manifest.webmanifest")).toBe(true);
    expect(sw.net.requests.some((u) => u.includes("cdn.other") || u.includes("/api/"))).toBe(false);
  });

  it("push shows a notification with tag, icon and url", async () => {
    const sw = loadSw();
    await sw.dispatch("push", { data: { json: () => ({ title: "👻 Ghost beer!", body: "Team B just got a free one", url: "/t/abc?tab=feed", tag: "ghost:1" }) } });
    expect(sw.notifications).toEqual([
      { title: "👻 Ghost beer!", options: { body: "Team B just got a free one", icon: "/icon-192.png", badge: "/icon-192.png", data: { url: "/t/abc?tab=feed" }, tag: "ghost:1" } },
    ]);
    await sw.dispatch("push", {
      data: {
        json: () => {
          throw new Error("not json");
        },
        text: () => "plain text push",
      },
    });
    expect(sw.notifications[1]).toMatchObject({ title: "Scramble", options: { body: "plain text push" } });
  });

  it("notification click focuses an open window for the URL, else opens one", async () => {
    const sw = loadSw();
    let closed = 0;
    const note = (url: string) => ({ notification: { close: () => void closed++, data: { url } } });
    await sw.dispatch("notificationclick", note("/t/abc?tab=feed"));
    expect(sw.opened).toEqual([ORIGIN + "/t/abc?tab=feed"]);
    const focused: string[] = [];
    const messages: unknown[] = [];
    sw.windows.push({ url: ORIGIN + "/t/abc", focus: async () => void focused.push("abc"), postMessage: (m) => void messages.push(m) });
    await sw.dispatch("notificationclick", note("/t/abc?tab=feed"));
    expect(focused).toEqual(["abc"]);
    expect(messages).toEqual([{ type: "open-url", url: ORIGIN + "/t/abc?tab=feed" }]);
    expect(sw.opened).toHaveLength(1);
    expect(closed).toBe(2);
  });
});
