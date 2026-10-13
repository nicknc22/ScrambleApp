"use client";
// Sync issues: changes the server refused. Kept per trip in localStorage (newest 20) so a
// rejection that arrived while the phone was in a pocket is still there to read later; the
// header shows "⚠️ N" and the SyncIssues sheet lists them until dismissed.
import type { ISODate, Player, Team, TripState, UUID } from "../types";
import type { Op, OpResult, RejectCode } from "../ops";
import { readItem, writeItem, type StorageLike } from "./identity";

export const MAX_SYNC_ISSUES = 20;

export interface SyncIssue extends OpResult {
  status: "rejected";
  /** The op's type ("drink.log", ...), or "photo" for an upload the server refused. */
  op_type: string;
  /** What it was, for people: "Shotgun for Mike · hole 3". */
  description: string;
  /** When this phone heard about it. */
  at: ISODate;
}

export const syncIssuesKey = (code: string) => `scramble:sync-issues:${code}`;

const REJECT_CODES: ReadonlySet<string> = new Set<RejectCode>(["not_live", "forbidden", "not_found", "invalid", "no_window", "conflict"]);

function isIssue(v: unknown): v is SyncIssue {
  const r = v as SyncIssue | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.id === "string" &&
    typeof r.op_type === "string" &&
    typeof r.description === "string" &&
    typeof r.at === "string" &&
    (r.code === undefined || REJECT_CODES.has(r.code)) &&
    (r.reason === undefined || typeof r.reason === "string")
  );
}

export function loadSyncIssues(code: string, storage: StorageLike | null): SyncIssue[] {
  const raw = readItem(syncIssuesKey(code), storage);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isIssue)
      .map((r) => ({ ...r, status: "rejected" as const }))
      .slice(-MAX_SYNC_ISSUES);
  } catch {
    return [];
  }
}

export function saveSyncIssues(code: string, issues: readonly SyncIssue[], storage: StorageLike | null): void {
  writeItem(syncIssuesKey(code), issues.length > 0 ? JSON.stringify(issues.slice(-MAX_SYNC_ISSUES)) : null, storage);
}

function playerName(state: TripState | null, id: UUID | null | undefined): string | null {
  if (!id) return null;
  const p: Pick<Player, "name" | "nickname"> | undefined = state?.players.find((x) => x.id === id);
  if (!p) return null;
  return p.nickname?.trim() || p.name.trim() || null;
}

function teamName(state: TripState | null, id: UUID | null | undefined): string | null {
  if (!id) return null;
  const t: Pick<Team, "name"> | undefined = state?.teams.find((x) => x.id === id);
  return t?.name.trim() || null;
}

function joined(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ");
}

const DRINK_LABEL: Record<string, string> = { drink: "Drink", shotgun: "Shotgun", shot: "Shot" };

function clip(text: string, max = 40): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** One line saying what an op did, with names from `state` where it has them. */
export function describeOp(op: Op, state: TripState | null): string {
  const team = "team_id" in op ? teamName(state, op.team_id) : null;
  switch (op.type) {
    case "tee.open":
      return joined(`On the tee: hole ${op.hole}`, team);
    case "round.complete":
      return joined("Round complete", team);
    case "score.set":
      return joined(`Hole ${op.hole} score: ${op.strokes}`, team);
    case "teeshot.set":
      return joined(`Hole ${op.hole} tee shot: ${playerName(state, op.player_id) ?? (op.player_id ? "someone" : "cleared")}`, team);
    case "drink.log": {
      const who = playerName(state, op.player_id);
      return joined(`${DRINK_LABEL[op.drink_type] ?? "Drink"}${who ? ` for ${who}` : ""}`, `hole ${op.hole}`, op.photo_path ? "with photo" : null);
    }
    case "drink.delete": {
      const d = state?.drinks.find((x) => x.id === op.drink_id);
      const who = playerName(state, d?.player_id);
      return d ? joined(`Undo ${who ? `${who}'s ` : ""}${(DRINK_LABEL[d.type] ?? "drink").toLowerCase()}`, `hole ${d.hole}`) : "Undo a drink";
    }
    case "drink.move":
      return `Move a drink to hole ${op.hole}`;
    case "mulligan.use":
      return joined(op.source === "groom" ? "Groom's Mulligan" : "Mulligan", `hole ${op.hole}`, team);
    case "mulligan.undo":
      return "Undo a mulligan";
    case "contest.submit": {
      const who = playerName(state, op.player_id);
      const what = op.contest_type === "ctp" ? `Closest to pin: ${op.distance_value} ft` : `Long drive: ${Math.round(op.distance_value)} yd`;
      return joined(what, who, `hole ${op.hole}`);
    }
    case "contest.delete":
      return "Delete a contest entry";
    case "contest.review":
      return "Review a contest entry";
    case "post.create":
      return op.text?.trim() ? `Post: “${clip(op.text)}”` : "Photo post";
    case "feed.delete":
      return "Delete a feed post";
    case "reaction.set":
      return op.on ? "Reaction" : "Remove a reaction";
    case "pot.optout":
      return joined(op.out ? "Opt out of a pot" : "Opt back into a pot", playerName(state, op.player_id));
    case "player.mute":
      return op.muted ? "Mute notifications" : "Unmute notifications";
    case "player.upsert":
      return `Player: ${op.player.name?.trim() || playerName(state, op.player.id) || "update"}`;
    case "player.delete":
      return joined("Remove player", playerName(state, op.player_id));
    case "team.upsert":
      return `Team: ${op.team.name?.trim() || teamName(state, op.team.id) || "update"}`;
    case "team.delete":
      return joined("Delete team", team);
    case "team.assign":
      return joined(`Move ${playerName(state, op.player_id) ?? "a player"}`, op.team_id ? `to ${team ?? "a team"}` : "off their team");
    case "hole.update":
      return `Edit hole ${op.hole}`;
    case "trip.update":
      return "Trip settings";
    case "trip.start":
      return "Start the round";
    case "trip.finalize":
      return "Finalize results";
    case "trip.reopen":
      return "Reopen the round";
    case "round.set_state":
      return joined("Fix round state", team);
  }
  return "A change";
}
