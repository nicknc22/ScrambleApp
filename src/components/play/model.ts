// Pure view-model helpers for the Play tab (team hole screen). No React, no store, no clock:
// every rule the screen applies lives here so it can be unit tested (tests/ui/play-model.test.ts).
import type { DrinkValue, DriveNineStatus, MulliganBank, StandingRow, TeamHoleLine } from "@/lib/engine/types";
import type { DrinkType, HoleContest, RoundStatus, TeamRoundState, TripStatus, UUID } from "@/lib/types";
import { formatToPar } from "@/lib/engine/format";
import { noWindowRoast } from "@/lib/events/templates";

export const MIN_STROKES = 1;
export const MAX_STROKES = 20;

type RoundLike = Pick<TeamRoundState, "open_hole" | "status" | "started_holes">;

// ---------------------------------------------------------------------------
// Which team this phone scores for
// ---------------------------------------------------------------------------

export interface PlayTeamInput {
  /** derived.teamOfPlayer[meId] (null when not on a team / no player picked). */
  myTeamId: UUID | null;
  isCommissioner: boolean;
  /** Team picked in the "Score for which team?" picker this session. */
  chosenTeamId: UUID | null;
  /** Active team ids in roster order. */
  teamIds: readonly UUID[];
}

export interface PlayTeamContext {
  /** Team to show; null = show the team picker. */
  teamId: UUID | null;
  /** Show a "switch team" control. */
  canSwitch: boolean;
}

/**
 * Players on a team always score for their own team. The commissioner defaults to his own team
 * but may pick any team. Anyone else (not on a team, or no player picked) picks a team.
 */
export function resolvePlayTeam({ myTeamId, isCommissioner, chosenTeamId, teamIds }: PlayTeamInput): PlayTeamContext {
  const valid = (id: UUID | null): id is UUID => id !== null && teamIds.includes(id);
  if (isCommissioner) {
    const teamId = valid(chosenTeamId) ? chosenTeamId : valid(myTeamId) ? myTeamId : null;
    return { teamId, canSwitch: teamIds.length > 1 || !valid(myTeamId) };
  }
  if (valid(myTeamId)) return { teamId: myTeamId, canSwitch: false };
  return { teamId: valid(chosenTeamId) ? chosenTeamId : null, canSwitch: teamIds.length > 0 };
}

/** Ops on another team's holes, or anything while the trip is final, go out as commissioner overrides. */
export function needsOverride(opts: { isCommissioner: boolean; myTeamId: UUID | null; teamId: UUID; tripStatus: TripStatus }): boolean {
  return opts.isCommissioner && (opts.teamId !== opts.myTeamId || opts.tripStatus === "final");
}

/** Play ops are accepted while live; the commissioner can still fix things once final. */
export function canEditPlay(tripStatus: TripStatus, isCommissioner: boolean): boolean {
  return tripStatus === "live" || (tripStatus === "final" && isCommissioner);
}

// ---------------------------------------------------------------------------
// Viewing hole and the "On the tee" / next-hole flow
// ---------------------------------------------------------------------------

export function clampHole(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(18, Math.max(1, Math.trunc(n)));
}

/** The hole on screen: the hole the user deliberately opened from the scorecard, else the team's current hole. */
export function viewingHole(currentHole: number, pinnedHole: number | null): number {
  return clampHole(pinnedHole ?? currentHole);
}

/** true when the user is looking at a hole other than the team's current hole (show the "Editing hole 6" bar). */
export function isEditingOtherHole(currentHole: number, pinnedHole: number | null): boolean {
  return pinnedHole !== null && pinnedHole !== currentHole;
}

/** The user changed the stepper on `hole` and hasn't saved that value (the strip's ✎). */
export function hasUnsavedDraft(drafts: Readonly<Record<number, number>>, lines: readonly Pick<TeamHoleLine, "strokes">[], hole: number): boolean {
  const draft = drafts[hole];
  const line = lines[hole - 1];
  return draft !== undefined && line !== undefined && line.strokes !== draft;
}

/**
 * The pinned hole after the team's current hole (or round status) changed, usually because a
 * teammate's phone teed off the next hole. Reaching the pinned hole un-pins (follow again). A phone
 * following the team with an unsaved stepper change on the hole it was showing stays on that hole,
 * so its Save never lands on a hole nobody has played yet.
 */
