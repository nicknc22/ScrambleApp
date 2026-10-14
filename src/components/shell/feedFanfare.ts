// Which incoming feed events deserve a full-screen fanfare on THIS phone. Pure.
// The shell shows fanfares for things other people caused; the Play screen fires its own
// fanfare instantly for the local user's actions (so we skip events whose actor is "me"), and
// Setup fires the commissioner's own "Round is live" (so round_started skips the commissioner).
import type { FeedEvent } from "@/lib/types";
import type { FanfareOptions } from "@/components/ui/Fanfare";

export interface FeedFanfareContext {
  meId: string | null;
  myTeamId: string | null;
  /** This phone is the commissioner's (it already showed its own "Round is live" fanfare). */
  isCommissioner?: boolean;
  /** Server "now" for the snapshot the event arrived in (ms epoch). */
  nowMs: number;
  /** Rendered copy for the event (renderFeedEvent), or null if rendering failed. */
  render?: (ev: FeedEvent) => { emoji: string; title: string; body: string } | null;
}

/** Older events (a phone coming back online after an hour) don't get fanfare. */
export const FANFARE_MAX_AGE_MS = 3 * 60_000;

export function fanfareForEvent(ev: FeedEvent, ctx: FeedFanfareContext): FanfareOptions | null {
  if (ev.deleted_at) return null;
  if (ctx.meId && ev.actor_id === ctx.meId) return null;
  const created = Date.parse(ev.created_at);
  if (!Number.isFinite(created) || ctx.nowMs - created > FANFARE_MAX_AGE_MS) return null;

  let copy: { emoji: string; title: string; body: string } | null = null;
  try {
    copy = ctx.render?.(ev) ?? null;
  } catch {
    copy = null;
  }

  switch (ev.type) {
    case "round_started":
      // Every player phone sitting on the pre-round screen flips to Play: say what to do first.
      if (ctx.isCommissioner) return null;
      return {
        key: ev.id,
        tone: "hype",
        emoji: "⛳",
        title: "We're live!",
        subtitle: "When your group's on the first tee, hit the big yellow button. Every drink after that knocks a stroke off.",
      };
    case "groom_mulligan":
      return {
        key: ev.id,
        tone: "groom",
        emoji: "👑",
        title: "Groom's Mulligan",
        subtitle: copy?.body || "The groom has invoked his divine right to a do-over. Kneel.",
      };
    case "ghost_beer":
      if (!ctx.myTeamId || ev.team_id !== ctx.myTeamId) return null;
      return {
        key: ev.id,
        tone: "ghost",
        emoji: "👻",
        title: "Ghost beer",
        subtitle: copy?.body || "That one counted double. The ghost of a fourth drinker thanks you.",
      };
    case "final_results":
      return {
        key: ev.id,
        tone: "hype",
        emoji: "🏆",
        title: "Final results",
        subtitle: copy?.body || "It's official. Check the Awards and settle your debts.",
      };
    default:
      return null;
  }
}
