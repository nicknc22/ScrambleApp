// derive(state): recompute every derived value from raw rows. Pure; shared by client and server.
import type { TripState } from "../types";
import type { Derived } from "./types";

export * from "./types";

export function derive(state: TripState, opts?: { now?: string }): Derived {
  void state;
  void opts;
  throw new Error("not implemented");
}
