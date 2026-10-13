import { describe, expect, it } from "vitest";
import { CLOCK_GRACE_MS, currentHoleFor, effectiveDrinkHole, loggedAfterRound, openWindowHole } from "@/lib/engine/windows";
import type { TeamRoundState } from "@/lib/types";

function rs(p: Partial<TeamRoundState>): TeamRoundState {
  return {
    id: "rs-1",
    trip_id: "trip-1",
    team_id: "team-1",
    open_hole: null,
    started_holes: [],
    hole_opened_at: {},
    status: "not_started",
    completed_at: null,
    updated_at: "2026-10-24T16:00:00.000Z",
    ...p,
  };
}

describe("openWindowHole", () => {
  it("is null with no round state (team added late, or setup)", () => {
    expect(openWindowHole(undefined)).toBeNull();
    expect(openWindowHole(null)).toBeNull();
  });

  it("is null before the team tees off on hole 1", () => {
    expect(openWindowHole(rs({}))).toBeNull();
  });

  it("is the open hole while playing", () => {
    expect(openWindowHole(rs({ status: "playing", open_hole: 1 }))).toBe(1);
    expect(openWindowHole(rs({ status: "playing", open_hole: 5 }))).toBe(5);
    expect(openWindowHole(rs({ status: "playing", open_hole: 18 }))).toBe(18);
  });

  it("is null once the round is complete (hole 18's window closed)", () => {
    expect(openWindowHole(rs({ status: "complete", open_hole: 18 }))).toBeNull();
  });

  it("is null for a playing row with no open hole (defensive)", () => {
    expect(openWindowHole(rs({ status: "playing", open_hole: null }))).toBeNull();
  });
});

describe("currentHoleFor", () => {
  it("is 1 when missing or not started", () => {
    expect(currentHoleFor(undefined)).toBe(1);
    expect(currentHoleFor(null)).toBe(1);
    expect(currentHoleFor(rs({}))).toBe(1);
  });

  it("is the open hole while playing", () => {
    expect(currentHoleFor(rs({ status: "playing", open_hole: 7 }))).toBe(7);
  });

  it("is 1 when playing with no open hole (defensive)", () => {
    expect(currentHoleFor(rs({ status: "playing", open_hole: null }))).toBe(1);
  });

  it("is the last open hole (18 by default) when complete", () => {
    expect(currentHoleFor(rs({ status: "complete", open_hole: 18 }))).toBe(18);
    expect(currentHoleFor(rs({ status: "complete", open_hole: 16 }))).toBe(16);
    expect(currentHoleFor(rs({ status: "complete", open_hole: null }))).toBe(18);
  });

  it("ignores a stray open_hole on a not-started row", () => {
    expect(currentHoleFor(rs({ status: "not_started", open_hole: 4 }))).toBe(1);
  });
});

