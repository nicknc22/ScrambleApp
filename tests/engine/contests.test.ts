import { describe, expect, it } from "vitest";
import { computeContests, contestScore, rankPreview } from "@/lib/engine/contests";
import { computeRoster, derive } from "@/lib/engine";
import type { ContestHoleSummary } from "@/lib/engine/types";
import type { Hole, TeamRoundState } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "../fixtures";

const TEE = { lat: 41.0948, lng: -75.648 };
/** 294 yd from TEE (see geo.test.ts). */
const BALL_294 = { lat: 41.0968, lng: -75.6462 };
/** 330 yd due east of TEE. */
const BALL_330 = { lat: 41.0948, lng: -75.648 + 0.0036 };

function contests(f: TripFixture): ContestHoleSummary[] {
  return computeContests(f.state, computeRoster(f.state).teamOfPlayer);
}
function hole(f: TripFixture, n: number): ContestHoleSummary {
  const s = contests(f).find((c) => c.hole === n);
  if (!s) throw new Error(`no contest on hole ${n}`);
  return s;
}
function patchHole(f: TripFixture, n: number, patch: Partial<Hole>) {
  f.state = { ...f.state, holes: f.state.holes.map((h) => (h.number === n ? { ...h, ...patch } : h)) };
}
function patchRound(f: TripFixture, team: string, patch: Partial<TeamRoundState>) {
  f.state = {
    ...f.state,
    team_round_state: f.state.team_round_state.map((rs) => (rs.team_id === f.team[team] ? { ...rs, ...patch } : rs)),
  };
}

describe("computeContests — structure", () => {
  it("returns one summary per contest hole, sorted by hole, with pot keys", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.state = { ...f.state, holes: [...f.state.holes].reverse() };
    const cs = contests(f);
    expect(cs.map((c) => [c.hole, c.type, c.pot_key])).toEqual([
      [3, "ctp", "contest:3"],
      [4, "ld", "contest:4"],
      [8, "ctp", "contest:8"],
      [9, "ld", "contest:9"],
      [11, "ctp", "contest:11"],
      [12, "ld", "contest:12"],
      [16, "ctp", "contest:16"],
      [18, "ld", "contest:18"],
    ]);
    for (const c of cs) {
      expect(c.entries).toEqual([]);
      expect(c.leader_ids).toEqual([]);
      expect(c.best).toBeNull();
      expect(c.closed).toBe(false);
    }
  });

  it("follows hole.contest (a par change re-derives it) and ignores entries of the wrong type", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 250 });
    // Hole 4 changed to a par 3: it is now closest to pin; the old long-drive entry no longer counts.
    patchHole(f, 4, { par: 3, contest: "ctp" });
    patchHole(f, 3, { par: 4, contest: "none" });
    const cs = contests(f);
    expect(cs.map((c) => c.hole)).not.toContain(3);
    const h4 = cs.find((c) => c.hole === 4)!;
    expect(h4.type).toBe("ctp");
    expect(h4.entries).toEqual([]);
  });
});

