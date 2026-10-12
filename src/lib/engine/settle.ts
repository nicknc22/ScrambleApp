import type { UUID } from "../types";
import type { LedgerRow, Payment } from "./types";

/** Minimize payments: repeatedly match the biggest debtor with the biggest creditor. */
export function settleUp(ledger: LedgerRow[], tieBreakOrder?: UUID[]): Payment[] {
  void ledger; void tieBreakOrder;
  throw new Error("not implemented");
}

/** Split `total` cents among `ids` as evenly as possible; remainder cents go to ids in order. */
export function splitCents(total: number, ids: UUID[]): Record<UUID, number> {
  void total; void ids;
  throw new Error("not implemented");
}
