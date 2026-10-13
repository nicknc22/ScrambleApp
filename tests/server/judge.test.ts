// AI judge for closest to pin: happy path, the suspicious rule (low confidence ignored), entry
// deleted / re-measured meanwhile, timeout → nothing written, no photo, AI off, and the whole
// thing end-to-end through the sync route's post-commit hooks. In-memory PGlite, a fake
// Anthropic client, a fake push sender and photos in a temp uploads dir.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// next/server's after() only works inside a Next request scope: capture the scheduled tasks.
const afterMock = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("next/server", () => ({ after: (task: () => unknown) => void afterMock.tasks.push(task) }));

import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { applyOpsToTrip } from "@/lib/server/apply";
import { createTrip } from "@/lib/server/trips";
import { loadTripState } from "@/lib/server/repo";
import { putPhoto } from "@/lib/server/storage";
import { setAiClientForTests, type AiClient, type AiResponse } from "@/lib/server/ai";
import { setPushSenderForTests, type PushSender } from "@/lib/server/push";
import {
  JUDGE_SYSTEM_PROMPT,
  MAX_JUDGE_CALLS_PER_PLAYER_HOLE,
  MAX_JUDGE_CALLS_PER_TRIP,
  ctpEntriesToJudge,
  imageMediaType,
  isSuspicious,
  judgeEntries,
  judgeEntry,
  judgeHook,
  judgeUploadedPhoto,
  parseJudgeVerdict,
  type JudgeDeps,
} from "@/lib/server/judge";
import { postCommitHookNames } from "@/lib/server/hooks";
import { deriveId, newId } from "@/lib/ids";
import type { Op, OpType, SyncResponse } from "@/lib/ops";
import type { ContestEntry, FeedEvent, Trip } from "@/lib/types";
import type Anthropic from "@anthropic-ai/sdk";
import { POST as syncRoute } from "@/app/api/t/[code]/sync/route";
import { POST as uploadRoute } from "@/app/api/t/[code]/upload/route";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const PIN_HASH = "scrypt$c2FsdA$aGFzaA";
const CTP_HOLE = 3; // Jack Frost #3 is a par 3
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
  const created = await createTrip(db, { name: "Judge Trip", app_name: "Scramble", pin_hash: PIN_HASH });
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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);

async function photo(s: Setup): Promise<string> {
  const p = `trips/${s.trip.id}/ctp/${newId()}.jpg`;
  await putPhoto(s.trip.id, p, JPEG);
  return p;
}

function submitOp(s: Setup, label: string, feet: number, photoPath: string | null, entryId = newId(), hole = CTP_HOLE) {
  return mk("contest.submit", {
    entry_id: entryId,
    hole,
    player_id: s.player[label],
    contest_type: "ctp",
    distance_value: feet,
    angle_deg: 90,
    lat: null,
    lng: null,
    gps_accuracy_m: null,
    low_accuracy: false,
    photo_path: photoPath,
    by: s.player[label],
  });
}

async function submit(s: Setup, label: string, feet: number, withPhoto = true): Promise<string> {
  const op = submitOp(s, label, feet, withPhoto ? await photo(s) : null);
  const out = await applyOpsToTrip({ db, trip: s.trip, ops: [op], isCommissioner: false });
  expect(out.results[0].status).toBe("applied");
  return op.entry_id;
}

async function entryOf(s: Setup, id: string): Promise<ContestEntry> {
  return (await loadTripState(db, s.trip.id)).contest_entries.find((e) => e.id === id)!;
}
async function feedOf(s: Setup, type: FeedEvent["type"]): Promise<FeedEvent[]> {
  return (await loadTripState(db, s.trip.id)).feed_events.filter((e) => e.type === type);
}

