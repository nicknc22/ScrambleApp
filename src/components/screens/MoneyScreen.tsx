"use client";
// PLACEHOLDER: the Money agent replaces this file. Keep the export name and no-props signature.
import { useClientState } from "@/lib/client/react";
import { Card, EmptyState, SectionHeader } from "@/components/ui";
import { formatCents } from "@/lib/engine/format";
import { Screen } from "@/components/shell/Screen";

export function MoneyScreen() {
  const derived = useClientState((s) => s.derived);
  if (!derived) return null;
  const money = derived.money;
  return (
    <Screen>
      <SectionHeader title="Money" subtitle={money.final ? "Final. Pay up." : "Projected. Nothing is real until it's final."} />
      {money.pots.length === 0 && <EmptyState emoji="💸" title="No pots yet" />}
      <ul className="space-y-2.5">
        {money.pots.map((p) => (
          <li key={p.key}>
            <Card className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-lg font-black">{p.label}</span>
              <span className="num text-xl font-black">{formatCents(p.total_cents)}</span>
            </Card>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
