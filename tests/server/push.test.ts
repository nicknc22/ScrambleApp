// Web Push: subscription route, sendToPlayers (mute, throttle, collapse, dead subscriptions) and
// trigger delivery, against in-memory PGlite with a fake web-push sender.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { applyOpsToTrip } from "@/lib/server/apply";
import { createTrip } from "@/lib/server/trips";
import { loadTripState } from "@/lib/server/repo";
import {
  COLLAPSE_WINDOW_SEC,
  audienceOf,
  deliverPushTriggers,
  isAllowedPushEndpoint,
  parsePushSubscription,
  pushAvailable,
  pushHook,
  sendToPlayers,
  setPushSenderForTests,
  topicFor,
  tripFeedUrl,
  vapidSubject,
  type PushSendOptions,
  type PushSender,
  type PushSubscriptionLike,
} from "@/lib/server/push";
import { newId } from "@/lib/ids";
import type { Op, OpType } from "@/lib/ops";
import type { Trip } from "@/lib/types";
import type { PushTrigger } from "@/lib/events/derive";
import { DELETE as unsubscribeRoute, POST as subscribeRoute } from "@/app/api/t/[code]/push/route";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PIN_HASH = "scrypt$c2FsdA$aGFzaA";
const BASE = "http://localhost:3000";
type OpOf<T extends OpType> = Extract<Op, { type: T }>;
let clientMs = Date.now() - 3 * 3600_000;
function mk<T extends OpType>(type: T, fields: Omit<OpOf<T>, "type" | "id" | "at" | "by"> & { by?: string | null }): OpOf<T> {
  clientMs += 1000;
  return { id: newId(), at: new Date(clientMs).toISOString(), by: null, ...fields, type } as OpOf<T>;
}

interface Setup {
  trip: Trip;
  team: Record<string, string>;
  player: Record<string, string>;
}

async function setup(teams: number[] = [2, 2]): Promise<Setup> {
  const created = await createTrip(db, { name: "Push Trip", app_name: "Scramble", pin_hash: PIN_HASH });
  const team: Record<string, string> = {};
  const player: Record<string, string> = {};
  const ops: Op[] = [];
  teams.forEach((size, ti) => {
    const letter = String.fromCharCode(65 + ti);
    team[letter] = newId();
    ops.push(mk("team.upsert", { team: { id: team[letter], name: `Team ${letter}` } }));
    for (let i = 1; i <= size; i++) {
      const label = `${letter}${i}`;
      player[label] = newId();
      ops.push(mk("player.upsert", { player: { id: player[label], name: `Player ${label}` } }));
      ops.push(mk("team.assign", { player_id: player[label], team_id: team[letter] }));
    }
  });
  ops.push(mk("trip.start", {}));
  const out = await applyOpsToTrip({ db, trip: created, ops, isCommissioner: true });
  expect(out.results.every((r) => r.status === "applied")).toBe(true);
  return { trip: out.snapshot.state.trip, team, player };
}

