"use client";
import { useEffect, type ComponentType } from "react";
import { cx, IconFeed, IconFlag, IconMoney, IconPodium, IconTarget, type IconProps } from "@/components/ui";
import { MAIN_TABS, TAB_LABEL, TAB_SHORT_LABEL, type TabKey } from "./tabs";

const ICON: Partial<Record<TabKey, ComponentType<IconProps>>> = {
  play: IconFlag,
  leaderboard: IconPodium,
  feed: IconFeed,
  contests: IconTarget,
  money: IconMoney,
};

/** Fixed bottom tab bar (Play · Board · Feed · Contests · Money), safe-area aware. */
export function TabBar({
  tab,
  onSelect,
  badges,
}: {
  tab: TabKey;
  onSelect: (t: TabKey) => void;
  /** Small count bubbles, e.g. unread feed events. */
  badges?: Partial<Record<TabKey, number>>;
}) {
  // Toasts float above the bar while it is on screen.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--toast-bottom", "calc(var(--tabbar-h) + 10px)");
    return () => {
      root.style.removeProperty("--toast-bottom");
    };
  }, []);

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-ink bg-paper pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <ul className="mx-auto flex h-[var(--tabbar-h)] max-w-xl items-stretch">
        {MAIN_TABS.map((key) => {
          const Icon = ICON[key]!;
          const active = key === tab;
          const badge = badges?.[key] ?? 0;
          return (
            <li key={key} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onSelect(key)}
                aria-current={active ? "page" : undefined}
                aria-label={badge > 0 ? `${TAB_LABEL[key]}, ${badge} new` : TAB_LABEL[key]}
                data-testid={`tab-${key}`}
                className={cx(
                  "relative flex h-full w-full flex-col items-center justify-center gap-0.5 transition-colors",
                  active ? "bg-fairway-soft text-fairway-dark" : "text-ink active:bg-sand",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx("absolute inset-x-2 top-0 h-1.5 rounded-b-full", active ? "bg-fairway" : "bg-transparent")}
                />
                <span className="relative">
                  <Icon size={27} strokeWidth={active ? 2.9 : 2.3} />
                  {badge > 0 && (
                    <span className="num absolute -top-1.5 -right-3 min-w-5 rounded-full border-2 border-paper bg-flag px-1 text-center text-[11px] leading-4 font-black text-white">
                      {badge > 9 ? "9+" : badge}
                    </span>
                  )}
                </span>
                <span className={cx("max-w-full truncate px-0.5 text-[12px] leading-tight uppercase", active ? "font-black" : "font-bold")}>
                  {TAB_SHORT_LABEL[key]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
