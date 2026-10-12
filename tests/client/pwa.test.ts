import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
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
