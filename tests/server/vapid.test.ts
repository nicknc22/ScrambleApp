// VAPID keys with zero setup (src/lib/server/vapid.ts): env pair wins; otherwise ONE generated
// pair, stored in server_config and reused forever (also after a cold start, also when cold starts
// race); PUSH_DISABLED=1 turns push off; only the public key ever reaches a client.
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type Db, type DbConnection } from "@/lib/server/db";
import { forgetVapidKeysForTests, getVapidKeys, loadOrCreateVapidKeys, type VapidKeys } from "@/lib/server/vapid";
import { buildSnapshot, createTrip, pushPublicKey } from "@/lib/server/trips";
import { applyOpsToTrip } from "@/lib/server/apply";
import { pushAvailable } from "@/lib/server/push";
import { newId } from "@/lib/ids";
import type { Snapshot, Trip } from "@/lib/types";
import { GET as stateRoute } from "@/app/api/t/[code]/state/route";
import { POST as subscribeRoute } from "@/app/api/t/[code]/push/route";

let db: DbConnection;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(async () => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "PUSH_DISABLED"]) {
    vi.stubEnv(k, "");
  }
  // Every test starts as a brand-new deploy: nothing stored, nothing cached.
  await db.query("delete from server_config");
  forgetVapidKeysForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const stored = () => db.query<{ value: unknown }>("select value from server_config where key = 'vapid'");

/** A real P-256 pair: the public key is the private key's point (what web-push and browsers need). */
function expectValidPair(k: VapidKeys | null): asserts k is VapidKeys {
  expect(k).not.toBeNull();
  const pub = Buffer.from(k!.publicKey, "base64url");
  expect(k!.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  expect(pub).toHaveLength(65);
  expect(pub[0]).toBe(0x04);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(k!.privateKey, "base64url"));
  expect(ecdh.getPublicKey().equals(pub)).toBe(true);
}

async function tripWithPlayer(): Promise<{ trip: Trip; playerId: string }> {
  const trip = await createTrip(db, { name: "Vapid Trip", app_name: "Scramble", pin_hash: "scrypt$c2FsdA$aGFzaA" });
  const playerId = newId();
  const op = { id: newId(), at: new Date().toISOString(), by: null, type: "player.upsert" as const, player: { id: playerId, name: "Nick" } };
  const out = await applyOpsToTrip({ db, trip, ops: [op], isCommissioner: true });
  expect(out.results[0].status).toBe("applied");
  return { trip, playerId };
}

function subscribeReq(code: string, playerId: string): Request {
  return new Request(`http://localhost:3000/api/t/${code}/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      player_id: playerId,
      subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${newId()}`, expirationTime: null, keys: { p256dh: "BPp256dhKeyAAAAAAAAAAAAAAAAAAAA", auth: "authKeyAAAAAAAA" } },
    }),
  });
}
const params = (code: string) => ({ params: Promise.resolve({ code }) });

