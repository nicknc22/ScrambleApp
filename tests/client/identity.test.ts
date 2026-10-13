// Carrying "who you are" into the iPhone Home Screen app (separate storage from Safari).
import { describe, expect, it } from "vitest";
import {
  adoptMeFromLaunch,
  carriesIdentityInUrl,
  dropForeignMe,
  loadMe,
  meKey,
  parseMeParam,
  saveMe,
  syncHomeScreenIdentity,
  tripManifestHref,
  withMeParam,
  withoutForeignMe,
  type HomeScreenDom,
  type StorageLike,
} from "@/lib/client/identity";

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

const CODE = "bachparty";
const JOE = "3f2b8c1e-6a4d-4e7f-9b21-0c5d8e7f6a1b";
const GREG = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("parseMeParam", () => {
  it("accepts a uuid (lowercased), rejects everything else", () => {
    expect(parseMeParam(JOE)).toBe(JOE);
    expect(parseMeParam(JOE.toUpperCase())).toBe(JOE);
    expect(parseMeParam(` ${JOE} `)).toBe(JOE);
    expect(parseMeParam(null)).toBeNull();
    expect(parseMeParam(undefined)).toBeNull();
    expect(parseMeParam("")).toBeNull();
    expect(parseMeParam("joe")).toBeNull();
    expect(parseMeParam(`${JOE}x`)).toBeNull();
    expect(parseMeParam(JOE.replace(/-/g, ""))).toBeNull();
    expect(parseMeParam("<script>alert(1)</script>")).toBeNull();
  });
});

describe("adoptMeFromLaunch (first launch of the Home Screen app)", () => {
  it("adopts ?me= when running standalone with no player stored for this trip", () => {
    const storage = new MemStorage();
    expect(adoptMeFromLaunch({ code: CODE, search: `?source=homescreen&me=${JOE}`, standalone: true, platform: "ios", storage })).toBe(JOE);
    expect(loadMe(CODE, storage)).toBe(JOE);
  });

  it("never adopts in a normal browser tab (a copied link can't turn you into someone else)", () => {
    const storage = new MemStorage();
    expect(adoptMeFromLaunch({ code: CODE, search: `?me=${JOE}`, standalone: false, platform: "ios", storage })).toBeNull();
    expect(loadMe(CODE, storage)).toBeNull();
  });

  it("never overrides a player already stored on this device", () => {
    const storage = new MemStorage();
    saveMe(CODE, GREG, storage);
    expect(adoptMeFromLaunch({ code: CODE, search: `?me=${JOE}`, standalone: true, platform: "ios", storage })).toBeNull();
    expect(loadMe(CODE, storage)).toBe(GREG);
    // A stored identity for another trip doesn't count.
    expect(adoptMeFromLaunch({ code: "othertrip", search: `?me=${JOE}`, standalone: true, platform: "ios", storage })).toBe(JOE);
  });

  it("only on iOS: an installed Android/desktop app never adopts (it shares the browser's storage, and Android opens tapped links in it)", () => {
    expect(carriesIdentityInUrl("ios")).toBe(true);
    expect(carriesIdentityInUrl("android")).toBe(false);
    expect(carriesIdentityInUrl("other")).toBe(false);
    for (const platform of ["android", "other"] as const) {
      const storage = new MemStorage();
      // Caster copies his Safari address bar into the group chat; an Android phone with the app
      // installed opens it standalone: it must ask "Who are you?", not become Caster.
      for (const search of [`?tab=setup&me=${JOE}`, `?source=homescreen&me=${JOE}`]) {
        expect(adoptMeFromLaunch({ code: CODE, search, standalone: true, platform, storage })).toBeNull();
      }
      expect(loadMe(CODE, storage)).toBeNull();
    }
  });

  it("ignores a missing, malformed or ambiguous me", () => {
    const storage = new MemStorage();
    for (const search of ["", "?source=homescreen", "?me=", "?me=joe", `?me=${JOE}&me=${GREG}`, `?me=${JOE}&me=nope`]) {
      expect(adoptMeFromLaunch({ code: CODE, search, standalone: true, platform: "ios", storage })).toBeNull();
    }
    expect(storage.map.size).toBe(0);
    // The same id twice is still one player.
    expect(adoptMeFromLaunch({ code: CODE, search: `?me=${JOE}&me=${JOE.toUpperCase()}`, standalone: true, platform: "ios", storage })).toBe(JOE);
  });

  it("stores an id that isn't on the roster anyway (the shell treats it as stale -> join screen)", () => {
    const storage = new MemStorage();
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(adoptMeFromLaunch({ code: CODE, search: `?me=${ghost}`, standalone: true, platform: "ios", storage })).toBe(ghost);
    expect(storage.getItem(meKey(CODE))).toBe(ghost);
  });

  it("fails soft without storage or when storage throws", () => {
    expect(adoptMeFromLaunch({ code: CODE, search: `?me=${JOE}`, standalone: true, platform: "ios", storage: null })).toBeNull();
    const broken: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => undefined,
    };
    expect(adoptMeFromLaunch({ code: CODE, search: `?me=${JOE}`, standalone: true, platform: "ios", storage: broken })).toBeNull();
  });
});

