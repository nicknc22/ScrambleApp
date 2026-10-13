// Server-render feed cards: variants, posts, reactions, delete affordance, pending photo.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeedEvent, FeedEventType } from "@/lib/types";
import { derive } from "@/lib/engine";
import { renderFeedEvent } from "@/lib/events/templates";
import { makeTrip, at } from "../fixtures";
import { FeedCard, type FeedCardProps } from "@/components/feed/FeedCard";
import { ReactionBar } from "@/components/feed/ReactionBar";
import { emptyReactionSummary, summarizeReactions } from "@/components/feed/model";

const f = makeTrip({ teams: [2, 2] });
const d = derive(f.state);

function ev(type: FeedEventType, extra: Partial<FeedEvent> = {}): FeedEvent {
  return {
    id: `ev-${type}`,
    trip_id: f.state.trip.id,
    type,
    team_id: f.team.A,
    player_id: null,
    actor_id: null,
    payload: {},
    photo_path: null,
    text: null,
    dedupe_key: null,
    created_at: at(0),
    updated_at: at(0),
    deleted_at: null,
    ...extra,
  };
}

function card(e: FeedEvent, over: Partial<FeedCardProps> = {}) {
  const props: FeedCardProps = {
    ev: e,
    r: renderFeedEvent(e, f.state, d),
    author: e.player_id ? (d.playerById[e.player_id] ?? null) : null,
    team: e.team_id ? (d.teamById[e.team_id] ?? null) : null,
    nowMs: Date.parse(at(5)),
    photoSrc: e.photo_path ? `/api/photos/${e.photo_path}` : null,
    pending: false,
    reactions: emptyReactionSummary(),
    meId: f.player.A1,
    canDelete: false,
    nameOf: (id) => d.playerById[id]?.name ?? "?",
    onReact: () => {},
    onMenu: () => {},
    onOpenPhoto: () => {},
    ...over,
  };
  return renderToStaticMarkup(<FeedCard {...props} />);
}

describe("FeedCard", () => {
  it("AI roast shows the label and the roast text", () => {
    const html = card(ev("roast", { text: "Three putts from four feet. Art.", payload: { trigger_event_id: "x" } }));
    expect(html).toContain("AI Roast");
    expect(html).toContain("Three putts from four feet. Art.");
    expect(html).toContain('data-type="roast"');
  });

  it("commissioner override is styled as a warning", () => {
    const html = card(ev("commissioner_override", { actor_id: f.player.A1, payload: { op_type: "drink.move", summary: "moved a drink from hole 6 to hole 7" } }));
    expect(html).toContain("Commissioner override");
    expect(html).toContain("moved a drink from hole 6 to hole 7");
    expect(html).toContain("repeating-linear-gradient");
  });

  it("big events get the oversized card", () => {
    const html = card(ev("groom_mulligan", { payload: { mulligan_id: "m", hole: 5, source: "groom", used_by: f.player.A1, groom_id: f.player.A1 } }));
    expect(html).toContain('data-big="true"');
    expect(html).toContain("loud");
  });

  it("player post: author, text, relative time, photo, uploading badge while pending", () => {
    const post = ev("post", { player_id: f.player.B1, actor_id: f.player.B1, team_id: f.team.B, text: "Nice shank", photo_path: "trips/t/posts/p.jpg" });
    const html = card(post, { pending: true, canDelete: true });
    expect(html).toContain("Player B1");
    expect(html).toContain("Nice shank");
    expect(html).toContain(">5m<");
    expect(html).toContain('data-testid="feed-photo"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('data-testid="photo-uploading"');
    expect(html).toContain('data-testid="feed-menu"');
    const done = card(post);
    expect(done).not.toContain("photo-uploading");
    expect(done).not.toContain("feed-menu");
  });
});

describe("ReactionBar", () => {
  it("shows counts and highlights mine", () => {
    const s = summarizeReactions(
      [
        { id: "1", trip_id: "t", feed_event_id: "e", player_id: "me", kind: "fire", created_at: at(0), deleted_at: null },
        { id: "2", trip_id: "t", feed_event_id: "e", player_id: "bob", kind: "fire", created_at: at(0), deleted_at: null },
        { id: "3", trip_id: "t", feed_event_id: "e", player_id: "bob", kind: "clown", created_at: at(0), deleted_at: null },
      ],
      "me",
    ).get("e")!;
    const html = renderToStaticMarkup(<ReactionBar summary={s} onToggle={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(6);
    expect(html).toContain('aria-pressed="true" aria-label="Fire, 2, yours"');
    expect(html).toContain('aria-pressed="false" aria-label="Clown, 1"');
    expect(html).toContain('aria-label="GOAT"');
  });
});
