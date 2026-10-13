"use client";
// "⚠️ N" in the header: changes the server refused, kept (per trip, newest 20) until dismissed,
// so a rejection that landed while the phone was in a pocket isn't lost with its toast.
import { useState } from "react";
import { useClientState, useTripStore } from "@/lib/client/react";
import type { SyncIssue } from "@/lib/client/sync-issues";
import { BottomSheet, Button, useToast } from "@/components/ui";
import { rejectionToastId } from "./hooks";

const KIND: Array<[prefix: string, label: string]> = [
  ["score.", "Score"],
  ["teeshot.", "Tee shot"],
  ["tee.", "Hole"],
  ["round.", "Round"],
  ["drink.", "Drink"],
  ["mulligan.", "Mulligan"],
  ["contest.", "Contest"],
  ["post.", "Post"],
  ["feed.", "Feed"],
  ["reaction.", "Reaction"],
  ["photo", "Photo"],
  ["pot.", "Pots"],
];

/** Short label for an issue's op type ("drink.log" -> "Drink"). */
export function issueKind(opType: string): string {
  for (const [prefix, label] of KIND) if (opType.startsWith(prefix)) return label;
  return "Setup";
}

/** "Didn't save" count for the header chip, e.g. "⚠️ 2". */
export function syncIssuesChipText(count: number): string | null {
  return count > 0 ? `⚠️ ${count}` : null;
}

function timeOf(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** Header chip + sheet. Renders nothing while every change saved. */
export function SyncIssuesChip() {
  const issues = useClientState((s) => s.rejected);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const text = syncIssuesChipText(issues.length);
  const show = () => {
    // The list says it all: clear the toasts that repeat it.
    for (const r of issues) toast.dismiss(rejectionToastId(r.id));
    setOpen(true);
  };
  return (
    <>
      {text && (
        <button
          type="button"
          onClick={show}
          aria-label={`${issues.length} ${issues.length === 1 ? "change" : "changes"} didn't save`}
          data-testid="sync-issues-chip"
          className="btn h-12 min-w-12 shrink-0 rounded-full! border-ink bg-flag px-2.5 text-[15px] font-black text-white"
        >
          {text}
        </button>
      )}
      <SyncIssuesSheet open={open && issues.length > 0} issues={issues} onClose={() => setOpen(false)} />
    </>
  );
}

export function SyncIssuesSheet({ open, issues, onClose }: { open: boolean; issues: readonly SyncIssue[]; onClose: () => void }) {
  const store = useTripStore();
  const newestFirst = [...issues].reverse();
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Didn't save"
      footer={
        issues.length > 1 ? (
          <Button variant="secondary" full onClick={() => store.dismissRejected()} data-testid="sync-issues-dismiss-all">
            Dismiss all
          </Button>
        ) : undefined
      }
    >
      <p className="pb-3 text-[15px] font-semibold text-muted">
        The server refused these, so they&apos;re not on the scorecard. Redo them if they still matter.
      </p>
      <ul className="flex flex-col gap-2 pb-2" data-testid="sync-issues-list">
        {newestFirst.map((r) => (
          <li key={r.id} className="flex items-start gap-3 rounded-2xl border-2 border-line bg-paper py-3 pr-2 pl-4" data-testid="sync-issue">
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-black tracking-[0.12em] text-flag-dark uppercase">
                {issueKind(r.op_type)}
                {timeOf(r.at) && <span className="font-bold tracking-normal text-muted normal-case"> · {timeOf(r.at)}</span>}
              </div>
              <div className="text-[17px] leading-snug font-extrabold break-words text-ink">{r.description}</div>
              {r.reason && <div className="mt-0.5 text-[15px] leading-snug font-semibold break-words text-muted">{r.reason}</div>}
            </div>
            <button
              type="button"
              onClick={() => store.dismissRejected(r.id)}
              className="btn h-12 shrink-0 border-ink bg-paper px-3 text-sm font-black text-ink active:bg-sand"
              aria-label={`Dismiss: ${r.description}`}
            >
              Dismiss
            </button>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}