describe("manifest href and ?me= in the address bar", () => {
  it("links the trip manifest with the player, or plain", () => {
    expect(tripManifestHref(CODE, JOE)).toBe(`/t/${CODE}/manifest.webmanifest?me=${JOE}`);
    expect(tripManifestHref(CODE, null)).toBe(`/t/${CODE}/manifest.webmanifest`);
    expect(tripManifestHref(CODE, "not-a-uuid")).toBe(`/t/${CODE}/manifest.webmanifest`);
  });

  it("sets or drops me, keeps every other param and the hash, null when unchanged", () => {
    expect(withMeParam(`/t/${CODE}`, JOE)).toBe(`/t/${CODE}?me=${JOE}`);
    expect(withMeParam(`/t/${CODE}?tab=feed&source=homescreen#x`, JOE)).toBe(`/t/${CODE}?tab=feed&source=homescreen&me=${JOE}#x`);
    expect(withMeParam(`/t/${CODE}?me=${GREG}&tab=feed`, JOE)).toBe(`/t/${CODE}?me=${JOE}&tab=feed`);
    expect(withMeParam(`/t/${CODE}?tab=feed&me=${JOE}`, JOE)).toBeNull();
    expect(withMeParam(`/t/${CODE}?tab=feed&me=${JOE}`, null)).toBe(`/t/${CODE}?tab=feed`);
    expect(withMeParam(`/t/${CODE}?me=${JOE}`, null)).toBe(`/t/${CODE}`);
    expect(withMeParam(`/t/${CODE}?tab=feed`, null)).toBeNull();
    // Duplicates collapse to one.
    expect(withMeParam(`/t/${CODE}?me=${JOE}&me=${JOE}`, JOE)).toBe(`/t/${CODE}?me=${JOE}`);
  });
});

describe("withoutForeignMe / dropForeignMe (before the trip loads)", () => {
  it("drops a me that isn't this phone's own player, keeps every other param", () => {
    expect(withoutForeignMe(`/t/${CODE}?tab=setup&me=${JOE}`, null)).toBe(`/t/${CODE}?tab=setup`);
    expect(withoutForeignMe(`/t/${CODE}?tab=setup&me=${JOE}`, GREG)).toBe(`/t/${CODE}?tab=setup`);
    expect(withoutForeignMe(`/t/${CODE}?me=garbage#x`, GREG)).toBe(`/t/${CODE}#x`);
    expect(withoutForeignMe(`/t/${CODE}?me=${JOE}&me=${GREG}`, JOE)).toBe(`/t/${CODE}`);
  });

  it("keeps this phone's own me, and leaves a URL without one alone", () => {
    expect(withoutForeignMe(`/t/${CODE}?tab=play&me=${JOE}`, JOE)).toBeNull();
    expect(withoutForeignMe(`/t/${CODE}?me=${JOE.toUpperCase()}`, JOE)).toBeNull();
    expect(withoutForeignMe(`/t/${CODE}?tab=play`, JOE)).toBeNull();
    expect(withoutForeignMe(`/t/${CODE}`, null)).toBeNull();
  });

  it("rewrites the address bar only when it has to, and never throws", () => {
    const f = fakeDom({ url: `/t/${CODE}?tab=setup&me=${JOE}` });
    dropForeignMe(GREG, f.dom);
    expect(f.replaced).toEqual([`/t/${CODE}?tab=setup`]);
    dropForeignMe(GREG, f.dom);
    expect(f.replaced).toHaveLength(1);
    const own = fakeDom({ url: `/t/${CODE}?me=${JOE}` });
    dropForeignMe(JOE, own.dom);
    expect(own.replaced).toEqual([]);
    expect(() => dropForeignMe(null, null)).not.toThrow();
    own.dom.history.replaceState = () => {
      throw new Error("SecurityError");
    };
    expect(() => dropForeignMe(null, own.dom)).not.toThrow();
  });
});

