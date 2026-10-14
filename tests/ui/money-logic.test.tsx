// Money tab: pure helpers + server-rendered presentational pieces (no DOM needed).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { derive } from "@/lib/engine";
import type { PotView } from "@/lib/engine/types";
import { JACK_FROST_HOLES } from "@/lib/course";
import { makeTrip, type TripFixture } from "../fixtures";
import {
  joinPotNames,
  ledgerNetSum,
  myPots,
  orderPayments,
  payoutRuleLabel,
  potShortName,
  potStatus,
  resultsChangedSinceFinal,
  signedCents,
  sittingOut,
  sortLedger,
  teamPayoutGroups,
  totalAntes,
} from "@/components/money/money";
import { ContestPotCard, TeamMatchCard, placeLabel } from "@/components/money/PotCards";
import { LedgerList, netClass } from "@/components/money/Ledger";
import { SettleUpList } from "@/components/money/SettleUp";
import { MoneyBanner } from "@/components/money/MoneyBanner";
import { copyText } from "@/components/money/clipboard";
import { formatCents } from "@/lib/engine/format";

/** A full 18-hole round for teams [4,3,3]: A shoots par-1 everywhere, B par, C par+1 on odd holes. */
function playedTrip(opts: { status?: "live" | "final"; payout?: number[] } = {}): TripFixture {
  const f = makeTrip({
    teams: [4, 3, 3],
    status: opts.status ?? "final",
    settings: { team_match_ante_cents: 2000, contest_ante_cents: 500, team_match_payout: opts.payout ?? [70, 30] },
  });
  for (const t of ["A", "B", "C"]) {
    for (const h of JACK_FROST_HOLES) {
      f.teeOff(t, h.number);
      const strokes = t === "A" ? h.par - 1 : t === "B" ? h.par : h.par + (h.number % 2);
      f.score(t, h.number, strokes);
    }
    f.complete(t);
  }
  f.entry({ hole: 3, player_id: f.player.B1, type: "ctp", distance_value: 6.5 });
  f.entry({ hole: 3, player_id: f.player.C2, type: "ctp", distance_value: 12 });
  f.entry({ hole: 4, player_id: f.player.A2, type: "ld", distance_value: 280 });
  f.optOut("C3", "contest:16");
  f.state.players = f.state.players.map((p) =>
    p.id === f.player.A1 ? { ...p, venmo_handle: "@Big-Nick", nickname: "Big Nick" } : p.id === f.player.B1 ? { ...p, venmo_handle: "Not A Handle" } : p,
  );
  return f;
}

