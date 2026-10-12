"use client";
// PLACEHOLDER: the Contests agent replaces this file. Keep the export name and no-props signature.
import { useClientState } from "@/lib/client/react";
import { Badge, Card, EmptyState, SectionHeader } from "@/components/ui";
import { displayName } from "@/components/ui/PlayerName";
import { Screen } from "@/components/shell/Screen";

export function ContestsScreen() {
  const derived = useClientState((s) => s.derived);
  if (!derived) return null;
  return (
    <Screen>
      <SectionHeader title="Contests" subtitle="Closest to pin on par 3s, long drive on par 5s." />
      {derived.contests.length === 0 && <EmptyState emoji="🎯" title="No contest holes" />}
      <ul className="space-y-2.5">
        {derived.contests.map((c) => (
          <li key={c.hole}>
            <Card className="flex items-center gap-3">
              <span className="num text-3xl font-black">#{c.hole}</span>
              <div className="min-w-0 flex-1">
                <Badge tone={c.type === "ctp" ? "sky" : "beer"}>{c.type === "ctp" ? "Closest to pin" : "Long drive"}</Badge>
                <p className="mt-1 truncate text-base font-bold">
                  {c.leader_ids.length > 0
                    ? `Leader: ${c.leader_ids.map((id) => displayName(derived.playerById[id])).join(", ")}`
                    : "No entries yet"}
                </p>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Screen>
  );
}
