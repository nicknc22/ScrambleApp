"use client";
// React bindings for TripStore.
import { createContext, useContext, type ReactNode } from "react";
import type { ClientState, TripStore } from "./store";

const TripStoreContext = createContext<TripStore | null>(null);

/** Creates (once per code) and starts a TripStore; stops it on unmount. */
export function TripProvider({ code, children }: { code: string; children: ReactNode }) {
  void code;
  return <TripStoreContext.Provider value={null}>{children}</TripStoreContext.Provider>;
}

export function useTripStore(): TripStore {
  const s = useContext(TripStoreContext);
  if (!s) throw new Error("useTripStore outside TripProvider");
  return s;
}

/** Subscribe to ClientState (useSyncExternalStore). Optional selector. */
export function useClientState<T = ClientState>(selector?: (s: ClientState) => T): T {
  void selector;
  throw new Error("not implemented");
}
