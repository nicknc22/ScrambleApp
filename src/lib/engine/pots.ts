// Pots, payouts, ledger and settle-up. See spec "Pots, settle-up and Venmo links".
//
// Pots are virtual: "team_match" plus "contest:<hole>" for every contest hole. Everything here is
// recomputed from raw rows, so it is a live projection until the commissioner finalizes.
//
// Rules (beyond the spec, decided here):
// - Participants: active players on an active team, minus active opt-out rows for the pot.
// - Contest pot: won by the best valid entry among its participants (ties split). With no such
//   entry it rolls once the hole is closed (every playing team past it, or trip final) into the
//   next contest hole of the same type, else into the team match. Otherwise it is pending.
//   Holes are resolved in ascending order, so chains work (3 -> 8 -> 11 -> 16 -> team match).
// - Team match: teams with >= 1 participant, ranked by standings pos (ties share). Place k gets
//   floor(total * pct_k / 100), remainder cents to 1st. Fewer teams than places: the unused
//   percentages go to the last occupied place group. Tied teams pool their places and split per
//   participating member. Nobody in the pot (but teams have started / trip final): refunded.
// - Refund: a refunded pot pays every participant of each pot that ended up in it (itself and
//   everything that rolled into it) their ante back. So refunds exactly cancel those antes.
// - Ledger: a pot's antes are charged only when the pot its money finally lands in is resolved
//   (won/refunded). Money sitting in a pending pot (directly or via rollover) is not charged and
//   not paid out, so the ledger always sums to exactly 0.
import type { ContestKind, Player, PotKey, TripState, UUID } from "../types";
import type { ContestHoleSummary, LedgerRow, MoneySummary, PotView, StandingRow } from "./types";
import { contestScore } from "./contests";
import { settleUp, splitCents } from "./settle";

const CONTEST_LABEL: Record<ContestKind, string> = { ctp: "Closest to pin", ld: "Long drive" };

