import { describe, expect, it } from "vitest";
import { derive } from "@/lib/engine";
import type { DriveNineStatus } from "@/lib/engine/types";
import { makeTrip } from "../fixtures";
import {
  advanceConfirm,
  canEditPlay,
  clampHole,
  clampStrokes,
  DRINK_UNDO_MS,
  DRINK_UNDONE_MS,
  EMPTY_BURST,
  burstAfterLog,
  burstAfterUndo,
  drinkChipDetail,
  drinkFeedback,
  drinksForRound,
  drinksOnHole,
  driveView,
  hasUnsavedDraft,
  isEditingOtherHole,
  isOwnMove,
  joinNames,
  missingScoresNote,
  mulliganOptions,
  needsOverride,
  netPreview,
  nextAction,
  nineOf,
  nineTotals,
  noWindowMessage,
  pinAfterTeamMove,
  resolvePlayTeam,
  roundSummary,
  savedScoreLine,
  scoreDraft,
  scoreName,
  scoreTone,
  stripCells,
  stripHint,
  teamMoveNotice,
  teeCtaHole,
  undoChipView,
  undoneMarkFor,
  unscoredHoles,
  viewingHole,
  type BurstDrink,
} from "@/components/play/model";

const rs = (open_hole: number | null, status: "not_started" | "playing" | "complete", started: number[] = []) => ({
  open_hole,
  status,
  started_holes: started,
});

describe("team context", () => {
  const teamIds = ["A", "B", "C"];

  it("players on a team always score for their own team", () => {
    expect(resolvePlayTeam({ myTeamId: "B", isCommissioner: false, chosenTeamId: "A", teamIds })).toEqual({ teamId: "B", canSwitch: false });
  });

  it("players without a team pick one (remembered choice wins when still valid)", () => {
    expect(resolvePlayTeam({ myTeamId: null, isCommissioner: false, chosenTeamId: null, teamIds })).toEqual({ teamId: null, canSwitch: true });
    expect(resolvePlayTeam({ myTeamId: null, isCommissioner: false, chosenTeamId: "C", teamIds })).toEqual({ teamId: "C", canSwitch: true });
    expect(resolvePlayTeam({ myTeamId: null, isCommissioner: false, chosenTeamId: "gone", teamIds }).teamId).toBeNull();
  });

  it("the commissioner defaults to his own team and may pick any team", () => {
    expect(resolvePlayTeam({ myTeamId: "A", isCommissioner: true, chosenTeamId: null, teamIds })).toEqual({ teamId: "A", canSwitch: true });
    expect(resolvePlayTeam({ myTeamId: "A", isCommissioner: true, chosenTeamId: "C", teamIds })).toEqual({ teamId: "C", canSwitch: true });
    expect(resolvePlayTeam({ myTeamId: null, isCommissioner: true, chosenTeamId: null, teamIds }).teamId).toBeNull();
    expect(resolvePlayTeam({ myTeamId: "A", isCommissioner: true, chosenTeamId: null, teamIds: ["A"] }).canSwitch).toBe(false);
  });

  it("commissioner overrides: another team's holes, or anything once final", () => {
    expect(needsOverride({ isCommissioner: true, myTeamId: "A", teamId: "A", tripStatus: "live" })).toBe(false);
    expect(needsOverride({ isCommissioner: true, myTeamId: "A", teamId: "B", tripStatus: "live" })).toBe(true);
    expect(needsOverride({ isCommissioner: true, myTeamId: "A", teamId: "A", tripStatus: "final" })).toBe(true);
    expect(needsOverride({ isCommissioner: true, myTeamId: null, teamId: "A", tripStatus: "live" })).toBe(true);
    expect(needsOverride({ isCommissioner: false, myTeamId: null, teamId: "B", tripStatus: "live" })).toBe(false);
  });

  it("play is editable while live, and by the commissioner once final", () => {
    expect(canEditPlay("live", false)).toBe(true);
    expect(canEditPlay("final", false)).toBe(false);
    expect(canEditPlay("final", true)).toBe(true);
    expect(canEditPlay("setup", true)).toBe(false);
  });
});

