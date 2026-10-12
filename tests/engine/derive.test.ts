import { afterEach, describe, expect, it, vi } from "vitest";
import { derive, type Derived } from "@/lib/engine";
import type { TeamRoundState, TripState } from "@/lib/types";
import { at, makeTrip } from "../fixtures";

// windows.ts is owned by another module. Use it when it is implemented; until then fall back
// to its documented semantics so derive() can be exercised on its own.
vi.mock("@/lib/engine/windows", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/engine/windows")>();
  try {
    real.openWindowHole(null);
    real.currentHoleFor(null);
    return real;
  } catch {
    return {
      openWindowHole: (rs: TeamRoundState | null | undefined) => (rs && rs.status === "playing" ? rs.open_hole : null),
      currentHoleFor: (rs: TeamRoundState | null | undefined) =>
        !rs || rs.status === "not_started" ? 1 : rs.status === "playing" ? (rs.open_hole ?? 1) : (rs.open_hole ?? 18),
    };
  }
});

/** Contests, money and awards are other modules; while they are stubs derive() logs and falls back. */
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
afterEach(() => vi.restoreAllMocks());

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe("derive — roster and lookups", () => {
  it("builds sorted active players/teams/holes and the index maps", () => {
    quiet();
    const f = makeTrip({ teams: [4, 3, 3], groom: "B2" });
    const s = f.state;
    f.state = {
      ...s,
      // Shuffled input order; one deleted player and one deleted (empty) team.
      holes: [...s.holes].reverse(),
      players: [...s.players].reverse().map((p) => (p.id === f.player.A4 ? { ...p, deleted_at: at(1) } : p)),
      teams: [
        ...[...s.teams].reverse(),
        { ...s.teams[0], id: "team-deleted", name: "Ghosts", sort_order: -1, deleted_at: at(2) },
      ],
    };
    const d = derive(f.state);
    expect(d.players.map((p) => p.id)).toEqual(
      ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"].map((k) => f.player[k]),
    );
    expect(d.teams.map((t) => t.id)).toEqual([f.team.A, f.team.B, f.team.C]);
    expect(d.holes.map((h) => h.number)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(d.holeByNumber[3].par).toBe(3);
    expect(d.playerById[f.player.B2].name).toBe("Player B2");
    expect(d.playerById[f.player.A4]).toBeUndefined();
    expect(d.teamById[f.team.C].name).toBe("Team C");
    expect(d.teamById["team-deleted"]).toBeUndefined();
    expect(d.teamOfPlayer[f.player.C3]).toBe(f.team.C);
    expect(d.teamOfPlayer[f.player.A4]).toBeUndefined();
    expect(d.membersOfTeam[f.team.A].map((p) => p.id)).toEqual([f.player.A1, f.player.A2, f.player.A3]);
    expect(d.teamSize).toEqual({ [f.team.A]: 3, [f.team.B]: 3, [f.team.C]: 3 });
    expect(d.groomId).toBe(f.player.B2);
    expect(d.mulligans[f.team.B].groom_available).toBe(true);
    expect(d.drinkers).toHaveLength(9);
  });

  it("sorts players and teams by sort_order, then name", () => {
    quiet();
    const f = makeTrip({ teams: [2, 2] });
    f.state = {
      ...f.state,
      players: f.state.players.map((p) => ({ ...p, sort_order: 0, name: { A1: "Zed", A2: "amy", B1: "Bob", B2: "Al" }[p.name.slice(-2)]! })),
      teams: f.state.teams.map((t) => ({ ...t, sort_order: t.id === f.team.A ? 5 : 1 })),
    };
    const d = derive(f.state);
    expect(d.players.map((p) => p.name)).toEqual(["Al", "amy", "Bob", "Zed"]);
    expect(d.teams.map((t) => t.id)).toEqual([f.team.B, f.team.A]);
    expect(d.membersOfTeam[f.team.A].map((p) => p.name)).toEqual(["amy", "Zed"]);
  });

  it("a member who is deleted makes the team smaller for ghost beer math", () => {
    quiet();
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    f.state = { ...f.state, players: f.state.players.map((p) => (p.id === f.player.A4 ? { ...p, deleted_at: at(0) } : p)) };
    for (const p of ["A1", "A2", "A3"]) f.drink("A", p, 1);
    const d = derive(f.state);
    expect(d.teamSize[f.team.A]).toBe(3);
    expect(d.teamHoles[f.team.A][0].credit).toBe(4);
  });

  it("uses opts.now for computed_at, else the trip's updated_at", () => {
    quiet();
    const f = makeTrip({ teams: [2] });
    expect(derive(f.state).computed_at).toBe(f.state.trip.updated_at);
    expect(derive(f.state, { now: "2026-10-24T20:00:00.000Z" }).computed_at).toBe("2026-10-24T20:00:00.000Z");
  });
});

describe("derive — windows, standings and leaders", () => {
  it("open window and current hole per team", () => {
    quiet();
    const f = makeTrip({ teams: [4, 3, 3] }).teeOff("B", 1).teeOff("B", 5).teeOff("C", 1).teeOff("C", 18).complete("C");
    const d = derive(f.state);
    expect(d.openWindow).toEqual({ [f.team.A]: null, [f.team.B]: 5, [f.team.C]: null });
    expect(d.currentHole).toEqual({ [f.team.A]: 1, [f.team.B]: 5, [f.team.C]: 18 });
    expect(d.driveMin[f.team.B].current_nine).toBe(1);
    expect(d.driveMin[f.team.C].current_nine).toBe(2);
  });

  it("works for a setup trip with no round state rows", () => {
    quiet();
    const f = makeTrip({ teams: [4, 3], status: "setup" });
    const d = derive(f.state);
    expect(d.openWindow[f.team.A]).toBeNull();
    expect(d.currentHole[f.team.B]).toBe(1);
    expect(d.standings.map((r) => r.status)).toEqual(["not_started", "not_started"]);
    expect(d.leaderTeamIds).toEqual([]);
  });

  it("leaderTeamIds: empty before anyone scores, then every team tied for first", () => {
    quiet();
    const f = makeTrip({ teams: [4, 3, 3] });
    expect(derive(f.state).leaderTeamIds).toEqual([]);
    f.teeOff("A", 1).score("A", 1, 4);
    expect(derive(f.state).leaderTeamIds).toEqual([f.team.A]);
    f.teeOff("B", 1).score("B", 1, 5);
    f.drink("B", "B1", 1);
    expect(derive(f.state).leaderTeamIds).toEqual([f.team.A, f.team.B]);
    f.drink("B", "B2", 1);
    const d = derive(f.state);
    expect(d.leaderTeamIds).toEqual([f.team.B]);
    expect(d.standings.map((r) => r.pos_label)).toEqual(["1", "2", "–"]);
  });
});

describe("derive — spec scoring checks end to end", () => {
  it("threesome 2 drinks on hole 1 + 1 on hole 2, then delete the 2nd", () => {
    quiet();
    const f = makeTrip({ teams: [4, 3] }).teeOff("B", 1);
    f.drink("B", "B1", 1);
    const second = f.drink("B", "B2", 1);
    f.teeOff("B", 2);
    const third = f.drink("B", "B3", 2);
    let d = derive(f.state);
    expect(d.drinkValues[third]).toMatchObject({ value: 2, ghost: true, seq: 3, hole: 2 });
    expect([d.teamHoles[f.team.B][0].credit, d.teamHoles[f.team.B][1].credit]).toEqual([2, 2]);
    f.deleteDrink(second);
    d = derive(f.state);
    expect([d.teamHoles[f.team.B][0].credit, d.teamHoles[f.team.B][1].credit]).toEqual([1, 1]);
    expect(d.standings.find((r) => r.team_id === f.team.B)).toMatchObject({ drinks: 2, credit: 2, ghost_beers: 0 });
  });

  it("shotgun and shot: -1 each, one mulligan each; using mulligans never changes net", () => {
    quiet();
    const f = makeTrip({ teams: [4, 3] }).teeOff("A", 1);
    f.drink("A", "A1", 1, "shotgun");
    f.drink("A", "A2", 1, "shot");
    f.drink("A", "A3", 1, "drink");
    f.drink("A", "A4", 1, "drink");
    f.drink("A", "A1", 1, "drink");
    f.score("A", 1, 4);
    const before = derive(f.state);
    expect(before.teamHoles[f.team.A][0].net).toBe(-1);
    expect(before.mulligans[f.team.A]).toMatchObject({ earned: 2, available: 2 });
    f.mulligan("A", 1, "earned");
    f.mulligan("A", 1, "earned");
    f.mulligan("A", 1, "groom");
    const after = derive(f.state);
    expect(after.mulligans[f.team.A]).toMatchObject({ available: 0, used_total: 3, groom_used: true, groom_available: false });
    expect(after.teamHoles).toEqual(before.teamHoles);
    expect(after.standings).toEqual(before.standings);
    const a1 = after.drinkers.find((r) => r.player_id === f.player.A1)!;
    expect(a1).toMatchObject({ drinks: 1, shotguns: 1, shots: 0, total: 2 });
  });
});

describe("derive — purity, determinism, speed", () => {
  function fullRound(): TripState {
    const f = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000, contest_ante_cents: 500 } });
    for (const t of ["A", "B", "C"]) {
      const size = f.state.team_members.filter((m) => m.team_id === f.team[t]).length;
      for (let h = 1; h <= 18; h++) {
        f.teeOff(t, h);
        for (let i = 0; i < 4; i++) f.drink(t, `${t}${(i % size) + 1}`, h, i === 3 ? "shotgun" : "drink");
        f.score(t, h, 4 + (h % 3), `${t}${(h % size) + 1}`);
        if (h % 6 === 0) f.mulligan(t, h, "earned");
      }
      f.complete(t);
    }
    return f.state;
  }

  it("does not mutate its input and is deterministic", () => {
    quiet();
    const state = deepFreeze(fullRound());
    const a = derive(state);
    const b = derive(state);
    expect(b).toEqual(a);
    expect(a.standings.every((r) => r.thru_label === "F")).toBe(true);
    expect(Object.keys(a.drinkValues)).toHaveLength(3 * 18 * 4);
  });

  it("is fast enough to run on every tap", () => {
    quiet();
    const state = fullRound();
    derive(state); // warm up
    const runs = 50;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) derive(state);
    const avg = (performance.now() - t0) / runs;
    expect(avg).toBeLessThan(25);
  });
});

