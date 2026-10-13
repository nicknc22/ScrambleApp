// Web Push (server side). Spec "Push notifications": lead changes, contest lead changes, the
// Groom's Mulligan, AI judge flags, roasts aimed at your team and final results.
//
//   - VAPID keys: VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY, or (unset) a pair the server generates
//     once and keeps in the database (vapid.ts). VAPID_SUBJECT defaults to
//     mailto:scramble@example.com. PUSH_DISABLED=1 → push is off and everything here is a no-op.
//     Tests inject a fake sender.
//   - Subscriptions: push_subscriptions, one row per endpoint (upsert), scoped to a trip + player.
//   - sendToPlayers honors players.muted_push, throttles to one push per player per
//     settings.push_throttle_sec (push_log), collapses duplicates by collapse key (same key to the
//     same player within COLLAPSE_WINDOW_SEC is skipped; the key is also the notification tag and,
//     hashed, the push-service Topic, so a newer one replaces an undelivered/unread older one),
//     deletes subscriptions the push service says are gone (404/410) and never throws. Results
//     pushes (FINAL RESULTS, RESULTS CHANGED) are never throttled or collapsed (RESULTS_KEYS).
//   - pushHook delivers the PushTriggers a sync batch produced (post-commit, via integrations.ts).
import crypto from "node:crypto";
import { DEFAULT_SETTINGS, type Trip, type TripState, type UUID } from "@/lib/types";
import type { PushTrigger } from "@/lib/events/derive";
import { getDb, type Db } from "./db";
import { pushEnabled } from "./env";
import type { PostCommitContext } from "./hooks";
import { isUuid, readTripState } from "./repo";
import { getVapidKeys } from "./vapid";

/** Same collapse key to the same player within this window is a duplicate. */
export const COLLAPSE_WINDOW_SEC = 5 * 60;
/**
 * Results pushes skip the throttle and the collapse window: people pay from them, and the likely
 * moment for a change (dead-zone phones finding signal at the clubhouse, a quick re-finalize) is
 * right after the FINAL push. Each one is a real change, never a duplicate; the shared tag still
 * replaces the older notification on the phone.
 */
export const RESULTS_KEYS: ReadonlySet<string> = new Set(["final", "results_changed"]);
/** Push services drop a message nobody picked up after this long (a stale lead change is noise). */
export const PUSH_TTL_SEC = 30 * 60;
export const PUSH_SEND_TIMEOUT_MS = 5000;
/** Subscriptions kept per player (newest win): phone + tablet + a reinstall or two. */
export const MAX_SUBSCRIPTIONS_PER_PLAYER = 5;
const MAX_TITLE = 80;
const MAX_BODY = 240;

export function vapidSubject(): string {
  const v = process.env.VAPID_SUBJECT?.trim();
  return v ? v : "mailto:scramble@example.com";
}

/** Where a notification tap lands: the trip's feed. */
export function tripFeedUrl(code: string): string {
  return `/t/${encodeURIComponent(code)}?tab=feed`;
}

// ---------------------------------------------------------------------------
// Sender (web-push, or a test fake)
// ---------------------------------------------------------------------------

export interface PushSubscriptionLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendOptions {
  TTL: number;
  urgency: "very-low" | "low" | "normal" | "high";
  topic?: string;
  timeout: number;
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}

/** Resolves with the push service's status; rejects with an error carrying `statusCode` on failure. */
export type PushSender = (sub: PushSubscriptionLike, payload: string, options: PushSendOptions) => Promise<{ statusCode: number }>;

const G = globalThis as typeof globalThis & { __scramblePushSender?: PushSender | null };

/** Tests: deliver through `fn` instead of web-push. null restores web-push. */
export function setPushSenderForTests(fn: PushSender | null): void {
  G.__scramblePushSender = fn;
}

const webPushSender: PushSender = async (sub, payload, options) => {
  const mod = await import("web-push");
  const webpush = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const res = await webpush.sendNotification(sub, payload, options);
  return { statusCode: res.statusCode };
};

/** Push can be sent: not switched off with PUSH_DISABLED=1 (the VAPID keys come from vapid.ts). */
export function pushAvailable(): boolean {
  return pushEnabled();
}

