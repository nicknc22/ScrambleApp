// Feed view-model helpers: ordering, filters, relative times, reactions, permissions.
import { describe, expect, it } from "vitest";
import type { FeedEvent, FeedEventType, Reaction } from "@/lib/types";
import {
  ALWAYS_BIG,
  canDeleteEvent,
  canSubmitPost,
  cardVariant,
  cleanPostText,
  deleteNeedsCommissioner,
  feedNow,
  isRecentEvent,
  matchesFilter,
  MAX_POST_CHARS,
  photoAspect,
  photoPlaceholder,
  photoRetryDelay,
  PHOTO_RETRY_DELAYS_MS,
  relativeTime,
  sortFeed,
  summarizeReactions,
} from "@/components/feed/model";

const T = "2026-10-24T17:00:00.000Z";
const later = (sec: number) => new Date(Date.parse(T) + sec * 1000).toISOString();

let n = 0;
function ev(type: FeedEventType, extra: Partial<FeedEvent> = {}): FeedEvent {
  n += 1;
  return {
    id: `ev-${String(n).padStart(4, "0")}`,
    trip_id: "trip",
    type,
    team_id: null,
    player_id: null,
    actor_id: null,
    payload: {},
    photo_path: null,
    text: null,
    dedupe_key: null,
    created_at: T,
    updated_at: T,
    deleted_at: null,
    ...extra,
  };
}

describe("sortFeed", () => {
  it("newest first, deleted rows dropped", () => {
    const a = ev("post", { created_at: later(0) });
    const b = ev("post", { created_at: later(60) });
    const c = ev("post", { created_at: later(30), deleted_at: later(40) });
    expect(sortFeed([a, b, c]).map((e) => e.id)).toEqual([b.id, a.id]);
  });

  it("same batch: consequences above causes (lead change > ghost beer > score > drinks)", () => {
    const drinks = ev("drinks", { payload: { hole: 3 } });
    const score = ev("score_notable", { payload: { hole: 3 } });
    const ghost = ev("ghost_beer", { payload: { hole: 3 } });
    const lead = ev("lead_change");
    const override = ev("commissioner_override");
    const out = sortFeed([drinks, score, lead, ghost, override]).map((e) => e.type);
    expect(out).toEqual(["commissioner_override", "lead_change", "ghost_beer", "score_notable", "drinks"]);
  });

  it("results_changed supersedes FINAL RESULTS (shown above it); removed sits with score edits", () => {
    const fin = ev("final_results");
    const changed = ev("results_changed");
    const removed = ev("removed", { payload: { kind: "drink", hole: 3 } });
    const drinks = ev("drinks", { payload: { hole: 3 } });
    expect(sortFeed([fin, removed, changed, drinks]).map((e) => e.type)).toEqual(["results_changed", "final_results", "removed", "drinks"]);
  });

  it("ties beyond type: updated_at desc, then hole desc, then later array position first", () => {
    const d1 = ev("drinks", { payload: { hole: 2 } });
    const d2 = ev("drinks", { payload: { hole: 2 }, updated_at: later(20) });
    const d3 = ev("drinks", { payload: { hole: 5 } });
    const d4 = ev("drinks", { payload: { hole: 2 } });
    expect(sortFeed([d1, d2, d3, d4]).map((e) => e.id)).toEqual([d2.id, d3.id, d4.id, d1.id]);
  });

  it("is stable for identical keys and doesn't mutate its input", () => {
    const xs = [ev("post"), ev("post"), ev("post")];
    const copy = [...xs];
    expect(sortFeed(xs).map((e) => e.id)).toEqual([xs[2].id, xs[1].id, xs[0].id]);
    expect(xs).toEqual(copy);
  });
});

