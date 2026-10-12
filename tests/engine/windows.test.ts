import { describe, expect, it } from "vitest";
import { currentHoleFor, openWindowHole } from "@/lib/engine/windows";
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
