// AI roasts: caps, per-team gap, big-event exemption, roasts disabled, banned-topic filter,
// insertion + push, against in-memory PGlite with a fake Anthropic client and push sender.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { applyOpsToTrip, type ApplyOpsResult } from "@/lib/server/apply";
import { createTrip } from "@/lib/server/trips";
import { insertFeedEvents, loadTripState } from "@/lib/server/repo";
import { setAiClientForTests, type AiClient, type AiResponse } from "@/lib/server/ai";
import { setPushSenderForTests, type PushSender, type PushSubscriptionLike } from "@/lib/server/push";
import {
  MAX_ROASTS_PER_BATCH,
  ROAST_SYSTEM_PROMPT,
  buildRoastContext,
  cleanRoast,
  handleRoastTrigger,
  roastHook,
  type RoastDeps,
} from "@/lib/server/roasts";
import { derive } from "@/lib/engine";
import { deriveId, newId } from "@/lib/ids";
import type { Op, OpType } from "@/lib/ops";
import type { FeedEvent, Trip, TripSettings } from "@/lib/types";
import type { RoastTrigger } from "@/lib/events/derive";
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PIN_HASH = "scrypt$c2FsdA$aGFzaA";
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

async function setup(teams: number[] = [2, 2], settings: Partial<TripSettings> = {}): Promise<Setup> {
  const created = await createTrip(db, { name: "Roast Trip", app_name: "Scramble", pin_hash: PIN_HASH });
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
      ops.push(mk("player.upsert", { player: { id: player[label], name: `Player ${label}`, is_groom: label === "A1" } }));
      ops.push(mk("team.assign", { player_id: player[label], team_id: team[letter] }));
    }
  });
  if (Object.keys(settings).length) ops.push(mk("trip.update", { patch: { settings } }));
  ops.push(mk("trip.start", {}));
  const out = await applyOpsToTrip({ db, trip: created, ops, isCommissioner: true });
  expect(out.results.every((r) => r.status === "applied")).toBe(true);
  return { trip: out.snapshot.state.trip, team, player };
}

async function play(s: Setup, ops: Op[]): Promise<ApplyOpsResult> {
  const out = await applyOpsToTrip({ db, trip: s.trip, ops, isCommissioner: false });
  expect(out.results.filter((r) => r.status !== "applied")).toEqual([]);
  return out;
}

/** Team `letter` scores `strokes` on `hole` (opening it). */
const score = (s: Setup, letter: string, hole: number, strokes: number): Op[] => [
  mk("tee.open", { team_id: s.team[letter], hole, by: s.player[`${letter}1`] }),
  mk("score.set", { team_id: s.team[letter], hole, strokes, by: s.player[`${letter}1`] }),
];

function triggerOf(out: ApplyOpsResult, pred: (t: RoastTrigger) => boolean): RoastTrigger {
  const t = out.events.roast_triggers.find(pred);
  expect(t, `no roast trigger among ${JSON.stringify(out.events.roast_triggers.map((x) => x.type))}`).toBeTruthy();
  return t!;
}
const doubleOf = (out: ApplyOpsResult) => triggerOf(out, (t) => t.type === "score_notable");

let aiCalls: Array<{ params: Anthropic.MessageCreateParamsNonStreaming; options?: Anthropic.RequestOptions }> = [];
let aiReply: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<AiResponse> | AiResponse;
const textReply = (text: string): AiResponse => ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 30 } });
const fakeAi: AiClient = {
  messages: {
    create: async (params, options) => {
      aiCalls.push({ params, options });
      return aiReply(params);
    },
  },
};

let pushed: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
const fakeSender: PushSender = async (sub, payload) => {
  pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
  return { statusCode: 201 };
};

async function subscribeAll(s: Setup): Promise<Record<string, string>> {
  const endpoints: Record<string, string> = {};
  for (const [label, id] of Object.entries(s.player)) {
    const sub: PushSubscriptionLike = { endpoint: `https://fcm.googleapis.com/fcm/send/${label}-${newId()}`, keys: { p256dh: "BKeyAAAAAAAAAAAAAAAA", auth: "authAAAAAAAA" } };
    await db.query("insert into push_subscriptions (id, trip_id, player_id, endpoint, keys) values ($1, $2, $3, $4, $5)", [newId(), s.trip.id, id, sub.endpoint, sub.keys]);
    endpoints[sub.endpoint] = label;
  }
  return endpoints;
}

async function roastsOf(tripId: string): Promise<FeedEvent[]> {
  return (await loadTripState(db, tripId)).feed_events.filter((e) => e.type === "roast");
}

