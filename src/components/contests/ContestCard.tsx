"use client";
// One contest hole on the Contests tab: type, hole, pot, leader, the green plot (closest to pin),
// every entry ranked with its photo, status and AI verdict, and the entry button for my team.
import { useState } from "react";
import type { ContestHoleSummary, ContestEntryView, Derived, PotView } from "@/lib/engine/types";
import type { UUID } from "@/lib/types";
import { Badge, Button, Card, PlayerName, TeamPill, cx } from "@/components/ui";
import { GreenPlot } from "./GreenPlot";
import {
  CONTEST_EMOJI,
  CONTEST_LABEL,
  aiVerdict,
  entryBadges,
  entryNote,
  formatContestDistance,
  leaderLine,
  plotEntries,
  potInfo,
  potWinnerLine,
} from "./model";
import type { EntryAccess } from "./flow";

export function ContestCard({
  summary,
  derived,
  pots,
  meId,
  access,
  myEntry,
  photoUrl,
  onEnter,
  onOpenPhoto,
  current,
}: {
  summary: ContestHoleSummary;
  derived: Derived;
  pots: readonly PotView[];
  meId: UUID | null;
  access: EntryAccess;
  myEntry: ContestEntryView | null;
  photoUrl: (path: string | null) => string | null;
  onEnter: () => void;
  onOpenPhoto: (src: string, caption: string) => void;
  /** My group is on this hole right now. */
  current: boolean;
}) {
  const ctp = summary.type === "ctp";
  const pot = potInfo(pots, summary.hole);
  const leader = leaderLine(summary, derived);
  const potWinner = potWinnerLine(summary, pots, derived);
  const hasEntries = summary.entries.length > 0;
  const enterLabel = ctp ? (myEntry ? "Edit my closest to pin" : "Enter closest to pin") : myEntry ? "Re-measure my drive" : "Measure drive";

  return (
    <Card
      id={`contest-${summary.hole}`}
      padded={false}
      className={cx("scroll-mt-20 overflow-hidden", current ? "border-ink shadow-hard" : "border-line")}
      data-testid="contest-card"
      data-hole={summary.hole}
      data-type={summary.type}
    >
      <header className={cx("flex items-center gap-3 px-3 py-3", ctp ? "bg-fairway-soft" : "bg-sky-soft")}>
        <div
          className={cx(
            "flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl border-2 border-ink leading-none text-white",
            ctp ? "bg-fairway" : "bg-sky",
          )}
        >
          <span className="text-[10px] font-black tracking-wide uppercase">Hole</span>
          <span className="num text-[26px] font-black">{summary.hole}</span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ctp ? "fairway" : "sky"}>
              {CONTEST_EMOJI[summary.type]} {CONTEST_LABEL[summary.type]}
            </Badge>
            {current && <Badge tone="hazard">You&apos;re here</Badge>}
            {summary.closed && <Badge tone="ink">Closed</Badge>}
          </p>
          <p className="mt-1 text-[15px] leading-tight font-bold text-muted">
            {ctp ? "Smallest distance wins. Ties split." : "Longest in the fairway wins."}
          </p>
        </div>
        <div className="shrink-0 text-right" data-testid="contest-pot">
          {pot.amount ? (
            <>
              <p className="text-[10px] font-black tracking-widest text-muted uppercase">Pot</p>
              <p className="num text-2xl leading-none font-black">{pot.amount}</p>
            </>
          ) : (
            <p className="text-xs font-bold text-muted">No pot</p>
          )}
        </div>
      </header>

      <div className="space-y-3 px-3 pt-3 pb-3">
        {pot.note && <p className="text-sm font-bold text-muted">💸 {pot.note}</p>}

        {hasEntries ? (
          <div
            className={cx("flex items-center gap-2 rounded-2xl border-2 px-3 py-2.5", leader ? "border-ink bg-hazard" : "border-line bg-sand")}
            data-testid="contest-leader"
          >
            <span className="text-2xl leading-none" aria-hidden="true">
              {leader ? "👑" : "⚖️"}
            </span>
            <p className="min-w-0 text-[17px] leading-tight font-black">
              {leader ? (
                <>
                  <span className="sr-only">Leader: </span>
                  {leader}
                  {summary.leader_ids.length > 1 && <span className="ml-1 text-flag">TIED</span>}
                </>
              ) : (
                "No valid entries yet. The commish has homework."
              )}
            </p>
          </div>
        ) : (
          <p className="text-[15px] font-bold text-muted" data-testid="contest-leader">
            <span aria-hidden="true">🦗 </span>No entries yet. The pot&apos;s just sitting there.
          </p>
        )}

        {potWinner && (
          <p className="rounded-xl border-2 border-ink bg-fairway-soft px-3 py-2 text-[15px] leading-snug font-black" data-testid="contest-pot-winner">
            <span aria-hidden="true">💰 </span>
            {potWinner}
          </p>
        )}

        {ctp && hasEntries && <GreenPlot hole={summary.hole} entries={plotEntries(summary, derived, { meId })} />}

        {hasEntries && (
          <ol className="divide-y-2 divide-line overflow-hidden rounded-2xl border-2 border-line" aria-label={`Hole ${summary.hole} entries`}>
            {summary.entries.map((v) => (
              <EntryRow key={v.entry.id} v={v} derived={derived} meId={meId} photoUrl={photoUrl} onOpenPhoto={onOpenPhoto} hole={summary.hole} />
            ))}
          </ol>
        )}

        {access.can ? (
          <Button
            variant={ctp ? "primary" : "hazard"}
            size="lg"
            full
            onClick={onEnter}
            leading={<span aria-hidden="true">{ctp ? "🎯" : "📏"}</span>}
            data-testid="contest-enter"
          >
            {enterLabel}
          </Button>
        ) : (
          access.reason && <p className="rounded-xl bg-sand px-3 py-2 text-[15px] font-bold text-muted">{access.reason}</p>
        )}
      </div>
    </Card>
  );
}