describe("viewing hole and advancing", () => {
  it("follows the current hole unless a hole was pinned from the scorecard", () => {
    expect(viewingHole(9, null)).toBe(9);
    expect(viewingHole(9, 6)).toBe(6);
    expect(isEditingOtherHole(9, 6)).toBe(true);
    expect(isEditingOtherHole(9, 9)).toBe(false);
    expect(isEditingOtherHole(9, null)).toBe(false);
    expect(clampHole(0)).toBe(1);
    expect(clampHole(25)).toBe(18);
    expect(clampHole(Number.NaN)).toBe(1);
  });

  it("On the tee CTA: hole 1 before the round, open_hole + 1 when viewed, never twice", () => {
    expect(teeCtaHole(null, 1)).toBe(1);
    expect(teeCtaHole(rs(null, "not_started"), 1)).toBe(1);
    expect(teeCtaHole(rs(5, "playing", [1, 2, 3, 4, 5]), 5)).toBeNull();
    expect(teeCtaHole(rs(5, "playing", [1, 2, 3, 4, 5]), 6)).toBe(6);
    expect(teeCtaHole(rs(5, "playing", [1, 2, 3, 4, 5]), 7)).toBeNull();
    expect(teeCtaHole(rs(18, "playing"), 18)).toBeNull();
    expect(teeCtaHole(rs(18, "complete"), 18)).toBeNull();
    // A commissioner rewound the window: the hole was already started once.
    expect(teeCtaHole(rs(3, "playing", [1, 2, 3, 4]), 4)).toBeNull();
  });

  it("a teammate's tee-off keeps a phone with an unsaved score on its hole (finding: second phone jumps mid-entry)", () => {
    const lines = [{ strokes: 4 }, { strokes: null }, { strokes: null }];
    // Phone B typed 5 on hole 1 (saved 4) and hasn't saved; phone A tees off hole 2.
    const unsaved = hasUnsavedDraft({ 1: 5 }, lines, 1);
    expect(unsaved).toBe(true);
    expect(pinAfterTeamMove({ from: 1, to: 2, pin: null, wasSummary: false, finished: false, unsavedOnFrom: unsaved })).toBe(1);
    // A stepper moved back to the saved value, or no draft at all: follow the team.
    expect(hasUnsavedDraft({ 1: 4 }, lines, 1)).toBe(false);
    expect(hasUnsavedDraft({}, lines, 2)).toBe(false);
    expect(hasUnsavedDraft({ 2: 4 }, lines, 2)).toBe(true);
    expect(pinAfterTeamMove({ from: 1, to: 2, pin: null, wasSummary: false, finished: false, unsavedOnFrom: false })).toBeNull();
    // The round finished on another phone while hole 18 had an unsaved score: stay on 18.
    expect(pinAfterTeamMove({ from: 18, to: 18, pin: null, wasSummary: false, finished: true, unsavedOnFrom: true })).toBe(18);
    // Nothing to protect behind the summary.
    expect(pinAfterTeamMove({ from: 18, to: 18, pin: null, wasSummary: true, finished: true, unsavedOnFrom: true })).toBeNull();
    // A hole opened from the strip stays pinned until the team reaches it.
    expect(pinAfterTeamMove({ from: 5, to: 6, pin: 3, wasSummary: false, finished: false, unsavedOnFrom: false })).toBe(3);
    expect(pinAfterTeamMove({ from: 5, to: 6, pin: 6, wasSummary: false, finished: false, unsavedOnFrom: false })).toBeNull();
    expect(pinAfterTeamMove({ from: 18, to: 18, pin: 18, wasSummary: false, finished: true, unsavedOnFrom: true })).toBe(18);
  });

  it("tells this phone's own moves from another phone's", () => {
    // Saved a score on hole 3 (opens it) a moment ago: the move to 3 is ours.
    expect(isOwnMove({ to: 3, at: 1000 }, 3, false, 1500)).toBe(true);
    // Saved hole 2 a moment ago, then the team went to 3: another phone teed off.
    expect(isOwnMove({ to: 2, at: 1000 }, 3, false, 1500)).toBe(false);
    expect(isOwnMove({ to: "complete", at: 1000 }, 18, true, 1500)).toBe(true);
    expect(isOwnMove({ to: 18, at: 1000 }, 18, true, 1500)).toBe(false);
    expect(isOwnMove({ to: 3, at: 1000 }, 3, false, 60_000)).toBe(false);
    expect(isOwnMove(null, 3, false, 1500)).toBe(false);
  });

  it("tells the user when another phone moved the team", () => {
    expect(teamMoveNotice({ to: 2, finished: false, keptHole: 1, keptValue: 5 })).toMatchObject({
      title: "Hole 2 teed off on another phone",
      message: expect.stringContaining("Your 5 on hole 1 isn't saved yet"),
    });
    expect(teamMoveNotice({ to: 2, finished: false, keptHole: null, keptValue: null })).toMatchObject({ title: "On the tee: hole 2" });
    expect(teamMoveNotice({ to: 18, finished: true, keptHole: 18, keptValue: 6 })?.title).toBe("Round finished on another phone");
    expect(teamMoveNotice({ to: 18, finished: true, keptHole: null, keptValue: null })).toBeNull();
  });

  it("next action: tee off N+1, Round complete on 18, nothing before tee off / after finishing", () => {
    expect(nextAction(null)).toEqual({ kind: "none" });
    expect(nextAction(rs(null, "not_started"))).toEqual({ kind: "none" });
    expect(nextAction(rs(1, "playing"))).toEqual({ kind: "tee", hole: 2 });
    expect(nextAction(rs(17, "playing"))).toEqual({ kind: "tee", hole: 18 });
    expect(nextAction(rs(18, "playing"))).toEqual({ kind: "complete" });
    expect(nextAction(rs(18, "complete"))).toEqual({ kind: "none" });
  });
});

