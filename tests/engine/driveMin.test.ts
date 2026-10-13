import { describe, expect, it, vi } from "vitest";
import { computeDriveMin } from "@/lib/engine/driveMin";
import { computeRoster } from "@/lib/engine";
import type { DriveLevel, DriveNineStatus, TeamDriveStatus } from "@/lib/engine/types";
import type { TeamRoundState } from "@/lib/types";
import { makeTrip, type TripFixture } from "../fixtures";

// windows.ts is owned by another module. Use it when it is implemented; until then fall back
// to its documented semantics so these tests exercise driveMin on its own.
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

const PAR: Record<number, number> = { 1: 4, 2: 4, 3: 3, 4: 5, 5: 4, 6: 4, 7: 4, 8: 3, 9: 5, 10: 4, 11: 3, 12: 5, 13: 4, 14: 4, 15: 4, 16: 3, 17: 4, 18: 5 };

function drive(f: TripFixture, team: string): TeamDriveStatus {
  return computeDriveMin(f.state, computeRoster(f.state).membersOfTeam)[f.team[team]];
}
const nine = (f: TripFixture, team: string, n: 1 | 2): DriveNineStatus => drive(f, team).nines[n - 1];
const labels = (f: TripFixture, ids: string[]) => ids.map((id) => Object.keys(f.player).find((k) => f.player[k] === id));

type Expect = [level: DriveLevel, remaining: number, needing: number];

/**
 * Walk a team through holes, asserting the drive status of that hole's nine
 * "on the tee" (window opened, no tee shot yet) and after the tee shot is recorded.
 */
function walk(f: TripFixture, team: string, steps: [hole: number, teeShot: string, onTee: Expect, after: Expect][]) {
  for (const [hole, teeShot, onTee, after] of steps) {
    const n = hole <= 9 ? 1 : 2;
    f.teeOff(team, hole);
    const a = nine(f, team, n);
    expect([a.level, a.remaining, a.needing.length], `hole ${hole} on the tee`).toEqual(onTee);
    f.score(team, hole, PAR[hole], teeShot);
    const b = nine(f, team, n);
    expect([b.level, b.remaining, b.needing.length], `hole ${hole} after ${teeShot}'s drive`).toEqual(after);
  }
}

