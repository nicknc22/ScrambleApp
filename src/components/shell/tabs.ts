// Tab model for the trip page. Pure (unit-tested in tests/ui/tabs.test.ts).
import type { TripStatus } from "@/lib/types";

export type TabKey = "play" | "leaderboard" | "feed" | "contests" | "money" | "setup" | "awards";

/** The five bottom-bar tabs, in order. */
export const MAIN_TABS: readonly TabKey[] = ["play", "leaderboard", "feed", "contests", "money"];
/** Extra destinations reached from the menu. */
export const EXTRA_TABS: readonly TabKey[] = ["setup", "awards"];

export const TAB_LABEL: Record<TabKey, string> = {
  play: "Play",
  leaderboard: "Leaderboard",
  feed: "Feed",
  contests: "Contests",
  money: "Money",
  setup: "Setup",
  awards: "Awards",
};

/** Short labels for the 360px-wide tab bar. */
export const TAB_SHORT_LABEL: Record<TabKey, string> = {
  play: "Play",
  leaderboard: "Board",
  feed: "Feed",
  contests: "Contests",
  money: "Money",
  setup: "Setup",
  awards: "Awards",
};

export interface TabContext {
  isCommissioner: boolean;
  status: TripStatus;
}

export function isTabKey(s: unknown): s is TabKey {
  return typeof s === "string" && (MAIN_TABS as readonly string[]).concat(EXTRA_TABS).includes(s);
}

/** Setup is commissioner-only; Awards only once the trip is final. */
export function tabAllowed(tab: TabKey, ctx: TabContext): boolean {
  if (tab === "setup") return ctx.isCommissioner;
  if (tab === "awards") return ctx.status === "final";
  return true;
}

/** Commissioner lands on Setup while the trip is in setup; everyone else on Play. */
export function defaultTab(ctx: TabContext): TabKey {
  return ctx.isCommissioner && ctx.status === "setup" ? "setup" : "play";
}

/**
 * The tab to show for a requested ?tab= value. Unknown or not-allowed values fall back to the
 * default without being erased from the URL, so "?tab=setup" starts working the moment the
 * commissioner cookie check comes back.
 */
export function resolveTab(requested: string | null | undefined, ctx: TabContext): TabKey {
  if (isTabKey(requested) && tabAllowed(requested, ctx)) return requested;
  return defaultTab(ctx);
}