let db: DbConnection;
const deps: RoastDeps = {};
let broadcast: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "AI_FAST_MODEL"]) {
    vi.stubEnv(k, "");
  }
  aiCalls = [];
  pushed = [];
  aiReply = () => textReply("Team A just carded a double like it was a dare, and they still haven't found the fairway or the beer cart.");
  setAiClientForTests(fakeAi);
  setPushSenderForTests(fakeSender);
  broadcast = vi.fn(async () => true);
  deps.broadcast = broadcast as unknown as (tripId: string) => Promise<boolean>;
});

afterEach(() => {
  setAiClientForTests(null);
  setPushSenderForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("cleanRoast", () => {
  it("unquotes, strips preambles and markdown, keeps at most two sentences", () => {
    expect(cleanRoast('"Nice triple, boys. Truly historic."')).toBe("Nice triple, boys. Truly historic.");
    expect(cleanRoast("Roast: **Team A** shanked it. Again. And again.")).toBe("Team A shanked it. Again.");
    expect(cleanRoast("Here's a roast: three putts\nfrom four feet!")).toBe("three putts from four feet!");
    expect(cleanRoast("  ")).toBeNull();
    expect(cleanRoast("ok")).toBeNull();
    expect(cleanRoast(null)).toBeNull();
    const long = cleanRoast(`${"word ".repeat(120)}end.`);
    expect(long!.length).toBeLessThanOrEqual(300);
    expect(long!.endsWith("…")).toBe(true);
  });
});

describe("prompt and context", () => {
  it("the system prompt keeps roasts on golf, drinking and decisions", () => {
    expect(ROAST_SYSTEM_PROMPT).toMatch(/golf/i);
    expect(ROAST_SYSTEM_PROMPT).toMatch(/drinking/i);
    expect(ROAST_SYSTEM_PROMPT).toMatch(/fiancées/);
    expect(ROAST_SYSTEM_PROMPT).toMatch(/family/);
    expect(ROAST_SYSTEM_PROMPT).toMatch(/jobs/);
    expect(ROAST_SYSTEM_PROMPT).toMatch(/looks/);
  });

  it("builds context with the event, the team, its holes and the leaderboard", async () => {
    const s = await setup();
    await play(s, score(s, "B", 1, 4));
    const out = await play(s, score(s, "A", 1, 6));
    const state = await loadTripState(db, s.trip.id);
    const ev = state.feed_events.find((e) => e.id === doubleOf(out).feed_event_id)!;
    const ctx = buildRoastContext(state, derive(state), ev, s.team.A);
    expect(ctx).toContain("Team A");
    expect(ctx).toContain("Player A1 👑 (the groom)");
    expect(ctx).toMatch(/made a 6 on the par-4 hole 1: a double bogey/);
    expect(ctx).toMatch(/Leaderboard: 1\. Team B E thru 1/);
  });

  it("last place at the turn comes through as score_notable kind last_at_turn", async () => {
    const s = await setup();
    // B plays the front nine at par, A at bogey.
    for (let h = 1; h <= 9; h++) await play(s, score(s, "B", h, h === 3 || h === 8 ? 3 : h === 4 || h === 9 ? 5 : 4));
    let out: ApplyOpsResult | null = null;
    for (let h = 1; h <= 9; h++) out = await play(s, score(s, "A", h, (h === 3 || h === 8 ? 3 : h === 4 || h === 9 ? 5 : 4) + 1));
    const trig = triggerOf(out!, (t) => t.type === "score_notable");
    const state = await loadTripState(db, s.trip.id);
    const ev = state.feed_events.find((e) => e.id === trig.feed_event_id)!;
    expect(ev.payload.kind).toBe("last_at_turn");
    expect(buildRoastContext(state, derive(state), ev, s.team.A)).toMatch(/dead last at the turn/);
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe("handleRoastTrigger", () => {
  it("posts a roast for a double bogey, broadcasts, and pushes it to that team only", async () => {
    const s = await setup();
    const endpoints = await subscribeAll(s);
    await play(s, score(s, "B", 1, 4));
    const out = await play(s, score(s, "A", 1, 6));
    const trig = doubleOf(out);
    expect(trig.big).toBe(false);

    const res = await handleRoastTrigger(s.trip.id, trig, deps);
    expect(res.status).toBe("posted");
    const roasts = await roastsOf(s.trip.id);
    expect(roasts).toHaveLength(1);
    expect(roasts[0]).toMatchObject({
      id: deriveId(s.trip.id, `roast:${trig.feed_event_id}`),
      type: "roast",
      team_id: s.team.A,
      text: "Team A just carded a double like it was a dare, and they still haven't found the fairway or the beer cart.",
      dedupe_key: `roast:${trig.feed_event_id}`,
      payload: { trigger_event_id: trig.feed_event_id, trigger_type: "score_notable", hole: 1 },
      deleted_at: null,
    });
    expect(broadcast).toHaveBeenCalledWith(s.trip.id);

    // Haiku with the roast rules, an 8 s budget and no retries.
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].params.model).toBe("claude-haiku-5-5");
    expect(aiCalls[0].params.system).toBe(ROAST_SYSTEM_PROMPT);
    expect(aiCalls[0].options).toMatchObject({ timeout: 8000, maxRetries: 0 });
    expect(aiCalls[0].options?.signal).toBeInstanceOf(AbortSignal);

    expect(pushed.map((p) => endpoints[p.endpoint]).sort()).toEqual(["A1", "A2"]);
    expect(pushed[0].payload).toMatchObject({ tag: `roast:${s.team.A}`, url: `/t/${s.trip.code}?tab=feed` });
    expect(String(pushed[0].payload.body)).toContain("double like it was a dare");

    // The same trigger again: deduped, no second AI call.
    expect(await handleRoastTrigger(s.trip.id, trig, deps)).toEqual({ status: "skipped", reason: "duplicate" });
    expect(aiCalls).toHaveLength(1);
  });

  it("at most one roast per team every 3 holes, except big events", async () => {
    const s = await setup();
    await play(s, score(s, "B", 1, 4));
    const h1 = doubleOf(await play(s, score(s, "A", 1, 6)));
    expect((await handleRoastTrigger(s.trip.id, h1, deps)).status).toBe("posted");

    await play(s, score(s, "B", 2, 4));
    const h2 = doubleOf(await play(s, score(s, "A", 2, 6)));
    expect(await handleRoastTrigger(s.trip.id, h2, deps)).toEqual({ status: "skipped", reason: "gap" });

    // A big event on the same hole goes through anyway.
    const big: RoastTrigger = { ...h2, big: true };
    expect((await handleRoastTrigger(s.trip.id, big, deps)).status).toBe("posted");

    // The other team isn't affected by Team A's gap.
    await play(s, score(s, "B", 3, 5));
    const b3 = doubleOf(await play(s, score(s, "B", 4, 7)));
    expect(b3.team_id).toBe(s.team.B);
    expect((await handleRoastTrigger(s.trip.id, b3, deps)).status).toBe("posted");

    // Three holes after Team A's last roast (hole 2, the big one): allowed again.
    await play(s, score(s, "A", 3, 3));
    await play(s, score(s, "A", 4, 5));
    const a5 = doubleOf(await play(s, score(s, "A", 5, 6)));
    expect((await handleRoastTrigger(s.trip.id, a5, deps)).status).toBe("posted");
    expect((await roastsOf(s.trip.id)).map((r) => r.payload.hole)).toEqual([1, 2, 4, 5]);
  });

  it("caps roasts per round at settings.roast_cap (40 by default), counting deleted ones too", async () => {
    const s = await setup();
    expect(s.trip.settings.roast_cap).toBe(40);
    const now = new Date().toISOString();
    const filler: FeedEvent[] = Array.from({ length: 40 }, (_, i) => ({
      id: newId(),
      trip_id: s.trip.id,
      type: "roast",
      team_id: s.team.B,
      player_id: null,
      actor_id: null,
      payload: { trigger_event_id: newId(), hole: 18 },
      photo_path: null,
      text: `filler roast ${i}`,
      dedupe_key: `roast:filler-${i}`,
      created_at: now,
      updated_at: now,
      deleted_at: i === 0 ? now : null,
    }));
    await insertFeedEvents(db, s.trip.id, filler.slice(0, 39));
    await play(s, score(s, "B", 1, 4));
    const t1 = doubleOf(await play(s, score(s, "A", 1, 6)));
    // 39 so far: one more fits.
    expect((await handleRoastTrigger(s.trip.id, t1, deps)).status).toBe("posted");
    await insertFeedEvents(db, s.trip.id, filler.slice(39));
    const big = { ...doubleOf(await play(s, score(s, "A", 2, 7))), big: true };
    expect(await handleRoastTrigger(s.trip.id, big, deps)).toEqual({ status: "skipped", reason: "cap" });
    expect(aiCalls).toHaveLength(1);
  });

  it("respects a custom cap and does nothing when roasts are disabled", async () => {
    const s = await setup([2, 2], { roast_cap: 1 });
    await play(s, score(s, "B", 1, 4));
    const t1 = doubleOf(await play(s, score(s, "A", 1, 6)));
    expect((await handleRoastTrigger(s.trip.id, { ...t1, big: true }, deps)).status).toBe("posted");
    const t2 = doubleOf(await play(s, score(s, "B", 2, 6)));
    expect(await handleRoastTrigger(s.trip.id, { ...t2, big: true }, deps)).toEqual({ status: "skipped", reason: "cap" });

    const off = await setup([2, 2], { roasts_enabled: false });
    await play(off, score(off, "B", 1, 4));
    const t3 = doubleOf(await play(off, score(off, "A", 1, 6)));
    aiCalls = [];
    expect(await handleRoastTrigger(off.trip.id, t3, deps)).toEqual({ status: "skipped", reason: "disabled" });
    expect(aiCalls).toHaveLength(0);
  });

  it("drops roasts that touch off-limits topics (partners, family, jobs, appearance)", async () => {
    const s = await setup();
    await subscribeAll(s);
    await play(s, score(s, "B", 1, 4));
    const t1 = doubleOf(await play(s, score(s, "A", 1, 6)));
    for (const bad of [
      "Team A golfs like their fiancée is watching from the clubhouse.",
      "Player A2 swings like his dad never taught him anything.",
      "Don't quit your day job, Team A. Actually, do.",
      "That double bogey matches Player A1's hairline: receding fast.",
    ]) {
      aiReply = () => textReply(bad);
      expect(await handleRoastTrigger(s.trip.id, t1, deps)).toEqual({ status: "skipped", reason: "banned" });
    }
    expect(await roastsOf(s.trip.id)).toHaveLength(0);
    expect(pushed).toHaveLength(0);
  });

  it("skips triggers with no target team (a tie for the lead)", async () => {
    const s = await setup();
    await play(s, score(s, "A", 1, 4));
    const out = await play(s, score(s, "B", 1, 4));
    const tie = triggerOf(out, (t) => t.type === "lead_change");
    expect(tie.team_id).toBeNull();
    expect(await handleRoastTrigger(s.trip.id, tie, deps)).toEqual({ status: "skipped", reason: "no_team" });
    expect(aiCalls).toHaveLength(0);
  });

  it("AI off, AI failure, refusal or a deleted trigger event: nothing posted", async () => {
    const s = await setup();
    await play(s, score(s, "B", 1, 4));
    const t1 = doubleOf(await play(s, score(s, "A", 1, 6)));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await handleRoastTrigger(s.trip.id, t1, { ...deps, client: null })).toEqual({ status: "skipped", reason: "ai_off" });
    aiReply = () => {
      throw new Error("overloaded");
    };
    expect(await handleRoastTrigger(s.trip.id, t1, deps)).toEqual({ status: "skipped", reason: "ai_failed" });
    aiReply = () => ({ content: [], stop_reason: "refusal" });
    expect(await handleRoastTrigger(s.trip.id, t1, deps)).toEqual({ status: "skipped", reason: "ai_failed" });
    aiReply = () => new Promise(() => {}); // hangs
    expect(await handleRoastTrigger(s.trip.id, t1, { ...deps, timeoutMs: 30 })).toEqual({ status: "skipped", reason: "ai_failed" });

    await db.query("update feed_events set deleted_at = now() where id = $1", [t1.feed_event_id]);
    aiReply = () => textReply("Too late, the evidence is gone.");
    expect(await handleRoastTrigger(s.trip.id, t1, deps)).toEqual({ status: "skipped", reason: "no_event" });
    expect(await roastsOf(s.trip.id)).toHaveLength(0);
    const log = await db.query<{ n: number }>("select count(*)::int as n from ai_log where trip_id = $1 and kind = 'roast'", [s.trip.id]);
    expect(log[0].n).toBe(3);
  });
});

describe("roastHook", () => {
  it("roasts a sync batch's triggers (big first, a few per batch) and skips when AI is off", async () => {
    const s = await setup();
    // A takes the lead on hole 1 and doubles nothing: one big trigger (lead change).
    const out = await play(s, score(s, "A", 1, 6));
    const types = out.events.roast_triggers.map((t) => t.type).sort();
    expect(types).toEqual(["lead_change", "score_notable"]);
    const ctx = { trip: out.snapshot.state.trip, events: out.events, ops: out.applied, results: out.results, state: out.snapshot.state };

    setAiClientForTests(null);
    expect(await roastHook(ctx, deps)).toEqual([]);
    expect(aiCalls).toHaveLength(0);

    setAiClientForTests(fakeAi);
    const results = await roastHook(ctx, deps);
    // Big (lead change) first; the double on the same hole then hits the per-team gap.
    expect(results.map((r) => r.status)).toEqual(["posted", "skipped"]);
    expect(results[1]).toEqual({ status: "skipped", reason: "gap" });
    const roasts = await roastsOf(s.trip.id);
    expect(roasts).toHaveLength(1);
    expect(roasts[0].payload.trigger_type).toBe("lead_change");
    expect(MAX_ROASTS_PER_BATCH).toBeGreaterThanOrEqual(2);
  });
});
