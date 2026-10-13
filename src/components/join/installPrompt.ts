"use client";
// Captures Chrome/Android's beforeinstallprompt so we can offer a real "Install" button.
// Registered at module load (the event fires early, before the "Get set up" card mounts).
import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  try {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferred = e as BeforeInstallPromptEvent;
      emit();
    });
    window.addEventListener("appinstalled", () => {
      deferred = null;
      emit();
    });
  } catch {
    /* ignore */
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Show the native install prompt if the browser offered one. Resolves true when accepted. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  emit();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    return choice.outcome === "accepted";
  } catch {
    return false;
  }
}

/** true when a native install prompt is available (Android Chrome / desktop Chrome). */
export function useCanPromptInstall(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => deferred !== null,
    () => false,
  );
}