describe("money helpers", () => {
  it("names pots and rollover sources", () => {
    expect(potShortName("team_match")).toBe("the team match");
    expect(potShortName("contest:8")).toBe("hole 8");
    expect(joinPotNames(["contest:3"])).toBe("hole 3");
    expect(joinPotNames(["contest:3", "contest:8"])).toBe("holes 3 & 8");
    expect(joinPotNames(["contest:3", "contest:8", "contest:11"])).toBe("holes 3, 8 & 11");
    expect(joinPotNames([])).toBe("");
  });

  it("describes the payout rule", () => {
    expect(payoutRuleLabel([100])).toBe("Winner takes all");
    expect(payoutRuleLabel([70, 30])).toBe("1st 70% · 2nd 30%");
    expect(payoutRuleLabel([50, 30, 20])).toBe("1st 50% · 2nd 30% · 3rd 20%");
    expect(payoutRuleLabel([])).toBe("Winner takes all");
  });

  it("labels pot status: projected vs final", () => {
    const pot = { status: "won", type: "contest" } as PotView;
    expect(potStatus(pot, false)).toEqual({ label: "Leading", tone: "sky" });
    expect(potStatus({ ...pot, type: "team_match" }, false)).toEqual({ label: "Projected", tone: "sky" });
    expect(potStatus(pot, true)).toEqual({ label: "Won", tone: "fairway" });
    expect(potStatus({ ...pot, status: "rolled" }, true).label).toBe("Rolled");
    expect(potStatus({ ...pot, status: "pending" }, false).label).toBe("Up for grabs");
    expect(potStatus({ ...pot, status: "refunded" }, true).label).toBe("Refunded");
  });

  it("orders payments: mine first (owe, then owed), stable otherwise", () => {
    const pays = [
      { from_player_id: "a", to_player_id: "b", amount_cents: 100 },
      { from_player_id: "c", to_player_id: "me", amount_cents: 200 },
      { from_player_id: "me", to_player_id: "d", amount_cents: 300 },
      { from_player_id: "e", to_player_id: "f", amount_cents: 400 },
    ];
    expect(orderPayments(pays, "me").map((p) => p.amount_cents)).toEqual([300, 200, 100, 400]);
    expect(orderPayments(pays, null).map((p) => p.amount_cents)).toEqual([100, 200, 300, 400]);
  });

  it("sorts the ledger by net, biggest winner first", () => {
    const rows = [
      { player_id: "a", antes_cents: 100, winnings_cents: 0, net_cents: -100 },
      { player_id: "b", antes_cents: 100, winnings_cents: 300, net_cents: 200 },
      { player_id: "c", antes_cents: 100, winnings_cents: 0, net_cents: -100 },
    ];
    expect(sortLedger(rows).map((r) => r.player_id)).toEqual(["b", "a", "c"]);
    expect(ledgerNetSum(rows)).toBe(0);
    expect(signedCents(1250, formatCents)).toBe("+$12.50");
    expect(signedCents(-500, formatCents)).toBe("-$5");
    expect(signedCents(0, formatCents)).toBe("$0");
    expect(netClass(1)).toBe("text-fairway-dark");
    expect(netClass(-1)).toBe("text-flag-dark");
    expect(placeLabel("T2")).toBe("T2nd");
    expect(placeLabel("1")).toBe("1st");
  });

  it("derives my pots from raw opt-out rows (works before teams exist)", () => {
    const f = makeTrip({ teams: [4, 3, 3], status: "setup", settings: { team_match_ante_cents: 2000, contest_ante_cents: 500 } });
    f.optOut("A2", "contest:3");
    const d = derive(f.state);
    const rows = myPots(f.state, d.money.pots, f.player.A2);
    expect(rows).toHaveLength(9); // team match + 8 contest holes at Jack Frost
    expect(rows[0]).toMatchObject({ key: "team_match", in: true, ante_cents: 2000, emoji: "🏆" });
    expect(rows.find((r) => r.key === "contest:3")).toMatchObject({ in: false, emoji: "🎯" });
    expect(rows.find((r) => r.key === "contest:4")).toMatchObject({ in: true, emoji: "💣" });
    // Somebody else is in everything.
    expect(myPots(f.state, d.money.pots, f.player.A1).every((r) => r.in)).toBe(true);
    // A deleted opt-out row means back in.
    f.state.pot_optouts = f.state.pot_optouts.map((o) => ({ ...o, deleted_at: "2026-10-24T00:00:00.000Z" }));
    expect(myPots(f.state, d.money.pots, f.player.A2).every((r) => r.in)).toBe(true);
    // Whole prize pool if every pot resolves: 10 x $20 + 8 holes x (10 players, one out of hole 3) x $5.
    expect(totalAntes(d.money.pots)).toBe(10 * 2000 + 8 * 10 * 500 - 500);
  });

  it("groups team-match payouts by team in standings order and lists who sat out", () => {
    const f = playedTrip();
    const d = derive(f.state);
    const tm = d.money.pots.find((p) => p.key === "team_match")!;
    const groups = teamPayoutGroups(tm, d.teamOfPlayer, d.standings);
    expect(groups.map((g) => g.team_id)).toEqual([f.team.A, f.team.B]);
    expect(groups[0].pos_label).toBe("1");
    expect(groups[0].members).toHaveLength(4);
    expect(groups.reduce((s, g) => s + g.total_cents, 0)).toBe(tm.total_cents);
    const hole16 = d.money.pots.find((p) => p.key === "contest:16")!;
    expect(sittingOut(hole16, d).map((p) => p.id)).toEqual([f.player.C3]);
    expect(sittingOut(tm, d)).toEqual([]);
  });
});

