import { describe, expect, it } from "vitest";
import { makeTrip, at } from "../fixtures";
import type { FeedEvent } from "@/lib/types";
import { defaultTab, isTabKey, resolveTab, tabAllowed, MAIN_TABS } from "@/components/shell/tabs";
import { activePlayers, formatTeeTime, rosterGroups, teamOfPlayer } from "@/components/shell/roster";
import { fanfareForEvent, FANFARE_MAX_AGE_MS } from "@/components/shell/feedFanfare";
import { bearingDeg, destinationPoint, pointFromTee, YARD_M } from "@/components/shell/geoMath";
import { countUnread, isFreshRejection, latestFeedAt, rejectionMessage } from "@/components/shell/hooks";
import { issueKind, syncIssuesChipText } from "@/components/shell/SyncIssues";
import { describeOp, loadSyncIssues, saveSyncIssues, syncIssuesKey, MAX_SYNC_ISSUES, type SyncIssue } from "@/lib/client/sync-issues";
import type { Op } from "@/lib/ops";
import { loadErrorKind } from "@/components/shell/Splash";
import { onboardingSteps } from "@/components/join/Onboarding";

describe("tabs", () => {
  const player = { isCommissioner: false, status: "live" as const };
  const commishSetup = { isCommissioner: true, status: "setup" as const };

  it("has the five bottom tabs in order", () => {
    expect(MAIN_TABS).toEqual(["play", "leaderboard", "feed", "contests", "money"]);
  });

  it("defaults to play, or setup for the commissioner during setup", () => {
    expect(defaultTab(player)).toBe("play");
    expect(defaultTab({ isCommissioner: false, status: "setup" })).toBe("play");
    expect(defaultTab(commishSetup)).toBe("setup");
    expect(defaultTab({ isCommissioner: true, status: "live" })).toBe("play");
  });

  it("only allows setup for the commissioner and awards once final", () => {
    expect(tabAllowed("setup", player)).toBe(false);
    expect(tabAllowed("setup", commishSetup)).toBe(true);
    expect(tabAllowed("awards", player)).toBe(false);
    expect(tabAllowed("awards", { isCommissioner: false, status: "final" })).toBe(true);
    expect(tabAllowed("money", player)).toBe(true);
  });

  it("resolves requested tabs with fallbacks", () => {
    expect(resolveTab("feed", player)).toBe("feed");
    expect(resolveTab(null, player)).toBe("play");
    expect(resolveTab("garbage", commishSetup)).toBe("setup");
    expect(resolveTab("setup", player)).toBe("play");
    // ?tab=setup starts working once the commissioner check comes back
    expect(resolveTab("setup", { isCommissioner: true, status: "live" })).toBe("setup");
    expect(resolveTab("awards", { isCommissioner: false, status: "final" })).toBe("awards");
  });

  it("isTabKey", () => {
    expect(isTabKey("awards")).toBe(true);
    expect(isTabKey("Play")).toBe(false);
    expect(isTabKey(undefined)).toBe(false);
  });
});

describe("roster", () => {
  it("groups players by team in order, skips empty teams, appends free agents", () => {
    const f = makeTrip({ teams: [4, 3], status: "setup" });
    const free = { ...f.state.players[0], id: "free-1", name: "Zed", is_groom: false, sort_order: 50 };
    f.state.players.push(free);
    f.state.teams.push({ ...f.state.teams[0], id: "empty-team", name: "Empty", sort_order: 9 });
    const groups = rosterGroups(f.state);
    expect(groups.map((g) => g.team?.name ?? null)).toEqual(["Team A", "Team B", null]);
    expect(groups[0].players).toHaveLength(4);
    expect(groups[2].players.map((p) => p.id)).toEqual(["free-1"]);
    const withEmpty = rosterGroups(f.state, { includeEmptyTeams: true });
    expect(withEmpty.map((g) => g.team?.name ?? null)).toEqual(["Team A", "Team B", "Empty", null]);
  });

  it("ignores deleted players and teams", () => {
    const f = makeTrip({ teams: [4, 3], status: "setup" });
    f.state.players[0].deleted_at = at(0);
    f.state.teams[1].deleted_at = at(0);
    expect(activePlayers(f.state)).toHaveLength(6);
    const groups = rosterGroups(f.state);
    expect(groups[0].players).toHaveLength(3);
    // Team B is deleted: its members become free agents
    expect(groups[groups.length - 1].team).toBeNull();
    expect(groups[groups.length - 1].players).toHaveLength(3);
    expect(teamOfPlayer(f.state, f.player.B1)).toBeNull();
    expect(teamOfPlayer(f.state, f.player.A2)?.id).toBe(f.team.A);
    expect(teamOfPlayer(f.state, null)).toBeNull();
  });

  it("formats tee times", () => {
    expect(formatTeeTime("12:50")).toBe("12:50 PM");
    expect(formatTeeTime("13:05")).toBe("1:05 PM");
    expect(formatTeeTime("00:10")).toBe("12:10 AM");
    expect(formatTeeTime("9:00")).toBe("9:00 AM");
    expect(formatTeeTime(null)).toBeNull();
    expect(formatTeeTime("soon")).toBe("soon");
  });
});