let endpointSeq = 0;
function subscription(host = "fcm.googleapis.com"): PushSubscriptionLike {
  endpointSeq++;
  return {
    endpoint: `https://${host}/fcm/send/device-${endpointSeq}-${newId()}`,
    keys: { p256dh: `BPp256dhKey${endpointSeq}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, auth: `authKey${endpointSeq}AAAAAAAA` },
  };
}

function req(code: string, method: "POST" | "DELETE", body: unknown): Request {
  return new Request(`${BASE}/api/t/${code}/push`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const params = (code: string) => ({ params: Promise.resolve({ code }) });

async function subscribe(s: Setup, label: string, sub = subscription()): Promise<PushSubscriptionLike> {
  const res = await subscribeRoute(req(s.trip.code, "POST", { player_id: s.player[label], subscription: { ...sub, expirationTime: null } }), params(s.trip.code));
  expect(res.status).toBe(200);
  return sub;
}

async function subsOf(tripId: string) {
  return db.query<{ player_id: string; endpoint: string; keys: { p256dh: string; auth: string } }>(
    "select player_id, endpoint, keys from push_subscriptions where trip_id = $1 order by created_at",
    [tripId],
  );
}

interface Sent {
  sub: PushSubscriptionLike;
  payload: Record<string, unknown>;
  options: PushSendOptions;
}
let sent: Sent[] = [];
let senderImpl: (sub: PushSubscriptionLike) => Promise<{ statusCode: number }>;
const fakeSender: PushSender = async (sub, payload, options) => {
  sent.push({ sub, payload: JSON.parse(payload) as Record<string, unknown>, options });
  return senderImpl(sub);
};

let db: DbConnection;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    vi.stubEnv(k, "");
  }
  sent = [];
  senderImpl = async () => ({ statusCode: 201 });
  setPushSenderForTests(fakeSender);
});

afterEach(() => {
  setPushSenderForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

describe("subscription validation", () => {
  it("accepts the browser push services and nothing else", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QGx1")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://evil.example.com/fcm.googleapis.com",
      "https://fcm.googleapis.com.evil.com/x",
      "https://localhost:3000/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://user:pw@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "not a url",
    ]) {
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
    }
  });

  it("parses PushSubscription.toJSON() and rejects junk", () => {
    const sub = subscription();
    expect(parsePushSubscription({ ...sub, expirationTime: null })).toEqual(sub);
    expect(parsePushSubscription(null)).toBeNull();
    expect(parsePushSubscription({ endpoint: sub.endpoint })).toBeNull();
    expect(parsePushSubscription({ endpoint: sub.endpoint, keys: { p256dh: "x", auth: sub.keys.auth } })).toBeNull();
    expect(parsePushSubscription({ endpoint: "https://evil.example.com/x", keys: sub.keys })).toBeNull();
    expect(parsePushSubscription({ endpoint: sub.endpoint, keys: { p256dh: "<script>alert(1)</script>", auth: sub.keys.auth } })).toBeNull();
  });
});

describe("POST / DELETE /api/t/[code]/push", () => {
  it("subscribes a player of the trip, upserts by endpoint, and unsubscribes", async () => {
    const s = await setup();
    const sub = await subscribe(s, "A1");
    let rows = await subsOf(s.trip.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ player_id: s.player.A1, endpoint: sub.endpoint, keys: sub.keys });

    // Same device, new keys, now picked as another player: one row, updated.
    const moved = { endpoint: sub.endpoint, keys: { p256dh: "BNewKeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", auth: "newAuthBBBBBB" } };
    await subscribe(s, "B1", moved);
    rows = await subsOf(s.trip.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ player_id: s.player.B1, keys: moved.keys });

    const del = await unsubscribeRoute(req(s.trip.code, "DELETE", { player_id: s.player.B1, endpoint: sub.endpoint }), params(s.trip.code));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, removed: 1 });
    expect(await subsOf(s.trip.id)).toHaveLength(0);

    // Deleting again is harmless; the client may send player_id null.
    const again = await unsubscribeRoute(req(s.trip.code, "DELETE", { player_id: null, endpoint: sub.endpoint }), params(s.trip.code));
    expect(await again.json()).toEqual({ ok: true, removed: 0 });
  });

  it("rejects players from other trips, deleted players, bad subscriptions and unknown trips", async () => {
    const s = await setup();
    const other = await setup();
    const res1 = await subscribeRoute(req(s.trip.code, "POST", { player_id: other.player.A1, subscription: subscription() }), params(s.trip.code));
    expect(res1.status).toBe(400);
    expect((await res1.json()).code).toBe("unknown_player");

    const res2 = await subscribeRoute(req(s.trip.code, "POST", { player_id: "nope", subscription: subscription() }), params(s.trip.code));
    expect(res2.status).toBe(400);

    const res3 = await subscribeRoute(
      req(s.trip.code, "POST", { player_id: s.player.A1, subscription: { endpoint: "https://evil.example.com/x", keys: subscription().keys } }),
      params(s.trip.code),
    );
    expect(res3.status).toBe(400);
    expect((await res3.json()).code).toBe("bad_subscription");

    await applyOpsToTrip({ db, trip: s.trip, ops: [mk("player.delete", { player_id: s.player.B2 })], isCommissioner: true });
    const res4 = await subscribeRoute(req(s.trip.code, "POST", { player_id: s.player.B2, subscription: subscription() }), params(s.trip.code));
    expect(res4.status).toBe(400);

    const res5 = await subscribeRoute(req("nosuchtrip9", "POST", { player_id: s.player.A1, subscription: subscription() }), params("nosuchtrip9"));
    expect(res5.status).toBe(404);
    expect(await subsOf(s.trip.id)).toHaveLength(0);
  });

  it("keeps at most 5 subscriptions per player (newest win)", async () => {
    const s = await setup();
    const subs: PushSubscriptionLike[] = [];
    for (let i = 0; i < 7; i++) {
      subs.push(await subscribe(s, "A1"));
      await new Promise((r) => setTimeout(r, 2));
    }
    const rows = await subsOf(s.trip.id);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.endpoint).sort()).toEqual(subs.slice(2).map((x) => x.endpoint).sort());
  });
});

// ---------------------------------------------------------------------------
// sendToPlayers
// ---------------------------------------------------------------------------

describe("sendToPlayers", () => {
  it("sends the payload to every subscription of the players, with tag/topic/TTL/VAPID details", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub-key");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv-key");
    const s = await setup();
    const a1 = await subscribe(s, "A1");
    const a1b = await subscribe(s, "A1");
    const b1 = await subscribe(s, "B1");
    await subscribe(s, "B2");

    const report = await sendToPlayers(s.trip, [s.player.A1, s.player.B1, s.player.A2], { title: "🏆 New leader", body: "Team A takes it.", tag: "lead" });
    expect(report.sent.sort()).toEqual([s.player.A1, s.player.B1].sort());
    expect(report.unsubscribed).toEqual([s.player.A2]);
    expect(sent.map((x) => x.sub.endpoint).sort()).toEqual([a1.endpoint, a1b.endpoint, b1.endpoint].sort());
    expect(sent[0].payload).toEqual({ title: "🏆 New leader", body: "Team A takes it.", url: tripFeedUrl(s.trip.code), tag: "lead" });
    expect(sent[0].payload.url).toBe(`/t/${s.trip.code}?tab=feed`);
    expect(sent[0].options).toMatchObject({
      TTL: expect.any(Number),
      topic: topicFor("lead"),
      vapidDetails: { subject: "mailto:scramble@example.com", publicKey: "pub-key", privateKey: "priv-key" },
    });
    expect(sent[0].options.topic!.length).toBeLessThanOrEqual(32);
    expect(sent[0].options.topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is off without VAPID keys or a sender, and uses VAPID_SUBJECT when set", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    setPushSenderForTests(null);
    expect(pushAvailable()).toBe(false);
    const report = await sendToPlayers(s.trip, [s.player.A1], { title: "x", body: "y" });
    expect(report.sent).toEqual([]);
    expect(sent).toHaveLength(0);
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    expect(pushAvailable()).toBe(true);
    vi.stubEnv("VAPID_SUBJECT", "mailto:nick@example.org");
    expect(vapidSubject()).toBe("mailto:nick@example.org");
  });

  it("works without a collapse key (no tag, no topic)", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    const report = await sendToPlayers(s.trip, [s.player.A1], { title: "plain", body: "no tag" });
    expect(report.sent).toEqual([s.player.A1]);
    expect(sent[0].payload).toEqual({ title: "plain", body: "no tag", url: `/t/${s.trip.code}?tab=feed` });
    expect(sent[0].options.topic).toBeUndefined();
    const log = await db.query<{ collapse_key: string | null }>("select collapse_key from push_log where trip_id = $1", [s.trip.id]);
    expect(log).toEqual([{ collapse_key: null }]);
  });

  it("honors players.muted_push", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    await subscribe(s, "A2");
    await applyOpsToTrip({ db, trip: s.trip, ops: [mk("player.mute", { player_id: s.player.A2, muted: true, by: s.player.A2 })], isCommissioner: false });
    const report = await sendToPlayers(s.trip, [s.player.A1, s.player.A2], { title: "t", body: "b", tag: "groom" });
    expect(report.sent).toEqual([s.player.A1]);
    expect(report.muted).toEqual([s.player.A2]);
    expect(sent).toHaveLength(1);
  });

  it("throttles to one push per player per 2 minutes (push_throttle_sec)", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    await subscribe(s, "B1");
    const t0 = Date.now();
    const at = (sec: number) => ({ now: new Date(t0 + sec * 1000) });

    expect((await sendToPlayers(s.trip, [s.player.A1], { title: "1", body: "", tag: "lead" }, at(0))).sent).toEqual([s.player.A1]);
    // A1 is throttled; B1 never got anything so B1 goes through.
    const r2 = await sendToPlayers(s.trip, [s.player.A1, s.player.B1], { title: "2", body: "", tag: "groom" }, at(60));
    expect(r2.throttled).toEqual([s.player.A1]);
    expect(r2.sent).toEqual([s.player.B1]);
    expect((await sendToPlayers(s.trip, [s.player.A1], { title: "3", body: "", tag: "final" }, at(119))).throttled).toEqual([s.player.A1]);
    expect((await sendToPlayers(s.trip, [s.player.A1], { title: "4", body: "", tag: "final" }, at(121))).sent).toEqual([s.player.A1]);
    expect(sent.map((x) => x.payload.title)).toEqual(["1", "2", "4"]);

    // A custom throttle from trip settings.
    const custom = { ...s.trip, settings: { ...s.trip.settings, push_throttle_sec: 10 } };
    expect((await sendToPlayers(custom, [s.player.A1], { title: "5", body: "", tag: "x1" }, at(132))).sent).toEqual([s.player.A1]);
  });

  it("collapses duplicates: the same collapse key to the same player within the window is skipped", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    const t0 = Date.now();
    const at = (sec: number) => ({ now: new Date(t0 + sec * 1000) });
    expect((await sendToPlayers(s.trip, [s.player.A1], { title: "lead 1", body: "", tag: "lead" }, at(0))).sent).toHaveLength(1);
    const dup = await sendToPlayers(s.trip, [s.player.A1], { title: "lead 2", body: "", tag: "lead" }, at(150));
    expect(dup.collapsed).toEqual([s.player.A1]);
    expect(dup.sent).toEqual([]);
    // A different key after the throttle goes through; the same key after the window too.
    expect((await sendToPlayers(s.trip, [s.player.A1], { title: "ctp", body: "", tag: "ctplead:3" }, at(151))).sent).toHaveLength(1);
    expect((await sendToPlayers(s.trip, [s.player.A1], { title: "lead 3", body: "", tag: "lead" }, at(COLLAPSE_WINDOW_SEC + 1))).sent).toHaveLength(1);
    expect(sent.map((x) => x.payload.title)).toEqual(["lead 1", "ctp", "lead 3"]);
  });

  it("deletes subscriptions the push service says are gone (404/410), keeps others, never throws", async () => {
    const s = await setup();
    const gone410 = await subscribe(s, "A1");
    const gone404 = await subscribe(s, "A2");
    const flaky = await subscribe(s, "B1");
    const ok = await subscribe(s, "B2");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    senderImpl = async (sub) => {
      if (sub.endpoint === gone410.endpoint) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      if (sub.endpoint === gone404.endpoint) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      if (sub.endpoint === flaky.endpoint) throw new Error("socket hang up");
      return { statusCode: 201 };
    };
    const report = await sendToPlayers(s.trip, Object.values(s.player), { title: "t", body: "b", tag: "final" });
    expect(report.sent).toEqual([s.player.B2]);
    expect(report.failed).toBe(3);
    expect(report.removed).toBe(2);
    const left = (await subsOf(s.trip.id)).map((r) => r.endpoint).sort();
    expect(left).toEqual([flaky.endpoint, ok.endpoint].sort());
  });

  it("never throws, even when the database is gone", async () => {
    const s = await setup();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { query: async () => { throw new Error("db down"); }, tx: async () => { throw new Error("db down"); } };
    const report = await sendToPlayers(s.trip, [s.player.A1], { title: "t", body: "b" }, { db: broken });
    expect(report.sent).toEqual([]);
    expect(err).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe("push triggers", () => {
  const trig = (collapse: string, audience: PushTrigger["audience"] = { kind: "all" }, title = collapse): PushTrigger => ({
    feed_event_id: newId(),
    title,
    body: `${title} body`,
    audience,
    collapse_key: collapse,
  });

  it("audience: everyone active, or one team's players", async () => {
    const s = await setup([2, 3]);
    const state = await loadTripState(db, s.trip.id);
    expect(audienceOf(state, { kind: "all" }).sort()).toEqual(Object.values(s.player).sort());
    expect(audienceOf(state, { kind: "team", team_id: s.team.B }).sort()).toEqual([s.player.B1, s.player.B2, s.player.B3].sort());
  });

  it("delivers the most important first and collapses same-key triggers to the latest", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    await subscribe(s, "B1");
    const state = await loadTripState(db, s.trip.id);
    await deliverPushTriggers(s.trip, state, [
      trig(`roast:${s.team.A}`, { kind: "team", team_id: s.team.A }),
      trig("lead", { kind: "all" }, "old lead"),
      trig("lead", { kind: "all" }, "new lead"),
    ]);
    // The lead change goes first (to everyone); A1 is then throttled for the roast.
    expect(sent.map((x) => x.payload.title)).toEqual(["new lead", "new lead"]);
  });

  it("pushHook sends a sync batch's lead change to every subscribed player", async () => {
    const s = await setup();
    await subscribe(s, "A1");
    await subscribe(s, "B2");
    const out = await applyOpsToTrip({
      db,
      trip: s.trip,
      ops: [mk("tee.open", { team_id: s.team.A, hole: 1, by: s.player.A1 }), mk("score.set", { team_id: s.team.A, hole: 1, strokes: 3, by: s.player.A1 })],
      isCommissioner: false,
    });
    expect(out.events.push_triggers.map((t) => t.collapse_key)).toContain("lead");
    await pushHook({ trip: out.snapshot.state.trip, events: out.events, ops: out.applied, results: out.results, state: out.snapshot.state });
    expect(sent.map((x) => x.sub.endpoint)).toHaveLength(2);
    expect(sent[0].payload.tag).toBe("lead");
    expect(String(sent[0].payload.title)).toMatch(/\S/);

    // No triggers → nothing to do (and no throw without a state).
    sent = [];
    await pushHook({ trip: s.trip, events: { feed: [], roast_triggers: [], push_triggers: [] }, ops: [], results: [] });
    expect(sent).toHaveLength(0);
  });
});
