// AI roasts (spec "AI roasts (tier 3)"). Post-commit, for each RoastTrigger a sync batch fired
// (double bogey or worse, last at the turn / at the finish, suspicious closest-to-pin entries,
// drive-minimum misses, lead changes, ghost beers, the Groom's Mulligan):
//
//   settings.roasts_enabled          the commissioner can turn roasts off
//   settings.roast_cap               at most N roasts per round (all roast rows count, deleted too:
//                                    the cap is about cost); AI attempts are capped at 2N+5 as well
//   settings.roast_min_hole_gap      at most one roast per team every N holes, unless trigger.big
//   FAST_MODEL                       one or two sentences, fully unhinged, profanity fine; golf,
//                                    drinking and on-course decisions ONLY (system prompt + a
//                                    post-filter that drops anything touching partners/fiancées,
//                                    families, jobs or appearance)
//   insert                           a "roast" feed event under the trip lock (caps re-checked
//                                    there), dedupe "roast:<trigger_event_id>", then broadcast and
//                                    push it to the target team ("roasts aimed at your team").
//
// Everything fails silently: the feed already has templated copy for every event.
import { DEFAULT_SETTINGS, type FeedEvent, type TripSettings, type TripState, type UUID } from "@/lib/types";
import { derive } from "@/lib/engine";
import type { Derived } from "@/lib/engine/types";
import { formatFeetInches, formatToPar } from "@/lib/engine/format";
import { pushTriggerFor, type RoastTrigger } from "@/lib/events/derive";
import { renderFeedEvent } from "@/lib/events/templates";
import type { RoastPayload } from "@/lib/events/payloads";
import { deriveId } from "@/lib/ids";
import { aiAvailable, aiText, containsBannedTopic, countAiCalls, fastModel, getAiClient, type AiClient } from "./ai";
import { getDb, type Db } from "./db";
import { demoAiEnabled } from "./env";
import type { PostCommitContext } from "./hooks";
import { deliverPushTrigger } from "./push";
import { broadcastTripChanged } from "./realtime";
import { insertFeedEvents, lockTrip, readTripState } from "./repo";

/** At most this many roasts attempted per sync batch (an offline phone can sync a whole nine). */
export const MAX_ROASTS_PER_BATCH = 3;
export const MAX_ROAST_CHARS = 300;

export interface RoastDeps {
  db?: Db;
  /** undefined = getAiClient(). */
  client?: AiClient | null;
  timeoutMs?: number;
  broadcast?: (tripId: string) => Promise<boolean>;
  /** Push the roast to the target team (default true). */
  push?: boolean;
  now?: Date;
}

export type RoastSkip = "ai_off" | "disabled" | "no_event" | "no_team" | "duplicate" | "cap" | "gap" | "ai_failed" | "banned" | "error";
export type RoastOutcome = { status: "posted"; event: FeedEvent } | { status: "skipped"; reason: RoastSkip };

const skip = (reason: RoastSkip): RoastOutcome => ({ status: "skipped", reason });

export function settingsOf(state: Pick<TripState, "trip">): TripSettings {
  return { ...DEFAULT_SETTINGS, ...(state.trip.settings ?? {}) };
}

export const roastDedupeKey = (triggerEventId: UUID) => `roast:${triggerEventId}`;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const ROAST_SYSTEM_PROMPT = [
  "You write roasts for the live feed of a bachelor-party golf scramble. Everyone in the group reads them on their phones mid-round.",
  "How the game works: teams of 2-4 play a scramble; every drink a team logs knocks a stroke off its net score (short-handed teams get bonus 'ghost beer' credit); shotguns and shots bank mulligans; the groom (marked 👑) gets one Groom's Mulligan; every player's tee shot has to be used at least once per nine (the drive minimum).",
  "",
  "Write ONE roast of one or two sentences (max 40 words) aimed at the target team.",
  "Tone: fully unhinged, savage, profanity is fine.",
  "Roast ONLY golf (the shots, the scores, the strategy), drinking (amount, pace, shotguns, ghost beers) and on-course decisions.",
  "Never mention or allude to: partners, wives, fiancées, girlfriends, brides, weddings or marriage; anyone's family; jobs, work or money; anyone's looks, body, hair, clothes or age. No slurs, nothing about race, religion, sexuality or health.",
  "Use only the facts given. Player and team names are fine.",
  "Output only the roast text: no quotes, no preamble, no hashtags, at most one emoji.",
].join("\n");