describe("filters", () => {
  it("photos / scores / drinks / roasts", () => {
    const photo = ev("post", { photo_path: "trips/t/posts/x.jpg" });
    const text = ev("post", { text: "hi" });
    const edit = ev("score_edit");
    const ghost = ev("ghost_beer");
    const roast = ev("roast", { text: "lol" });
    expect(matchesFilter(photo, "photos")).toBe(true);
    expect(matchesFilter(text, "photos")).toBe(false);
    expect(matchesFilter(edit, "scores")).toBe(true);
    expect(matchesFilter(ghost, "scores")).toBe(false);
    expect(matchesFilter(ghost, "drinks")).toBe(true);
    expect(matchesFilter(roast, "roasts")).toBe(true);
    expect(matchesFilter(edit, "roasts", "alert")).toBe(false);
    expect(matchesFilter(edit, "roasts", "roast")).toBe(true);
    for (const e of [photo, text, edit, ghost, roast]) expect(matchesFilter(e, "all")).toBe(true);
  });

  it("results_changed is a score event (never a roast); removed files under what was removed", () => {
    const changed = ev("results_changed");
    expect(matchesFilter(changed, "scores")).toBe(true);
    expect(matchesFilter(changed, "drinks")).toBe(false);
    expect(matchesFilter(changed, "roasts", "roast")).toBe(false);
    const drink = ev("removed", { payload: { kind: "drink" } });
    const mulligan = ev("removed", { payload: { kind: "mulligan" } });
    const entry = ev("removed", { payload: { kind: "contest_entry" } });
    expect([drink, mulligan, entry].map((e) => [matchesFilter(e, "drinks"), matchesFilter(e, "scores")])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(matchesFilter(entry, "all")).toBe(true);
  });
});

describe("relativeTime / feedNow", () => {
  const now = Date.parse(T);
  it("formats seconds, minutes, hours, days, then a date", () => {
    expect(relativeTime(T, now + 30_000)).toBe("now");
    expect(relativeTime(T, now - 60_000)).toBe("now"); // future (clock skew)
    expect(relativeTime(T, now + 2 * 60_000)).toBe("2m");
    expect(relativeTime(T, now + 59 * 60_000)).toBe("59m");
    expect(relativeTime(T, now + 3 * 3600_000)).toBe("3h");
    expect(relativeTime(T, now + 2 * 86400_000)).toBe("2d");
    expect(relativeTime(T, now + 10 * 86400_000)).toMatch(/^Oct 2[34]$/);
    expect(relativeTime("garbage", now)).toBe("");
  });

  it("never runs behind the server clock", () => {
    expect(feedNow(1000, null)).toBe(1000);
    expect(feedNow(now - 5 * 60_000, T)).toBe(now);
    expect(feedNow(now + 1000, T)).toBe(now + 1000);
  });
});

describe("summarizeReactions", () => {
  const r = (feed_event_id: string, player_id: string, kind: Reaction["kind"], deleted = false): Reaction => ({
    id: `${feed_event_id}-${player_id}-${kind}`,
    trip_id: "trip",
    feed_event_id,
    player_id,
    kind,
    created_at: T,
    deleted_at: deleted ? T : null,
  });

  it("counts active reactions per kind, tracks mine and who", () => {
    const m = summarizeReactions(
      [r("e1", "me", "fire"), r("e1", "bob", "fire"), r("e1", "bob", "lol"), r("e1", "al", "dead", true), r("e2", "al", "goat"), r("e1", "me", "fire")],
      "me",
    );
    const e1 = m.get("e1")!;
    expect(e1.counts).toEqual({ fire: 2, lol: 1, beer: 0, dead: 0, goat: 0, clown: 0 });
    expect([...e1.mine]).toEqual(["fire"]);
    expect(e1.who.fire).toEqual(["me", "bob"]);
    expect(e1.total).toBe(3);
    expect(m.get("e2")!.mine.size).toBe(0);
    expect(m.has("e3")).toBe(false);
  });

  it("ignores unknown kinds and handles no viewer", () => {
    const bad = { ...r("e1", "x", "fire"), kind: "poop" } as unknown as Reaction;
    const m = summarizeReactions([bad, r("e1", "y", "beer")], null);
    expect(m.get("e1")!.total).toBe(1);
    expect(m.get("e1")!.mine.size).toBe(0);
  });
});

describe("permissions", () => {
  const mine = { type: "post" as const, player_id: "me" };
  const theirs = { type: "post" as const, player_id: "bob" };
  const auto = { type: "score_edit" as const, player_id: "me" };
  it("authors delete their own posts; the commissioner deletes anything", () => {
    expect(canDeleteEvent(mine, "me", false)).toBe(true);
    expect(canDeleteEvent(theirs, "me", false)).toBe(false);
    expect(canDeleteEvent(auto, "me", false)).toBe(false);
    expect(canDeleteEvent(theirs, null, false)).toBe(false);
    expect(canDeleteEvent(theirs, "me", true)).toBe(true);
    expect(canDeleteEvent(auto, null, true)).toBe(true);
  });
  it("deleteNeedsCommissioner", () => {
    expect(deleteNeedsCommissioner(mine, "me")).toBe(false);
    expect(deleteNeedsCommissioner(theirs, "me")).toBe(true);
    expect(deleteNeedsCommissioner(auto, "me")).toBe(true);
    expect(deleteNeedsCommissioner(mine, null)).toBe(true);
  });
});

describe("composer helpers", () => {
  it("cleanPostText / canSubmitPost", () => {
    expect(cleanPostText("  hi  ")).toBe("hi");
    expect(cleanPostText("   ")).toBeNull();
    expect(canSubmitPost("", false)).toBe(false);
    expect(canSubmitPost("   ", true)).toBe(true);
    expect(canSubmitPost("yo", false)).toBe(true);
    expect(canSubmitPost("x".repeat(MAX_POST_CHARS + 1), true)).toBe(false);
    expect(canSubmitPost(` ${"x".repeat(MAX_POST_CHARS)} `, false)).toBe(true);
  });

  it("photoAspect clamps between 4:5 and 16:9", () => {
    expect(photoAspect(0, 0)).toBeCloseTo(4 / 3);
    expect(photoAspect(1000, 750)).toBeCloseTo(4 / 3);
    expect(photoAspect(750, 4000)).toBeCloseTo(4 / 5);
    expect(photoAspect(4000, 500)).toBeCloseTo(16 / 9);
  });
});

describe("cardVariant", () => {
  it("type-specific looks win over the template tone", () => {
    expect(cardVariant("post", "info")).toBe("post");
    expect(cardVariant("roast", "roast")).toBe("ai_roast");
    expect(cardVariant("commissioner_override", "alert")).toBe("override");
    expect(cardVariant("ghost_beer", "fanfare")).toBe("ghost");
    expect(cardVariant("groom_mulligan", "fanfare")).toBe("groom");
    expect(cardVariant("final_results", "hype")).toBe("final");
    expect(cardVariant("lead_change", "hype")).toBe("lead");
    expect(cardVariant("score_notable", "roast")).toBe("roast");
    expect(cardVariant("drinks", "hype")).toBe("hype");
    expect(cardVariant("results_changed", "info")).toBe("results_changed");
    expect(cardVariant("removed", "info")).toBe("removed");
    expect(ALWAYS_BIG.has("results_changed")).toBe(true);
  });
});

describe("photos from other phones (finding: photo backfill placeholder stuck)", () => {
  it("retries a photo that didn't load with backoff for about 3 minutes, then waits for a snapshot or a tap", () => {
    expect(photoRetryDelay(0)).toBeNull();
    expect(photoRetryDelay(1)).toBe(3_000);
    const total = PHOTO_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(150_000);
    expect(total).toBeLessThanOrEqual(240_000);
    for (let i = 1; i < PHOTO_RETRY_DELAYS_MS.length; i++) expect(PHOTO_RETRY_DELAYS_MS[i]).toBeGreaterThanOrEqual(PHOTO_RETRY_DELAYS_MS[i - 1]);
    expect(photoRetryDelay(PHOTO_RETRY_DELAYS_MS.length + 1)).toBeNull();
  });

  it("a recent event's missing photo reads 'on its way', not 'didn't load'", () => {
    const now = Date.parse(T);
    expect(isRecentEvent(later(-60), now)).toBe(true);
    expect(isRecentEvent(later(-4 * 60), now)).toBe(true);
    expect(isRecentEvent(later(-6 * 60), now)).toBe(false);
    expect(isRecentEvent("garbage", now)).toBe(false);
    expect(photoPlaceholder({ uploadingHere: false, recent: true })).toMatchObject({ state: "coming", text: "Photo on its way…" });
    expect(photoPlaceholder({ uploadingHere: true, recent: false })).toMatchObject({ state: "uploading", text: "Uploading…" });
    expect(photoPlaceholder({ uploadingHere: false, recent: false })).toMatchObject({ state: "failed", text: "Photo didn't load. Tap to retry." });
  });
});
