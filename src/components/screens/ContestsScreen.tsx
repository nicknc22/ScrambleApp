"use client";
// Contests tab: one card per contest hole (closest to pin on par 3s, long drive on par 5s) with
// the pot, the leader, every entry ranked (photo, status, AI judge), the green plot for closest
// to pin, and an entry button for holes my team has reached.
import { useCallback, useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import { Button, EmptyState, SectionHeader, cx } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";
import { useShellNav } from "@/components/shell/nav";
import { PhotoViewer } from "@/components/feed/PhotoViewer";
import { ContestCard } from "@/components/contests/ContestCard";
import { LongDriveSheet } from "@/components/contests/LongDriveSheet";
import { ClosestToPinSheet } from "@/components/contests/ClosestToPinSheet";
import { entryAccess } from "@/components/contests/flow";
import { CONTEST_EMOJI, contestCounts, entryOf } from "@/components/contests/model";
import type { ContestKind } from "@/lib/types";

export function ContestsScreen() {
  const store = useTripStore();
  const derived = useClientState((s) => s.derived);
  const view = useClientState((s) => s.view);
  const meId = useClientState((s) => s.meId);
  const isCommissioner = useClientState((s) => s.isCommissioner);
  // Re-render when a queued photo finishes uploading (photoUrl switches from blob: to remote).
  useClientState((s) => s.pendingCount);
  const nav = useShellNav();
  const [sheet, setSheet] = useState<{ type: ContestKind; hole: number } | null>(null);
  const [viewer, setViewer] = useState<{ src: string; caption: string } | null>(null);
  const closeViewer = useCallback(() => setViewer(null), []);

  if (!derived || !view) return null;

  const myTeamId = meId ? (derived.teamOfPlayer[meId] ?? null) : null;
  const rs = myTeamId ? (view.team_round_state.find((r) => r.team_id === myTeamId) ?? null) : null;
  const myHole = rs && rs.status === "playing" ? rs.open_hole : null;
  const counts = contestCounts(derived.contests);
  const photoUrl = (path: string | null) => store.photoUrl(path);

  const jump = (hole: number) => {
    try {
      document.getElementById(`contest-${hole}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      /* ignore */
    }
  };

  return (
    <Screen>
      <SectionHeader
        title="Contests"
        subtitle="Closest to pin on the par 3s, long drive on the par 5s. Every group, one board."
        action={
          isCommissioner && counts.review + counts.sus > 0 ? (
            <Button variant="hazard" className="px-3 text-sm" onClick={() => nav.setTab("setup")} data-testid="contest-review-link">
              ⚖️ Review {counts.review + counts.sus}
            </Button>
          ) : undefined
        }
      />

      {derived.contests.length === 0 ? (
        <EmptyState emoji="🎯" title="No contest holes">
          No par 3s or par 5s on this course? Who designed it, a committee?
        </EmptyState>
      ) : (
        <>
          <nav aria-label="Jump to a contest hole" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
            {derived.contests.map((c) => {
              const here = myHole === c.hole;
              return (
                <button
                  key={c.hole}
                  type="button"
                  onClick={() => jump(c.hole)}
                  className={cx(
                    "flex h-12 min-w-14 shrink-0 items-center justify-center gap-1 rounded-full border-2 px-3 text-base font-black",
                    here ? "border-ink bg-hazard text-ink" : c.leader_ids.length > 0 ? "border-ink bg-paper text-ink" : "border-line bg-sand text-muted",
                  )}
                  aria-label={`Hole ${c.hole}, ${c.type === "ctp" ? "closest to pin" : "long drive"}${here ? ", your group is here" : ""}`}
                >
                  <span aria-hidden="true">{CONTEST_EMOJI[c.type]}</span>
                  <span className="num">{c.hole}</span>
                </button>
              );
            })}
          </nav>

          <ul className="space-y-4">
            {derived.contests.map((c) => {
              const access = entryAccess({ type: c.type, hole: c.hole, tripStatus: view.trip.status, rs, onTeam: myTeamId !== null });
              return (
                <li key={c.hole}>
                  <ContestCard
                    summary={c}
                    derived={derived}
                    pots={derived.money.pots}
                    meId={meId}
                    access={access}
                    myEntry={entryOf(c, meId)}
                    photoUrl={photoUrl}
                    current={myHole === c.hole}
                    onEnter={() => setSheet({ type: c.type, hole: c.hole })}
                    onOpenPhoto={(src, caption) => setViewer({ src, caption })}
                  />
                </li>
              );
            })}
          </ul>
          <p className="pb-2 text-[13px] leading-snug font-semibold text-muted">
            Long drives are GPS-measured from each hole&apos;s tee point; under {view.trip.settings.ld_min_yd} or over {view.trip.settings.ld_max_yd} yd,
            or weak GPS, goes to the commissioner. The AI judge roasts closest-to-pin photos but never decides: only the commish can change a distance.
          </p>
        </>
      )}

      <LongDriveSheet open={sheet?.type === "ld"} onClose={() => setSheet(null)} hole={sheet?.hole ?? 0} />
      <ClosestToPinSheet open={sheet?.type === "ctp"} onClose={() => setSheet(null)} hole={sheet?.hole ?? 0} />
      <PhotoViewer src={viewer?.src ?? null} caption={viewer?.caption} onClose={closeViewer} />
    </Screen>
  );
}
