// Live-update invalidations via Supabase Realtime broadcast. After each commit the server tells
// every phone on topic "trip:<trip_id>" that something changed; phones refetch the snapshot.
// Best effort: never throws, gives up after 3 s, no-op when Supabase isn't configured (phones
// then fall back to polling every 3 s).
import { realtimeConfigured, supabaseAnonKey, supabaseServiceRoleKey, supabaseUrl } from "./env";
import type { SnapshotMeta } from "@/lib/types";

export const BROADCAST_TIMEOUT_MS = 3000;

export function tripTopic(tripId: string): string {
  return `trip:${tripId}`;
}

/** What clients need to subscribe (null = poll only). */
export function realtimeMeta(tripId: string): SnapshotMeta["realtime"] {
  const url = supabaseUrl();
  const anon = supabaseAnonKey();
  if (!realtimeConfigured() || !url || !anon) return null;
  return { url, anon_key: anon, topic: tripTopic(tripId) };
}

/**
 * Legacy Supabase keys (anon / service_role) are JWTs ("eyJ..."). The new-format keys
 * (sb_publishable_... / sb_secret_...) are not, and must only travel in the apikey header: sent as
 * "Authorization: Bearer" they get the request rejected.
 */
export function isJwtKey(key: string): boolean {
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key);
}

/** Headers for a server call to Supabase with the service key (either key format). */
function serviceKeyHeaders(key: string): Record<string, string> {
  return isJwtKey(key) ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

/** Returns true when the broadcast was accepted. */
export async function broadcastTripChanged(tripId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = supabaseUrl();
  const key = supabaseServiceRoleKey();
  if (!url || !key || !realtimeConfigured()) return false;
  try {
    const res = await fetchImpl(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { ...serviceKeyHeaders(key), "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ topic: tripTopic(tripId), event: "changed", payload: { at: new Date().toISOString() } }],
      }),
      signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(
        `realtime: broadcast for ${tripId} failed with HTTP ${res.status}` +
          (res.status === 401 || res.status === 403 ? " (check SUPABASE_SERVICE_ROLE_KEY belongs to NEXT_PUBLIC_SUPABASE_URL's project)" : ""),
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`realtime: broadcast for ${tripId} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
