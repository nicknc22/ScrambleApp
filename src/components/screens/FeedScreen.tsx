"use client";
// PLACEHOLDER: the Feed agent replaces this file. Keep the export name and no-props signature.
import { useClientState } from "@/lib/client/react";
import { renderFeedEvent } from "@/lib/events/templates";
import { Card, EmptyState, SectionHeader } from "@/components/ui";
import { Screen } from "@/components/shell/Screen";

export function FeedScreen() {
  const view = useClientState((s) => s.view);
  const derived = useClientState((s) => s.derived);
  if (!view || !derived) return null;
  const events = view.feed_events.filter((e) => !e.deleted_at).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return (
    <Screen>
      <SectionHeader title="Feed" subtitle="Everything that happened, newest first." />
      {events.length === 0 && <EmptyState emoji="📭" title="Quiet so far">Nothing has happened yet. Go do something stupid.</EmptyState>}
      <ul className="space-y-2.5">
        {events.map((ev) => {
          let title: string = ev.type;
          let emoji = "•";
          let body = ev.text ?? "";
          try {
            const r = renderFeedEvent(ev, view, derived);
            title = r.title;
            emoji = r.emoji;
            body = r.body;
          } catch {
            /* templates not ready: show the raw type */
          }
          return (
            <li key={ev.id}>
              <Card className="flex gap-3">
                <span className="text-3xl leading-none" aria-hidden="true">
                  {emoji}
                </span>
                <div className="min-w-0">
                  <p className="text-lg leading-tight font-black">{title}</p>
                  {body && <p className="text-base font-semibold text-ink">{body}</p>}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </Screen>
  );
}
