// View-model for the Contests tab (pure; unit tested in tests/ui/contests-flow.test.ts).
// Everything comes from derive(): contest summaries, pots, roster.
import type { ContestEntry, ContestKind, UUID } from "@/lib/types";
import type { ContestEntryView, ContestHoleSummary, Derived, PotView } from "@/lib/engine/types";
import { formatCents, formatFeetInches } from "@/lib/engine/format";
import type { BadgeTone } from "@/components/ui";
import { displayName } from "@/components/ui/PlayerName";

export const CONTEST_LABEL: Record<ContestKind, string> = { ctp: "Closest to pin", ld: "Long drive" };
export const CONTEST_EMOJI: Record<ContestKind, string> = { ctp: "🎯", ld: "💥" };

/** "4' 6"" for ctp, "287 yd" for ld. */
export function formatContestDistance(type: ContestKind, distance: number): string {
  return type === "ctp" ? formatFeetInches(distance) : `${Math.round(distance)} yd`;
}

export interface EntryBadge {
  key: string;
  tone: BadgeTone;
  label: string;
}

/** Status chips for an entry row: commissioner review, weak GPS, out of range, approved, AI flag. */
export function entryBadges(v: ContestEntryView): EntryBadge[] {
  const e = v.entry;
  const out: EntryBadge[] = [];
  if (e.status === "overridden") out.push({ key: "approved", tone: "fairway", label: "✅ Commish approved" });
  if (e.status === "flagged") out.push({ key: "review", tone: "hazard", label: "⚖️ Commish review" });
  if (v.type === "ld" && e.low_accuracy) out.push({ key: "gps", tone: "outline", label: "📡 Weak GPS" });
  if (e.status === "ok" && !v.valid && v.invalid_reason?.startsWith("Out of range")) out.push({ key: "range", tone: "flag", label: "Out of range" });
  if (v.suspicious) out.push({ key: "sus", tone: "flag", label: "🚩 AI says sus" });
  return out;
}

/** One line explaining why an entry doesn't count (or how its official distance was set). */
export function entryNote(v: ContestEntryView): string | null {
  const e = v.entry;
  if (!v.valid) return v.invalid_reason;
  if (e.status === "overridden" && e.distance_override !== null) {
    const measured = v.type === "ctp" ? e.distance_value : Math.round(e.distance_value);
    if (Math.abs(measured - e.distance_override) > 1e-9) {
      return `Official distance set by the commish (entered ${formatContestDistance(v.type, measured)}).`;
    }
  }
  return null;
}

export interface AiVerdict {
  /** "~6' 2" · medium confidence" */
  estimate: string | null;
  roast: string | null;
  suspicious: boolean;
}

/** The AI judge's take (closest to pin), null when the judge hasn't weighed in. */
export function aiVerdict(e: Pick<ContestEntry, "ai_estimate_ft" | "ai_confidence" | "ai_roast" | "ai_suspicious">): AiVerdict | null {
  const hasEstimate = e.ai_estimate_ft !== null && Number.isFinite(e.ai_estimate_ft);
  const roast = e.ai_roast?.trim() || null;
  if (!hasEstimate && !roast) return null;
  return {
    estimate: hasEstimate ? `~${formatFeetInches(e.ai_estimate_ft as number)}${e.ai_confidence ? ` · ${e.ai_confidence} confidence` : ""}` : null,
    roast,
    suspicious: e.ai_suspicious === true,
  };
}

export interface PotInfo {
  /** "$40", null when there's no money on this hole. */
  amount: string | null;
  /** "Rolled to #8", "Incl. $20 rollover", "Refunded", or null. */
  note: string | null;
  status: PotView["status"] | null;
}

export function potInfo(pots: readonly PotView[], hole: number): PotInfo {
  const pot = pots.find((p) => p.key === `contest:${hole}`);
  if (!pot) return { amount: null, note: null, status: null };
  const amount = pot.total_cents > 0 ? formatCents(pot.total_cents) : null;
  let note: string | null = null;
  if (pot.status === "rolled") {
    const to = pot.rolled_to;
    note = to === "team_match" ? "Rolled into the team match" : to ? `Rolled to #${to.slice("contest:".length)}` : "Rolled over";
  } else if (pot.status === "refunded") {
    note = "Nobody won. Refunded.";
  } else if (pot.rollover_in_cents > 0) {
    note = `Incl. ${formatCents(pot.rollover_in_cents)} rollover`;
  }
  return { amount, note, status: pot.status };
}

