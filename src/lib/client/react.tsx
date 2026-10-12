"use client";
// React bindings for TripStore.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { getTripStore, type ClientState, type TripStore } from "./store";
import { warmServiceWorker } from "./sw-register";

const TripStoreContext = createContext<TripStore | null>(null);

// Providers mounted per store: started on the first, stopped when the last unmounts.
const mounts = new Map<TripStore, number>();

/** Creates (once per code) and starts a TripStore; stops it on unmount. */
export function TripProvider({ code, children }: { code: string; children: ReactNode }) {
  // One store per code per tab (registry), so remounts/StrictMode keep the warm in-memory state.
  const store = useMemo(() => getTripStore(code), [code]);
  useEffect(() => {
    const n = mounts.get(store) ?? 0;
    mounts.set(store, n + 1);
    if (n === 0) store.start();
    return () => {
      const left = (mounts.get(store) ?? 1) - 1;
      if (left <= 0) {
        mounts.delete(store);
        store.stop();
      } else {
        mounts.set(store, left);
      }
    };
  }, [store]);
  useEffect(() => {
    // Arriving here by client-side navigation means the SW never saw a navigation request for
    // this URL: cache the trip page now so it opens with no signal later.
    try {
      if (navigator.serviceWorker?.controller) void warmServiceWorker([window.location.href]);
    } catch {
      /* no SW */
    }
  }, [code]);
  return <TripStoreContext.Provider value={store}>{children}</TripStoreContext.Provider>;
}

export function useTripStore(): TripStore {
  const s = useContext(TripStoreContext);
  if (!s) throw new Error("useTripStore outside TripProvider");
  return s;
}

const identity = <T,>(s: ClientState) => s as unknown as T;

/**
 * Subscribe to ClientState (useSyncExternalStore). Optional selector. The selection is cached
 * per (state, selector), so selectors may return fresh objects without render loops; components
 * re-render only when the selected value changes identity.
 */
export function useClientState<T = ClientState>(selector?: (s: ClientState) => T): T {
  const store = useTripStore();
  const select = (selector ?? identity) as (s: ClientState) => T;
  const cache = useRef<{ state: ClientState; select: (s: ClientState) => T; value: T } | null>(null);
  const serverCache = useRef<{ state: ClientState; select: (s: ClientState) => T; value: T } | null>(null);

  const read = (state: ClientState, ref: typeof cache): T => {
    const c = ref.current;
    if (c && c.state === state && c.select === select) return c.value;
    const value = select(state);
    // Same value as before (e.g. a primitive, or an unchanged sub-object): keep the old identity.
    if (c && Object.is(c.value, value)) {
      ref.current = { state, select, value: c.value };
      return c.value;
    }
    ref.current = { state, select, value };
    return value;
  };

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(
    subscribe,
    () => read(store.getState(), cache),
    () => read(store.getServerState(), serverCache),
  );
}

/** Shorthand for the dispatch function. */
export function useDispatch(): TripStore["dispatch"] {
  const store = useTripStore();
  return useCallback((input) => store.dispatch(input), [store]);
}
