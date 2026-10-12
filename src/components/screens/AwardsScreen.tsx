"use client";
// PLACEHOLDER: the Awards agent replaces this file. Keep the export name and no-props signature.
import { useClientState } from "@/lib/client/react";
import { Card, SectionHeader } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";

export function AwardsScreen() {
  const derived = useClientState((s) => s.derived);
  if (!derived) return null;
  return (
    <Screen>
      <SectionHeader title="Awards" subtitle="Glory and shame, computed." />
      <ul className="space-y-2.5">
        {derived.awards.map((a) => (
          <li key={a.key}>
            <Card className="flex items-center gap-3">
              <span className="text-4xl leading-none" aria-hidden="true">
                {a.emoji}
              </span>
              <div className="min-w-0">
                <p className="text-lg leading-tight font-black">{a.title}</p>
                <p className="text-base font-semibold">{a.awarded ? a.value_label : "Nobody. Boring."}</p>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
