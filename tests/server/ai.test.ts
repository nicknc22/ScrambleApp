// The AI layer (src/lib/server/ai.ts): client gating, timeouts, never-throw, ai_log, JSON
// extraction, the off-limits topic filter, and AI team names (lib + route) with a fake client.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, setDbForTests, type DbConnection } from "@/lib/server/db";
import { createTrip } from "@/lib/server/trips";
import {
  AI_TIMEOUT_MS,
  DEFAULT_FAST_MODEL,
  DEFAULT_JUDGE_MODEL,
  FALLBACK_TEAM_NAMES,
  aiAvailable,
  aiJson,
  aiText,
  cleanTeamName,
  containsBannedTopic,
  countAiCalls,
  extractJson,
  fallbackTeamNames,
  fastModel,
  generateTeamNames,
  getAiClient,
  judgeModel,
  setAiClientForTests,
  type AiClient,
  type AiResponse,
} from "@/lib/server/ai";
import type { Trip } from "@/lib/types";
import type Anthropic from "@anthropic-ai/sdk";
import { POST as teamNamesRoute } from "@/app/api/t/[code]/ai/team-names/route";

const PIN_HASH = "scrypt$c2FsdA$aGFzaA";

let calls: Array<{ params: Anthropic.MessageCreateParamsNonStreaming; options?: Anthropic.RequestOptions }> = [];
let reply: (params: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions) => Promise<AiResponse> | AiResponse;
const text = (t: string, stop = "end_turn"): AiResponse => ({ content: [{ type: "thinking" }, { type: "text", text: t }], stop_reason: stop, usage: { input_tokens: 12, output_tokens: 34 } });
const fake: AiClient = {
  messages: {
    create: async (params, options) => {
      calls.push({ params, options });
      return reply(params, options);
    },
  },
};

let db: DbConnection;
let trip: Trip;

beforeAll(async () => {
  db = await createTestDb();
  setDbForTests(db);
  trip = await createTrip(db, { name: "AI Trip", app_name: "Scramble", pin_hash: PIN_HASH });
});

afterAll(async () => {
  setDbForTests(null);
  await db?.close();
});

beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "AI_JUDGE_MODEL", "AI_FAST_MODEL"]) vi.stubEnv(k, "");
  calls = [];
  reply = () => text("hello");
});

