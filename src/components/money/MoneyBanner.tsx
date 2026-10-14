// Top of the Money tab: FINAL vs projected, total in play, my net (while live, a button down to the
// settle-up preview). When the results changed after the finalize (results_changed in the feed),
// it says so up top: people may already have paid.
import type { ISODate, TripStatus } from "@/lib/types";
import { formatCents } from "@/lib/engine/format";
import { StatTile, cx } from "@/components/ui";
import { signedCents } from "./money";

function clockTime(iso: ISODate): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function MoneyBanner({
  status,
  totalCents,
  myNetCents,
  changedAt = null,
  onSeeFeed,
  onSeeMine,
}: {
  status: TripStatus;
  totalCents: number;
  /** null when I'm not in the ledger (no player picked / not on a team). */
  myNetCents: number | null;
  /** The results changed after the finalize (newest results_changed post), else null. */
  changedAt?: ISODate | null;
  onSeeFeed?: () => void;
  /** While live: the "You, if it ended now" tile becomes a button that jumps to who you'd pay. */
  onSeeMine?: () => void;
}) {
  const final = status === "final";
  const changed = final && changedAt !== null;
  const at = changed ? clockTime(changedAt) : "";
  const seeMine = !final && onSeeMine ? onSeeMine : null;
  const mineValue = myNetCents === null ? "" : signedCents(myNetCents, formatCents);
  const mineTile =
    myNetCents === null ? null : (
      <StatTile
        label={final ? "You" : "You, if it ended now"}
        value={mineValue}
        sub={seeMine ? <span aria-hidden="true">{myNetCents > 0 ? "Who pays you ↓" : myNetCents < 0 ? "Who you'd pay ↓" : "Settle-up ↓"}</span> : undefined}
        tone={myNetCents > 0 ? "fairway" : myNetCents < 0 ? "flag" : "default"}
        className={cx(myNetCents === 0 && (final ? "border-white" : "border-ink"), seeMine && "h-full")}
      />
    );
  const mine =
    mineTile && seeMine ? (
      <button
        type="button"
        onClick={seeMine}
        className="block min-h-12 min-w-0 rounded-2xl text-left active:scale-[0.98]"
        aria-label={`You, if it ended now: ${mineValue}. Jump to the settle-up preview.`}
        data-testid="money-see-mine"
      >
        {mineTile}
      </button>
    ) : (
      mineTile
    );
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
      {changed && (
        <div className="mt-3 rounded-2xl border-2 border-white bg-flag px-3 py-2.5 text-white" role="alert" data-testid="money-results-changed">
          <p className="text-lg leading-tight font-black">🚨 Results changed after the final whistle — see the feed</p>
          <p className="mt-1 text-sm leading-snug font-bold">
            {at ? `Changed at ${at}. ` : ""}Already paid off the old numbers? Settle the difference.
          </p>
          {onSeeFeed && (
            <button type="button" onClick={onSeeFeed} className="btn mt-2 min-h-12 w-full border-ink bg-paper text-base font-black text-ink active:bg-sand">
              See what changed
            </button>
          )}
        </div>
      )}
      <p className="mt-2 text-base leading-snug font-bold">
        {changed
          ? "These are the new numbers, changed after the commissioner signed off. Check the feed before you Venmo."
          : final
            ? "The commissioner signed off. These numbers are real. Pay up."
            : status === "setup"
              ? "Nothing's in play until the round starts."
              : "Final when the commissioner signs off. Every shot and every beer moves it."}
      </p>
      <div className={cx("mt-3 grid gap-2", myNetCents === null ? "grid-cols-1" : "grid-cols-2")}>
        <StatTile
          label="Total in play"
          value={<span data-testid="money-total">{formatCents(totalCents)}</span>}
          tone="default"
          className={final ? "border-white" : "border-ink"}
        />
        {mine}
      </div>
    </section>
  );
}
