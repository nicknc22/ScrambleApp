// Web Push on the client. Everything here fails soft: a push problem never blocks the app.
// iPhone: works only from the Home Screen app (iOS 16.4+). Android Chrome works in the browser.

export type PushStatus =
  /** Subscribed and the server stored it (or the endpoint isn't deployed yet: 404 tolerated). */
  | "subscribed"
  /** This browser can't do push (or iOS outside the Home Screen app). */
  | "unsupported"
  /** The server has no VAPID key: push is off for this trip. */
  | "no_key"
  /** The user said no (or dismissed the prompt). */
  | "denied"
  /** Something else went wrong (no service worker, network, ...). */
  | "error";

export interface EnablePushResult {
  status: PushStatus;
  /** Human copy for a toast. */
  message: string;
}

const READY_TIMEOUT_MS = 8000;

export function pushSupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window
    );
  } catch {
    return false;
  }
}

/** Current notification permission, or "unsupported". */
export function pushPermission(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  try {
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

/** VAPID public key (URL-safe base64) -> bytes for applicationServerKey. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const MESSAGES: Record<PushStatus, string> = {
  subscribed: "Notifications on. Your phone will now narrate every bad decision.",
  unsupported: "This browser can't do notifications. On iPhone, open the app from your Home Screen first.",
  no_key: "Push isn't set up for this trip. The feed still has everything.",
  denied: "Notifications blocked. You can flip them on later in your phone's settings.",
  error: "Couldn't turn on notifications. Try again when you've got signal.",
};

function result(status: PushStatus): EnablePushResult {
  return { status, message: MESSAGES[status] };
}

/**
 * Ask permission, subscribe through the service worker and register the subscription with
 * POST /api/t/<code>/push { player_id, subscription }. Must be called from a tap (iOS rule).
 */
export async function enablePush(opts: { code: string; playerId: string; vapidPublicKey: string | null }): Promise<EnablePushResult> {
  if (!pushSupported()) return result("unsupported");
  if (!opts.vapidPublicKey) return result("no_key");
  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") return result("denied");

    const reg = await withTimeout(navigator.serviceWorker.ready, READY_TIMEOUT_MS);
    const key = urlBase64ToUint8Array(opts.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) {
      // Server key rotated: the old subscription is useless.
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

    const res = await fetch(`/api/t/${encodeURIComponent(opts.code)}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: opts.playerId, subscription: sub.toJSON() }),
    });
    // 404: the push endpoint isn't deployed yet. The subscription is still valid locally.
    if (!res.ok && res.status !== 404) return result("error");
    return result("subscribed");
  } catch {
    return result("error");
  }
}

function sameKey(sub: PushSubscription, key: Uint8Array): boolean {
  try {
    const current = sub.options?.applicationServerKey;
    if (!current) return true;
    const a = new Uint8Array(current);
    if (a.length !== key.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== key[i]) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Unsubscribe this device. Best effort: tells the server (DELETE /api/t/<code>/push) when a
 * code is given, and never throws. Muting (player.mute) is the server-side way to stop pushes.
 */
export async function disablePush(opts?: { code?: string; playerId?: string }): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return true;
    const endpoint = sub.endpoint;
    const ok = await sub.unsubscribe();
    if (opts?.code) {
      await fetch(`/api/t/${encodeURIComponent(opts.code)}/push`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: opts.playerId ?? null, endpoint }),
      }).catch(() => undefined);
    }
    return ok;
  } catch {
    return false;
  }
}

/** Whether this device currently has a push subscription. */
export async function hasPushSubscription(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager.getSubscription());
  } catch {
    return false;
  }
}