const playerLabel = (state: TripState, id: UUID | null | undefined): string => {
  const p = id ? state.players.find((x) => x.id === id) : undefined;
  if (!p) return "someone";
  const name = p.nickname?.trim() || p.name;
  return p.is_groom ? `${name} 👑 (the groom)` : name;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Event-specific facts the template text doesn't spell out. */
function eventFacts(state: TripState, ev: FeedEvent): string[] {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  switch (ev.type) {
    case "score_notable": {
      const strokes = num(p.strokes);
      const par = num(p.par);
      if (p.kind === "last_at_turn") {
        out.push(`They are dead last at the turn (after hole 9)${typeof p.pos_label === "string" ? `, position ${p.pos_label}` : ""}${num(p.net_to_par) !== null ? `, ${formatToPar(num(p.net_to_par)!)} net` : ""}.`);
      } else if (strokes !== null && par !== null) {
        const what = p.kind === "double" ? "a double bogey" : p.kind === "triple_plus" ? "a triple bogey or worse" : String(p.kind ?? "a notable score");
        out.push(`They made a ${strokes} on the par-${par} hole ${String(p.hole ?? "?")}: ${what}.`);
        if (num(p.credit)) out.push(`Drink credit on that hole: ${p.credit} (net ${String(p.net)}).`);
      }
      break;
    }
    case "ghost_beer":
      out.push(`${playerLabel(state, p.player_id as UUID)} just drank a ghost beer: their drink counted ${String(p.value)} because the team is short-handed (${String(p.team_size)} players). Team ghost beers so far: ${String(p.ghost_count)}.`);
      break;
    case "ai_judge":
      out.push(
        `${playerLabel(state, ev.player_id)} claimed their closest-to-pin ball was ${num(p.claimed_ft) !== null ? formatFeetInches(num(p.claimed_ft)!) : "?"} from the hole on hole ${String(p.hole)}; the AI judge's photo estimate is ${num(p.estimate_ft) !== null ? formatFeetInches(num(p.estimate_ft)!) : "?"} (${String(p.confidence)} confidence). Flagged as suspicious: probably a lie.`,
      );
      break;
    case "drive_miss": {
      const missed = Array.isArray(p.missed) ? (p.missed as UUID[]).map((id) => playerLabel(state, id)) : [];
      out.push(`On the ${p.nine === 2 ? "back" : "front"} nine they never used a tee shot from: ${missed.join(", ") || "someone"} (drive minimum missed).`);
      break;
    }
    case "lead_change":
      out.push(`They just took the lead at ${num(p.net_to_par) !== null ? formatToPar(num(p.net_to_par)!) : "?"} net thru ${String(p.thru)}. Remind them how fast leads die out here.`);
      break;
    case "groom_mulligan":
      out.push(`The groom just burned his one and only Groom's Mulligan on hole ${String(p.hole)}.`);
      break;
    case "round_complete":
      out.push(`They just finished the round in LAST place (${String(p.pos_label)}), ${num(p.net_to_par) !== null ? formatToPar(num(p.net_to_par)!) : "?"} net, ${String(p.drinks)} drinks.`);
      break;
    default:
      break;
  }
  return out;
}

/** Everything the model gets to work with: event, team line, recent holes, leaderboard. */
export function buildRoastContext(state: TripState, d: Derived, ev: FeedEvent, teamId: UUID | null): string {
  const lines: string[] = [];
  let rendered = "";
  try {
    const r = renderFeedEvent(ev, state, d);
    rendered = `${r.title}: ${r.body}`;
  } catch {
    rendered = ev.type;
  }
  lines.push(`What just happened (feed post): ${rendered}`);
  lines.push(...eventFacts(state, ev));

  const team = teamId ? d.teamById[teamId] : undefined;
  if (team) {
    const members = (d.membersOfTeam[team.id] ?? []).map((p) => playerLabel(state, p.id));
    lines.push(`Target team: ${team.name} (${members.join(", ") || "no players"}).`);
    const row = d.standings.find((s) => s.team_id === team.id);
    if (row && row.thru > 0) {
      lines.push(
        `Their round: position ${row.pos_label} of ${d.standings.length}, ${formatToPar(row.net_to_par)} net to par (${formatToPar(row.gross_to_par)} gross) thru ${row.thru}, ${row.drinks} drinks logged, ${row.ghost_beers} ghost beers.`,
      );
    }
    const scored = (d.teamHoles[team.id] ?? []).filter((h) => h.strokes !== null).slice(-3);
    if (scored.length) {
      lines.push(`Their last holes: ${scored.map((h) => `hole ${h.hole} (par ${h.par}): ${h.strokes}${h.credit ? `, ${h.drinks} drinks` : ""}`).join("; ")}.`);
    }
    const bank = d.mulligans[team.id];
    if (bank && bank.used_total > 0) lines.push(`Mulligans used so far: ${bank.used_total}.`);
  }
  const board = d.standings.filter((s) => s.thru > 0).slice(0, 6);
  if (board.length) {
    lines.push(`Leaderboard: ${board.map((s) => `${s.pos_label}. ${d.teamById[s.team_id]?.name ?? "?"} ${formatToPar(s.net_to_par)} thru ${s.thru}`).join(" | ")}.`);
  }
  return lines.join("\n");
}

/** Names that may appear in a roast (blanked before the banned-topic check). */
export function allowedNames(state: TripState): string[] {
  const out: string[] = [];
  for (const p of state.players) {
    out.push(p.name);
    if (p.nickname) out.push(p.nickname);
  }
  for (const t of state.teams) out.push(t.name);
  return out.filter((n) => typeof n === "string" && n.trim().length >= 2).sort((a, b) => b.length - a.length);
}

/**
 * Tidy model output into a feed-ready roast: unquoted, no markdown, one line, at most two
 * sentences and MAX_ROAST_CHARS. null when nothing usable is left.
 */
export function cleanRoast(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/\r/g, "").trim();
  s = s.replace(/^(?:here(?:'|’)?s\s+(?:a|the|your|my)\s+roast|roast)\s*[:\-–—]\s*/i, "");
  s = s.replace(/\*\*|__|`/g, "").replace(/^#+\s*/gm, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^["“”'‘’]+/, "").replace(/["“”'‘’]+$/, "").trim();
  const sentences = s.split(/(?<=[.!?…]["”’)]*)\s+(?=\S)/);
  s = sentences.slice(0, 2).join(" ").trim();
  if (s.length > MAX_ROAST_CHARS) {
    const cut = s.slice(0, MAX_ROAST_CHARS - 1);
    const space = cut.lastIndexOf(" ");
    s = `${(space > 40 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
  }
  if (s.length < 4 || !/[\p{L}]/u.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

interface RoastRow {
  id: UUID;
  type: string;
  team_id: UUID | null;
  payload: Record<string, unknown> | null;
  dedupe_key: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** Why a roast may not be posted right now given the existing roast rows (null = go). */
function capOrGap(
  roasts: readonly Pick<RoastRow, "team_id" | "payload" | "dedupe_key" | "created_at">[],
  trigger: RoastTrigger,
  teamId: UUID | null,
  hole: number | null,
  settings: TripSettings,
): RoastSkip | null {
  if (roasts.some((r) => r.dedupe_key === roastDedupeKey(trigger.feed_event_id))) return "duplicate";
  const cap = Math.max(0, Math.floor(Number(settings.roast_cap) || 0));
  if (roasts.length >= cap) return "cap";
  if (!trigger.big && teamId && hole !== null) {
    const gap = Math.max(0, Math.floor(Number(settings.roast_min_hole_gap) || 0));
    let last: (typeof roasts)[number] | null = null;
    for (const r of roasts) {
      if (r.team_id !== teamId) continue;
      if (!last || Date.parse(r.created_at) >= Date.parse(last.created_at)) last = r;
    }
    const lastHole = last ? num(last.payload?.hole) : null;
    if (lastHole !== null && Math.abs(hole - lastHole) < gap) return "gap";
  }
  return null;
}

/**
 * Roast one trigger. Never throws. Order of checks: AI available → roasts enabled → the trigger
 * event still exists → dedupe / cap / per-team gap → AI → clean + banned-topic filter → insert
 * under the trip lock (dedupe / cap / gap re-checked) → broadcast → push to the team.
 */
export async function handleRoastTrigger(tripId: UUID, trigger: RoastTrigger, deps: RoastDeps = {}): Promise<RoastOutcome> {
  try {
    const client = deps.client === undefined ? getAiClient() : deps.client;
    if (!client) return skip("ai_off");
    const db = deps.db ?? getDb();
    const state = await readTripState(db, tripId);
    const settings = settingsOf(state);
    if (!settings.roasts_enabled) return skip("disabled");

    const ev = state.feed_events.find((e) => e.id === trigger.feed_event_id);
    if (!ev || ev.deleted_at !== null) return skip("no_event");
    const now = deps.now ?? new Date();
    const d = derive(state, { now: now.toISOString() });
    const teamId = trigger.team_id ?? ev.team_id ?? null;
    // Roasts are aimed at a team (and pushed to it); a tie for the lead has nobody to aim at.
    if (!teamId) return skip("no_team");
    const hole = trigger.hole ?? num(ev.payload?.hole) ?? d.currentHole[teamId] ?? null;

    const roasts = state.feed_events.filter((e) => e.type === "roast");
    const blocked = capOrGap(roasts, trigger, teamId, hole, settings);
    if (blocked) return skip(blocked);
    // Cost guard: failed / filtered attempts cost money too.
    if ((await countAiCalls(tripId, "roast", db)) >= Math.max(0, settings.roast_cap) * 2 + 5) return skip("cap");

    const raw = await aiText(
      {
        kind: "roast",
        tripId,
        model: fastModel(),
        system: ROAST_SYSTEM_PROMPT,
        content: buildRoastContext(state, d, ev, teamId),
        maxTokens: 1500,
        timeoutMs: deps.timeoutMs,
        meta: { trigger_type: trigger.type, trigger_event_id: trigger.feed_event_id },
      },
      { db, client },
    );
    if (raw === null) return skip("ai_failed");
    const text = cleanRoast(raw);
    if (!text) return skip("ai_failed");
    if (containsBannedTopic(text, allowedNames(state))) {
      console.warn(`[roast] dropped an off-limits roast for trip ${tripId} (${trigger.type})`);
      return skip("banned");
    }

    const at = now.toISOString();
    const dedupe = roastDedupeKey(trigger.feed_event_id);
    const payload: RoastPayload & { hole: number | null } = { trigger_event_id: trigger.feed_event_id, trigger_type: trigger.type, hole };
    const roast: FeedEvent = {
      id: deriveId(tripId, dedupe),
      trip_id: tripId,
      type: "roast",
      team_id: teamId,
      player_id: ev.player_id ?? null,
      actor_id: null,
      payload: payload as unknown as Record<string, unknown>,
      photo_path: null,
      text,
      dedupe_key: dedupe,
      created_at: at,
      updated_at: at,
      deleted_at: null,
    };

    const outcome = await db.tx(async (t): Promise<RoastSkip | null> => {
      await lockTrip(t, tripId);
      const rows = await t.query<RoastRow & { type: string }>(
        "select id, type, team_id, payload, dedupe_key, created_at, deleted_at from feed_events where trip_id = $1 and (type = 'roast' or id = $2)",
        [tripId, trigger.feed_event_id],
      );
      const target = rows.find((r) => r.id === trigger.feed_event_id);
      if (!target || target.deleted_at !== null) return "no_event";
      const fresh = rows.filter((r) => r.type === "roast");
      const settingsNow = await t.query<{ settings: Partial<TripSettings> }>("select settings from trips where id = $1", [tripId]);
      const s = { ...DEFAULT_SETTINGS, ...(settingsNow[0]?.settings ?? {}) };
      if (!s.roasts_enabled) return "disabled";
      const again = capOrGap(fresh, trigger, teamId, hole, s);
      if (again) return again;
      const inserted = await insertFeedEvents(t, tripId, [roast]);
      return inserted.length === 1 ? null : "duplicate";
    });
    if (outcome) return skip(outcome);

    await (deps.broadcast ?? broadcastTripChanged)(tripId).catch(() => false);

    if (deps.push !== false && teamId) {
      const withRoast: TripState = { ...state, feed_events: [...state.feed_events, roast] };
      const pt = pushTriggerFor(roast, withRoast, d);
      if (pt) await deliverPushTrigger(state.trip, withRoast, pt, { db, now: deps.now });
    }
    return { status: "posted", event: roast };
  } catch (e) {
    console.error(`[roast] trigger ${trigger.feed_event_id} (${trigger.type}) failed for trip ${tripId}`, e);
    return skip("error");
  }
}

/** Post-commit hook: roast the batch's RoastTriggers (big ones first, a few per batch). */
export async function roastHook(ctx: PostCommitContext, deps: RoastDeps = {}): Promise<RoastOutcome[]> {
  const triggers = ctx.events?.roast_triggers ?? [];
  if (triggers.length === 0) return [];
  if (!aiAvailable(deps.client)) return [];
  if (ctx.trip.is_demo && !demoAiEnabled() && deps.client === undefined) return []; // public demo: no AI spend
  if (ctx.trip.settings && ctx.trip.settings.roasts_enabled === false) return [];
  const ordered = triggers
    .map((t, i) => ({ t, i }))
    .sort((a, b) => Number(b.t.big) - Number(a.t.big) || a.i - b.i)
    .slice(0, MAX_ROASTS_PER_BATCH)
    .map((x) => x.t);
  const out: RoastOutcome[] = [];
  // Sequential: each roast changes the cap / gap the next one sees.
  for (const t of ordered) out.push(await handleRoastTrigger(ctx.trip.id, t, deps));
  return out;
}