function ev(partial: Partial<FeedEvent> & Pick<FeedEvent, "type">): FeedEvent {
  return {
    id: "ev-1",
    trip_id: "t",
    team_id: "team-a",
    player_id: null,
    actor_id: "someone-else",
    payload: {},
    photo_path: null,
    text: null,
    dedupe_key: null,
    created_at: at(0),
    updated_at: at(0),
    deleted_at: null,
    ...partial,
  };
}

describe("feed fanfare", () => {
  const now = Date.parse(at(1));
  const ctx = { meId: "me", myTeamId: "team-a", nowMs: now };

  it("groom mulligan fanfares for everyone, keyed by event id", () => {
    const f = fanfareForEvent(ev({ type: "groom_mulligan", team_id: "team-b" }), ctx);
    expect(f?.tone).toBe("groom");
    expect(f?.key).toBe("ev-1");
  });

  it("ghost beers only for my team", () => {
    expect(fanfareForEvent(ev({ type: "ghost_beer", team_id: "team-a" }), ctx)?.tone).toBe("ghost");
    expect(fanfareForEvent(ev({ type: "ghost_beer", team_id: "team-b" }), ctx)).toBeNull();
    expect(fanfareForEvent(ev({ type: "ghost_beer" }), { ...ctx, myTeamId: null })).toBeNull();
  });

  it("skips my own actions, old events, deleted events and boring types", () => {
    expect(fanfareForEvent(ev({ type: "groom_mulligan", actor_id: "me" }), ctx)).toBeNull();
    expect(fanfareForEvent(ev({ type: "groom_mulligan" }), { ...ctx, nowMs: now + FANFARE_MAX_AGE_MS + 120_000 })).toBeNull();
    expect(fanfareForEvent(ev({ type: "groom_mulligan", deleted_at: at(1) }), ctx)).toBeNull();
    expect(fanfareForEvent(ev({ type: "drinks" }), ctx)).toBeNull();
  });

  it("uses rendered copy when available and survives a throwing renderer", () => {
    const f = fanfareForEvent(ev({ type: "final_results" }), { ...ctx, render: () => ({ emoji: "🏆", title: "x", body: "Fore Play wins" }) });
    expect(f?.subtitle).toBe("Fore Play wins");
    const g = fanfareForEvent(ev({ type: "groom_mulligan" }), {
      ...ctx,
      render: () => {
        throw new Error("not implemented");
      },
    });
    expect(g?.subtitle).toMatch(/do-over/);
  });
});

describe("geo math (GPS simulator)", () => {
  const tee = { lat: 41.0954, lng: -75.6716 };
  it("bearing north/east", () => {
    expect(bearingDeg(tee, { lat: 41.1, lng: -75.6716 })).toBeCloseTo(0, 3);
    expect(bearingDeg(tee, { lat: 41.0954, lng: -75.66 })).toBeCloseTo(90, 0);
  });

  it("destination point round-trips distance via haversine", () => {
    const p = destinationPoint(tee, 37, 250 * YARD_M);
    const R = 6371008.8;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(p.lat - tee.lat);
    const dLng = toRad(p.lng - tee.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(tee.lat)) * Math.cos(toRad(p.lat)) * Math.sin(dLng / 2) ** 2;
    const meters = 2 * R * Math.asin(Math.sqrt(a));
    expect(meters / YARD_M).toBeCloseTo(250, 3);
    expect(bearingDeg(tee, p)).toBeCloseTo(37, 3);
  });

  it("points toward the green, or north without one", () => {
    const green = { lat: 41.0954, lng: -75.665 }; // due east
    const p = pointFromTee(tee, green, 100);
    expect(bearingDeg(tee, p)).toBeCloseTo(90, 0);
    const q = pointFromTee(tee, null, 100);
    expect(q.lat).toBeGreaterThan(tee.lat);
    expect(q.lng).toBeCloseTo(tee.lng, 6);
  });
});

describe("feed unread", () => {
  it("counts events newer than seen, not mine, not deleted", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.state.feed_events = [
      ev({ id: "1", type: "drinks", created_at: at(1) }),
      ev({ id: "2", type: "drinks", created_at: at(2), actor_id: "me" }),
      ev({ id: "3", type: "drinks", created_at: at(3) }),
      ev({ id: "4", type: "drinks", created_at: at(4), deleted_at: at(5) }),
    ];
    expect(latestFeedAt(f.state)).toBe(at(3));
    expect(countUnread(f.state, null, "me")).toBe(2);
    expect(countUnread(f.state, at(1), "me")).toBe(1);
    expect(countUnread(f.state, at(3), "me")).toBe(0);
    expect(countUnread(null, null, "me")).toBe(0);
    expect(latestFeedAt(null)).toBeNull();
  });
});

