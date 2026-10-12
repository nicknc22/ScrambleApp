"use client";
// The active tab lives in ?tab=. Read via useSyncExternalStore (null during SSR/hydration),
// written with history.replaceState: no navigation, no history spam.
import { useCallback, useSyncExternalStore } from "react";

const URL_EVENT = "scramble:urlchange";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(URL_EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(URL_EVENT, cb);
  };
}

function getSnapshot(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("tab");
  } catch {
    return null;
  }
}

function getServerSnapshot(): string | null {
  return null;
}

export function useUrlTab(): [string | null, (tab: string | null) => void] {
  const tab = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTab = useCallback((next: string | null) => {
    try {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("tab", next);
      else url.searchParams.delete("tab");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      /* ignore: the in-memory event below still switches the tab */
    }
    window.dispatchEvent(new Event(URL_EVENT));
  }, []);
  return [tab, setTab];
}