afterEach(() => {
  setAiClientForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function logRows(kind: string) {
  return db.query<{ kind: string; meta: Record<string, unknown> }>("select kind, meta from ai_log where trip_id = $1 and kind = $2 order by created_at", [trip.id, kind]);
}

// ---------------------------------------------------------------------------
// Client + models
// ---------------------------------------------------------------------------

describe("client gating and models", () => {
  it("AI is off without ANTHROPIC_API_KEY, on with it, and a test client overrides", () => {
    expect(getAiClient()).toBeNull();
    expect(aiAvailable()).toBe(false);
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const real = getAiClient();
    expect(real).not.toBeNull();
    expect(getAiClient()).toBe(real); // cached per key
    setAiClientForTests(fake);
    expect(getAiClient()).toBe(fake);
    expect(aiAvailable()).toBe(true);
  });

  it("models default to Sonnet 5.5 (judge) and Haiku 5.5 (fast) and follow env overrides", () => {
    expect(DEFAULT_JUDGE_MODEL).toBe("claude-sonnet-5-5");
    expect(DEFAULT_FAST_MODEL).toBe("claude-haiku-5-5");
    expect(judgeModel()).toBe("claude-sonnet-5-5");
    expect(fastModel()).toBe("claude-haiku-5-5");
    vi.stubEnv("AI_JUDGE_MODEL", "claude-opus-5-5");
    vi.stubEnv("AI_FAST_MODEL", "claude-haiku-4-5");
    expect(judgeModel()).toBe("claude-opus-5-5");
    expect(fastModel()).toBe("claude-haiku-4-5");
  });
});

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

const req = (over: Partial<Parameters<typeof aiText>[0]> = {}): Parameters<typeof aiText>[0] => ({
  kind: "roast",
  tripId: trip.id,
  model: "claude-haiku-5-5",
  system: "be mean",
  content: "roast them",
  maxTokens: 300,
  ...over,
});

describe("aiText / aiJson", () => {
  it("sends model/system/user/max_tokens/effort with an 8 s signal and no retries; returns the text blocks; logs", async () => {
    reply = () => text("  Nice shank.  ");
    expect(await aiText(req(), { client: fake })).toBe("Nice shank.");
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 300,
      system: "be mean",
      messages: [{ role: "user", content: "roast them" }],
      output_config: { effort: "low" },
    });
    expect(calls[0].options).toMatchObject({ timeout: AI_TIMEOUT_MS, maxRetries: 0 });
    expect(calls[0].options?.signal).toBeInstanceOf(AbortSignal);
    const [row] = await logRows("roast");
    expect(row.meta).toMatchObject({ model: "claude-haiku-5-5", ok: true, input_tokens: 12, output_tokens: 34 });
    expect(await countAiCalls(trip.id, "roast")).toBeGreaterThanOrEqual(1);
  });

  it("doesn't send effort to older models", async () => {
    await aiText(req({ model: "claude-haiku-4-5" }), { client: fake });
    expect(calls[0].params).not.toHaveProperty("output_config");
  });

  it("returns null (never throws) when AI is off, on errors, refusals, truncation, empty text and timeouts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await aiText(req())).toBeNull(); // no key, no override
    expect(await aiText(req(), { client: null })).toBeNull();

    reply = () => {
      throw new Error("529 overloaded");
    };
    expect(await aiText(req({ kind: "team_names" }), { client: fake })).toBeNull();
    reply = () => ({ content: [], stop_reason: "refusal" });
    expect(await aiText(req({ kind: "team_names" }), { client: fake })).toBeNull();
    reply = () => text("Half a sen", "max_tokens");
    expect(await aiText(req({ kind: "team_names" }), { client: fake })).toBeNull();
    reply = () => text("   ");
    expect(await aiText(req({ kind: "team_names" }), { client: fake })).toBeNull();

    // A client that ignores the abort signal still can't hold us past the timeout.
    let signal: AbortSignal | undefined;
    reply = (_p, o) => {
      signal = o?.signal ?? undefined;
      return new Promise(() => {});
    };
    const started = Date.now();
    expect(await aiText(req({ kind: "team_names", timeoutMs: 40 }), { client: fake })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);

    const rows = await logRows("team_names");
    expect(rows.map((r) => r.meta.ok)).toEqual([false, false, false, false, false]);
    expect(rows[rows.length - 1].meta.error).toBe("timeout");
  });

  it("logs nothing (and still works) when the trip id is null or the log write fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reply = () => text("ok then");
    expect(await aiText(req({ tripId: null }), { client: fake })).toBe("ok then");
    const broken = { query: async () => { throw new Error("db down"); }, tx: async () => { throw new Error("db down"); } };
    expect(await aiText(req(), { client: fake, db: broken })).toBe("ok then");
  });

  it("aiJson extracts the object or returns null", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    reply = () => text('Sure! ```json\n{"a": 1}\n```');
    expect(await aiJson(req(), { client: fake })).toEqual({ a: 1 });
    reply = () => text("no json here, champ");
    expect(await aiJson(req(), { client: fake })).toBeNull();
  });
});

