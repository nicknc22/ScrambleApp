// Server-render the green plot and a contest card against real engine output.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import { GreenPlot } from "@/components/contests/GreenPlot";
import { ContestCard } from "@/components/contests/ContestCard";
import { entryOf, plotEntries } from "@/components/contests/model";

function scene() {
  const f = makeTrip({ teams: [4, 3, 3], settings: { contest_ante_cents: 500 } });
  f.teeOff("A", 3).teeOff("B", 3);
  f.entry({ hole: 3, player_id: f.player.B2, type: "ctp", distance_value: 4.5, angle_deg: 30, ai_estimate_ft: 12, ai_confidence: "high", ai_suspicious: true, ai_roast: "Four feet? In dog years." });
  f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 2.25, angle_deg: 200, photo_path: "trips/t/ctp/a.jpg" });
  f.entry({ hole: 3, player_id: f.player.C1, type: "ctp", distance_value: 41, angle_deg: 90 });
  f.entry({ hole: 4, player_id: f.player.C2, type: "ld", distance_value: 50, low_accuracy: true, status: "flagged", flag_reason: "GPS was weak" });
  return { f, d: derive(f.state) };
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("GreenPlot", () => {
  it("draws the rings, every entry, the leader ring and the AI red flag", () => {
    const { f, d } = scene();
    const ctp = d.contests.find((c) => c.hole === 3)!;
    const html = renderToStaticMarkup(<GreenPlot hole={3} entries={plotEntries(ctp, d, { meId: f.player.A1 })} />);
    for (const ft of ["5", "10", "20", "30"]) expect(html).toContain(`>${ft}&#x27;</text>`);
    expect(count(html, 'data-testid="plot-entry"')).toBe(3);
    expect(count(html, 'data-leader="true"')).toBe(1);
    expect(count(html, 'data-testid="plot-sus"')).toBe(1);
    // The leader is Player A1 (2' 3"); the 41 ft entry clamps to the edge and shows its distance.
    expect(html).toContain("Player A1");
    expect(html).toContain(`Player C1 41&#x27; 0&quot;`);
    expect(html).toContain('role="img"');
    expect(html).toContain("Green for hole 3: Player A1 2&#x27; 3&quot; (leader)");
    expect(html).not.toContain('role="slider"');
  });

  it("renders the draggable marker as a slider", () => {
    const html = renderToStaticMarkup(<GreenPlot entries={[]} marker={{ feet: 6.5, angle: 135, label: "Dave", onAngleChange: () => {} }} />);
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="135"');
    expect(html).toContain('aria-valuetext="Short right of the pin"');
    expect(html).toContain('data-testid="plot-marker"');
    expect(html).toContain(">Dave</text>");
    expect(html).toContain("no balls on it yet");
  });
});

describe("ContestCard", () => {
  it("shows pot, leader, ranked entries, photo, statuses and the AI roast", () => {
    const { f, d } = scene();
    const ctp = d.contests.find((c) => c.hole === 3)!;
    const html = renderToStaticMarkup(
      <ContestCard
        summary={ctp}
        derived={d}
        pots={d.money.pots}
        meId={f.player.A1}
        access={{ can: true, reason: null }}
        myEntry={entryOf(ctp, f.player.A1)}
        photoUrl={(p) => (p ? `/api/photos/${p}` : null)}
        onEnter={() => {}}
        onOpenPhoto={() => {}}
        current={false}
      />,
    );
    expect(html).toContain('data-hole="3"');
    expect(html).toContain("$50");
    expect(html).toContain(`Player A1 at 2&#x27; 3&quot;`);
    expect(count(html, 'data-testid="contest-entry"')).toBe(3);
    expect(html).toContain('data-rank="1"');
    expect(html).toContain('src="/api/photos/trips/t/ctp/a.jpg"');
    expect(html).toContain("🚩 AI says sus");
    expect(html).toContain("Four feet? In dog years.");
    expect(html).toContain(`~12&#x27; 0&quot; · high confidence`);
    expect(html).toContain('data-testid="green-plot"');
    expect(html).toContain("Edit my closest to pin");
  });

  it("long drive: no plot, review status, and the reason instead of a button", () => {
    const { f, d } = scene();
    const ld = d.contests.find((c) => c.hole === 4)!;
    const html = renderToStaticMarkup(
      <ContestCard
        summary={ld}
        derived={d}
        pots={d.money.pots}
        meId={f.player.A1}
        access={{ can: false, reason: "Measure on hole 4, standing at your ball." }}
        myEntry={null}
        photoUrl={() => null}
        onEnter={() => {}}
        onOpenPhoto={() => {}}
        current={false}
      />,
    );
    expect(html).not.toContain('data-testid="green-plot"');
    expect(html).toContain("⚖️ Commish review");
    expect(html).toContain("📡 Weak GPS");
    expect(html).toContain("Needs commissioner review: GPS was weak");
    expect(html).toContain("No valid entries yet");
    expect(html).toContain("Measure on hole 4, standing at your ball.");
    expect(html).not.toContain('data-testid="contest-enter"');
  });
});
