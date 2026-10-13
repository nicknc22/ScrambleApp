// AI judge for closest to pin (spec "AI judge for closest to pin (tier 3)").
//
// After a committed contest.submit of type ctp WITH a photo (post-commit hook):
//   1. read the photo bytes (Supabase public bucket or the local uploads dir)
//   2. ask JUDGE_MODEL (image input) for {estimate_ft, confidence, suspicious, roast}, using the
//      flagstick (~7 ft) and the cup (4.25 in) as scale
//   3. decide "suspicious" ourselves: claimed < settings.judge_suspicious_ratio × estimate AND
//      confidence !== "low" (the model's own opinion is ignored)
//   4. under the trip lock, if the entry is still active and unjudged: write ai_estimate_ft /
//      ai_confidence / ai_suspicious / ai_roast (status untouched: the AI never changes the
//      official distance) and insert an ai_judge feed event (dedupe "judge:<entry_id>")
//   5. broadcast; when suspicious, push the flag to everyone and run the roast pipeline on it.
// Skips silently when AI is off, there's no photo, the call fails / times out (8 s) or the entry
// was deleted or re-measured meanwhile.
import { DEFAULT_SETTINGS, type AiConfidence, type ContestEntry, type FeedEvent, type UUID } from "@/lib/types";
import type { Op } from "@/lib/ops";
import { derive } from "@/lib/engine";
import { formatFeetInches } from "@/lib/engine/format";
import { pushTriggerFor, roastTriggerFor } from "@/lib/events/derive";
import type { AiJudgePayload } from "@/lib/events/payloads";
import { deriveId } from "@/lib/ids";
import { aiAvailable, aiJson, containsBannedTopic, getAiClient, judgeModel, type AiClient } from "./ai";
import { getDb, type Db } from "./db";
import { demoAiEnabled } from "./env";
import type { PostCommitContext } from "./hooks";
import { deliverPushTrigger } from "./push";
import { broadcastTripChanged } from "./realtime";
import { insertFeedEvents, lockTrip, readTripState } from "./repo";
import { allowedNames, cleanRoast, handleRoastTrigger } from "./roasts";
import { getPhotoBytes } from "./storage";

/** Base64 inflates by 4/3 and the API caps an image at 5 MB: stay well under. */
export const MAX_JUDGE_IMAGE_BYTES = 3_500_000;
/** Judge at most this many entries per sync batch. */
export const MAX_JUDGED_PER_BATCH = 4;
/** No green is bigger than this; a larger estimate is junk. */
const MAX_ESTIMATE_FT = 300;

export const judgeDedupeKey = (entryId: UUID) => `judge:${entryId}`;

export interface JudgeDeps {
  db?: Db;
  /** undefined = getAiClient(). */
  client?: AiClient | null;
  timeoutMs?: number;
  broadcast?: (tripId: string) => Promise<boolean>;
  /** Photo reader override (tests). Default getPhotoBytes. */
  photoBytes?: (path: string) => Promise<Uint8Array | null>;
  /** Push the suspicious flag (default true). */
  push?: boolean;
  /** Roast a suspicious entry (default true). */
  roast?: boolean;
  now?: Date;
}

export type JudgeSkip = "ai_off" | "no_entry" | "no_photo" | "already_judged" | "bad_image" | "ai_failed" | "bad_response" | "entry_gone" | "error";
export type JudgeOutcome =
  | { status: "written"; event: FeedEvent; suspicious: boolean; estimate_ft: number; confidence: AiConfidence }
  | { status: "skipped"; reason: JudgeSkip };

const skip = (reason: JudgeSkip): JudgeOutcome => ({ status: "skipped", reason });

// ---------------------------------------------------------------------------
// Prompt + parsing
// ---------------------------------------------------------------------------

export const JUDGE_SYSTEM_PROMPT = [
  "You are the AI judge for the closest-to-pin contest at a bachelor-party golf scramble. A player photographed their ball on the green with the flagstick in frame and claims a distance from the ball to the hole.",
  "Estimate the real ball-to-hole distance from the photo. For scale, the flagstick is about 7 ft tall and the cup is 4.25 in across. Account for perspective and camera angle. Estimate from the photo first, then compare with the claim.",
  'Reply with ONLY JSON: {"estimate_ft": number, "confidence": "low" | "medium" | "high", "suspicious": boolean, "roast": string}',
  "- estimate_ft: your best estimate in feet (decimals allowed).",
  "- confidence: low when the ball, the flagstick or the cup isn't clearly visible, or the angle makes the scale unreliable.",
  "- suspicious: true when the claim looks clearly shorter than reality.",
  "- roast: one line (max 25 words), savage and funny, profanity fine, about the shot, the claim, the putting or the drinking. Never about partners, fiancées, weddings, families, jobs or anyone's appearance.",
].join("\n");