describe("computeContests — closest to pin", () => {
  it("ranks smallest first at inch precision; ties share rank", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 3.0 }); // 36 in
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 2.5 }); // 30 in
    f.entry({ hole: 3, player_id: f.player.C1, type: "ctp", distance_value: 3.04 }); // 36.48 in -> 36 (tie)
    f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 12.5 });
    f.entry({ hole: 3, player_id: f.player.B2, type: "ctp", distance_value: 3.05 }); // 36.6 in -> 37
    const s = hole(f, 3);
    expect(s.entries.map((v) => [v.player_id, v.rank])).toEqual([
      [f.player.B1, 1],
      [f.player.A1, 2], // earlier submission listed first among the tie
      [f.player.C1, 2],
      [f.player.B2, 4],
      [f.player.A2, 5],
    ]);
    expect(s.leader_ids).toEqual([f.player.B1]);
    expect(s.best).toBe(2.5);
    for (const v of s.entries) {
      expect(v.unit).toBe("ft");
      expect(v.type).toBe("ctp");
      expect(v.valid).toBe(true);
      expect(v.invalid_reason).toBeNull();
    }
  });

  it("a tie for the lead gives several leader_ids", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 8, player_id: f.player.A1, type: "ctp", distance_value: 4 + 2 / 12 });
    f.entry({ hole: 8, player_id: f.player.B2, type: "ctp", distance_value: 4.1667 });
    f.entry({ hole: 8, player_id: f.player.B1, type: "ctp", distance_value: 9 });
    const s = hole(f, 8);
    expect(s.leader_ids).toEqual([f.player.A1, f.player.B2]);
    expect(s.entries.map((v) => v.rank)).toEqual([1, 1, 3]);
  });

  it("uses the commissioner override as the official distance", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 2, distance_override: 20, status: "overridden" });
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 10 });
    const s = hole(f, 3);
    expect(s.entries.find((v) => v.player_id === f.player.A1)!.distance).toBe(20);
    expect(s.leader_ids).toEqual([f.player.B1]);
  });

  it("keeps one active entry per player: the latest by updated_at, then created_at, then id", () => {
    const f = makeTrip({ teams: [2, 2] });
    // Deleted entries never count.
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 1, deleted_at: at(5) });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 8, updated_at: at(30) });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 6, updated_at: at(20) });
    // Same updated_at: later created_at wins.
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 5, updated_at: at(40), created_at: at(10) });
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 7, updated_at: at(40), created_at: at(11) });
    // Same timestamps: larger id wins.
    f.entry({ id: "entry-zzz", hole: 3, player_id: f.player.B2, type: "ctp", distance_value: 9, updated_at: at(1), created_at: at(1) });
    f.entry({ id: "entry-aaa", hole: 3, player_id: f.player.B2, type: "ctp", distance_value: 2, updated_at: at(1), created_at: at(1) });
    const s = hole(f, 3);
    const byPlayer = Object.fromEntries(s.entries.map((v) => [v.player_id, v.distance]));
    expect(s.entries).toHaveLength(3);
    expect(byPlayer).toEqual({ [f.player.A1]: 8, [f.player.B1]: 7, [f.player.B2]: 9 });
  });

  it("ignores entries of deleted players and maps team_id from the current roster", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 3 });
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 4 });
    f.state = {
      ...f.state,
      players: f.state.players.map((p) => (p.id === f.player.A1 ? { ...p, deleted_at: at(50) } : p)),
      // B1 was moved to team A by the commissioner after submitting.
      team_members: f.state.team_members.map((m) => (m.player_id === f.player.B1 ? { ...m, team_id: f.team.A } : m)),
    };
    const s = hole(f, 3);
    expect(s.entries.map((v) => v.player_id)).toEqual([f.player.B1]);
    expect(s.entries[0].team_id).toBe(f.team.A);
    expect(s.entries[0].entry.team_id).toBe(f.team.B);
  });

  it("marks AI-suspicious entries without affecting validity or rank", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 1, ai_suspicious: true, ai_estimate_ft: 30 });
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 5, ai_suspicious: false });
    const s = hole(f, 3);
    expect(s.entries[0]).toMatchObject({ player_id: f.player.A1, suspicious: true, valid: true, rank: 1 });
    expect(s.entries[1]).toMatchObject({ player_id: f.player.B1, suspicious: false, valid: true, rank: 2 });
  });
});

