// Server-render Play pieces against real engine output.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import { HoleHeader } from "@/components/play/HoleHeader";
import { RoundSummaryCard } from "@/components/play/RoundSummaryCard";
import { ScorecardStrip } from "@/components/play/ScorecardStrip";
import { canEditPlay, roundSummary } from "@/components/play/model";

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

describe("RoundSummaryCard", () => {
  it("after finalize a player is told to ask the commissioner, not to tap the scorecard (finding: final summary says tap to fix)", () => {
    const f = makeTrip({ teams: [3, 3] });
    f.teeOff("A", 1);
    for (let h = 1; h <= 18; h++) if (h !== 13) f.score("A", h, 4);
    f.complete("A");
    const d = derive(f.state);
    const lines = d.teamHoles[f.team.A];
    const summary = roundSummary(d.standings.find((r) => r.team_id === f.team.A), lines);
    const player = renderToStaticMarkup(<RoundSummaryCard summary={summary} final teamName="A" canEdit={canEditPlay("final", false)} />);
    expect(player).toContain("No score on hole 13. Ask the commissioner to fix it.");
    expect(player).not.toContain("Tap it on the scorecard");
    const strip = renderToStaticMarkup(<ScorecardStrip lines={lines} currentHole={-1} viewing={null} unsavedHoles={[]} onSelect={() => {}} canEdit={false} />);
    expect(strip).toContain("Tap a hole to see it");
    // The commissioner (and anyone while the trip is live) can still fix it.
    const commish = renderToStaticMarkup(<RoundSummaryCard summary={summary} final teamName="A" canEdit={canEditPlay("final", true)} />);
    expect(commish).toContain("No score on hole 13. Tap it on the scorecard to fix.");
  });
});