describe("derive — resilience", () => {
  it("keeps scores and standings when a secondary view throws, and rethrows in strict mode", async () => {
    vi.resetModules();
    vi.doMock("@/lib/engine/awards", () => ({
      computeAwards: () => {
        throw new Error("boom");
      },
    }));
    vi.doMock("@/lib/engine/pots", () => ({
      computeMoney: () => {
        throw new Error("boom");
      },
    }));
    vi.doMock("@/lib/engine/contests", () => ({
      computeContests: () => {
        throw new Error("boom");
      },
    }));
    const engine = await import("@/lib/engine");
    const errors = quiet();
    const f = makeTrip({ teams: [4, 3], status: "final" }).teeOff("A", 1).score("A", 1, 3);
    const d = engine.derive(f.state);
    expect(d.standings[0]).toMatchObject({ team_id: f.team.A, net_to_par: -1 });
    expect(d.contests).toEqual([]);
    expect(d.awards).toEqual([]);
    expect(d.money).toEqual({ final: true, pots: [], ledger: [], payments: [], total_in_play_cents: 0 });
    expect(errors).toHaveBeenCalledTimes(3);
    expect(() => engine.derive(f.state, { strict: true })).toThrow("boom");
    vi.doUnmock("@/lib/engine/awards");
    vi.doUnmock("@/lib/engine/pots");
    vi.doUnmock("@/lib/engine/contests");
    vi.resetModules();
  });
});

// Runs last: the full pipeline with contests, money and awards from their own modules.
describe("derive — strict end to end (needs every engine module)", () => {
  it("derives a finished round without any module throwing", (ctx) => {
    const f = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000, contest_ante_cents: 500 } });
    for (const t of ["A", "B", "C"]) {
      for (let h = 1; h <= 18; h++) {
        f.teeOff(t, h);
        f.score(t, h, 4, `${t}1`);
      }
      f.complete(t);
    }
    f.drink("B", "B1", 7, "shotgun");
    let d: Derived;
    try {
      d = derive(f.state, { strict: true });
    } catch (err) {
      if (err instanceof Error && err.message === "not implemented") {
        ctx.skip(`another engine module is still a stub: ${err.stack?.split("\n")[1]?.trim() ?? ""}`);
      }
      throw err;
    }
    expect(d.standings[0].team_id).toBe(f.team.B);
    expect(d.leaderTeamIds).toEqual([f.team.B]);
    expect(d.contests.map((c) => c.hole)).toEqual([3, 4, 8, 9, 11, 12, 16, 18]);
    expect(d.money.ledger.reduce((s, r) => s + r.net_cents, 0)).toBe(0);
    expect(Array.isArray(d.awards)).toBe(true);
  });
});
