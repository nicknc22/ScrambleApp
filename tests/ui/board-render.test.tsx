// Server-render the leaderboard pieces against real engine output.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import { StandingsTable } from "@/components/leaderboard/StandingsTable";
import { DrinkersBoard } from "@/components/leaderboard/DrinkersBoard";
import { ContestsBoard } from "@/components/leaderboard/ContestsBoard";
import { DrivesBoard } from "@/components/leaderboard/DrivesBoard";

function played() {
  const f = makeTrip({ teams: [4, 3, 3] });
  f.teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
  f.score("A", 1, 3, "A1");
  f.score("B", 1, 4, "B1");
  f.score("C", 1, 4, "C2");
  f.drink("B", "B2", 1, "shotgun");
  return f;
}

describe("StandingsTable", () => {
  it("renders every column per row, tie labels, leader and my team", () => {
    const f = played();
    const d = derive(f.state);
    const html = renderToStaticMarkup(<StandingsTable standings={d.standings} teamById={d.teamById} myTeamId={f.team.C} onOpenTeam={() => {}} />);
    for (const h of ["Pos", "Team", "Thru", "Grs", "Drk", "Cred", "Net"]) expect(html).toContain(`>${h}<`);
    expect(html.match(/data-testid="standings-row"/g)).toHaveLength(3);
    // A birdies (-1); B pars but its shotgun is worth 1 (threesome) -> also -1: tied for 1st.
    expect(html).toContain(`data-team-id="${f.team.A}" data-pos="T1" data-leader="true"`);
    expect(html).toContain(`data-team-id="${f.team.B}" data-pos="T1" data-leader="true"`);
    expect(html).toContain(`data-team-id="${f.team.C}" data-pos="3" data-mine="true"`);
    expect(html).toContain("Team B, position T1, thru 1, gross 4, 1 drinks, credit -1, net 3, net to par -1");
    expect(html).toContain("Team C (your team)");
    expect(html).not.toContain('data-testid="standings-banked"');
  });

  it("drinks on a hole without a score show as a small banked marker, not in the net", () => {
    const f = played();
    f.teeOff("C", 2);
    f.drink("C", "C1", 2);
    const d = derive(f.state);
    const html = renderToStaticMarkup(<StandingsTable standings={d.standings} teamById={d.teamById} myTeamId={null} onOpenTeam={() => {}} />);
    expect(html.match(/data-testid="standings-banked"/g)).toHaveLength(1);
    expect(html).toContain("+1 🍺 banked");
    expect(html).toContain("Team C, position 3, thru 1, gross 4, 0 drinks, credit 0, net 4, net to par E, plus 1 banked drink (-1) on an unscored hole");
  });
});

describe("other boards", () => {
  it("DrinkersBoard ranks and marks the viewer", () => {
    const f = played();
    const html = renderToStaticMarkup(<DrinkersBoard derived={derive(f.state)} meId={f.player.B2} />);
    expect(html.match(/data-testid="drinker-row"/g)).toHaveLength(10);
    expect(html).toContain(`data-player-id="${f.player.B2}"`);
    expect(html).toContain(">YOU<");
    expect(html).toContain("most drinks");
  });

  it("ContestsBoard shows the leader, distance and empty holes", () => {
    const f = played();
    f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 4.5, ai_suspicious: true });
    const html = renderToStaticMarkup(<ContestsBoard derived={derive(f.state)} meId={null} />);
    expect(html).toContain("Player A2");
    expect(html).toContain(`4&#x27; 6&quot;`);
    expect(html).toContain("🤖 Sus");
    expect(html).toContain("No entries yet");
  });

  it("DrivesBoard renders a card per team with per-nine counts", () => {
    const f = played();
    const html = renderToStaticMarkup(<DrivesBoard derived={derive(f.state)} meId={f.player.A1} />);
    expect(html.match(/data-testid="drive-team"/g)).toHaveLength(3);
    expect(html).toContain(`data-player-id="${f.player.A1}" data-front="ok"`);
    expect(html).toContain(`data-player-id="${f.player.A2}" data-front="needs"`);
  });
});
