// Server-render the Play pieces changed in the usability pass (Oct 13): score card states, the
// quiet untouched Save, drinks row order + YOU, the contest badge as a button, the earned-only
// mulligan button, the drive chips' header and badges.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import { makeTrip } from "../fixtures";
import { ScorePanel } from "@/components/play/ScorePanel";
import { SaveButton } from "@/components/play/ActionBar";
import { DrinksPanel } from "@/components/play/DrinksPanel";
import { HoleHeader } from "@/components/play/HoleHeader";
import { MulliganPanel } from "@/components/play/MulliganPanel";
import { TeeShotPanel } from "@/components/play/TeeShotPanel";
import { ContestPanel } from "@/components/play/ContestPanel";
import { ScorecardStrip } from "@/components/play/ScorecardStrip";
import { drinksForRound, drinksOnHole, driveView, mulliganOptions, scoreDraft } from "@/components/play/model";

const count = (html: string, needle: string) => html.split(needle).length - 1;
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

describe("ScorePanel header (finding: untouched par save trap)", () => {
  const render = (saved: number | null, draft: number | undefined) =>
    renderToStaticMarkup(<ScorePanel hole={1} par={4} credit={0} draft={scoreDraft(saved, draft, 4)} disabled={false} onChange={() => {}} />);

  it("right after tee-off: 'Team score' and a grey 'No score yet'", () => {
    const html = render(null, undefined);
    expect(html).toMatch(/data-testid="score-name"[^>]*>Team score</);
    expect(html).toMatch(/data-testid="score-status" data-state="empty">No score yet</);
    expect(html).toContain("bg-sand");
    expect(html).not.toContain("Not saved");
    expect(html).not.toContain("Team score: </span>"); // the sr-only prefix only goes with a score name
  });

  it("touched: the score name and a yellow 'Not saved'", () => {
    const html = render(null, 5);
    expect(html).toMatch(/data-testid="score-name"[^>]*>Bogey</);
    expect(html).toMatch(/data-state="dirty">Not saved</);
    expect(html).toContain("bg-hazard");
    expect(html).toContain("Team score: </span>");
  });

  it("saved: '✓ Saved'; a change to it: 'Unsaved'", () => {
    expect(render(4, undefined)).toMatch(/data-state="saved">✓ Saved</);
    expect(render(4, 6)).toMatch(/data-state="dirty">Unsaved</);
  });
});

describe("SaveButton (finding: untouched par save trap)", () => {
  it("untouched default: a quiet outline 'Hole out, then / Save 4', same test id and handler slot", () => {
    const html = renderToStaticMarkup(<SaveButton value={4} dirty untouched onSave={() => {}} />);
    expect(html).toContain('data-testid="save-score"');
    expect(html).toContain('data-untouched="true"');
    expect(text(html)).toMatch(/Hole out, then\s*Save\s*4/);
    expect(html).toContain("bg-paper");
    expect(html).toContain("border-fairway-dark");
    expect(html).not.toContain("shadow-hard");
    expect(html).not.toContain("bg-fairway ");
  });

  it("touched: the filled green 'Save 5'", () => {
    const html = renderToStaticMarkup(<SaveButton value={5} dirty untouched={false} onSave={() => {}} />);
    expect(html).toContain('data-testid="save-score"');
    expect(html).not.toContain("data-untouched");
    expect(text(html)).toMatch(/^Save\s*5$/);
    expect(html).toContain("bg-fairway");
    expect(html).toContain("shadow-hard-sm");
  });

  it("the move guard still disables both", () => {
    expect(renderToStaticMarkup(<SaveButton value={4} dirty untouched disabled onSave={() => {}} />)).toContain("disabled");
    expect(renderToStaticMarkup(<SaveButton value={5} dirty disabled onSave={() => {}} />)).toContain("disabled");
  });

  it("an earlier hole with no score says so instead of 'Hole out, then'", () => {
    const html = renderToStaticMarkup(<SaveButton value={4} dirty untouched untouchedSub="No score yet" onSave={() => {}} />);
    expect(text(html)).toMatch(/No score yet\s*Save\s*4/);
  });
});