describe("getVapidKeys", () => {
  it("generates a pair on first need, stores it, and reuses it forever (also after a cold start)", async () => {
    expect(await stored()).toEqual([]);
    const first = await getVapidKeys(db);
    expectValidPair(first);
    expect(await stored()).toEqual([{ value: first }]);

    // Cached: the second call doesn't even ask the database.
    const spy = vi.spyOn(db, "query");
    expect(await getVapidKeys(db)).toEqual(first);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // A fresh process (empty cache) reads the same pair back instead of making a new one.
    forgetVapidKeysForTests();
    expect(await getVapidKeys(db)).toEqual(first);
    expect(await loadOrCreateVapidKeys(db)).toEqual(first);
    expect(await stored()).toHaveLength(1);
  });

  it("concurrent first calls agree on ONE pair (same process, and racing cold starts)", async () => {
    const same = await Promise.all(Array.from({ length: 5 }, () => getVapidKeys(db)));
    expectValidPair(same[0]);
    for (const k of same) expect(k).toEqual(same[0]);

    // Several uncached "processes" at once.
    await db.query("delete from server_config");
    const racers = await Promise.all(Array.from({ length: 6 }, () => loadOrCreateVapidKeys(db)));
    for (const k of racers) expect(k).toEqual(racers[0]);
    expect(await stored()).toEqual([{ value: racers[0] }]);

    // Losing the race: our read saw nothing, someone else inserted first → we use THEIR pair.
    const winner = racers[0];
    let firstRead = true;
    const lateDb: Db = {
      query: async <T,>(sql: string, p?: unknown[]): Promise<T[]> => {
        if (firstRead && /^select value from server_config/.test(sql)) {
          firstRead = false;
          return [];
        }
        return db.query<T>(sql, p);
      },
      tx: (fn, opts) => db.tx(fn, opts),
    };
    expect(await loadOrCreateVapidKeys(lateDb)).toEqual(winner);
    expect(await stored()).toEqual([{ value: winner }]);
  });

  it("env keys take precedence and never touch the database; a lone env key is ignored", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "env-pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "env-priv");
    expect(await getVapidKeys(db)).toEqual({ publicKey: "env-pub", privateKey: "env-priv" });
    expect(await stored()).toEqual([]);

    // Even over an already generated (and cached) pair.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    const generated = await getVapidKeys(db);
    expectValidPair(generated);
    vi.stubEnv("VAPID_PUBLIC_KEY", "env-pub");
    expect(await getVapidKeys(db)).toEqual({ publicKey: "env-pub", privateKey: "env-priv" });
    expect(await pushPublicKey(db)).toBe("env-pub");

    // Half a pair can't sign anything: the stored pair is used, with ONE warning per process (no key printed).
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    expect(await getVapidKeys(db)).toEqual(generated);
    expect(await getVapidKeys(db)).toEqual(generated);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("only one of VAPID_PUBLIC_KEY"))).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("env-pub");
  });

  it("PUSH_DISABLED=1 turns push off everywhere (and generates nothing)", async () => {
    vi.stubEnv("PUSH_DISABLED", "1");
    const { trip, playerId } = await tripWithPlayer();
    expect(await getVapidKeys(db)).toBeNull();
    expect(pushAvailable()).toBe(false);
    const snap = await buildSnapshot(db, trip);
    expect(snap.meta).toMatchObject({ vapid_public_key: null, push_enabled: false });
    const res = await subscribeRoute(subscribeReq(trip.code, playerId), params(trip.code));
    expect(await res.json()).toEqual({ ok: true, push_enabled: false });
    expect(await stored()).toEqual([]);

    vi.stubEnv("PUSH_DISABLED", "");
    expect(pushAvailable()).toBe(true);
    expect((await buildSnapshot(db, trip)).meta.push_enabled).toBe(true);
  });

  it("never replaces a malformed stored pair; push is off for that response instead of failing it", async () => {
    await db.query("insert into server_config (key, value) values ('vapid', $1::jsonb)", [{ publicKey: 7 }]);
    await expect(getVapidKeys(db)).rejects.toThrow(/malformed/);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { trip } = await tripWithPlayer();
    const snap = await buildSnapshot(db, trip);
    expect(snap.meta).toMatchObject({ vapid_public_key: null, push_enabled: false });
    // Phones poll every few seconds: the error is logged once, not on every snapshot.
    await buildSnapshot(db, trip);
    await buildSnapshot(db, trip);
    expect(err).toHaveBeenCalledTimes(1);
    expect(await stored()).toEqual([{ value: { publicKey: 7 } }]);
  });
});

describe("what clients see", () => {
  it("push is on with no VAPID env vars; snapshots, sync responses and the push route carry only the public key", async () => {
    const { trip, playerId } = await tripWithPlayer();
    const res = await stateRoute(new Request(`http://localhost:3000/api/t/${trip.code}/state`), params(trip.code));
    const text = await res.text();
    const snap = JSON.parse(text) as Snapshot;
    const keys = await getVapidKeys(db);
    expectValidPair(keys);
    expect(await stored()).toEqual([{ value: keys }]);
    expect(snap.meta).toMatchObject({ vapid_public_key: keys.publicKey, push_enabled: true });
    expect(text).not.toContain(keys.privateKey);
    expect(text).not.toContain("privateKey");

    const op = { id: newId(), at: new Date().toISOString(), by: null, type: "player.upsert" as const, player: { id: playerId, name: "Nick C" } };
    const sync = await applyOpsToTrip({ db, trip, ops: [op], isCommissioner: true });
    expect(sync.snapshot.meta).toMatchObject({ vapid_public_key: keys.publicKey, push_enabled: true });
    expect(JSON.stringify(sync.snapshot)).not.toContain(keys.privateKey);

    const sub = await subscribeRoute(subscribeReq(trip.code, playerId), params(trip.code));
    const subText = await sub.text();
    expect(JSON.parse(subText)).toEqual({ ok: true, push_enabled: true });
    expect(subText).not.toContain(keys.privateKey);
  });
});