describe("computeContests — long drive", () => {
  it("ranks longest first at yard precision with ties sharing rank", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 250.4 }); // 250
    f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 280 });
    f.entry({ hole: 4, player_id: f.player.C1, type: "ld", distance_value: 249.6 }); // 250
    f.entry({ hole: 4, player_id: f.player.A2, type: "ld", distance_value: 199 });
    const s = hole(f, 4);
    expect(s.entries.map((v) => [v.player_id, v.distance, v.rank])).toEqual([
      [f.player.B1, 280, 1],
      [f.player.A1, 250, 2],
      [f.player.C1, 250, 2],
      [f.player.A2, 199, 4],
    ]);
    expect(s.leader_ids).toEqual([f.player.B1]);
    expect(s.best).toBe(280);
    expect(s.entries.every((v) => v.unit === "yd")).toBe(true);
  });

  it("recomputes distance from the hole's current tee point after the tee point moves", () => {
    const f = makeTrip({ teams: [2, 2] });
    patchHole(f, 4, { tee_lat: TEE.lat, tee_lng: TEE.lng });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 301, lat: BALL_294.lat, lng: BALL_294.lng });
    f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 310, lat: BALL_330.lat, lng: BALL_330.lng });
    // No coordinates: falls back to the submitted distance.
    f.entry({ hole: 4, player_id: f.player.B2, type: "ld", distance_value: 299.6 });
    let s = hole(f, 4);
    const dist = () => Object.fromEntries(s.entries.map((v) => [v.player_id, v.distance]));
    expect(dist()).toEqual({ [f.player.A1]: 294, [f.player.B1]: 330, [f.player.B2]: 300 });
    expect(s.leader_ids).toEqual([f.player.B1]);

    // Move the tee point 0.0036 deg east, onto BALL_330: B1's drive becomes 0 yd (out of range),
    // A1's drive is re-measured from the new point.
    patchHole(f, 4, { tee_lat: BALL_330.lat, tee_lng: BALL_330.lng });
    s = hole(f, 4);
    const a1 = s.entries.find((v) => v.player_id === f.player.A1)!;
    expect(a1.distance).toBe(Math.round(((Math.hypot(0.0018 * Math.cos((41.0958 * Math.PI) / 180), 0.002) * Math.PI) / 180) * 6371008.8 / 0.9144));
    const b1 = s.entries.find((v) => v.player_id === f.player.B1)!;
    expect(b1).toMatchObject({ distance: 0, valid: false, invalid_reason: "Out of range: 0 yd", rank: null });
    expect(s.leader_ids).toEqual([f.player.B2]);

    // Clearing the tee point falls back to each entry's submitted distance.
    patchHole(f, 4, { tee_lat: null, tee_lng: null });
    s = hole(f, 4);
    expect(dist()).toEqual({ [f.player.A1]: 301, [f.player.B1]: 310, [f.player.B2]: 300 });
  });

  it("the override wins over the GPS distance", () => {
    const f = makeTrip({ teams: [2, 2] });
    patchHole(f, 4, { tee_lat: TEE.lat, tee_lng: TEE.lng });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 294, lat: BALL_294.lat, lng: BALL_294.lng, distance_override: 305.4, status: "overridden" });
    const v = hole(f, 4).entries[0];
    expect(v.distance).toBe(305);
    expect(v.valid).toBe(true);
  });

  it("validity: flagged -> invalid, overridden -> valid, ok but out of range -> invalid", () => {
    const f = makeTrip({ teams: [4, 4], settings: { ld_min_yd: 100, ld_max_yd: 400 } });
    f.entry({ hole: 9, player_id: f.player.A1, type: "ld", distance_value: 260, status: "flagged", flag_reason: "GPS was weak", low_accuracy: true });
    f.entry({ hole: 9, player_id: f.player.A2, type: "ld", distance_value: 412, status: "flagged", flag_reason: "Out of range: 412 yd" });
    f.entry({ hole: 9, player_id: f.player.A3, type: "ld", distance_value: 412, status: "overridden" }); // commissioner approved the bomb
    f.entry({ hole: 9, player_id: f.player.A4, type: "ld", distance_value: 412 }); // ok, but out of range
    f.entry({ hole: 9, player_id: f.player.B1, type: "ld", distance_value: 99.4 }); // 99 -> out of range
    f.entry({ hole: 9, player_id: f.player.B2, type: "ld", distance_value: 100 }); // boundary: in range
    f.entry({ hole: 9, player_id: f.player.B3, type: "ld", distance_value: 400 }); // boundary: in range
    f.entry({ hole: 9, player_id: f.player.B4, type: "ld", distance_value: 50, status: "flagged", flag_reason: null });
    const s = hole(f, 9);
    const view = (p: string) => s.entries.find((v) => v.player_id === f.player[p])!;
    expect(view("A1")).toMatchObject({ valid: false, invalid_reason: "Needs commissioner review: GPS was weak", rank: null });
    expect(view("A2")).toMatchObject({ valid: false, invalid_reason: "Needs commissioner review: Out of range: 412 yd" });
    expect(view("A3")).toMatchObject({ valid: true, invalid_reason: null, rank: 1, distance: 412 });
    expect(view("A4")).toMatchObject({ valid: false, invalid_reason: "Out of range: 412 yd", rank: null });
    expect(view("B1")).toMatchObject({ valid: false, invalid_reason: "Out of range: 99 yd" });
    expect(view("B2")).toMatchObject({ valid: true, rank: 3 });
    expect(view("B3")).toMatchObject({ valid: true, rank: 2 });
    expect(view("B4")).toMatchObject({ valid: false, invalid_reason: "Needs commissioner review" });
    expect(s.leader_ids).toEqual([f.player.A3]);
    // Valid first (best first), then invalid.
    const validFlags = s.entries.map((v) => v.valid);
    expect(validFlags).toEqual([true, true, true, false, false, false, false, false]);
  });

  it("re-checks ok entries against the CURRENT sanity range", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 350 });
    expect(hole(f, 4).entries[0].valid).toBe(true);
    f.state = { ...f.state, trip: { ...f.state.trip, settings: { ...f.state.trip.settings, ld_max_yd: 320 } } };
    expect(hole(f, 4).entries[0]).toMatchObject({ valid: false, invalid_reason: "Out of range: 350 yd" });
  });

  it("an ok entry with a commissioner override is not range-checked (the override is a ruling)", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 450, distance_override: 290 });
    expect(hole(f, 4).entries[0]).toMatchObject({ valid: true, distance: 290 });
  });
});