export function pinAfterTeamMove(opts: {
  /** Team's current hole before / after the change. */
  from: number;
  to: number;
  pin: number | null;
  /** The round summary was on screen before the change (nothing to protect). */
  wasSummary: boolean;
  finished: boolean;
  /** hasUnsavedDraft(..., from). */
  unsavedOnFrom: boolean;
}): number | null {
  const { from, to, pin, finished } = opts;
  if (pin !== null) return pin === to && !finished ? null : pin;
  if (!opts.wasSummary && opts.unsavedOnFrom && (from !== to || finished)) return from;
  return null;
}

/** Toast copy when the team's hole moved without this phone doing it (another phone teed off / finished). */
export function teamMoveNotice(opts: {
  to: number;
  finished: boolean;
  /** Hole this phone stays on with an unsaved stepper value, if any. */
  keptHole: number | null;
  keptValue: number | null;
}): { emoji: string; title: string; message: string } | null {
  const { to, finished, keptHole, keptValue } = opts;
  if (keptHole !== null && keptValue !== null) {
    return {
      emoji: "✋",
      title: finished ? "Round finished on another phone" : `Hole ${to} teed off on another phone`,
      message: `Your ${keptValue} on hole ${keptHole} isn't saved yet. Save it or drop it, then head on.`,
    };
  }
  if (finished) return null;
  return { emoji: "⛳", title: `On the tee: hole ${to}`, message: `Teed off on another phone. Drinks now count on hole ${to}.` };
}

/** After the screen changed holes under the user's thumb, Save ignores taps for this long. */
export const HOLE_MOVE_GUARD_MS = 1500;

/** Hole the big "On the tee" CTA opens while viewing `viewing`, or null when there is nothing to tee off. */
export function teeCtaHole(rs: RoundLike | null | undefined, viewing: number): number | null {
  if (rs?.status === "complete") return null;
  const next = (rs?.open_hole ?? 0) + 1;
  if (next > 18 || viewing !== next) return null;
  if (rs?.started_holes?.includes(next)) return null;
  return next;
}

export type NextAction = { kind: "tee"; hole: number } | { kind: "complete" } | { kind: "none" };

/** What the bottom bar's advance button does: tee off the next hole, finish the round, or nothing. */
export function nextAction(rs: RoundLike | null | undefined): NextAction {
  if (!rs || rs.status !== "playing" || rs.open_hole === null) return { kind: "none" };
  if (rs.open_hole >= 18) return { kind: "complete" };
  return { kind: "tee", hole: rs.open_hole + 1 };
}

// ---------------------------------------------------------------------------
// Score entry
// ---------------------------------------------------------------------------

export interface ScoreDraftView {
  /** What the stepper shows. */
  value: number;
  /** Strokes saved for the hole (null = not scored). */
  saved: number | null;
  /** The stepper value differs from what's saved (Save button visible). */
  dirty: boolean;
  /** The user changed the stepper on this hole (vs. showing the par default). */
  touched: boolean;
}

/** Stepper value = the user's draft ?? saved strokes ?? par. */
export function scoreDraft(saved: number | null, draft: number | undefined, par: number): ScoreDraftView {
  const touched = draft !== undefined;
  const value = clampStrokes(draft ?? saved ?? par);
  return { value, saved, dirty: value !== saved, touched };
}

export function clampStrokes(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.min(MAX_STROKES, Math.max(MIN_STROKES, Math.round(n)));
}

export interface NetPreview {
  strokes: number;
  credit: number;
  net: number;
  /** net - par as "E" / "+1" / "-2". */
  netToPar: string;
  /** "4 − 2 🍺 = 2 net". */
  text: string;
}

export function netPreview(strokes: number, credit: number, par: number): NetPreview {
  const net = strokes - credit;
  return { strokes, credit, net, netToPar: formatToPar(net - par), text: `${strokes} − ${credit} 🍺 = ${net} net` };
}

/** Golf name for a gross score: "Ace", "Eagle", "Birdie", "Par", "Bogey", "Double", ... */
export function scoreName(strokes: number, par: number): string {
  if (strokes === 1) return "Ace";
  const d = strokes - par;
  if (d <= -4) return "Condor";
  if (d === -3) return "Albatross";
  if (d === -2) return "Eagle";
  if (d === -1) return "Birdie";
  if (d === 0) return "Par";
  if (d === 1) return "Bogey";
  if (d === 2) return "Double bogey";
  if (d === 3) return "Triple bogey";
  if (strokes === 8) return "Snowman";
  return `+${d}. Pick it up`;
}

export type ScoreTone = "ace" | "eagle" | "birdie" | "par" | "bogey" | "double" | "none";

