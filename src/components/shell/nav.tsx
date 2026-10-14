"use client";
// Shell navigation for screens: switch tabs, open the menu, settings, the explainer or the rules.
// `const nav = useShellNav(); nav.setTab("leaderboard")`.
import { createContext, useContext } from "react";
import type { TabKey } from "./tabs";

export interface ShellNav {
  tab: TabKey;
  setTab: (tab: TabKey) => void;
  openMenu: () => void;
  openSettings: () => void;
  /** Show the "who are you?" roster again (same as Settings → Switch player). */
  switchPlayer: () => void;
  /** Play the "How it works" explainer. */
  openExplainer: () => void;
  /** Open the "Rules & lingo" cheat sheet. */
  openRules: () => void;
}

const noop = () => {};
const fallback: ShellNav = {
  tab: "play",
  setTab: noop,
  openMenu: noop,
  openSettings: noop,
  switchPlayer: noop,
  openExplainer: noop,
  openRules: noop,
};

export const ShellNavContext = createContext<ShellNav>(fallback);

export function useShellNav(): ShellNav {
  return useContext(ShellNavContext);
}
