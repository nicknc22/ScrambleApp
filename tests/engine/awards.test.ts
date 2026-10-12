import { describe, expect, it } from "vitest";
import { derive } from "@/lib/engine";
import { computeAwards } from "@/lib/engine/awards";
import type { Award, AwardKey } from "@/lib/engine/types";
import { JACK_FROST_HOLES } from "@/lib/course";
import type { FeedEvent, FeedEventType } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "../fixtures";

const PAR: Record<number, number> = Object.fromEntries(JACK_FROST_HOLES.map((h) => [h.number, h.par]));

const KEYS: AwardKey[] = [
  "champions",
  "didnt_need_the_beer",
  "most_drinks",
  "ghost_whisperers",
  "longest_drive",
  "closest_pin",
  "biggest_beer_save",
  "worst_hole",
  "mulligan_merchant",
  "edit_bandit",
  "most_suspicious",
];
const TITLES = [
  "Champions",
  "Didn't Need the Beer",
  "Most Drinks",
  "Ghost Whisperers",
  "Longest Drive",
  "Closest Pin",
  "Biggest Beer Save",
  "Worst Hole",
  "Mulligan Merchant",
  "Edit Bandit",
  "Most Suspicious",
];

function awards(f: TripFixture): Record<AwardKey, Award> {
  const list = derive(f.state, { strict: true }).awards;
  expect(list.map((a) => a.key)).toEqual(KEYS);
  return Object.fromEntries(list.map((a) => [a.key, a])) as Record<AwardKey, Award>;
}

/** Scores every hole at par, with per-hole overrides. */
function card(f: TripFixture, team: string, overrides: Record<number, number> = {}) {
  for (let h = 1; h <= 18; h++) f.score(team, h, overrides[h] ?? PAR[h]);
  f.teeOff(team, 18);
  f.complete(team);
}

let feedSeq = 0;
function feed(f: TripFixture, type: FeedEventType, actor: string | null, deleted = false) {
  const row: FeedEvent = {
    id: `feed-${++feedSeq}`,
    trip_id: f.state.trip.id,
    type,
    team_id: null,
    player_id: actor ? f.player[actor] : null,
    actor_id: actor ? f.player[actor] : null,
    payload: {},
    photo_path: null,
    text: null,
    dedupe_key: null,
    created_at: at(100 + feedSeq),
    updated_at: at(100 + feedSeq),
    deleted_at: deleted ? at(200) : null,
  };
  f.state = { ...f.state, feed_events: [...f.state.feed_events, row] };
}

