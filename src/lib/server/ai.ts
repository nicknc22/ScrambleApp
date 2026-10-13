// Anthropic Messages API access for the AI features (closest-to-pin judge, roasts, team names).
//
//   - The client exists only when ANTHROPIC_API_KEY is set (created lazily, cached per key).
//     Tests inject a fake with setAiClientForTests().
//   - Every call has a hard timeout (8 s by default: an AbortSignal plus our own race, so even a
//     client that ignores the signal can't hang a hook) and NO retries (a retry can't fit in 8 s).
//   - Callers never see a throw: failures, timeouts, refusals and truncated output return null.
//   - Each call writes one ai_log row (kind, model, ok, ms, tokens) for observability and cost caps.
//
// Models: AI_JUDGE_MODEL (default claude-sonnet-5-5, needs image input) and AI_FAST_MODEL
// (default claude-haiku-5-5, roasts + team names). Read on every call so env changes apply live.
//
// Also home to the shared content filter (roasts and team names stay on golf, drinking and
// on-course decisions: never partners/fiancées, families, jobs or appearance) and the AI team
// name generator behind POST /api/t/<code>/ai/team-names.
import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "./db";
import { getDb } from "./db";
import { anthropicApiKey } from "./env";

export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_FAST_MODEL = "claude-haiku-5-5";
/** Spec: "If the API fails, times out (8 s) ... skip silently." Applies to every AI call. */
export const AI_TIMEOUT_MS = 8000;

function envModel(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

/** Image-capable model for the closest-to-pin judge. */
export function judgeModel(): string {
  return envModel("AI_JUDGE_MODEL", DEFAULT_JUDGE_MODEL);
}

/** Cheap fast model for roasts and team names. */
export function fastModel(): string {
  return envModel("AI_FAST_MODEL", DEFAULT_FAST_MODEL);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** The slice of a Messages API response we read. */
export interface AiResponse {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
}

/** The slice of the Anthropic client we use (tests pass a fake with the same shape). */
export interface AiClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): PromiseLike<AiResponse>;
  };
}

interface AiGlobals {
  real?: { key: string; client: AiClient };
  /** Test override: a fake client (AI counts as enabled while set). */
  override?: AiClient | null;
}
const G = globalThis as typeof globalThis & { __scrambleAi?: AiGlobals };
const ag: AiGlobals = (G.__scrambleAi ??= {});

/** Tests: route every AI call to `client` (null restores the real, env-driven one). */
export function setAiClientForTests(client: AiClient | null): void {
  ag.override = client;
}

/** The client to use, or null when AI is off (no ANTHROPIC_API_KEY and no test override). */
export function getAiClient(): AiClient | null {
  if (ag.override) return ag.override;
  const key = anthropicApiKey();
  if (!key) return null;
  if (ag.real?.key !== key) {
    const sdk = new Anthropic({ apiKey: key, maxRetries: 0, timeout: AI_TIMEOUT_MS });
    ag.real = {
      key,
      client: { messages: { create: (params, options) => sdk.messages.create(params, options) } },
    };
  }
  return ag.real.client;
}