export interface PlotEntry {
  id: string;
  playerId: UUID;
  /** Label text on the plot ("Dave", "Dave 34'" when clamped beyond 30 ft). */
  name: string;
  feet: number;
  angle: number | null;
  leader: boolean;
  suspicious: boolean;
  valid: boolean;
  teamSortOrder: number | null;
  mine: boolean;
}

/**
 * Every entry for a ctp hole from every group, leader(s) first (label layout priority).
 * `excludePlayerId` drops that player's current entry (the sheet draws their new marker instead).
 */
export function plotEntries(
  summary: ContestHoleSummary | undefined,
  d: Pick<Derived, "playerById" | "teamById" | "teamOfPlayer">,
  opts: { meId?: UUID | null; excludePlayerId?: UUID | null } = {},
): PlotEntry[] {
  if (!summary || summary.type !== "ctp") return [];
  const leaders = new Set(summary.leader_ids);
  const rows = summary.entries
    .filter((v) => v.player_id !== opts.excludePlayerId)
    .map((v): PlotEntry => {
      const teamId = d.teamOfPlayer[v.player_id] ?? v.team_id;
      return {
        id: v.entry.id,
        playerId: v.player_id,
        name: displayName(d.playerById[v.player_id]),
        feet: v.distance,
        angle: v.entry.angle_deg,
        leader: v.valid && leaders.has(v.player_id),
        suspicious: v.suspicious,
        valid: v.valid,
        teamSortOrder: d.teamById[teamId]?.sort_order ?? null,
        mine: !!opts.meId && v.player_id === opts.meId,
      };
    });
  return [...rows.filter((r) => r.leader), ...rows.filter((r) => !r.leader)];
}

/** "Dave", "Dave & Mike", "Dave, Mike & Al". */
function namesOf(ids: readonly UUID[], d: Pick<Derived, "playerById">): string {
  const names = ids.map((id) => displayName(d.playerById[id]));
  return names.length > 2 ? `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}` : names.join(" & ");
}

/** "Dave & Mike at 4' 6"" / null. */
export function leaderLine(summary: ContestHoleSummary, d: Pick<Derived, "playerById">): string | null {
  if (summary.leader_ids.length === 0 || summary.best === null) return null;
  return `${namesOf(summary.leader_ids, d)} at ${formatContestDistance(summary.type, summary.best)}`;
}

/**
 * Who actually takes the hole's pot, when that isn't the contest leader (the leader sat this pot
 * out): "Pot → Dave (Mike opted out)". null when the pot goes to the leader(s) or nobody leads.
 * The pot's winners come from derived.money, so this always agrees with the Money tab.
 */
export function potWinnerLine(summary: ContestHoleSummary, pots: readonly PotView[], d: Pick<Derived, "playerById">): string | null {
  const pot = pots.find((p) => p.key === `contest:${summary.hole}`);
  if (!pot || summary.leader_ids.length === 0) return null;
  const winners = pot.status === "won" ? pot.winners : [];
  const same = winners.length === summary.leader_ids.length && winners.every((id) => summary.leader_ids.includes(id));
  if (same) return null;
  const out = summary.leader_ids.filter((id) => !pot.participants.includes(id));
  const why = out.length > 0 ? ` (${namesOf(out, d)} opted out)` : "";
  if (winners.length > 0) return `Pot → ${namesOf(winners, d)}${why}`;
  if (pot.status === "rolled") return `Pot rolls on${why}`;
  if (pot.status === "refunded") return `Pot refunded${why}`;
  return `Pot → nobody yet${why}`;
}

/** The player's active entry on a hole (as the engine sees it), if any. */
export function entryOf(summary: ContestHoleSummary | undefined, playerId: UUID | null): ContestEntryView | null {
  if (!summary || !playerId) return null;
  return summary.entries.find((v) => v.player_id === playerId) ?? null;
}

/** Cards sorted for the tab: by hole. Counts for the header. */
export function contestCounts(contests: readonly ContestHoleSummary[]): { entries: number; review: number; sus: number } {
  let entries = 0;
  let review = 0;
  let sus = 0;
  for (const c of contests) {
    entries += c.entries.length;
    for (const v of c.entries) {
      if (!v.valid) review += 1;
      if (v.suspicious) sus += 1;
    }
  }
  return { entries, review, sus };
}