describe("money components (server-rendered)", () => {
  it("banner: FINAL vs projected, total and my net", () => {
    const fin = renderToStaticMarkup(<MoneyBanner status="final" totalCents={59000} myNetCents={-3037} />);
    expect(fin).toContain("FINAL");
    expect(fin).toContain("$590");
    expect(fin).toContain("-$30.37");
    const proj = renderToStaticMarkup(<MoneyBanner status="live" totalCents={1000} myNetCents={null} />);
    expect(proj).toContain("Projected");
    expect(proj).toContain("Final when the commissioner signs off.");
    expect(proj).not.toContain("Projected. ");
    expect(proj).not.toContain("— final");
    expect(proj).not.toContain("FINAL");
  });

  it("banner: results changed after the final whistle (finding: late-sync-rewrites-final-settleup)", () => {
    const finalizedAt = "2026-10-24T22:00:00.000Z";
    const ev = (type: string, created_at: string, deleted_at: string | null = null) => ({ type, created_at, deleted_at }) as never;
    const trip = { status: "final" as const, finalized_at: finalizedAt };
    // Nothing after the finalize: no banner.
    expect(resultsChangedSinceFinal(trip, [ev("final_results", finalizedAt), ev("results_changed", "2026-10-24T21:00:00.000Z")])).toBeNull();
    // A results_changed after it: the newest one's time; deleted ones don't count; only while final.
    const events = [
      ev("final_results", finalizedAt),
      ev("results_changed", "2026-10-24T22:01:00.000Z"),
      ev("results_changed", "2026-10-24T22:05:00.000Z"),
      ev("results_changed", "2026-10-24T22:09:00.000Z", "2026-10-24T22:10:00.000Z"),
    ];
    expect(resultsChangedSinceFinal(trip, events)).toBe("2026-10-24T22:05:00.000Z");
    expect(resultsChangedSinceFinal({ status: "live", finalized_at: finalizedAt }, events)).toBeNull();
    // Re-finalized after the change: the old notice is history.
    expect(resultsChangedSinceFinal({ status: "final", finalized_at: "2026-10-24T22:30:00.000Z" }, events)).toBeNull();

    const changed = renderToStaticMarkup(<MoneyBanner status="final" totalCents={59000} myNetCents={-3037} changedAt="2026-10-24T22:05:00.000Z" onSeeFeed={() => {}} />);
    expect(changed).toContain("Results changed after the final whistle — see the feed");
    expect(changed).toContain('data-testid="money-results-changed"');
    expect(changed).toContain("See what changed");
    expect(changed).not.toContain("These numbers are real. Pay up.");
    const plain = renderToStaticMarkup(<MoneyBanner status="final" totalCents={59000} myNetCents={-3037} changedAt={null} />);
    expect(plain).not.toContain("Results changed");
    expect(plain).toContain("These numbers are real. Pay up.");
    // Never while live (a projection can change all it wants).
    expect(renderToStaticMarkup(<MoneyBanner status="live" totalCents={1} myNetCents={null} changedAt="2026-10-24T22:05:00.000Z" />)).not.toContain("Results changed");
  });

  it("team match card shows the payout rule, places and per-member amounts", () => {
    const f = playedTrip();
    const d = derive(f.state);
    const tm = d.money.pots.find((p) => p.key === "team_match")!;
    const html = renderToStaticMarkup(<TeamMatchCard pot={tm} final payout={[70, 30]} people={d} meId={f.player.A1} />);
    expect(html).toContain("1st 70% · 2nd 30%");
    expect(html).toContain("Team A");
    expect(html).toContain("Team B");
    expect(html).toContain("1st");
    expect(html).toContain("2nd");
    expect(html).toContain("(you)");
    expect(html).toContain("Won");
  });

  it("contest card shows winner + distance, rollovers and sitting-out players", () => {
    const f = playedTrip();
    const d = derive(f.state);
    const byHole = new Map(d.contests.map((c) => [c.hole, c]));
    const pot3 = d.money.pots.find((p) => p.key === "contest:3")!;
    const html3 = renderToStaticMarkup(<ContestPotCard pot={pot3} final contest={byHole.get(3)} people={d} meId={null} />);
    expect(html3).toContain("Hole 3 · Closest to pin");
    expect(html3).toContain("Player B1");
    expect(html3).toContain(`6&#x27; 6&quot;`);
    expect(html3).toContain(formatCents(pot3.total_cents));

    // Hole 8 had no entries: rolled to hole 11, which shows the rollover in.
    const pot8 = d.money.pots.find((p) => p.key === "contest:8")!;
    expect(pot8.status).toBe("rolled");
    const html8 = renderToStaticMarkup(<ContestPotCard pot={pot8} final contest={byHole.get(8)} people={d} meId={null} />);
    expect(html8).toContain("Rolled");
    expect(html8).toContain("hole 11");
    const pot11 = d.money.pots.find((p) => p.key === "contest:11")!;
    const html11 = renderToStaticMarkup(<ContestPotCard pot={pot11} final contest={byHole.get(11)} people={d} meId={null} />);
    expect(html11).toContain("rolled from hole 8");

    const pot16 = d.money.pots.find((p) => p.key === "contest:16")!;
    const html16 = renderToStaticMarkup(<ContestPotCard pot={pot16} final contest={byHole.get(16)} people={d} meId={null} />);
    expect(html16).toContain("Sitting out: Player C3");
  });

  it("ledger: every player, sorted by net, me highlighted, sums to $0", () => {
    const f = playedTrip();
    const d = derive(f.state);
    const html = renderToStaticMarkup(<LedgerList ledger={d.money.ledger} people={d} meId={f.player.C1} final />);
    const nets = [...html.matchAll(/data-net-cents="(-?\d+)"/g)].map((m) => Number(m[1]));
    expect(nets).toHaveLength(10);
    expect(nets).toEqual([...nets].sort((a, b) => b - a));
    expect(nets.reduce((s, n) => s + n, 0)).toBe(0);
    expect(html).toContain('data-me="true"');
    expect(html).toContain('data-sum-cents="0"');
    expect(html).toContain("Books balance");
  });

  it("settle-up: Venmo deep links only when final and the payee has a usable handle", () => {
    const f = playedTrip();
    const d = derive(f.state);
    expect(d.money.payments.length).toBeGreaterThan(0);
    const toA1 = d.money.payments.find((p) => p.to_player_id === f.player.A1);
    expect(toA1).toBeDefined();
    const payer = toA1!.from_player_id;
    const note = "Scramble: Test Trip settle-up";
    const html = renderToStaticMarkup(
      <SettleUpList payments={d.money.payments} people={d} meId={payer} final note={note} onCopy={() => {}} />,
    );
    // My payment first, with the big button, copy buttons and the web fallback.
    const first = html.indexOf('data-testid="payment"');
    expect(html.slice(first, first + 200)).toContain('data-mine="pay"');
    expect(html).toContain("You owe");
    const amount = (toA1!.amount_cents / 100).toFixed(2);
    expect(html).toContain(`href="venmo://paycharge?txn=pay&amp;recipients=Big-Nick&amp;amount=${amount}&amp;note=Scramble%3A%20Test%20Trip%20settle-up"`);
    expect(html).toContain(`href="https://venmo.com/Big-Nick?txn=pay&amp;amount=${amount}`);
    expect(html).toContain("@Big-Nick");
    expect(html).toContain("Copy the amount");
    // Payees without a handle: amount + "ask for their Venmo".
    expect(html).toMatch(/Ask (for their Venmo|.* for their Venmo)/);

    const projected = renderToStaticMarkup(
      <SettleUpList payments={d.money.payments} people={d} meId={payer} final={false} note={note} onCopy={() => {}} />,
    );
    expect(projected).not.toContain("venmo://");
    expect(projected).toContain(formatCents(toA1!.amount_cents));
  });

  it("settle-up: a prefilled pay link only on payments I make; others' (and mine to receive) show the amount + copy handle", () => {
    // Findings money/venmo-links-on-others-debts, walkthrough/payee-sees-pay-yourself-venmo-link.
    const f = playedTrip();
    f.state.players = f.state.players.map((p) => ({ ...p, venmo_handle: `h-${p.id}` }));
    const d = derive(f.state);
    const note = "Scramble: Test Trip settle-up";
    const render = (meId: string | null) =>
      renderToStaticMarkup(<SettleUpList payments={d.money.payments} people={d} meId={meId} final note={note} onCopy={() => {}} />);
    const payLinks = (html: string) => [...html.matchAll(/href="(venmo:\/\/[^"]+|https:\/\/venmo\.com\/[^"]+)"/g)].map((m) => m[1]);
    expect(d.money.payments.length).toBeGreaterThan(1);

    // A payer: links only for their own payments, never to themselves.
    const payer = d.money.payments[0].from_player_id;
    const mine = d.money.payments.filter((p) => p.from_player_id === payer);
    const links = payLinks(render(payer));
    expect(links).toHaveLength(mine.length * 2); // app deep link + web fallback per payment
    for (const p of mine) expect(links.some((l) => l.includes(`recipients=h-${p.to_player_id}&amp;`))).toBe(true);
    expect(links.some((l) => l.includes(`h-${payer}`))).toBe(false);

    // A payee: no link that opens "pay yourself", just their handle to copy and send.
    const payee = d.money.payments[0].to_player_id;
    const asPayee = render(payee);
    expect(payLinks(asPayee)).toEqual([]);
    expect(asPayee).toContain(`aria-label="Copy your Venmo"`);
    expect(asPayee).toContain(`@h-${payee}`);

    // Somebody who owes nothing (or nobody picked): no one-tap way to pay another man's debt.
    const bystander = f.state.players.find((p) => !d.money.payments.some((x) => x.from_player_id === p.id))!.id;
    const asBystander = render(bystander);
    expect(payLinks(asBystander)).toEqual([]);
    expect(payLinks(render(null))).toEqual([]);
    // Each third-party card still shows its amount and a copy button for the payee's handle.
    const third = d.money.payments.find((p) => p.from_player_id !== bystander && p.to_player_id !== bystander)!;
    expect(asBystander).toContain(formatCents(third.amount_cents));
    expect(asBystander).toContain(`@h-${third.to_player_id}`);
    expect(asBystander).not.toContain('data-testid="venmo-pay"');
  });
});


