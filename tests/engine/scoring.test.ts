import { describe, expect, it } from "vitest";
import { computeDrinkValues } from "@/lib/engine/drinks";
import { computeDrinkers, computeStandings, computeTeamHoles } from "@/lib/engine/scoring";
import { computeRoster } from "@/lib/engine";
import type { StandingRow } from "@/lib/engine/types";
import { JACK_FROST_HOLES } from "@/lib/course";
import type { TripState } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "../fixtures";

const DASH = "–";

function compute(state: TripState) {
  const roster = computeRoster(state);
  const drinkValues = computeDrinkValues(state, roster.teamSize);
  const teamHoles = computeTeamHoles(state, drinkValues);
  const standings = computeStandings(state, teamHoles, drinkValues);
  const drinkers = computeDrinkers(state, roster.teamOfPlayer);
  return { roster, drinkValues, teamHoles, standings, drinkers };
}

const row = (f: TripFixture, team: string): StandingRow => compute(f.state).standings.find((r) => r.team_id === f.team[team])!;
const order = (f: TripFixture) => compute(f.state).standings.map((r) => Object.keys(f.team).find((k) => f.team[k] === r.team_id));

/** Score holes 1..strokes.length with the given strokes (teeing off each hole first). */
function play(f: TripFixture, team: string, strokes: number[]) {
  strokes.forEach((s, i) => {
    f.teeOff(team, i + 1);
    f.score(team, i + 1, s);
  });
  return f;
}

const PARS = JACK_FROST_HOLES.map((h) => h.par);

describe("computeTeamHoles", () => {
  it("gives every active team 18 lines with course par and contest, empty until scored", () => {
    const f = makeTrip({ teams: [4, 3] });
    const { teamHoles } = compute(f.state);
    expect(Object.keys(teamHoles).sort()).toEqual([f.team.A, f.team.B].sort());
    const lines = teamHoles[f.team.A];
    expect(lines).toHaveLength(18);
    expect(lines.map((l) => l.hole)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(lines.map((l) => l.par)).toEqual(PARS);
    expect(lines[2].contest).toBe("ctp");
    expect(lines[3].contest).toBe("ld");
    expect(lines[0]).toEqual({
      hole: 1,
      par: 4,
      contest: "none",
      strokes: null,
      tee_shot_player_id: null,
      drinks: 0,
      credit: 0,
      net: null,
      gross_to_par: null,
      net_to_par: null,
      edit_count: 0,
    });
  });

  it("strokes 4 with 5 drink credits gives a hole net of -1", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    for (const p of ["A1", "A2", "A3", "A4", "A1"]) f.drink("A", p, 1);
    f.score("A", 1, 4, "A2");
    const line = compute(f.state).teamHoles[f.team.A][0];
    expect(line).toMatchObject({ strokes: 4, drinks: 5, credit: 5, net: -1, gross_to_par: 0, net_to_par: -5 });
    expect(line.tee_shot_player_id).toBe(f.player.A2);
  });

  it("same for a threesome: 4 drinks are worth 1+1+2+1 = 5", () => {
    const f = makeTrip({ teams: [3] }).teeOff("A", 1);
    for (const p of ["A1", "A2", "A3", "A1"]) f.drink("A", p, 1);
    f.score("A", 1, 4);
    expect(compute(f.state).teamHoles[f.team.A][0]).toMatchObject({ drinks: 4, credit: 5, net: -1 });
  });

  it("keeps drink credit on a hole with no strokes yet, with null nets", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    f.drink("A", "A1", 1);
    expect(compute(f.state).teamHoles[f.team.A][0]).toMatchObject({ strokes: null, drinks: 1, credit: 1, net: null, net_to_par: null });
  });

  it("reports edit_count and par from edited holes", () => {
    const f = makeTrip({ teams: [4] }).teeOff("A", 1);
    f.score("A", 1, 5).score("A", 1, 4);
    f.state = { ...f.state, holes: f.state.holes.map((h) => (h.number === 1 ? { ...h, par: 5, contest: "ld" } : h)) };
    expect(compute(f.state).teamHoles[f.team.A][0]).toMatchObject({ strokes: 4, edit_count: 1, par: 5, contest: "ld", gross_to_par: -1 });
  });

  it("skips deleted teams and ignores scores of unknown teams", () => {
    const f = makeTrip({ teams: [4, 3] }).teeOff("B", 1).score("B", 1, 4);
    f.state = { ...f.state, teams: f.state.teams.map((t) => (t.id === f.team.B ? { ...t, deleted_at: at(5) } : t)) };
    const { teamHoles, standings } = compute(f.state);
    expect(teamHoles[f.team.B]).toBeUndefined();
    expect(standings.map((r) => r.team_id)).toEqual([f.team.A]);
  });
});

