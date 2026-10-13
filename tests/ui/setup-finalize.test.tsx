// The commissioner's Finalize check: teams still out there, holes played past with no score, and
// contest rulings that can move a pot, each with a Fix link into Commissioner Tools.
// Findings: rules/finalize-no-missing-hole-warning, walkthrough/finalize-ignores-missing-hole-scores,
// money/finalize-ignores-review-queue.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { JACK_FROST_HOLES } from "@/lib/course";
import { makeTrip, type TripFixture } from "../fixtures";
import { holesLabel, scoreGaps, unfinishedTeams } from "@/components/setup/model";
import { pendingRulings } from "@/components/setup/commish/commishModel";
import { FinalizeSummary, finalizeIssueCount, type FinalizeFix, type FinalizeIssues } from "@/components/setup/FinalizeSummary";

const PAR = new Map(JACK_FROST_HOLES.map((h) => [h.number, h.par]));

/** Play a team's whole round at par (skipping some holes' scores), then tap Round complete. */
function playRound(f: TripFixture, team: string, opts: { skip?: number[]; strokes?: Record<number, number> } = {}) {
  for (let h = 1; h <= 18; h++) {
    f.teeOff(team, h);
    if (!opts.skip?.includes(h)) f.score(team, h, opts.strokes?.[h] ?? PAR.get(h)!);
  }
  f.complete(team);
}

function issuesOf(f: TripFixture): FinalizeIssues {
  const d = derive(f.state);
  return { unfinished: unfinishedTeams(f.state), gaps: scoreGaps(f.state), rulings: pendingRulings(d.contests) };
}

function render(f: TripFixture, onFix: (x: FinalizeFix) => void = () => {}) {
  const d = derive(f.state);
  return renderToStaticMarkup(<FinalizeSummary issues={issuesOf(f)} playerById={d.playerById} onFix={onFix} />);
}

describe("finalize check: missing scores", () => {
  it("warns about a team that tapped Round complete with an unscored hole (it would play as par)", () => {
    // Two foursomes each drink 4 on hole 7. Team A forgets hole 7's score (a 6) and finishes.
    const f = makeTrip({ teams: [4, 4], status: "live" });
    for (const t of ["A", "B"]) {
      for (let h = 1; h <= 18; h++) {
        f.teeOff(t, h);
        if (h === 7) for (const p of ["1", "2", "3", "4"]) f.drink(t, `${t}${p}`, 7);
        if (!(t === "A" && h === 7)) f.score(t, h, h === 7 ? 6 : PAR.get(h)!);
      }
      f.complete(t);
    }
    // What finalizing would silently lock in: A's blank hole 7 drops out of the round (thru 17, its
    // 4 drinks stay banked), so A sits at even par while the same 6 + 4 drinks puts B at -2.
    const d = derive(f.state);
    const a = d.standings.find((s) => s.team_id === f.team.A)!;
    const b = d.standings.find((s) => s.team_id === f.team.B)!;
    expect([a.thru_label, a.net_to_par, a.pending_drinks]).toEqual(["17", 0, 4]);
    expect([b.thru_label, b.net_to_par]).toEqual(["F", -2]);

    expect(unfinishedTeams(f.state)).toEqual([]);
    expect(scoreGaps(f.state).map((g) => [g.team.name, g.holes])).toEqual([["Team A", [7]]]);

    const html = render(f);
    expect(html).not.toContain("Every team tapped Round complete");
    expect(html).toContain("Missing scores:");
    expect(html).toContain("Team A: no score on hole 7");
    expect(html).toContain('aria-label="Enter Team A&#x27;s hole 7"');
    expect(finalizeIssueCount(issuesOf(f))).toBe(1);
  });

  it("counts only holes a playing team already passed; not-started teams have no gaps", () => {
    const f = makeTrip({ teams: [3, 3, 3], status: "live" });
    for (let h = 1; h <= 9; h++) {
      f.teeOff("A", h);
      if (h !== 2 && h !== 5) f.score("A", h, 4);
    }
    playRound(f, "B", { skip: [2, 13, 18] });
    // Team A is on 9 (unscored but still open: not a gap); C hasn't teed off.
    expect(scoreGaps(f.state).map((g) => [g.team.name, g.holes])).toEqual([
      ["Team A", [2, 5]],
      ["Team B", [2, 13, 18]],
    ]);
    expect(holesLabel([7])).toBe("hole 7");
    expect(holesLabel([2, 13, 18])).toBe("holes 2, 13 and 18");
    const html = render(f);
    expect(html).toContain("Still out there:");
    expect(html).toContain("Team B: no score on holes 2, 13 and 18");
  });

  it("says all clear only when every team is done, every hole is scored and no ruling is pending", () => {
    const f = makeTrip({ teams: [2, 2], status: "live" });
    playRound(f, "A");
    playRound(f, "B");
    const html = render(f);
    expect(html).toContain("Every team tapped Round complete, every hole has a score and no ruling is pending.");
    expect(html).not.toContain("You can still finalize");
    expect(finalizeIssueCount(issuesOf(f))).toBe(0);
  });
});

