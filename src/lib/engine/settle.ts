// Settle-up: turn the ledger into a short list of "A pays B $X" payments. Integer cents only.
import type { UUID } from "../types";
import type { LedgerRow, Payment } from "./types";

/** Minimize payments: repeatedly match the biggest debtor with the biggest creditor. */
export function settleUp(ledger: LedgerRow[], tieBreakOrder?: UUID[]): Payment[] {
  // Deterministic tie-break: position in tieBreakOrder (unlisted ids after), then id.
  const orderIndex = new Map<UUID, number>();
  (tieBreakOrder ?? []).forEach((id, i) => {
    if (!orderIndex.has(id)) orderIndex.set(id, i);
  });
  const rankOf = (id: UUID) => orderIndex.get(id) ?? Number.MAX_SAFE_INTEGER;
  const byIdOrder = (a: UUID, b: UUID) => rankOf(a) - rankOf(b) || (a < b ? -1 : a > b ? 1 : 0);

  // Merge duplicate rows defensively; amounts are integer cents.
  const balance = new Map<UUID, number>();
  for (const row of ledger) balance.set(row.player_id, (balance.get(row.player_id) ?? 0) + Math.round(row.net_cents));

  const debtors: { id: UUID; owes: number }[] = [];
  const creditors: { id: UUID; due: number }[] = [];
  for (const [id, net] of balance) {
    if (net < 0) debtors.push({ id, owes: -net });
    else if (net > 0) creditors.push({ id, due: net });
  }

  const payments: Payment[] = [];
  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort((a, b) => b.owes - a.owes || byIdOrder(a.id, b.id));
    creditors.sort((a, b) => b.due - a.due || byIdOrder(a.id, b.id));
    const d = debtors[0];
    const c = creditors[0];
    const amount = Math.min(d.owes, c.due);
    payments.push({ from_player_id: d.id, to_player_id: c.id, amount_cents: amount });
    d.owes -= amount;
    c.due -= amount;
    if (d.owes === 0) debtors.shift();
    if (c.due === 0) creditors.shift();
  }
  return payments;
}

/** Split `total` cents among `ids` as evenly as possible; remainder cents go to ids in order. */
export function splitCents(total: number, ids: UUID[]): Record<UUID, number> {
  const out: Record<UUID, number> = {};
  if (ids.length === 0) return out;
  const cents = Math.round(total);
  const base = Math.floor(cents / ids.length);
  let remainder = cents - base * ids.length; // 0 <= remainder < ids.length (also for negative totals)
  for (const id of ids) {
    const share = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    // A duplicated id accumulates both shares so the result still sums to total.
    out[id] = (out[id] ?? 0) + share;
  }
  return out;
}
