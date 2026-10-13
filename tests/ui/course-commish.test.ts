// Commissioner tools view-model: review queue, drink list, drive-minimum flags, round fixes.
import { describe, expect, it } from "vitest";
import { makeTrip } from "../fixtures";
import { derive } from "@/lib/engine";
import {
  driveFlags,
  drinkRows,
  feetFromParts,
  formatDistance,
  normalizeRoundFix,
  partsFromFeet,
  reviewItems,
  reviewQueue,
  reviewReasons,
  roundStateLabel,
  sameRound,
  yardsFromText,
} from "@/components/setup/commish/commishModel";

describe("contest review queue", () => {
  function trip() {
    const f = makeTrip({ teams: [4, 3, 3], status: "live" });
    // Long drive on hole 4 needs a tee point for measured distances; give it one.
    f.state.holes = f.state.holes.map((h) => (h.number === 4 ? { ...h, tee_lat: 41.0964244, tee_lng: -75.6596474 } : h));
    const ok = f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 8.5 });
    const sus = f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 2, ai_suspicious: true, ai_estimate_ft: 14, ai_confidence: "high" });
    const weak = f.entry({ hole: 4, player_id: f.player.A2, type: "ld", distance_value: 290, low_accuracy: true, status: "flagged", flag_reason: "GPS was weak", gps_accuracy_m: 21 });
    const far = f.entry({ hole: 4, player_id: f.player.C1, type: "ld", distance_value: 450 });
    const approved = f.entry({ hole: 4, player_id: f.player.B2, type: "ld", distance_value: 260, status: "overridden", ai_suspicious: true });
    return { f, ids: { ok, sus, weak, far, approved } };
  }

  it("queues flagged, weak-GPS, out-of-range and AI-suspicious entries, not approved ones", () => {
    const { f, ids } = trip();
    const d = derive(f.state);
    const q = reviewQueue(d.contests);
    const qIds = q.map((i) => i.view.entry.id);
    expect(qIds).toContain(ids.sus);
    expect(qIds).toContain(ids.weak);
    expect(qIds).toContain(ids.far);
    expect(qIds).not.toContain(ids.ok);
    expect(qIds).not.toContain(ids.approved);
    // sorted by hole
    expect(q.map((i) => i.hole)).toEqual([...q.map((i) => i.hole)].sort((a, b) => a - b));
    const all = reviewItems(d.contests);
    expect(all).toHaveLength(5);

    const byId = new Map(all.map((i) => [i.view.entry.id, i]));
    expect(byId.get(ids.weak)!.reasons).toEqual(["Flagged: GPS was weak"]);
    expect(byId.get(ids.far)!.reasons[0]).toMatch(/^Out of range: \d+ yd$/);
    expect(byId.get(ids.sus)!.reasons[0]).toMatch(/AI judge smells a rat: claimed 2' 0", looks like ~14' 0"/);
    expect(reviewReasons(byId.get(ids.approved)!.view)).toEqual([]);
  });

  it("formats distances", () => {
    expect(formatDistance(8.5, "ft")).toBe(`8' 6"`);
    expect(formatDistance(287.4, "yd")).toBe("287 yd");
  });

  it("official distance inputs", () => {
    expect(feetFromParts("12", "6")).toBe(12.5);
    expect(feetFromParts("0", "9")).toBe(0.75);
    expect(feetFromParts("3", "")).toBe(3);
    expect(feetFromParts("", "")).toBeNull();
    expect(feetFromParts("3", "12")).toBeNull();
    expect(feetFromParts("201", "0")).toBeNull();
    expect(partsFromFeet(12.5)).toEqual({ ft: 12, inches: 6 });
    expect(partsFromFeet(0.99)).toEqual({ ft: 1, inches: 0 });
    expect(yardsFromText("287")).toBe(287);
    expect(yardsFromText("")).toBeNull();
    expect(yardsFromText("701")).toBeNull();
  });
});

describe("drinkRows", () => {
  it("filters by team and hole, newest first, with ghost values", () => {
    const f = makeTrip({ teams: [4, 3], status: "live" });
    f.teeOff("A", 1).teeOff("B", 1);
    f.drink("A", "A1", 1);
    const b1 = f.drink("B", "B1", 1);
    f.drink("B", "B2", 1);
    const b3 = f.drink("B", "B3", 2, "shotgun"); // third threesome drink: ghost beer
    const gone = f.drink("B", "B1", 2);
    f.deleteDrink(gone);
    const d = derive(f.state);

    const all = drinkRows(f.state, d, { teamId: null, hole: null });
    expect(all.map((r) => r.drink.id)).not.toContain(gone);
    expect(all).toHaveLength(4);
    expect(all[0].drink.id).toBe(b3);
    expect(all[0]).toMatchObject({ value: 2, ghost: true });
    expect(all[0].player?.id).toBe(f.player.B3);
    expect(all[0].team?.id).toBe(f.team.B);

    const teamB = drinkRows(f.state, d, { teamId: f.team.B, hole: 1 });
    expect(teamB.map((r) => r.drink.id).sort()).toEqual([b1, all.find((r) => r.player?.id === f.player.B2)!.drink.id].sort());
    expect(drinkRows(f.state, d, { teamId: f.team.A, hole: 2 })).toEqual([]);
  });
});

describe("driveFlags", () => {
  it("lists closed nines with players at zero, and nines on the clock", () => {
    const f = makeTrip({ teams: [2, 2], status: "live" });
    // Team A: A1 hits every tee shot on the front nine and they move to hole 10.
    for (let h = 1; h <= 9; h++) {
      f.teeOff("A", h);
      f.score("A", h, 4, "A1");
    }
    f.teeOff("A", 10);
    // Team B: on hole 9 with B2 still needing a drive (1 hole left, 1 player needing = hard).
    for (let h = 1; h <= 8; h++) {
      f.teeOff("B", h);
      f.score("B", h, 4, "B1");
    }
    f.teeOff("B", 9);
    const d = derive(f.state);
    const flags = driveFlags(d);
    const missed = flags.filter((x) => x.kind === "missed");
    expect(missed).toEqual([{ team_id: f.team.A, nine: 1, kind: "missed", players: [f.player.A2], remaining: 0 }]);
    const risk = flags.filter((x) => x.kind === "at_risk");
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({ team_id: f.team.B, nine: 1, players: [f.player.B2], remaining: 1 });
  });
});

describe("round state fixes", () => {
  it("labels and normalizes", () => {
    expect(roundStateLabel(null)).toBe("Not started");
    expect(roundStateLabel({ status: "playing", open_hole: 7 })).toBe("On hole 7");
    expect(roundStateLabel({ status: "complete", open_hole: 18 })).toBe("Round complete");
    expect(normalizeRoundFix({ status: "not_started", open_hole: 5 })).toEqual({ status: "not_started", open_hole: null });
    expect(normalizeRoundFix({ status: "playing", open_hole: 0 })).toEqual({ status: "playing", open_hole: 1 });
    expect(normalizeRoundFix({ status: "complete", open_hole: 30 })).toEqual({ status: "complete", open_hole: 18 });
    expect(sameRound({ status: "playing", open_hole: 7 }, { status: "playing", open_hole: 7 })).toBe(true);
    expect(sameRound({ status: "playing", open_hole: 7 }, { status: "playing", open_hole: 8 })).toBe(false);
    expect(sameRound(null, { status: "not_started", open_hole: 3 })).toBe(true);
  });
});
