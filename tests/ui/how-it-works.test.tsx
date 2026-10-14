// "How it works" in words (pre-round steps card + ☰ → Rules & lingo) and the menu's commissioner
// row. The rule claims are checked against the engine so the copy can't drift from the math.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { creditFor } from "@/lib/engine/drinks";
import { makeTrip, at } from "../fixtures";
import { HowItWorksCard, LINGO, RulesContent, ghostStepText, howItWorksSteps, rulesInput } from "@/components/shell/HowItWorks";
import { setupRowCopy } from "@/components/shell/MenuSheet";

const values = (teamSize: number, base: number, count: number) =>
  Array.from({ length: count }, (_, i) => creditFor(i + 1, teamSize, base) - creditFor(i, teamSize, base));

describe("how it works steps", () => {
  it("seven steps in course order, the drink rule worded the way people say it", () => {
    const steps = howItWorksSteps({ groomName: "Caster", baseTeamSize: 4 });
    expect(steps.map((s) => s.key)).toEqual(["tee", "drinks", "ghost", "score", "drives", "mulligans", "contests"]);
    expect(steps[0].text).toMatch(/ON THE TEE/);
    expect(steps[0].text).toMatch(/Drinks before that don't count/);
    expect(steps[1].text).toMatch(/takes a stroke off your team's score \(🍺 = −1\)/);
    expect(steps[3].text).toMatch(/whose drive.*TEAM score.*Save.*tee off the next hole/);
    expect(steps[4].text).toMatch(/at least once per nine/);
    expect(steps[6].text).toMatch(/🎯/);
    expect(steps[6].text).toMatch(/💣/);
  });

  it("personalises the Groom's Mulligan, and says 'the groom' when nobody's flagged", () => {
    expect(howItWorksSteps({ groomName: "Caster", baseTeamSize: 4 })[5].text).toBe(
      "Shotguns and shots bank a mulligan; Caster 👑 gets one Groom's Mulligan. Mulligans never change the score.",
    );
    expect(howItWorksSteps({ groomName: null, baseTeamSize: 4 })[5].text).toMatch(/; the groom 👑 gets one Groom's Mulligan/);
  });

  it("the foursome-base ghost line matches the engine: threesome 1, 1, 2; twosome 2, 2", () => {
    expect(values(3, 4, 6)).toEqual([1, 1, 2, 1, 1, 2]);
    expect(values(2, 4, 3)).toEqual([2, 2, 2]);
    expect(ghostStepText(4)).toBe(
      "Threesome? Every 3rd drink counts 2 (👻 ghost beer) and someone hits a 4th ball every shot. Twosome? Every drink counts 2.",
    );
  });

  it("any other base gets the general line, which also holds up against the engine", () => {
    const line = ghostStepText(3);
    expect(line).not.toMatch(/Every 3rd drink counts 2/);
    expect(line).toMatch(/Every team drinks for 3/);
    // Short-handed (twosome vs 3): some drinks count 2. Bigger (foursome vs 3): some count 0.
    expect(values(2, 3, 2)).toEqual([1, 2]);
    expect(values(4, 3, 4)).toEqual([0, 1, 1, 1]);
    expect(line).toMatch(/Some drinks count 2/);
    expect(line).toMatch(/Some count 0/);
  });

  it("reads the groom and base from the trip (deleted grooms don't count)", () => {
    const f = makeTrip({ teams: [4, 3], status: "setup" });
    const groom = f.state.players[2];
    f.state.players = f.state.players.map((p) => ({ ...p, is_groom: p.id === groom.id, nickname: p.id === groom.id ? "Caster" : p.nickname }));
    expect(rulesInput(f.state)).toEqual({ groomName: "Caster", baseTeamSize: f.state.trip.base_team_size });
    f.state.players = f.state.players.map((p) => (p.id === groom.id ? { ...p, deleted_at: at(0) } : p));
    expect(rulesInput(f.state).groomName).toBeNull();
  });
});

describe("how it works card (server-rendered)", () => {
  it("base 4 spells out the threesome ghost beer", () => {
    const html = renderToStaticMarkup(<HowItWorksCard input={{ groomName: "Caster", baseTeamSize: 4 }} />);
    expect(html).toContain('data-testid="how-it-works-steps"');
    expect(html).toContain("How it works");
    expect(html).toContain("Every 3rd drink counts 2");
    expect(html).toContain("takes a stroke off your team");
    expect(html).toContain("Caster 👑");
    // Numbered 1..7.
    expect(html.match(/data-step="/g)).toHaveLength(7);
    // No lingo button unless there's somewhere to send it.
    expect(html).not.toContain('data-testid="how-it-works-lingo"');
  });

  it("base 3 does not claim the foursome rule", () => {
    const html = renderToStaticMarkup(<HowItWorksCard input={{ groomName: "Caster", baseTeamSize: 3 }} onLingo={() => {}} />);
    expect(html).not.toContain("Every 3rd drink counts 2");
    expect(html).toContain("Every team drinks for 3");
    expect(html).toContain('data-testid="how-it-works-lingo"');
  });

  it("the rules sheet body: the same steps plus a Lingo list", () => {
    const html = renderToStaticMarkup(<RulesContent input={{ groomName: null, baseTeamSize: 4 }} />);
    expect(html).toContain("Lingo");
    expect(html).toContain("takes a stroke off your team");
    for (const l of LINGO) expect(html).toContain(`>${l.term.replace("&", "&amp;")}<`);
    expect(html.match(/<dt/g)).toHaveLength(LINGO.length);
  });

  it("the lingo covers what the board and money tab throw at you", () => {
    const terms = LINGO.map((l) => l.term);
    for (const t of ["To par", "Thru", "Net", "🍺 banked", "👻 Ghost beer", "Drive minimum", "Pots & antes", "Settle up"]) expect(terms).toContain(t);
    const pots = LINGO.find((l) => l.term === "Pots & antes")!.text;
    expect(pots).toMatch(/next hole of the same kind, then into the team match/);
    expect(LINGO.find((l) => l.term === "🍺 banked")!.text).toMatch(/count once it's scored/);
    expect(LINGO.find((l) => l.term === "Settle up")!.text).toMatch(/after|once the commissioner finalizes/);
  });
});

describe("menu: the commissioner's Setup row", () => {
  it("is Setup before the round, the Commissioner desk during and after it", () => {
    expect(setupRowCopy("setup")).toEqual({ label: "Setup", sub: "Roster, teams, course, pots, settings" });
    expect(setupRowCopy("live")).toEqual({ label: "Commissioner desk", sub: "Fix scores, drinks, contests · Finalize" });
    expect(setupRowCopy("final")).toEqual({ label: "Commissioner desk", sub: "Fix scores · Reopen" });
  });
});
