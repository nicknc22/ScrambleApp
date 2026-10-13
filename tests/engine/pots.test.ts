import { describe, expect, it } from "vitest";
import { derive } from "@/lib/engine";
import { computeMoney } from "@/lib/engine/pots";
import type { MoneySummary, PotView } from "@/lib/engine/types";
import { JACK_FROST_HOLES } from "@/lib/course";
import type { PotKey, TeamRoundState, TripSettings, TripStatus } from "@/lib/types";
import { at, makeTrip, type TripFixture } from "../fixtures";

const PAR: Record<number, number> = Object.fromEntries(JACK_FROST_HOLES.map((h) => [h.number, h.par]));

function money(f: TripFixture): MoneySummary {
  return derive(f.state, { strict: true }).money;
}
function pot(m: MoneySummary, key: PotKey): PotView {
  const p = m.pots.find((x) => x.key === key);
  if (!p) throw new Error(`no pot ${key}`);
  return p;
}
function setStatus(f: TripFixture, status: TripStatus) {
  f.state = { ...f.state, trip: { ...f.state.trip, status } };
}
function patchRound(f: TripFixture, team: string, patch: Partial<TeamRoundState>) {
  f.state = {
    ...f.state,
    team_round_state: f.state.team_round_state.map((rs) => (rs.team_id === f.team[team] ? { ...rs, ...patch } : rs)),
  };
}
/** Every listed team plays all 18 at par except hole 1 (par + delta), completes; trip final by default. */
function finish(f: TripFixture, deltas: Record<string, number>, final = true) {
  for (const [t, delta] of Object.entries(deltas)) {
    for (let h = 1; h <= 18; h++) f.score(t, h, PAR[h] + (h === 1 ? delta : 0));
    f.teeOff(t, 18);
    f.complete(t);
  }
  if (final) setStatus(f, "final");
}
/** Net per player label, e.g. { A1: 3000, B1: -2000 }. */
function nets(f: TripFixture, m: MoneySummary): Record<string, number> {
  const label = Object.fromEntries(Object.entries(f.player).map(([k, v]) => [v, k]));
  return Object.fromEntries(m.ledger.map((r) => [label[r.player_id], r.net_cents]));
}
function payoutsByLabel(f: TripFixture, p: PotView): Record<string, number> {
  const label = Object.fromEntries(Object.entries(f.player).map(([k, v]) => [v, k]));
  return Object.fromEntries(Object.entries(p.payouts).map(([id, c]) => [label[id], c]));
}

/** Every invariant the Money tab relies on. */
function expectConsistent(m: MoneySummary) {
  let antes = 0;
  let wins = 0;
  for (const r of m.ledger) {
    expect(r.net_cents).toBe(r.winnings_cents - r.antes_cents);
    expect(Number.isInteger(r.net_cents)).toBe(true);
    expect(r.antes_cents).toBeGreaterThanOrEqual(0);
    expect(r.winnings_cents).toBeGreaterThanOrEqual(0);
    antes += r.antes_cents;
    wins += r.winnings_cents;
  }
  expect(m.ledger.reduce((s, r) => s + r.net_cents, 0)).toBe(0);
  expect(wins).toBe(antes);
  expect(m.total_in_play_cents).toBe(wins);

  const byKey = new Map(m.pots.map((p) => [p.key, p]));
  for (const p of m.pots) {
    expect(p.base_cents).toBe(p.ante_cents * p.participants.length);
    expect(p.total_cents).toBe(p.base_cents + p.rollover_in_cents);
    const fromSum = p.rolled_from.reduce((s, k) => s + byKey.get(k)!.total_cents, 0);
    expect(p.rollover_in_cents).toBe(fromSum);
    const paid = Object.values(p.payouts).reduce((s, c) => s + c, 0);
    if (p.status === "won" || p.status === "refunded") {
      expect(paid).toBe(p.total_cents);
      expect(new Set(Object.keys(p.payouts))).toEqual(new Set(p.winners));
    } else {
      expect(paid).toBe(0);
      expect(p.winners).toEqual([]);
    }
    if (p.status === "rolled") {
      expect(p.rolled_to).not.toBeNull();
      expect(byKey.get(p.rolled_to!)!.rolled_from).toContain(p.key);
    } else {
      expect(p.rolled_to).toBeNull();
    }
  }

  // Settle-up zeroes every balance.
  const bal = new Map(m.ledger.map((r) => [r.player_id, r.net_cents]));
  for (const pay of m.payments) {
    expect(pay.amount_cents).toBeGreaterThan(0);
    bal.set(pay.from_player_id, bal.get(pay.from_player_id)! + pay.amount_cents);
    bal.set(pay.to_player_id, bal.get(pay.to_player_id)! - pay.amount_cents);
  }
  for (const v of bal.values()) expect(v).toBe(0);
}

