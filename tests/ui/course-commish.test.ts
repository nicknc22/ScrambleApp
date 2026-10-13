// Commissioner tools view-model: review queue, drink list, drive-minimum flags, round fixes.
import { describe, expect, it } from "vitest";
import { at, makeTrip, type TripFixture } from "../fixtures";
import { derive } from "@/lib/engine";
import { applyOp } from "@/lib/reducer";
import type { Op, OpInput } from "@/lib/ops";
import type { TripState } from "@/lib/types";
import {
  addDrinkInput,
  addEntryInput,
  defaultAddHole,
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

  it("shows and filters by the hole a drink counts on, not the stale hole its phone stamped", () => {
    const f = makeTrip({ teams: [4, 3], status: "live" });
    f.teeOff("A", 1, 10).teeOff("A", 2, 20);
    // A stale phone still showed hole 1 at minute 25, after hole 2 was teed off at minute 20.
    const stale = f.drink("A", "A2", 1, "drink", { min: 25 });
    const d = derive(f.state);
    const [row] = drinkRows(f.state, d, { teamId: f.team.A, hole: null });
    expect(row.drink.id).toBe(stale);
    expect(row.drink.hole).toBe(1);
    expect(row.hole).toBe(2);
    expect(drinkRows(f.state, d, { teamId: f.team.A, hole: 2 }).map((r) => r.drink.id)).toEqual([stale]);
    expect(drinkRows(f.state, d, { teamId: f.team.A, hole: 1 })).toEqual([]);
  });
});

