import { describe, expect, it } from "vitest";
import { compareDrinkOrder, computeDrinkValues, creditFor } from "@/lib/engine/drinks";
import { computeTeamHoles } from "@/lib/engine/scoring";
import { computeRoster, derive } from "@/lib/engine";
import type { DrinkValue } from "@/lib/engine/types";
import type { Drink, TripState } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "../fixtures";

const values = (state: TripState) => computeDrinkValues(state, computeRoster(state).teamSize);

/** Values of one team's drinks in ghost-beer order. */
function sequence(f: TripFixture, team: string): DrinkValue[] {
  return Object.values(values(f.state))
    .filter((v) => v.team_id === f.team[team])
    .sort((a, b) => a.seq - b.seq);
}

function holeCredit(f: TripFixture, team: string, hole: number): number {
  const lines = computeTeamHoles(f.state, values(f.state))[f.team[team]];
  return lines[hole - 1].credit;
}

describe("creditFor", () => {
  it("is floor(base * d / n)", () => {
    expect([1, 2, 3, 4].map((d) => creditFor(d, 4, 4))).toEqual([1, 2, 3, 4]);
    expect([1, 2, 3, 4, 5, 6].map((d) => creditFor(d, 3, 4))).toEqual([1, 2, 4, 5, 6, 8]);
    expect([1, 2, 3].map((d) => creditFor(d, 2, 4))).toEqual([2, 4, 6]);
    expect([1, 2, 3, 4].map((d) => creditFor(d, 4, 3))).toEqual([0, 1, 2, 3]);
  });
  it("is 0 before any drink", () => {
    expect(creditFor(0, 3, 4)).toBe(0);
  });
  it("treats an empty team as a full team instead of dividing by zero", () => {
    expect(creditFor(5, 0, 4)).toBe(5);
    expect(creditFor(5, -1, 4)).toBe(5);
  });
  it("falls back to base 4 when the base is unusable", () => {
    expect(creditFor(3, 3, 0)).toBe(4);
    expect(creditFor(3, 3, Number.NaN)).toBe(4);
  });
});