/** AI features can run (a key is configured, or a test client is injected). */
export function aiAvailable(client?: AiClient | null): boolean {
  return (client ?? getAiClient()) !== null;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export type AiKind = "judge" | "roast" | "team_names";

export interface AiRequest {
  kind: AiKind;
  /** For ai_log (null: not logged). */
  tripId: string | null;
  model: string;
  system: string;
  /** The single user turn. */
  content: string | Anthropic.ContentBlockParam[];
  maxTokens: number;
  /** Default AI_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Extra ai_log meta (no secrets, no photo bytes). */
  meta?: Record<string, unknown>;
}

export interface AiDeps {
  db?: Db;
  /** Override the client (tests). undefined = getAiClient(). */
  client?: AiClient | null;
}

export class AiTimeoutError extends Error {
  constructor(ms: number) {
    super(`AI call timed out after ${ms} ms`);
    this.name = "AiTimeoutError";
  }
}

/**
 * Current model families take an effort level (low = fastest, which is what an 8 s budget needs).
 * Older models reject the parameter, so only send it to the ones we know accept it.
 */
function effortFor(model: string): Pick<Anthropic.MessageCreateParamsNonStreaming, "output_config"> {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-5(\b|-)/.test(model) ? { output_config: { effort: "low" } } : {};
}

function describeError(e: unknown): { error: string; status?: number } {
  if (e instanceof AiTimeoutError) return { error: "timeout" };
  if (e instanceof Anthropic.APIError) return { error: `${e.name}: ${e.message}`.slice(0, 300), status: e.status };
  if (e instanceof Error) return { error: `${e.name}: ${e.message}`.slice(0, 300) };
  return { error: String(e).slice(0, 300) };
}

async function logCall(db: Db, req: AiRequest, meta: Record<string, unknown>): Promise<void> {
  if (!req.tripId) return;
  try {
    await db.query("insert into ai_log (trip_id, kind, meta) values ($1, $2, $3)", [
      req.tripId,
      req.kind,
      { model: req.model, ...req.meta, ...meta },
    ]);
  } catch (e) {
    console.warn(`[ai] couldn't write ai_log for ${req.kind}: ${describeError(e).error}`);
  }
}

/** Number of AI calls of `kind` logged for a trip (successful or not). Never throws (0). */
export async function countAiCalls(tripId: string, kind: AiKind, db: Db = getDb()): Promise<number> {
  try {
    const rows = await db.query<{ n: number }>("select count(*)::int as n from ai_log where trip_id = $1 and kind = $2", [tripId, kind]);
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * One Messages API call → the response text (text blocks joined), or null on ANY problem:
 * AI off, timeout, API error, refusal, truncated output, empty text. Never throws.
 */
export async function aiText(req: AiRequest, deps: AiDeps = {}): Promise<string | null> {
  const client = deps.client === undefined ? getAiClient() : deps.client;
  if (!client) return null;
  const db = deps.db ?? getDb();
  const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : AI_TIMEOUT_MS;
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.content }],
      ...effortFor(req.model),
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AiTimeoutError(timeoutMs));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    const call = Promise.resolve().then(() =>
      client.messages.create(params, { signal: controller.signal, timeout: timeoutMs, maxRetries: 0 }),
    );
    call.catch(() => undefined); // a late rejection after the timeout won is expected, not unhandled
    const res = await Promise.race([call, timeout]);

    const text = (res.content ?? [])
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
    const usage = { input_tokens: res.usage?.input_tokens ?? null, output_tokens: res.usage?.output_tokens ?? null };
    const stop = res.stop_reason ?? null;
    if (stop === "refusal" || stop === "max_tokens" || !text) {
      await logCall(db, req, { ok: false, ms: Date.now() - started, stop_reason: stop, ...usage, error: text ? stop : "empty" });
      return null;
    }
    await logCall(db, req, { ok: true, ms: Date.now() - started, stop_reason: stop, ...usage });
    return text;
  } catch (e) {
    const info = describeError(e);
    console.warn(`[ai] ${req.kind} call failed (${req.model}): ${info.error}`);
    await logCall(db, req, { ok: false, ms: Date.now() - started, ...info });
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** aiText + extractJson: the first JSON object in the response, or null. Never throws. */
export async function aiJson(req: AiRequest, deps: AiDeps = {}): Promise<Record<string, unknown> | null> {
  const text = await aiText(req, deps);
  if (text === null) return null;
  const parsed = extractJson(text);
  if (!parsed) console.warn(`[ai] ${req.kind}: response had no JSON object`);
  return parsed;
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function tryParse(s: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(s));
  } catch {
    return null;
  }
}