function currentSender(): PushSender {
  return G.__scramblePushSender ?? webPushSender;
}

function statusOf(e: unknown): number | null {
  const s = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === "number" ? s : null;
}

/** Push-service Topic header: ≤ 32 chars of URL-safe base64. */
export function topicFor(collapseKey: string): string {
  return crypto.createHash("sha256").update(collapseKey).digest("base64url").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Hosts of the browser push services (Chrome/Android/Samsung/Opera: FCM; Safari/iOS: Apple;
 * Firefox: Mozilla; Edge: WNS). The server POSTs to whatever endpoint is stored, so anything
 * else is refused (no turning the server into a request cannon aimed at arbitrary URLs).
 */
const PUSH_HOST_SUFFIXES = ["googleapis.com", "push.apple.com", "push.services.mozilla.com", "notify.windows.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const KEY_RE = /^[A-Za-z0-9_\-+/=]{8,256}$/;

/** PushSubscription.toJSON() → a validated subscription, or null. */
export function parsePushSubscription(v: unknown): PushSubscriptionLike | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const endpoint = typeof o.endpoint === "string" ? o.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint)) return null;
  const keys = o.keys && typeof o.keys === "object" ? (o.keys as Record<string, unknown>) : null;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys?.auth === "string" ? keys.auth.trim() : "";
  if (!KEY_RE.test(p256dh) || !KEY_RE.test(auth)) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Store (or move) a subscription for a player of a trip, by endpoint. Keeps the newest
 * MAX_SUBSCRIPTIONS_PER_PLAYER per player. Returns false when the player isn't an active
 * player of the trip.
 */
export async function savePushSubscription(db: Db, tripId: UUID, playerId: UUID, sub: PushSubscriptionLike): Promise<boolean> {
  if (!isUuid(tripId) || !isUuid(playerId)) return false;
  return db.tx(async (t) => {
    const player = await t.query("select id from players where id = $1 and trip_id = $2 and deleted_at is null", [playerId, tripId]);
    if (player.length === 0) return false;
    await t.query(
      `insert into push_subscriptions (id, trip_id, player_id, endpoint, keys, created_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (endpoint) do update
         set trip_id = excluded.trip_id, player_id = excluded.player_id, keys = excluded.keys, created_at = now()`,
      [crypto.randomUUID(), tripId, playerId, sub.endpoint, sub.keys],
    );
    await t.query(
      `delete from push_subscriptions where id in (
         select id from push_subscriptions where trip_id = $1 and player_id = $2
         order by created_at desc, id offset $3)`,
      [tripId, playerId, MAX_SUBSCRIPTIONS_PER_PLAYER],
    );
    return true;
  });
}

