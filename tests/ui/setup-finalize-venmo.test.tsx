// The Finalize confirm's Venmo heads-up: payees in settle-up with no usable handle are named (their
// payers get no Pay with Venmo button), with a jump to Roster. It never counts as an issue, so it
// doesn't flip the confirm to "Finalize anyway".
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { JACK_FROST_HOLES } from "@/lib/course";
import { makeTrip, type TripFixture } from "../fixtures";
import { payeesWithoutVenmo, scoreGaps, unfinishedTeams } from "@/components/setup/model";
import { pendingRulings } from "@/components/setup/commish/commishModel";
import { FinalizeSummary, finalizeIssueCount, type FinalizeIssues } from "@/components/setup/FinalizeSummary";
import { displayName } from "@/components/ui/PlayerName";

const PAR = new Map(JACK_FROST_HOLES.map((h) => [h.number, h.par]));

function playRound(f: TripFixture, team: string, strokes: Record<number, number> = {}) {
  for (let h = 1; h <= 18; h++) {
    f.teeOff(team, h);
    f.score(team, h, strokes[h] ?? PAR.get(h)!);
  }
  f.complete(team);
}

function issuesOf(f: TripFixture): FinalizeIssues {
  const d = derive(f.state);
  return { unfinished: unfinishedTeams(f.state), gaps: scoreGaps(f.state), rulings: pendingRulings(d.contests, d.money.pots) };
}

/** Two foursomes, $20 a head: Team A birdies hole 1 and wins, so Team B pays Team A. */
function finishedTrip() {
  const f = makeTrip({ teams: [4, 4], status: "live", settings: { team_match_ante_cents: 2000, contest_ante_cents: 0 } });
  playRound(f, "A", { 1: 3 });
  playRound(f, "B");
  return f;
}

describe("finalize check: Venmo heads-up", () => {
  it("names the payees with no Venmo, links to Roster, and doesn't count as an issue", () => {
    const f = finishedTrip();
    const d = derive(f.state);
    expect(d.money.payments.length).toBeGreaterThan(0);
    const payees = payeesWithoutVenmo(d.money.payments, d.playerById);
    // Nobody has a handle in the fixture: every payee (Team A) is listed.
    expect(payees.length).toBeGreaterThan(0);
    expect(payees.every((p) => [f.player.A1, f.player.A2, f.player.A3, f.player.A4].includes(p.id))).toBe(true);

    const names = payees.map((p) => displayName(p));
    const issues = issuesOf(f);
    expect(finalizeIssueCount(issues)).toBe(0);
    const html = renderToStaticMarkup(
      <FinalizeSummary issues={issues} playerById={d.playerById} onFix={() => {}} noVenmo={names} onRoster={() => {}} />,
    );
    expect(html).toContain("Every team tapped Round complete");
    expect(html).toContain('data-testid="finalize-venmo"');
    expect(html).toContain(`No Venmo for ${names.slice(0, 4).join(", ")}`);
    expect(html).toContain("their payers get no Pay button. Add it in Roster.");
    expect(html).toContain('aria-label="Add Venmo handles in Roster"');
    // Still clean: no "You can still finalize" nag.
    expect(html).not.toContain("You can still finalize");
  });

  it("stays quiet when every payee has a handle", () => {
    const f = finishedTrip();
    f.state = { ...f.state, players: f.state.players.map((p, i) => ({ ...p, venmo_handle: `player-${i}` })) };
    const d = derive(f.state);
    expect(payeesWithoutVenmo(d.money.payments, d.playerById)).toEqual([]);
    const html = renderToStaticMarkup(<FinalizeSummary issues={issuesOf(f)} playerById={d.playerById} onFix={() => {}} noVenmo={[]} />);
    expect(html).not.toContain("finalize-venmo");
  });

  it("caps a long list: four names, then +N more", () => {
    const f = finishedTrip();
    const d = derive(f.state);
    const html = renderToStaticMarkup(
      <FinalizeSummary issues={issuesOf(f)} playerById={d.playerById} onFix={() => {}} noVenmo={["Joe", "Greg", "Rich", "Reitman", "Drew", "Will"]} />,
    );
    expect(html).toContain("No Venmo for Joe, Greg, Rich, Reitman +2 more: their payers get no Pay button.");
    // No Roster jump without a handler.
    expect(html).not.toContain("Add Venmo handles in Roster");
  });
});