describe("copyText", () => {
  it("uses the async clipboard when available", async () => {
    const written: string[] = [];
    const ok = await copyText("@nick 12.50", { navigator: { clipboard: { writeText: async (t) => void written.push(t) } }, document: null });
    expect(ok).toBe(true);
    expect(written).toEqual(["@nick 12.50"]);
  });

  it("falls back to a hidden textarea + execCommand when the clipboard API fails", async () => {
    const appended: { value: string; removed: boolean }[] = [];
    const fakeDoc = {
      body: {
        appendChild: (el: { value: string; removed: boolean }) => appended.push(el),
      },
      createElement: () => {
        const el = {
          value: "",
          removed: false,
          style: { cssText: "" },
          setAttribute: () => {},
          focus: () => {},
          select: () => {},
          setSelectionRange: () => {},
          remove: () => {
            el.removed = true;
          },
        };
        return el;
      },
      execCommand: (cmd: string) => cmd === "copy",
    } as unknown as Document;
    const ok = await copyText("12.50", {
      navigator: {
        clipboard: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      },
      document: fakeDoc,
    });
    expect(ok).toBe(true);
    expect(appended[0].value).toBe("12.50");
    expect(appended[0].removed).toBe(true);
  });

  it("reports failure instead of throwing when nothing works", async () => {
    expect(await copyText("x", { navigator: null, document: null })).toBe(false);
  });
});