export interface JudgeVerdict {
  estimate_ft: number;
  confidence: AiConfidence;
  roast: string | null;
}

const CONFIDENCES: readonly AiConfidence[] = ["low", "medium", "high"];

/** Validate the model's JSON. null when there's no usable estimate. */
export function parseJudgeVerdict(obj: Record<string, unknown> | null, allowed: readonly string[] = []): JudgeVerdict | null {
  if (!obj) return null;
  const str = typeof obj.estimate_ft === "string" ? /^\s*(\d+(?:\.\d+)?)\s*(?:ft|feet|')?\s*$/i.exec(obj.estimate_ft) : null;
  const rawEstimate = str ? Number(str[1]) : obj.estimate_ft;
  if (typeof rawEstimate !== "number" || !Number.isFinite(rawEstimate) || rawEstimate < 0 || rawEstimate > MAX_ESTIMATE_FT) return null;
  const estimate_ft = Math.round(rawEstimate * 10) / 10;
  const c = typeof obj.confidence === "string" ? obj.confidence.trim().toLowerCase() : "";
  const confidence: AiConfidence = (CONFIDENCES as readonly string[]).includes(c) ? (c as AiConfidence) : "low";
  let roast = typeof obj.roast === "string" ? cleanRoast(obj.roast) : null;
  if (roast && roast.length > 200) roast = `${roast.slice(0, 199).trimEnd()}…`;
  if (roast && containsBannedTopic(roast, allowed)) roast = null;
  return { estimate_ft, confidence, roast };
}

/** Spec: claimed under ratio × estimate (default 50%) and the AI isn't low-confidence. */
export function isSuspicious(claimedFt: number, estimateFt: number, confidence: AiConfidence, ratio: number = DEFAULT_SETTINGS.judge_suspicious_ratio): boolean {
  const r = Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULT_SETTINGS.judge_suspicious_ratio;
  return confidence !== "low" && Number.isFinite(claimedFt) && Number.isFinite(estimateFt) && claimedFt < r * estimateFt;
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Sniff the image type from magic bytes (the path says .jpg, the bytes decide). */
export function imageMediaType(b: Uint8Array): ImageMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Judge one ctp entry. Never throws. */
export async function judgeEntry(tripId: UUID, entryId: UUID, deps: JudgeDeps = {}): Promise<JudgeOutcome> {
  try {
    const client = deps.client === undefined ? getAiClient() : deps.client;
    if (!client) return skip("ai_off");
    const db = deps.db ?? getDb();
    const state = await readTripState(db, tripId);
    const entry = state.contest_entries.find((e) => e.id === entryId);
    if (!entry || entry.deleted_at !== null || entry.type !== "ctp") return skip("no_entry");
    if (!entry.photo_path) return skip("no_photo");
    const dedupe = judgeDedupeKey(entry.id);
    if (entry.ai_estimate_ft !== null || state.feed_events.some((e) => e.dedupe_key === dedupe)) return skip("already_judged");

    const bytes = await (deps.photoBytes ?? getPhotoBytes)(entry.photo_path);
    if (!bytes || bytes.byteLength === 0) return skip("no_photo");
    const mediaType = imageMediaType(bytes);
    if (!mediaType || bytes.byteLength > MAX_JUDGE_IMAGE_BYTES) return skip("bad_image");

    const player = state.players.find((p) => p.id === entry.player_id);
    const who = player ? player.nickname?.trim() || player.name : "The player";
    const obj = await aiJson(
      {
        kind: "judge",
        tripId,
        model: judgeModel(),
        system: JUDGE_SYSTEM_PROMPT,
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") } },
          {
            type: "text",
            text: `Hole ${entry.hole} (par 3). ${who} claims the ball is ${formatFeetInches(entry.distance_value)} (${entry.distance_value.toFixed(2)} ft) from the hole. Judge it.`,
          },
        ],
        maxTokens: 3000,
        timeoutMs: deps.timeoutMs,
        meta: { entry_id: entry.id, hole: entry.hole },
      },
      { db, client },
    );
    if (!obj) return skip("ai_failed");
    const verdict = parseJudgeVerdict(obj, allowedNames(state));
    if (!verdict) return skip("bad_response");

    const settings = { ...DEFAULT_SETTINGS, ...(state.trip.settings ?? {}) };
    const claimed = entry.distance_value;
    const suspicious = isSuspicious(claimed, verdict.estimate_ft, verdict.confidence, settings.judge_suspicious_ratio);
    const at = (deps.now ?? new Date()).toISOString();
    const payload: AiJudgePayload = {
      entry_id: entry.id,
      hole: entry.hole,
      claimed_ft: claimed,
      estimate_ft: verdict.estimate_ft,
      confidence: verdict.confidence,
      suspicious,
      roast: verdict.roast,
    };
    const event: FeedEvent = {
      id: deriveId(tripId, dedupe),
      trip_id: tripId,
      type: "ai_judge",
      team_id: entry.team_id,
      player_id: entry.player_id,
      actor_id: null,
      payload: payload as unknown as Record<string, unknown>,
      photo_path: null,
      text: null,
      dedupe_key: dedupe,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };

    const written = await db.tx(async (t) => {
      await lockTrip(t, tripId);
      // Still active (not deleted, not replaced by a re-measure) and not judged meanwhile.
      const live = await t.query(
        "select id from contest_entries where id = $1 and trip_id = $2 and deleted_at is null and ai_estimate_ft is null",
        [entry.id, tripId],
      );
      if (live.length === 0) return false;
      const inserted = await insertFeedEvents(t, tripId, [event]);
      if (inserted.length === 0) return false;
      await t.query(
        `update contest_entries
            set ai_estimate_ft = $3, ai_confidence = $4, ai_suspicious = $5, ai_roast = $6, updated_at = $7
          where id = $1 and trip_id = $2`,
        [entry.id, tripId, verdict.estimate_ft, verdict.confidence, suspicious, verdict.roast, at],
      );
      return true;
    });
    if (!written) return skip("entry_gone");

    await (deps.broadcast ?? broadcastTripChanged)(tripId).catch(() => false);

    if (suspicious) {
      const judged: ContestEntry = { ...entry, ai_estimate_ft: verdict.estimate_ft, ai_confidence: verdict.confidence, ai_suspicious: true, ai_roast: verdict.roast, updated_at: at };
      const fresh = {
        ...state,
        contest_entries: state.contest_entries.map((e) => (e.id === entry.id ? judged : e)),
        feed_events: [...state.feed_events, event],
      };
      if (deps.push !== false) {
        try {
          const pt = pushTriggerFor(event, fresh, derive(fresh, { now: at }));
          if (pt) await deliverPushTrigger(state.trip, fresh, pt, { db, now: deps.now });
        } catch (e) {
          console.error("[judge] flag push failed", e);
        }
      }
      const rt = deps.roast !== false ? roastTriggerFor(event) : null;
      if (rt) {
        await handleRoastTrigger(tripId, rt, { db, client, timeoutMs: deps.timeoutMs, broadcast: deps.broadcast, now: deps.now });
      }
    }
    return { status: "written", event, suspicious, estimate_ft: verdict.estimate_ft, confidence: verdict.confidence };
  } catch (e) {
    console.error(`[judge] entry ${entryId} of trip ${tripId} failed`, e);
    return skip("error");
  }
}

/** Entry ids of the batch's ctp submissions that carry a photo (latest submission per entry). */
export function ctpEntriesToJudge(ops: readonly Op[]): UUID[] {
  const ids: UUID[] = [];
  for (const op of ops) {
    if (op.type !== "contest.submit" || op.contest_type !== "ctp" || !op.photo_path) continue;
    if (!ids.includes(op.entry_id)) ids.push(op.entry_id);
  }
  return ids.slice(-MAX_JUDGED_PER_BATCH);
}

/** Post-commit hook: judge the batch's ctp submissions with photos. */
export async function judgeHook(ctx: PostCommitContext, deps: JudgeDeps = {}): Promise<JudgeOutcome[]> {
  const ids = ctpEntriesToJudge(ctx.ops ?? []);
  if (ids.length === 0 || !aiAvailable(deps.client)) return [];
  if (ctx.trip.is_demo && !demoAiEnabled() && deps.client === undefined) return []; // public demo: no AI spend
  // Skip entries the batch itself already replaced or deleted (re-measure in the same batch).
  const live = ctx.state ? ids.filter((id) => ctx.state!.contest_entries.some((e) => e.id === id && e.deleted_at === null)) : ids;
  return Promise.all(live.map((id) => judgeEntry(ctx.trip.id, id, deps)));
}
