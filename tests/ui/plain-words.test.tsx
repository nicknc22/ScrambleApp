// The jargon pass, server-rendered against real engine output: the leader banner and legend in
// words, the team card's drink-window chip, champions in words, contest cards (💣, empty pots,
// "Everyone's through", late entries) and the Money banner's live copy + "You" button.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import { BoardLegend, LeaderBanner } from "@/components/screens/LeaderboardScreen";
import { ContestsBoard } from "@/components/leaderboard/ContestsBoard";
import { ChampionsHero } from "@/components/awards/AwardCards";
import { ContestCard } from "@/components/contests/ContestCard";
import { CONTEST_EMOJI, entryOf } from "@/components/contests/model";
import { MoneyBanner } from "@/components/money/MoneyBanner";

describe("leader banner and legend", () => {
  it("reads '3 under · thru 1' (no ' net'), and a chasing viewer sees how far back", () => {
    const f = makeTrip({ teams: [4, 4, 4] });
    f.teeOff("A", 1).teeOff("B", 1).teeOff("C", 1);
    f.score("A", 1, 2).score("B", 1, 5).score("C", 1, 5);
    f.drink("A", "A1", 1);
    const d = derive(f.state);
    const html = renderToStaticMarkup(<LeaderBanner derived={d} final={false} myTeamId={f.team.B} />);
    expect(html).toContain("Team A");
    expect(html).toContain("3 under · thru 1");
    expect(html).not.toMatch(/-3 net/);
    expect(html).toContain("You: T2, 4 back");
    // The leader's own phone (and nobody-picked phones) get no chase line.
    expect(renderToStaticMarkup(<LeaderBanner derived={d} final={false} myTeamId={f.team.A} />)).not.toContain('data-testid="leader-chase"');
    expect(renderToStaticMarkup(<LeaderBanner derived={d} final={false} myTeamId={null} />)).not.toContain('data-testid="leader-chase"');
  });

  it("the legend explains To par, Thru, Net and banked in plain lines", () => {
    const html = renderToStaticMarkup(<BoardLegend />);
    for (const s of ["To par", "your net vs par so far. Lowest wins", "Thru", "holes scored", "Drk / Cred", "Net", "🍺 banked", "count once it&#x27;s scored", "Tap a team for its card."]) {
      expect(html).toContain(s);
    }
  });
});

describe("champions in words", () => {
  it("'N under · net M' instead of the engine's '-N net'", () => {
    const f = makeTrip({ teams: [4, 4] });
    f.teeOff("A", 1).teeOff("B", 1);
    f.score("A", 1, 3).score("B", 1, 5);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1);
    const d = derive(f.state);
    const champs = d.awards.find((a) => a.key === "champions")!;
    const row = d.standings.find((r) => r.team_id === f.team.A)!;
    expect([row.net, row.net_to_par]).toEqual([1, -3]);
    const html = renderToStaticMarkup(<ChampionsHero award={champs} people={d} meId={null} />);
    expect(html).toContain("3 under · net 1");
    expect(html).not.toContain("-3 net");
  });
});

function contestScene(ante: number) {
  const f = makeTrip({ teams: [4, 4], settings: { contest_ante_cents: ante } });
  f.teeOff("A", 3).teeOff("B", 3);
  return f;
}

