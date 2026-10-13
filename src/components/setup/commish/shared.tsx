"use client";
// Small shared bits for the commissioner tools.
import { useCallback } from "react";
import { useTripStore } from "@/lib/client/react";
import type { OpInput } from "@/lib/ops";
import type { Team } from "@/lib/types";
import { Chip, teamColor, useToast } from "@/components/ui";

/** Dispatch and toast the rejection reason. Returns true when accepted. */
export function useCommishDispatch(): (input: OpInput) => boolean {
  const store = useTripStore();
  const toast = useToast();
  return useCallback(
    (input: OpInput) => {
      const r = store.dispatch(input);
      if (!r.ok) {
        toast.error(r.reason, { title: "Override bounced" });
        return false;
      }
      return true;
    },
    [store, toast],
  );
}

export function TeamChips({
  teams,
  value,
  onChange,
  allLabel,
}: {
  teams: Team[];
  value: string | null;
  onChange: (teamId: string | null) => void;
  /** Show an "All" chip with this label. */
  allLabel?: string;
}) {
  return (
    <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label="Team">
      {allLabel && (
        <Chip selected={value === null} tone="ink" onClick={() => onChange(null)} className="shrink-0">
          {allLabel}
        </Chip>
      )}
      {teams.map((t) => {
        const c = teamColor(t.sort_order);
        return (
          <Chip
            key={t.id}
            selected={value === t.id}
            tone="ink"
            onClick={() => onChange(t.id)}
            className="shrink-0"
            leading={<span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-ink" style={{ backgroundColor: c.bg }} />}
          >
            {t.name || "Unnamed team"}
          </Chip>
        );
      })}
    </div>
  );
}

export function timeOf(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function HoleSelect({ value, onChange, label = "Hole" }: { value: number | null; onChange: (h: number | null) => void; label?: string }) {
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="text-sm font-extrabold tracking-wider uppercase">{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="h-12 min-w-0 flex-1 rounded-xl border-2 border-ink bg-paper px-3 text-lg font-bold text-ink"
      >
        <option value="">All holes</option>
        {Array.from({ length: 18 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            Hole {n}
          </option>
        ))}
      </select>
    </label>
  );
}