const ANTES: Partial<TripSettings> = { team_match_ante_cents: 2000, contest_ante_cents: 500 };

describe("Pot payouts and settle-up sum to zero, ties split, and empty contest pots roll over", () => {
  it("winner-take-all team match", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000, contest_ante_cents: 0 } });
    finish(f, { A: -2, B: 0, C: 1 });
    const m = money(f);
    expectConsistent(m);
    expect(m.final).toBe(true);
    const tm = pot(m, "team_match");
    expect(tm).toMatchObject({ label: "Team match", type: "team_match", status: "won", base_cents: 20000, total_cents: 20000 });
    expect(payoutsByLabel(f, tm)).toEqual({ A1: 5000, A2: 5000, A3: 5000, A4: 5000 });
    expect(nets(f, m)).toEqual({ A1: 3000, A2: 3000, A3: 3000, A4: 3000, B1: -2000, B2: -2000, B3: -2000, C1: -2000, C2: -2000, C3: -2000 });
    // Greedy biggest-debtor/biggest-creditor (the spec'd algorithm): 6 losers, 4 winners -> 8 payments.
    expect(m.payments).toHaveLength(8);
    expect(m.payments[0]).toEqual({ from_player_id: f.player.B1, to_player_id: f.player.A1, amount_cents: 2000 });
    expect(m.total_in_play_cents).toBe(20000);
  });

  it("70/30 split with remainder cents to the first member", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000, team_match_payout: [70, 30] } });
    finish(f, { A: 3, B: -1, C: 0 });
    const m = money(f);
    expectConsistent(m);
    const tm = pot(m, "team_match");
    // 1st (B, 3 players) 14000 -> 4667/4667/4666; 2nd (C) 6000 -> 2000 each.
    expect(payoutsByLabel(f, tm)).toEqual({ B1: 4667, B2: 4667, B3: 4666, C1: 2000, C2: 2000, C3: 2000 });
    expect(tm.winners).toEqual([f.player.B1, f.player.B2, f.player.B3, f.player.C1, f.player.C2, f.player.C3]);
    expect(nets(f, m)).toMatchObject({ A1: -2000, B1: 2667, B3: 2666, C1: 0 });
  });

  it("70/30 with odd cents: pools floor, remainder to 1st place", () => {
    const f = makeTrip({ teams: [3, 2], settings: { team_match_ante_cents: 333, team_match_payout: [70, 30] } });
    finish(f, { A: 0, B: 1 });
    const m = money(f);
    expectConsistent(m);
    // total 1665: 2nd = floor(1665 * 0.3) = 499, 1st = 1166.
    const tm = pot(m, "team_match");
    expect(payoutsByLabel(f, tm)).toEqual({ A1: 389, A2: 389, A3: 388, B1: 250, B2: 249 });
  });

  it("ties on the team match split per member across team sizes", () => {
    // Winner take all, A (4) and B (3) tie for 1st: 7 members split the whole pot.
    const f = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000 } });
    finish(f, { A: -1, B: -1, C: 2 });
    const m = money(f);
    expectConsistent(m);
    const tm = pot(m, "team_match");
    // 20000 / 7 = 2857 r 1.
    expect(payoutsByLabel(f, tm)).toEqual({ A1: 2858, A2: 2857, A3: 2857, A4: 2857, B1: 2857, B2: 2857, B3: 2857 });
    const d = derive(f.state);
    expect(d.standings.filter((r) => r.pos === 1)).toHaveLength(2);
  });

  it("70/30: a tie for 1st pools 1st+2nd; a tie for 2nd splits 2nd per member", () => {
    const f1 = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000, team_match_payout: [70, 30] } });
    finish(f1, { A: 0, B: 0, C: 5 });
    const m1 = money(f1);
    expectConsistent(m1);
    expect(payoutsByLabel(f1, pot(m1, "team_match"))).toEqual({ A1: 2858, A2: 2857, A3: 2857, A4: 2857, B1: 2857, B2: 2857, B3: 2857 });

    const f2 = makeTrip({ teams: [4, 3, 3], settings: { team_match_ante_cents: 2000, team_match_payout: [70, 30] } });
    finish(f2, { A: -3, B: 1, C: 1 });
    const m2 = money(f2);
    expectConsistent(m2);
    expect(payoutsByLabel(f2, pot(m2, "team_match"))).toEqual({
      A1: 3500, A2: 3500, A3: 3500, A4: 3500,
      B1: 1000, B2: 1000, B3: 1000, C1: 1000, C2: 1000, C3: 1000,
    });
  });

  it("50/30/20: a tie for 2nd pools the 2nd and 3rd place money", () => {
    const f = makeTrip({ teams: [3, 3, 2, 2], settings: { team_match_ante_cents: 1000, team_match_payout: [50, 30, 20] } });
    finish(f, { A: -2, B: 0, C: 0, D: 4 });
    const m = money(f);
    expectConsistent(m);
    // total 10000: A 5000; B+C pool 5000 over 5 members; D nothing.
    expect(payoutsByLabel(f, pot(m, "team_match"))).toEqual({ A1: 1667, A2: 1667, A3: 1666, B1: 1000, B2: 1000, B3: 1000, C1: 1000, C2: 1000 });
  });

  it("fewer ranked teams than paid places: unused percentages go to the last occupied place", () => {
    const f = makeTrip({ teams: [2, 2], settings: { team_match_ante_cents: 1000, team_match_payout: [50, 30, 20] } });
    finish(f, { A: 0, B: 1 });
    const m = money(f);
    expectConsistent(m);
    expect(payoutsByLabel(f, pot(m, "team_match"))).toEqual({ A1: 1000, A2: 1000, B1: 1000, B2: 1000 });

    // Only one team in the pot at all (the other opted out): it takes 100%.
    const g = makeTrip({ teams: [2, 2], settings: { team_match_ante_cents: 1000, team_match_payout: [70, 30] } });
    g.optOut("A1", "team_match").optOut("A2", "team_match");
    finish(g, { A: -5, B: 1 });
    const mg = money(g);
    expectConsistent(mg);
    expect(payoutsByLabel(g, pot(mg, "team_match"))).toEqual({ B1: 1000, B2: 1000 });
    expect(nets(g, mg)).toEqual({ A1: 0, A2: 0, B1: 0, B2: 0 });
  });

  it("a tie for 1st among all teams with 70/30 hands the whole pot to everyone in the tie", () => {
    const f = makeTrip({ teams: [2, 2], settings: { team_match_ante_cents: 1000, team_match_payout: [70, 30] } });
    finish(f, { A: 0, B: 0 });
    const m = money(f);
    expectConsistent(m);
    expect(Object.values(nets(f, m))).toEqual([0, 0, 0, 0]);
  });

  it("ties on a contest hole split the pot", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: ANTES });
    f.entry({ hole: 3, player_id: f.player.A2, type: "ctp", distance_value: 3 });
    f.entry({ hole: 3, player_id: f.player.C3, type: "ctp", distance_value: 3.02 }); // same inch
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 8 });
    // Three-way long-drive tie with remainder cents on hole 4.
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 280 });
    f.entry({ hole: 4, player_id: f.player.B2, type: "ld", distance_value: 280.3 });
    f.entry({ hole: 4, player_id: f.player.C1, type: "ld", distance_value: 279.6 });
    finish(f, { A: 0, B: 1, C: 2 });
    const m = money(f);
    expectConsistent(m);
    const c3 = pot(m, "contest:3");
    expect(c3).toMatchObject({ label: "Hole 3 · Closest to pin", type: "contest", hole: 3, contest_type: "ctp", status: "won" });
    expect(c3.total_cents).toBe(5000);
    expect(payoutsByLabel(f, c3)).toEqual({ A2: 2500, C3: 2500 });
    const c4 = pot(m, "contest:4");
    expect(c4.label).toBe("Hole 4 · Long drive");
    expect(payoutsByLabel(f, c4)).toEqual({ A1: 1667, B2: 1667, C1: 1666 });
  });

  it("rollover chain 3 -> 8 -> 11 -> 16 -> team match", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: ANTES });
    // Every long drive hole has a winner, no closest-to-pin entries at all.
    for (const h of [4, 9, 12, 18]) f.entry({ hole: h, player_id: f.player.B1, type: "ld", distance_value: 250 });
    // An invalid (flagged) entry doesn't stop a rollover.
    f.entry({ hole: 8, player_id: f.player.A1, type: "ctp", distance_value: 2, status: "flagged", flag_reason: "photo shows a bunker" });
    finish(f, { A: -1, B: 0, C: 0 });
    const m = money(f);
    expectConsistent(m);
    expect(pot(m, "contest:3")).toMatchObject({ status: "rolled", rolled_to: "contest:8", total_cents: 5000 });
    expect(pot(m, "contest:8")).toMatchObject({ status: "rolled", rolled_to: "contest:11", rollover_in_cents: 5000, rolled_from: ["contest:3"], total_cents: 10000 });
    expect(pot(m, "contest:11")).toMatchObject({ status: "rolled", rolled_to: "contest:16", rollover_in_cents: 10000, total_cents: 15000 });
    expect(pot(m, "contest:16")).toMatchObject({ status: "rolled", rolled_to: "team_match", rollover_in_cents: 15000, total_cents: 20000 });
    const tm = pot(m, "team_match");
    expect(tm).toMatchObject({ status: "won", base_cents: 20000, rollover_in_cents: 20000, rolled_from: ["contest:16"], total_cents: 40000 });
    expect(payoutsByLabel(f, tm)).toEqual({ A1: 10000, A2: 10000, A3: 10000, A4: 10000 });
    for (const h of [4, 9, 12, 18]) expect(pot(m, `contest:${h}`)).toMatchObject({ status: "won", total_cents: 5000 });
    // A members: +10000 - 2000 - 8 * 500 = 4000. B1 wins 4 LD pots: 20000 - 6000 = 14000.
    expect(nets(f, m)).toMatchObject({ A1: 4000, B1: 14000, B2: -6000, C1: -6000 });
  });

  it("a rollover stops at the next hole of the same type that has a winner", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    f.entry({ hole: 11, player_id: f.player.B2, type: "ctp", distance_value: 6 });
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 260 });
    finish(f, { A: 0, B: 1 });
    const m = money(f);
    expectConsistent(m);
    expect(pot(m, "contest:3").rolled_to).toBe("contest:8");
    expect(pot(m, "contest:8").rolled_to).toBe("contest:11");
    expect(pot(m, "contest:11")).toMatchObject({ status: "won", total_cents: 6000, rolled_from: ["contest:8"] });
    expect(payoutsByLabel(f, pot(m, "contest:11"))).toEqual({ B2: 6000 });
    // 16 has no entries -> team match. LD: 4 won, 9 -> 12 -> 18 -> team match.
    expect(pot(m, "contest:16").rolled_to).toBe("team_match");
    expect(pot(m, "contest:9").rolled_to).toBe("contest:12");
    expect(pot(m, "contest:18")).toMatchObject({ rolled_to: "team_match", total_cents: 6000 });
    expect(pot(m, "team_match")).toMatchObject({ rolled_from: ["contest:16", "contest:18"], rollover_in_cents: 8000, total_cents: 16000 });
  });

  it("opt-outs: out of the pot, no ante, no winnings; deleted opt-out rows mean back in", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: ANTES });
    f.optOut("A4", "team_match"); // on the winning team but opted out
    f.optOut("C3", "team_match");
    f.optOut("B1", "contest:3");
    // A revoked opt-out (soft-deleted row) means B2 is back in the team match.
    f.optOut("B2", "team_match");
    f.state = {
      ...f.state,
      pot_optouts: f.state.pot_optouts.map((o) => (o.player_id === f.player.B2 ? { ...o, deleted_at: at(99) } : o)),
    };
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 4 });
    finish(f, { A: -1, B: 0, C: 0 });
    const m = money(f);
    expectConsistent(m);
    const tm = pot(m, "team_match");
    expect(tm.participants).toHaveLength(8);
    expect(tm.participants).not.toContain(f.player.A4);
    expect(tm.participants).toContain(f.player.B2);
    expect(tm.base_cents).toBe(16000);
    // 7 contest pots had no entries and rolled in (10 x 500 each).
    expect(tm.rollover_in_cents).toBe(35000);
    expect(payoutsByLabel(f, tm)).toEqual({ A1: 17000, A2: 17000, A3: 17000 });
    expect(pot(m, "contest:3").participants).not.toContain(f.player.B1);
    expect(pot(m, "contest:3").total_cents).toBe(4500);
    const a4 = m.ledger.find((r) => r.player_id === f.player.A4)!;
    expect(a4.antes_cents).toBe(8 * 500); // contests only
    const b1 = m.ledger.find((r) => r.player_id === f.player.B1)!;
    expect(b1.antes_cents).toBe(2000 + 7 * 500);
  });

  it("a team with every member opted out can't win; the next team does", () => {
    const f = makeTrip({ teams: [2, 2, 2], settings: { team_match_ante_cents: 1000 } });
    f.optOut("A1", "team_match").optOut("A2", "team_match");
    finish(f, { A: -4, B: 1, C: 0 });
    const m = money(f);
    expectConsistent(m);
    expect(payoutsByLabel(f, pot(m, "team_match"))).toEqual({ C1: 2000, C2: 2000 });
  });

  it("opted-out contest winner -> the next eligible participant wins", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: ANTES });
    f.optOut("A1", "contest:3");
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 1 }); // best, but not in the pot
    f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 2, status: "flagged", flag_reason: "AI hates it" }); // invalid
    f.entry({ hole: 3, player_id: f.player.C2, type: "ctp", distance_value: 6 });
    f.entry({ hole: 3, player_id: f.player.A3, type: "ctp", distance_value: 9 });
    finish(f, { A: 0, B: 0, C: 0 });
    const d = derive(f.state, { strict: true });
    expect(d.contests.find((c) => c.hole === 3)!.leader_ids).toEqual([f.player.A1]); // contest card still shows A1
    const m = d.money;
    expectConsistent(m);
    const c3 = pot(m, "contest:3");
    expect(c3).toMatchObject({ status: "won", total_cents: 4500, winners: [f.player.C2] });
    expect(payoutsByLabel(f, c3)).toEqual({ C2: 4500 });
  });

  it("contest pots: everyone opted out of a hole and nobody valid -> rolls with zero", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    for (const p of ["A1", "A2", "B1", "B2"]) f.optOut(p, "contest:3");
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 1 });
    f.entry({ hole: 8, player_id: f.player.B1, type: "ctp", distance_value: 7 });
    finish(f, { A: 0, B: 1 });
    const m = money(f);
    expectConsistent(m);
    expect(pot(m, "contest:3")).toMatchObject({ status: "rolled", rolled_to: "contest:8", total_cents: 0, participants: [] });
    expect(pot(m, "contest:8")).toMatchObject({ status: "won", total_cents: 2000 });
  });

  it("pending holes mid-round are excluded from the ledger and don't roll", () => {
    const f = makeTrip({ teams: [4, 3, 3], settings: ANTES });
    // Before anyone scores everything is pending and nobody owes anything.
    let m = money(f);
    expectConsistent(m);
    expect(m.final).toBe(false);
    expect(m.pots.every((p) => p.status === "pending")).toBe(true);
    expect(m.ledger.every((r) => r.antes_cents === 0 && r.net_cents === 0)).toBe(true);
    expect(m.payments).toEqual([]);
    expect(m.total_in_play_cents).toBe(0);
    expect(m.ledger).toHaveLength(10);

    // Mid-round: A on 9, B on 5, C on 4.
    for (const [t, thru] of [["A", 8], ["B", 4], ["C", 3]] as const) {
      for (let h = 1; h <= thru; h++) f.score(t, h, PAR[h] + (t === "A" ? 1 : 0));
      f.teeOff(t, thru + 1);
    }
    // Hole 3 (closed, every team is past it): no entries -> rolls to 8 (A on 9, others not there) -> pending.
    // Hole 4 (C is on it): one valid entry -> projected won.
    f.entry({ hole: 4, player_id: f.player.C2, type: "ld", distance_value: 260 });
    m = money(f);
    expectConsistent(m);
    expect(pot(m, "contest:3")).toMatchObject({ status: "rolled", rolled_to: "contest:8" });
    expect(pot(m, "contest:8")).toMatchObject({ status: "pending", rollover_in_cents: 5000, total_cents: 10000 });
    expect(pot(m, "contest:4")).toMatchObject({ status: "won", winners: [f.player.C2] });
    expect(pot(m, "contest:9")).toMatchObject({ status: "pending", rollover_in_cents: 0 });
    for (const h of [11, 12, 16, 18]) expect(pot(m, `contest:${h}`).status).toBe("pending");
    // Team match: B and C are tied at even through their holes, A is +8. Projected won.
    const tm = pot(m, "team_match");
    expect(tm.status).toBe("won");
    expect(payoutsByLabel(f, tm)).toEqual({ B1: 3334, B2: 3334, B3: 3333, C1: 3333, C2: 3333, C3: 3333 });
    // Antes: team match + contest:4 only (3's money sits in pending 8).
    expect(m.ledger.every((r) => r.antes_cents === 2500)).toBe(true);
    expect(m.total_in_play_cents).toBe(20000 + 5000);

    // Hole 8 gets an entry: 8 now won with 3's rollover, and 3's antes are charged.
    f.entry({ hole: 8, player_id: f.player.A4, type: "ctp", distance_value: 12 });
    m = money(f);
    expectConsistent(m);
    expect(pot(m, "contest:8")).toMatchObject({ status: "won", total_cents: 10000 });
    expect(m.ledger.every((r) => r.antes_cents === 3500)).toBe(true);
  });

  it("a hole a team hasn't reached stays pending even if the others are done", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    finish(f, { A: 0 }, false);
    patchRound(f, "B", { status: "playing", open_hole: 16 });
    f.score("B", 1, 4);
    const m = money(f);
    expectConsistent(m);
    expect(pot(m, "contest:11")).toMatchObject({ status: "rolled", rolled_to: "contest:16" });
    // 3 -> 8 -> 11 all closed and empty: their money waits in pending 16.
    expect(pot(m, "contest:16")).toMatchObject({ status: "pending", total_cents: 8000, rollover_in_cents: 6000 });
    expect(pot(m, "contest:12")).toMatchObject({ status: "rolled", rolled_to: "contest:18" });
    expect(pot(m, "contest:18")).toMatchObject({ status: "pending" });
    // Once final, the pending pots resolve: 16 -> team match, 18 -> team match.
    setStatus(f, "final");
    const fm = money(f);
    expectConsistent(fm);
    expect(fm.final).toBe(true);
    expect(pot(fm, "team_match")).toMatchObject({ rolled_from: ["contest:16", "contest:18"], total_cents: 4 * 2000 + 8 * 2000 });
  });

  it("refund edge: nobody in the team match -> rolled contest money goes back to its antes", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    for (const p of ["A1", "A2", "B1", "B2"]) f.optOut(p, "team_match");
    f.optOut("A2", "contest:16");
    f.entry({ hole: 4, player_id: f.player.A1, type: "ld", distance_value: 260 });
    // CTP: no entries at all -> 3 -> 8 -> 11 -> 16 -> team match. LD: 4 won; 9 -> 12 -> 18 -> team match.
    finish(f, { A: 0, B: 1 });
    const m = money(f);
    expectConsistent(m);
    const tm = pot(m, "team_match");
    expect(tm).toMatchObject({ status: "refunded", base_cents: 0, participants: [], total_cents: 4 * 2000 - 500 + 3 * 2000 });
    // Each player gets back exactly the antes of the pots that ended up in the team match.
    expect(payoutsByLabel(f, tm)).toEqual({ A1: 3500, A2: 3000, B1: 3500, B2: 3500 });
    // Only the hole 4 long drive pot moved money: A1 +1500, everyone else -500.
    expect(nets(f, m)).toEqual({ A1: 1500, A2: -500, B1: -500, B2: -500 });
  });

  it("refund edge: nobody in the team match and nothing rolled in -> refunded with zero; pending before play", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    for (const p of ["A1", "A2", "B1", "B2"]) f.optOut(p, "team_match");
    expect(pot(money(f), "team_match").status).toBe("pending");
    for (const h of [3, 4, 8, 9, 11, 12, 16, 18]) {
      const type = PAR[h] === 5 ? "ld" : "ctp";
      f.entry({ hole: h, player_id: f.player.B1, type, distance_value: type === "ld" ? 250 : 5 });
    }
    finish(f, { A: 0, B: 0 });
    const m = money(f);
    expectConsistent(m);
    expect(pot(m, "team_match")).toMatchObject({ status: "refunded", total_cents: 0, winners: [] });
  });

  it("only active players on active teams are in the ledger", () => {
    const f = makeTrip({ teams: [3, 3], settings: ANTES });
    f.state = {
      ...f.state,
      players: f.state.players.map((p) => (p.id === f.player.A3 ? { ...p, deleted_at: at(1) } : p)),
      team_members: f.state.team_members.filter((m) => m.player_id !== f.player.B3),
    };
    finish(f, { A: 0, B: 1 });
    const m = money(f);
    expectConsistent(m);
    expect(m.ledger.map((r) => r.player_id)).toEqual([f.player.A1, f.player.A2, f.player.B1, f.player.B2]);
    expect(pot(m, "team_match").participants).toHaveLength(4);
  });

  it("zero antes: pots still resolve and everyone nets 0", () => {
    const f = makeTrip({ teams: [4, 3, 3] });
    f.entry({ hole: 3, player_id: f.player.A1, type: "ctp", distance_value: 3 });
    finish(f, { A: 0, B: 1, C: 2 });
    const m = money(f);
    expectConsistent(m);
    expect(pot(m, "team_match").status).toBe("won");
    expect(pot(m, "team_match").winners).toHaveLength(4);
    expect(pot(m, "contest:3").winners).toEqual([f.player.A1]);
    expect(m.ledger.every((r) => r.net_cents === 0)).toBe(true);
    expect(m.payments).toEqual([]);
  });

  it("drinks count: the team match goes to the lowest NET", () => {
    const f = makeTrip({ teams: [2, 2], settings: { team_match_ante_cents: 1000 } });
    f.teeOff("A", 1);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1); // twosome: 2 credit each = 4 strokes
    finish(f, { A: 2, B: 0 });
    const m = money(f);
    expectConsistent(m);
    expect(payoutsByLabel(f, pot(m, "team_match"))).toEqual({ A1: 2000, A2: 2000 });
  });

  it("a finished team with an unscored hole is ranked by net to par over its scored holes; credit banked there doesn't count", () => {
    const f = makeTrip({ teams: [2, 2], settings: { team_match_ante_cents: 1000 } });
    f.teeOff("A", 1);
    f.drink("A", "A1", 1);
    f.drink("A", "A2", 1); // twosome: 4 credit on hole 1
    finish(f, { A: 2 }, false); // A: +2 gross, 4 credit -> -2 net to par
    for (let h = 1; h <= 17; h++) f.teeOff("B", h).score("B", h, PAR[h]);
    f.teeOff("B", 18);
    f.drink("B", "B1", 18);
    f.drink("B", "B2", 18); // 4 credit banked on hole 18, which never got a score
    f.complete("B");
    setStatus(f, "final");
    const d = derive(f.state, { strict: true });
    expect(d.standings.map((r) => [r.team_id, r.thru, r.net_to_par, r.pending_credit])).toEqual([
      [f.team.A, 18, -2, 0],
      [f.team.B, 17, 0, 4],
    ]);
    const m = d.money;
    expectConsistent(m);
    expect(payoutsByLabel(f, pot(m, "team_match"))).toEqual({ A1: 2000, A2: 2000 });
  });

  it("orders pots: team match first, then contest holes", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    expect(money(f).pots.map((p) => p.key)).toEqual(["team_match", "contest:3", "contest:4", "contest:8", "contest:9", "contest:11", "contest:12", "contest:16", "contest:18"]);
  });

  it("computeMoney sorts contest summaries itself", () => {
    const f = makeTrip({ teams: [2, 2], settings: ANTES });
    finish(f, { A: 0, B: 1 });
    const d = derive(f.state, { strict: true });
    const a = computeMoney(f.state, d.standings, d.contests, d.teamOfPlayer);
    const b = computeMoney(f.state, d.standings, [...d.contests].reverse(), d.teamOfPlayer);
    expect(b).toEqual(a);
  });
});

