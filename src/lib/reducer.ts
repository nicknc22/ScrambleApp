// applyOp: the ONE place op semantics live. Pure and immutable (returns new arrays for changed
// tables; untouched tables keep identity). Used by the client (optimistic view = snapshot + pending
// ops) and by the server (inside a per-trip lock; `writes` are persisted to Postgres).
// Semantics are specified in CLAUDE.md "Reducer semantics".
import type { AnyRow, ISODate, RowTable, Trip, TripState, UUID } from "./types";
import type { Op, RejectCode } from "./ops";

export interface ApplyCtx {
  /** Server time on the server; client time on the client. Used for created_at/updated_at/deleted_at. */
  now: ISODate;
  is_commissioner: boolean;
  side: "client" | "server";
}

export type Write =
  | { kind: "upsert"; table: RowTable; row: AnyRow }
  | { kind: "delete"; table: RowTable; id: UUID }
  | { kind: "trip"; row: Trip };

export type ApplyResult =
  | { ok: true; state: TripState; writes: Write[] }
  | { ok: false; code: RejectCode; reason: string };

export function applyOp(state: TripState, op: Op, ctx: ApplyCtx): ApplyResult {
  void state; void op; void ctx;
  throw new Error("not implemented");
}

/** Apply many ops in order, skipping rejected ones. Returns the final state and per-op results. */
export function applyOps(
  state: TripState,
  ops: Op[],
  ctx: ApplyCtx,
): { state: TripState; results: Array<{ id: UUID; ok: boolean; code?: RejectCode; reason?: string }> } {
  void state; void ops; void ctx;
  throw new Error("not implemented");
}