describe("computeDrinkValues — spec scoring tests", () => {
  it("foursome logs 4 drinks on hole 1: hole 1 credit is 4", () => {
    const f = makeTrip({ teams: [4, 3] }).teeOff("A", 1);
    for (const p of ["A1", "A2", "A3", "A4"]) f.drink("A", p, 1);
    expect(sequence(f, "A").map((v) => v.value)).toEqual([1, 1, 1, 1]);
    expect(sequence(f, "A").some((v) => v.ghost)).toBe(false);
    expect(holeCredit(f, "A", 1)).toBe(4);
  });

  it("threesome logs drinks 1, 2, 3: values are 1, 1, 2 and drink 3 is a ghost beer", () => {
    const f = makeTrip({ teams: [4, 3] }).teeOff("B", 1);
    const ids = [f.drink("B", "B1", 1), f.drink("B", "B2", 1), f.drink("B", "B3", 1)];
    const v = values(f.state);
    expect(ids.map((id) => v[id].value)).toEqual([1, 1, 2]);
    expect(ids.map((id) => v[id].ghost)).toEqual([false, false, true]);
    expect(ids.map((id) => v[id].seq)).toEqual([1, 2, 3]);
  });

  it("threesome logs 2 drinks on hole 1 and 1 on hole 2: hole 1 credit 2, hole 2 credit 2", () => {
    const f = makeTrip({ teams: [4, 3] }).teeOff("B", 1);
    f.drink("B", "B1", 1);
    f.drink("B", "B2", 1);
    f.teeOff("B", 2);
    f.drink("B", "B3", 2);
    expect(holeCredit(f, "B", 1)).toBe(2);
    expect(holeCredit(f, "B", 2)).toBe(2);
  });

  it("deleting the threesome's 2nd drink recomputes: hole 1 credit 1, hole 2 credit 1", () => {
    const f = makeTrip({ teams: [4, 3] }).teeOff("B", 1);
    f.drink("B", "B1", 1);
    const second = f.drink("B", "B2", 1);
    f.teeOff("B", 2);
    const third = f.drink("B", "B3", 2);
    expect(values(f.state)[third].ghost).toBe(true);
    f.deleteDrink(second);
    expect(holeCredit(f, "B", 1)).toBe(1);
    expect(holeCredit(f, "B", 2)).toBe(1);
    const v = values(f.state);
    expect(v[second]).toBeUndefined();
    expect(v[third]).toMatchObject({ seq: 2, value: 1, ghost: false });
  });

  it("twosome: every drink is worth 2", () => {
    const f = makeTrip({ teams: [4, 2] }).teeOff("B", 1);
    for (let i = 0; i < 6; i++) f.drink("B", i % 2 ? "B2" : "B1", 1 + Math.floor(i / 2));
    const seq = sequence(f, "B");
    expect(seq.map((v) => v.value)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(seq.every((v) => v.ghost)).toBe(true);
    expect(holeCredit(f, "B", 1)).toBe(4);
    expect(holeCredit(f, "B", 3)).toBe(4);
  });

  it("respects the base team size: base 4, threesome, six drinks -> 1,1,2,1,1,2 (sum 8)", () => {
    const f = makeTrip({ teams: [3], base_team_size: 4 }).teeOff("A", 1);
    for (let i = 0; i < 6; i++) f.drink("A", `A${(i % 3) + 1}`, 1);
    const seq = sequence(f, "A");
    expect(seq.map((v) => v.value)).toEqual([1, 1, 2, 1, 1, 2]);
    expect(seq.reduce((s, v) => s + v.value, 0)).toBe(Math.floor((4 * 6) / 3));
    expect(holeCredit(f, "A", 1)).toBe(8);
  });

  it("base 3: a threesome gets 1 per drink, a foursome is scaled down (0,1,1,1)", () => {
    const f = makeTrip({ teams: [3, 4], base_team_size: 3 }).teeOff("A", 1).teeOff("B", 1);
    for (let i = 0; i < 6; i++) f.drink("A", `A${(i % 3) + 1}`, 1);
    for (let i = 0; i < 8; i++) f.drink("B", `B${(i % 4) + 1}`, 1);
    expect(sequence(f, "A").map((v) => v.value)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(sequence(f, "B").map((v) => v.value)).toEqual([0, 1, 1, 1, 0, 1, 1, 1]);
    expect(holeCredit(f, "B", 1)).toBe(6);
  });

  it("base 2: a foursome's drinks alternate 0 and 1", () => {
    const f = makeTrip({ teams: [4], base_team_size: 2 }).teeOff("A", 1);
    for (let i = 0; i < 4; i++) f.drink("A", "A1", 1);
    expect(sequence(f, "A").map((v) => v.value)).toEqual([0, 1, 0, 1]);
  });
});

describe("computeDrinkValues — ordering and recompute", () => {
  it("orders by logged_at, not by insertion order", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1, 0);
    const late = f.drink("A", "A1", 1, "drink", { min: 30 });
    const early = f.drink("A", "A2", 1, "drink", { min: 10 });
    const middle = f.drink("A", "A3", 1, "drink", { min: 20 });
    const v = values(f.state);
    expect([early, middle, late].map((id) => v[id].seq)).toEqual([1, 2, 3]);
    expect(v[late].ghost).toBe(true);
  });

  it("breaks logged_at ties by id", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1, 0);
    f.drink("A", "A1", 1, "drink", { min: 5, id: "drink-c" });
    f.drink("A", "A2", 1, "drink", { min: 5, id: "drink-a" });
    f.drink("A", "A3", 1, "drink", { min: 5, id: "drink-b" });
    const v = values(f.state);
    expect(v["drink-a"].seq).toBe(1);
    expect(v["drink-b"].seq).toBe(2);
    expect(v["drink-c"]).toMatchObject({ seq: 3, value: 2, ghost: true });
  });

  it("orders by actual time even when timestamps use different ISO spellings", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1, 0);
    const a = f.drink("A", "A1", 1, "drink", { min: 10 });
    const b = f.drink("A", "A2", 1, "drink", { min: 20 });
    // Same instant as min 5 but with an explicit offset: sorts first by time, not by string.
    const t5 = new Date(Date.parse(at(5)) + 2 * 3600_000).toISOString().replace("Z", "+02:00");
    f.state = { ...f.state, drinks: f.state.drinks.map((d) => (d.id === b ? { ...d, logged_at: t5 } : d)) };
    const v = values(f.state);
    expect(v[b].seq).toBe(1);
    expect(v[a].seq).toBe(2);
  });

  it("compareDrinkOrder is a total order", () => {
    const base: Drink = {
      id: "x",
      trip_id: "t",
      team_id: "team",
      player_id: "p",
      hole: 1,
      type: "drink",
      photo_path: null,
      logged_by: null,
      logged_at: at(1),
      created_at: at(1),
      deleted_at: null,
      deleted_by: null,
      moved_from_hole: null,
    };
    expect(compareDrinkOrder(base, { ...base })).toBe(0);
    expect(compareDrinkOrder(base, { ...base, id: "y" })).toBeLessThan(0);
    expect(compareDrinkOrder({ ...base, logged_at: at(2) }, { ...base, id: "a" })).toBeGreaterThan(0);
    expect(compareDrinkOrder({ ...base, logged_at: "garbage" }, base)).toBeGreaterThan(0);
  });

  it("counts each team independently", () => {
    const f = makeTrip({ teams: [3, 3] }).teeOff("A", 1).teeOff("B", 1);
    f.drink("A", "A1", 1);
    f.drink("B", "B1", 1);
    f.drink("A", "A2", 1);
    f.drink("B", "B2", 1);
    const b3 = f.drink("B", "B3", 1);
    expect(sequence(f, "A").map((v) => v.value)).toEqual([1, 1]);
    expect(sequence(f, "B").map((v) => v.value)).toEqual([1, 1, 2]);
    expect(values(f.state)[b3].ghost).toBe(true);
  });

  it("carries type, player and hole through and credits a moved drink to its new hole", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1);
    const shot = f.drink("A", "A3", 1, "shot");
    expect(values(f.state)[shot]).toMatchObject({ team_id: f.team.A, player_id: f.player.A3, hole: 1, type: "shot", value: 2 });
    // Commissioner moves the ghost beer to hole 2: same order, so same value, now on hole 2.
    f.state = { ...f.state, drinks: f.state.drinks.map((d) => (d.id === shot ? { ...d, hole: 2, moved_from_hole: 1 } : d)) };
    expect(holeCredit(f, "A", 1)).toBe(2);
    expect(holeCredit(f, "A", 2)).toBe(2);
  });

  it("spec: a drink logged after the team taps On the tee for hole 5 lands on hole 5, even if a stale phone stamped 4", () => {
    const f = makeTrip({ teams: [4] });
    f.teeOff("A", 4, 60).score("A", 4, 4);
    f.teeOff("A", 5, 75); // phone A taps On the tee: hole 5
    // Phone B hasn't seen it (dead zone): it stamps hole 4 for drinks at 78 and 79.
    const late = f.drink("A", "A2", 4, "drink", { min: 78 });
    const shot = f.drink("A", "A3", 4, "shot", { min: 79 });
    // A drink logged at 70, while 4 really was open, stays on 4.
    const early = f.drink("A", "A4", 4, "drink", { min: 70 });
    const v = values(f.state);
    expect([v[late].hole, v[shot].hole, v[early].hole]).toEqual([5, 5, 4]);
    expect(holeCredit(f, "A", 4)).toBe(1);
    expect(holeCredit(f, "A", 5)).toBe(2);
    // The stored stamp is untouched (raw rows are the source of truth; the engine derives the hole).
    expect(f.state.drinks.find((d) => d.id === late)!.hole).toBe(4);
  });

  it("a tee.open that syncs after the drink still re-homes it (the hole is derived, not stored)", () => {
    const f = makeTrip({ teams: [4] });
    f.teeOff("A", 1, 0);
    const d = f.drink("A", "A1", 1, "drink", { min: 30 });
    expect(values(f.state)[d].hole).toBe(1);
    f.teeOff("A", 2, 20); // the scorer's offline tee.open (logged at 20) arrives later
    expect(values(f.state)[d].hole).toBe(2);
    // ...and a commissioner move pins it wherever they put it.
    f.state = { ...f.state, drinks: f.state.drinks.map((x) => (x.id === d ? { ...x, hole: 1, moved_from_hole: 1 } : x)) };
    expect(values(f.state)[d].hole).toBe(1);
  });

  it("ignores deleted drinks and drinks of deleted teams", () => {
    const f = makeTrip({ teams: [3, 3] }).teeOff("A", 1).teeOff("B", 1);
    const gone = f.drink("A", "A1", 1);
    f.deleteDrink(gone);
    const bDrink = f.drink("B", "B1", 1);
    f.state = { ...f.state, teams: f.state.teams.map((t) => (t.id === f.team.B ? { ...t, deleted_at: at(50) } : t)) };
    const v = values(f.state);
    expect(v[gone]).toBeUndefined();
    expect(v[bDrink]).toBeUndefined();
    expect(Object.keys(v)).toHaveLength(0);
  });

  it("uses the current team size: a foursome that loses a member becomes a threesome", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    for (let i = 0; i < 3; i++) f.drink("A", "A1", 1);
    expect(sequence(f, "A").map((v) => v.value)).toEqual([1, 1, 1]);
    f.state = { ...f.state, team_members: f.state.team_members.filter((m) => m.player_id !== f.player.A4) };
    expect(sequence(f, "A").map((v) => v.value)).toEqual([1, 1, 2]);
  });

  it("falls back to the base when a team size is missing", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1);
    for (let i = 0; i < 3; i++) f.drink("A", "A1", 1);
    const v = computeDrinkValues(f.state, {});
    expect(Object.values(v).map((x) => x.value)).toEqual([1, 1, 1]);
  });
});