describe("effectiveDrinkHole", () => {
  const t = (min: number) => new Date(Date.parse("2026-10-24T17:00:00.000Z") + min * 60_000).toISOString();
  const opened = rs({ status: "playing", open_hole: 6, hole_opened_at: { "4": t(60), "5": t(75), "6": t(90) } });
  const drinkAt = (hole: number, min: number, moved_from_hole: number | null = null) => ({ hole, logged_at: t(min), moved_from_hole });

  it("is the hole whose window was open when the drink was logged, even if a stale phone stamped an older hole", () => {
    expect(effectiveDrinkHole(drinkAt(4, 78), opened)).toBe(5); // phone still showed 4; hole 5 opened at 75
    expect(effectiveDrinkHole(drinkAt(4, 95), opened)).toBe(6);
    expect(effectiveDrinkHole(drinkAt(5, 80), opened)).toBe(5);
  });

  it("phone clocks disagree: a drink within 2 minutes of the next hole opening (on another phone) stays on its stamped hole", () => {
    expect(CLOCK_GRACE_MS).toBe(2 * 60_000);
    expect(effectiveDrinkHole(drinkAt(4, 75), opened)).toBe(4);
    expect(effectiveDrinkHole(drinkAt(4, 77), opened)).toBe(4); // exactly the grace: still hole 4
    expect(effectiveDrinkHole(drinkAt(4, 77.1), opened)).toBe(5);
  });

  it("offline review repro: Mike's phone runs fast, Dave tees off the next hole: the drink stays where it was tapped", () => {
    // Hole 4 opened at minute 36. Mike taps a drink at real minute 46 (hole 4 open on his screen);
    // Dave tees off hole 5 at real minute 48.
    const rs4 = rs({ status: "playing", open_hole: 5, hole_opened_at: { "4": t(36), "5": t(48) } });
    for (const fastBy of [0, 1, 2, 3.5]) expect(effectiveDrinkHole(drinkAt(4, 46 + fastBy), rs4), `${fastBy} min fast`).toBe(4);
    // Dave's phone 2 minutes slow (stamps 46 for the tee shot): still hole 4.
    const slowDave = rs({ status: "playing", open_hole: 5, hole_opened_at: { "4": t(36), "5": t(46) } });
    expect(effectiveDrinkHole(drinkAt(4, 46), slowDave)).toBe(4);
    // A stale phone that really drank on hole 5 (well after it opened) still moves.
    expect(effectiveDrinkHole(drinkAt(4, 55), rs4)).toBe(5);
  });

  it("never moves a drink earlier than its stamp (a missing or late tee.open can't drag it back)", () => {
    expect(effectiveDrinkHole(drinkAt(6, 70), opened)).toBe(6);
    expect(effectiveDrinkHole(drinkAt(9, 95), opened)).toBe(9);
    expect(effectiveDrinkHole(drinkAt(4, 61), opened)).toBe(4);
  });

  it("ignores windows that opened after the drink was logged", () => {
    expect(effectiveDrinkHole(drinkAt(4, 74.9), opened)).toBe(4);
  });

  it("a commissioner-moved drink stays where it was put", () => {
    expect(effectiveDrinkHole(drinkAt(4, 95, 6), opened)).toBe(4);
  });

  it("falls back to the stamp with no round state, no open times or an unreadable time", () => {
    expect(effectiveDrinkHole(drinkAt(4, 95), undefined)).toBe(4);
    expect(effectiveDrinkHole(drinkAt(4, 95), null)).toBe(4);
    expect(effectiveDrinkHole(drinkAt(4, 95), rs({}))).toBe(4);
    expect(effectiveDrinkHole({ hole: 4, logged_at: "garbage", moved_from_hole: null }, opened)).toBe(4);
    expect(effectiveDrinkHole(drinkAt(4, 95), rs({ hole_opened_at: { "5": "garbage", x: t(0), "40": t(0) } }))).toBe(4);
  });

  it("with skewed phone clocks, takes the highest hole opened more than the grace before the drink's time", () => {
    // Hole 3 was opened by a phone whose clock runs slow: its time is before hole 2's.
    const skewed = rs({ status: "playing", open_hole: 3, hole_opened_at: { "1": t(0), "2": t(20), "3": t(18) } });
    expect(effectiveDrinkHole(drinkAt(1, 19), skewed)).toBe(1);
    expect(effectiveDrinkHole(drinkAt(1, 21), skewed)).toBe(3);
  });
});

describe("loggedAfterRound", () => {
  const t = (min: number) => new Date(Date.parse("2026-10-24T21:00:00.000Z") + min * 60_000).toISOString();
  const done = rs({ status: "complete", open_hole: 18, completed_at: t(0) });
  const drinkAt = (min: number, moved_from_hole: number | null = null) => ({ logged_at: t(min), moved_from_hole });

  it("is true only for a drink logged more than the clock grace after the team's Round complete", () => {
    expect(loggedAfterRound(drinkAt(-5), done)).toBe(false);
    expect(loggedAfterRound(drinkAt(1), done)).toBe(false);
    expect(loggedAfterRound(drinkAt(2), done)).toBe(false);
    expect(loggedAfterRound(drinkAt(2.1), done)).toBe(true);
    expect(loggedAfterRound(drinkAt(15), done)).toBe(true);
  });

  it("a commissioner-pinned drink counts; no completion or unreadable times never exclude", () => {
    expect(loggedAfterRound(drinkAt(15, 18), done)).toBe(false);
    expect(loggedAfterRound(drinkAt(15), rs({ status: "playing", open_hole: 18 }))).toBe(false);
    expect(loggedAfterRound(drinkAt(15), undefined)).toBe(false);
    expect(loggedAfterRound({ logged_at: "garbage", moved_from_hole: null }, done)).toBe(false);
  });
});
