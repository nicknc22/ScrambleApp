// Pure view-model helpers for the Feed tab: ordering, filters, relative times, reactions,
// permissions. No React, no I/O.
import { REACTION_KINDS, type FeedEvent, type FeedEventType, type ReactionKind, type Reaction, type UUID } from "@/lib/types";
import type { FeedTone } from "@/lib/events/templates";

export const FEED_PAGE_SIZE = 50;
export const MAX_POST_CHARS = 1000;

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Events created by the same op (or the same sync batch) share created_at. Inside such a group,
 * newest-first reads best with consequences above causes: the lead change above the birdie that
 * caused it, the ghost beer above the drink. Higher rank = shown first.
 */
export const TYPE_RANK: Readonly<Record<FeedEventType, number>> = {
  // A late sync changed the final results: it supersedes (and sits above) FINAL RESULTS.
  results_changed: 105,
  final_results: 100,
  commissioner_override: 95,
  lead_change: 90,
  contest_lead: 85,
  roast: 82,
  groom_mulligan: 80,
  ghost_beer: 75,
  round_complete: 70,
  drive_miss: 65,
  drive_warning: 60,
  ai_judge: 55,
  score_notable: 50,
  score_edit: 45,
  removed: 44,
  contest_entry: 42,
  mulligan_used: 40,
  shotgun: 38,
  shot: 38,
  drinks: 35,
  tee_off: 20,
  round_started: 10,
  post: 5,
};