function fakeDom(opts: { links?: string[]; url?: string } = {}) {
  const links = (opts.links ?? [`/t/${CODE}/manifest.webmanifest`]).map((href) => {
    const attrs = new Map<string, string>([["href", href]]);
    return { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v) };
  });
  const appended: Array<{ rel: string; href: string }> = [];
  const replaced: string[] = [];
  const u = new URL(opts.url ?? `/t/${CODE}`, "https://scramble.test");
  const location = { pathname: u.pathname, search: u.search, hash: u.hash };
  const dom: HomeScreenDom = {
    document: {
      querySelectorAll: (sel: string) => (sel === 'link[rel="manifest"]' ? links : []),
      createElement: () => ({ rel: "", href: "" }) as unknown as HTMLLinkElement,
      head: { appendChild: (node: HTMLLinkElement) => appended.push({ rel: node.rel, href: node.href }) },
    },
    location,
    history: {
      replaceState: (_data, _unused, url) => {
        replaced.push(String(url));
        const next = new URL(String(url), "https://scramble.test");
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
      },
    },
  };
  return { dom, links, appended, replaced, location };
}

describe("syncHomeScreenIdentity", () => {
  it("points the manifest link and the URL at the player, idempotently", () => {
    const f = fakeDom({ url: `/t/${CODE}?tab=leaderboard` });
    syncHomeScreenIdentity(CODE, JOE, f.dom);
    expect(f.links[0].getAttribute("href")).toBe(`/t/${CODE}/manifest.webmanifest?me=${JOE}`);
    expect(f.replaced).toEqual([`/t/${CODE}?tab=leaderboard&me=${JOE}`]);
    syncHomeScreenIdentity(CODE, JOE, f.dom);
    expect(f.replaced).toHaveLength(1);
  });

  it("drops the param after Switch player", () => {
    const f = fakeDom({ links: [`/t/${CODE}/manifest.webmanifest?me=${JOE}`], url: `/t/${CODE}?me=${JOE}&tab=play` });
    syncHomeScreenIdentity(CODE, null, f.dom);
    expect(f.links[0].getAttribute("href")).toBe(`/t/${CODE}/manifest.webmanifest`);
    expect(f.replaced).toEqual([`/t/${CODE}?tab=play`]);
  });

  it("creates the manifest link when the page has none", () => {
    const f = fakeDom({ links: [] });
    syncHomeScreenIdentity(CODE, GREG, f.dom);
    expect(f.appended).toEqual([{ rel: "manifest", href: `/t/${CODE}/manifest.webmanifest?me=${GREG}` }]);
  });

  it("never throws (no DOM, or a DOM that throws)", () => {
    expect(() => syncHomeScreenIdentity(CODE, JOE, null)).not.toThrow();
    const f = fakeDom();
    f.dom.history.replaceState = () => {
      throw new Error("SecurityError");
    };
    f.dom.document.querySelectorAll = () => {
      throw new Error("nope");
    };
    expect(() => syncHomeScreenIdentity(CODE, JOE, f.dom)).not.toThrow();
  });
});
