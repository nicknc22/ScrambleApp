import { describe, expect, it } from "vitest";
import { settleUp, splitCents } from "@/lib/engine/settle";
import type { LedgerRow, Payment } from "@/lib/engine/types";

const row = (player_id: string, net_cents: number): LedgerRow => ({
  player_id,
  antes_cents: net_cents < 0 ? -net_cents : 0,
  winnings_cents: net_cents > 0 ? net_cents : 0,
  net_cents,
});

/** Applying the payments must bring every balance to exactly zero. */
function expectSettles(ledger: LedgerRow[], payments: Payment[]) {
  const bal = new Map(ledger.map((r) => [r.player_id, r.net_cents]));
  for (const p of payments) {
    expect(p.amount_cents).toBeGreaterThan(0);
    expect(Number.isInteger(p.amount_cents)).toBe(true);
    expect(p.from_player_id).not.toBe(p.to_player_id);
    bal.set(p.from_player_id, bal.get(p.from_player_id)! + p.amount_cents);
    bal.set(p.to_player_id, bal.get(p.to_player_id)! - p.amount_cents);
  }
  for (const v of bal.values()) expect(v).toBe(0);
}

describe("splitCents", () => {
  it("splits evenly with remainder cents to ids in order", () => {
    expect(splitCents(1000, ["a", "b", "c"])).toEqual({ a: 334, b: 333, c: 333 });
    expect(splitCents(1001, ["c", "b", "a"])).toEqual({ c: 334, b: 334, a: 333 });
    expect(splitCents(900, ["a", "b", "c"])).toEqual({ a: 300, b: 300, c: 300 });
    expect(splitCents(5, ["a", "b", "c", "d"])).toEqual({ a: 2, b: 1, c: 1, d: 1 });
    expect(splitCents(2, ["a", "b", "c"])).toEqual({ a: 1, b: 1, c: 0 });
  });

  it("handles zero, a single id and no ids", () => {
    expect(splitCents(0, ["a", "b"])).toEqual({ a: 0, b: 0 });
    expect(splitCents(777, ["a"])).toEqual({ a: 777 });
    expect(splitCents(500, [])).toEqual({});
  });

  it("always sums to the total", () => {
    for (let total = 0; total < 500; total += 7) {
      for (let n = 1; n <= 9; n++) {
        const ids = Array.from({ length: n }, (_, i) => `p${i}`);
        const out = splitCents(total, ids);
        expect(Object.values(out).reduce((s, c) => s + c, 0)).toBe(total);
        const vals = Object.values(out);
        expect(Math.max(...vals) - Math.min(...vals)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("settleUp", () => {
  it("matches the biggest debtor with the biggest creditor", () => {
    const ledger = [row("a", -1000), row("b", -500), row("c", 1200), row("d", 300)];
    const payments = settleUp(ledger);
    expect(payments).toEqual([
      { from_player_id: "a", to_player_id: "c", amount_cents: 1000 },
      { from_player_id: "b", to_player_id: "d", amount_cents: 300 },
      { from_player_id: "b", to_player_id: "c", amount_cents: 200 },
    ]);
    expectSettles(ledger, payments);
  });

  it("nobody pays when everyone is even; zero rows are skipped", () => {
    expect(settleUp([row("a", 0), row("b", 0)])).toEqual([]);
    expect(settleUp([])).toEqual([]);
    const ledger = [row("a", 0), row("b", -250), row("c", 250)];
    expect(settleUp(ledger)).toEqual([{ from_player_id: "b", to_player_id: "c", amount_cents: 250 }]);
  });

  it("breaks ties by the given order, then by id", () => {
    const ledger = [row("z", -500), row("y", -500), row("x", 1000)];
    expect(settleUp(ledger).map((p) => p.from_player_id)).toEqual(["y", "z"]);
    expect(settleUp(ledger, ["z", "y", "x"]).map((p) => p.from_player_id)).toEqual(["z", "y"]);
    const creditors = [row("a", -1000), row("q", 500), row("p", 500)];
    expect(settleUp(creditors).map((p) => p.to_player_id)).toEqual(["p", "q"]);
    expect(settleUp(creditors, ["q"]).map((p) => p.to_player_id)).toEqual(["q", "p"]);
  });

  it("winner-take-all from a 10-player ledger needs 9 payments", () => {
    const ledger = [row("w", 9000), ...Array.from({ length: 9 }, (_, i) => row(`l${i}`, -1000))];
    const payments = settleUp(ledger);
    expect(payments).toHaveLength(9);
    expect(payments.every((p) => p.to_player_id === "w" && p.amount_cents === 1000)).toBe(true);
    expectSettles(ledger, payments);
  });

  it("settles randomized zero-sum ledgers in at most n - 1 payments", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rand() * 11);
      const nets = Array.from({ length: n - 1 }, () => Math.floor(rand() * 4001) - 2000);
      nets.push(-nets.reduce((s, c) => s + c, 0));
      const ledger = nets.map((c, i) => row(`p${String(i).padStart(2, "0")}`, c));
      const payments = settleUp(ledger);
      expectSettles(ledger, payments);
      const nonZero = nets.filter((c) => c !== 0).length;
      expect(payments.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));
      // Deterministic: same input, same output.
      expect(settleUp([...ledger].reverse())).toEqual(payments);
    }
  });
});