describe("the real SDK client against a local stub API", () => {
  it("sends a well-formed Messages request and reads the response; a hung server times out", async () => {
    const http = await import("node:http");
    const seen: Array<{ url: string; headers: Record<string, unknown>; body: Record<string, unknown> }> = [];
    let hang = false;
    const server = http.createServer((rq, rs) => {
      let raw = "";
      rq.on("data", (c) => (raw += c));
      rq.on("end", () => {
        seen.push({ url: rq.url ?? "", headers: rq.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
        if (hang) return; // never answer
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-5-5",
            content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: '{"names": ["Sip Happens"]}' }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      vi.stubEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("ANTHROPIC_API_KEY", `sk-ant-stub-${port}`); // new key → new client with this base URL
      expect(await aiJson(req({ kind: "team_names" }))).toEqual({ names: ["Sip Happens"] });
      expect(seen[0].url).toBe("/v1/messages");
      expect(seen[0].headers["x-api-key"]).toBe(`sk-ant-stub-${port}`);
      expect(seen[0].body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 300, system: "be mean", output_config: { effort: "low" } });

      hang = true;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const started = Date.now();
      expect(await aiText(req({ kind: "team_names", timeoutMs: 150 }))).toBeNull();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(seen).toHaveLength(2); // no retry
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe("extractJson", () => {
  it("handles bare JSON, fences, prose and braces inside strings", () => {
    expect(extractJson('{"estimate_ft": 12.5, "confidence": "high"}')).toEqual({ estimate_ft: 12.5, confidence: "high" });
    expect(extractJson('```json\n{"x": [1, 2]}\n```')).toEqual({ x: [1, 2] });
    expect(extractJson('```\n{"x": 1}\n```')).toEqual({ x: 1 });
    expect(extractJson('Here you go: {"roast": "nice {brace} work", "n": {"deep": true}} hope that helps')).toEqual({
      roast: "nice {brace} work",
      n: { deep: true },
    });
    expect(extractJson('junk {not json} then {"ok": true}')).toEqual({ ok: true });
    expect(extractJson('{"quote": "she said \\"hi\\" }"}')).toEqual({ quote: 'she said "hi" }' });
    expect(extractJson("[1, 2, 3]")).toBeNull();
    expect(extractJson("nothing")).toBeNull();
    expect(extractJson('{"unterminated": ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Content filter
// ---------------------------------------------------------------------------

describe("containsBannedTopic", () => {
  it("flags partners/fiancées, families, jobs and appearance", () => {
    for (const bad of [
      "Your fiancée would putt better.",
      "He plays like his wife is watching.",
      "Even his girlfriend could chip that.",
      "Swinging like the wedding is tomorrow.",
      "Getting married won't fix that slice.",
      "Your mom has a better short game.",
      "His dad must be so proud.",
      "Take the kids home, Team A.",
      "Don't quit your day job.",
      "Back to the office Monday with that handicap.",
      "Nick's boss saw that shank.",
      "Bald as the 7th green.",
      "That beer belly is blocking the backswing.",
      "Fix your hairline before your grip.",
      "Look at his face after that triple.",
      "Nice outfit, shame about the score.",
    ]) {
      expect(containsBannedTopic(bad), bad).toBe(true);
    }
  });

  it("lets golf, drinking and decisions through (incl. idioms that look close)", () => {
    for (const ok of [
      "Nice job, Team A: a triple bogey and three shotguns before noon.",
      "Shotgunned it like a boss and still three-putted.",
      "Hit it fat, hit it thin, hit it into the pond. Hat trick.",
      "Carrying that much dead weight on a par 5 should be illegal.",
      "In your face, Team B! Oh wait, you're still in last.",
      "The groom burned his mulligan on a 4-footer. Bold strategy.",
      "Belly up to the beer cart, boys, you're going to need the credit.",
      "That clubface was open like the bar tab.",
    ]) {
      expect(containsBannedTopic(ok), ok).toBe(false);
    }
  });

  it("ignores allowed names (a player nicknamed Big Dad)", () => {
    expect(containsBannedTopic("Big Dad shanked it into the parking lot.")).toBe(true);
    expect(containsBannedTopic("Big Dad shanked it into the parking lot.", ["Big Dad"])).toBe(false);
    expect(containsBannedTopic("Big Dad shanked it and his wife saw.", ["Big Dad"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Team names
// ---------------------------------------------------------------------------

describe("team names", () => {
  it("the built-in list has 40+ unique, short, on-topic names", () => {
    expect(FALLBACK_TEAM_NAMES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(FALLBACK_TEAM_NAMES.map((n) => n.toLowerCase())).size).toBe(FALLBACK_TEAM_NAMES.length);
    for (const n of FALLBACK_TEAM_NAMES) {
      expect(cleanTeamName(n), n).toBe(n);
    }
    const picked = fallbackTeamNames(["Bogey Nights", "Shank Redemption"]);
    expect(picked).toHaveLength(5);
    expect(new Set(picked).size).toBe(5);
    expect(picked).not.toContain("Bogey Nights");
  });

  it("cleanTeamName strips numbering/quotes and rejects junk", () => {
    expect(cleanTeamName('1. "Grip It and Sip It"')).toBe("Grip It and Sip It");
    expect(cleanTeamName("- Fore Play")).toBe("Fore Play");
    expect(cleanTeamName("x".repeat(40))).toBeNull();
    expect(cleanTeamName("123")).toBeNull();
    expect(cleanTeamName("The Fiancée Fan Club")).toBeNull();
    expect(cleanTeamName(42)).toBeNull();
  });

  it("AI path: 5 cleaned unique names from the fast model, topped up when it comes back short", async () => {
    reply = () => text('{"names": ["Sip Happens", "1. Sip Happens", "Wives Gone Wild", "Team Taken", "Par-Tee Fouls", "Shanksgiving"]}');
    const r = await generateTeamNames({ tripId: trip.id, seed: "Nick's last stand", existing: ["Team Taken"] }, { client: fake });
    expect(r.ai).toBe(true);
    expect(r.names).toHaveLength(5);
    expect(r.names.slice(0, 3)).toEqual(["Sip Happens", "Par-Tee Fouls", "Shanksgiving"]);
    expect(new Set(r.names.map((n) => n.toLowerCase())).size).toBe(5);
    expect(r.names).not.toContain("Team Taken");
    expect(calls[0].params.model).toBe("claude-haiku-5-5");
    const user = String(calls[0].params.messages[0].content);
    expect(user).toContain("Nick's last stand");
    expect(user).toContain('"Team Taken"');
  });

  it("fallback (ai: false) when AI is off, fails, times out or returns junk", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = await generateTeamNames({ tripId: trip.id }, { client: null });
    expect(off.ai).toBe(false);
    expect(off.names).toHaveLength(5);
    for (const n of off.names) expect(FALLBACK_TEAM_NAMES).toContain(n);

    reply = () => text("I'd rather not.");
    expect((await generateTeamNames({ tripId: trip.id }, { client: fake })).ai).toBe(false);
    reply = () => text('{"names": ["Wives and Knives", "x"]}');
    expect((await generateTeamNames({ tripId: trip.id }, { client: fake })).ai).toBe(false);
    reply = () => new Promise(() => {});
    const slow = await generateTeamNames({ tripId: trip.id }, { client: fake, timeoutMs: 30 });
    expect(slow).toMatchObject({ ai: false });
    expect(slow.names).toHaveLength(5);
  });

  describe("POST /api/t/[code]/ai/team-names", () => {
    const post = (code: string, body?: unknown) =>
      teamNamesRoute(
        new Request(`http://localhost:3000/api/t/${code}/ai/team-names`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
        { params: Promise.resolve({ code }) },
      );

    it("returns AI names when AI is on, built-in names when off; 404 for unknown trips", async () => {
      const t = await createTrip(db, { name: "Names Trip", app_name: "Scramble", pin_hash: PIN_HASH });
      const off = await post(t.code);
      expect(off.status).toBe(200);
      const offBody = (await off.json()) as { names: string[]; ai: boolean };
      expect(offBody.ai).toBe(false);
      expect(offBody.names).toHaveLength(5);

      setAiClientForTests(fake);
      reply = () => text('{"names": ["Sip Happens", "Par-Tee Fouls", "Shanksgiving", "Hooked on Tonics", "Ace Holes"]}');
      const on = await post(t.code, { seed: "golf" });
      expect(await on.json()).toEqual({ names: ["Sip Happens", "Par-Tee Fouls", "Shanksgiving", "Hooked on Tonics", "Ace Holes"], ai: true });

      expect((await post("nosuchtrip9")).status).toBe(404);
    });

    it("rate-limits AI calls per trip (then serves built-in names)", async () => {
      const t = await createTrip(db, { name: "Spammy Trip", app_name: "Scramble", pin_hash: PIN_HASH });
      setAiClientForTests(fake);
      reply = () => text('{"names": ["Sip Happens", "Par-Tee Fouls", "Shanksgiving", "Hooked on Tonics", "Ace Holes"]}');
      const results: boolean[] = [];
      for (let i = 0; i < 14; i++) results.push(((await (await post(t.code)).json()) as { ai: boolean }).ai);
      expect(results.filter(Boolean)).toHaveLength(12);
      expect(results.slice(12)).toEqual([false, false]);
      expect(calls).toHaveLength(12);
    });
  });
});