describe("load errors and onboarding steps", () => {
  it("classifies load errors", () => {
    expect(loadErrorKind("No trip with that code. Double-check the link from the group chat.", true)).toBe("not_found");
    expect(loadErrorKind("No signal, and this trip isn't saved on this phone yet.", false)).toBe("offline");
    // the store reports offline after a 500; the message wins
    expect(loadErrorKind("The server is having a moment (500). Retrying…", false)).toBe("server");
    expect(loadErrorKind(null, false)).toBe("offline");
    expect(loadErrorKind(null, true)).toBe("server");
  });

  it("skips the install step when running standalone", () => {
    expect(onboardingSteps(false)).toEqual(["install", "location", "notify"]);
    expect(onboardingSteps(true)).toEqual(["location", "notify"]);
  });
});

describe("sync issues (changes the server refused)", () => {
  const f = makeTrip({ teams: [4, 3], status: "live" });
  f.state.players.find((p) => p.id === f.player.A2)!.nickname = "Moose";
  const base = { id: "op-1", at: at(0), by: f.player.A1 };
  const describe1 = (op: Record<string, unknown>) => describeOp({ ...base, ...op } as unknown as Op, f.state);

  it("describes ops for people, with names from the trip", () => {
    expect(describe1({ type: "score.set", team_id: f.team.A, hole: 6, strokes: 4 })).toBe("Hole 6 score: 4 · Team A");
    expect(describe1({ type: "drink.log", drink_id: "d", team_id: f.team.A, player_id: f.player.A2, hole: 3, drink_type: "shotgun", photo_path: null })).toBe(
      "Shotgun for Moose · hole 3",
    );
    expect(describe1({ type: "mulligan.use", mulligan_id: "m", team_id: f.team.B, hole: 5, source: "groom" })).toBe("Groom's Mulligan · hole 5 · Team B");
    expect(describe1({ type: "teeshot.set", team_id: f.team.A, hole: 2, player_id: f.player.A1 })).toBe("Hole 2 tee shot: Player A1 · Team A");
    expect(
      describe1({ type: "contest.submit", entry_id: "e", hole: 7, player_id: f.player.A1, contest_type: "ctp", distance_value: 12.5, angle_deg: null, lat: null, lng: null, gps_accuracy_m: null, low_accuracy: false, photo_path: null }),
    ).toBe("Closest to pin: 12.5 ft · Player A1 · hole 7");
    expect(describe1({ type: "post.create", event_id: "p", text: "  what a   ball  ", photo_path: null })).toBe("Post: “what a ball”");
    expect(describe1({ type: "drink.delete", drink_id: "missing" })).toBe("Undo a drink");
    expect(describe1({ type: "trip.finalize" })).toBe("Finalize results");
    // Unknown names don't break it.
    expect(describeOp({ ...base, type: "score.set", team_id: "gone", hole: 1, strokes: 3 } as Op, null)).toBe("Hole 1 score: 3");
  });

  it("round-trips through storage per trip (newest 20) and ignores junk", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    const issues: SyncIssue[] = Array.from({ length: 25 }, (_, i) => ({
      id: `op-${i}`,
      status: "rejected",
      code: "conflict",
      reason: "No",
      op_type: "score.set",
      description: `Hole ${i}`,
      at: at(i),
    }));
    saveSyncIssues("trip1", issues, storage);
    const back = loadSyncIssues("trip1", storage);
    expect(back).toHaveLength(MAX_SYNC_ISSUES);
    expect(back[0].id).toBe("op-5");
    expect(loadSyncIssues("trip2", storage)).toEqual([]);
    map.set(syncIssuesKey("trip3"), JSON.stringify([{ id: 1 }, null, back[0]]));
    expect(loadSyncIssues("trip3", storage)).toEqual([back[0]]);
    map.set(syncIssuesKey("trip4"), "{not json");
    expect(loadSyncIssues("trip4", storage)).toEqual([]);
    saveSyncIssues("trip1", [], storage);
    expect(map.has(syncIssuesKey("trip1"))).toBe(false);
    expect(loadSyncIssues("trip1", null)).toEqual([]);
  });

  it("toasts say what didn't save, and only fresh rejections toast", () => {
    expect(rejectionMessage({ description: "Hole 6 score: 4", reason: "Hole 6 already got a newer edit: 5", code: "conflict" })).toBe(
      "Hole 6 score: 4 — Hole 6 already got a newer edit: 5",
    );
    expect(rejectionMessage({ code: "not_live" })).toBe("The round isn't live, so that didn't count.");
    const mounted = Date.parse(at(10));
    expect(isFreshRejection({ at: at(11) }, mounted)).toBe(true);
    expect(isFreshRejection({ at: at(2) }, mounted)).toBe(false); // restored from an earlier visit
  });

  it("chip and labels", () => {
    expect(syncIssuesChipText(0)).toBeNull();
    expect(syncIssuesChipText(3)).toBe("⚠️ 3");
    expect(issueKind("drink.log")).toBe("Drink");
    expect(issueKind("teeshot.set")).toBe("Tee shot");
    expect(issueKind("tee.open")).toBe("Hole");
    expect(issueKind("photo")).toBe("Photo");
    expect(issueKind("trip.update")).toBe("Setup");
  });
});