describe("money — randomized scenarios always balance", () => {
  it("ledger sums to zero and settle-up clears it across 400 random trips", () => {
    let seed = 20261024;
    const seen = new Map<string, number>();
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const payouts = [[100], [70, 30], [50, 30, 20], [60, 25, 15], [34, 33, 33], [90, 10]];

    for (let trial = 0; trial < 400; trial++) {
      const nTeams = 2 + Math.floor(rand() * 3);
      const sizes = Array.from({ length: nTeams }, () => 2 + Math.floor(rand() * 3));
      const f = makeTrip({
        teams: sizes,
        settings: {
          team_match_ante_cents: pick([0, 100, 333, 1000, 2000, 2501]),
          contest_ante_cents: pick([0, 1, 250, 500, 777]),
          team_match_payout: pick(payouts),
        },
      });
      const letters = Object.keys(f.team);
      const players = Object.keys(f.player);
      const potKeys: PotKey[] = ["team_match", "contest:3", "contest:4", "contest:8", "contest:9", "contest:11", "contest:12", "contest:16", "contest:18"];
      const allOutOfTeamMatch = rand() < 0.08; // exercises the refund path
      for (const p of players) {
        for (const k of potKeys) if ((k === "team_match" && allOutOfTeamMatch) || rand() < 0.12) f.optOut(p, k);
      }

      // Progress: each team somewhere between not started and complete.
      const preRound = rand() < 0.1; // nobody has scored yet
      for (const t of letters) {
        const thru = preRound ? 0 : Math.floor(rand() * 19);
        for (let h = 1; h <= thru; h++) f.score(t, h, 2 + Math.floor(rand() * 5));
        if (thru === 18 && rand() < 0.7) {
          f.teeOff(t, 18);
          f.complete(t);
        } else if (thru > 0 || rand() < 0.5) {
          f.teeOff(t, Math.min(18, thru + 1));
        }
        // A few drinks so nets differ from gross.
        const nDrinks = Math.floor(rand() * 4);
        const members = players.filter((p) => p.startsWith(t));
        for (let i = 0; i < nDrinks && thru > 0; i++) f.drink(t, pick(members), 1 + Math.floor(rand() * thru));
      }
      // Random contest entries, some flagged/overridden, some ties.
      for (const h of [3, 4, 8, 9, 11, 12, 16, 18]) {
        const type = PAR[h] === 3 ? "ctp" : "ld";
        for (const p of players) {
          if (rand() > 0.3) continue;
          const distance_value = type === "ctp" ? pick([2, 3, 3.01, 5.5, 12, 40]) : pick([90, 250, 250.2, 280, 310, 420]);
          const status = pick(["ok", "ok", "ok", "flagged", "overridden"] as const);
          f.entry({ hole: h, player_id: f.player[p], type, distance_value, status, flag_reason: status === "flagged" ? "GPS was weak" : null });
        }
      }
      if (rand() < 0.5) setStatus(f, "final");

      const m = money(f);
      expectConsistent(m);
      expect(m.ledger).toHaveLength(players.length);
      // Winners of a tied/split pot never differ by more than a cent within one place group.
      for (const p of m.pots.filter((x) => x.type === "contest" && x.status === "won")) {
        const vals = Object.values(p.payouts);
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
      }
      for (const p of m.pots) seen.set(`${p.type}:${p.status}`, (seen.get(`${p.type}:${p.status}`) ?? 0) + 1);
      const d = derive(f.state);
      const tm = pot(m, "team_match");
      if (tm.status === "won" && d.standings.filter((r) => r.thru > 0 && r.pos === 1).length > 1) seen.set("team_tie", (seen.get("team_tie") ?? 0) + 1);
      if (m.pots.some((p) => p.type === "contest" && p.status === "won" && p.winners.length > 1)) seen.set("contest_tie", (seen.get("contest_tie") ?? 0) + 1);
    }
    // The generator really exercised every path.
    for (const k of ["team_match:won", "team_match:pending", "team_match:refunded", "contest:won", "contest:rolled", "contest:pending", "team_tie", "contest_tie"]) {
      expect(seen.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  });
});
