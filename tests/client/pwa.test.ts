import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { GET as tripManifest } from "@/app/t/[code]/manifest.webmanifest/route";
import TripPage, { generateMetadata as tripPageMetadata } from "@/app/t/[code]/page";
import { createTestDb, setDbForTests, type Db, type DbConnection } from "@/lib/server/db";
import { createTrip } from "@/lib/server/trips";
import { GET as icon192 } from "@/app/icon-192.png/route";
import { GET as icon512 } from "@/app/icon-512.png/route";
import AppleIcon from "@/app/apple-icon";
import { collectWarmUrls, isEditing, shouldRegisterServiceWorker, SW_DEV_FLAG } from "@/lib/client/sw-register";
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

function pngSize(buf: Buffer) {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("web app manifest", () => {
  it("has the installable PWA basics", () => {
    const m = manifest();
    expect(m).toMatchObject({
      name: "Scramble",
      short_name: "Scramble",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#0a7d3e",
    });
    const icons = m.icons ?? [];
    for (const src of ["/icon-192.png", "/icon-512.png"]) {
      expect(icons.filter((i) => i.src === src).map((i) => i.purpose).sort()).toEqual(["any", "maskable"]);
    }
  });
});

describe("per-trip manifest (Home Screen icon opens the trip)", () => {
  let db: DbConnection;
  const params = (code: string) => ({ params: Promise.resolve({ code }) });
  const get = async (code: string, search = "") => {
    const res = await tripManifest(new Request(`http://localhost/t/${code}/manifest.webmanifest${search}`), params(code));
    return { res, body: res.ok ? ((await res.json()) as Record<string, unknown>) : null };
  };

  beforeAll(async () => {
    db = await createTestDb();
    setDbForTests(db);
    await createTrip(db, { code: "bachparty", name: "Jack Frost Scramble", app_name: "Bachelor Open", pin_hash: "scrypt:x:y" });
  });
  afterAll(async () => {
    setDbForTests(null);
    await db?.close();
  });

  it("starts at the trip, scoped to the whole app, named after the trip's app_name", async () => {
    const { res, body } = await get("BachParty");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    expect(body).toMatchObject({
      id: "/t/bachparty",
      start_url: "/t/bachparty?source=homescreen",
      scope: "/",
      name: "Bachelor Open",
      short_name: "Bachelor Open",
      display: "standalone",
      theme_color: "#0a7d3e",
    });
    expect(body!.icons).toEqual(manifest().icons);
  });

  it("carries ?me=<player> into start_url (so the Home Screen app knows who you are), same app id", async () => {
    const me = "3f2b8c1e-6a4d-4e7f-9b21-0c5d8e7f6a1b";
    const { body } = await get("bachparty", `?me=${me}`);
    expect(body).toMatchObject({ id: "/t/bachparty", start_url: `/t/bachparty?source=homescreen&me=${me}`, scope: "/", name: "Bachelor Open" });
    expect((await get("bachparty", `?me=${me.toUpperCase()}`)).body).toMatchObject({ start_url: `/t/bachparty?source=homescreen&me=${me}` });
  });

  it("ignores a missing, malformed or ambiguous me", async () => {
    const plain = "/t/bachparty?source=homescreen";
    for (const search of ["", "?me=", "?me=joe", "?me=%3Cscript%3E", "?me=3f2b8c1e6a4d4e7f9b210c5d8e7f6a1b", `?me=3f2b8c1e-6a4d-4e7f-9b21-0c5d8e7f6a1b&me=9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d`]) {
      const { res, body } = await get("bachparty", search);
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ id: "/t/bachparty", start_url: plain });
    }
  });

  it("falls back to 'Scramble' for an unknown trip or a database that doesn't answer in time", async () => {
    expect((await get("nosuchtrip")).body).toMatchObject({ name: "Scramble", start_url: "/t/nosuchtrip?source=homescreen" });
    const hanging: Db = { query: () => new Promise(() => undefined), tx: () => new Promise(() => undefined) };
    setDbForTests(hanging);
    try {
      const t0 = Date.now();
      const { body } = await get("bachparty");
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(body).toMatchObject({ name: "Scramble", id: "/t/bachparty" });
    } finally {
      setDbForTests(db);
    }
  });

  it("404s for something that can't be a trip code", async () => {
    expect((await get("x")).res.status).toBe(404);
  });

  it("the trip page links it without touching the database", async () => {
    const broken: Db = {
      query: () => Promise.reject(new Error("the page must not query")),
      tx: () => Promise.reject(new Error("the page must not query")),
    };
    setDbForTests(broken);
    try {
      expect(await tripPageMetadata(params("BachParty"))).toEqual({
        title: "Scramble",
        manifest: "/t/bachparty/manifest.webmanifest",
        // Static link-preview text (the image with the trip's name is ./opengraph-image.tsx).
        openGraph: {
          title: "You're in: the Scramble ⛳",
          description: "Open it, tap your name. Every beer you log knocks a stroke off your team's score.",
          type: "website",
        },
        twitter: {
          card: "summary_large_image",
          title: "You're in: the Scramble ⛳",
          description: "Open it, tap your name. Every beer you log knocks a stroke off your team's score.",
        },
      });
      const el = (await TripPage(params("%20BachParty"))) as { props: { code: string } };
      expect(el.props.code).toBe("bachparty");
    } finally {
      setDbForTests(db);
    }
  });
});

