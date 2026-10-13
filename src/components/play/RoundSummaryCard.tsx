"use client";
// After "Round complete" (or once the trip is final): gross, credit, net, net to par, position.
import { Badge, StatTile } from "@/components/ui";
import type { RoundSummary } from "./model";

export function RoundSummaryCard({ summary, final, teamName }: { summary: RoundSummary; final: boolean; teamName: string }) {
  return (
    <section
      className="relative overflow-hidden rounded-3xl border-2 border-ink px-4 pt-4 pb-4 text-white shadow-hard"
      style={{ background: "radial-gradient(circle at 80% 0%, #3b3b3b 0%, #0b0f0c 60%)" }}
      data-testid="round-summary"
    >
      <div className="flex items-center gap-2">
        <Badge tone={final ? "gold" : "hazard"} size="md">
          {final ? "🏆 Final" : "🏁 Round complete"}
        </Badge>
        <span className="min-w-0 truncate text-sm font-black tracking-wide uppercase opacity-90">{teamName}</span>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <div className="text-xs font-black tracking-[0.25em] uppercase opacity-90">Net to par</div>
          <div className="loud num text-[5rem] leading-[0.85] text-hazard" data-testid="summary-net-to-par">
            {summary.netToPar}
          </div>
        </div>
        <div className="pb-1 text-right">
          <div className="text-xs font-black tracking-[0.25em] uppercase opacity-90">Position</div>
          <div className="loud num text-6xl leading-none">{summary.pos}</div>
        </div>
      </div>
      <p className="mt-3 text-lg leading-snug font-bold">{summary.verdict}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-ink">
        <StatTile label="Gross" value={summary.gross} />
        <StatTile label="Credit 🍺" value={`−${summary.credit}`} tone="beer" />
        <StatTile label="Net" value={summary.net} tone="fairway" />
      </div>
      <p className="mt-3 text-sm font-extrabold opacity-95">
        {summary.drinks} {summary.drinks === 1 ? "drink" : "drinks"}
        {summary.ghostBeers > 0 ? ` · ${summary.ghostBeers} ghost ${summary.ghostBeers === 1 ? "beer" : "beers"} 👻` : ""} · thru {summary.thru}
      </p>
      {summary.missing.length > 0 && (
        <p className="mt-3 rounded-xl border-2 border-ink bg-hazard px-3 py-2 text-[15px] font-black text-ink">
          ⚠️ No score on {summary.missing.length === 1 ? "hole" : "holes"} {summary.missing.join(", ")}. Tap {summary.missing.length === 1 ? "it" : "them"} on the scorecard to fix.
        </p>
      )}
    </section>
  );
}