describe("drinkRows: drinks the engine doesn't count", () => {
  it("a drink logged after Round complete is worth 0 and says why; pinning it to 18 makes it count (finding: commish-drinks-panel-counts-post-round-drinks)", () => {
    const f = makeTrip({ teams: [3, 3], status: "live" });
    for (let h = 1; h <= 18; h++) {
      f.teeOff("A", h, h * 12);
      f.score("A", h, 4);
    }
    f.complete("A", 18 * 12 + 10); // Round complete at minute 226
    const inRound = f.drink("A", "A2", 18, "drink", { min: 18 * 12 + 5 });
    const bar = f.drink("A", "A3", 18, "drink", { min: 18 * 12 + 25 }); // 15 min after Round complete
    const d = derive(f.state);
    expect(d.standings.find((r) => r.team_id === f.team.A)).toMatchObject({ drinks: 1, credit: 1 });

    const rows = drinkRows(f.state, d, { teamId: f.team.A, hole: 18 });
    const byId = new Map(rows.map((r) => [r.drink.id, r]));
    expect(byId.get(inRound)).toMatchObject({ counted: true, value: 1, uncountedReason: null });
    expect(byId.get(bar)).toMatchObject({ counted: false, value: 0, ghost: false, hole: 18, uncountedReason: "Logged after Round complete" });
    // The panel's header counts only what counts.
    expect(rows.filter((r) => r.counted)).toHaveLength(1);

    // "Count it on 18": a move to its own hole pins it (moved_from_hole), and the engine counts it.
    const move = applyOp(f.state, { type: "drink.move", id: "op-pin", at: at(240), by: null, drink_id: bar, hole: 18 } as Op, {
      now: at(240),
      is_commissioner: true,
      side: "server",
    });
    if (!move.ok) throw new Error(move.reason);
    const d2 = derive(move.state);
    expect(drinkRows(move.state, d2, { teamId: f.team.A, hole: 18 }).find((r) => r.drink.id === bar)).toMatchObject({ counted: true, value: 1 });
    expect(d2.standings.find((r) => r.team_id === f.team.A)).toMatchObject({ drinks: 2 });
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

// ---------------------------------------------------------------------------
// Day-of fallback: the commissioner adds a missed drink or contest entry
// (finding speccheck/commish-cant-add-missed-drink)
// ---------------------------------------------------------------------------

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** Dispatch like the store does: id/at/by filled in, the commissioner's phone (on team A). */
function commish(f: TripFixture, state: TripState, input: OpInput, min = 400, side: "client" | "server" = "client") {
  const op = { ...input, id: uuid(), at: at(min), by: f.player.A1 } as Op;
  return applyOp(state, op, { now: at(min), is_commissioner: true, side });
}

describe("commissioner adds a drink", () => {
  it("builds a drink.log with as_commissioner, or null until team, player and hole are picked", () => {
    expect(addDrinkInput({ teamId: "t", playerId: null, hole: 3, type: "drink" }, "d")).toBeNull();
    expect(addDrinkInput({ teamId: "t", playerId: "p", hole: 19, type: "drink" }, "d")).toBeNull();
    expect(addDrinkInput({ teamId: "t", playerId: "p", hole: 18, type: "shot" }, "d")).toEqual({
      type: "drink.log",
      drink_id: "d",
      team_id: "t",
      player_id: "p",
      hole: 18,
      drink_type: "shot",
      photo_path: null,
      as_commissioner: true,
    });
    expect(defaultAddHole(null)).toBe(1);
    expect(defaultAddHole({ status: "playing", open_hole: 12 })).toBe(12);
    expect(defaultAddHole({ status: "complete", open_hole: 18 })).toBe(18);
  });

  it("lands on hole 18 after the team tapped Round complete (a player's phone can't)", () => {
    const f = makeTrip({ teams: [4, 4], status: "live" });
    for (let h = 1; h <= 18; h++) f.teeOff("B", h, h * 10);
    f.score("B", 18, 5);
    f.complete("B", 200);
    const drinkId = uuid();
    const input = addDrinkInput({ teamId: f.team.B, playerId: f.player.B2, hole: 18, type: "shotgun" }, drinkId)!;
    // A plain player dispatch is refused: the window is shut.
    const asPlayer = applyOp(f.state, { ...input, as_commissioner: undefined, id: uuid(), at: at(400), by: f.player.B1 } as Op, {
      now: at(400),
      is_commissioner: false,
      side: "client",
    });
    expect(asPlayer).toMatchObject({ ok: false, code: "no_window" });
    for (const side of ["client", "server"] as const) {
      const r = commish(f, f.state, input, 400, side);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = derive(r.state);
      expect(d.drinkValues[drinkId]).toMatchObject({ hole: 18, player_id: f.player.B2, value: 1 });
      expect(d.teamHoles[f.team.B].find((l) => l.hole === 18)).toMatchObject({ drinks: 1, credit: 1, net: 4 });
    }
  });

  it("back-fills an earlier hole for another team and the credit stays on that hole", () => {
    const f = makeTrip({ teams: [4, 4], status: "live" });
    for (let h = 1; h <= 12; h++) {
      f.teeOff("B", h, h * 10);
      if (h < 12) f.score("B", h, 4);
    }
    const drinkId = uuid();
    const r = commish(f, f.state, addDrinkInput({ teamId: f.team.B, playerId: f.player.B3, hole: 5, type: "drink" }, drinkId)!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = derive(r.state);
    expect(d.drinkValues[drinkId].hole).toBe(5);
    expect(d.teamHoles[f.team.B].find((l) => l.hole === 5)).toMatchObject({ drinks: 1, net: 3 });
    expect(d.teamHoles[f.team.B].find((l) => l.hole === 12)!.drinks).toBe(0);
  });

  it("works on a final trip (a fix after the fact)", () => {
    const f = makeTrip({ teams: [2, 2], status: "final" });
    f.teeOff("A", 1, 1);
    f.complete("A", 5);
    const r = commish(f, f.state, addDrinkInput({ teamId: f.team.A, playerId: f.player.A2, hole: 1, type: "drink" }, uuid())!);
    expect(r.ok).toBe(true);
  });
});

describe("commissioner adds a contest entry", () => {
  it("builds a contest.submit with a typed distance, no GPS and no photo", () => {
    expect(addEntryInput({ hole: 3, type: "ctp", playerId: "p", distance: null }, "e")).toBeNull();
    expect(addEntryInput({ hole: 3, type: "ctp", playerId: null, distance: 4 }, "e")).toBeNull();
    expect(addEntryInput({ hole: 4, type: "ld", playerId: "p", distance: 287 }, "e")).toEqual({
      type: "contest.submit",
      entry_id: "e",
      hole: 4,
      player_id: "p",
      contest_type: "ld",
      distance_value: 287,
      angle_deg: null,
      lat: null,
      lng: null,
      gps_accuracy_m: null,
      low_accuracy: false,
      photo_path: null,
      as_commissioner: true,
    });
  });

  it("enters a CTP for a player on another team; it counts and wins the hole", () => {
    const f = makeTrip({ teams: [2, 2], status: "live" });
    f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 9 });
    const entryId = uuid();
    // The commissioner is A1 (team A); B1 is on team B. A player can't enter for another team.
    const input = addEntryInput({ hole: 3, type: "ctp", playerId: f.player.B1, distance: 4.5 }, entryId)!;
    const asPlayer = applyOp(f.state, { ...input, as_commissioner: undefined, id: uuid(), at: at(50), by: f.player.A1 } as Op, {
      now: at(50),
      is_commissioner: false,
      side: "client",
    });
    expect(asPlayer).toMatchObject({ ok: false, code: "forbidden" });
    const r = commish(f, f.state, input, 50);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hole3 = derive(r.state).contests.find((c) => c.hole === 3)!;
    expect(hole3.leader_ids).toEqual([f.player.B1]);
    expect(hole3.entries[0]).toMatchObject({ valid: true, distance: 4.5, rank: 1, team_id: f.team.B });
  });

  it("enters a long drive by hand after the hole closed (measuring is over for players)", () => {
    const f = makeTrip({ teams: [2, 2], status: "live" });
    for (const t of ["A", "B"]) for (let h = 1; h <= 6; h++) f.teeOff(t, h, h);
    const entryId = uuid();
    const r = commish(f, f.state, addEntryInput({ hole: 4, type: "ld", playerId: f.player.B2, distance: 265 }, entryId)!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hole4 = derive(r.state).contests.find((c) => c.hole === 4)!;
    expect(hole4.closed).toBe(true);
    expect(hole4.entries.map((v) => [v.player_id, v.distance, v.valid])).toEqual([[f.player.B2, 265, true]]);
  });
});