describe("drinks after Round complete (rules review: order-independent)", () => {
  /** Threesome B plays 18 fours and taps Round complete at minute 300. */
  function finished() {
    const f = makeTrip({ teams: [3, 3] });
    for (let h = 1; h <= 18; h++) {
      f.teeOff("B", h, h * 10);
      f.score("B", h, 4);
    }
    f.complete("B", 300);
    return f;
  }

  it("a drink logged more than 2 minutes after the team's completed_at never counts: no credit, no drinking board, no mulligan", () => {
    const f = finished();
    const onTime = f.drink("B", "B1", 18, "drink", { min: 299 });
    const graced = f.drink("B", "B2", 18, "drink", { min: 302 });
    const bar = f.drink("B", "B2", 18, "drink", { min: 310 });
    const barShotgun = f.drink("B", "B3", 18, "shotgun", { min: 312 });
    const v = values(f.state);
    expect(Object.keys(v).sort()).toEqual([onTime, graced].sort());
    expect(v[bar]).toBeUndefined();
    expect(v[barShotgun]).toBeUndefined();
    const d = derive(f.state);
    expect(d.teamHoles[f.team.B][17]).toMatchObject({ drinks: 2, credit: 2, net: 2 });
    expect(d.standings.find((r) => r.team_id === f.team.B)).toMatchObject({ drinks: 2, credit: 2, pending_drinks: 0 });
    expect(d.drinkers.find((r) => r.player_id === f.player.B2)).toMatchObject({ total: 1 });
    expect(d.drinkers.find((r) => r.player_id === f.player.B3)).toMatchObject({ total: 0, shotguns: 0 });
    expect(d.mulligans[f.team.B]).toMatchObject({ earned: 0, available: 0 });
  });

  it("is decided by the times, not by which op synced first: the same drinks before the completion lands count until it does", () => {
    const f = finished();
    // The scorer's Round complete hasn't synced yet: B still shows 18 open.
    const rsBefore = f.state.team_round_state.map((rs) => (rs.team_id === f.team.B ? { ...rs, status: "playing" as const, completed_at: null } : rs));
    const bar = f.drink("B", "B2", 18, "drink", { min: 310 });
    expect(values({ ...f.state, team_round_state: rsBefore })[bar]).toBeDefined();
    // Once it lands, the clubhouse beer drops out.
    expect(values(f.state)[bar]).toBeUndefined();
  });

  it("a commissioner-pinned drink (moved or back-filled) still counts after the round", () => {
    const f = finished();
    const pinned = f.drink("B", "B1", 18, "drink", { min: 400 });
    f.state = { ...f.state, drinks: f.state.drinks.map((x) => (x.id === pinned ? { ...x, moved_from_hole: 18 } : x)) };
    expect(values(f.state)[pinned]).toMatchObject({ hole: 18, value: 1 });
  });
});