/** End index (inclusive) of the balanced {...} starting at `start`, string-aware; -1 if unbalanced. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The first JSON object in a model response: tolerates ```json fences, prose before/after and
 * braces inside strings. Returns null when there is none.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const candidates: string[] = [];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const whole = tryParse(c.trim());
    if (whole) return whole;
    for (let i = c.indexOf("{"); i !== -1; i = c.indexOf("{", i + 1)) {
      const end = matchBrace(c, i);
      if (end === -1) break; // unbalanced from here on: later starts are nested inside it
      const obj = tryParse(c.slice(i, end + 1));
      if (obj) return obj;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content filter (off-limits topics)
// ---------------------------------------------------------------------------

/** Off-limits: partners/fiancées, families, jobs, appearance. Matched as whole words. */
const BANNED_WORDS = [
  // partners / fiancées
  "wife", "wives", "wifey", "girlfriend", "girlfriends", "boyfriend", "husband", "spouse", "bride", "brides", "bridezilla",
  "wedding", "weddings", "marriage", "married", "marry", "marrying", "honeymoon", "ball and chain", "old lady", "missus",
  "significant other", "better half", "in-law", "in-laws",
  // families
  "mom", "moms", "mommy", "mother", "mothers", "mama", "dad", "dads", "daddy", "father", "fathers", "parents", "family",
  "families", "kids", "children", "daughter", "daughters", "grandma", "grandpa", "grandmother", "grandfather", "sister",
  "sisters", "uncle", "aunt", "cousin", "cousins", "stepdad", "stepmom",
  // jobs ("nice job" / "like a boss" are fine: those only count as possessives below)
  "day job", "salary", "paycheck", "unemployed", "coworker", "coworkers", "co-worker", "co-workers", "cubicle",
  "employer", "linkedin", "layoff", "laid off", "intern", "9-to-5", "office",
  // appearance ("hit it fat", "dead weight" and "belly up to the bar" are golf/drinking, so not these)
  "fatty", "fatso", "fat-ass", "fat ass", "fat boy", "fat guy", "fat man", "fat bastard", "fat fuck", "ugly", "bald",
  "balding", "hairline", "hair", "haircut", "beard", "beer belly", "overweight", "chubby", "skinny", "obese", "dad bod",
  "acne", "outfit", "wardrobe", "handsome", "hideous", "good-looking", "receding", "pasty", "scrawny", "short king",
];
/** Substrings (any word containing them). */
const BANNED_SUBSTRINGS = ["fianc", "girlfriend", "husband", "marri", "wedding"];
/** Possessive references: "his face", "your son", "their looks", "Nick's boss"... */
const POSSESSIVE_TARGETS = [
  "face", "looks", "son", "sons", "brother", "brothers", "kid", "body", "appearance", "clothes", "shirt", "pants",
  "shorts", "legs", "job", "jobs", "boss", "career", "work", "employer",
];
/** Harmless idioms that would otherwise trip the possessive check. */
const IDIOMS = /\bin (your|ur) face\b/gi;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD_RE = new RegExp(`(^|[^\\p{L}\\p{N}])(${BANNED_WORDS.map(escapeRe).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");
const POSSESSIVE_RE = new RegExp(`\\b(his|her|your|their|ur|'s|’s)\\s+(${POSSESSIVE_TARGETS.map(escapeRe).join("|")})\\b`, "i");

/**
 * Does `text` touch an off-limits topic? `allowed` strings (player/team names) are blanked out
 * first so a player nicknamed "Big Dad" doesn't get every roast about him dropped.
 */
export function containsBannedTopic(text: string, allowed: readonly string[] = []): boolean {
  let t = String(text ?? "");
  for (const a of allowed) {
    const name = a?.trim();
    if (name && name.length >= 2) t = t.replace(new RegExp(escapeRe(name), "gi"), " ");
  }
  t = t.replace(IDIOMS, " ");
  const lower = t.toLowerCase();
  if (BANNED_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  return WORD_RE.test(t) || POSSESSIVE_RE.test(t.replace(/\s+/g, " "));
}

// ---------------------------------------------------------------------------
// Team names
// ---------------------------------------------------------------------------

export const TEAM_NAME_COUNT = 5;
export const MAX_TEAM_NAME_CHARS = 32;

/** Used when AI is off, slow, rate limited or returns junk. 40+ names, no off-limits topics. */
export const FALLBACK_TEAM_NAMES: readonly string[] = [
  "Grip It and Sip It",
  "Shank Redemption",
  "Bogey Nights",
  "The Mulligan Mafia",
  "Fore Play",
  "Hole in Wonder",
  "Putt Pirates",
  "Tee-Totalers (Not)",
  "Sand Bagger Vance",
  "The Ghost Beer Boys",
  "Shotgun Start",
  "Par-Tee Animals",
  "The Lip Outs",
  "Drive Thru Liquor",
  "Hazard Pay",
  "Back Nine Bandits",
  "Weapons of Grass Destruction",
  "Out of Bounds & Out of Beer",
  "The Fried Eggs",
  "Shank You Very Much",
  "Chip Faced",
  "Can't Putt, Won't Putt",
  "The Duffers Club",
  "Liquid Lunch Pail",
  "Three Putt Thunder",
  "The Bunker Busters",
  "Whiskey Business",
  "Ball Washers Anonymous",
  "Fairway to Heaven",
  "Kiss My Ace",
  "The Hangover Hackers",
  "Dimple Minded",
  "Rough Riders",
  "The Sweet Spot Savants",
  "Snowmen on Every Hole",
  "Beer Cart Chasers",
  "The Lost Ball Society",
  "Stroke Ballers",
  "Last Swing of Freedom",
  "Divot Divas",
  "The Shotgun Shamblers",
  "Liquid Courage Caddies",
  "Bogey Boys Club",
  "Sir Shanks-a-Lot",
];

/** Trim, unquote, strip list markers/emoji clutter; null if unusable. */
export function cleanTeamName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/[\r\n\t]+/g, " ").trim();
  s = s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, ""); // "1. Name", "- Name"
  s = s.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  s = s.replace(/\s{2,}/g, " ");
  if (s.length < 2 || s.length > MAX_TEAM_NAME_CHARS) return null;
  if (!/[\p{L}]/u.test(s)) return null;
  if (containsBannedTopic(s)) return null;
  return s;
}

