// Commissioner Setup: pure helpers (no React, no I/O). Unit-tested in tests/ui/setup-model.test.ts.
// Everything here works on raw TripState rows so Setup keeps working even if derive() hiccups.
import type { Hole, Player, PotKey, Team, TeeSet, Trip, TripSettings, TripState } from "@/lib/types";
import type { TripUpdateOp } from "@/lib/ops";
import { normalizeVenmoHandle } from "@/lib/venmo";

export const MIN_TEAM_SIZE = 2;
export const MAX_TEAM_SIZE = 4;
export const MAX_NAME_CHARS = 80;
/** $10,000 per ante is plenty for a bachelor party; anything bigger is a typo. */
export const MAX_ANTE_CENTS = 1_000_000;

export type SetupSection = "roster" | "teams" | "course" | "pots" | "settings" | "round";
export const SETUP_SECTIONS: readonly SetupSection[] = ["roster", "teams", "course", "pots", "settings", "round"];
export const SECTION_LABEL: Record<SetupSection, string> = {
  roster: "Roster",
  teams: "Teams",
  course: "Course",
  pots: "Pots",
  settings: "Settings",
  round: "Round",
};

export function isSetupSection(v: unknown): v is SetupSection {
  return typeof v === "string" && (SETUP_SECTIONS as readonly string[]).includes(v);
}

type Rows = Pick<TripState, "players" | "teams" | "team_members">;

const byOrderThenName = <T extends { sort_order: number; name: string }>(a: T, b: T) =>
  a.sort_order - b.sort_order || a.name.localeCompare(b.name);

export function livePlayers(s: Rows): Player[] {
  return s.players.filter((p) => !p.deleted_at).sort(byOrderThenName);
}

export function liveTeams(s: Rows): Team[] {
  return s.teams.filter((t) => !t.deleted_at).sort(byOrderThenName);
}

/** player_id -> team_id (active teams and players only). */
export function teamIdByPlayer(s: Rows): Map<string, string> {
  const teams = new Set(liveTeams(s).map((t) => t.id));
  const players = new Set(livePlayers(s).map((p) => p.id));
  const out = new Map<string, string>();
  for (const m of s.team_members) if (teams.has(m.team_id) && players.has(m.player_id)) out.set(m.player_id, m.team_id);
  return out;
}

/** team_id -> active members (sorted). */
export function membersByTeam(s: Rows): Map<string, Player[]> {
  const out = new Map<string, Player[]>(liveTeams(s).map((t) => [t.id, []]));
  const tOf = teamIdByPlayer(s);
  for (const p of livePlayers(s)) {
    const t = tOf.get(p.id);
    if (t) out.get(t)?.push(p);
  }
  return out;
}

export function unassignedPlayers(s: Rows): Player[] {
  const tOf = teamIdByPlayer(s);
  return livePlayers(s).filter((p) => !tOf.has(p.id));
}

export function groomOf(s: Pick<TripState, "players">): Player | null {
  return s.players.find((p) => !p.deleted_at && p.is_groom) ?? null;
}

// ---------------------------------------------------------------------------
// Team sizes
// ---------------------------------------------------------------------------

export type SizeStatus = "empty" | "short" | "ok" | "full" | "over";

/** empty (0), short (1), ok (2-3), full (4), over (5+, impossible via the reducer). */
export function teamSizeStatus(n: number): SizeStatus {
  if (n <= 0) return "empty";
  if (n < MIN_TEAM_SIZE) return "short";
  if (n < MAX_TEAM_SIZE) return "ok";
  if (n === MAX_TEAM_SIZE) return "full";
  return "over";
}

export function sizeIsPlayable(n: number): boolean {
  return n >= MIN_TEAM_SIZE && n <= MAX_TEAM_SIZE;
}

/** "Foursome", "Threesome (ghost beers)", "Needs 1 more", "Empty". */
export function sizeNote(n: number): string {
  if (n <= 0) return "Empty. Drop players here.";
  if (n === 1) return "Needs at least 1 more";
  if (n === 2) return "Twosome: every drink counts double";
  if (n === 3) return "Threesome: ghost beers + extra ball";
  if (n === 4) return "Foursome: full";
  return `${n} players: too many (max ${MAX_TEAM_SIZE})`;
}