describe("computeAwards", () => {
  it("nobody qualifies before the round: every card unawarded with an empty label, titles exact", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const list = derive(f.state, { strict: true }).awards;
    expect(list.map((a) => a.key)).toEqual(KEYS);
    expect(list.map((a) => a.title)).toEqual(TITLES);
    for (const a of list) {
      expect(a).toMatchObject({ awarded: false, value_label: "", team_ids: [], player_ids: [], photo_path: null });
      expect(a.emoji.length).toBeGreaterThan(0);
    }
  });

  it("a full round produces every award", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "final" });
    // Drinks. A (4): every drink worth 1. B (3): 1, 1, 2, 1, 1, 2. C (3): one drink.
    f.teeOff("A", 1);
    f.teeOff("B", 1);
    f.teeOff("C", 1);
    f.drink("A", "A1", 3);
    f.drink("A", "A1", 3);
    f.drink("A", "A2", 5, "shotgun");
    f.drink("B", "B1", 7);
    f.drink("B", "B1", 7);
    f.drink("B", "B1", 7, "drink", { photo: "trips/x/drink/1.jpg" }); // ghost beer: hole 7 credit = 4
    f.drink("B", "B2", 8, "shot");
    f.drink("B", "B3", 9);
    f.drink("B", "B1", 10, "shotgun"); // ghost beer #2
    f.drink("C", "C1", 1);
    // Scores: A 73 gross (70 net), B 77 gross with a 9 on hole 7 (69 net), C 71 gross (70 net).
    card(f, "A", { 1: 5 });
    card(f, "B", { 7: 9 });
    card(f, "C", { 2: 3 });
    // Mulligans: B used two, A one; a deleted use doesn't count.
    f.mulligan("A", 5, "earned");
    f.mulligan("B", 8, "earned");
    f.mulligan("B", 10, "earned");
    const undone = f.mulligan("A", 6, "groom");
    f.state = { ...f.state, mulligans: f.state.mulligans.map((m) => (m.id === undone ? { ...m, deleted_at: at(300) } : m)) };
    f.mulligan("A", 7, "earned");
    f.state = { ...f.state, mulligans: f.state.mulligans.map((m, i, arr) => (i === arr.length - 1 ? { ...m, deleted_at: at(301) } : m)) };
    // Contests.
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 300, photo_path: "trips/x/ld/a1.jpg" });
    f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 280 });
    f.entry({ hole: 9, player_id: f.player.C1, type: "ld", distance_value: 340, status: "flagged", flag_reason: "GPS was weak" });
    f.entry({ hole: 12, player_id: f.player.B2, type: "ld", distance_value: 299 });
    f.entry({ hole: 3, player_id: f.player.C2, type: "ctp", distance_value: 4.5, photo_path: "trips/x/ctp/c2.jpg", ai_suspicious: true });
    f.entry({ hole: 8, player_id: f.player.A3, type: "ctp", distance_value: 6, ai_suspicious: true });
    f.entry({ hole: 11, player_id: f.player.A3, type: "ctp", distance_value: 2, status: "flagged", flag_reason: "AI says 30 ft", ai_suspicious: true });
    f.entry({ hole: 16, player_id: f.player.B3, type: "ctp", distance_value: 1, ai_suspicious: true, deleted_at: at(400) });
    // Score edits: B2 three (plus a deleted one), A1 two; posts don't count.
    for (let i = 0; i < 3; i++) feed(f, "score_edit", "B2");
    feed(f, "score_edit", "B2", true);
    feed(f, "score_edit", "A1");
    feed(f, "score_edit", "A1");
    for (let i = 0; i < 5; i++) feed(f, "post", "A1");
    feed(f, "score_edit", null);

    const a = awards(f);
    const T = f.team;
    const P = f.player;

    expect(a.champions).toMatchObject({ awarded: true, team_ids: [T.B], player_ids: [], value_label: "-3 net" });
    expect(a.champions.detail).toContain("69 net");
    expect(a.didnt_need_the_beer).toMatchObject({ awarded: true, team_ids: [T.C], value_label: "-1 gross" });
    expect(a.most_drinks).toMatchObject({ awarded: true, player_ids: [P.B1], team_ids: [], value_label: "4 drinks (1 shotgun)" });
    expect(a.ghost_whisperers).toMatchObject({ awarded: true, team_ids: [T.B], value_label: "2 ghost beers" });
    expect(a.longest_drive).toMatchObject({ awarded: true, player_ids: [P.A1], team_ids: [T.A], value_label: "300 yd", photo_path: "trips/x/ld/a1.jpg" });
    expect(a.longest_drive.detail).toContain("Hole 4");
    expect(a.closest_pin).toMatchObject({ awarded: true, player_ids: [P.C2], value_label: `4' 6"`, photo_path: "trips/x/ctp/c2.jpg" });
    expect(a.closest_pin.detail).toContain("Hole 3");
    expect(a.biggest_beer_save).toMatchObject({ awarded: true, team_ids: [T.B], value_label: "Team B, hole 7: 4 strokes of beer" });
    expect(a.worst_hole).toMatchObject({ awarded: true, team_ids: [T.B], value_label: "Team B, hole 7: 9 (+5)" });
    expect(a.mulligan_merchant).toMatchObject({ awarded: true, team_ids: [T.B], value_label: "2 mulligans" });
    expect(a.edit_bandit).toMatchObject({ awarded: true, player_ids: [P.B2], value_label: "3 score edits" });
    expect(a.most_suspicious).toMatchObject({ awarded: true, player_ids: [P.A3], value_label: "2 AI flags" });
    for (const k of KEYS) expect(a[k].detail).toBeTruthy();
    // Photos only on the two contest awards.
    for (const k of KEYS.filter((k) => k !== "longest_drive" && k !== "closest_pin")) expect(a[k].photo_path).toBeNull();
  });

  it("ties share awards", () => {
    const f = makeTrip({ teams: [2, 2, 2] });
    card(f, "A", { 1: 6 }); // 74 gross, a 6 on a par 4 (+2)
    card(f, "B", { 3: 5 }); // 74 gross, its worst is a 5 on a par 3 (+2)
    card(f, "C", { 1: 6 }); // 74 gross: three-way tie
    f.drink("A", "A1", 2, "shot");
    f.drink("B", "B2", 2, "shotgun");
    f.drink("C", "C1", 2);
    // Twosomes: every drink is a ghost beer worth 2, so every team nets 72.
    f.entry({ hole: 4, player_id: f.player.A2, type: "ld", distance_value: 280.4 });
    f.entry({ hole: 9, player_id: f.player.B1, type: "ld", distance_value: 279.6, photo_path: "b1.jpg" });
    f.entry({ hole: 3, player_id: f.player.C1, type: "ctp", distance_value: 3 });
    f.entry({ hole: 8, player_id: f.player.A1, type: "ctp", distance_value: 3.01 });
    f.mulligan("A", 2, "earned");
    f.mulligan("B", 2, "earned");
    feed(f, "score_edit", "C2");
    feed(f, "score_edit", "A2");
    const a = awards(f);
    const T = f.team;
    const P = f.player;
    expect(a.champions).toMatchObject({ awarded: true, team_ids: [T.A, T.B, T.C], value_label: "E net" });
    expect(a.champions.detail).toContain("Dead heat");
    expect(a.didnt_need_the_beer.team_ids).toEqual([T.A, T.B, T.C]);
    expect(a.most_drinks).toMatchObject({ player_ids: [P.A1, P.B2, P.C1], value_label: "1 drink each" });
    expect(a.ghost_whisperers).toMatchObject({ team_ids: [T.A, T.B, T.C], value_label: "1 ghost beer" });
    expect(a.longest_drive).toMatchObject({ player_ids: [P.A2, P.B1], team_ids: [T.A, T.B], value_label: "280 yd", photo_path: "b1.jpg" });
    expect(a.longest_drive.detail).toContain("Hole 4 & 9");
    expect(a.closest_pin).toMatchObject({ player_ids: [P.A1, P.C1], value_label: `3' 0"` });
    expect(a.biggest_beer_save).toMatchObject({
      team_ids: [T.A, T.B, T.C],
      value_label: "Team A, hole 2; Team B, hole 2; Team C, hole 2: 2 strokes of beer",
    });
    expect(a.worst_hole).toMatchObject({ team_ids: [T.A, T.C], value_label: "Team A, hole 1; Team C, hole 1: 6 (+2)" });
    expect(a.mulligan_merchant).toMatchObject({ team_ids: [T.A, T.B], value_label: "1 mulligan" });
    expect(a.edit_bandit).toMatchObject({ player_ids: [P.A2, P.C2], value_label: "1 score edit" });
    expect(a.most_suspicious.awarded).toBe(false);
  });

  it("champions compares net to par when teams are through different numbers of holes", () => {
    const f = makeTrip({ teams: [2, 2] });
    // A: 9 holes, 2 over (net 38, +2). B: 3 holes, 1 under (net 10, -1). Raw net would pick B anyway;
    // make B's raw net higher than A's to prove net_to_par is used.
    for (let h = 1; h <= 9; h++) f.score("A", h, PAR[h] + (h <= 2 ? 1 : 0));
    for (let h = 1; h <= 12; h++) f.score("B", h, PAR[h] - (h === 1 ? 1 : 0));
    f.teeOff("A", 10);
    f.teeOff("B", 13);
    const a = awards(f);
    expect(a.champions).toMatchObject({ awarded: true, team_ids: [f.team.B], value_label: "-1 net" });
    expect(a.didnt_need_the_beer.team_ids).toEqual([f.team.B]);
  });

  it("same holes played: compares raw net (and raw gross)", () => {
    const f = makeTrip({ teams: [2, 2] });
    card(f, "A", { 1: 3 });
    card(f, "B", { 1: 6 });
    f.drink("B", "B1", 5);
    f.drink("B", "B2", 5);
    f.drink("B", "B1", 6);
    const a = awards(f);
    expect(a.champions).toMatchObject({ team_ids: [f.team.B], value_label: "-4 net" });
    expect(a.didnt_need_the_beer).toMatchObject({ team_ids: [f.team.A], value_label: "-1 gross" });
    expect(a.most_drinks).toMatchObject({ player_ids: [f.player.B1], value_label: "2 drinks" });
  });

  it("only valid contest entries win the contest awards; teams that haven't scored are skipped", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 500 }); // out of range
    f.entry({ hole: 18, player_id: f.player.B1, type: "ld", distance_value: 380, status: "flagged", flag_reason: "GPS was weak" });
    f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 0.5, status: "flagged", flag_reason: "photo is a bunker" });
    const a = awards(f);
    expect(a.longest_drive).toMatchObject({ awarded: false, value_label: "", player_ids: [], photo_path: null });
    expect(a.closest_pin.awarded).toBe(false);
    expect(a.champions.awarded).toBe(false);
    // A commissioner override makes the bomb count.
    f.state = {
      ...f.state,
      contest_entries: f.state.contest_entries.map((e) => (e.player_id === f.player.A1 ? { ...e, status: "overridden" as const } : e)),
    };
    expect(awards(f).longest_drive).toMatchObject({ awarded: true, player_ids: [f.player.A1], value_label: "500 yd" });
  });

  it("Edit Bandit ignores deleted events, other event types and unknown actors", () => {
    const f = makeTrip({ teams: [2, 2] });
    feed(f, "score_edit", "A1", true);
    feed(f, "post", "A2");
    feed(f, "score_notable", "B1");
    f.state = {
      ...f.state,
      feed_events: [...f.state.feed_events, { ...f.state.feed_events[0], id: "ghost-actor", actor_id: "no-such-player", deleted_at: null }],
    };
    expect(awards(f).edit_bandit).toMatchObject({ awarded: false, value_label: "", player_ids: [] });
  });

  it("Most Drinks breaks out shotguns and shots", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.drink("A", "A1", 1);
    for (let i = 0; i < 2; i++) f.drink("A", "A1", 1, "shotgun");
    f.drink("A", "A1", 2, "shot");
    for (let i = 0; i < 7; i++) f.drink("A", "A1", 3);
    expect(awards(f).most_drinks.value_label).toBe("11 drinks (2 shotguns, 1 shot)");
  });

  it("computeAwards can be called directly with derive() output", () => {
    const f = makeTrip({ teams: [2, 2] });
    card(f, "A");
    const d = derive(f.state, { strict: true });
    expect(computeAwards(f.state, d)).toEqual(d.awards);
  });
});