export function scoreTone(strokes: number | null, par: number): ScoreTone {
  if (strokes === null) return "none";
  if (strokes === 1) return "ace";
  const d = strokes - par;
  if (d <= -2) return "eagle";
  if (d === -1) return "birdie";
  if (d === 0) return "par";
  if (d === 1) return "bogey";
  return "double";
}

/** Short hype/roast line for a freshly saved score. */
export function savedScoreLine(strokes: number, par: number, hole: number): { emoji: string; title: string; message: string } {
  const name = scoreName(strokes, par);
  const d = strokes - par;
  if (strokes === 1) return { emoji: "🕳️", title: `ACE ON ${hole}`, message: "Somebody call the newspapers. Then buy the bar." };
  if (d <= -2) return { emoji: "🦅", title: `${name} on ${hole}`, message: "Who are you people? Saved." };
  if (d === -1) return { emoji: "🐦", title: `Birdie on ${hole}`, message: "Look at you. Saved." };
  if (d === 0) return { emoji: "✅", title: `Par on ${hole}`, message: "Boring. Effective. Saved." };
  if (d === 1) return { emoji: "😐", title: `Bogey on ${hole}`, message: "Drink it off. Saved." };
  return { emoji: "💀", title: `${strokes} on ${hole}`, message: `${name}. The feed has been notified. Saved.` };
}

// ---------------------------------------------------------------------------
// Drive minimum
// ---------------------------------------------------------------------------

export type DriveTone = "done" | "ok" | "soft" | "hard" | "impossible" | "missed";

export interface DriveView {
  tone: DriveTone;
  nine: 1 | 2;
  nineLabel: string;
  /** One line, e.g. "Needs a drive: Dave · 3 holes left on this nine". */
  text: string;
  /** Show as the sticky red banner. */
  banner: boolean;
}

export function holesWord(n: number): string {
  return `${n} ${n === 1 ? "hole" : "holes"}`;
}