describe("computeContests — closed", () => {
  it("closes once every playing team is past the hole or complete", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    const closed = () => Object.fromEntries(contests(f).map((c) => [c.hole, c.closed]));
    expect(closed()[3]).toBe(false);

    patchRound(f, "A", { status: "playing", open_hole: 4 });
    patchRound(f, "B", { status: "playing", open_hole: 3 }); // on hole 3: not past it
    patchRound(f, "C", { status: "complete", open_hole: 18 });
    expect(closed()[3]).toBe(false);

    patchRound(f, "B", { open_hole: 4 });
    expect(closed()).toMatchObject({ 3: true, 4: false, 8: false });

    // Complete counts as past every hole, even with an early open_hole (commissioner fix).
    patchRound(f, "A", { status: "complete", open_hole: 12 });
    patchRound(f, "B", { status: "complete", open_hole: 18 });
    expect(Object.values(closed()).every(Boolean)).toBe(true);
  });

  it("a team with no round state hasn't passed anything; an empty team is ignored", () => {
    const f = makeTrip({ teams: [2, 2, 2] });
    patchRound(f, "A", { status: "playing", open_hole: 10 });
    patchRound(f, "B", { status: "playing", open_hole: 10 });
    f.state = { ...f.state, team_round_state: f.state.team_round_state.filter((rs) => rs.team_id !== f.team.C) };
    expect(hole(f, 3).closed).toBe(false);

    // Team C loses all its members: it no longer plays, so it can't hold the hole open.
    f.state = { ...f.state, team_members: f.state.team_members.filter((m) => m.team_id !== f.team.C) };
    expect(hole(f, 3).closed).toBe(true);
    expect(hole(f, 11).closed).toBe(false);
  });

  it("every hole is closed once the trip is final; none before play starts", () => {
    const setup = makeTrip({ teams: [2, 2], status: "setup" });
    expect(contests(setup).some((c) => c.closed)).toBe(false);
    const fin = makeTrip({ teams: [2, 2], status: "final" });
    expect(contests(fin).every((c) => c.closed)).toBe(true);
  });

  it("derive() exposes the same summaries", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 3 });
    expect(derive(f.state, { strict: true }).contests).toEqual(contests(f));
  });
});