describe("icons", () => {
  it("render as PNGs of the right size", async () => {
    for (const [res, px] of [
      [icon192(), 192],
      [icon512(), 512],
      [AppleIcon(), 180],
    ] as const) {
      expect(res.headers.get("content-type")).toContain("image/png");
      const size = pngSize(Buffer.from(await res.arrayBuffer()));
      expect(size).toEqual({ width: px, height: px });
    }
  });
});

describe("service worker registration helpers", () => {
  it("registers in production, or in dev only with the opt-in flag", () => {
    const storage = new MemStorage();
    expect(shouldRegisterServiceWorker("production", storage)).toBe(true);
    expect(shouldRegisterServiceWorker("development", storage)).toBe(false);
    storage.setItem(SW_DEV_FLAG, "1");
    expect(shouldRegisterServiceWorker("development", storage)).toBe(true);
    expect(shouldRegisterServiceWorker("development", null)).toBe(false);
  });

  it("collects the page and its same-origin assets to warm", () => {
    const attrs = (list: Array<Record<string, string>>) => list.map((a) => ({ getAttribute: (k: string) => a[k] ?? null }));
    const doc = {
      querySelectorAll: (sel: string) =>
        (sel.startsWith("script")
          ? attrs([{ src: "/_next/static/chunks/main.js" }, { src: "https://cdn.other/x.js" }])
          : attrs([{ href: "/_next/static/css/app.css" }, { href: "/manifest.webmanifest" }, { href: "/icon?abc" }])) as unknown as NodeListOf<Element>,
    };
    const loc = { href: "https://scramble.test/t/abc?tab=feed", origin: "https://scramble.test" };
    const perf = {
      getEntriesByType: () =>
        [
          { name: "https://scramble.test/_next/static/chunks/lazy.js" },
          { name: "https://scramble.test/api/t/abc/state" },
          { name: "https://other.test/_next/static/x.js" },
        ] as unknown as PerformanceEntryList,
    };
    const urls = collectWarmUrls(doc, loc, perf);
    expect(urls).toEqual([
      "https://scramble.test/t/abc?tab=feed",
      "https://scramble.test/_next/static/chunks/main.js",
      "https://scramble.test/_next/static/css/app.css",
      "https://scramble.test/manifest.webmanifest",
      "https://scramble.test/icon?abc",
      "https://scramble.test/_next/static/chunks/lazy.js",
    ]);
  });

  it("never reloads under someone's thumbs: detects focused text inputs", () => {
    const doc = (el: Partial<HTMLInputElement> | null) => ({ activeElement: el }) as unknown as Document;
    expect(isEditing(doc(null))).toBe(false);
    expect(isEditing(doc({ tagName: "BUTTON" }))).toBe(false);
    expect(isEditing(doc({ tagName: "INPUT", type: "text" }))).toBe(true);
    expect(isEditing(doc({ tagName: "INPUT", type: "number" }))).toBe(true);
    expect(isEditing(doc({ tagName: "INPUT", type: "checkbox" }))).toBe(false);
    expect(isEditing(doc({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditing(doc({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });
});
