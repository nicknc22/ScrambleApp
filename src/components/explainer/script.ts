// The "How it works" explainer's words and the numbers its cartoons draw, in one place. Every rule
// claim here must match docs/SPEC.md + CLAUDE.md (tests/ui/explainer.test.ts pins the
// accuracy-sensitive bits). Pure: no React, no DOM. Ghost beer numbers come from the engine's own
// creditFor, so the cartoon can never disagree with the scoring.
import { creditFor } from "@/lib/engine/drinks";
import { formatCents, ordinal } from "@/lib/engine/format";

export type SceneId = "cold-open" | "scramble" | "drinks" | "ghost" | "mulligans" | "contests" | "board" | "outro";
export type SceneTone = "fairway" | "sky" | "beer" | "ghost" | "groom" | "ink";

/** Who's watching and what trip it is (built from the roster by personalize.ts). */
export interface ExplainerInput {
  /** The viewer's display name; null = nobody picked yet (a recording, the commissioner). */
  playerName: string | null;
  isGroom: boolean;
  tripName: string;
  /** The groom's display name; null = no groom flagged. */
  groomName: string | null;
  courseName: string;
  /** Ghost beer base team size (trip.base_team_size). */
  baseTeamSize: number;
  /** Members per active team (teams with nobody on them left out). */
  teamSizes: number[];
  /** The viewer's team size; null = not on a team yet. */
  myTeamSize: number | null;
  /** Names on the "Whose drive did you use?" chips: the viewer's team, else the first few on the roster. */
  driveNames: string[];
  /** Team names for the mini leaderboard. */
  teamNames: string[];
  /**
   * Member names per team, aligned with teamNames (empty when the names are placeholders). The
   * board's settle-up line uses them: the cartoon's last-place team pays its winner.
   */
  teamMembers?: string[][];
  /** The viewer's index in teamNames (null = not on one of those teams). */
  myTeamIndex?: number | null;
  teamMatchAnteCents: number;
  contestAnteCents: number;
  /** The AI judge is switched on for this trip (snapshot meta). */
  aiJudge: boolean;
  status: "setup" | "live" | "final";
}

export interface ExplainerScene {
  id: SceneId;
  /** Auto-advance after this long. */
  durationMs: number;
  /** The frame shown when motion is reduced (everything on screen, nothing mid-flight). */
  heroMs: number;
  tone: SceneTone;
  /** Small label over the heading. */
  kicker: string;
  /** Loud heading (the dialog's live caption). */
  title: string;
  /** Short caption lines under the heading. Real text, read by screen readers. */
  lines: string[];
}

/** What the cartoons draw (names, numbers), so the art says the same thing as the captions. */
export interface ExplainerArt {
  /** "Joe", or "Boys" when nobody's picked. */
  hello: string;
  groomName: string;
  /** Drinks scene: a full team's par 4 with one drink. */
  drinkMath: { strokes: number; credit: number; net: number };
  /** Ghost scene: a short-handed team's first drinks and what each is worth. */
  ghost: { teamSize: number; base: number; values: number[] };
  driveNames: string[];
  teamNames: string[];
  payer: string;
  payee: string;
  amount: string;
  aiJudge: boolean;
}

export interface ExplainerScript {
  scenes: ExplainerScene[];
  art: ExplainerArt;
  totalMs: number;
}

/** What each of a team's drinks is worth, in logged order: credit(d) - credit(d - 1). */
export function drinkValues(teamSize: number, base: number, count: number): number[] {
  const out: number[] = [];
  for (let d = 1; d <= count; d++) out.push(creditFor(d, teamSize, base) - creditFor(d - 1, teamSize, base));
  return out;
}

/**
 * One sentence for how a team of `teamSize` earns credit against `base` (the values repeat every
 * `teamSize` drinks): "every drink counts double", "every 3rd drink counts double", ...
 */
export function ghostRule(teamSize: number, base: number): string {
  const period = drinkValues(teamSize, base, Math.max(1, teamSize));
  const first = period[0];
  if (period.every((v) => v === first)) {
    if (first === 1) return "every drink counts once";
    return first === 2 ? "every drink counts double" : `every drink counts ${first}x`;
  }
  const bonus = period.map((v, i) => (v > 1 ? i : -1)).filter((i) => i >= 0);
  if (bonus.length === 1 && bonus[0] === period.length - 1 && period[bonus[0]] === 2 && period.slice(0, -1).every((v) => v === 1)) {
    return `every ${ordinal(teamSize)} drink counts double`;
  }
  return `drinks count ${period.join(", ")}, then repeat`;
}