function EntryRow({
  v,
  derived,
  meId,
  photoUrl,
  onOpenPhoto,
  hole,
}: {
  v: ContestEntryView;
  derived: Derived;
  meId: UUID | null;
  photoUrl: (path: string | null) => string | null;
  onOpenPhoto: (src: string, caption: string) => void;
  hole: number;
}) {
  const player = derived.playerById[v.player_id];
  const team = derived.teamById[v.team_id];
  const badges = entryBadges(v);
  const note = entryNote(v);
  const ai = v.type === "ctp" ? aiVerdict(v.entry) : null;
  const src = photoUrl(v.entry.photo_path);
  const dist = formatContestDistance(v.type, v.distance);
  const mine = v.player_id === meId;
  const caption = `${player ? player.nickname?.trim() || player.name : "Somebody"} · ${dist} · hole ${hole}`;

  return (
    <li
      className={cx("px-2.5 py-2.5", mine ? "bg-hazard-soft" : "bg-paper", !v.valid && "bg-sand")}
      data-testid="contest-entry"
      data-player-id={v.player_id}
      data-valid={v.valid}
      data-rank={v.rank ?? ""}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={cx(
            "num flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-base font-black",
            v.rank === 1 ? "border-ink bg-gold text-ink" : v.valid ? "border-ink bg-paper text-ink" : "border-line-strong bg-sand text-muted",
          )}
          aria-label={v.rank ? `Rank ${v.rank}` : "Not ranked"}
        >
          {v.rank ?? "–"}
        </span>
        <Thumb key={src ?? "none"} src={src} caption={caption} onOpenPhoto={onOpenPhoto} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] leading-tight font-black">
            <PlayerName player={player} you={mine} />
          </p>
          <div className="mt-1 flex min-w-0">
            <TeamPill team={team} size="sm" />
          </div>
        </div>
        <span
          className={cx("num shrink-0 text-right text-2xl leading-none font-black", !v.valid && "text-muted line-through decoration-2")}
          data-testid="contest-distance"
        >
          {dist}
        </span>
      </div>
      {badges.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-[6.25rem]">
          {badges.map((b) => (
            <Badge key={b.key} tone={b.tone}>
              {b.label}
            </Badge>
          ))}
        </div>
      )}
      {note && <p className="mt-1 pl-[6.25rem] text-sm leading-snug font-bold text-flag-dark">{note}</p>}
      {ai && (
        <div className={cx("mt-2 rounded-xl border-2 px-2.5 py-2", ai.suspicious ? "border-flag bg-flag-soft" : "border-line bg-sand")} data-testid="contest-ai">
          <p className="text-[13px] font-black tracking-wide uppercase">
            🤖 AI judge{ai.estimate ? `: ${ai.estimate}` : ""} {ai.suspicious && <span className="text-flag">🚩 Suspicious</span>}
          </p>
          {ai.roast && <p className="mt-0.5 text-[15px] leading-snug font-semibold italic">&ldquo;{ai.roast}&rdquo;</p>}
        </div>
      )}
    </li>
  );
}

/** Entry photo thumbnail; falls back to a placeholder while a photo is still uploading elsewhere. */
function Thumb({ src, caption, onOpenPhoto }: { src: string | null; caption: string; onOpenPhoto: (src: string, caption: string) => void }) {
  const [failed, setFailed] = useState(false);
  const placeholder = "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-line-strong text-xl";
  if (!src) {
    return (
      <span className={placeholder} aria-label="No photo" title="No photo">
        📵
      </span>
    );
  }
  if (failed) {
    return (
      <button type="button" className={placeholder} aria-label="Photo still uploading. Tap to retry." onClick={() => setFailed(false)}>
        ⏫
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenPhoto(src, caption)}
      className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border-2 border-ink bg-sand"
      aria-label={`Photo of ${caption}`}
      data-testid="contest-photo"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- user photos from storage / local blobs */}
      <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
    </button>
  );
}
