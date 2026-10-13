import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectPlatform,
  forgetTrip,
  getRecentTrips,
  isGetSetUpHidden,
  normalizeTripCode,
  readPref,
  rememberTrip,
  setGetSetUpHidden,
  writePref,
  getSetUpHiddenKey,
  RECENT_TRIPS_KEY,
} from "@/lib/client/ui-prefs";

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe("normalizeTripCode", () => {
  it("accepts codes and pasted links", () => {
    expect(normalizeTripCode("k7m2qx9fpt")).toBe("k7m2qx9fpt");
    expect(normalizeTripCode("  K7M2-QX9F pt ")).toBe("k7m2qx9fpt");
    expect(normalizeTripCode("https://scramble.app/t/k7m2qx9fpt?tab=play")).toBe("k7m2qx9fpt");
    expect(normalizeTripCode("scramble.app/t/abc123#x")).toBe("abc123");
  });

  it("rejects junk and anything that could become a weird URL", () => {
    expect(normalizeTripCode("")).toBeNull();
    expect(normalizeTripCode(null)).toBeNull();
    expect(normalizeTripCode("!!")).toBeNull();
    expect(normalizeTripCode("javascript:alert(1)")).toBe("javascriptalert1");
    expect(normalizeTripCode("x".repeat(80))).toBeNull();
  });
});

describe("prefs with localStorage", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("'Get set up' card hidden flag (per trip on this device: hiding it on the dry run keeps it on Saturday's trip)", () => {
    expect(isGetSetUpHidden("dryrun")).toBe(false);
    setGetSetUpHidden("dryrun");
    expect(isGetSetUpHidden("dryrun")).toBe(true);
    expect(storage.getItem(getSetUpHiddenKey("dryrun"))).toBe("1");
    expect(isGetSetUpHidden("realtrip")).toBe(false);
    setGetSetUpHidden("dryrun", false);
    expect(isGetSetUpHidden("dryrun")).toBe(false);
    expect(storage.getItem(getSetUpHiddenKey("dryrun"))).toBeNull();
  });

  it("recent trips: most recent first, dedupe, keeps name, capped", () => {
    rememberTrip("aaa111", "Trip A", 1);
    rememberTrip("bbb222", "Trip B", 2);
    rememberTrip("AAA111", undefined, 3);
    let list = getRecentTrips();
    expect(list.map((t) => t.code)).toEqual(["aaa111", "bbb222"]);
    expect(list[0].name).toBe("Trip A");
    for (let i = 0; i < 10; i++) rememberTrip(`ccc${i}00`, `C${i}`, 10 + i);
    list = getRecentTrips();
    expect(list).toHaveLength(6);
    expect(list[0].code).toBe("ccc900");
    forgetTrip("ccc900");
    expect(getRecentTrips()[0].code).toBe("ccc800");
  });

  it("survives corrupt storage", () => {
    writePref(RECENT_TRIPS_KEY, "{not json");
    expect(getRecentTrips()).toEqual([]);
    writePref(RECENT_TRIPS_KEY, JSON.stringify([{ code: 5 }, null, { code: "ok123", name: 7, at: "x" }]));
    expect(getRecentTrips()).toEqual([{ code: "ok123", name: null, at: 0 }]);
  });

  it("never throws when storage throws", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("QuotaExceeded");
        },
        removeItem: () => {
          throw new Error("nope");
        },
      },
    });
    expect(readPref("x")).toBeNull();
    expect(() => writePref("x", "1")).not.toThrow();
    expect(() => rememberTrip("abc123", "A")).not.toThrow();
    expect(isGetSetUpHidden("abc123")).toBe(false);
    expect(() => setGetSetUpHidden("abc123")).not.toThrow();
  });

  it("works without window (SSR)", () => {
    vi.unstubAllGlobals();
    expect(readPref("x")).toBeNull();
    expect(getRecentTrips()).toEqual([]);
  });
});

describe("detectPlatform", () => {
  it("detects iOS (including iPadOS posing as Mac) and Android", () => {
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("other");
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5)).toBe("android");
  });
});