/** "Dave", "Dave and Mike", "Dave, Mike and Al". */
export function joinNames(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Nine (1 = holes 1-9, 2 = holes 10-18) containing a hole. */
export function nineOf(hole: number): 1 | 2 {
  return hole <= 9 ? 1 : 2;
}

export function driveView(nine: DriveNineStatus, nameOf: (id: UUID) => string): DriveView {
  const nineLabel = nine.nine === 1 ? "front nine" : "back nine";
  const names = joinNames(nine.needing.map(nameOf));
  const base = { nine: nine.nine, nineLabel };
  if (nine.closed) {
    if (nine.missed.length > 0) {
      return {
        ...base,
        tone: "missed",
        banner: false,
        text: `Missed on the ${nineLabel}: ${joinNames(nine.missed.map(nameOf))} never had a drive used. The commissioner has been notified.`,
      };
    }
    return { ...base, tone: "done", banner: false, text: `Drive minimum done on the ${nineLabel}. Everybody contributed. Allegedly.` };
  }
  if (nine.needing.length === 0) {
    return { ...base, tone: "done", banner: false, text: `Everyone's drive has been used on the ${nineLabel}.` };
  }
  const left = `${holesWord(nine.remaining)} left on this nine`;
  switch (nine.level) {
    case "impossible":
      return {
        ...base,
        tone: "impossible",
        banner: true,
        text: `Too late: ${left} and ${nine.needing.length} still need a drive (${names}). Somebody's getting roasted.`,
      };
    case "hard":
      return {
        ...base,
        tone: "hard",
        banner: true,
        text:
          nine.needing.length === 1
            ? `Use ${names}'s drive NOW: ${left}.`
            : `Use drives from ${names} NOW: ${left}.`,
      };
    case "soft":
      return { ...base, tone: "soft", banner: false, text: `Needs a drive: ${names} · ${left}` };
    default:
      return { ...base, tone: "ok", banner: false, text: `Still need a drive: ${names} · ${left}` };
  }
}

// ---------------------------------------------------------------------------
// Drinks
// ---------------------------------------------------------------------------

export interface PlayerDrinkCount {
  /** Active drinks on the hole. */
  count: number;
  /** Credit those drinks are worth (ghost beers count 2). */
  credit: number;
  ghosts: number;
}

/** player_id -> drinks on one hole for one team. */
export function drinksOnHole(values: Record<UUID, DrinkValue>, teamId: UUID, hole: number): Record<UUID, PlayerDrinkCount> {
  const out: Record<UUID, PlayerDrinkCount> = {};
  for (const v of Object.values(values)) {
    if (v.team_id !== teamId || v.hole !== hole) continue;
    const c = out[v.player_id] ?? (out[v.player_id] = { count: 0, credit: 0, ghosts: 0 });
    c.count += 1;
    c.credit += v.value;
    if (v.ghost) c.ghosts += 1;
  }
  return out;
}

/** player_id -> active drinks for the round (one team). */
export function drinksForRound(values: Record<UUID, DrinkValue>, teamId: UUID): Record<UUID, number> {
  const out: Record<UUID, number> = {};
  for (const v of Object.values(values)) {
    if (v.team_id !== teamId) continue;
    out[v.player_id] = (out[v.player_id] ?? 0) + 1;
  }
  return out;
}

export const DRINK_LABEL: Record<DrinkType, string> = { drink: "Drink", shotgun: "Shotgun", shot: "Shot" };
export const DRINK_EMOJI: Record<DrinkType, string> = { drink: "🍺", shotgun: "🔫", shot: "🥃" };

export interface DrinkFeedback {
  ghost: boolean;
  /** Shotgun / shot: the team banked a mulligan. */
  mulligan: boolean;
  emoji: string;
  title: string;
  message: string;
}

/** Toast copy after logging a drink, from its freshly derived value. */
export function drinkFeedback(type: DrinkType, value: number | undefined, playerName: string, hole: number): DrinkFeedback {
  const ghost = (value ?? 1) > 1;
  const mulligan = type === "shotgun" || type === "shot";
  const worth = value ?? 1;
  const strokes = `${worth} ${worth === 1 ? "stroke" : "strokes"}`;
  const title = mulligan ? `${DRINK_LABEL[type]}! Mulligan banked` : ghost ? "Ghost beer!" : `${DRINK_LABEL[type]} logged`;
  const message = `${playerName} · hole ${hole} · −${strokes}${ghost ? " 👻" : ""}`;
  return { ghost, mulligan, emoji: ghost ? "👻" : DRINK_EMOJI[type], title, message };
}

/** One drink in a team's logging burst (the drinks the merged undo toast covers, newest last). */
export interface BurstDrink {
  opId: UUID;
  drinkId: UUID;
  name: string;
  type: DrinkType;
  /** Derived value right after logging (2 = ghost beer). */
  value: number | undefined;
  hole: number;
}

export interface ToastCopy {
  emoji: string;
  title: string;
  message: string;
}

/**
 * Copy for the single, compact undo toast a burst of drink logs shares: the count plus the latest
 * drink ("3 drinks logged" / "Last: Rob 👻 −2"). Its Undo removes the latest drink.
 */
export function drinkBurstCopy(burst: readonly BurstDrink[]): ToastCopy {
  const last = burst[burst.length - 1];
  if (!last) return { emoji: "🍺", title: "Drinks logged", message: "" };
  const fb = drinkFeedback(last.type, last.value, last.name, last.hole);
  if (burst.length === 1) return { emoji: fb.emoji, title: fb.title, message: fb.message };
  return { emoji: fb.emoji, title: `${burst.length} drinks logged`, message: `Last: ${last.name} ${fb.ghost ? "👻" : DRINK_EMOJI[last.type]} −${last.value ?? 1}` };
}

/** Copy after Undo removed the latest drink of a burst; `remaining` are the burst's other drinks. */
export function drinkUndoneCopy(remaining: readonly BurstDrink[]): ToastCopy {
  const last = remaining[remaining.length - 1];
  if (!last) return { emoji: "↩️", title: "Drink undone", message: "Pretend it never happened." };
  return { emoji: "↩️", title: "Drink undone", message: `${remaining.length} still logged · last: ${last.name}` };
}

export function ghostFanfareCopy(playerName: string, value: number): { title: string; subtitle: string } {
  return {
    title: "Ghost beer",
    subtitle: `${playerName}'s drink just counted ${value}. The ghost of your missing fourth thanks you for your service.`,
  };
}

/** Roast for a drink logged with no open window (before hole 1, or after "Round complete"). */
export function noWindowMessage(status: RoundStatus | null | undefined, seed: string): string {
  if (status === "complete") return "Round's over. That one's just for fun now. The 19th hole doesn't keep score.";
  return noWindowRoast(seed);
}

// ---------------------------------------------------------------------------
// Mulligans
// ---------------------------------------------------------------------------

export interface MulliganOptions {
  earned: number;
  groom: boolean;
  any: boolean;
  usedTotal: number;
}

export function mulliganOptions(bank: MulliganBank | null | undefined): MulliganOptions {
  const earned = bank?.available ?? 0;
  const groom = !!bank?.groom_available;
  return { earned, groom, any: earned > 0 || groom, usedTotal: bank?.used_total ?? 0 };
}

// ---------------------------------------------------------------------------
// Scorecard strip
// ---------------------------------------------------------------------------

export interface StripCell {
  hole: number;
  par: number;
  contest: HoleContest;
  strokes: number | null;
  net: number | null;
  drinks: number;
  credit: number;
  tone: ScoreTone;
  current: boolean;
  viewing: boolean;
  /** The user changed the stepper on this hole and didn't save. */
  unsaved: boolean;
  /** Short label for screen readers: "Hole 5, par 4, 4 strokes, net 2, 2 drinks". */
  label: string;
}

export function stripCells(lines: readonly TeamHoleLine[], currentHole: number, viewing: number, unsavedHoles: readonly number[] = []): StripCell[] {
  const unsaved = new Set(unsavedHoles);
  return lines.map((l) => {
    const parts = [`Hole ${l.hole}`, `par ${l.par}`];
    parts.push(l.strokes === null ? "no score" : `${l.strokes} strokes, net ${l.net}`);
    if (l.drinks > 0) parts.push(`${l.drinks} ${l.drinks === 1 ? "drink" : "drinks"}`);
    if (l.contest === "ctp") parts.push("closest to pin");
    if (l.contest === "ld") parts.push("long drive");
    if (unsaved.has(l.hole)) parts.push("unsaved change");
    return {
      hole: l.hole,
      par: l.par,
      contest: l.contest,
      strokes: l.strokes,
      net: l.net,
      drinks: l.drinks,
      credit: l.credit,
      tone: scoreTone(l.strokes, l.par),
      current: l.hole === currentHole,
      viewing: l.hole === viewing,
      unsaved: unsaved.has(l.hole),
      label: parts.join(", "),
    };
  });
}

export interface NineTotal {
  label: "Out" | "In" | "Total";
  par: number;
  /** Gross over scored holes. */
  strokes: number;
  net: number;
  played: number;
}

/** Out (1-9), In (10-18) and Total over the scored holes. */
export function nineTotals(lines: readonly TeamHoleLine[]): [NineTotal, NineTotal, NineTotal] {
  const sum = (label: NineTotal["label"], from: number, to: number): NineTotal => {
    let par = 0;
    let strokes = 0;
    let net = 0;
    let played = 0;
    for (const l of lines) {
      if (l.hole < from || l.hole > to) continue;
      par += l.par;
      if (l.strokes === null) continue;
      strokes += l.strokes;
      net += l.net ?? l.strokes;
      played += 1;
    }
    return { label, par, strokes, net, played };
  };
  return [sum("Out", 1, 9), sum("In", 10, 18), sum("Total", 1, 18)];
}

/** Holes (1..18) with no strokes entered. */
export function unscoredHoles(lines: readonly TeamHoleLine[], upTo = 18): number[] {
  return lines.filter((l) => l.hole <= upTo && l.strokes === null).map((l) => l.hole);
}

// ---------------------------------------------------------------------------
// Round summary
// ---------------------------------------------------------------------------

export interface RoundSummary {
  gross: number;
  credit: number;
  net: number;
  netToPar: string;
  pos: string;
  thru: string;
  drinks: number;
  ghostBeers: number;
  missing: number[];
  /** One unhinged line about the round. */
  verdict: string;
}

export function roundSummary(row: StandingRow | null | undefined, lines: readonly TeamHoleLine[]): RoundSummary {
  const missing = unscoredHoles(lines);
  const gross = row?.gross ?? 0;
  const credit = row?.credit ?? 0;
  const net = row?.net ?? gross - credit;
  const toPar = row?.net_to_par ?? 0;
  const pos = row?.pos_label ?? "–";
  let verdict: string;
  if (row && row.pos === 1 && row.thru > 0) verdict = "Leading the field. Act humble. You won't.";
  else if (credit > gross / 3 && credit >= 6) verdict = "The beer did more work than the clubs. Respect.";
  else if (toPar > 10) verdict = "That was a lot of golf. Most of it bad.";
  else verdict = "Done. Now go stand in a circle and lie about it.";
  return {
    gross,
    credit,
    net,
    netToPar: formatToPar(toPar),
    pos,
    thru: row?.thru_label ?? "–",
    drinks: row?.drinks ?? 0,
    ghostBeers: row?.ghost_beers ?? 0,
    missing,
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Confirm copy for "On the tee: hole N+1" / "Round complete"
// ---------------------------------------------------------------------------

export interface AdvanceConfirm {
  title: string;
  body: string;
  emoji: string;
  confirmLabel: string;
  tone: "primary" | "hazard" | "danger";
  /** Save the stepper value on `fromHole` before advancing (the primary button). */
  saveFirst: number | null;
  /** Secondary button: advance without a score (only while the hole has none). null = not offered. */
  skipLabel: string | null;
}

/**
 * Copy for the advance confirm. `draft` is the scoreDraft of the hole being left (the team's
 * current hole). Whatever the stepper shows is what the primary button saves, including the
 * untouched par default ("Par 4 on hole 3?" -> "Save 4 & tee off hole 4"); a hole with no score
 * also offers "Tee off without a score".
 */
export function advanceConfirm(opts: {
  fromHole: number;
  to: number | "complete";
  draft: ScoreDraftView;
  credit: number;
  /** Other holes with no score (for "Round complete"). */
  otherMissing?: readonly number[];
}): AdvanceConfirm {
  const { fromHole, to, draft, credit } = opts;
  const finishing = to === "complete";
  const target = finishing ? "finish the round" : `tee off hole ${to}`;
  const go = finishing ? "Round complete" : `On the tee: hole ${to}`;
  const otherMissing = (opts.otherMissing ?? []).filter((h) => h !== fromHole);
  const missingNote =
    otherMissing.length > 0 ? ` Still no score on ${otherMissing.length === 1 ? "hole" : "holes"} ${joinNames(otherMissing.map(String))}.` : "";
  const closeNote = finishing
    ? " Hole 18's drink window closes. Drinks after this are just for fun."
    : ` Drinks start counting on hole ${to}.`;

  const skipLabel = draft.saved === null ? (finishing ? "Finish without a score" : "Tee off without a score") : null;

  if (draft.dirty && draft.touched) {
    return {
      title: `Save ${draft.value} on hole ${fromHole} and ${target}?`,
      body: `Hole ${fromHole}: ${draft.value} strokes, net ${draft.value - credit}.${closeNote}${missingNote}`,
      emoji: finishing ? "🏁" : "⛳",
      confirmLabel: finishing ? `Save ${draft.value} & finish` : `Save ${draft.value} & tee off ${to}`,
      tone: finishing ? "danger" : "primary",
      saveFirst: draft.value,
      skipLabel,
    };
  }
  if (draft.dirty) {
    // Untouched stepper on an unscored hole: it shows par, and par is what gets saved.
    return {
      title: `Par ${draft.value} on hole ${fromHole}?`,
      body: `Nobody touched the score, so it's ${draft.value} (net ${draft.value - credit}).${closeNote}${missingNote}`,
      emoji: finishing ? "🏁" : "⛳",
      confirmLabel: finishing ? `Save ${draft.value} & finish` : `Save ${draft.value} & tee off hole ${to}`,
      tone: finishing ? "danger" : "primary",
      saveFirst: draft.value,
      skipLabel,
    };
  }
  return {
    title: finishing ? "Round complete?" : `${go}?`,
    body: `Hole ${fromHole} is locked in at ${draft.value} (net ${draft.value - credit}).${closeNote}${missingNote}`,
    emoji: finishing ? "🏁" : "⛳",
    confirmLabel: finishing ? "Round complete" : `Tee off ${to}`,
    tone: finishing ? "danger" : "primary",
    saveFirst: null,
    skipLabel: null,
  };
}

// ---------------------------------------------------------------------------
// Fanfare copy
// ---------------------------------------------------------------------------

export function teeOffFanfare(teamName: string): { emoji: string; title: string; subtitle: string } {
  return {
    emoji: "🏌️",
    title: "Tee off!",
    subtitle: `${teamName} is officially on the course. Drinks count from right now. Hydrate irresponsibly.`,
  };
}

export function roundCompleteFanfare(teamName: string, netToPar: string): { emoji: string; title: string; subtitle: string } {
  return {
    emoji: "🏁",
    title: "Round complete",
    subtitle: `${teamName} finishes at ${netToPar} net. The 19th hole is open and it doesn't keep score.`,
  };
}

export const GROOM_FANFARE = {
  emoji: "👑",
  title: "Groom's Mulligan",
  subtitle: "The groom has invoked his divine right to a do-over. All rise. Nobody speaks of the first shot again.",
} as const;
