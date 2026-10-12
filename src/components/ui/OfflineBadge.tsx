import { cx } from "./cx";
import { IconSync, IconWifiOff } from "./icons";

export interface SyncStatus {
  pendingCount: number;
  online: boolean;
  syncing?: boolean;
}

/** What the offline badge says, or null when everything is synced. */
export function offlineBadgeText({ pendingCount, online }: SyncStatus): { text: string; tone: "offline" | "syncing" } | null {
  const n = Math.max(0, Math.floor(pendingCount || 0));
  const changes = `${n} ${n === 1 ? "change" : "changes"}`;
  if (!online) return { text: n > 0 ? `Offline, ${changes} waiting` : "Offline", tone: "offline" };
  if (n > 0) return { text: `Syncing ${n}…`, tone: "syncing" };
  return null;
}

/**
 * "Offline, X changes waiting" (yellow) / "Syncing X…" (blue) / nothing when all synced.
 * Presentational: pass the store's pendingCount/online (the shell's TripOfflineBadge does that).
 */
export function OfflineBadge({
  pendingCount,
  online,
  syncing,
  variant = "pill",
  className,
}: SyncStatus & { variant?: "pill" | "bar"; className?: string }) {
  const s = offlineBadgeText({ pendingCount, online, syncing });
  if (!s) return null;
  const offline = s.tone === "offline";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-badge"
      className={cx(
        "flex items-center gap-2 font-extrabold",
        variant === "pill" ? "inline-flex min-h-8 rounded-full border-2 px-3 text-sm" : "min-h-9 w-full justify-center px-4 text-[15px]",
        offline ? "border-ink bg-hazard text-ink" : "border-sky-dark bg-sky text-white",
        className,
      )}
    >
      {offline ? (
        <IconWifiOff size={18} strokeWidth={2.75} className="shrink-0" />
      ) : (
        <IconSync size={18} strokeWidth={2.75} className="shrink-0 animate-spin [animation-duration:1.6s]" />
      )}
      <span className="truncate">{s.text}</span>
    </div>
  );
}
