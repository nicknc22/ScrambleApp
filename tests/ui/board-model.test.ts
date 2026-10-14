// Leaderboard view-model helpers against real engine output (fixtures + derive).
import { describe, expect, it } from "vitest";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import {
  DASH,
  contestViews,
  drinkerRanks,
  driveViews,
  formatContestDistance,
  leaderBannerLine,
  leaderHeadline,
  myChaseLine,
  positionDeltas,
  scoreShape,
  scorecardSections,
  standingsView,
  toParTone,
  toParWords,
} from "@/components/leaderboard/model";
import type { DrinkerRow } from "@/lib/engine/types";

describe("standingsView", () => {
  it("formats every column, shares tied positions and marks leader / my team", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
    f.score("A", 1, 3, "A1"); // birdie on a par 4
    f.score("B", 1, 4, "B1");
    f.score("C", 1, 5, "C1");
    f.drink("C", "C1", 1); // threesome: worth 1
    const d = derive(f.state);
    const rows = standingsView(d.standings, f.team.B);
    expect(rows.map((r) => r.team_id)).toEqual([f.team.A, f.team.B, f.team.C]);
    expect(rows.map((r) => r.pos_label)).toEqual(["1", "T2", "T2"]);
    expect(rows[0]).toMatchObject({ leader: true, mine: false, gross: "3", drinks: "0", credit: "0", net: "3", to_par: "-1", thru_label: "1" });
    expect(rows[1]).toMatchObject({ leader: false, mine: true, to_par: "E", to_par_value: 0 });
    expect(rows[2]).toMatchObject({ gross: "5", drinks: "1", credit: "-1", net: "4", to_par: "E" });
  });

  it("shows dashes for teams that haven't scored (and no leader before anyone scores)", () => {
    const f = makeTrip({ teams: [2, 2] });
    f.teeOff("A", 1);
    f.drink("A", "A1", 1); // twosome: worth 2, no strokes yet
    const d = derive(f.state);
    const rows = standingsView(d.standings, null);
    expect(rows.every((r) => !r.leader && !r.started)).toBe(true);
    const a = rows.find((r) => r.team_id === f.team.A)!;
    // Round net = sum of hole nets over SCORED holes: the drink is banked until hole 1 has a score.
    expect(a).toMatchObject({ pos_label: DASH, thru_label: DASH, gross: DASH, net: DASH, to_par: DASH, credit: "0", drinks: "0" });
    expect(a).toMatchObject({ banked: "+1 🍺 banked", banked_drinks: 1, banked_credit: 2 });
    expect(rows.find((r) => r.team_id === f.team.B)!).toMatchObject({ banked: null, banked_drinks: 0, banked_credit: 0 });
    expect(leaderHeadline(d).kind).toBe("none");
  });

  it("drinks on the open, unscored hole are banked, not in Drk / Cred / Net, until the hole is scored (finding: two net definitions)", () => {
    const f = makeTrip({ teams: [3, 3] });
    f.teeOff("A", 1).teeOff("B", 1);
    f.score("A", 1, 4, "A1").score("B", 1, 4, "B1");
    f.teeOff("A", 2);
    f.drink("A", "A1", 2);
    f.drink("A", "A2", 2); // threesome: 1 + 1 on hole 2, not scored yet
    let a = standingsView(derive(f.state).standings, null).find((r) => r.team_id === f.team.A)!;
    expect(a).toMatchObject({ gross: "4", drinks: "0", credit: "0", net: "4", to_par: "E", banked: "+2 🍺 banked", banked_credit: 2 });
    // Scoring hole 2 moves the banked drinks into the net.
    f.score("A", 2, 5, "A2");
    a = standingsView(derive(f.state).standings, null).find((r) => r.team_id === f.team.A)!;
    expect(a).toMatchObject({ gross: "9", drinks: "2", credit: "-2", net: "7", to_par: "-1", banked: null, banked_drinks: 0 });
  });

  it("leaderHeadline handles a solo leader and a tie", () => {
    const f = makeTrip({ teams: [4, 4, 4] });
    f.teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
    f.score("A", 1, 3).score("B", 1, 3).score("C", 1, 6);
    let h = leaderHeadline(derive(f.state));
    expect(h).toMatchObject({ kind: "tie", names: ["Team A", "Team B"], to_par: "-1", thru: "1" });
    f.score("B", 1, 4);
    h = leaderHeadline(derive(f.state));
    expect(h).toMatchObject({ kind: "solo", names: ["Team A"], to_par_value: -1 });
    expect(leaderBannerLine(h)).toBe("1 under · thru 1");
  });

  it("toParWords says it in words: under / Even / over", () => {
    expect(toParWords(-16)).toBe("16 under");
    expect(toParWords(-1)).toBe("1 under");
    expect(toParWords(0)).toBe("Even");
    expect(toParWords(3)).toBe("3 over");
    expect(toParWords(Number.NaN)).toBe("Even");
  });

  it("the banner line: no ' net' after the number, 'finished' once thru 18", () => {
    expect(leaderBannerLine({ to_par_value: -16, thru: "14" })).toBe("16 under · thru 14");
    expect(leaderBannerLine({ to_par_value: 0, thru: "3" })).toBe("Even · thru 3");
    expect(leaderBannerLine({ to_par_value: -39, thru: "F" })).toBe("39 under · finished");
    expect(leaderBannerLine({ to_par_value: -16, thru: "14" })).not.toMatch(/ net/);
  });

  it("the viewer's chase line: position and strokes back, only when started and not leading", () => {
    const f = makeTrip({ teams: [4, 4, 4] });
    f.teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
    f.score("A", 1, 2).score("B", 1, 5).score("C", 1, 5); // A -2, B and C +1 (tied 2nd)
    const d = derive(f.state);
    expect(myChaseLine(d.standings, f.team.B)).toBe("You: T2, 3 back");
    // A lone place is an ordinal ("3rd"), never a bare "3" that reads like a score.
    const solo = makeTrip({ teams: [4, 4, 4] });
    solo.teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
    solo.score("A", 1, 2).score("B", 1, 4).score("C", 1, 5); // A -2, B E, C +1
    const ds = derive(solo.state);
    expect(myChaseLine(ds.standings, solo.team.C)).toBe("You: 3rd, 3 back");
    expect(myChaseLine(ds.standings, solo.team.B)).toBe("You: 2nd, 2 back");
    expect(myChaseLine(d.standings, f.team.A)).toBeNull(); // leading
    expect(myChaseLine(d.standings, null)).toBeNull(); // no team
    // Not started yet: nothing to chase.
    const g = makeTrip({ teams: [4, 4] });
    g.teeOff("A", 1).teeOff("B", 1);
    g.score("A", 1, 4);
    expect(myChaseLine(derive(g.state).standings, g.team.B)).toBeNull();
    // Co-leaders get no chase line.
    g.score("B", 1, 4);
    expect(myChaseLine(derive(g.state).standings, g.team.B)).toBeNull();
  });

  it("toParTone", () => {
    expect(toParTone(-2)).toBe("under");
    expect(toParTone(0)).toBe("even");
    expect(toParTone(3)).toBe("over");
    expect(toParTone(null)).toBe("none");
  });
});

