// VAPID keys for Web Push, with no setup required:
//   - VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY from the environment when both are set (read on every
//     call, like everything in env.ts);
//   - otherwise the server generates a pair the first time it needs one, stores it in
//     server_config (key 'vapid', migration 005) and uses that pair forever after. It must never
//     change: every phone's push subscription is bound to the public key it subscribed with.
//     Concurrent cold starts agree on ONE pair (insert ... on conflict do nothing, then re-read).
//     Cached in memory per process after the first read.
//   - PUSH_DISABLED=1 turns push off: getVapidKeys returns null.
// Only the public key ever leaves the server (snapshot meta). Call getVapidKeys with the root db,
// never inside a transaction (a rolled-back insert must not end up in the cache).
import { getDb, type Db } from "./db";
import { pushEnabled, vapidPrivateKey, vapidPublicKey } from "./env";

export interface VapidKeys {
  /** URL-safe base64 (uncompressed P-256 point): the browser's applicationServerKey. */
  publicKey: string;
  /** URL-safe base64. Server-only: never put it in a response. */
  privateKey: string;
}

const CONFIG_KEY = "vapid";

const G = globalThis as typeof globalThis & { __scrambleVapid?: Promise<VapidKeys>; __scrambleVapidHalfWarned?: boolean };

/** The push keys (env, else stored, else generated and stored), or null when push is disabled. */
export async function getVapidKeys(db: Db = getDb()): Promise<VapidKeys | null> {
  if (!pushEnabled()) return null;
  const publicKey = vapidPublicKey();
  const privateKey = vapidPrivateKey();
  if (publicKey && privateKey) return { publicKey, privateKey };
  if ((publicKey || privateKey) && !G.__scrambleVapidHalfWarned) {
    G.__scrambleVapidHalfWarned = true;
    console.warn(
      "[push] only one of VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY is set; using the server-generated pair. " +
        "Set both or neither (adding the second one later switches keys and everyone must re-enable notifications).",
    );
  }
  if (!G.__scrambleVapid) {
    const p = loadOrCreateVapidKeys(db);
    G.__scrambleVapid = p;
    // A failure (database down) is retried on the next call instead of cached forever.
    p.catch(() => {
      if (G.__scrambleVapid === p) G.__scrambleVapid = undefined;
    });
  }
  return G.__scrambleVapid;
}

/** Tests: forget the cached pair (as a fresh process would). */
export function forgetVapidKeysForTests(): void {
  G.__scrambleVapid = undefined;
  G.__scrambleVapidHalfWarned = undefined;
}

/** The stored pair, generating and storing one first if there is none. Uncached. */
export async function loadOrCreateVapidKeys(db: Db): Promise<VapidKeys> {
  const stored = await readStored(db);
  if (stored) return stored;
  const fresh = await generateVapidKeys();
  await db.query("insert into server_config (key, value) values ($1, $2::jsonb) on conflict (key) do nothing", [CONFIG_KEY, fresh]);
  // Whoever inserted first wins; everyone reads the winner.
  const winner = await readStored(db);
  if (!winner) throw new Error("VAPID keys missing right after saving them");
  return winner;
}

async function readStored(db: Db): Promise<VapidKeys | null> {
  const rows = await db.query<{ value: unknown }>("select value from server_config where key = $1", [CONFIG_KEY]);
  if (rows.length === 0) return null;
  const v = rows[0].value as Partial<VapidKeys> | null;
  if (typeof v?.publicKey !== "string" || typeof v.privateKey !== "string" || !v.publicKey || !v.privateKey) {
    // Never silently replace it (that would break every phone's subscription).
    throw new Error("server_config 'vapid' is malformed; delete that row to generate a new pair (phones must re-enable push)");
  }
  return { publicKey: v.publicKey, privateKey: v.privateKey };
}

async function generateVapidKeys(): Promise<VapidKeys> {
  const mod = await import("web-push");
  const webpush = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}