/** Forget a subscription of this trip. Returns how many rows went away. */
export async function removePushSubscription(db: Db, tripId: UUID, endpoint: string): Promise<number> {
  if (!isUuid(tripId) || typeof endpoint !== "string" || !endpoint) return 0;
  const rows = await db.query("delete from push_subscriptions where trip_id = $1 and endpoint = $2 returning id", [tripId, endpoint]);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface PushMessage {
  title: string;
  body: string;
  /** Default: the trip's feed. */
  url?: string;
  /** Collapse key: duplicate suppression + notification tag + push-service topic. */
  tag?: string | null;
}

export interface PushReport {
  /** Players we sent to (at least one subscription accepted the message). */
  sent: UUID[];
  muted: UUID[];
  throttled: UUID[];
  collapsed: UUID[];
  /** Players with no subscription in this trip. */
  unsubscribed: UUID[];
  /** Deliveries that failed (per subscription). */
  failed: number;
  /** Subscriptions deleted because the push service said they're gone. */
  removed: number;
}

export interface SendDeps {
  db?: Db;
  /** Clock override (tests). */
  now?: Date;
}

const emptyReport = (): PushReport => ({ sent: [], muted: [], throttled: [], collapsed: [], unsubscribed: [], failed: 0, removed: 0 });

function clip(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

interface SubRow {
  id: UUID;
  player_id: UUID;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Push `msg` to these players of the trip. Muted, deleted, throttled, collapsed and unsubscribed
 * players are skipped. Never throws.
 */
export async function sendToPlayers(
  trip: Pick<Trip, "id" | "code"> & { settings?: Partial<Trip["settings"]> | null },
  playerIds: readonly UUID[],
  msg: PushMessage,
  deps: SendDeps = {},
): Promise<PushReport> {
  const report = emptyReport();
  try {
    if (!pushAvailable()) return report;
    const ids = [...new Set(playerIds.filter((id) => isUuid(id)))];
    if (ids.length === 0) return report;
    const db = deps.db ?? getDb();
    const keys = await getVapidKeys(db);
    if (!keys) return report;
    const now = deps.now ?? new Date();
    const throttleSec = Math.max(0, Number(trip.settings?.push_throttle_sec ?? DEFAULT_SETTINGS.push_throttle_sec) || 0);
    const collapseKey = msg.tag ? String(msg.tag).slice(0, 200) : null;
    const urgent = collapseKey !== null && RESULTS_KEYS.has(collapseKey);
    const windowSec = Math.max(throttleSec, collapseKey ? COLLAPSE_WINDOW_SEC : 0);
    const since = new Date(now.getTime() - windowSec * 1000).toISOString();
    const throttleSince = now.getTime() - throttleSec * 1000;

    // Decide and reserve under a per-trip push lock, so two concurrent senders can't both pass
    // the throttle check for the same player.
    const subs = await db.tx(async (t) => {
      await t.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`push:${trip.id}`]);
      const players = await t.query<{ id: UUID; muted_push: boolean }>(
        "select id, muted_push from players where trip_id = $1 and id = any($2::uuid[]) and deleted_at is null",
        [trip.id, ids],
      );
      const rows = await t.query<SubRow>(
        "select id, player_id, endpoint, keys from push_subscriptions where trip_id = $1 and player_id = any($2::uuid[]) order by created_at desc",
        [trip.id, ids],
      );
      const recent = await t.query<{ player_id: UUID; collapse_key: string | null; sent_at: string }>(
        "select player_id, collapse_key, sent_at from push_log where trip_id = $1 and player_id = any($2::uuid[]) and sent_at > $3",
        [trip.id, ids, since],
      );
      const subsOf = new Map<UUID, SubRow[]>();
      for (const r of rows) subsOf.set(r.player_id, [...(subsOf.get(r.player_id) ?? []), r]);

      const allowed: UUID[] = [];
      for (const p of players) {
        if (p.muted_push) {
          report.muted.push(p.id);
          continue;
        }
        if (!subsOf.has(p.id)) {
          report.unsubscribed.push(p.id);
          continue;
        }
        const mine = urgent ? [] : recent.filter((r) => r.player_id === p.id);
        if (collapseKey && mine.some((r) => r.collapse_key === collapseKey)) {
          report.collapsed.push(p.id);
          continue;
        }
        if (throttleSec > 0 && mine.some((r) => Date.parse(r.sent_at) > throttleSince)) {
          report.throttled.push(p.id);
          continue;
        }
        allowed.push(p.id);
      }
      if (allowed.length > 0) {
        await t.query(
          `insert into push_log (trip_id, player_id, collapse_key, sent_at)
           select $1::uuid, unnest($2::uuid[]), $3::text, $4::timestamptz`,
          [trip.id, allowed, collapseKey, now.toISOString()],
        );
      }
      // Housekeeping: the log only matters for a few minutes.
      await t.query("delete from push_log where trip_id = $1 and sent_at < $2", [trip.id, new Date(now.getTime() - 86_400_000).toISOString()]);
      return allowed.flatMap((id) => subsOf.get(id) ?? []);
    });
    if (subs.length === 0) return report;

    const payload = JSON.stringify({
      title: clip(msg.title, MAX_TITLE) || "Scramble",
      body: clip(msg.body, MAX_BODY),
      url: msg.url ?? tripFeedUrl(trip.code),
      ...(collapseKey ? { tag: collapseKey } : {}),
    });
    const options: PushSendOptions = {
      TTL: PUSH_TTL_SEC,
      urgency: "high",
      ...(collapseKey ? { topic: topicFor(collapseKey) } : {}),
      timeout: PUSH_SEND_TIMEOUT_MS,
      vapidDetails: { subject: vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
    };
    const send = currentSender();
    const gone: string[] = [];
    const delivered = new Set<UUID>();
    await Promise.all(
      subs.map(async (s) => {
        try {
          const res = await send({ endpoint: s.endpoint, keys: s.keys }, payload, options);
          if (res && typeof res.statusCode === "number" && res.statusCode >= 400) throw Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode });
          delivered.add(s.player_id);
        } catch (e) {
          report.failed++;
          const status = statusOf(e);
          if (status === 404 || status === 410) gone.push(s.endpoint);
          else console.warn(`[push] send to player ${s.player_id} failed: ${status ?? (e instanceof Error ? e.message : String(e))}`);
        }
      }),
    );
    report.sent = [...delivered];
    if (gone.length > 0) {
      try {
        const rows = await db.query("delete from push_subscriptions where trip_id = $1 and endpoint = any($2::text[]) returning id", [trip.id, gone]);
        report.removed = rows.length;
      } catch (e) {
        console.warn("[push] couldn't delete dead subscriptions", e);
      }
    }
    return report;
  } catch (e) {
    console.error(`[push] sending to trip ${trip.id} failed`, e);
    return report;
  }
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Players a trigger goes to: everyone active, or the active members of one team. */
export function audienceOf(state: TripState, audience: PushTrigger["audience"]): UUID[] {
  const active = new Set(state.players.filter((p) => p.deleted_at === null).map((p) => p.id));
  if (audience.kind === "all") return [...active];
  return state.team_members.filter((m) => m.team_id === audience.team_id && active.has(m.player_id)).map((m) => m.player_id);
}

/** Lower = more important (a player throttled after the first push should get the best one). */
function priorityOf(collapseKey: string): number {
  if (RESULTS_KEYS.has(collapseKey)) return 0;
  if (collapseKey === "groom") return 1;
  if (collapseKey === "lead") return 2;
  if (collapseKey.startsWith("judge:")) return 3;
  if (collapseKey.startsWith("ctplead:")) return 4;
  if (collapseKey.startsWith("roast:")) return 5;
  return 6;
}

/** Deliver one trigger. Never throws. */
export async function deliverPushTrigger(
  trip: Pick<Trip, "id" | "code" | "settings">,
  state: TripState,
  trigger: PushTrigger,
  deps: SendDeps = {},
): Promise<PushReport> {
  try {
    return await sendToPlayers(trip, audienceOf(state, trigger.audience), {
      title: trigger.title,
      body: trigger.body,
      url: tripFeedUrl(trip.code),
      tag: trigger.collapse_key,
    }, deps);
  } catch (e) {
    console.error("[push] trigger delivery failed", e);
    return emptyReport();
  }
}

/**
 * Deliver several triggers: duplicates by collapse key collapse to the latest one, then the most
 * important go first (throttling means a player usually gets only the first). Never throws.
 */
export async function deliverPushTriggers(
  trip: Pick<Trip, "id" | "code" | "settings">,
  state: TripState,
  triggers: readonly PushTrigger[],
  deps: SendDeps = {},
): Promise<PushReport[]> {
  const latest = new Map<string, PushTrigger>();
  for (const t of triggers) {
    latest.delete(t.collapse_key);
    latest.set(t.collapse_key, t);
  }
  const ordered = [...latest.values()].sort((a, b) => priorityOf(a.collapse_key) - priorityOf(b.collapse_key));
  const out: PushReport[] = [];
  for (const t of ordered) out.push(await deliverPushTrigger(trip, state, t, deps));
  return out;
}

/** Post-commit hook: push the batch's PushTriggers. */
export async function pushHook(ctx: PostCommitContext, deps: SendDeps = {}): Promise<void> {
  const triggers = ctx.events?.push_triggers ?? [];
  if (triggers.length === 0 || !pushAvailable()) return;
  const state = ctx.state ?? (await readTripState(deps.db ?? getDb(), ctx.trip.id));
  await deliverPushTriggers(ctx.trip, state, triggers, deps);
}