describe("computeDriveMin", () => {
  it("not started: both nines open with every member at 0", () => {
    const f = makeTrip({ teams: [4, 3] });
    const s = drive(f, "A");
    expect(s.team_id).toBe(f.team.A);
    expect(s.current_nine).toBe(1);
    expect(s.nines[0]).toEqual({
      nine: 1,
      holes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      counts: { [f.player.A1]: 0, [f.player.A2]: 0, [f.player.A3]: 0, [f.player.A4]: 0 },
      needing: [f.player.A1, f.player.A2, f.player.A3, f.player.A4],
      remaining: 9,
      level: "ok",
      closed: false,
      missed: [],
    });
    expect(s.nines[1]).toMatchObject({ nine: 2, holes: [10, 11, 12, 13, 14, 15, 16, 17, 18], remaining: 9, level: "ok", closed: false });
    expect(Object.keys(computeDriveMin(f.state, computeRoster(f.state).membersOfTeam)).sort()).toEqual([f.team.A, f.team.B].sort());
  });

  it("foursome, front nine: soft from 3 holes left, hard when holes left = players needing; par 3 drives count", () => {
    const f = makeTrip({ teams: [4] });
    walk(f, "A", [
      [1, "A1", ["ok", 9, 4], ["ok", 8, 3]],
      [2, "A1", ["ok", 8, 3], ["ok", 7, 3]],
      [3, "A2", ["ok", 7, 3], ["ok", 6, 2]], // par 3 counts for A2
      [4, "A1", ["ok", 6, 2], ["ok", 5, 2]],
      [5, "A1", ["ok", 5, 2], ["ok", 4, 2]],
      [6, "A1", ["ok", 4, 2], ["soft", 3, 2]],
      [7, "A3", ["soft", 3, 2], ["soft", 2, 1]],
      [8, "A1", ["soft", 2, 1], ["hard", 1, 1]], // par 3
      [9, "A4", ["hard", 1, 1], ["ok", 0, 0]],
    ]);
    const front = nine(f, "A", 1);
    expect(front.counts).toEqual({ [f.player.A1]: 6, [f.player.A2]: 1, [f.player.A3]: 1, [f.player.A4]: 1 });
    // Still on hole 9: the nine isn't over until the team moves on.
    expect(front).toMatchObject({ closed: false, needing: [], level: "ok", missed: [] });
    // The back nine is untouched by front-nine drives.
    expect(nine(f, "A", 2)).toMatchObject({ remaining: 9, level: "ok", needing: Object.values(f.player) });
    f.teeOff("A", 10);
    expect(drive(f, "A").current_nine).toBe(2);
    expect(nine(f, "A", 1)).toMatchObject({ closed: true, remaining: 0, level: "ok", missed: [] });
  });

  it("foursome: hard with three players needing, then impossible, then a miss", () => {
    const f = makeTrip({ teams: [4] });
    walk(f, "A", [
      [1, "A1", ["ok", 9, 4], ["ok", 8, 3]],
      [2, "A1", ["ok", 8, 3], ["ok", 7, 3]],
      [3, "A1", ["ok", 7, 3], ["ok", 6, 3]],
      [4, "A1", ["ok", 6, 3], ["ok", 5, 3]],
      [5, "A1", ["ok", 5, 3], ["ok", 4, 3]],
      [6, "A1", ["ok", 4, 3], ["hard", 3, 3]],
      [7, "A1", ["hard", 3, 3], ["impossible", 2, 3]],
      [8, "A2", ["impossible", 2, 3], ["impossible", 1, 2]],
    ]);
    // Last hole: A3 drives, so A4 is left at 0. Still on hole 9 it's "impossible" (a mis-tap could
    // still be fixed); teeing off 10 closes the nine with a miss.
    f.teeOff("A", 9);
    f.score("A", 9, 5, "A3");
    let front = nine(f, "A", 1);
    expect(front).toMatchObject({ closed: false, remaining: 0, level: "impossible", missed: [] });
    expect(labels(f, front.needing)).toEqual(["A4"]);
    f.teeOff("A", 10);
    front = nine(f, "A", 1);
    expect(front).toMatchObject({ closed: true, remaining: 0, level: "ok" });
    expect(labels(f, front.missed)).toEqual(["A4"]);
    expect(labels(f, front.needing)).toEqual(["A4"]);
  });

  it("threesome, back nine: soft then hard at the right holes (par 3s count)", () => {
    const f = makeTrip({ teams: [3] });
    for (let h = 1; h <= 9; h++) {
      f.teeOff("A", h);
      f.score("A", h, PAR[h], `A${(h % 3) + 1}`);
    }
    expect(nine(f, "A", 1)).toMatchObject({ closed: false, needing: [], missed: [], level: "ok" });
    walk(f, "A", [
      [10, "A1", ["ok", 9, 3], ["ok", 8, 2]],
      [11, "A1", ["ok", 8, 2], ["ok", 7, 2]], // par 3
      [12, "A1", ["ok", 7, 2], ["ok", 6, 2]],
      [13, "A1", ["ok", 6, 2], ["ok", 5, 2]],
      [14, "A1", ["ok", 5, 2], ["ok", 4, 2]],
      [15, "A1", ["ok", 4, 2], ["soft", 3, 2]],
      [16, "A1", ["soft", 3, 2], ["hard", 2, 2]], // par 3
      [17, "A2", ["hard", 2, 2], ["hard", 1, 1]],
      [18, "A3", ["hard", 1, 1], ["ok", 0, 0]],
    ]);
    expect(drive(f, "A").current_nine).toBe(2);
    expect(nine(f, "A", 1)).toMatchObject({ closed: true, missed: [] });
    expect(nine(f, "A", 2)).toMatchObject({ closed: false, needing: [], missed: [] });
    f.complete("A");
    expect(nine(f, "A", 2)).toMatchObject({ closed: true, missed: [] });
  });

  it("threesome, front nine: soft at 3 left, hard at 2, then a miss when the last hole goes to someone else", () => {
    const f = makeTrip({ teams: [3] });
    walk(f, "A", [
      [1, "A1", ["ok", 9, 3], ["ok", 8, 2]],
      [2, "A1", ["ok", 8, 2], ["ok", 7, 2]],
      [3, "A1", ["ok", 7, 2], ["ok", 6, 2]],
      [4, "A1", ["ok", 6, 2], ["ok", 5, 2]],
      [5, "A1", ["ok", 5, 2], ["ok", 4, 2]],
      [6, "A1", ["ok", 4, 2], ["soft", 3, 2]],
      [7, "A1", ["soft", 3, 2], ["hard", 2, 2]],
      [8, "A2", ["hard", 2, 2], ["hard", 1, 1]], // par 3 drive counts for A2
      [9, "A1", ["hard", 1, 1], ["impossible", 0, 1]], // every hole has a drive, A3 at 0: too late
    ]);
    const front = nine(f, "A", 1);
    expect(front).toMatchObject({ closed: false, missed: [] });
    f.teeOff("A", 10);
    expect(nine(f, "A", 1).closed).toBe(true);
    expect(labels(f, nine(f, "A", 1).missed)).toEqual(["A3"]);
  });

  it("twosome: soft with 3 left, hard when the last needing player has 1 hole left", () => {
    const f = makeTrip({ teams: [2] });
    for (let h = 1; h <= 6; h++) {
      f.teeOff("A", h);
      f.score("A", h, PAR[h]); // strokes only, no tee shot recorded
    }
    f.teeOff("A", 7);
    expect(nine(f, "A", 1)).toMatchObject({ level: "soft", remaining: 3 });
    f.score("A", 7, 4, "A1");
    expect(nine(f, "A", 1)).toMatchObject({ level: "soft", remaining: 2 });
    f.teeOff("A", 8);
    expect(nine(f, "A", 1)).toMatchObject({ level: "soft", remaining: 2, needing: [f.player.A2] });
    f.score("A", 8, 3, "A1");
    expect(nine(f, "A", 1)).toMatchObject({ level: "hard", remaining: 1 });
  });

  it("holes already passed without a tee shot don't count as remaining", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 5);
    expect(nine(f, "A", 1)).toMatchObject({ remaining: 5, level: "ok", closed: false });
    f.teeOff("A", 7);
    expect(nine(f, "A", 1)).toMatchObject({ remaining: 3, level: "impossible" });
  });

  it("moving past a nine closes it, with everyone at 0 missed", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1).teeOff("A", 10);
    const front = nine(f, "A", 1);
    expect(front).toMatchObject({ closed: true, remaining: 0, level: "ok" });
    expect(labels(f, front.missed)).toEqual(["A1", "A2", "A3"]);
    expect(nine(f, "A", 2)).toMatchObject({ closed: false, remaining: 9, missed: [] });
  });

  it("round complete closes both nines", () => {
    const f = makeTrip({ teams: [3] });
    for (let h = 1; h <= 18; h++) {
      f.teeOff("A", h);
      f.score("A", h, PAR[h], h <= 9 ? `A${(h % 3) + 1}` : "A1");
    }
    // On 18 with a drive recorded on every hole, the nine stays open until Round complete.
    expect(nine(f, "A", 2)).toMatchObject({ closed: false, remaining: 0, level: "impossible" });
    f.complete("A");
    const s = drive(f, "A");
    expect(s.current_nine).toBe(2);
    expect(s.nines[0]).toMatchObject({ closed: true, remaining: 0, missed: [] });
    expect(s.nines[1]).toMatchObject({ closed: true, remaining: 0, level: "ok" });
    expect(labels(f, s.nines[1].missed)).toEqual(["A2", "A3"]);
  });

  it("a mis-tapped chip on the last hole of a nine stays fixable: impossible, not missed, until the team moves on", () => {
    const f = makeTrip({ teams: [4] });
    const shots = ["A1", "A2", "A3", "A1", "A2", "A3", "A1", "A2"];
    shots.forEach((who, i) => f.teeOff("A", i + 1).score("A", i + 1, 4, who));
    f.teeOff("A", 9);
    expect(nine(f, "A", 1)).toMatchObject({ level: "hard", remaining: 1, needing: [f.player.A4] });
    f.score("A", 9, 5, "A1"); // wrong chip
    expect(nine(f, "A", 1)).toMatchObject({ level: "impossible", remaining: 0, closed: false, missed: [] });
    f.score("A", 9, 5, "A4"); // fixed
    expect(nine(f, "A", 1)).toMatchObject({ level: "ok", needing: [], closed: false, missed: [] });
    f.teeOff("A", 10);
    expect(nine(f, "A", 1)).toMatchObject({ closed: true, missed: [] });
  });

  it("a final trip closes every nine of a team that teed off (no Round complete tapped)", () => {
    const f = makeTrip({ teams: [4, 3] });
    for (let h = 1; h <= 18; h++) f.teeOff("A", h).score("A", h, 4, h <= 9 ? ["A1", "A2", "A3", "A4"][h % 4] : h < 18 ? "A1" : null);
    expect(nine(f, "A", 2)).toMatchObject({ closed: false, level: "impossible", remaining: 1 });
    f.state = { ...f.state, trip: { ...f.state.trip, status: "final" } };
    const s = drive(f, "A");
    expect(s.nines[0]).toMatchObject({ closed: true, missed: [], level: "ok" });
    expect(s.nines[1]).toMatchObject({ closed: true, remaining: 0, level: "ok" });
    expect(labels(f, s.nines[1].missed)).toEqual(["A2", "A3", "A4"]);
    // Team B never teed off: nothing to close, nothing missed.
    expect(drive(f, "B").nines.map((n) => [n.closed, n.missed.length])).toEqual([
      [false, 0],
      [false, 0],
    ]);
  });

  it("completing early (holes missing) still closes the back nine", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1).teeOff("A", 12).complete("A");
    const s = drive(f, "A");
    expect(s.nines[1]).toMatchObject({ closed: true, remaining: 0, level: "ok" });
    expect(s.nines[1].missed).toHaveLength(4);
  });

  it("ignores tee shots by non-members but treats the hole as taken; counts only current members", () => {
    const f = makeTrip({ teams: [3, 3] }).teeOff("A", 1);
    f.score("A", 1, 4, "B1"); // bad data: a player from another team
    let front = nine(f, "A", 1);
    expect(Object.keys(front.counts).sort()).toEqual([f.player.A1, f.player.A2, f.player.A3].sort());
    expect(front).toMatchObject({ remaining: 8, needing: [f.player.A1, f.player.A2, f.player.A3] });

    // A3 drives hole 2, then is moved off the team: their drive no longer counts for anyone.
    f.teeOff("A", 2);
    f.score("A", 2, 4, "A3");
    expect(nine(f, "A", 1).counts[f.player.A3]).toBe(1);
    f.state = { ...f.state, team_members: f.state.team_members.filter((m) => m.player_id !== f.player.A3) };
    front = nine(f, "A", 1);
    expect(front.counts).toEqual({ [f.player.A1]: 0, [f.player.A2]: 0 });
    expect(front.remaining).toBe(7);
  });

  it("clearing a tee shot puts the hole back in play", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 9);
    f.score("A", 9, 5, "A1");
    expect(nine(f, "A", 1)).toMatchObject({ remaining: 0, level: "impossible" });
    f.score("A", 9, 5, null);
    expect(nine(f, "A", 1)).toMatchObject({ remaining: 1, level: "impossible", needing: Object.values(f.player) });
  });

  it("nobody needing a drive is always ok", () => {
    const f = makeTrip({ teams: [2] });
    f.teeOff("A", 1).score("A", 1, 4, "A1");
    f.teeOff("A", 2).score("A", 2, 4, "A2");
    for (let h = 3; h <= 8; h++) f.teeOff("A", h);
    expect(nine(f, "A", 1)).toMatchObject({ level: "ok", needing: [], remaining: 2, closed: false });
  });
});
