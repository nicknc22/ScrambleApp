// Top of the Money tab: FINAL vs projected, total in play, my net.
import type { TripStatus } from "@/lib/types";
import { formatCents } from "@/lib/engine/format";
import { StatTile, cx } from "@/components/ui";
import { signedCents } from "./money";

export function MoneyBanner({
  status,
  totalCents,
  myNetCents,
}: {
  status: TripStatus;
  totalCents: number;
  /** null when I'm not in the ledger (no player picked / not on a team). */
  myNetCents: number | null;
}) {
  const final = status === "final";
  return (
    <section
      data-testid="money-banner"
      data-final={final || undefined}
      className={cx(
        "relative overflow-hidden rounded-3xl border-2 border-ink p-4 shadow-hard",
        final ? "bg-ink text-white" : "bg-hazard text-ink",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="shrink-0 text-[2.6rem] leading-none" aria-hidden="true">
          {final ? "🧾" : "💸"}
        </span>
        <h2 className={cx("loud min-w-0 text-[clamp(2.1rem,11vw,3.25rem)]", final ? "text-gold" : "text-ink")}>
          {final ? "FINAL" : "Projected"}
        </h2>
      </div>
      <p className="mt-2 text-base leading-snug font-bold">
        {final
          ? "The commissioner signed off. These numbers are real. Pay up."
          : status === "setup"
            ? "— final when the commissioner finalizes. Nothing's in play until the round starts."
            : "— final when the commissioner finalizes. Every shot and every beer moves money."}
      </p>
      <div className={cx("mt-3 grid gap-2", myNetCents === null ? "grid-cols-1" : "grid-cols-2")}>
        <StatTile
          label="Total in play"
          value={<span data-testid="money-total">{formatCents(totalCents)}</span>}
          tone="default"
          className={final ? "border-white" : "border-ink"}
        />
        {myNetCents !== null && (
          <StatTile
            label={final ? "You" : "You, if it ended now"}
            value={signedCents(myNetCents, formatCents)}
            tone={myNetCents > 0 ? "fairway" : myNetCents < 0 ? "flag" : "default"}
            className={myNetCents === 0 ? (final ? "border-white" : "border-ink") : ""}
          />
        )}
      </div>
    </section>
  );
}