describe("contest cards", () => {
  it("long drive is 💣 everywhere (Contests tab and Board)", () => {
    expect(CONTEST_EMOJI.ld).toBe("💣");
    const f = contestScene(0);
    const html = renderToStaticMarkup(<ContestsBoard derived={derive(f.state)} meId={null} />);
    expect(html).toContain("💣 Long drive");
    expect(html).not.toContain("🏌️ Long drive");
    expect(html).not.toContain("💥");
  });

  it("no antes: 'Bragging rights only', never 'No pot' next to 'the pot's just sitting there'", () => {
    const f = contestScene(0);
    const d = derive(f.state);
    const ctp = d.contests.find((c) => c.type === "ctp")!;
    const html = renderToStaticMarkup(
      <ContestCard summary={ctp} derived={d} pots={d.money.pots} meId={null} access={{ can: false, reason: null }} myEntry={null} photoUrl={() => null} onEnter={() => {}} onOpenPhoto={() => {}} current={false} />,
    );
    expect(html).toContain("No pot");
    expect(html).toContain("No entries yet. Bragging rights only.");
    expect(html).not.toContain("just sitting there");
    // With money on it, the pot line stays.
    const g = contestScene(500);
    const dg = derive(g.state);
    const withPot = renderToStaticMarkup(
      <ContestCard summary={dg.contests.find((c) => c.type === "ctp")!} derived={dg} pots={dg.money.pots} meId={null} access={{ can: false, reason: null }} myEntry={null} photoUrl={() => null} onEnter={() => {}} onOpenPhoto={() => {}} current={false} />,
    );
    expect(withPot).toContain("just sitting there");
    expect(withPot).not.toContain("Bragging rights only");
  });

  it("a hole the group already left: a quiet late-entry button (same testid), and 'Everyone's through' once closed", () => {
    const f = contestScene(500);
    for (const t of ["A", "B"] as const) for (let h = 4; h <= 12; h++) f.teeOff(t, h);
    const d = derive(f.state);
    const ctp = d.contests.find((c) => c.type === "ctp" && c.hole === 3)!;
    expect(ctp.closed).toBe(true);
    const props = { summary: ctp, derived: d, pots: d.money.pots, meId: f.player.A1, photoUrl: () => null, onEnter: () => {}, onOpenPhoto: () => {}, current: false };
    const late = renderToStaticMarkup(<ContestCard {...props} access={{ can: true, reason: null, late: true }} myEntry={null} />);
    expect(late).toContain("Everyone&#x27;s through");
    expect(late).not.toContain(">Closed<");
    expect(late).toContain('data-testid="contest-enter"');
    expect(late).toContain('data-late="true"');
    expect(late).toContain("Forgot to enter? Add it late (it posts to the feed)");
    // Nobody entered and everyone's through: the pot rolled on, so it isn't "just sitting there".
    expect(late).toContain("Nobody entered, so the pot moved on.");
    expect(late).not.toContain("just sitting there");
    expect(late).not.toContain("bg-fairway text-white border-fairway-dark"); // not the green primary
    expect(late).not.toContain("Enter closest to pin");
    // The hole you're on: the primary button, as before.
    const now = renderToStaticMarkup(<ContestCard {...props} access={{ can: true, reason: null }} myEntry={null} current />);
    expect(now).toContain("Enter closest to pin");
    expect(now).toContain("bg-fairway text-white border-fairway-dark");
    expect(now).not.toContain('data-late="true"');
    // Already entered on a past hole: editing says it posts too.
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 6 });
    const d2 = derive(f.state);
    const ctp2 = d2.contests.find((c) => c.hole === 3)!;
    const edit = renderToStaticMarkup(
      <ContestCard {...props} summary={ctp2} derived={d2} pots={d2.money.pots} access={{ can: true, reason: null, late: true }} myEntry={entryOf(ctp2, f.player.A1)} />,
    );
    expect(edit).toContain("Edit my closest to pin (it posts to the feed)");
  });
});

describe("money banner", () => {
  it("live: plain projected copy and a 'You' tile that jumps to the settle-up preview", () => {
    const live = renderToStaticMarkup(<MoneyBanner status="live" totalCents={10000} myNetCents={-1500} onSeeMine={() => {}} />);
    expect(live).toContain("Final when the commissioner signs off.");
    // The heading already says PROJECTED: the line under it doesn't repeat it.
    expect(live).not.toContain("Projected. ");
    expect(live).not.toContain("— final");
    expect(live).toContain('data-testid="money-see-mine"');
    expect(live).toContain("You, if it ended now");
    expect(live).toContain("Who you&#x27;d pay ↓");
    expect(renderToStaticMarkup(<MoneyBanner status="live" totalCents={10000} myNetCents={2500} onSeeMine={() => {}} />)).toContain("Who pays you ↓");
    // Without a handler (or with no player) there's no button.
    expect(renderToStaticMarkup(<MoneyBanner status="live" totalCents={10000} myNetCents={-1500} />)).not.toContain("money-see-mine");
    expect(renderToStaticMarkup(<MoneyBanner status="live" totalCents={10000} myNetCents={null} onSeeMine={() => {}} />)).not.toContain("money-see-mine");
  });

  it("setup copy, and final mode keeps its plain tile", () => {
    expect(renderToStaticMarkup(<MoneyBanner status="setup" totalCents={10000} myNetCents={null} />)).toContain(">Nothing&#x27;s in play until the round starts.<");
    const fin = renderToStaticMarkup(<MoneyBanner status="final" totalCents={10000} myNetCents={-1500} onSeeMine={() => {}} />);
    expect(fin).not.toContain("money-see-mine");
    expect(fin).toContain("These numbers are real. Pay up.");
  });
});