/** The short-handed team size the ghost scene talks about: the viewer's, else the biggest short team, else base - 1. */
export function ghostTeamSize(input: Pick<ExplainerInput, "baseTeamSize" | "teamSizes" | "myTeamSize">): number | null {
  const base = input.baseTeamSize;
  if (input.myTeamSize !== null && input.myTeamSize >= 2 && input.myTeamSize < base) return input.myTeamSize;
  const short = input.teamSizes.filter((n) => n >= 2 && n < base).sort((a, b) => b - a);
  if (short.length > 0) return short[0];
  return base - 1 >= 2 ? base - 1 : null;
}

const END_PUNCT = /[.!?…]$/;
const sentence = (s: string) => (END_PUNCT.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** Scene lengths (ms). 44 s in all ("about 40 seconds" in the copy). */
export const SCENE_MS: Record<SceneId, number> = {
  "cold-open": 6000,
  scramble: 5200,
  drinks: 6000,
  ghost: 5600,
  mulligans: 6000,
  contests: 6200,
  board: 5400,
  outro: 3600,
};

/**
 * Captions must be readable while the cartoon plays: at most this many words a second (title +
 * lines) for every scene that auto-advances. The last scene holds until "Let's go". About 200 wpm,
 * a little under a normal reading speed (finding: 331 words in 43 s, 460 wpm).
 */
export const MAX_CAPTION_WORDS_PER_SEC = 3.4;

/** Words a viewer has to read: tokens with a letter or digit ("+ / −", "=", "→" and emoji are free). */
export function captionWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** "Threesomes" / "Your threesome" for the sizes that happen, "Teams of 5" otherwise. */
const SIZE_WORD: Record<number, string> = { 2: "twosome", 3: "threesome", 4: "foursome" };
const teamsOf = (n: number) => (SIZE_WORD[n] ? `${SIZE_WORD[n][0].toUpperCase()}${SIZE_WORD[n].slice(1)}s` : `Teams of ${n}`);

/**
 * The script. `recording`: the group-chat MP4 (?explainer=1&rec=1), where the phone-only "tap right
 * / hold to pause" line means nothing.
 */
export function buildExplainer(input: ExplainerInput, opts: { reducedMotion?: boolean; recording?: boolean } = {}): ExplainerScript {
  const base = input.baseTeamSize >= 2 ? input.baseTeamSize : 4;
  const name = input.playerName?.trim() || null;
  const trip = input.tripName.trim() || "the Scramble";
  const groom = input.groomName?.trim() || null;
  const groomLabel = groom ?? "The groom";
  const course = input.courseName.trim() || "the course";

  const scenes: ExplainerScene[] = [];
  const add = (id: SceneId, tone: SceneTone, kicker: string, title: string, lines: string[], heroMs?: number) =>
    scenes.push({ id, tone, kicker, title, lines, durationMs: SCENE_MS[id], heroMs: heroMs ?? SCENE_MS[id] });

  // Short captions: a title and one or two lines, readable in the scene's time
  // (MAX_CAPTION_WORDS_PER_SEC). The cartoon carries the rest; Rules & lingo has the details.

  // 1. Cold open: the shotgun.
  const controls = opts.recording ? null : opts.reducedMotion ? "Tap right: next. Left: back." : "Tap right: next. Left: back. Hold: pause.";
  add("cold-open", "fairway", "How it works", sentence(`${name ?? "Boys"}, welcome to ${trip}`), [
    input.isGroom ? "Yes, groom, you too. About 40 seconds." : "Here's how it works. About 40 seconds.",
    ...(controls ? [controls] : []),
  ]);

  // 2. Scramble basics + punching in the score.
  add("scramble", "sky", "The format", "One ball. Everybody hits.", ["Play the best ball. Holed out? Team score with + / −, then Save."]);

  // 3. Drinks = strokes (a full team: every drink is worth exactly 1). SPEC drink windows rule 3.
  add("drinks", "beer", "Drinks = strokes", "Every drink knocks a stroke off.", [
    "Tap Drink by your name. Nothing counts before On the tee on hole 1.",
  ]);

  // 4. Ghost beers for short-handed teams.
  const ghostSize = ghostTeamSize({ baseTeamSize: base, teamSizes: input.teamSizes, myTeamSize: input.myTeamSize });
  const ghostValues = ghostSize ? drinkValues(ghostSize, base, 6) : drinkValues(base, base, 6);
  if (ghostSize) {
    const mine = input.myTeamSize === ghostSize;
    const who = mine ? `Your ${SIZE_WORD[ghostSize] ?? `team of ${ghostSize}`} drinks` : `${teamsOf(ghostSize)} drink`;
    const lines = [`${who} for ${base}: ${ghostRule(ghostSize, base)}.`];
    // Another short size on the roster (say a twosome next to the threesomes) gets its own line;
    // else a team bigger than the base (only if the commissioner lowered it); else the 4th ball.
    const other = [...new Set(input.teamSizes)].filter((n) => n >= 2 && n < base && n !== ghostSize).sort((a, b) => a - b)[0];
    const bigger = [...new Set(input.teamSizes)].filter((n) => n > base).sort((a, b) => a - b)[0];
    if (other) lines.push(`${teamsOf(other)}: ${ghostRule(other, base)}.`);
    else if (bigger) lines.push(`${teamsOf(bigger)}: ${ghostRule(bigger, base)}.`);
    else if (ghostSize === 3) lines.push("Plus: hit a 4th ball every shot.");
    add("ghost", "ghost", "Short-handed?", "Ghost beers.", lines);
  }

  // 5. Mulligans, the Groom's Mulligan, the drive minimum.
  add("mulligans", "groom", "Mulligans", "Shotgun or shot = drink + mulligan.", [
    input.isGroom ? "You 👑 get one Groom's Mulligan." : `${groomLabel} 👑 gets one Groom's Mulligan.`,
    "Tap whose drive you used: everybody needs one per nine.",
  ]);

  // 6. Contests.
  add("contests", "fairway", "Contests", "Long drive & closest to pin.", [
    "Par 5: at your ball, tap Measure my drive.",
    input.aiJudge ? "Par 3: photo, then feet. AI judges." : "Par 3: photo, then feet. Honor system.",
  ]);

  // 7. Board and money.
  const team = input.teamMatchAnteCents > 0 ? `Team match: ${formatCents(input.teamMatchAnteCents)} a man.` : null;
  const contest = input.contestAnteCents > 0 ? `Contests: ${formatCents(input.contestAnteCents)} a hole.` : null;
  const money = team || contest ? `${[team, contest].filter(Boolean).join(" ")} Then it says who Venmos who.` : "Live standings, net of drinks. Pots and Venmo on the Money tab.";
  add("board", "ink", "Board & money", "Lowest net wins.", [money]);

  // 8. Outro (holds until "Let's go").
  add("outro", "fairway", "That's it", "That's it. Tee it up.", [
    input.status === "setup" ? `See you on the first tee at ${course}.` : "Go hit it.",
    "Watch again anytime: ☰ → How it works.",
  ]);

  const amount = input.teamMatchAnteCents > 0 ? formatCents(input.teamMatchAnteCents) : "$20";
  const { payer, payee } = settleUp(input, name, groom);
  const art: ExplainerArt = {
    hello: name ?? "Boys",
    groomName: groom ?? "Groom",
    drinkMath: { strokes: 4, credit: 1, net: 3 },
    ghost: { teamSize: ghostSize ?? base, base, values: ghostValues },
    driveNames: input.driveNames.slice(0, 4),
    teamNames: input.teamNames.slice(0, 3),
    payer,
    payee,
    amount,
    aiJudge: input.aiJudge,
  };

  return { scenes, art, totalMs: scenes.reduce((s, x) => s + x.durationMs, 0) };
}

/**
 * The board cartoon's settle-up line agrees with the board above it: the team drawn in last place
 * (the 3rd, or the 1st when only two are drawn) pays the team that jumps to 1st (the 2nd). The
 * viewer shows as "You" when he's on one of them. Placeholder teams: any two names.
 */
export function settleUp(input: ExplainerInput, name: string | null, groom: string | null): { payer: string; payee: string } {
  const teams = input.teamNames.slice(0, 3);
  const members = input.teamMembers ?? [];
  const winner = 1;
  const loser = teams.length >= 3 ? 2 : 0;
  const me = input.myTeamIndex ?? null;
  const first = (i: number) => members[i]?.find((n) => n.trim()) ?? null;
  const payee = me === winner && name ? "You" : first(winner);
  const payer = me === loser && name ? "You" : first(loser);
  if (payer && payee) return { payer, payee };
  // No real teams yet: two roster names, never somebody paying himself.
  const pool = [...new Set([...input.driveNames, groom ?? ""].filter((n) => n && n !== name))];
  return { payer: payer ?? pool[0] ?? "Greg", payee: payee ?? pool.find((n) => n !== (payer ?? pool[0])) ?? "Joe" };
}