describe("finalize check: pending rulings", () => {
  // The money reviewer's case: hole 4 A1 310 yd weak GPS (flagged) vs B1 250 yd ok; hole 9 A2 295 yd
  // flagged and nobody else. Finalizing silently gives hole 4 to B1 and rolls hole 9.
  function flaggedDrives() {
    const f = makeTrip({ teams: [2, 2], status: "live", settings: { contest_ante_cents: 500, team_match_ante_cents: 1000 } });
    const weak4 = f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 310, low_accuracy: true, status: "flagged", flag_reason: "GPS was weak" });
    f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 250 });
    const weak9 = f.entry({ hole: 9, player_id: f.player.A2, type: "ld", distance_value: 295, low_accuracy: true, status: "flagged", flag_reason: "GPS was weak" });
    // A flagged drive that loses anyway can't move money: not worth a ruling at finalize.
    const short = f.entry({ hole: 4, player_id: f.player.B2, type: "ld", distance_value: 200, low_accuracy: true, status: "flagged", flag_reason: "GPS was weak" });
    return { f, weak4, weak9, short };
  }

  it("lists flagged entries that would take or tie the hole, by hole", () => {
    const { f, weak4, weak9, short } = flaggedDrives();
    playRound(f, "A");
    playRound(f, "B");
    const rulings = pendingRulings(derive(f.state).contests);
    expect(rulings.map((r) => r.view.entry.id)).toEqual([weak4, weak9]);
    expect(rulings.map((r) => r.view.entry.id)).not.toContain(short);

    const fixes: FinalizeFix[] = [];
    const html = render(f, (x) => fixes.push(x));
    expect(html).toContain("Needs your ruling:");
    expect(html).toContain("Hole 4 long drive · Player A1 · 310 yd · Flagged: GPS was weak");
    expect(html).toContain("Hole 9 long drive · Player A2 · 295 yd · Flagged: GPS was weak");
    expect(html).toContain("You can still finalize");
    expect(finalizeIssueCount(issuesOf(f))).toBe(2);
  });

  it("drops entries once ruled on; flags an AI-suspicious leader; ignores a suspicious entry that isn't winning", () => {
    const f = makeTrip({ teams: [2, 2], status: "live" });
    f.state.holes = f.state.holes.map((h) => (h.number === 4 ? { ...h, tee_lat: 41.0964244, tee_lng: -75.6596474 } : h));
    const approved = f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 310, status: "overridden", low_accuracy: true });
    // Out of range (the engine re-checks): would beat the approved 310 if allowed.
    const far = f.entry({ hole: 4, player_id: f.player.B1, type: "ld", distance_value: 450 });
    // Weak-GPS note on a drive that already counts and loses: informational only.
    f.entry({ hole: 4, player_id: f.player.B2, type: "ld", distance_value: 280, gps_accuracy_m: 20 });
    const susLeader = f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 2, ai_suspicious: true, ai_estimate_ft: 14, ai_confidence: "high" });
    f.entry({ hole: 8, player_id: f.player.A1, type: "ctp", distance_value: 3 });
    f.entry({ hole: 8, player_id: f.player.B1, type: "ctp", distance_value: 9, ai_suspicious: true, ai_estimate_ft: 20, ai_confidence: "high" });
    const ids = pendingRulings(derive(f.state).contests).map((r) => r.view.entry.id);
    expect(ids).toEqual([susLeader, far]);
    expect(ids).not.toContain(approved);
  });
});
