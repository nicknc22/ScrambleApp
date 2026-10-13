"use client";
// "Send the link" (Setup -> Roster, and the menu): the clean /t/<code> link through the share sheet,
// else copied with a toast. See shareLink.ts.
import { useState } from "react";
import { Button, Card, useIsClient, useToast } from "@/components/ui";
import { shareTripLink, tripLink } from "./shareLink";

/** Share (or copy) the trip link; toasts the outcome. Returns [send, busy, url]. */
export function useShareTripLink(code: string, tripName: string): [() => Promise<void>, boolean, string] {
  const toast = useToast();
  const isClient = useIsClient();
  const [busy, setBusy] = useState(false);
  const url = isClient ? tripLink(window.location.origin, code) : `/t/${code}`;
  const send = async () => {
    if (busy) return;
    setBusy(true);
    const outcome = await shareTripLink({ url, title: tripName });
    setBusy(false);
    if (outcome === "copied") {
      toast.success("Paste it in the group chat. They open it, tap their name, done.", { title: "Link copied", emoji: "📋", id: "trip-link" });
    } else if (outcome === "failed") {
      toast.error(`Couldn't copy it. Press and hold the link to copy it: ${url}`, { id: "trip-link" });
    }
  };
  return [send, busy, url];
}

/** Setup -> Roster: the link, big, with one button. */
export function ShareTripLinkCard({ code, tripName }: { code: string; tripName: string }) {
  const [send, busy, url] = useShareTripLink(code, tripName);
  return (
    <Card tone="sky" className="space-y-2" data-testid="share-link-card">
      <div>
        <h3 className="text-xl leading-tight font-black">Send the boys the link</h3>
        <p className="mt-0.5 text-[15px] font-bold">They open it, tap their name, done. No PIN, no wizard.</p>
      </div>
      <p className="rounded-xl border-2 border-ink bg-paper px-3 py-2 font-mono text-[15px] font-bold break-all text-ink select-all" data-testid="share-link-url">
        {url}
      </p>
      <Button size="lg" full loading={busy} onClick={() => void send()} data-testid="share-link" leading={<span aria-hidden="true">📤</span>}>
        Send the link
      </Button>
    </Card>
  );
}
