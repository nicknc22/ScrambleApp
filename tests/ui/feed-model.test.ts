// Feed view-model helpers: ordering, filters, relative times, reactions, permissions.
import { describe, expect, it } from "vitest";
import type { FeedEvent, FeedEventType, Reaction } from "@/lib/types";
import {
  canDeleteEvent,
  canSubmitPost,
  cardVariant,
  cleanPostText,
  deleteNeedsCommissioner,
  feedNow,
  matchesFilter,
  MAX_POST_CHARS,
  photoAspect,
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
  });
});