let calls: Array<{ params: Anthropic.MessageCreateParamsNonStreaming; options?: Anthropic.RequestOptions }> = [];
let judgeReply: () => Promise<AiResponse> | AiResponse;
let roastReply: () => Promise<AiResponse> | AiResponse;
const text = (t: string): AiResponse => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 60 } });
const verdict = (v: Record<string, unknown>) => () => text(`\`\`\`json\n${JSON.stringify(v)}\n\`\`\``);
const fakeAi: AiClient = {
  messages: {
    create: async (params, options) => {
      calls.push({ params, options });
      return params.system === JUDGE_SYSTEM_PROMPT ? judgeReply() : roastReply();
    },
  },
};

let pushed: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
const fakeSender: PushSender = async (sub, payload) => {
  pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
  return { statusCode: 201 };
};

async function subscribeAll(s: Setup): Promise<void> {
  for (const id of Object.values(s.player)) {
    await db.query("insert into push_subscriptions (id, trip_id, player_id, endpoint, keys) values ($1, $2, $3, $4, $5)", [
      newId(),
      s.trip.id,
      id,
      `https://fcm.googleapis.com/fcm/send/${newId()}`,
      { p256dh: "BKeyAAAAAAAAAAAAAAAA", auth: "authAAAAAAAA" },
    ]);
  }
}

let db: DbConnection;
let uploads: string;
let broadcast: ReturnType<typeof vi.fn>;
let deps: JudgeDeps;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), "scramble-judge-"));
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
  fs.rmSync(uploads, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "AI_JUDGE_MODEL", "AI_FAST_MODEL", "VERCEL"]) {
    vi.stubEnv(k, "");
  }
  vi.stubEnv("UPLOADS_DIR", uploads);
  calls = [];
  pushed = [];
  afterMock.tasks.length = 0;
  judgeReply = verdict({ estimate_ft: 12, confidence: "high", suspicious: false, roast: "Twelve feet and a prayer. The putter is already sweating." });
  roastReply = () => text("Claiming three feet from twelve is the most aggressive thing Team A has done all day, including the shotguns.");
  setAiClientForTests(fakeAi);
  setPushSenderForTests(fakeSender);
  broadcast = vi.fn(async () => true);
  deps = { broadcast: broadcast as unknown as (tripId: string) => Promise<boolean> };
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