/** "Team N" with N = active teams + 1, bumped past any name already in use. */
export function nextTeamName(teams: readonly Pick<Team, "name" | "deleted_at">[], extra = 0): string {
  const active = teams.filter((t) => !t.deleted_at);
  const used = new Set(active.map((t) => t.name.trim().toLowerCase()));
  let skip = extra;
  for (let n = active.length + 1; n < 1000; n++) {
    const name = `Team ${n}`;
    if (used.has(name.toLowerCase())) continue;
    if (skip-- > 0) continue;
    return name;
  }
  return `Team ${active.length + 1}`;
}

// ---------------------------------------------------------------------------
// Shuffle helper ("Shuffle into teams of 4/3/3")
// ---------------------------------------------------------------------------

/** How many teams a shuffle uses: keep the existing count if it can work, else the fewest that fit. */
export function shuffleTeamCount(players: number, existingTeams: number): number {
  if (players < MIN_TEAM_SIZE) return 0;
  const fewest = Math.ceil(players / MAX_TEAM_SIZE);
  const most = Math.floor(players / MIN_TEAM_SIZE);
  if (existingTeams >= fewest && existingTeams <= most) return existingTeams;
  return fewest;
}

/** Sizes as even as possible, biggest first: (10, 3) -> [4, 3, 3]. Empty when impossible. */
export function shuffleSizes(players: number, teams: number): number[] {
  if (teams <= 0 || players < teams * MIN_TEAM_SIZE || players > teams * MAX_TEAM_SIZE) return [];
  const base = Math.floor(players / teams);
  const extra = players % teams;
  return Array.from({ length: teams }, (_, i) => base + (i < extra ? 1 : 0));
}

export function sizesLabel(sizes: readonly number[]): string {
  return sizes.join("/");
}

/** Fisher-Yates with an injectable random source (tests pass a seeded one). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface ShufflePlan {
  sizes: number[];
  /** Index into the team list (existing teams first, then teams to create) per player id. */
  assignments: Array<{ player_id: string; team_index: number }>;
  /** How many new teams must be created before assigning. */
  create: number;
}

/** Random teams for every active player. null when there aren't enough players. */
export function planShuffle(playerIds: readonly string[], existingTeams: number, random: () => number = Math.random): ShufflePlan | null {
  const count = shuffleTeamCount(playerIds.length, existingTeams);
  const sizes = shuffleSizes(playerIds.length, count);
  if (sizes.length === 0) return null;
  const order = shuffled(playerIds, random);
  const assignments: ShufflePlan["assignments"] = [];
  let k = 0;
  sizes.forEach((size, team_index) => {
    for (let i = 0; i < size; i++) assignments.push({ player_id: order[k++], team_index });
  });
  return { sizes, assignments, create: Math.max(0, count - existingTeams) };
}

// ---------------------------------------------------------------------------
// Tee times
// ---------------------------------------------------------------------------

const TEE_TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isValidTeeTime(s: string): boolean {
  return TEE_TIME_RE.test(s.trim());
}