describe("rankPreview", () => {
  it("ranks a new ctp distance excluding the player's own entry", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 2 }); // own entry, leading
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 5 });
    f.entry({ hole: 3, player_id: f.player.C1, type: "ctp", distance_value: 10 });
    f.entry({ hole: 3, player_id: f.player.C2, type: "ctp", distance_value: 1, status: "flagged", flag_reason: "sus" });
    const s = hole(f, 3);

    // A1 re-measures at 7 ft: their own 2 ft doesn't count against them.
    let p = rankPreview(s, f.player.A1, 7);
    expect(p.rank).toBe(2);
    expect(p.label).toBe("2nd");
    expect(p.leader?.player_id).toBe(f.player.B1);

    p = rankPreview(s, f.player.A1, 4);
    expect(p).toMatchObject({ rank: 1, label: "1st" });
    expect(p.leader?.player_id).toBe(f.player.B1);

    // Ties at inch precision: 5 ft 0.4 in rounds to 60 in.
    p = rankPreview(s, f.player.A1, 5 + 0.4 / 12);
    expect(p).toMatchObject({ rank: 1, label: "T1st" });
    p = rankPreview(s, f.player.A1, 10);
    expect(p).toMatchObject({ rank: 2, label: "T2nd" });
    p = rankPreview(s, f.player.A1, 30);
    expect(p).toMatchObject({ rank: 3, label: "3rd" });

    // Someone else previewing sees A1 as the leader and the flagged entry ignored.
    p = rankPreview(s, f.player.A2, 1);
    expect(p).toMatchObject({ rank: 1, label: "1st" });
    expect(p.leader?.player_id).toBe(f.player.A1);
    p = rankPreview(s, f.player.A2, 3);
    expect(p).toMatchObject({ rank: 2, label: "2nd" });
  });

  it("ranks long drives with longer = better and handles an empty hole", () => {
    const f = makeTrip({ teams: [2, 2] });
    expect(rankPreview(hole(f, 4), f.player.A1, 250)).toEqual({ rank: 1, leader: null, label: "1st" });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 300 });
    f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 260 });
    const s = hole(f, 4);
    expect(rankPreview(s, f.player.B2, 280)).toMatchObject({ rank: 2, label: "2nd" });
    expect(rankPreview(s, f.player.B2, 260.4)).toMatchObject({ rank: 2, label: "T2nd" });
    expect(rankPreview(s, f.player.B2, 320)).toMatchObject({ rank: 1, label: "1st" });
    expect(rankPreview(s, f.player.B2, 320).leader?.player_id).toBe(f.player.A1);
    // The only other entry is mine: I'd lead with anything.
    expect(rankPreview(s, f.player.A1, 100).leader?.player_id).toBe(f.player.B1);
    expect(rankPreview(s, f.player.A1, 100)).toMatchObject({ rank: 2, label: "2nd" });
  });
});

describe("contestScore", () => {
  it("is smaller-is-better for both kinds at the right precision", () => {
    expect(contestScore("ctp", 3)).toBe(36);
    expect(contestScore("ctp", 3.04)).toBe(36);
    expect(contestScore("ld", 287.4)).toBe(-287);
    expect(contestScore("ld", 300)).toBeLessThan(contestScore("ld", 290));
  });
});
