"use client";
// Commissioner live-round tools (rendered by Setup while the round is live/final): fix any score,
// drink or contest entry, move drinks between holes, fix a team's round state, and see
// drive-minimum misses. Every change goes through store.dispatch with as_commissioner where the op
// isn't commissioner-only by type; the server posts a "Commissioner override" to the feed.
import { useState } from "react";
import { useClientState } from "@/lib/client/react";
import { Card, SectionHeader, cx } from "@/components/ui";
import { driveFlags, reviewQueue } from "./commishModel";
import { ContestsPanel } from "./ContestsPanel";
import { DrinksPanel } from "./DrinksPanel";
import { FlagsPanel } from "./FlagsPanel";
import { RoundsPanel } from "./RoundsPanel";
import { ScoresPanel } from "./ScoresPanel";

type ToolTab = "scores" | "drinks" | "contests" | "rounds" | "flags";

const TABS: ReadonlyArray<{ value: ToolTab; label: string; emoji: string }> = [
  { value: "scores", label: "Scores", emoji: "🔢" },
  { value: "drinks", label: "Drinks", emoji: "🍺" },
  { value: "contests", label: "Entries", emoji: "📏" },
  { value: "rounds", label: "Rounds", emoji: "🛠️" },
  { value: "flags", label: "Drives", emoji: "🚗" },
];

export function CommissionerTools() {
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const [tab, setTab] = useState<ToolTab>("scores");

  if (!view || !derived) return null;
  if (!isCommissioner) {
    return (
      <Card tone="hazard" className="font-bold">
        Commissioner tools are locked. Unlock with the PIN in Settings.
      </Card>
    );
  }
  if (view.trip.status === "setup") {
    return (
      <Card tone="sand" className="font-bold" data-testid="commish-tools-waiting">
        Commissioner tools show up once the round starts. Nothing to fix yet. Give them time.
      </Card>
    );
  }

  const queue = reviewQueue(derived.contests).length;
  const misses = driveFlags(derived).filter((f) => f.kind === "missed").length;
  const drinks = view.drinks.filter((d) => d.deleted_at === null).length;

  return (
    <section className="space-y-4" data-testid="commish-tools" aria-label="Commissioner tools">
      <SectionHeader title="Commissioner tools" subtitle="Fix anything. Everyone sees it." />
      <div className="rounded-2xl border-2 border-ink bg-ink px-4 py-3 text-white">
        <p className="loud text-[clamp(1.3rem,6.4vw,1.5rem)]">⚖️ Transparency mode</p>
        <p className="mt-1 text-[15px] font-semibold text-white/90">
          Every fix posts a <span className="font-black text-hazard">Commissioner override</span> to the feed. The commissioner is also
          the groom, and he&apos;s playing. Nobody trusts him.
        </p>
      </div>
      <div role="tablist" aria-label="Commissioner tools" className="grid grid-cols-5 gap-1.5">
        {TABS.map((t) => {
          const badge = t.value === "drinks" ? drinks : t.value === "contests" ? queue : t.value === "flags" ? misses : 0;
          const active = tab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={badge > 0 ? `${t.label} (${badge})` : t.label}
              onClick={() => setTab(t.value)}
              className={cx(
                "relative flex min-h-[60px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-0.5 transition-transform active:scale-[0.96]",
                active ? "border-ink bg-ink text-white shadow-hard-sm" : "border-ink bg-paper text-ink",
              )}
            >
              <span className="text-xl leading-none" aria-hidden="true">
                {t.emoji}
              </span>
              <span className="text-[11px] leading-none font-black tracking-tight uppercase">{t.label}</span>
              {badge > 0 && (
                <span
                  className={cx(
                    "num absolute -top-2 -right-1 min-w-5 rounded-full border-2 border-ink px-1 text-center text-[11px] leading-4 font-black",
                    t.value === "drinks" ? "bg-beer text-ink" : "bg-flag text-white",
                  )}
                  aria-hidden="true"
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={tab}>
        {tab === "scores" && <ScoresPanel />}
        {tab === "drinks" && <DrinksPanel />}
        {tab === "contests" && <ContestsPanel />}
        {tab === "rounds" && <RoundsPanel />}
        {tab === "flags" && <FlagsPanel />}
      </div>
    </section>
  );
}
