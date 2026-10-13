// Ledger: every player's antes, winnings and net, sorted by net, me highlighted.
import type { UUID } from "@/lib/types";
import type { Derived, LedgerRow } from "@/lib/engine/types";
import { formatCents } from "@/lib/engine/format";
import { Avatar, PlayerName, cx } from "@/components/ui";
import { ledgerNetSum, signedCents, sortLedger } from "./money";

export function netClass(cents: number): string {
  return cents > 0 ? "text-fairway-dark" : cents < 0 ? "text-flag-dark" : "text-muted";
}

export function LedgerList({
  ledger,
  people,
  meId,
  final,
}: {
  ledger: readonly LedgerRow[];
  people: Pick<Derived, "playerById" | "teamById" | "teamOfPlayer">;
  meId: UUID | null;
  final: boolean;
}) {
  const rows = sortLedger(ledger);
  const sum = ledgerNetSum(ledger);
  return (
    <div className="overflow-hidden rounded-2xl border-2 border-ink" data-testid="ledger">
      <div className="flex items-center gap-3 border-b-2 border-ink bg-ink px-3 py-2 text-[12px] font-black tracking-wide text-white uppercase">
        <span className="flex-1">Player · in / won</span>
        <span>{final ? "Net" : "Net if it ended now"}</span>
      </div>
      <ol className="divide-y-2 divide-line">
        {rows.map((r) => {
          const me = r.player_id === meId;
          const player = people.playerById[r.player_id];
          const team = people.teamById[people.teamOfPlayer[r.player_id]];
          return (
            <li
              key={r.player_id}
              data-testid="ledger-row"
              data-net-cents={r.net_cents}
              data-me={me || undefined}
              className={cx("flex min-h-16 items-center gap-3 px-3 py-2", me ? "bg-hazard-soft" : "bg-paper")}
            >
              <Avatar player={player} teamSortOrder={team ? team.sort_order : null} size="md" showCrown={false} />
              <div className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-lg font-black">
                  <PlayerName player={player} you={me} />
                </span>
                <span className="num block text-sm font-bold text-muted">
                  in {formatCents(r.antes_cents)} · won {formatCents(r.winnings_cents)}
                </span>
              </div>
              <span className={cx("num shrink-0 text-2xl font-black", netClass(r.net_cents))}>{signedCents(r.net_cents, formatCents)}</span>
            </li>
          );
        })}
      </ol>
      <div
        className={cx(
          "flex items-center justify-between gap-3 border-t-2 border-ink px-3 py-2 text-sm font-black",
          sum === 0 ? "bg-fairway-soft text-fairway-dark" : "bg-flag-soft text-flag-dark",
        )}
        data-testid="ledger-sum"
        data-sum-cents={sum}
      >
        <span>{sum === 0 ? "Books balance. Every dollar accounted for." : "Books don't balance. Tell the commissioner."}</span>
        <span className="num shrink-0">{signedCents(sum, formatCents)}</span>
      </div>
    </div>
  );
}