/** "9:05" -> "09:05"; invalid -> null. */
export function normalizeTeeTime(s: string): string | null {
  const m = TEE_TIME_RE.exec(s.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** "12:50" + 10 -> "13:00" (wraps at midnight). */
export function addMinutes(hhmm: string, minutes: number): string | null {
  const n = normalizeTeeTime(hhmm);
  if (!n) return null;
  const [h, m] = n.split(":").map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const FIRST_TEE_TIME = "12:50";
export const TEE_GAP_MIN = 10;

/** Tee time suggestions for a team: the next free 10-minute slot after the latest one set, plus the default first slot. */
export function teeTimeSuggestions(teams: readonly Pick<Team, "id" | "tee_time">[], forTeamId: string): string[] {
  const taken = teams
    .filter((t) => t.id !== forTeamId)
    .map((t) => (t.tee_time ? normalizeTeeTime(t.tee_time) : null))
    .filter((t): t is string => t !== null)
    .sort();
  const out: string[] = [];
  let slot = FIRST_TEE_TIME;
  while (out.length < 4) {
    if (!taken.includes(slot)) out.push(slot);
    const next = addMinutes(slot, TEE_GAP_MIN);
    if (!next || next === FIRST_TEE_TIME) break;
    slot = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** "$20" / "20" / "12.5" / "12.50" -> cents. "" -> 0. Invalid or negative -> null. */
export function parseDollars(input: string): number | null {
  const s = input.replace(/[\s,$]/g, "");
  if (s === "") return 0;
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === ".") return null;
  const cents = Math.round(Number(s) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > MAX_ANTE_CENTS) return null;
  return cents;
}

/** 2000 -> "20", 1250 -> "12.50", 0 -> "0". */
export function centsToInput(cents: number): string {
  const c = Math.max(0, Math.round(cents));
  return c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2);
}

/** Contest holes in order (every hole whose contest isn't "none"). */
export function contestHoles(holes: readonly Hole[]): Hole[] {
  return holes.filter((h) => h.contest !== "none").sort((a, b) => a.number - b.number);
}

export function potKeys(holes: readonly Hole[]): PotKey[] {
  return ["team_match", ...contestHoles(holes).map((h) => `contest:${h.number}` as PotKey)];
}

/** What one player risks if they're in every pot: team match ante + contest ante per contest hole. */
export function maxExposureCents(settings: Pick<TripSettings, "team_match_ante_cents" | "contest_ante_cents">, contestHoleCount: number): number {
  return settings.team_match_ante_cents + settings.contest_ante_cents * contestHoleCount;
}

export type PayoutMode = "winner" | "split";

export function payoutMode(payout: readonly number[]): PayoutMode {
  return payout.length >= 2 ? "split" : "winner";
}

/** First-place share for a split (default 70). */
export function firstShare(payout: readonly number[]): number {
  return payout.length >= 2 && Number.isFinite(payout[0]) ? payout[0] : 70;
}

/** [first, 100 - first], first clamped to 50..100 and rounded to a whole percent. */
export function splitPayout(first: number): number[] {
  const f = Math.min(100, Math.max(50, Math.round(first)));
  return f >= 100 ? [100] : [f, 100 - f];
}

export function payoutLabel(payout: readonly number[]): string {
  if (payout.length < 2) return "Winner take all";
  return payout.map((p) => `${p}%`).join(" / ");
}

export function payoutValid(payout: readonly number[]): boolean {
  return (
    payout.length > 0 &&
    payout.every((x) => Number.isFinite(x) && x >= 0) &&
    Math.abs(payout.reduce((a, b) => a + b, 0) - 100) < 1e-9
  );
}

/** Active opt-out rows: `${pot_key}|${player_id}` (present = OUT). */
export function optOutSet(s: Pick<TripState, "pot_optouts">): Set<string> {
  const out = new Set<string>();
  for (const o of s.pot_optouts) if (!o.deleted_at) out.add(`${o.pot_key}|${o.player_id}`);
  return out;
}

export function optKey(pot: PotKey, playerId: string): string {
  return `${pot}|${playerId}`;
}

export function potShortLabel(pot: PotKey, holes: readonly Hole[]): string {
  if (pot === "team_match") return "Team";
  const n = Number(pot.slice("contest:".length));
  const h = holes.find((x) => x.number === n);
  return `#${n} ${h?.contest === "ctp" ? "CTP" : h?.contest === "ld" ? "LD" : ""}`.trim();
}

export function potLongLabel(pot: PotKey, holes: readonly Hole[]): string {
  if (pot === "team_match") return "Team match";
  const n = Number(pot.slice("contest:".length));
  const h = holes.find((x) => x.number === n);
  return `Hole ${n} · ${h?.contest === "ctp" ? "Closest to pin" : h?.contest === "ld" ? "Long drive" : "Contest"}`;
}

// ---------------------------------------------------------------------------
// Pre-flight checklist
// ---------------------------------------------------------------------------

export type CheckLevel = "ok" | "warn" | "block";

export interface CheckItem {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
  /** Where to go to fix it. */
  section: SetupSection;
}

export interface Preflight {
  items: CheckItem[];
  blocking: number;
  warnings: number;
  canStart: boolean;
}

function nameList(names: string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

/** Everything the commissioner should check before "Start round". Blocking items mirror trip.start's reducer checks. */
export function preflight(s: TripState): Preflight {
  const items: CheckItem[] = [];
  const players = livePlayers(s);
  const teams = liveTeams(s);
  const members = membersByTeam(s);
  const free = unassignedPlayers(s);

  items.push(
    players.length >= MIN_TEAM_SIZE
      ? { id: "players", level: "ok", title: `${players.length} players on the roster`, detail: "", section: "roster" }
      : {
          id: "players",
          level: "block",
          title: players.length === 0 ? "Nobody on the roster" : "Only 1 player",
          detail: "Add the degenerates first.",
          section: "roster",
        },
  );

  items.push(
    teams.length > 0
      ? { id: "teams", level: "ok", title: `${teams.length} team${teams.length === 1 ? "" : "s"}`, detail: "", section: "teams" }
      : { id: "teams", level: "block", title: "No teams yet", detail: "Golf is a team sport today.", section: "teams" },
  );

  items.push(
    free.length === 0
      ? { id: "assigned", level: "ok", title: "Everyone is on a team", detail: "", section: "teams" }
      : {
          id: "assigned",
          level: "block",
          title: `${free.length} not on a team`,
          detail: nameList(free.map((p) => p.name)),
          section: "teams",
        },
  );

  const bad = teams.filter((t) => !sizeIsPlayable(members.get(t.id)?.length ?? 0));
  if (teams.length > 0) {
    items.push(
      bad.length === 0
        ? {
            id: "sizes",
            level: "ok",
            title: "Team sizes 2 to 4",
            detail: `Teams of ${teams.map((t) => members.get(t.id)?.length ?? 0).join("/")}`,
            section: "teams",
          }
        : {
            id: "sizes",
            level: "block",
            title: "Team sizes must be 2 to 4",
            detail: nameList(bad.map((t) => `${t.name} has ${members.get(t.id)?.length ?? 0}`)),
            section: "teams",
          },
    );
  }

  const groom = groomOf(s);
  items.push(
    groom
      ? { id: "groom", level: "ok", title: `Groom: ${groom.nickname?.trim() || groom.name} 👑`, detail: "", section: "roster" }
      : { id: "groom", level: "warn", title: "No groom set", detail: "No groom, no Groom's Mulligan. Crown somebody.", section: "roster" },
  );

  const st = s.trip.settings;
  const antesMissing = [st.team_match_ante_cents <= 0 ? "team match" : null, st.contest_ante_cents <= 0 ? "contests" : null].filter(
    (x): x is string => x !== null,
  );
  items.push(
    antesMissing.length === 0
      ? { id: "antes", level: "ok", title: "Antes set", detail: payoutLabel(st.team_match_payout), section: "pots" }
      : {
          id: "antes",
          level: "warn",
          title: `No ante for ${antesMissing.join(" or ")}`,
          detail: "Playing for pride only? Bold.",
          section: "pots",
        },
  );

  const ldMissing = s.holes
    .filter((h) => h.contest === "ld" && (h.tee_lat === null || h.tee_lng === null))
    .map((h) => h.number)
    .sort((a, b) => a - b);
  const ldCount = s.holes.filter((h) => h.contest === "ld").length;
  items.push(
    ldMissing.length === 0
      ? { id: "tees", level: "ok", title: ldCount > 0 ? "Tee points on every long drive hole" : "No long drive holes", detail: "", section: "course" }
      : {
          id: "tees",
          level: "warn",
          title: "Long drive tee points missing",
          detail: `Hole${ldMissing.length === 1 ? "" : "s"} ${ldMissing.join(", ")}: drives can't be measured from the tee.`,
          section: "course",
        },
  );

  const noTee = teams.filter((t) => !t.tee_time);
  if (teams.length > 0 && noTee.length > 0) {
    items.push({
      id: "tee_times",
      level: "warn",
      title: "Tee times not set",
      detail: nameList(noTee.map((t) => t.name)),
      section: "teams",
    });
  }

  const blocking = items.filter((i) => i.level === "block").length;
  const warnings = items.filter((i) => i.level === "warn").length;
  return { items, blocking, warnings, canStart: blocking === 0 };
}

/** Issue count for the Teams segment badge. */
export function teamIssues(s: Rows): number {
  const members = membersByTeam(s);
  return unassignedPlayers(s).length + liveTeams(s).filter((t) => !sizeIsPlayable(members.get(t.id)?.length ?? 0)).length;
}

// ---------------------------------------------------------------------------
// Finalize summary
// ---------------------------------------------------------------------------

export interface UnfinishedTeam {
  team: Team;
  label: string;
}

/** Teams that haven't tapped "Round complete", with where they are. */
export function unfinishedTeams(s: TripState): UnfinishedTeam[] {
  const out: UnfinishedTeam[] = [];
  for (const team of liveTeams(s)) {
    const rs = s.team_round_state.find((r) => r.team_id === team.id);
    if (rs?.status === "complete") continue;
    const scored = s.hole_scores.filter((h) => h.team_id === team.id && h.strokes !== null).length;
    if (!rs || rs.status === "not_started" || rs.open_hole === null) {
      out.push({ team, label: scored > 0 ? `${scored} holes scored, never teed off` : "hasn't teed off" });
    } else {
      out.push({ team, label: `on hole ${rs.open_hole}, ${scored} scored` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export interface PlayerDraft {
  name: string;
  nickname: string;
  venmo: string;
  is_groom: boolean;
}

export function draftOfPlayer(p: Pick<Player, "name" | "nickname" | "venmo_handle" | "is_groom"> | null): PlayerDraft {
  return { name: p?.name ?? "", nickname: p?.nickname ?? "", venmo: p?.venmo_handle ?? "", is_groom: p?.is_groom ?? false };
}

export interface PlayerDraftResult {
  errors: Partial<Record<"name" | "nickname" | "venmo", string>>;
  value: { name: string; nickname: string | null; venmo_handle: string | null; is_groom: boolean } | null;
}

export function validatePlayerDraft(d: PlayerDraft): PlayerDraftResult {
  const errors: PlayerDraftResult["errors"] = {};
  const name = d.name.trim();
  if (!name) errors.name = "Every player needs a name.";
  else if (name.length > MAX_NAME_CHARS) errors.name = `Keep it under ${MAX_NAME_CHARS} characters.`;
  const nickname = d.nickname.trim();
  if (nickname.length > MAX_NAME_CHARS) errors.nickname = `Keep it under ${MAX_NAME_CHARS} characters.`;
  const rawVenmo = d.venmo.trim();
  const venmo = rawVenmo ? normalizeVenmoHandle(rawVenmo) : null;
  if (rawVenmo && !venmo) errors.venmo = "Just the username: letters, numbers, - and _. No spaces.";
  if (Object.keys(errors).length > 0) return { errors, value: null };
  return { errors, value: { name, nickname: nickname || null, venmo_handle: venmo, is_groom: d.is_groom } };
}

/** Case-insensitive duplicate name check (excluding one player id). */
export function duplicateName(players: readonly Player[], name: string, exceptId: string | null): Player | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  return players.find((p) => !p.deleted_at && p.id !== exceptId && p.name.trim().toLowerCase() === n) ?? null;
}

// ---------------------------------------------------------------------------
// Settings draft
// ---------------------------------------------------------------------------

export interface SettingsDraft {
  app_name: string;
  name: string;
  course_name: string;
  tee_set: TeeSet;
  base_team_size: number;
  roasts_enabled: boolean;
  roast_min_hole_gap: number;
  roast_cap: number;
  ld_accuracy_limit_m: number;
  ld_min_yd: string;
  ld_max_yd: string;
  /** Percent, e.g. 50 for 0.5. */
  judge_pct: number;
  /** Minutes (0.5 steps). */
  push_throttle_min: number;
  /** "" = no cap. */
  drink_cap: string;
}

export function settingsDraft(trip: Pick<Trip, "app_name" | "name" | "base_team_size" | "settings">): SettingsDraft {
  const s = trip.settings;
  return {
    app_name: trip.app_name,
    name: trip.name,
    course_name: s.course_name,
    tee_set: s.tee_set,
    base_team_size: trip.base_team_size,
    roasts_enabled: s.roasts_enabled,
    roast_min_hole_gap: s.roast_min_hole_gap,
    roast_cap: s.roast_cap,
    ld_accuracy_limit_m: s.ld_accuracy_limit_m,
    ld_min_yd: String(s.ld_min_yd),
    ld_max_yd: String(s.ld_max_yd),
    judge_pct: Math.round(s.judge_suspicious_ratio * 100),
    push_throttle_min: Math.round((s.push_throttle_sec / 60) * 2) / 2,
    drink_cap: s.drink_cap === null ? "" : String(s.drink_cap),
  };
}

export type SettingsErrors = Partial<Record<keyof SettingsDraft, string>>;

const LD_LIMIT_YD = 700;

function wholeNumber(s: string): number | null {
  const t = s.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  return Number(t);
}

/**
 * Validate the draft and build the trip.update patch with only the fields that differ from
 * `trip`. patch is null when there are errors; {} when nothing changed.
 */
export function settingsPatch(
  trip: Pick<Trip, "app_name" | "name" | "base_team_size" | "settings">,
  d: SettingsDraft,
): { errors: SettingsErrors; patch: TripUpdateOp["patch"] | null } {
  // Only edited fields are validated and sent: a stored value the UI wouldn't produce (set by a
  // script, or not exactly representable like a 100 s throttle shown as 1.5 min) never blocks or
  // gets rewritten by an unrelated save.
  const base = settingsDraft(trip);
  const changed = (k: keyof SettingsDraft) => d[k] !== base[k];
  const errors: SettingsErrors = {};
  const appName = d.app_name.trim();
  if (changed("app_name")) {
    if (!appName) errors.app_name = "The app needs a name. Even a bad one.";
    else if (appName.length > MAX_NAME_CHARS) errors.app_name = `Under ${MAX_NAME_CHARS} characters.`;
  }
  const tripName = d.name.trim();
  if (changed("name")) {
    if (!tripName) errors.name = "Name the trip.";
    else if (tripName.length > MAX_NAME_CHARS) errors.name = `Under ${MAX_NAME_CHARS} characters.`;
  }
  const course = d.course_name.trim();
  if (changed("course_name")) {
    if (!course) errors.course_name = "Which course? It needs a name.";
    else if (course.length > 120) errors.course_name = "Under 120 characters.";
  }
  if (changed("base_team_size") && (!Number.isInteger(d.base_team_size) || d.base_team_size < 2 || d.base_team_size > 4)) errors.base_team_size = "2 to 4.";
  if (changed("roast_min_hole_gap") && (!Number.isInteger(d.roast_min_hole_gap) || d.roast_min_hole_gap < 0 || d.roast_min_hole_gap > 18)) {
    errors.roast_min_hole_gap = "0 to 18 holes.";
  }
  if (changed("roast_cap") && (!Number.isInteger(d.roast_cap) || d.roast_cap < 0 || d.roast_cap > 500)) errors.roast_cap = "0 to 500.";
  if (changed("ld_accuracy_limit_m") && (!Number.isFinite(d.ld_accuracy_limit_m) || d.ld_accuracy_limit_m <= 0 || d.ld_accuracy_limit_m > 100)) {
    errors.ld_accuracy_limit_m = "1 to 100 m.";
  }
  const ldTouched = changed("ld_min_yd") || changed("ld_max_yd");
  const ldMin = ldTouched ? wholeNumber(d.ld_min_yd) : trip.settings.ld_min_yd;
  const ldMax = ldTouched ? wholeNumber(d.ld_max_yd) : trip.settings.ld_max_yd;
  if (ldTouched) {
    if (ldMin === null || ldMin > LD_LIMIT_YD) errors.ld_min_yd = `0 to ${LD_LIMIT_YD} yd.`;
    if (ldMax === null || ldMax > LD_LIMIT_YD) errors.ld_max_yd = `0 to ${LD_LIMIT_YD} yd.`;
    if (ldMin !== null && ldMax !== null && !errors.ld_min_yd && !errors.ld_max_yd && ldMin > ldMax) {
      errors.ld_max_yd = "The max is below the min. Bold strategy.";
    }
  }
  if (changed("judge_pct") && (!Number.isInteger(d.judge_pct) || d.judge_pct < 0 || d.judge_pct > 100)) errors.judge_pct = "0 to 100%.";
  if (changed("push_throttle_min") && (!Number.isFinite(d.push_throttle_min) || d.push_throttle_min < 0 || d.push_throttle_min > 60)) {
    errors.push_throttle_min = "0 to 60 minutes.";
  }
  let drinkCap: number | null = trip.settings.drink_cap;
  if (changed("drink_cap")) {
    drinkCap = null;
    if (d.drink_cap.trim() !== "") {
      const n = wholeNumber(d.drink_cap);
      if (n === null || n < 1 || n > 999) errors.drink_cap = "A whole number of drinks (1+), or blank for no cap.";
      else drinkCap = n;
    }
  }
  if (Object.keys(errors).length > 0) return { errors, patch: null };

  const next: Partial<TripSettings> = {};
  if (changed("course_name") && course !== trip.settings.course_name) next.course_name = course;
  if (changed("tee_set")) next.tee_set = d.tee_set;
  if (changed("roasts_enabled")) next.roasts_enabled = d.roasts_enabled;
  if (changed("roast_min_hole_gap")) next.roast_min_hole_gap = d.roast_min_hole_gap;
  if (changed("roast_cap")) next.roast_cap = d.roast_cap;
  if (changed("ld_accuracy_limit_m")) next.ld_accuracy_limit_m = d.ld_accuracy_limit_m;
  if (ldMin !== null && ldMin !== trip.settings.ld_min_yd) next.ld_min_yd = ldMin;
  if (ldMax !== null && ldMax !== trip.settings.ld_max_yd) next.ld_max_yd = ldMax;
  if (changed("judge_pct")) next.judge_suspicious_ratio = d.judge_pct / 100;
  if (changed("push_throttle_min")) next.push_throttle_sec = Math.round(d.push_throttle_min * 60);
  if (drinkCap !== trip.settings.drink_cap) next.drink_cap = drinkCap;

  const patch: TripUpdateOp["patch"] = {};
  if (changed("app_name") && appName !== trip.app_name) patch.app_name = appName;
  if (changed("name") && tripName !== trip.name) patch.name = tripName;
  if (changed("base_team_size")) patch.base_team_size = d.base_team_size;
  if (Object.keys(next).length > 0) patch.settings = next;
  return { errors, patch };
}

export function sameDraft(a: SettingsDraft, b: SettingsDraft): boolean {
  return (Object.keys(a) as (keyof SettingsDraft)[]).every((k) => a[k] === b[k]);
}

// ---------------------------------------------------------------------------
// PIN change
// ---------------------------------------------------------------------------

export function pinChangeError(current: string, next: string, confirm: string): string | null {
  if (!/^\d{4,12}$/.test(current)) return "Enter the current PIN (4 to 12 digits).";
  if (!/^\d{4,12}$/.test(next)) return "The new PIN has to be 4 to 12 digits.";
  if (next !== confirm) return "The new PINs don't match. Sober up and retype.";
  if (next === current) return "That's the same PIN. Living dangerously, huh?";
  return null;
}