function timeOf(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function holeOf(ev: FeedEvent): number {
  const h = (ev.payload as Record<string, unknown> | null)?.hole;
  return typeof h === "number" && Number.isFinite(h) ? h : 0;
}

/**
 * Active (not deleted) events, newest first. Ties on created_at: type rank desc, then
 * updated_at desc, then hole desc, then the row's position in `events` reversed (later = newer).
 */
export function sortFeed(events: readonly FeedEvent[]): FeedEvent[] {
  const rows: { ev: FeedEvent; i: number; c: number; u: number }[] = [];
  events.forEach((ev, i) => {
    if (ev.deleted_at) return;
    rows.push({ ev, i, c: timeOf(ev.created_at), u: timeOf(ev.updated_at) });
  });
  rows.sort(
    (a, b) =>
      b.c - a.c ||
      (TYPE_RANK[b.ev.type] ?? 0) - (TYPE_RANK[a.ev.type] ?? 0) ||
      b.u - a.u ||
      holeOf(b.ev) - holeOf(a.ev) ||
      b.i - a.i,
  );
  return rows.map((r) => r.ev);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type FeedFilter = "all" | "photos" | "scores" | "drinks" | "roasts";

export const FEED_FILTERS: readonly { value: FeedFilter; label: string; emoji: string }[] = [
  { value: "all", label: "All", emoji: "📣" },
  { value: "photos", label: "Photos", emoji: "📸" },
  { value: "scores", label: "Scores", emoji: "⛳" },
  { value: "drinks", label: "Drinks", emoji: "🍺" },
  { value: "roasts", label: "Roasts", emoji: "🔥" },
];

const SCORE_TYPES: ReadonlySet<FeedEventType> = new Set<FeedEventType>([
  "round_started",
  "tee_off",
  "score_notable",
  "score_edit",
  "lead_change",
  "contest_entry",
  "contest_lead",
  "ai_judge",
  "drive_warning",
  "drive_miss",
  "round_complete",
  "final_results",
  "results_changed",
]);

const DRINK_TYPES: ReadonlySet<FeedEventType> = new Set<FeedEventType>([
  "drinks",
  "shotgun",
  "shot",
  "ghost_beer",
  "mulligan_used",
  "groom_mulligan",
]);

/** A "removed" event files under what was removed: drinks and mulligans -> Drinks, contest entries -> Scores. */
function removedFilter(ev: FeedEvent): "scores" | "drinks" {
  const kind = (ev.payload as Record<string, unknown> | null)?.kind;
  return kind === "contest_entry" ? "scores" : "drinks";
}

/** Does the event belong in this filter? `tone` is the rendered tone (roasts include templated burns). */
export function matchesFilter(ev: FeedEvent, filter: FeedFilter, tone?: FeedTone): boolean {
  switch (filter) {
    case "all":
      return true;
    case "photos":
      return !!ev.photo_path;
    case "scores":
      return SCORE_TYPES.has(ev.type) || (ev.type === "removed" && removedFilter(ev) === "scores");
    case "drinks":
      return DRINK_TYPES.has(ev.type) || (ev.type === "removed" && removedFilter(ev) === "drinks");
    case "roasts":
      // results_changed is roast-free by design, whatever its template tone.
      return ev.type === "roast" || (tone === "roast" && ev.type !== "results_changed");
  }
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * "now" (< 1 min), "5m", "3h", "2d", then "Oct 24". Future timestamps (clock skew) read "now".
 */
export function relativeTime(iso: string, nowMs: number): string {
  const t = timeOf(iso);
  if (!t) return "";
  const sec = Math.floor((nowMs - t) / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const d = new Date(t);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * The clock relative times are measured against: the device clock, but never behind the last
 * snapshot's server_time (a phone whose clock lags would otherwise show "now" forever).
 */
export function feedNow(clientNowMs: number, serverTime: string | null | undefined): number {
  const s = timeOf(serverTime);
  return Math.max(clientNowMs, s);
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

export interface ReactionSummary {
  counts: Record<ReactionKind, number>;
  /** Kinds the viewer has on. */
  mine: Set<ReactionKind>;
  /** Player ids per kind (for "who reacted"). */
  who: Record<ReactionKind, UUID[]>;
  total: number;
}

function emptyCounts(): Record<ReactionKind, number> {
  return { fire: 0, lol: 0, beer: 0, dead: 0, goat: 0, clown: 0 };
}

function emptyWho(): Record<ReactionKind, UUID[]> {
  return { fire: [], lol: [], beer: [], dead: [], goat: [], clown: [] };
}

export function emptyReactionSummary(): ReactionSummary {
  return { counts: emptyCounts(), mine: new Set(), who: emptyWho(), total: 0 };
}

/** feed_event_id -> active reactions summary. Unknown kinds and deleted rows are ignored. */
export function summarizeReactions(reactions: readonly Reaction[], meId: UUID | null): Map<UUID, ReactionSummary> {
  const out = new Map<UUID, ReactionSummary>();
  // Unique (event, player, kind) is enforced by the reducer; dedupe defensively anyway.
  const seen = new Set<string>();
  for (const r of reactions) {
    if (r.deleted_at) continue;
    if (!REACTION_KINDS.includes(r.kind)) continue;
    const key = `${r.feed_event_id}|${r.player_id}|${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let s = out.get(r.feed_event_id);
    if (!s) out.set(r.feed_event_id, (s = emptyReactionSummary()));
    s.counts[r.kind] += 1;
    s.who[r.kind].push(r.player_id);
    s.total += 1;
    if (meId && r.player_id === meId) s.mine.add(r.kind);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Permissions & misc
// ---------------------------------------------------------------------------

/** The commissioner can delete anything; authors can delete their own posts. */
export function canDeleteEvent(ev: Pick<FeedEvent, "type" | "player_id">, meId: UUID | null, isCommissioner: boolean): boolean {
  if (isCommissioner) return true;
  return ev.type === "post" && meId !== null && ev.player_id === meId;
}

/** Deleting this needs commissioner powers (not the author's own post). */
export function deleteNeedsCommissioner(ev: Pick<FeedEvent, "type" | "player_id">, meId: UUID | null): boolean {
  return !(ev.type === "post" && meId !== null && ev.player_id === meId);
}

/** Trimmed post text, or null when empty. */
export function cleanPostText(text: string): string | null {
  const t = text.trim();
  return t.length > 0 ? t : null;
}

/** Can the composer submit? */
export function canSubmitPost(text: string, hasPhoto: boolean): boolean {
  const t = text.trim();
  if (t.length > MAX_POST_CHARS) return false;
  return t.length > 0 || hasPhoto;
}

/** CSS aspect ratio for a photo, clamped so tall shots don't eat the screen and panoramas stay visible. */
export function photoAspect(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 4 / 3;
  const r = width / height;
  return Math.min(16 / 9, Math.max(4 / 5, r));
}

// ---------------------------------------------------------------------------
// Photos from other phones
// ---------------------------------------------------------------------------

/**
 * Ops never wait for their photo, so other phones routinely see a photo before its bytes exist
 * (the upload is still crawling up from the course). A photo on an event younger than this reads
 * "on its way", not "didn't load".
 */
export const PHOTO_RECENT_MS = 5 * 60_000;

/** Waits between automatic retries of a photo that didn't load: about 3 minutes in all. */
export const PHOTO_RETRY_DELAYS_MS: readonly number[] = [3_000, 5_000, 8_000, 12_000, 20_000, 30_000, 45_000, 60_000];

/** Wait before the next automatic retry after `failures` failed loads; null = stop (a new snapshot or a tap still retries). */
export function photoRetryDelay(failures: number): number | null {
  if (failures < 1) return null;
  return PHOTO_RETRY_DELAYS_MS[failures - 1] ?? null;
}

/** A fresh snapshot retries a failed photo, but not more often than this. */
export const PHOTO_REFRESH_RETRY_MIN_MS = 4_000;

export function isRecentEvent(createdAt: string, nowMs: number): boolean {
  const t = timeOf(createdAt);
  return t > 0 && nowMs - t < PHOTO_RECENT_MS;
}

/** What a photo box says while there is nothing to show. */
export function photoPlaceholder(opts: { uploadingHere: boolean; recent: boolean }): { emoji: string; text: string; state: "uploading" | "coming" | "failed" } {
  if (opts.uploadingHere) return { emoji: "⏫", text: "Uploading…", state: "uploading" };
  if (opts.recent) return { emoji: "⏳", text: "Photo on its way…", state: "coming" };
  return { emoji: "📷", text: "Photo didn't load. Tap to retry.", state: "failed" };
}

// ---------------------------------------------------------------------------
// Card look
// ---------------------------------------------------------------------------

export type CardVariant =
  | "post"
  | "ai_roast"
  | "override"
  | "results_changed"
  | "removed"
  | "ghost"
  | "groom"
  | "final"
  | "lead"
  | "hype"
  | "roast"
  | "alert"
  | "fanfare"
  | "info";

/** Variants that always render as a big card, whatever the template says. */
export const ALWAYS_BIG: ReadonlySet<CardVariant> = new Set<CardVariant>(["results_changed"]);

/** Which card style an event gets: type-specific looks first, then the template's tone. */
export function cardVariant(type: FeedEventType, tone: FeedTone): CardVariant {
  switch (type) {
    case "post":
      return "post";
    case "roast":
      return "ai_roast";
    case "commissioner_override":
      return "override";
    case "results_changed":
      return "results_changed";
    case "removed":
      return "removed";
    case "ghost_beer":
      return "ghost";
    case "groom_mulligan":
      return "groom";
    case "final_results":
      return "final";
    case "lead_change":
      return "lead";
    default:
      return tone;
  }
}