describe("computeStandings", () => {
  it("ties share a position (T2); not-started teams come last with dashes", () => {
    const f = makeTrip({ teams: [4, 3, 3, 3] });
    play(f, "A", [3]); // -1
    play(f, "B", [4]); // E
    play(f, "C", [4]); // E
    const s = compute(f.state).standings;
    expect(order(f)).toEqual(["A", "B", "C", "D"]);
    expect(s.map((r) => r.pos)).toEqual([1, 2, 2, 4]);
    expect(s.map((r) => r.pos_label)).toEqual(["1", "T2", "T2", DASH]);
    expect(s.map((r) => r.thru_label)).toEqual(["1", "1", "1", DASH]);
  });

  it("a tie for the lead is T1 and the next team is 3rd", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    play(f, "A", [4, 4]);
    play(f, "B", [5, 3]);
    play(f, "C", [5, 4]);
    const s = compute(f.state).standings;
    expect(s.map((r) => r.pos_label)).toEqual(["T1", "T1", "3"]);
  });

  it("sorts mid-round by net to par, not net, when teams are thru different holes", () => {
    const f = makeTrip({ teams: [4, 4, 4] });
    // A: thru 2, par par -> E, net 8.
    play(f, "A", [4, 4]);
    // B: thru 5 (pars 4,4,3,5,4 = 20), gross 21, 3 drinks -> net 18, net to par -2.
    play(f, "B", [4, 5, 3, 5, 4]);
    for (const p of ["B1", "B2", "B3"]) f.drink("B", p, 5);
    // C: thru 1, bogey -> +1, net 5 (lowest net, but worst to par).
    play(f, "C", [5]);
    const s = compute(f.state).standings;
    expect(order(f)).toEqual(["B", "A", "C"]);
    expect(s.map((r) => r.net_to_par)).toEqual([-2, 0, 1]);
    expect(s.map((r) => r.net)).toEqual([18, 8, 5]);
    expect(s.map((r) => r.thru)).toEqual([5, 2, 1]);
    expect(s[0]).toMatchObject({ gross: 21, drinks: 3, credit: 3, par_played: 20, gross_to_par: 1, pos: 1, pos_label: "1" });
  });

  it("on equal net to par, lists lower net first but keeps the shared position", () => {
    const f = makeTrip({ teams: [4, 4] });
    play(f, "A", [4, 4, 3]); // thru 3, E, net 11
    play(f, "B", [4]); // thru 1, E, net 4
    const s = compute(f.state).standings;
    expect(order(f)).toEqual(["B", "A"]);
    expect(s.map((r) => r.pos_label)).toEqual(["T1", "T1"]);
  });

  it("falls back to team order when net to par and net are equal", () => {
    const f = makeTrip({ teams: [4, 4, 4] });
    play(f, "C", [4]);
    play(f, "B", [4]);
    play(f, "A", [4]);
    expect(order(f)).toEqual(["A", "B", "C"]);
  });

  it("banks drink credit on the open, unscored hole (pending) until that hole is scored", () => {
    const f = makeTrip({ teams: [4] });
    play(f, "A", [4]);
    f.teeOff("A", 2);
    f.drink("A", "A1", 2);
    f.drink("A", "A2", 2);
    // Spec: round net = sum of hole nets, so only scored holes count; hole 2's credit is banked.
    expect(row(f, "A")).toMatchObject({
      thru: 1, gross: 4, drinks: 0, credit: 0, net: 4, pending_drinks: 2, pending_credit: 2, par_played: 4, net_to_par: 0, gross_to_par: 0,
    });
    f.score("A", 2, 5);
    expect(row(f, "A")).toMatchObject({
      thru: 2, gross: 9, drinks: 2, credit: 2, net: 7, pending_drinks: 0, pending_credit: 0, par_played: 8, net_to_par: -1,
    });
  });

  it("net = gross - credit = sum of scored hole nets; every line keeps its own credit", () => {
    const f = makeTrip({ teams: [3] });
    f.teeOff("A", 1);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1);
    f.score("A", 1, 4);
    f.teeOff("A", 2);
    f.drink("A", "A3", 2); // ghost beer (worth 2) on the open hole 2
    const { standings, teamHoles } = compute(f.state);
    const lines = teamHoles[f.team.A];
    expect(lines.map((l) => l.credit).slice(0, 3)).toEqual([2, 2, 0]);
    const r = standings[0];
    const scored = lines.filter((l) => l.strokes !== null);
    expect(r.net).toBe(scored.reduce((s, l) => s + l.net!, 0));
    expect(r.net).toBe(r.gross - r.credit);
    expect(r).toMatchObject({ net: 2, credit: 2, drinks: 2, pending_drinks: 1, pending_credit: 2, ghost_beers: 1 });
  });

  it("a team that has drunk but not scored is still not started", () => {
    const f = makeTrip({ teams: [4, 3] });
    play(f, "A", [6]);
    f.teeOff("B", 1);
    for (const p of ["B1", "B2", "B3"]) f.drink("B", p, 1);
    const s = compute(f.state).standings;
    expect(order(f)).toEqual(["A", "B"]);
    expect(s[1]).toMatchObject({
      pos: 2, pos_label: DASH, thru: 0, thru_label: DASH, credit: 0, pending_credit: 4, pending_drinks: 3, ghost_beers: 1, net: 0, status: "playing", open_hole: 1,
    });
  });

  it("everyone not started: all share pos 1 with dashes, in team order", () => {
    const f = makeTrip({ teams: [3, 4] });
    const s = compute(f.state).standings;
    expect(s.map((r) => [r.pos, r.pos_label, r.thru_label, r.status])).toEqual([
      [1, DASH, DASH, "not_started"],
      [1, DASH, DASH, "not_started"],
    ]);
    expect(order(f)).toEqual(["A", "B"]);
  });

  it("shows F only when complete with all 18 scored", () => {
    const f = makeTrip({ teams: [4, 4, 4] });
    play(f, "A", PARS); // 18, complete
    f.complete("A");
    play(f, "B", PARS); // 18, still playing (no "Round complete" yet)
    play(f, "C", PARS.slice(0, 17)); // complete with a missing hole
    f.complete("C");
    const thru = (t: string) => row(f, t).thru_label;
    expect(thru("A")).toBe("F");
    expect(thru("B")).toBe("18");
    expect(thru("C")).toBe("17");
    expect(row(f, "A")).toMatchObject({ status: "complete", open_hole: 18, net_to_par: 0, gross: 72, par_played: 72 });
  });

  it("net to par equals net minus 72 once everyone is thru 18", () => {
    const f = makeTrip({ teams: [4, 3] });
    play(f, "A", PARS.map((p) => p + 1)); // +18 gross
    for (let i = 0; i < 20; i++) f.drink("A", "A1", 18);
    play(f, "B", PARS); // E gross
    for (let i = 0; i < 6; i++) f.drink("B", "B1", 18); // 8 credit
    const s = compute(f.state).standings;
    expect(s.map((r) => [r.net, r.net_to_par])).toEqual([
      [72 - 8, 72 - 8 - 72],
      [90 - 20, 90 - 20 - 72],
    ]);
    expect(order(f)).toEqual(["B", "A"]);
    expect(s[0].ghost_beers).toBe(2);
    expect(s[1].ghost_beers).toBe(0);
  });
});