function shuffled<T>(list: readonly T[], rand: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** `count` built-in names, skipping ones already taken (case-insensitive). */
export function fallbackTeamNames(exclude: readonly string[] = [], count = TEAM_NAME_COUNT, rand: () => number = Math.random): string[] {
  const taken = new Set(exclude.map((n) => n.trim().toLowerCase()));
  const pool = FALLBACK_TEAM_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  const picked = shuffled(pool.length >= count ? pool : FALLBACK_TEAM_NAMES, rand).slice(0, count);
  return picked;
}

const TEAM_NAMES_SYSTEM = [
  "You name teams for a bachelor-party golf scramble where every drink a team logs knocks a stroke off its score.",
  "Write fully unhinged team names: golf puns, drinking, bad decisions on the course, bachelor-party chaos. Profanity is fine.",
  "Never reference partners, fiancées, brides, weddings or marriage; anyone's family; jobs; or anyone's appearance.",
  `Each name is at most ${MAX_TEAM_NAME_CHARS} characters. No numbering, no emoji.`,
  `Reply with only JSON: {"names": ["...", "...", "...", "...", "..."]} with exactly ${TEAM_NAME_COUNT} names.`,
].join("\n");

export interface TeamNamesResult {
  names: string[];
  /** true when the names came from the model. */
  ai: boolean;
}

/**
 * 5 team names from FAST_MODEL, topped up / replaced by built-in names when AI is off or returns
 * fewer than 5 usable ones. Never throws.
 */
export async function generateTeamNames(
  args: { tripId: string; seed?: string | null; existing?: readonly string[] },
  deps: AiDeps & { timeoutMs?: number; rand?: () => number } = {},
): Promise<TeamNamesResult> {
  const existing = (args.existing ?? []).filter((n) => typeof n === "string");
  const fallback = (): TeamNamesResult => ({ names: fallbackTeamNames(existing, TEAM_NAME_COUNT, deps.rand), ai: false });
  try {
    const seed = typeof args.seed === "string" ? args.seed.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const lines = [`Give me ${TEAM_NAME_COUNT} team names.`];
    if (existing.length) lines.push(`Already taken (don't repeat): ${existing.slice(0, 20).map((n) => JSON.stringify(n)).join(", ")}.`);
    if (seed) lines.push(`Vibe to riff on (ignore it if it's off-limits): ${JSON.stringify(seed)}.`);
    lines.push(`Random salt so you don't repeat yourself: ${Math.floor((deps.rand ?? Math.random)() * 1e6)}.`);
    const out = await aiJson(
      {
        kind: "team_names",
        tripId: args.tripId,
        model: fastModel(),
        system: TEAM_NAMES_SYSTEM,
        content: lines.join("\n"),
        maxTokens: 1500,
        timeoutMs: deps.timeoutMs,
      },
      deps,
    );
    const raw = out && Array.isArray(out.names) ? out.names : null;
    if (!raw) return fallback();
    const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
    const names: string[] = [];
    for (const r of raw) {
      const n = cleanTeamName(r);
      if (!n) continue;
      const k = n.toLowerCase();
      if (taken.has(k)) continue;
      taken.add(k);
      names.push(n);
      if (names.length === TEAM_NAME_COUNT) break;
    }
    if (names.length === 0) return fallback();
    if (names.length < TEAM_NAME_COUNT) {
      names.push(...fallbackTeamNames([...taken], TEAM_NAME_COUNT - names.length, deps.rand));
    }
    return { names, ai: true };
  } catch (e) {
    console.warn("[ai] team names failed", e);
    return fallback();
  }
}
