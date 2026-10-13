"use client";
// Commissioner live-round tools (rendered by Setup while the round is live/final): fix any score,
// drink or contest entry, move drinks between holes, fix a team's round state, and see
// drive-minimum misses. Every change goes through store.dispatch with as_commissioner where the op
// isn't commissioner-only by type; the server posts a "Commissioner override" to the feed.
import { useEffect, useRef, useState } from "react";
import { useClientState } from "@/lib/client/react";
import { Card, SectionHeader, cx } from "@/components/ui";
import { useHeaderHeight } from "../shared";
import { driveFlags, reviewQueue } from "./commishModel";
import { ContestsPanel } from "./ContestsPanel";
import { DrinksPanel } from "./DrinksPanel";
import { FlagsPanel } from "./FlagsPanel";
import { RoundsPanel } from "./RoundsPanel";
import { ScoresPanel } from "./ScoresPanel";

export type ToolTab = "scores" | "drinks" | "contests" | "rounds" | "flags";

/** Open a panel on a specific team / hole / entry (e.g. a Fix link in the finalize check). A new seq re-applies it. */
export interface ToolFocus {
  tab: ToolTab;
  teamId?: string;
  hole?: number;
  entryId?: string;
  seq: number;
}

const TABS: ReadonlyArray<{ value: ToolTab; label: string; emoji: string }> = [
  { value: "scores", label: "Scores", emoji: "🔢" },
  { value: "drinks", label: "Drinks", emoji: "🍺" },
  { value: "contests", label: "Entries", emoji: "📏" },
  { value: "rounds", label: "Rounds", emoji: "🛠️" },
  { value: "flags", label: "Drives", emoji: "🚗" },
];

export function CommissionerTools({ focus = null }: { focus?: ToolFocus | null }) {
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  const headerH = useHeaderHeight();
  const [tab, setTab] = useState<ToolTab>(focus?.tab ?? "scores");
  // The focus target applies to the panel it opened, until the commissioner picks another tab.
  const [target, setTarget] = useState<ToolFocus | null>(focus);
  const seq = focus?.seq ?? 0;
  const [appliedSeq, setAppliedSeq] = useState(seq);
  if (focus && seq !== appliedSeq) {
    setAppliedSeq(seq);
    setTab(focus.tab);
    setTarget(focus);
  }
  const at = (t: ToolTab) => (target?.tab === t ? target : null);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (seq === 0) return;
    try {
      sectionRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch {
      /* ignore */
    }
  }, [seq]);

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
  // Drinks that count (a drink logged after Round complete is listed, but isn't one).
  const drinks = Object.keys(derived.drinkValues).length;

  return (
    <section
      ref={sectionRef}
      className="space-y-4"
      data-testid="commish-tools"
      aria-label="Commissioner tools"
      style={{ scrollMarginTop: headerH + 80 }}
    >
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
              onClick={() => {
                setTab(t.value);
                setTarget(null);
              }}
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
        {/* Keyed by the focus seq: a new Fix link re-opens the panel on its target. */}
        {tab === "scores" && <ScoresPanel key={seq} focusTeamId={at("scores")?.teamId} focusHole={at("scores")?.hole} />}
        {tab === "drinks" && <DrinksPanel />}
        {tab === "contests" && <ContestsPanel key={seq} focusEntryId={at("contests")?.entryId} />}
        {tab === "rounds" && <RoundsPanel key={seq} focusTeamId={at("rounds")?.teamId} />}
        {tab === "flags" && <FlagsPanel />}
      </div>
    </section>
  );
}