describe("score entry", () => {
  it("stepper defaults to saved ?? par, Save only when the draft differs", () => {
    expect(scoreDraft(null, undefined, 4)).toEqual({ value: 4, saved: null, dirty: true, touched: false });
    expect(scoreDraft(5, undefined, 4)).toEqual({ value: 5, saved: 5, dirty: false, touched: false });
    expect(scoreDraft(5, 3, 4)).toEqual({ value: 3, saved: 5, dirty: true, touched: true });
    expect(scoreDraft(5, 5, 4)).toEqual({ value: 5, saved: 5, dirty: false, touched: true });
    expect(clampStrokes(0)).toBe(1);
    expect(clampStrokes(99)).toBe(20);
  });

  it("live net preview includes this hole's drink credit (net can go negative)", () => {
    expect(netPreview(4, 2, 4)).toMatchObject({ net: 2, netToPar: "-2", text: "4 − 2 🍺 = 2 net" });
    expect(netPreview(4, 5, 4)).toMatchObject({ net: -1, netToPar: "-5" });
    expect(netPreview(5, 0, 4)).toMatchObject({ net: 5, netToPar: "+1", text: "5 − 0 🍺 = 5 net" });
  });

  it("names scores", () => {
    expect(scoreName(1, 3)).toBe("Ace");
    expect(scoreName(2, 4)).toBe("Eagle");
    expect(scoreName(3, 4)).toBe("Birdie");
    expect(scoreName(4, 4)).toBe("Par");
    expect(scoreName(5, 4)).toBe("Bogey");
    expect(scoreName(6, 4)).toBe("Double bogey");
    expect(scoreName(8, 4)).toBe("Snowman");
    expect(scoreTone(null, 4)).toBe("none");
    expect(scoreTone(3, 4)).toBe("birdie");
    expect(scoreTone(7, 4)).toBe("double");
    expect(savedScoreLine(3, 4, 7).title).toBe("Birdie on 7");
  });
});

