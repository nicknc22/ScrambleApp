// Pure view helpers for the Money tab (unit-tested in tests/ui/money-logic.test.ts).
// Everything is integer cents; display with formatCents.
import type { ContestKind, FeedEvent, ISODate, Player, PotKey, Trip, TripState, UUID } from "@/lib/types";
import type { Derived, LedgerRow, Payment, PotView, StandingRow } from "@/lib/engine/types";

export const CONTEST_EMOJI: Record<ContestKind, string> = { ctp: "🎯", ld: "💣" };
export const CONTEST_NAME: Record<ContestKind, string> = { ctp: "Closest to pin", ld: "Long drive" };

/** "Team match" / "hole 3" — short name of a pot for rollover lines. */
export function potShortName(key: PotKey | string): string {
  if (key === "team_match") return "the team match";
  const m = /^contest:(\d+)$/.exec(key);
  return m ? `hole ${m[1]}` : String(key);
}

/** "hole 3", "holes 3 & 8", "holes 3, 8 & 11" */
export function joinPotNames(keys: readonly string[]): string {
  const names = keys.map(potShortName);
  if (names.length <= 1) return names[0] ?? "";
  const holes = keys.every((k) => k.startsWith("contest:"));
  const bare = holes ? keys.map((k) => k.slice("contest:".length)) : names;
  const prefix = holes ? "holes " : "";
  return `${prefix}${bare.slice(0, -1).join(", ")} & ${bare[bare.length - 1]}`;
}

/** Team match payout rule: [100] -> "Winner takes all"; [70, 30] -> "1st 70% · 2nd 30%". */
export function payoutRuleLabel(percents: readonly number[] | null | undefined): string {
  const pct = (percents ?? []).filter((p) => Number.isFinite(p) && p > 0);
  if (pct.length <= 1) return "Winner takes all";
  const ord = ["1st", "2nd", "3rd", "4th", "5th", "6th"];
  return pct.map((p, i) => `${ord[i] ?? `${i + 1}th`} ${p}%`).join(" · ");
}

export type StatusTone = "fairway" | "sky" | "hazard" | "ghost" | "neutral";

/** Badge text + tone for a pot. "won" while not final is only a projection. */
export function potStatus(pot: PotView, final: boolean): { label: string; tone: StatusTone } {
  switch (pot.status) {
    case "won":
      return final ? { label: "Won", tone: "fairway" } : { label: pot.type === "team_match" ? "Projected" : "Leading", tone: "sky" };
    case "rolled":
      return { label: "Rolled", tone: "ghost" };
    case "refunded":
      return { label: "Refunded", tone: "neutral" };
    default:
      return { label: "Up for grabs", tone: "hazard" };
  }
}

/** Players on a team who opted out of this pot (roster order). */
export function sittingOut(pot: PotView, derived: Pick<Derived, "players" | "teamOfPlayer">): Player[] {
  const inPot = new Set(pot.participants);
  return derived.players.filter((p) => derived.teamOfPlayer[p.id] !== undefined && !inPot.has(p.id));
}

export interface PayoutGroup {
  team_id: UUID;
  /** Standings label for the team ("1", "T2", ...). */
  pos_label: string;
  pos: number;
  /** Members of this team in the pot's payouts, with their amounts (roster order). */
  members: { player_id: UUID; cents: number }[];
  /** Sum of members' payouts. */
  total_cents: number;
}

/** Team-match payouts grouped by team, best position first. */
export function teamPayoutGroups(
  pot: PotView,
  teamOfPlayer: Record<UUID, UUID>,
  standings: readonly StandingRow[],
): PayoutGroup[] {
  const groups = new Map<UUID, PayoutGroup>();
  for (const pid of pot.winners) {
    const cents = pot.payouts[pid] ?? 0;
    const teamId = teamOfPlayer[pid];
    if (!teamId) continue;
    let g = groups.get(teamId);
    if (!g) {
      const row = standings.find((r) => r.team_id === teamId);
      g = { team_id: teamId, pos_label: row?.pos_label ?? "–", pos: row?.pos ?? 99, members: [], total_cents: 0 };
      groups.set(teamId, g);
    }
    g.members.push({ player_id: pid, cents });
    g.total_cents += cents;
  }
  return [...groups.values()].sort((a, b) => a.pos - b.pos || b.total_cents - a.total_cents);
}

/** Ledger sorted by net (biggest winner first); ties keep roster order. */
export function sortLedger(ledger: readonly LedgerRow[]): LedgerRow[] {
  return ledger
    .map((row, i) => ({ row, i }))
    .sort((a, b) => b.row.net_cents - a.row.net_cents || b.row.winnings_cents - a.row.winnings_cents || a.i - b.i)
    .map((x) => x.row);
}

export function ledgerNetSum(ledger: readonly LedgerRow[]): number {
  return ledger.reduce((s, r) => s + r.net_cents, 0);
}

/** Payments involving me first (what I owe, then what I'm owed), otherwise the engine's order. */
export function orderPayments(payments: readonly Payment[], meId: UUID | null): Payment[] {
  const rank = (p: Payment) => (meId && p.from_player_id === meId ? 0 : meId && p.to_player_id === meId ? 1 : 2);
  return payments
    .map((p, i) => ({ p, i }))
    .sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i)
    .map((x) => x.p);
}

export interface MyPotRow {
  key: PotKey;
  label: string;
  emoji: string;
  ante_cents: number;
  /** In the pot (no active opt-out row). */
  in: boolean;
}

/** Every pot with my in/out state, from the raw opt-out rows (works before I'm on a team). */
export function myPots(view: Pick<TripState, "pot_optouts">, pots: readonly PotView[], meId: UUID | null): MyPotRow[] {
  const out = new Set(
    view.pot_optouts.filter((o) => o.deleted_at === null && meId !== null && o.player_id === meId).map((o) => o.pot_key as string),
  );
  return pots.map((p) => ({
    key: p.key,
    label: p.label,
    emoji: p.type === "team_match" ? "🏆" : CONTEST_EMOJI[p.contest_type ?? "ctp"],
    ante_cents: p.ante_cents,
    in: !out.has(p.key),
  }));
}

/** Sum of every pot's own antes (rolled money counted once): the whole prize pool if every pot resolves. */
export function totalAntes(pots: readonly PotView[]): number {
  return pots.reduce((s, p) => s + p.base_cents, 0);
}

/** "+$12.50" / "-$5" / "$0" */
export function signedCents(cents: number, format: (c: number) => string): string {
  if (cents > 0) return `+${format(cents)}`;
  return format(cents);
}

/**
 * When the results changed after the final whistle (a late sync from the course or a commissioner
 * fix posted results_changed after this finalize): the newest such post's time, else null. People
 * may already have paid off the old numbers, so the Money tab says so.
 */
export function resultsChangedSinceFinal(
  trip: Pick<Trip, "status" | "finalized_at">,
  events: readonly Pick<FeedEvent, "type" | "created_at" | "deleted_at">[],
): ISODate | null {
  if (trip.status !== "final" || !trip.finalized_at) return null;
  const finalizedMs = Date.parse(trip.finalized_at);
  let latest: ISODate | null = null;
  for (const e of events) {
    if (e.type !== "results_changed" || e.deleted_at !== null) continue;
    const t = Date.parse(e.created_at);
    if (!(t >= finalizedMs)) continue;
    if (latest === null || t > Date.parse(latest)) latest = e.created_at;
  }
  return latest;
}
