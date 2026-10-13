// Server-render Play pieces against real engine output.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import { HoleHeader } from "@/components/play/HoleHeader";

describe("HoleHeader", () => {
  it("labels the team's net to par 'To par' (not 'Net'), and banked drinks don't move it (finding: two net definitions)", () => {
    const f = makeTrip({ teams: [3, 3] });
    f.teeOff("A", 1).teeOff("B", 1);
    f.score("A", 1, 3, "A1").score("B", 1, 4, "B1");
    f.teeOff("A", 2);
    f.drink("A", "A1", 2); // open hole 2, not scored yet: banked
    const d = derive(f.state);
    const html = renderToStaticMarkup(
      <HoleHeader
        hole={2}
        holeRow={d.holes[1]}
        teeSet={f.state.trip.settings.tee_set}
        team={d.teamById[f.team.A]}
        isMyTeam
        standing={d.standings.find((r) => r.team_id === f.team.A)}
        canSwitch={false}
        onSwitch={() => {}}
      />,
    );
    expect(html).toContain(">To par</dt>");
    expect(html).not.toContain(">Net</dt>");
    // Birdie on hole 1 = -1 to par; the drink on unscored hole 2 is banked, not counted yet.
    expect(html).toMatch(/>To par<\/dt><dd[^>]*>-1<\/dd>/);
    expect(html).toMatch(/>Pos<\/dt><dd[^>]*>1<\/dd>/);
    expect(html).toMatch(/>Thru<\/dt><dd[^>]*>1<\/dd>/);
  });
});
