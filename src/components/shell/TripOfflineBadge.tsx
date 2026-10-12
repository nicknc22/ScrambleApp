"use client";
import { useClientState } from "@/lib/client/react";
import { OfflineBadge } from "@/components/ui";

/** OfflineBadge wired to the trip store ("Offline, X changes waiting" / "Syncing X…"). */
export function TripOfflineBadge({ variant = "bar", className }: { variant?: "pill" | "bar"; className?: string }) {
  const pendingCount = useClientState((s) => s.pendingCount);
  const online = useClientState((s) => s.online);
  const syncing = useClientState((s) => s.syncing);
  return <OfflineBadge pendingCount={pendingCount} online={online} syncing={syncing} variant={variant} className={className} />;
}
