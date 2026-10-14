"use client";
// The explainer's lazy door. The trip page only carries this file; the cartoons load on first
// open (or earlier, in the background, so the service worker has the chunk for no-signal replays).
// A chunk that can't load (offline before it was ever cached) closes quietly instead of crashing.
import { useEffect, useState, type ComponentType } from "react";
import { warmServiceWorker } from "@/lib/client/sw-register";
import { ErrorBoundary } from "@/components/shell/ErrorBoundary";
import type { ExplainerProps } from "./Explainer";

type ExplainerComponent = ComponentType<ExplainerProps>;

let loaded: ExplainerComponent | null = null;
let loading: Promise<ExplainerComponent> | null = null;

/** Load (once) the explainer chunk. */
export function loadExplainer(): Promise<ExplainerComponent> {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = import("./Explainer").then(
      (m) => {
        loaded = m.Explainer;
        return loaded;
      },
      (e: unknown) => {
        loading = null; // try again next time (signal may be back)
        throw e;
      },
    );
  }
  return loading;
}

/**
 * Fetch the chunk while the phone is idle, then ask the service worker to keep it, so "How it works"
 * replays with no signal on the course. Best effort, never throws.
 */
export function prefetchExplainer(): void {
  if (loaded || typeof window === "undefined") return;
  const run = () => {
    loadExplainer()
      .then(() => {
        try {
          const chunks = performance
            .getEntriesByType("resource")
            .map((e) => e.name)
            .filter((n) => n.startsWith(location.origin) && new URL(n).pathname.startsWith("/_next/static/"));
          if (chunks.length > 0) void warmServiceWorker(chunks);
        } catch {
          /* best effort */
        }
      })
      .catch(() => undefined);
  };
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

export function LazyExplainer(props: ExplainerProps & { onUnavailable?: () => void }) {
  const { onUnavailable, ...rest } = props;
  const [Comp, setComp] = useState<ExplainerComponent | null>(() => loaded);
  useEffect(() => {
    if (Comp) return;
    let alive = true;
    loadExplainer().then(
      (c) => {
        if (alive) setComp(() => c);
      },
      () => {
        if (alive) (onUnavailable ?? (() => rest.onClose("skip")))();
      },
    );
    return () => {
      alive = false;
    };
    // Load once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!Comp) return null;
  return (
    <ErrorBoundary where="explainer" fallback={() => <CloseOnCrash onClose={() => rest.onClose("skip")} />}>
      <Comp {...rest} />
    </ErrorBoundary>
  );
}

function CloseOnCrash({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    onClose();
  }, [onClose]);
  return null;
}