describe("computeDrinkers", () => {
  it("lists every active player on a team, broken out by type, sorted by total then name", () => {
    const f = makeTrip({ teams: [3, 2] }).teeOff("A", 1).teeOff("B", 1);
    f.drink("A", "A2", 1);
    f.drink("A", "A2", 1, "shotgun", { photo: "trips/x/drinks/1.jpg" });
    f.drink("A", "A2", 1, "shot");
    f.drink("B", "B1", 1, "shot");
    f.drink("B", "B2", 1, "drink", { photo: "trips/x/drinks/2.jpg" });
    const gone = f.drink("A", "A3", 1);
    f.deleteDrink(gone);
    const { drinkers } = compute(f.state);
    const label = (pid: string) => Object.keys(f.player).find((k) => f.player[k] === pid);
    expect(drinkers.map((d) => label(d.player_id))).toEqual(["A2", "B1", "B2", "A1", "A3"]);
    expect(drinkers[0]).toEqual({ player_id: f.player.A2, team_id: f.team.A, drinks: 1, shotguns: 1, shots: 1, total: 3, photos: 1 });
    expect(drinkers[1]).toMatchObject({ team_id: f.team.B, drinks: 0, shots: 1, total: 1, photos: 0 });
    expect(drinkers[2]).toMatchObject({ drinks: 1, total: 1, photos: 1 });
    expect(drinkers[4]).toMatchObject({ total: 0 });
  });

  it("leaves out deleted players and players not on a team", () => {
    const f = makeTrip({ teams: [3, 2] });
    f.state = {
      ...f.state,
      players: f.state.players.map((p) => (p.id === f.player.A1 ? { ...p, deleted_at: at(1) } : p)),
      team_members: f.state.team_members.filter((m) => m.player_id !== f.player.B2),
    };
    const ids = compute(f.state).drinkers.map((d) => d.player_id);
    expect(ids).not.toContain(f.player.A1);
    expect(ids).not.toContain(f.player.B2);
    expect(ids).toHaveLength(3);
  });
});