describe("DrinksPanel (findings: drinks below the fold, pre-tee drink dead end)", () => {
  function panel(opts: { me: string | null; teed: boolean; complete?: boolean; nickname?: string; drinks?: number }) {
    const f = makeTrip({ teams: [3, 3] });
    if (opts.teed) f.teeOff("B", 1);
    for (let i = 0; i < (opts.drinks ?? 0); i++) f.drink("B", "B1", 1, "drink", { min: 2 + i });
    const d = derive(f.state);
    const members = d.membersOfTeam[f.team.B].map((p) => (p.id === f.player.B3 && opts.nickname ? { ...p, nickname: opts.nickname } : p));
    const html = renderToStaticMarkup(
      <DrinksPanel
        members={members}
        teamSortOrder={1}
        meId={opts.me ? f.player[opts.me] : null}
        targetHole={1}
        viewingHole={1}
        windowOpen={opts.teed && !opts.complete}
        roundComplete={!!opts.complete}
        onHole={drinksOnHole(d.drinkValues, f.team.B, 1)}
        forRound={drinksForRound(d.drinkValues, f.team.B)}
        disabled={false}
        onLog={() => {}}
        undo={null}
        undonePlayerId={null}
        onUndo={() => {}}
      />,
    );
    return { f, html };
  }

  it("the phone owner's row comes first, tinted, with a YOU pill leading the name", () => {
    const { f, html } = panel({ me: "B3", teed: true, nickname: "Bunker Mentality" });
    const order = [...html.matchAll(/data-testid="drink-row" data-player="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([f.player.B3, f.player.B1, f.player.B2]);
    expect(count(html, 'data-me="true"')).toBe(1);
    expect(count(html, 'data-testid="drink-row-you"')).toBe(1);
    expect(html).toContain("bg-hazard-soft");
    // YOU leads the name line (finding: on the count line it cut off "drinks today" and the 👻
    // count at 360px). The count line is the same full "0 drinks today" as everyone else's.
    expect(html).toMatch(/data-testid="drink-row-you"[^>]*>You<\/span>[^]*?Bunker Mentality/);
    const youRow = html.slice(html.indexOf('data-me="true"'), html.indexOf('data-me="true"') + 3000);
    expect(youRow).toMatch(/<div class="flex min-w-0 items-center text-sm"><span class="truncate font-bold text-muted">0 drinks today<\/span>/);
    // No visible "(you)" after the name any more (screen readers still get it).
    expect(html).not.toContain("font-semibold text-muted\">(you)");
    expect(html).toContain('<span class="sr-only"> (you)</span>');
  });

  it("without a player on this team the roster order stays and nobody is YOU", () => {
    const { f, html } = panel({ me: null, teed: true });
    const order = [...html.matchAll(/data-testid="drink-row" data-player="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([f.player.B1, f.player.B2, f.player.B3]);
    expect(html).not.toContain("drink-row-you");
  });

  it("before tee-off the header says 'Not teed off yet'; after Round complete 'Round's over'", () => {
    expect(panel({ me: "B1", teed: false }).html).toMatch(/<span class="num[^"]*">Not teed off yet<\/span>/);
    expect(panel({ me: "B1", teed: false }).html).not.toContain("No window open");
    expect(panel({ me: "B1", teed: true, complete: true }).html).toMatch(/>Round&#x27;s over<\/span>/);
  });

  it("teed off with no drinks yet: 'Hole 1: no drinks yet', never '−0' (finding: −0 header)", () => {
    const none = panel({ me: "B1", teed: true }).html;
    expect(none).toMatch(/<span class="num[^"]*">Hole 1: no drinks yet<\/span>/);
    expect(none).not.toContain("−0");
    expect(panel({ me: "B1", teed: true, drinks: 1 }).html).toMatch(/<span class="num[^"]*">Hole 1: −1 🍺<\/span>/);
  });
});

describe("HoleHeader contest badge (finding: contest entry hidden)", () => {
  const f = makeTrip({ teams: [3, 3] });
  const d = derive(f.state);
  const header = (hole: number, onContest?: () => void) =>
    renderToStaticMarkup(<HoleHeader hole={hole} holeRow={d.holes[hole - 1]} teeSet={f.state.trip.settings.tee_set} standing={undefined} onContest={onContest} />);

  it("is a button when the entry can be opened: closest to pin · Enter ›", () => {
    const html = header(3, () => {});
    expect(html).toMatch(/<button type="button" aria-label="Closest to pin · Enter"[^>]*data-testid="hole-contest"/);
    expect(text(html)).toContain("Closest to pin· Enter›");
    // Same look as the plain badge, plus a transparent 48px+ hit area that doesn't grow the header.
    expect(html).toContain("after:absolute");
    expect(html).toContain("after:-top-3");
    expect(html).toContain("after:-bottom-5");
    expect(html).toContain("text-[11px]");
  });

  it("long drive: 💣 · Measure ›, never 💥", () => {
    const html = header(4, () => {});
    expect(html).toContain('aria-label="Long drive · Measure"');
    expect(html).toContain("💣");
    expect(html).not.toContain("💥");
  });

  it("without onContest it's a plain badge", () => {
    const html = header(4);
    expect(html).not.toContain("<button");
    expect(text(html)).toContain("💣 Long drive");
    expect(header(1)).not.toContain("hole-contest");
  });

  it("the par / yardage line never wraps; a narrow column shrinks it, then drops the yardage (finding: 'PAR / 4' on holes 10-18 at 360)", () => {
    const html = header(10);
    expect(html).toMatch(/<div class="[^"]*whitespace-nowrap[^"]*" data-testid="hole-par-line">/);
    expect(html).toMatch(/data-testid="hole-yards"/);
    expect(html).toMatch(/class="num hidden [^"]*@\[9\.5rem\]:inline[^"]*" data-testid="hole-yards"/);
    expect(html).toMatch(/<span class="loud text-3xl leading-none @\[11rem\]:text-4xl">Par 4<\/span>/);
  });

  it("the header doesn't clip the hit area (the stats row rounds its own corners)", () => {
    const html = header(3, () => {});
    expect(html).toMatch(/data-testid="hole-header"/);
    expect(html).not.toMatch(/<section class="[^"]*overflow-hidden/);
    expect(html).toContain("rounded-b-[22px]");
  });
});

describe("MulliganPanel (finding: mulligan single-choice sheet)", () => {
  const panel = (earned: number, groom: boolean, disabled = false) =>
    renderToStaticMarkup(
      <MulliganPanel
        hole={5}
        options={{ earned, groom, any: earned > 0 || groom, usedTotal: 0 }}
        groomOnTeam
        groomName="Caster"
        disabled={disabled}
        onUse={() => {}}
      />,
    );

  it("one earned-only button that says how many are left, no picker sheet", () => {
    const html = panel(2, true);
    expect(text(html)).toContain("Use a mulligan (2 left)");
    expect(html).not.toContain('role="dialog"');
    expect(html).toMatch(/<button[^>]*data-testid="use-mulligan"[^>]*>/);
    expect(html.match(/<button[^>]*data-testid="use-mulligan"[^>]*>/)![0]).not.toContain("disabled");
    // The groom's still goes through its own gold button.
    expect(text(html)).toContain("Groom's Mulligan");
  });

  it("0 earned: disabled, while the Groom's Mulligan stays available", () => {
    const html = panel(0, true);
    expect(text(html)).toContain("Use a mulligan (0 left)");
    expect(html.match(/<button[^>]*data-testid="use-mulligan"[^>]*>/)![0]).toContain("disabled");
    const groom = html.match(/<button[^>]*>(?:(?!<\/button>).)*Groom&#x27;s Mulligan/)![0];
    expect(groom).not.toContain("disabled");
  });

  it("works with the real engine bank", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("A", 1);
    f.drink("A", "A2", 1, "shotgun");
    const o = mulliganOptions(derive(f.state).mulligans[f.team.A]);
    const html = renderToStaticMarkup(<MulliganPanel hole={1} options={o} groomOnTeam groomName="A1" disabled={false} onUse={() => {}} />);
    expect(text(html)).toContain("Use a mulligan (1 left)");
  });
});

describe("TeeShotPanel (finding: drive minimum warns too late)", () => {
  function render(level: "ok" | "hard", opts: { banner?: boolean } = {}) {
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("A", 1);
    const d = derive(f.state);
    const nine = { ...d.driveMin[f.team.A].nines[0], level, remaining: level === "hard" ? 4 : 9 };
    const view = driveView(nine, (id) => d.playerById[id]?.name ?? "?");
    return renderToStaticMarkup(
      <TeeShotPanel
        hole={1}
        members={d.membersOfTeam[f.team.A]}
        selected={null}
        nine={nine}
        driveView={opts.banner ? null : view}
        driveTone={view.tone}
        disabled={false}
        onSelect={() => {}}
      />,
    );
  }

  it("asks whose drive was used and labels the counts", () => {
    const html = render("ok");
    expect(html).toContain(">Whose drive did you use?</h2>");
    // The count label only shows where it fits on the title's line (never a second header line).
    expect(text(html)).toContain("Drives used · front 9");
    expect(html).toMatch(/class="hidden [^"]*@\[27rem\]:inline" data-testid="drive-nine-label"/);
    expect(html).not.toContain("flex-wrap items-baseline");
    // The status line leads with the count and can take two lines (never truncated); with
    // nobody's drive used yet it's one short line.
    expect(html).toMatch(/data-testid="drive-status" data-tone="ok"/);
    expect(text(html)).toContain("9 holes left · all 4 still need a drive");
    expect(html).toMatch(/class="[^"]*line-clamp-2[^"]*" data-testid="drive-status"/);
    expect(html).not.toMatch(/class="[^"]*truncate[^"]*" data-testid="drive-status"/);
  });

  it("a 0 is neutral when nothing's urgent, red when it is (even while the banner hides the line)", () => {
    const calm = render("ok");
    expect(count(calm, 'data-testid="drive-count"')).toBe(4);
    expect(calm).not.toContain("bg-flag");
    expect(count(calm, "bg-sand")).toBeGreaterThanOrEqual(4);
    const urgent = render("hard", { banner: true });
    expect(urgent).not.toContain('data-testid="drive-status"');
    expect(count(urgent, "border-flag bg-flag")).toBe(4);
  });
});

describe("ContestPanel and ScorecardStrip (findings: contest entry hidden, ld icon collision)", () => {
  const f = makeTrip({ teams: [3, 3] });
  f.teeOff("A", 1);
  const d = derive(f.state);

  it("buttons say what they do; long drive is 💣", () => {
    const ctp = renderToStaticMarkup(<ContestPanel hole={3} contest="ctp" summary={undefined} playerById={d.playerById} canMeasure disabled={false} onOpen={() => {}} />);
    expect(text(ctp)).toContain("Enter my distance");
    const ld = renderToStaticMarkup(<ContestPanel hole={4} contest="ld" summary={undefined} playerById={d.playerById} canMeasure disabled={false} onOpen={() => {}} />);
    expect(text(ld)).toContain("Measure my drive");
    expect(ld).toContain("💣");
    expect(ld).not.toContain("💥");
  });

  it("the strip marks long-drive holes with 💣", () => {
    const html = renderToStaticMarkup(<ScorecardStrip lines={d.teamHoles[f.team.A]} currentHole={1} viewing={1} unsavedHoles={[]} onSelect={() => {}} />);
    expect(count(html, "💣")).toBe(4); // holes 4, 9, 12, 18
    expect(html).not.toContain("💥");
  });
});
