"use client";
// Current leader for every contest hole (closest to pin on par 3s, long drive on par 5s).
import type { Player, UUID } from "@/lib/types";
import type { Derived } from "@/lib/engine/types";
import { Badge, Button, EmptyState, PlayerName, cx, teamColor } from "@/components/ui";
import { contestViews } from "./model";

export function ContestsBoard({ derived, meId, onOpenContests }: { derived: Derived; meId: UUID | null; onOpenContests?: () => void }) {
  const rows = contestViews(derived.contests);
  if (rows.length === 0) {
    return (
      <EmptyState emoji="📏" title="No contest holes">
        No par 3s or par 5s on this course? Who designed this, a committee?
      </EmptyState>
    );
  }
  return (
    <div className="space-y-2.5">
      <ul className="space-y-2.5" aria-label="Contest leaders">
        {rows.map((c) => {
          const leaders = c.leader_ids.map((id) => derived.playerById[id]).filter((p): p is Player => !!p);
          const myLead = meId !== null && c.leader_ids.includes(meId);
          return (
            <li
              key={c.hole}
              data-testid="contest-row"
              data-hole={c.hole}
              className={cx(
                "flex min-h-16 items-center gap-3 rounded-2xl border-2 px-3 py-2.5",
                c.state === "leader" ? "border-ink bg-paper" : "border-line bg-sand",
                myLead && "bg-hazard-soft",
              )}
            >
              <div
                className={cx(
                  "flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border-2 border-ink leading-none",
                  c.type === "ld" ? "bg-sky text-white" : "bg-fairway text-white",
                )}
              >
                <span className="text-[9px] font-black tracking-wide uppercase">Hole</span>
                <span className="num text-xl font-black">{c.hole}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] font-black tracking-wide text-muted uppercase">
                    {c.type === "ld" ? "🏌️ Long drive" : "🎯 Closest to pin"}
                  </span>
                  {c.suspicious && (
                    <Badge tone="flag" data-testid="contest-sus">
                      🤖 Sus
                    </Badge>
                  )}
                  {c.closed && <Badge tone="ink">Closed</Badge>}
                </div>
                {c.state === "leader" ? (
                  <p className="text-[17px] leading-tight font-extrabold">
                    {leaders.map((p, i) => {
                      const team = derived.teamById[derived.teamOfPlayer[p.id] ?? ""];
                      return (
                        <span key={p.id}>
                          {i > 0 && <span className="text-muted"> &amp; </span>}
                          <span
                            className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle"
                            style={{ backgroundColor: teamColor(team?.sort_order ?? null).bg }}
                            aria-hidden="true"
                          />
                          <PlayerName player={p} you={p.id === meId} />
                        </span>
                      );
                    })}
                    {leaders.length > 1 && <span className="ml-1 text-sm font-black text-flag">TIED</span>}
                  </p>
                ) : c.state === "no_valid" ? (
                  <p className="text-[15px] leading-tight font-bold text-muted">
                    No valid entries yet{c.pending_review > 0 ? ` · ${c.pending_review} waiting on the commish` : ""}
                  </p>
                ) : (
                  <p className="text-[15px] leading-tight font-bold text-muted">No entries yet</p>
                )}
                {c.state === "leader" && c.pending_review > 0 && (
                  <p className="text-[12px] font-bold text-muted">{c.pending_review} more waiting on commissioner review</p>
                )}
              </div>
              {c.entries > 0 && (
                <div className="shrink-0 text-right">
                  <span className={cx("num block font-black", c.state === "leader" ? "text-2xl" : "text-xl text-line-strong")} data-testid="contest-distance">
                    {c.distance}
                  </span>
                  <span className="text-[11px] font-bold text-muted">
                    {c.entries} {c.entries === 1 ? "entry" : "entries"}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {onOpenContests && (
        <Button variant="secondary" full onClick={onOpenContests} trailing={<span aria-hidden="true">→</span>}>
          Enter or check contests
        </Button>
      )}
    </div>
  );
}
