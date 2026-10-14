"use client";
// Money tab: pots with live projected payouts, opt-outs, ledger and settle-up with Venmo links.
// Everything comes from derived.money (integer cents); the only write is pot.optout (MyPots).
// While live the answer people open it for ("what do I owe?") comes right after the banner:
// settle-up preview (my payments first), then pots, ledger and opt-outs. No antes at all: just
// the empty state (no "$0 in play" banner on top of "No money on the line").
import { useCallback } from "react";
import { useClientState } from "@/lib/client/react";
import { venmoNote } from "@/lib/venmo";
import { Button, EmptyState, SectionHeader, useToast } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { useShellNav } from "@/components/shell/nav";
import { copyText } from "@/components/money/clipboard";
import { LedgerList } from "@/components/money/Ledger";
import { MoneyBanner } from "@/components/money/MoneyBanner";
import { MyPots } from "@/components/money/MyPots";
import { ContestPotCard, TeamMatchCard } from "@/components/money/PotCards";
import { SettleUpList } from "@/components/money/SettleUp";
import { resultsChangedSinceFinal, totalAntes } from "@/components/money/money";

export function MoneyScreen() {
  const derived = useClientState((s) => s.derived);
  const trip = useClientState((s) => s.view?.trip ?? null);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  // A results_changed post after this finalize: the numbers below are new since the FINAL push.
  const changedAt = useClientState((s) => (s.view ? resultsChangedSinceFinal(s.view.trip, s.view.feed_events) : null));
  const toast = useToast();
  const nav = useShellNav();

  const onCopy = useCallback(
    (text: string, what: string) => {
      void copyText(text).then((ok) => {
        if (ok) toast.success(`Copied ${what}: ${text}`, { emoji: "📋", id: "money-copy" });
        else toast.error(`Couldn't reach the clipboard. It's ${text}.`, { title: "Copy failed", id: "money-copy" });
      });
    },
    [toast],
  );

  if (!derived || !trip) return null;
  const money = derived.money;
  const status = trip.status;
  const final = status === "final";
  const teamMatch = money.pots.find((p) => p.type === "team_match");
  const contestPots = money.pots.filter((p) => p.type === "contest");
  const contestByHole = new Map(derived.contests.map((c) => [c.hole, c]));
  const total = final ? money.total_in_play_cents : totalAntes(money.pots);
  const myRow = meId ? money.ledger.find((r) => r.player_id === meId) : undefined;
  const noMoney = money.pots.every((p) => p.ante_cents <= 0 && p.total_cents <= 0);
  const showLedger = status !== "setup" && money.ledger.length > 0;
  const note = venmoNote(trip.app_name, trip.name);
  const seeMine = () => {
    try {
      // The whole section (scroll-mt clears the sticky header), found by its heading's id.
      const el = document.getElementById("money-settle");
      (el?.closest("section") ?? el)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      /* ignore */
    }
  };

  const banner = (
    <MoneyBanner
      status={status}
      totalCents={total}
      myNetCents={status === "setup" || !myRow ? null : myRow.net_cents}
      changedAt={changedAt}
      onSeeFeed={() => nav.setTab("feed")}
      onSeeMine={status === "live" ? seeMine : undefined}
    />
  );

  if (noMoney) {
    return (
      <Screen>
        <EmptyState
          emoji="🐔"
          title="No money on the line"
          action={
            isCommissioner ? (
              <Button variant="primary" full onClick={() => nav.setTab("setup")}>
                Set antes in Setup
              </Button>
            ) : undefined
          }
        >
          The commissioner hasn&apos;t set any antes. Playing for pride, apparently. How quaint.
        </EmptyState>
      </Screen>
    );
  }

  const pots = (
    <section className="space-y-2.5" aria-labelledby="money-pots">
      <SectionHeader
        title={<span id="money-pots">The pots</span>}
        subtitle={final ? "Who took what." : "Live projection. Changes with every shot and every beer."}
      />
      {teamMatch && (
        <TeamMatchCard pot={teamMatch} final={final} payout={trip.settings?.team_match_payout ?? [100]} people={derived} meId={meId} />
      )}
      {contestPots.length > 0 && (
        <>
          <p className="px-1 pt-1 text-sm leading-snug font-bold text-muted">
            Contest holes: no valid entry rolls the pot to the next hole of the same type, then into the team match.
          </p>
          <ul className="space-y-2.5">
            {contestPots.map((p) => (
              <li key={p.key}>
                <ContestPotCard
                  pot={p}
                  final={final}
                  contest={contestByHole.get(p.hole ?? -1)}
                  people={derived}
                  meId={meId}
                  quiet={status === "setup"}
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );

  const ledger = showLedger && (
    <section className="space-y-2.5" aria-labelledby="money-ledger">
      <SectionHeader
        title={<span id="money-ledger">Ledger</span>}
        subtitle={final ? "Antes in, winnings out. Nets sum to zero." : "Only pots with a result count so far."}
      />
      <LedgerList ledger={money.ledger} people={derived} meId={meId} final={final} />
    </section>
  );

  const settle = status !== "setup" && (
    <section className="scroll-mt-20 space-y-2.5" aria-labelledby="money-settle">
      <SectionHeader
        title={<span id="money-settle">{final ? "Settle up" : "Settle-up preview"}</span>}
        subtitle={
          final
            ? "Fewest payments possible. You confirm each payment inside Venmo; this app never touches money."
            : "If it ended now. Don't pay yet: Venmo buttons unlock when the commissioner finalizes."
        }
      />
      {money.payments.length === 0 ? (
        <p className="rounded-2xl border-2 border-line bg-sand px-4 py-3 text-base font-bold">
          {final ? "Nobody owes anybody. Deeply suspicious." : "Nobody owes anybody yet."}
        </p>
      ) : (
        <SettleUpList payments={money.payments} people={derived} meId={meId} final={final} note={note} onCopy={onCopy} />
      )}
    </section>
  );

  const myPots = (
    <section className="space-y-2.5" aria-labelledby="money-mine">
      <SectionHeader title={<span id="money-mine">Your pots</span>} />
      <MyPots pots={money.pots} />
    </section>
  );

  return (
    <Screen className="space-y-6">
      {banner}
      {status === "setup" && (
        <>
          {myPots}
          {pots}
        </>
      )}
      {status === "live" && (
        <>
          {settle}
          {pots}
          {ledger}
          {myPots}
        </>
      )}
      {final && (
        <>
          {settle}
          {ledger}
          {pots}
          {myPots}
        </>
      )}
    </Screen>
  );
}
