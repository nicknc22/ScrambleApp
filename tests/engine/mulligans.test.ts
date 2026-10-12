import { describe, expect, it } from "vitest";
import { computeDrinkValues } from "@/lib/engine/drinks";
import { computeMulliganBanks } from "@/lib/engine/mulligans";
import { computeStandings, computeTeamHoles } from "@/lib/engine/scoring";
import { computeRoster } from "@/lib/engine";
import type { TripState } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "../fixtures";

function compute(state: TripState) {
  const roster = computeRoster(state);
  const drinkValues = computeDrinkValues(state, roster.teamSize);
  const teamHoles = computeTeamHoles(state, drinkValues);
  return {
    drinkValues,
    teamHoles,
    standings: computeStandings(state, teamHoles, drinkValues),
    banks: computeMulliganBanks(state, roster.teamOfPlayer, roster.groomId),
  };
}

const bank = (f: TripFixture, team: string) => compute(f.state).banks[f.team[team]];

describe("computeMulliganBanks", () => {
  it("shotgun and shot each give -1 like any drink and add one mulligan; using one never changes net", () => {
    const f = makeTrip({ teams: [4, 3] }).teeOff("A", 1);
    const shotgun = f.drink("A", "A2", 1, "shotgun");
    const shot = f.drink("A", "A3", 1, "shot");
    f.score("A", 1, 5);
    const before = compute(f.state);
    expect(before.drinkValues[shotgun].value).toBe(1);
    expect(before.drinkValues[shot].value).toBe(1);
    expect(before.teamHoles[f.team.A][0]).toMatchObject({ drinks: 2, credit: 2, net: 3 });
    expect(before.banks[f.team.A]).toMatchObject({ earned: 2, used_earned: 0, available: 2, used_total: 0 });

    f.mulligan("A", 1, "earned");
    f.mulligan("A", 1, "groom"); // A1 is the groom
    const after = compute(f.state);
    expect(after.banks[f.team.A]).toMatchObject({
      earned: 2,
      used_earned: 1,
      available: 1,
      used_total: 2,
      groom_on_team: true,
      groom_used: true,
      groom_available: false,
    });
    // Score math is untouched by mulligans.
    expect(after.teamHoles).toEqual(before.teamHoles);
    expect(after.standings).toEqual(before.standings);
    expect(after.drinkValues).toEqual(before.drinkValues);
  });

  it("a threesome's ghost-beer shotgun is worth 2 and still earns exactly one mulligan", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1);
    const shotgun = f.drink("A", "A3", 1, "shotgun");
    const c = compute(f.state);
    expect(c.drinkValues[shotgun]).toMatchObject({ value: 2, ghost: true });
    expect(c.banks[f.team.A]).toMatchObject({ earned: 1, available: 1 });
  });

  it("plain drinks earn nothing", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1);
    expect(bank(f, "A")).toMatchObject({ earned: 0, available: 0 });
  });

  it("deleting the shotgun voids its mulligan; available never goes negative", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    const shotgun = f.drink("A", "A1", 1, "shotgun");
    f.mulligan("A", 1, "earned");
    expect(bank(f, "A")).toMatchObject({ earned: 1, used_earned: 1, available: 0 });
    f.deleteDrink(shotgun);
    expect(bank(f, "A")).toMatchObject({ earned: 0, used_earned: 1, available: 0, used_total: 1 });
  });

  it("an undone (deleted) mulligan use is returned to the bank", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    f.drink("A", "A1", 1, "shot");
    const use = f.mulligan("A", 1, "earned");
    f.state = { ...f.state, mulligans: f.state.mulligans.map((m) => (m.id === use ? { ...m, deleted_at: at(30) } : m)) };
    expect(bank(f, "A")).toMatchObject({ earned: 1, used_earned: 0, available: 1, used_total: 0 });
  });

  it("the Groom's Mulligan belongs to the groom's team and is spent trip-wide", () => {
    const f = makeTrip({ teams: [4, 3], groom: "B2" }).teeOff("B", 1);
    expect(bank(f, "A")).toMatchObject({ groom_on_team: false, groom_used: false, groom_available: false });
    expect(bank(f, "B")).toMatchObject({ groom_on_team: true, groom_used: false, groom_available: true });
    const use = f.mulligan("B", 1, "groom");
    expect(bank(f, "A")).toMatchObject({ groom_on_team: false, groom_used: true, groom_available: false });
    expect(bank(f, "B")).toMatchObject({ groom_on_team: true, groom_used: true, groom_available: false, used_total: 1, used_earned: 0 });
    // Undo gives it back.
    f.state = { ...f.state, mulligans: f.state.mulligans.map((m) => (m.id === use ? { ...m, deleted_at: at(30) } : m)) };
    expect(bank(f, "B")).toMatchObject({ groom_used: false, groom_available: true, used_total: 0 });
  });

  it("no groom on any team when the groom is deleted or unassigned", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.state = { ...f.state, team_members: f.state.team_members.filter((m) => m.player_id !== f.player.A1) };
    expect(bank(f, "A")).toMatchObject({ groom_on_team: false, groom_available: false });
    const g = makeTrip({ teams: [4, 3] });
    g.state = { ...g.state, players: g.state.players.map((p) => (p.id === g.player.A1 ? { ...p, deleted_at: at(1) } : p)) };
    expect(bank(g, "A")).toMatchObject({ groom_on_team: false, groom_available: false });
  });

  it("each team's bank only sees its own drinks; deleted teams get no bank", () => {
    const f = makeTrip({ teams: [4, 3, 3] }).teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
    f.drink("A", "A1", 1, "shotgun");
    f.drink("B", "B1", 1, "shot");
    f.drink("B", "B2", 1, "shotgun");
    f.drink("C", "C1", 1, "shot");
    f.mulligan("B", 1, "earned");
    f.state = { ...f.state, teams: f.state.teams.map((t) => (t.id === f.team.C ? { ...t, deleted_at: at(40) } : t)) };
    const { banks } = compute(f.state);
    expect(Object.keys(banks).sort()).toEqual([f.team.A, f.team.B].sort());
    expect(banks[f.team.A]).toMatchObject({ team_id: f.team.A, earned: 1, available: 1 });
    expect(banks[f.team.B]).toMatchObject({ team_id: f.team.B, earned: 2, used_earned: 1, available: 1 });
  });
});