describe("verdict parsing and the suspicious rule", () => {
  it("suspicious = claimed < 50% of the estimate and confidence not low", () => {
    expect(isSuspicious(5.9, 12, "high")).toBe(true);
    expect(isSuspicious(5.9, 12, "medium")).toBe(true);
    expect(isSuspicious(5.9, 12, "low")).toBe(false);
    expect(isSuspicious(6, 12, "high")).toBe(false);
    expect(isSuspicious(10, 12, "high")).toBe(false);
    expect(isSuspicious(7, 12, "high", 0.6)).toBe(true);
    expect(isSuspicious(7, 12, "high", NaN)).toBe(false); // bad ratio → default 0.5
  });

  it("parses and sanitizes the model's JSON", () => {
    expect(parseJudgeVerdict({ estimate_ft: 12.34, confidence: "High", suspicious: true, roast: '"Liar."' })).toEqual({ estimate_ft: 12.3, confidence: "high", roast: "Liar." });
    expect(parseJudgeVerdict({ estimate_ft: "8 ft", confidence: "medium" })).toEqual({ estimate_ft: 8, confidence: "medium", roast: null });
    expect(parseJudgeVerdict({ estimate_ft: 8, confidence: "very sure" })?.confidence).toBe("low");
    expect(parseJudgeVerdict({ estimate_ft: 8, confidence: "high", roast: "Putts like his wife is watching." })?.roast).toBeNull();
    expect(parseJudgeVerdict({ estimate_ft: "3-4 ft" })).toBeNull();
    expect(parseJudgeVerdict({ estimate_ft: -1 })).toBeNull();
    expect(parseJudgeVerdict({ estimate_ft: 9000 })).toBeNull();
    expect(parseJudgeVerdict({ confidence: "high" })).toBeNull();
    expect(parseJudgeVerdict(null)).toBeNull();
  });

  it("sniffs image types", () => {
    expect(imageMediaType(JPEG)).toBe("image/jpeg");
    expect(imageMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(imageMediaType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("picks the batch's ctp submissions with photos", () => {
    const s = { trip: { id: newId() }, player: { A1: newId() } } as unknown as Setup;
    const a = submitOp(s, "A1", 5, "trips/x/ctp/y.jpg");
    const b = submitOp(s, "A1", 5, null);
    const ld = { ...submitOp(s, "A1", 250, "trips/x/ld/y.jpg"), contest_type: "ld" as const };
    expect(ctpEntriesToJudge([a, b, ld, mk("tee.open", { team_id: newId(), hole: 1 })])).toEqual([a.entry_id]);
  });

  it("keeps every photo submission of a big batch (no silent per-batch cap)", () => {
    const s = { trip: { id: newId() }, player: { A1: newId() } } as unknown as Setup;
    const ops = Array.from({ length: 8 }, (_, i) => submitOp(s, "A1", 5 + i, `trips/x/ctp/${i}.jpg`));
    expect(ctpEntriesToJudge(ops)).toEqual(ops.map((o) => o.entry_id));
  });
});

// ---------------------------------------------------------------------------
// judgeEntry
// ---------------------------------------------------------------------------

describe("judgeEntry", () => {
  it("happy path: writes the AI fields (status untouched), posts an ai_judge event, broadcasts", async () => {
    const s = await setup();
    await subscribeAll(s);
    const id = await submit(s, "A1", 10);
    const before = await entryOf(s, id);

    const res = await judgeEntry(s.trip.id, id, deps);
    expect(res).toMatchObject({ status: "written", suspicious: false, estimate_ft: 12, confidence: "high" });

    const after = await entryOf(s, id);
    expect(after).toMatchObject({
      ai_estimate_ft: 12,
      ai_confidence: "high",
      ai_suspicious: false,
      ai_roast: "Twelve feet and a prayer. The putter is already sweating.",
      status: before.status,
      distance_value: 10,
      distance_override: null,
    });
    const [ev] = await feedOf(s, "ai_judge");
    expect(ev).toMatchObject({
      id: deriveId(s.trip.id, `judge:${id}`),
      dedupe_key: `judge:${id}`,
      player_id: s.player.A1,
      team_id: s.team.A,
      payload: { entry_id: id, hole: CTP_HOLE, claimed_ft: 10, estimate_ft: 12, confidence: "high", suspicious: false, roast: "Twelve feet and a prayer. The putter is already sweating." },
    });
    expect(broadcast).toHaveBeenCalledWith(s.trip.id);

    // The request: Sonnet, the photo as a base64 image block plus the claim, 8 s, no retries.
    expect(calls).toHaveLength(1);
    const { params, options } = calls[0];
    expect(params.model).toBe("claude-sonnet-5-5");
    const content = params.messages[0].content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(JPEG).toString("base64") } });
    expect(content[1]).toMatchObject({ type: "text", text: expect.stringContaining("10' 0\"") });
    expect(params.system).toMatch(/7 ft/);
    expect(params.system).toMatch(/4\.25 in/);
    expect(options).toMatchObject({ timeout: 8000, maxRetries: 0 });

    // Not suspicious: no push, no roast.
    expect(pushed).toHaveLength(0);
    expect(await feedOf(s, "roast")).toHaveLength(0);

    // Running it again is a no-op.
    expect(await judgeEntry(s.trip.id, id, deps)).toEqual({ status: "skipped", reason: "already_judged" });
    expect(calls).toHaveLength(1);
  });

  it("suspicious: claimed < 50% of a confident estimate → flag, push to everyone, roast the team", async () => {
    const s = await setup();
    await subscribeAll(s);
    const id = await submit(s, "A2", 3);
    // The model's own "suspicious" opinion is ignored: our rule decides.
    judgeReply = verdict({ estimate_ft: 12, confidence: "medium", suspicious: false, roast: "Three feet? Bring a tape measure and a lawyer." });

    const res = await judgeEntry(s.trip.id, id, deps);
    expect(res).toMatchObject({ status: "written", suspicious: true });
    expect((await entryOf(s, id)).ai_suspicious).toBe(true);
    expect((await entryOf(s, id)).status).toBe("ok"); // the AI never changes the official result
    const [ev] = await feedOf(s, "ai_judge");
    expect(ev.payload).toMatchObject({ suspicious: true, claimed_ft: 3, estimate_ft: 12 });

    // Flag pushed to everyone (tag judge:<entry>), then the roast is throttled for them.
    expect(pushed).toHaveLength(4);
    expect(pushed.every((p) => p.payload.tag === `judge:${id}`)).toBe(true);
    const roasts = await feedOf(s, "roast");
    expect(roasts).toHaveLength(1);
    expect(roasts[0]).toMatchObject({ team_id: s.team.A, payload: { trigger_event_id: ev.id, trigger_type: "ai_judge", hole: CTP_HOLE } });
    expect(roasts[0].text).toMatch(/three feet from twelve/);
  });

  it("low confidence never flags, and a model 'suspicious: true' alone doesn't either", async () => {
    const s = await setup();
    await subscribeAll(s);
    const low = await submit(s, "A1", 2);
    judgeReply = verdict({ estimate_ft: 20, confidence: "low", suspicious: true, roast: "Can't see a thing. Neither can you." });
    expect(await judgeEntry(s.trip.id, low, deps)).toMatchObject({ status: "written", suspicious: false, confidence: "low" });

    const close = await submit(s, "B1", 9);
    judgeReply = verdict({ estimate_ft: 12, confidence: "high", suspicious: true, roast: "Close enough." });
    expect(await judgeEntry(s.trip.id, close, deps)).toMatchObject({ status: "written", suspicious: false });

    expect((await feedOf(s, "ai_judge")).map((e) => e.payload.suspicious)).toEqual([false, false]);
    expect(pushed).toHaveLength(0);
    expect(await feedOf(s, "roast")).toHaveLength(0);
  });

  it("entry deleted while the AI was thinking → nothing written", async () => {
    const s = await setup();
    const id = await submit(s, "A1", 3);
    judgeReply = async () => {
      const del = await applyOpsToTrip({ db, trip: s.trip, ops: [mk("contest.delete", { entry_id: id, by: s.player.A1 })], isCommissioner: false });
      expect(del.results[0].status).toBe("applied");
      return verdict({ estimate_ft: 12, confidence: "high", suspicious: true, roast: "Gone." })();
    };
    expect(await judgeEntry(s.trip.id, id, deps)).toEqual({ status: "skipped", reason: "entry_gone" });
    const e = await entryOf(s, id);
    expect(e.ai_estimate_ft).toBeNull();
    expect(await feedOf(s, "ai_judge")).toHaveLength(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("re-measured meanwhile (the new entry replaces the old) → the old one isn't judged", async () => {
    const s = await setup();
    const first = await submit(s, "A1", 3);
    judgeReply = async () => {
      await submit(s, "A1", 4);
      return verdict({ estimate_ft: 12, confidence: "high", suspicious: true, roast: "Nope." })();
    };
    expect(await judgeEntry(s.trip.id, first, deps)).toEqual({ status: "skipped", reason: "entry_gone" });
    expect(await feedOf(s, "ai_judge")).toHaveLength(0);
  });

  it("timeout (8 s budget) → nothing written", async () => {
    const s = await setup();
    const id = await submit(s, "A1", 3);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    judgeReply = () => new Promise(() => {});
    expect(await judgeEntry(s.trip.id, id, { ...deps, timeoutMs: 40 })).toEqual({ status: "skipped", reason: "ai_failed" });
    expect((await entryOf(s, id)).ai_estimate_ft).toBeNull();
    expect(await feedOf(s, "ai_judge")).toHaveLength(0);
    const log = await db.query<{ meta: Record<string, unknown> }>("select meta from ai_log where trip_id = $1 and kind = 'judge'", [s.trip.id]);
    expect(log.map((r) => r.meta)).toEqual([expect.objectContaining({ ok: false, error: "timeout", entry_id: id })]);
  });

  it("skips silently: no photo, photo missing from storage, junk JSON, AI off", async () => {
    const s = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const noPhoto = await submit(s, "A1", 3, false);
    expect(await judgeEntry(s.trip.id, noPhoto, deps)).toEqual({ status: "skipped", reason: "no_photo" });

    const missing = submitOp(s, "A2", 3, `trips/${s.trip.id}/ctp/${newId()}.jpg`);
    await applyOpsToTrip({ db, trip: s.trip, ops: [missing], isCommissioner: false });
    expect(await judgeEntry(s.trip.id, missing.entry_id, deps)).toEqual({ status: "skipped", reason: "no_photo" });
    expect(calls).toHaveLength(0);

    const junk = await submit(s, "B1", 3);
    judgeReply = () => text("I refuse to judge my friends.");
    expect(await judgeEntry(s.trip.id, junk, deps)).toEqual({ status: "skipped", reason: "ai_failed" });
    judgeReply = verdict({ estimate: "far" });
    expect(await judgeEntry(s.trip.id, junk, deps)).toEqual({ status: "skipped", reason: "bad_response" });

    expect(await judgeEntry(s.trip.id, junk, { ...deps, client: null })).toEqual({ status: "skipped", reason: "ai_off" });
    expect(await judgeEntry(s.trip.id, newId(), deps)).toEqual({ status: "skipped", reason: "no_entry" });
    expect(await feedOf(s, "ai_judge")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cost caps, batches, photo reuse
// ---------------------------------------------------------------------------

const judgeCalls = () => calls.filter((c) => c.params.system === JUDGE_SYSTEM_PROMPT);

describe("cost caps", () => {
  it("stops at the per-trip cap: no AI call once the trip has used its judge budget", async () => {
    const s = await setup();
    const id = await submit(s, "A1", 10);
    await db.query(
      "insert into ai_log (trip_id, kind, meta) select $1::uuid, 'judge', '{}'::jsonb from generate_series(1, $2::int)",
      [s.trip.id, MAX_JUDGE_CALLS_PER_TRIP],
    );
    expect(await judgeEntry(s.trip.id, id, deps)).toEqual({ status: "skipped", reason: "cap" });
    expect(calls).toHaveLength(0);
    expect(await feedOf(s, "ai_judge")).toHaveLength(0);
  });

  it("a player re-submitting fresh photos on one hole gets 3 judge calls, then no more (others still get judged)", async () => {
    const s = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    judgeReply = () => text("No."); // the model refuses: every call still costs, and counts
    for (let i = 0; i < MAX_JUDGE_CALLS_PER_PLAYER_HOLE; i++) {
      const id = await submit(s, "A1", 10 + i);
      expect(await judgeEntry(s.trip.id, id, deps)).toEqual({ status: "skipped", reason: "ai_failed" });
    }
    const again = await submit(s, "A1", 20);
    expect(await judgeEntry(s.trip.id, again, deps)).toEqual({ status: "skipped", reason: "cap" });
    expect(judgeCalls()).toHaveLength(MAX_JUDGE_CALLS_PER_PLAYER_HOLE);

    judgeReply = verdict({ estimate_ft: 12, confidence: "high", suspicious: false, roast: "Fine." });
    const teammate = await submit(s, "A2", 11);
    expect(await judgeEntry(s.trip.id, teammate, deps)).toMatchObject({ status: "written", reused: false });
    const log = await db.query<{ meta: Record<string, unknown> }>("select meta from ai_log where trip_id = $1 and kind = 'judge' order by created_at", [s.trip.id]);
    expect(log.at(-1)!.meta).toMatchObject({ entry_id: teammate, player_id: s.player.A2, hole: CTP_HOLE });
  });

  it("never pays twice for one photo: a re-measure that kept its photo reuses the verdict, and a new lie still gets flagged", async () => {
    const s = await setup();
    await subscribeAll(s);
    const shot = await photo(s);
    const first = submitOp(s, "A1", 10, shot);
    await applyOpsToTrip({ db, trip: s.trip, ops: [first], isCommissioner: false });
    expect(await judgeEntry(s.trip.id, first.entry_id, deps)).toMatchObject({ status: "written", suspicious: false, estimate_ft: 12, reused: false });

    // A straight re-measure on the same photo carries the verdict over in the reducer: nothing to do.
    const remeasure = submitOp(s, "A1", 9, shot);
    await applyOpsToTrip({ db, trip: s.trip, ops: [remeasure], isCommissioner: false });
    expect(await judgeEntry(s.trip.id, remeasure.entry_id, deps)).toEqual({ status: "skipped", reason: "already_judged" });
    // Pulled, then re-entered with the same photo and a new claim: 3 ft (the AI said ~12).
    await applyOpsToTrip({ db, trip: s.trip, ops: [mk("contest.delete", { entry_id: remeasure.entry_id, by: s.player.A1 })], isCommissioner: false });
    const edit = submitOp(s, "A1", 3, shot);
    await applyOpsToTrip({ db, trip: s.trip, ops: [edit], isCommissioner: false });
    expect((await entryOf(s, edit.entry_id)).ai_estimate_ft).toBeNull();
    const res = await judgeEntry(s.trip.id, edit.entry_id, deps);
    expect(res).toMatchObject({ status: "written", suspicious: true, estimate_ft: 12, confidence: "high", reused: true });
    expect(judgeCalls()).toHaveLength(1);
    expect(await entryOf(s, edit.entry_id)).toMatchObject({ ai_estimate_ft: 12, ai_confidence: "high", ai_suspicious: true, ai_roast: null });
    const events = await feedOf(s, "ai_judge");
    expect(events.map((e) => [e.payload.entry_id, e.payload.suspicious])).toEqual([
      [first.entry_id, false],
      [edit.entry_id, true],
    ]);
    expect(pushed.length).toBeGreaterThan(0); // the new flag is news
  });

  it("money review repro: an edit that keeps the photo and lowers the claim posts the flag (no AI call); undoing it doesn't re-announce", async () => {
    const s = await setup();
    const shot = await photo(s);
    const first = submitOp(s, "A1", 10, shot);
    await applyOpsToTrip({ db, trip: s.trip, ops: [first], isCommissioner: false });
    expect(await judgeEntry(s.trip.id, first.entry_id, deps)).toMatchObject({ status: "written", suspicious: false, estimate_ft: 12, posted: true });

    // "Edit my closest to pin" -> keep the photo -> 2 ft. The verdict carries over: flagged, and posted.
    const edit = submitOp(s, "A1", 2, shot);
    const out = await applyOpsToTrip({ db, trip: s.trip, ops: [edit], isCommissioner: false });
    const flag = out.events.feed.find((e) => e.type === "ai_judge")!;
    expect(flag).toMatchObject({ dedupe_key: `judge:${edit.entry_id}`, payload: { entry_id: edit.entry_id, suspicious: true, carried: true } });
    expect(out.events.push_triggers.map((p) => p.collapse_key)).toContain(`judge:${edit.entry_id}`);
    expect(out.events.roast_triggers.map((r) => r.feed_event_id)).toContain(flag.id);
    expect(await judgeEntry(s.trip.id, edit.entry_id, deps)).toEqual({ status: "skipped", reason: "already_judged" });

    // Undo the edit: pull it and restore the 10-footer under a new id (no verdict carried, no active
    // entry to carry from). The judge reuses the photo's verdict but doesn't post it a second time.
    const undo = [mk("contest.delete", { entry_id: edit.entry_id, by: s.player.A1 }), submitOp(s, "A1", 10, shot)];
    await applyOpsToTrip({ db, trip: s.trip, ops: undo, isCommissioner: false });
    const restored = undo[1] as OpOf<"contest.submit">;
    const pushesBefore = pushed.length;
    expect(await judgeEntry(s.trip.id, restored.entry_id, deps)).toMatchObject({ status: "written", suspicious: false, reused: true, posted: false });
    expect(await entryOf(s, restored.entry_id)).toMatchObject({ ai_estimate_ft: 12, ai_suspicious: false });
    expect((await feedOf(s, "ai_judge")).map((e) => [e.payload.entry_id, e.payload.suspicious])).toEqual([
      [first.entry_id, false],
      [edit.entry_id, true],
    ]);
    expect(pushed.length).toBe(pushesBefore);
    expect(judgeCalls()).toHaveLength(1);
  });

  it("the same entry is never judged twice at once (upload route vs sync hook race)", async () => {
    const s = await setup();
    const id = await submit(s, "A1", 10);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    judgeReply = async () => {
      await gate;
      return verdict({ estimate_ft: 12, confidence: "high", suspicious: false, roast: "Fine." })();
    };
    const a = judgeEntry(s.trip.id, id, deps);
    await new Promise((r) => setTimeout(r, 30));
    expect(await judgeEntry(s.trip.id, id, deps)).toEqual({ status: "skipped", reason: "in_progress" });
    release();
    expect(await a).toMatchObject({ status: "written" });
    expect(judgeCalls()).toHaveLength(1);
  });
});

describe("batches", () => {
  it("judges every photo entry of a batch flushed after a dead zone (8 entries on two holes)", async () => {
    const s = await setup([4, 4]);
    const ops: Op[] = [];
    for (const hole of [CTP_HOLE, 8]) {
      for (const label of ["A1", "A2", "B1", "B2"]) ops.push(submitOp(s, label, 5 + ops.length, await photo(s), newId(), hole));
    }
    const out = await applyOpsToTrip({ db, trip: s.trip, ops, isCommissioner: false });
    expect(out.results.every((r) => r.status === "applied")).toBe(true);
    const results = await judgeHook({ trip: out.snapshot.state.trip, events: out.events, ops: out.applied, results: out.results, state: out.snapshot.state }, deps);
    expect(results.map((r) => r.status)).toEqual(Array(8).fill("written"));
    const judged = new Set((await feedOf(s, "ai_judge")).map((e) => e.payload.entry_id));
    expect(judged).toEqual(new Set(ops.map((o) => (o as OpOf<"contest.submit">).entry_id)));
    expect(judgeCalls()).toHaveLength(8);
  });

  it("doesn't start new judgments past the time budget (they're logged, not hung)", async () => {
    const s = await setup([4, 4]);
    const ids = [await submit(s, "A1", 5), await submit(s, "A2", 6), await submit(s, "B1", 7)];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    judgeReply = async () => {
      await new Promise((r) => setTimeout(r, 60));
      return verdict({ estimate_ft: 12, confidence: "high", suspicious: false, roast: "Fine." })();
    };
    const res = await judgeEntries(s.trip.id, ids, { ...deps, concurrency: 1, budgetMs: 30 });
    expect(res.map((r) => (r.status === "skipped" ? r.reason : r.status))).toEqual(["written", "budget", "budget"]);
  });
});

describe("a closest-to-pin photo that arrives after its entry", () => {
  const uploadReq = (s: Setup, p: string) =>
    uploadRoute(
      new Request(`http://localhost:3000/api/t/${s.trip.code}/upload?path=${encodeURIComponent(p)}`, {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: JPEG,
      }),
      { params: Promise.resolve({ code: s.trip.code }) },
    );

  it("gets judged from the upload route, after the response", async () => {
    const s = await setup();
    const p = `trips/${s.trip.id}/ctp/${newId()}.jpg`;
    const op = submitOp(s, "A1", 4, p);
    const out = await applyOpsToTrip({ db, trip: s.trip, ops: [op], isCommissioner: false });
    // The sync hook ran first: no bytes yet.
    expect(await judgeHook({ trip: s.trip, events: out.events, ops: out.applied, results: out.results, state: out.snapshot.state }, deps)).toEqual([
      { status: "skipped", reason: "no_photo" },
    ]);
    expect(judgeCalls()).toHaveLength(0);

    const res = await uploadReq(s, p);
    expect(res.status).toBe(200);
    expect(judgeCalls()).toHaveLength(0); // nothing before the response
    expect(afterMock.tasks).toHaveLength(1);
    const [outcome] = (await Promise.all(afterMock.tasks.splice(0).map((t) => t()))) as unknown[];
    expect(outcome).toMatchObject({ status: "written" });
    expect((await feedOf(s, "ai_judge")).map((e) => e.payload.entry_id)).toEqual([op.entry_id]);

    // A retried upload of the same photo doesn't judge it again.
    expect((await uploadReq(s, p)).status).toBe(200);
    await Promise.all(afterMock.tasks.splice(0).map((t) => t()));
    expect(judgeCalls()).toHaveLength(1);
  });

  it("only ctp photos, only for an active unjudged entry, never on a demo trip without DEMO_AI", async () => {
    const s = await setup();
    const drinkPhoto = `trips/${s.trip.id}/drinks/${newId()}.jpg`;
    expect((await uploadReq(s, drinkPhoto)).status).toBe(200);
    expect(afterMock.tasks).toHaveLength(0);
    expect(await judgeUploadedPhoto(s.trip, `trips/${s.trip.id}/ctp/${newId()}.jpg`, deps)).toBeNull(); // no entry points at it
    expect(await judgeUploadedPhoto(s.trip, drinkPhoto, deps)).toBeNull();

    const p = await photo(s);
    const op = submitOp(s, "A1", 4, p);
    await applyOpsToTrip({ db, trip: s.trip, ops: [op], isCommissioner: false });
    expect(await judgeUploadedPhoto({ ...s.trip, is_demo: true }, p, {})).toBeNull();
    expect(judgeCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hooks, end to end
// ---------------------------------------------------------------------------

describe("post-commit integration", () => {
  it("judgeHook judges the batch's ctp submissions (not ones replaced in the same batch)", async () => {
    const s = await setup();
    const replaced = submitOp(s, "A1", 2, await photo(s));
    const kept = submitOp(s, "A1", 9, await photo(s));
    const out = await applyOpsToTrip({ db, trip: s.trip, ops: [replaced, kept], isCommissioner: false });
    const results = await judgeHook({ trip: out.snapshot.state.trip, events: out.events, ops: out.applied, results: out.results, state: out.snapshot.state }, deps);
    expect(results.map((r) => r.status)).toEqual(["written"]);
    expect((await feedOf(s, "ai_judge")).map((e) => e.payload.entry_id)).toEqual([kept.entry_id]);

    setAiClientForTests(null);
    expect(await judgeHook({ trip: s.trip, events: out.events, ops: out.applied, results: out.results })).toEqual([]);
  });

  it("the sync route registers the integrations and the judge runs after the response", async () => {
    expect(postCommitHookNames()).toEqual(expect.arrayContaining(["ai-judge", "ai-roasts", "push"]));
    const s = await setup();
    await subscribeAll(s);
    const op = submitOp(s, "B1", 2.5, await photo(s));
    judgeReply = verdict({ estimate_ft: 14, confidence: "high", suspicious: true, roast: "Two and a half feet. Sure, buddy." });
    const res = await syncRoute(
      new Request(`http://localhost:3000/api/t/${s.trip.code}/sync`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops: [op] }) }),
      { params: Promise.resolve({ code: s.trip.code }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SyncResponse;
    expect(body.results).toEqual([{ id: op.id, status: "applied" }]);
    // Nothing AI happened before the response.
    expect(calls).toHaveLength(0);
    expect(afterMock.tasks).toHaveLength(1);

    const [report] = (await Promise.all(afterMock.tasks.splice(0).map((t) => t()))) as Array<{ hooks: Record<string, string> }>;
    expect(report.hooks).toMatchObject({ "ai-judge": "ok", "ai-roasts": "ok", push: "ok" });
    const judged = await feedOf(s, "ai_judge");
    expect(judged).toHaveLength(1);
    expect(judged[0].payload).toMatchObject({ entry_id: op.entry_id, suspicious: true });
    expect(await feedOf(s, "roast")).toHaveLength(1);
    expect(pushed.length).toBeGreaterThan(0);
  });
});