describe("positionDeltas", () => {
  it("reports places gained (+) and lost (-), skipping new and unmoved teams", () => {
    expect(positionDeltas(["a", "b", "c"], ["c", "a", "b"])).toEqual({ c: 2, a: -1, b: -1 });
    expect(positionDeltas(["a", "b"], ["a", "b"])).toEqual({});
    expect(positionDeltas(["a"], ["b", "a"])).toEqual({ a: -1 });
  });
});

describe("scorecard", () => {
  it("OUT / IN / TOT add up and match the leaderboard row (credit on an unscored hole is banked)", () => {
    const f = makeTrip({ teams: [3, 3] });
    f.teeOff("A", 1);
    f.score("A", 1, 5, "A1");
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1);
    f.drink("A", "A3", 1); // ghost: 1, 1, 2
    for (let h = 2; h <= 10; h++) {
      f.teeOff("A", h);
      f.score("A", h, 4, "A2");
    }
    f.teeOff("A", 11);
    f.drink("A", "A1", 11); // open hole, not scored yet
    const d = derive(f.state);
    const { front, back, total } = scorecardSections(d.teamHoles[f.team.A]);
    expect(front.lines.map((l) => l.hole)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(back.lines).toHaveLength(9);
    expect(front.sum).toMatchObject({ label: "OUT", strokes: 37, drinks: 3, credit: 4, net: 33, played: 9, banked_drinks: 0 });
    expect(back.sum).toMatchObject({ label: "IN", strokes: 4, drinks: 0, credit: 0, net: 4, played: 1, banked_drinks: 1, banked_credit: 1 });
    expect(total).toMatchObject({ label: "TOT", strokes: 41, drinks: 3, credit: 4, net: 37, played: 10, banked_drinks: 1, banked_credit: 1 });
    // The hole row itself still shows the open hole's drink (its net is "–" until it's scored).
    expect(back.lines[1]).toMatchObject({ hole: 11, strokes: null, drinks: 1, credit: 1, net: null });
    const row = d.standings.find((r) => r.team_id === f.team.A)!;
    expect(total.net).toBe(row.net);
    expect(total.drinks).toBe(row.drinks);
    expect(total.credit).toBe(row.credit);
    expect([total.banked_drinks, total.banked_credit]).toEqual([row.pending_drinks, row.pending_credit]);
    expect(total.par).toBe(d.holes.reduce((s, h) => s + h.par, 0));
  });

  it("empty card has null strokes and net (even with a banked drink)", () => {
    const f = makeTrip({ teams: [2, 2] });
    let { total } = scorecardSections(derive(f.state).teamHoles[f.team.A]);
    expect(total.strokes).toBeNull();
    expect(total.net).toBeNull();
    f.teeOff("A", 1).drink("A", "A1", 1);
    ({ total } = scorecardSections(derive(f.state).teamHoles[f.team.A]));
    expect(total).toMatchObject({ strokes: null, net: null, drinks: 0, credit: 0, banked_drinks: 1, banked_credit: 2 });
  });

  it("scoreShape", () => {
    expect(scoreShape(null, 4)).toBe("none");
    expect(scoreShape(1, 4)).toBe("albatross");
    expect(scoreShape(2, 4)).toBe("eagle");
    expect(scoreShape(3, 4)).toBe("birdie");
    expect(scoreShape(4, 4)).toBe("par");
    expect(scoreShape(5, 4)).toBe("bogey");
    expect(scoreShape(9, 4)).toBe("double");
  });
});