describe("drive minimum", () => {
  const names: Record<string, string> = { a: "Al", b: "Bo", c: "Cy" };
  const nameOf = (id: string) => names[id];
  const nine = (patch: Partial<DriveNineStatus>): DriveNineStatus => ({
    nine: 1,
    holes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    counts: { a: 1, b: 0, c: 0 },
    needing: ["b", "c"],
    remaining: 5,
    level: "ok",
    closed: false,
    missed: [],
    ...patch,
  });

  it("matches the spec copy for soft warnings", () => {
    const v = driveView(nine({ needing: ["b"], remaining: 3, level: "soft" }), nameOf);
    expect(v).toMatchObject({ tone: "soft", banner: false, nine: 1 });
    expect(v.text).toBe("Needs a drive: Bo · 3 holes left on this nine");
  });

  it("hard and impossible are red banners", () => {
    const hard = driveView(nine({ remaining: 2, level: "hard" }), nameOf);
    expect(hard).toMatchObject({ tone: "hard", banner: true });
    expect(hard.text).toContain("Bo and Cy");
    expect(hard.text).toContain("2 holes left");
    const one = driveView(nine({ needing: ["c"], remaining: 1, level: "hard" }), nameOf);
    expect(one.text).toBe("Use Cy's drive NOW: 1 hole left on this nine.");
    expect(driveView(nine({ remaining: 1, level: "impossible" }), nameOf)).toMatchObject({ tone: "impossible", banner: true });
  });

  it("ok / done / missed", () => {
    expect(driveView(nine({}), nameOf).tone).toBe("ok");
    expect(driveView(nine({ needing: [], counts: { a: 3, b: 1, c: 1 } }), nameOf).tone).toBe("done");
    const missed = driveView(nine({ nine: 2, closed: true, remaining: 0, missed: ["c"], needing: ["c"] }), nameOf);
    expect(missed).toMatchObject({ tone: "missed", banner: false, nineLabel: "back nine" });
    expect(missed.text).toContain("Cy");
    expect(driveView(nine({ closed: true, needing: [], missed: [] }), nameOf).tone).toBe("done");
  });

  it("works against the real engine for a threesome", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("B", 1);
    for (let h = 1; h <= 7; h++) {
      f.teeOff("B", h);
      f.score("B", h, 4, "B1");
    }
    const d = derive(f.state);
    const v = driveView(d.driveMin[f.team.B].nines[0], (id) => d.playerById[id]?.name ?? "?");
    // Current hole 7 has a tee shot, so holes 8 and 9 remain for two players: hard.
    expect(v.tone).toBe("hard");
    expect(nineOf(9)).toBe(1);
    expect(nineOf(10)).toBe(2);
    expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("drinks", () => {
  it("counts drinks per player on a hole and for the round, with ghost credit", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("B", 1);
    f.drink("B", "B1", 1);
    f.drink("B", "B2", 1);
    f.drink("B", "B1", 1); // 3rd drink for a threesome: ghost beer worth 2
    f.drink("B", "B3", 2);
    f.drink("A", "A1", 1);
    const d = derive(f.state);
    const onHole = drinksOnHole(d.drinkValues, f.team.B, 1);
    expect(onHole[f.player.B1]).toEqual({ count: 2, credit: 3, ghosts: 1 });
    expect(onHole[f.player.B2]).toEqual({ count: 1, credit: 1, ghosts: 0 });
    expect(onHole[f.player.B3]).toBeUndefined();
    expect(drinksForRound(d.drinkValues, f.team.B)).toEqual({ [f.player.B1]: 2, [f.player.B2]: 1, [f.player.B3]: 1 });
  });

  it("feedback: ghost beers, banked mulligans", () => {
    expect(drinkFeedback("drink", 1, "Al", 3)).toMatchObject({ ghost: false, mulligan: false, title: "Drink logged" });
    expect(drinkFeedback("drink", 2, "Al", 3)).toMatchObject({ ghost: true, title: "Ghost beer!", emoji: "👻" });
    expect(drinkFeedback("drink", 2, "Al", 3).message).toContain("−2 strokes");
    expect(drinkFeedback("shotgun", 1, "Al", 3)).toMatchObject({ mulligan: true, title: "Shotgun! Mulligan banked" });
    expect(drinkFeedback("shot", undefined, "Al", 3)).toMatchObject({ mulligan: true, ghost: false });
  });

  it("drink undo is an inline chip on the newest drink's row, never a toast (finding: drink-undo toast over the action bar)", () => {
    const d = (name: string, value = 1, type: BurstDrink["type"] = "drink"): BurstDrink => ({
      opId: `op-${name}`,
      drinkId: `d-${name}`,
      playerId: `p-${name}`,
      name,
      type,
      value,
      hole: 6,
    });
    const t0 = 1_000_000;
    expect(undoChipView(EMPTY_BURST, t0)).toBeNull();

    // A burst: each log restarts the 10 s window; the chip sits on the newest drink's row.
    let b = burstAfterLog(EMPTY_BURST, d("Tom"), t0);
    b = burstAfterLog(b, d("Jimmy"), t0 + 4_000);
    b = burstAfterLog(b, d("Rob", 2), t0 + 8_000);
    const chip = undoChipView(b, t0 + 9_000)!;
    expect(chip).toMatchObject({ playerId: "p-Rob", count: 3, remainingMs: 9_000, elapsedMs: 1_000, detail: "👻 Ghost beer −2", ariaLabel: "Undo Rob's drink" });
    expect(chip.announce).toContain("Ghost beer!");
    expect(undoChipView(b, t0 + 8_000 + DRINK_UNDO_MS)).toBeNull();

    // Undo pops the newest; the chip moves to the previous drink with a fresh window, and the
    // undone row gets a brief "Undone" mark.
    const u = burstAfterUndo(b, t0 + 12_000)!;
    expect(u.removed.drinkId).toBe("d-Rob");
    expect(undoChipView(u.burst, t0 + 12_000)).toMatchObject({ playerId: "p-Jimmy", count: 2, remainingMs: DRINK_UNDO_MS });
    expect(undoneMarkFor(u.burst, t0 + 12_000)).toBe("p-Rob");
    expect(undoneMarkFor(u.burst, t0 + 12_000 + DRINK_UNDONE_MS)).toBeNull();
    // Too late: the window closed (plus a small grace for a tap on a chip that just timed out).
    expect(burstAfterUndo(u.burst, t0 + 12_000 + DRINK_UNDO_MS + 500)).not.toBeNull();
    expect(burstAfterUndo(u.burst, t0 + 12_000 + DRINK_UNDO_MS + 2_000)).toBeNull();
    expect(burstAfterUndo(EMPTY_BURST, t0)).toBeNull();
    // A log after the window starts a new burst.
    expect(burstAfterLog(u.burst, d("Al"), t0 + 30_000).drinks.map((x) => x.name)).toEqual(["Al"]);
    // Undoing the last drink of a burst leaves no chip.
    const last = burstAfterUndo(burstAfterLog(EMPTY_BURST, d("Al"), t0), t0 + 1_000)!;
    expect(undoChipView(last.burst, t0 + 1_000)).toBeNull();

    // The chip keeps the drink feedback, including the banked mulligan.
    expect(drinkChipDetail({ type: "drink", value: 1 })).toBe("🍺 −1 stroke");
    expect(drinkChipDetail({ type: "shotgun", value: 1 })).toBe("🔫 Mulligan banked");
    expect(drinkChipDetail({ type: "shot", value: 2 })).toBe("👻 Mulligan banked");
  });

  it("no-window roasts", () => {
    expect(noWindowMessage("complete", "x")).toMatch(/Round's over/);
    expect(noWindowMessage("not_started", "x").length).toBeGreaterThan(10);
    expect(noWindowMessage(null, "y").length).toBeGreaterThan(10);
  });
});

describe("mulligans", () => {
  it("lists what can be used", () => {
    expect(mulliganOptions(undefined)).toEqual({ earned: 0, groom: false, any: false, usedTotal: 0 });
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("A", 1);
    f.drink("A", "A2", 1, "shotgun");
    let d = derive(f.state);
    expect(mulliganOptions(d.mulligans[f.team.A])).toEqual({ earned: 1, groom: true, any: true, usedTotal: 0 });
    expect(mulliganOptions(d.mulligans[f.team.B]).any).toBe(false);
    f.mulligan("A", 1, "groom");
    d = derive(f.state);
    expect(mulliganOptions(d.mulligans[f.team.A])).toEqual({ earned: 1, groom: false, any: true, usedTotal: 1 });
  });
});

describe("scorecard strip and summary", () => {
  it("builds 18 cells with current/viewing/unsaved flags", () => {
    const f = makeTrip({ teams: [4] });
    f.teeOff("A", 1);
    f.score("A", 1, 3);
    f.drink("A", "A1", 1);
    f.teeOff("A", 2);
    const d = derive(f.state);
    const cells = stripCells(d.teamHoles[f.team.A], 2, 1, [5]);
    expect(cells).toHaveLength(18);
    expect(cells[0]).toMatchObject({ hole: 1, strokes: 3, net: 2, drinks: 1, tone: "birdie", viewing: true, current: false });
    expect(cells[1]).toMatchObject({ hole: 2, strokes: null, current: true });
    expect(cells[2].contest).toBe("ctp");
    expect(cells[4].unsaved).toBe(true);
    expect(cells[0].label).toBe("Hole 1, par 4, 3 strokes, net 2, 1 drink");
  });

  it("totals out/in and lists unscored holes", () => {
    const f = makeTrip({ teams: [4] });
    f.teeOff("A", 1);
    f.score("A", 1, 4);
    f.score("A", 10, 5);
    f.drink("A", "A1", 10);
    const d = derive(f.state);
    const [out, inn, total] = nineTotals(d.teamHoles[f.team.A]);
    expect(out).toMatchObject({ label: "Out", par: 36, strokes: 4, net: 4, played: 1 });
    expect(inn).toMatchObject({ label: "In", par: 36, strokes: 5, net: 4, played: 1 });
    expect(total).toMatchObject({ par: 72, strokes: 9, net: 8, played: 2 });
    expect(unscoredHoles(d.teamHoles[f.team.A], 3)).toEqual([2, 3]);
  });

  it("the strip's total net is the leaderboard's net mid-round, with a drink on the open hole (finding: two net definitions)", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("A", 1);
    f.score("A", 1, 5);
    f.drink("A", "A1", 1);
    f.teeOff("A", 2);
    f.drink("A", "A2", 2); // open hole 2, not scored: banked
    const d = derive(f.state);
    const row = d.standings.find((r) => r.team_id === f.team.A)!;
    const total = nineTotals(d.teamHoles[f.team.A])[2];
    expect(total).toMatchObject({ strokes: 5, net: 4, played: 1 });
    expect(row).toMatchObject({ gross: 5, net: 4, net_to_par: 0, pending_drinks: 1, pending_credit: 1 });
  });

  it("missing-score copy only says 'tap to fix' to phones that can still edit (finding: final summary says tap to fix)", () => {
    expect(missingScoresNote([], true)).toBeNull();
    expect(missingScoresNote([13], true)).toBe("No score on hole 13. Tap it on the scorecard to fix.");
    expect(missingScoresNote([7, 13], true)).toBe("No score on holes 7, 13. Tap them on the scorecard to fix.");
    // A player once the trip is final (canEditPlay("final", false) === false).
    expect(canEditPlay("final", false)).toBe(false);
    expect(missingScoresNote([13], canEditPlay("final", false))).toBe("No score on hole 13. Ask the commissioner to fix it.");
    expect(missingScoresNote([7, 13], false)).toBe("No score on holes 7, 13. Ask the commissioner to fix them.");
    // The commissioner can still fix it.
    expect(missingScoresNote([13], canEditPlay("final", true))).toContain("Tap it on the scorecard");
    expect(stripHint(true)).toBe("Tap a hole to fix it");
    expect(stripHint(false)).toBe("Tap a hole to see it");
  });

  it("round summary from the standings row", () => {
    const f = makeTrip({ teams: [4, 3] });
    f.teeOff("A", 1);
    for (let h = 1; h <= 18; h++) f.score("A", h, f.state.holes.find((x) => x.number === h)!.par);
    f.drink("A", "A1", 18);
    f.complete("A");
    const d = derive(f.state);
    const row = d.standings.find((r) => r.team_id === f.team.A);
    const s = roundSummary(row, d.teamHoles[f.team.A]);
    expect(s).toMatchObject({ gross: 72, credit: 1, net: 71, netToPar: "-1", pos: "1", thru: "F", missing: [] });
    expect(roundSummary(undefined, d.teamHoles[f.team.B]).missing).toHaveLength(18);
  });
});

describe("advance confirm", () => {
  it("saves a touched draft first", () => {
    const c = advanceConfirm({ fromHole: 5, to: 6, draft: scoreDraft(null, 3, 4), credit: 1 });
    expect(c.saveFirst).toBe(3);
    // A number somebody entered is a normal (last-write-wins) save.
    expect(c.saveIsDefault).toBe(false);
    expect(c.title).toBe("Save 3 on hole 5 and tee off hole 6?");
    expect(c.confirmLabel).toBe("Save 3 & tee off 6");
    expect(c.body).toContain("net 2");
  });

  it("an untouched par default is what gets saved; skipping is the secondary action (finding: par default not saved)", () => {
    const c = advanceConfirm({ fromHole: 3, to: 4, draft: scoreDraft(null, undefined, 4), credit: 1 });
    expect(c).toMatchObject({
      saveFirst: 4,
      // Untouched default: sent fill-if-empty, so it never replaces a teammate's real score
      // (finding: advance default par clobbers a teammate's score).
      saveIsDefault: true,
      tone: "primary",
      title: "Par 4 on hole 3?",
      confirmLabel: "Save 4 & tee off hole 4",
      skipLabel: "Tee off without a score",
    });
    expect(c.body).toContain("net 3");
    expect(c.body).toContain("If a teammate already saved one, theirs stays.");
    // Finishing on 18 with the par default.
    const f = advanceConfirm({ fromHole: 18, to: "complete", draft: scoreDraft(null, undefined, 5), credit: 0, otherMissing: [7, 18] });
    expect(f).toMatchObject({ saveFirst: 5, saveIsDefault: true, tone: "danger", confirmLabel: "Save 5 & finish", skipLabel: "Finish without a score" });
    expect(f.body).toContain("Still no score on hole 7.");
    // A touched draft on an unscored hole can also be skipped; a change to a saved score can't.
    expect(advanceConfirm({ fromHole: 5, to: 6, draft: scoreDraft(null, 3, 4), credit: 0 }).skipLabel).toBe("Tee off without a score");
    expect(advanceConfirm({ fromHole: 5, to: 6, draft: scoreDraft(5, 3, 4), credit: 0 }).skipLabel).toBeNull();
  });

  it("plain confirm when saved", () => {
    const c = advanceConfirm({ fromHole: 5, to: 6, draft: scoreDraft(4, undefined, 4), credit: 2 });
    expect(c).toMatchObject({ saveFirst: null, saveIsDefault: false, skipLabel: null, tone: "primary", title: "On the tee: hole 6?", confirmLabel: "Tee off 6" });
    expect(c.body).toContain("net 2");
  });

  it("round complete lists other missing holes", () => {
    const c = advanceConfirm({ fromHole: 18, to: "complete", draft: scoreDraft(5, undefined, 5), credit: 0, otherMissing: [7, 12, 18] });
    expect(c).toMatchObject({ title: "Round complete?", confirmLabel: "Round complete", tone: "danger" });
    expect(c.body).toContain("holes 7 and 12");
    expect(c.body).toContain("window closes");
  });
});