/** Split order for remainder cents: sort_order, then id (deterministic on every device). */
function compareSortOrderId(a: Player, b: Player): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Non-negative whole cents; garbage settings become 0 rather than poisoning the ledger. */
function cents(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Payout percentages by place. Invalid input falls back to winner-take-all. */
function payoutPercents(raw: number[] | null | undefined): number[] {
  const pct = (Array.isArray(raw) ? raw : []).map((p) => (typeof p === "number" && Number.isFinite(p) && p > 0 ? p : 0));
  return pct.reduce((s, p) => s + p, 0) > 0 ? pct : [100];
}

/**
 * Pots, payouts, ledger and settle-up. All money in integer cents; every split
 * distributes remainder cents deterministically so the ledger sums to exactly 0.
 */
export function computeMoney(
  state: TripState,
  standings: StandingRow[],
  contests: ContestHoleSummary[],
  teamOfPlayer: Record<UUID, UUID>,
): MoneySummary {
  const final = state.trip.status === "final";
  const settings = state.trip.settings;
  const activeTeams = new Set(state.teams.filter((t) => t.deleted_at === null).map((t) => t.id));

  // Everyone in the money game: active players on an active team, in split order.
  const players = state.players
    .filter((p) => p.deleted_at === null && teamOfPlayer[p.id] !== undefined && activeTeams.has(teamOfPlayer[p.id]))
    .sort(compareSortOrderId);
  const orderOf = new Map(players.map((p, i) => [p.id, i]));
  const inOrder = (ids: Iterable<UUID>): UUID[] =>
    [...new Set(ids)].filter((id) => orderOf.has(id)).sort((a, b) => orderOf.get(a)! - orderOf.get(b)!);

  const optedOut = new Map<string, Set<UUID>>();
  for (const o of state.pot_optouts) {
    if (o.deleted_at !== null) continue;
    let set = optedOut.get(o.pot_key);
    if (!set) optedOut.set(o.pot_key, (set = new Set()));
    set.add(o.player_id);
  }

  const newPot = (
    key: PotKey,
    label: string,
    ante: number,
    hole: number | null,
    contestType: ContestKind | null,
  ): PotView => {
    const out = optedOut.get(key);
    const participants = players.filter((p) => !out?.has(p.id)).map((p) => p.id);
    const base = ante * participants.length;
    return {
      key,
      type: hole === null ? "team_match" : "contest",
      hole,
      contest_type: contestType,
      label,
      ante_cents: ante,
      participants,
      base_cents: base,
      rollover_in_cents: 0,
      rolled_from: [],
      total_cents: base,
      status: "pending",
      rolled_to: null,
      winners: [],
      payouts: {},
    };
  };

  const teamMatch = newPot("team_match", "Team match", cents(settings.team_match_ante_cents), null, null);
  const sortedContests = contests.slice().sort((a, b) => a.hole - b.hole);
  const contestPots = sortedContests.map((s) =>
    newPot(s.pot_key, `Hole ${s.hole} · ${CONTEST_LABEL[s.type]}`, cents(settings.contest_ante_cents), s.hole, s.type),
  );
  const potByKey = new Map<PotKey, PotView>([[teamMatch.key, teamMatch]]);
  for (const p of contestPots) potByKey.set(p.key, p);

  // --- Contest pots, ascending by hole. Rollovers only move forward, so a pot's rollover_in is
  // complete by the time it is resolved.
  sortedContests.forEach((s, i) => {
    const pot = contestPots[i];
    pot.total_cents = pot.base_cents + pot.rollover_in_cents;
    const inPot = new Set(pot.participants);
    const eligible = s.entries.filter((v) => v.valid && inPot.has(v.player_id));
    if (eligible.length > 0) {
      const best = Math.min(...eligible.map((v) => contestScore(s.type, v.distance)));
      pot.status = "won";
      pot.winners = inOrder(eligible.filter((v) => contestScore(s.type, v.distance) === best).map((v) => v.player_id));
      pot.payouts = splitCents(pot.total_cents, pot.winners);
    } else if (s.closed || final) {
      const next = sortedContests.findIndex((n, j) => j > i && n.type === s.type);
      const target = next >= 0 ? contestPots[next] : teamMatch;
      pot.status = "rolled";
      pot.rolled_to = target.key;
      target.rollover_in_cents += pot.total_cents;
      target.rolled_from.push(pot.key);
    } else {
      pot.status = "pending";
    }
  });

  // --- Team match.
  teamMatch.total_cents = teamMatch.base_cents + teamMatch.rollover_in_cents;
  const membersInPot = new Map<UUID, UUID[]>();
  for (const pid of teamMatch.participants) {
    const teamId = teamOfPlayer[pid];
    const list = membersInPot.get(teamId);
    if (list) list.push(pid);
    else membersInPot.set(teamId, [pid]);
  }
  const ranked = standings.filter((r) => (membersInPot.get(r.team_id)?.length ?? 0) > 0);

  if (ranked.length === 0) {
    // Nobody can win the team match. Once play has started (or the trip is final) give the money back.
    teamMatch.status = final || standings.some((r) => r.thru > 0) ? "refunded" : "pending";
  } else if (!final && !ranked.some((r) => r.thru > 0)) {
    teamMatch.status = "pending";
  } else {
    teamMatch.status = "won";
    // Place groups: consecutive rows sharing a position are tied.
    const groups: StandingRow[][] = [];
    for (const r of ranked) {
      const last = groups[groups.length - 1];
      if (last && last[0].pos === r.pos && (last[0].thru > 0) === (r.thru > 0)) last.push(r);
      else groups.push([r]);
    }

    const pct = payoutPercents(settings.team_match_payout);
    const pctSum = pct.reduce((s, p) => s + p, 0);
    const pools = pct.map((p) => Math.floor((teamMatch.total_cents * p) / pctSum));
    pools[0] += teamMatch.total_cents - pools.reduce((s, c) => s + c, 0);

    let place = 0;
    const groupShare = groups.map((g) => {
      let amount = 0;
      let share = 0;
      for (let k = place; k < place + g.length && k < pools.length; k++) {
        amount += pools[k];
        share += pct[k];
      }
      place += g.length;
      return { amount, share };
    });
    // Fewer teams than paid places: the unused places go to the last occupied place group.
    for (let k = place; k < pools.length; k++) {
      groupShare[groupShare.length - 1].amount += pools[k];
      groupShare[groupShare.length - 1].share += pct[k];
    }

    const winners: UUID[] = [];
    groups.forEach((g, gi) => {
      const { amount, share } = groupShare[gi];
      if (amount <= 0 && share <= 0) return;
      // Tied teams pool their places and split per participating member.
      const members = inOrder(g.flatMap((r) => membersInPot.get(r.team_id) ?? []));
      const split = splitCents(amount, members);
      for (const pid of members) {
        teamMatch.payouts[pid] = (teamMatch.payouts[pid] ?? 0) + split[pid];
        winners.push(pid);
      }
    });
    teamMatch.winners = winners;
  }

  const allPots = [teamMatch, ...contestPots];

  /** The pot a pot's money finally lands in (follows the rollover chain). */
  const destination = (pot: PotView): PotView => {
    let p = pot;
    for (let guard = 0; p.status === "rolled" && p.rolled_to !== null && guard <= allPots.length; guard++) {
      p = potByKey.get(p.rolled_to) ?? p;
    }
    return p;
  };

  if (teamMatch.status === "refunded") {
    const refunds: Record<UUID, number> = {};
    for (const p of allPots) {
      if (destination(p) !== teamMatch) continue;
      for (const pid of p.participants) refunds[pid] = (refunds[pid] ?? 0) + p.ante_cents;
    }
    teamMatch.winners = inOrder(Object.keys(refunds));
    teamMatch.payouts = {};
    for (const pid of teamMatch.winners) teamMatch.payouts[pid] = refunds[pid];
  }

  // --- Ledger.
  const antes = new Map<UUID, number>();
  const winnings = new Map<UUID, number>();
  for (const p of allPots) {
    if (destination(p).status === "pending") continue; // money not in play yet
    for (const pid of p.participants) antes.set(pid, (antes.get(pid) ?? 0) + p.ante_cents);
    if (p.status === "won" || p.status === "refunded") {
      for (const [pid, c] of Object.entries(p.payouts)) winnings.set(pid, (winnings.get(pid) ?? 0) + c);
    }
  }
  const ledger: LedgerRow[] = players.map((p) => {
    const a = antes.get(p.id) ?? 0;
    const w = winnings.get(p.id) ?? 0;
    return { player_id: p.id, antes_cents: a, winnings_cents: w, net_cents: w - a };
  });

  const total_in_play_cents = allPots
    .filter((p) => p.status === "won" || p.status === "refunded")
    .reduce((s, p) => s + p.total_cents, 0);

  return {
    final,
    pots: allPots,
    ledger,
    payments: settleUp(ledger, players.map((p) => p.id)),
    total_in_play_cents,
  };
}