describe("drinkerRanks", () => {
  const row = (player_id: string, total: number): DrinkerRow => ({ player_id, team_id: "t", drinks: total, shotguns: 0, shots: 0, total, photos: 0 });
  it("competition ranking with ties; zero shows a dash", () => {
    const out = drinkerRanks([row("a", 3), row("b", 5), row("c", 3), row("d", 0)]);
    expect(out.map((r) => [r.player_id, r.rank_label])).toEqual([
      ["b", "1"],
      ["a", "T2"],
      ["c", "T2"],
      ["d", DASH],
    ]);
  });

  it("works on derived drinkers", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 1);
    f.drink("A", "A1", 1, "shotgun");
    f.drink("A", "A1", 1, "drink");
    f.drink("A", "A2", 1, "shot");
    const out = drinkerRanks(derive(f.state).drinkers);
    expect(out[0]).toMatchObject({ player_id: f.player.A1, total: 2, shotguns: 1, drinks: 1, rank_label: "1" });
    expect(out[1]).toMatchObject({ player_id: f.player.A2, total: 1, shots: 1, rank_label: "2" });
    expect(out).toHaveLength(10);
  });
});

describe("contestViews", () => {
  it("leader, distance formatting, suspicious flag, no entries", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.teeOff("A", 1);
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 12.5, ai_suspicious: true });
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 20 });
    f.entry({ hole: 4, player_id: f.player.C1, type: "ld", distance_value: 287, status: "flagged", flag_reason: "GPS was weak" });
    const views = contestViews(derive(f.state).contests);
    expect(views.map((v) => v.hole)).toEqual([3, 4, 8, 9, 11, 12, 16, 18]);
    const h3 = views[0];
    expect(h3).toMatchObject({ state: "leader", leader_ids: [f.player.A1], distance: `12' 6"`, entries: 2, label: "Closest to pin" });
    expect(h3.suspicious).toBe(true);
    const h4 = views[1];
    expect(h4).toMatchObject({ state: "no_valid", leader_ids: [], distance: DASH, pending_review: 1, label: "Long drive" });
    expect(views[2]).toMatchObject({ state: "no_entries", entries: 0, distance: DASH });
  });

  it("formatContestDistance", () => {
    expect(formatContestDistance(287.4, "yd")).toBe("287 yd");
    expect(formatContestDistance(0.75, "ft")).toBe(`9"`);
    expect(formatContestDistance(null, "ft")).toBe(DASH);
  });
});

describe("driveViews", () => {
  it("highlights who needs a drive on the current nine, escalating to hard", () => {
    const f = makeTrip({ teams: [3, 3] });
    // Team A: A1 drives holes 1-6; A2 and A3 still need one with 3 holes left (7, 8, 9).
    for (let h = 1; h <= 6; h++) {
      f.teeOff("A", h);
      f.score("A", h, 4, "A1");
    }
    f.teeOff("A", 7);
    const d = derive(f.state);
    const a = driveViews(d).find((t) => t.team_id === f.team.A)!;
    expect(a.current_nine).toBe(1);
    expect(a.level).toBe("soft");
    const byId = Object.fromEntries(a.players.map((p) => [p.player_id, p]));
    expect(byId[f.player.A1]).toMatchObject({ front: 6, front_state: "ok", back_state: "idle" });
    expect(byId[f.player.A2]).toMatchObject({ front: 0, front_state: "needs_soft" });

    f.score("A", 7, 4, "A1"); // 2 holes left, 2 needing -> hard
    f.teeOff("A", 8);
    const a2 = driveViews(derive(f.state)).find((t) => t.team_id === f.team.A)!;
    expect(a2.level).toBe("hard");
    expect(a2.players.find((p) => p.player_id === f.player.A3)!.front_state).toBe("needs_hard");
  });

  it("marks misses once the nine closes", () => {
    const f = makeTrip({ teams: [2, 2] });
    for (let h = 1; h <= 9; h++) {
      f.teeOff("A", h);
      f.score("A", h, 4, "A1");
    }
    f.teeOff("A", 10);
    const a = driveViews(derive(f.state)).find((t) => t.team_id === f.team.A)!;
    expect(a.current_nine).toBe(2);
    expect(a.missed_any).toBe(true);
    expect(a.players.find((p) => p.player_id === f.player.A2)!.front_state).toBe("missed");
    expect(a.players.find((p) => p.player_id === f.player.A1)!.front_state).toBe("ok");
    expect(a.players.find((p) => p.player_id === f.player.A2)!.back_state).toBe("needs");
  });
});
