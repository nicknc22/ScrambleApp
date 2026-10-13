// Which rows the "Get set up" card shows, and whether it shows at all: the full card pre-round,
// one row on Play while the round is live. Pure (tested in tests/ui/get-set-up.test.tsx);
// GetSetUp.tsx feeds it what this device can do.
import type { Platform } from "@/lib/client/ui-prefs";

export interface GetSetUpInput {
  /** Running from the Home Screen (isStandalone()). */
  standalone: boolean;
  platform: Platform;
  /** Snapshot meta push_enabled: the server sends pushes for this trip. */
  pushOnServer: boolean;
  /** This browser can do Web Push (pushSupported()). */
  pushSupported: boolean;
  /** Subscribed for the server's current key with permission granted; null while still checking. */
  pushOn: boolean | null;
}

export type InstallRow = "todo" | "done";
/**
 * install_first: iPhone Safari (push only works in the Home Screen app), shown disabled.
 * null: not offered (push off for the trip, or this phone can't do it at all).
 */
export type NotifyRow = "todo" | "done" | "checking" | "install_first" | null;

export interface GetSetUpRows {
  install: InstallRow;
  notify: NotifyRow;
}

export function getSetUpRows(i: GetSetUpInput): GetSetUpRows {
  const install: InstallRow = i.standalone ? "done" : "todo";
  let notify: NotifyRow;
  if (!i.pushOnServer) notify = null;
  else if (!i.pushSupported) notify = !i.standalone && i.platform === "ios" ? "install_first" : null;
  else if (i.pushOn === null) notify = "checking";
  else notify = i.pushOn ? "done" : "todo";
  return { install, notify };
}

/**
 * Show the card: not hidden on this device, every check has answered (no flash of a card that's
 * about to vanish), and something is left to do. It hides itself once every row is done.
 */
export function showGetSetUp(rows: GetSetUpRows, hidden: boolean): boolean {
  if (hidden || rows.notify === "checking") return false;
  return rows.install !== "done" || rows.notify === "todo" || rows.notify === "install_first";
}

/** Rows that can be done right now (iPhone Safari's blocked notifications row doesn't count). */
export function getSetUpTodo(rows: GetSetUpRows): number {
  return (rows.install === "todo" ? 1 : 0) + (rows.notify === "todo" ? 1 : 0);
}

/** The card's first line: counts only what can be done now. */
export function getSetUpIntro(rows: GetSetUpRows): string {
  const todo = getSetUpTodo(rows);
  if (todo >= 2) return "Two quick things before the first tee. Thirty seconds, tops.";
  if (todo === 1 && rows.notify === "install_first") return "One quick thing now. Notifications come after, from the Home Screen app.";
  if (todo === 1) return "One quick thing before the first tee. Ten seconds, tops.";
  return "All set. Go hit something.";
}

/**
 * During the round Play shows one row instead of the card (below the scorecard, never above it):
 * the first thing left to do, null when nothing can be done right now.
 */
export function getSetUpNextRow(rows: GetSetUpRows): "install" | "notify" | null {
  if (rows.install === "todo") return "install";
  if (rows.notify === "todo") return "notify";
  return null;
}
