// What finalizing would lock in that still looks wrong: teams still out there, holes a team
// played past with no score (they play as even par), and contest rulings that can move a pot.
// Each row links to the Commissioner Tools panel that fixes it. Presentational (server-renderable).
import type { ReactNode } from "react";
import type { Player, UUID } from "@/lib/types";
import { displayName } from "@/components/ui/PlayerName";
import { formatDistance, type ReviewItem } from "./commish/commishModel";
import { holesLabel, type ScoreGap, type UnfinishedTeam } from "./model";

export interface FinalizeIssues {
  unfinished: UnfinishedTeam[];
  gaps: ScoreGap[];
  rulings: ReviewItem[];
}

export type FinalizeFix =
  | { kind: "round"; teamId: UUID }
  | { kind: "score"; teamId: UUID; hole: number }
  | { kind: "entry"; entryId: UUID };

export function finalizeIssueCount(i: FinalizeIssues): number {
  return i.unfinished.length + i.gaps.length + i.rulings.length;
}

const KIND = { ctp: "closest to pin", ld: "long drive" } as const;

export function FinalizeSummary({
  issues,
  playerById,
  onFix,
}: {
  issues: FinalizeIssues;
  playerById: Record<UUID, Player | undefined>;
  onFix: (fix: FinalizeFix) => void;
}) {
  const { unfinished, gaps, rulings } = issues;
  const clean = finalizeIssueCount(issues) === 0;
  return (
    <span className="block" data-testid="finalize-summary">
      Pots lock, settle-up goes official and Awards unlock.
      <span className="mt-1 block text-sm font-bold text-muted" data-testid="finalize-late-sync">
        Phones still offline can sync plays from the round for 12 hours. If that moves the results, everyone gets a Results changed post.
      </span>
      {clean && (
        <span className="mt-2 block text-base text-fairway-dark" data-testid="finalize-clean">
          Every team tapped Round complete, every hole has a score and no ruling is pending.
        </span>
      )}
      {unfinished.length > 0 && (
        <IssueBlock title="Still out there:">
          {unfinished.map((u) => (
            <IssueRow key={u.team.id} fixLabel={`Fix ${u.team.name}'s round`} onFix={() => onFix({ kind: "round", teamId: u.team.id })}>
              {u.team.name}: {u.label}
            </IssueRow>
          ))}
        </IssueBlock>
      )}
      {gaps.length > 0 && (
        <IssueBlock title="Missing scores:" note="A blank hole plays as even par, and its drinks don't count.">
          {gaps.map((g) => (
            <IssueRow
              key={g.team.id}
              fixLabel={`Enter ${g.team.name}'s hole ${g.holes[0]}`}
              onFix={() => onFix({ kind: "score", teamId: g.team.id, hole: g.holes[0] })}
              testId="finalize-gap"
            >
              {g.team.name}: no score on {holesLabel(g.holes)}
            </IssueRow>
          ))}
        </IssueBlock>
      )}
      {rulings.length > 0 && (
        <IssueBlock title="Needs your ruling:" note="Until you rule, a flagged entry doesn't count and the pot goes elsewhere.">
          {rulings.map((r) => {
            const who = displayName(playerById[r.view.player_id]);
            return (
              <IssueRow
                key={r.view.entry.id}
                fixLabel={`Rule on ${who}'s hole ${r.hole} entry`}
                onFix={() => onFix({ kind: "entry", entryId: r.view.entry.id })}
                testId="finalize-ruling"
              >
                Hole {r.hole} {KIND[r.view.type]} · {who} · {formatDistance(r.view.distance, r.view.unit)} · {r.reasons[0]}
              </IssueRow>
            );
          })}
        </IssueBlock>
      )}
      {!clean && (
        <span className="mt-3 block text-left text-[15px] font-bold text-muted">
          You can still finalize. Reopening fixes it later, but people may have paid by then.
        </span>
      )}
    </span>
  );
}

function IssueBlock({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <span className="mt-3 block text-left text-base">
      <span className="block font-black text-flag">{title}</span>
      {note && <span className="block text-sm font-bold text-muted">{note}</span>}
      <span className="mt-1 block space-y-1">{children}</span>
    </span>
  );
}

function IssueRow({ children, fixLabel, onFix, testId }: { children: ReactNode; fixLabel: string; onFix: () => void; testId?: string }) {
  return (
    <span className="flex items-center gap-2" data-testid={testId}>
      <span className="min-w-0 flex-1 leading-snug [overflow-wrap:anywhere]">• {children}</span>
      <button
        type="button"
        onClick={onFix}
        aria-label={fixLabel}
        className="btn min-h-12 shrink-0 border-ink bg-paper px-3 text-[15px] text-ink active:bg-sand"
      >
        Fix
      </button>
    </span>
  );
}
