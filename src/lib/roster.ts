// The roster as text and as trip-creation input. Pure (no React, no I/O): shared by the home page
// create form, Setup -> Roster ("Load the boys", "Add several at once") and POST /api/trips.
//
//   DEFAULT_ROSTER           the crew, in order; the first name is the commissioner, Caster is the groom
//   parseRosterText(text)    "Joe, Greg\nRich" -> ["Joe", "Greg", "Rich"] (cleaned, deduped, capped)
//   validateRosterInput(v)   POST /api/trips `roster` -> clean entries, or a human error
//   planRosterAdds(...)      which pasted names are new to an existing roster (Setup)
//   bulkAddEntries(...)      those names as players, the default groom crowned if nobody is

/** Same limit the reducer enforces on player names (player.upsert rejects longer ones). */
export const MAX_PLAYER_NAME_CHARS = 80;
/** A bachelor party, not the PGA Tour. Also bounds trip creation (one op per player). */
export const MAX_ROSTER_SIZE = 40;

export interface RosterEntry {
  name: string;
  is_groom?: boolean;
}

/** A validated roster entry, ready for player.upsert. */
export interface RosterPlayer {
  name: string;
  is_groom: boolean;
}

/** The boys. First name = the commissioner (the phone that creates the trip). */
export const DEFAULT_ROSTER: readonly Readonly<RosterEntry>[] = Object.freeze([
  { name: "Caster", is_groom: true },
  { name: "Joe" },
  { name: "Greg" },
  { name: "Rich" },
  { name: "Reitman" },
  { name: "Drew" },
  { name: "Will" },
  { name: "Ross" },
  { name: "Conner" },
  { name: "Mark" },
]);

/** The default roster's groom (null if it has none). */
export const DEFAULT_GROOM_NAME: string | null = DEFAULT_ROSTER.find((p) => p.is_groom)?.name ?? null;

/** DEFAULT_ROSTER as textarea text, one name per line. */
export function defaultRosterText(): string {
  return DEFAULT_ROSTER.map((p) => p.name).join("\n");
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Control characters become spaces, runs of whitespace collapse to one space, ends trimmed. */
function squish(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A display-ready player name: squished and capped at MAX_PLAYER_NAME_CHARS (UTF-16 units, the
 * reducer's measure) without splitting an emoji's surrogate pair. "" when nothing is left.
 */
export function cleanPlayerName(raw: string): string {
  let s = squish(String(raw ?? ""));
  if (s.length > MAX_PLAYER_NAME_CHARS) {
    s = s.slice(0, MAX_PLAYER_NAME_CHARS);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // dangling high surrogate
    s = s.trim();
  }
  return s;
}

/** Case-insensitive comparison key ("  joe " and "JOE" are the same guy). */
export function nameKey(name: string): string {
  return squish(String(name ?? "")).toLowerCase();
}

/** "- Joe", "• Joe", "1. Joe", "2) Joe" (pasted from a group chat list) -> "Joe". */
function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*•·]+\s*|\d{1,2}[.)]\s+)/, "");
}

/**
 * Names from free text: split on newlines and commas, list markers dropped, cleaned (see
 * cleanPlayerName), empties dropped, duplicates dropped case-insensitively (the first spelling
 * wins), at most `max` names.
 */
export function parseRosterText(text: string, max: number = MAX_ROSTER_SIZE): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of String(text ?? "").split(/[\r\n,]+/)) {
    if (out.length >= max) break;
    const name = cleanPlayerName(stripListMarker(piece));
    if (!name) continue;
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Groom picker (home page create form)
// ---------------------------------------------------------------------------

/**
 * Index of the groom among `names` for the create form's picker. `choice` is the picker value:
 * "" = "No groom yet" (explicit), a nameKey = that player, null = untouched. Untouched falls back
 * to the default roster's groom when he is on the list. A picked name that's no longer on the list
 * is NO groom (the form says "pick him again"), never a silent switch back to the default.
 * -1 = no groom.
 */
export function resolveGroomIndex(names: readonly string[], choice: string | null): number {
  if (choice === "") return -1;
  const keys = names.map(nameKey);
  if (choice !== null) return keys.indexOf(choice);
  return DEFAULT_GROOM_NAME === null ? -1 : keys.indexOf(nameKey(DEFAULT_GROOM_NAME));
}

/**
 * The picker value after the names went from `prev` to `next` (one edit of the textarea): the crown
 * follows its line. If the groom's name changed ("Joe" -> "Joey") while the number of names stayed
 * the same, the choice moves to the new spelling at the same position. If his line is gone, an
 * explicit pick stays stale (resolveGroomIndex -> no groom, "pick him again") and an untouched
 * picker stays untouched.
 */
export function carryGroomChoice(prev: readonly string[], next: readonly string[], choice: string | null): string | null {
  if (choice === "") return "";
  const i = resolveGroomIndex(prev, choice);
  if (i < 0) return choice;
  const key = nameKey(prev[i]);
  if (next.some((n) => nameKey(n) === key)) return choice;
  if (next.length === prev.length && i < next.length) return nameKey(next[i]);
  return choice;
}

/** The create form's picker shows "No groom yet" because the picked name was edited away. */
export function groomChoiceLost(names: readonly string[], choice: string | null): boolean {
  return choice !== null && choice !== "" && resolveGroomIndex(names, choice) < 0;
}

/** The `roster` body for POST /api/trips. */
export function rosterPayload(names: readonly string[], groomIndex: number): RosterPlayer[] {
  return names.map((name, i) => ({ name, is_groom: i === groomIndex }));
}

// ---------------------------------------------------------------------------
// Server-side validation (POST /api/trips `roster`)
// ---------------------------------------------------------------------------

export type RosterInputResult = { ok: true; roster: RosterPlayer[] } | { ok: false; error: string };

const fail = (error: string): RosterInputResult => ({ ok: false, error });

/**
 * Validate a trip-creation roster: absent/null = no players (create an empty trip, as before);
 * otherwise an array of at most MAX_ROSTER_SIZE names, each a string or {name, is_groom?}.
 * Names are squished and must be non-empty, at most MAX_PLAYER_NAME_CHARS, and unique
 * (case-insensitive). At most one groom. Errors are friendly enough to show as-is.
 */
export function validateRosterInput(raw: unknown): RosterInputResult {
  if (raw === undefined || raw === null) return { ok: true, roster: [] };
  if (!Array.isArray(raw)) return fail("The roster has to be a list of names.");
  if (raw.length > MAX_ROSTER_SIZE) {
    return fail(`${raw.length} players? This is a bachelor party, not the PGA Tour. ${MAX_ROSTER_SIZE} max.`);
  }
  const roster: RosterPlayer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    let rawName: unknown;
    let groom: unknown = false;
    if (typeof item === "string") {
      rawName = item;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const o = item as Record<string, unknown>;
      rawName = o.name;
      groom = o.is_groom ?? false;
    } else {
      return fail(`Player ${i + 1} on the roster isn't a name.`);
    }
    if (typeof rawName !== "string") return fail(`Player ${i + 1} on the roster needs a name.`);
    const name = squish(rawName);
    if (!name) return fail(`Player ${i + 1} on the roster needs a name. "Hey you" won't fit on the leaderboard.`);
    if (name.length > MAX_PLAYER_NAME_CHARS) {
      return fail(`"${name.slice(0, 24)}..." is longer than a par 5. Keep names under ${MAX_PLAYER_NAME_CHARS} characters.`);
    }
    if (typeof groom !== "boolean") return fail(`Bad groom flag for ${name}.`);
    const key = nameKey(name);
    if (seen.has(key)) return fail(`${name} is on the roster twice. Give one of them a last initial.`);
    seen.add(key);
    roster.push({ name, is_groom: groom });
  }
  if (roster.filter((p) => p.is_groom).length > 1) return fail("Two grooms? Pick one. Only one guy is getting married here.");
  return { ok: true, roster };
}

// ---------------------------------------------------------------------------
// Setup: adding names to an existing roster
// ---------------------------------------------------------------------------

/** `names` split into the ones to add and the ones already on the roster (active players, case-insensitive). */
export function planRosterAdds(
  existing: readonly { name: string; deleted_at: string | null }[],
  names: readonly string[],
): { add: string[]; skipped: string[] } {
  const taken = new Set(existing.filter((p) => !p.deleted_at).map((p) => nameKey(p.name)));
  const add: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    const key = nameKey(name);
    if (!key) continue;
    if (taken.has(key)) {
      skipped.push(name);
    } else {
      taken.add(key);
      add.push(name);
    }
  }
  return { add, skipped };
}

/**
 * "Add several at once" entries: `names` as new players, with the default groom crowned when the
 * roster has no groom yet, so "Fill in the crew" builds the same crew Load the boys does. Never
 * crowns anybody while there's a groom (player.upsert with is_groom would move the crown).
 */
export function bulkAddEntries(
  existing: readonly { is_groom: boolean; deleted_at: string | null }[],
  names: readonly string[],
): RosterPlayer[] {
  const hasGroom = existing.some((p) => p.is_groom && !p.deleted_at);
  const groomKey = !hasGroom && DEFAULT_GROOM_NAME !== null ? nameKey(DEFAULT_GROOM_NAME) : null;
  let crowned = false;
  return names.map((name) => {
    const is_groom = !crowned && groomKey !== null && nameKey(name) === groomKey;
    if (is_groom) crowned = true;
    return { name, is_groom };
  });
}

/** "Joe", "Joe and Greg", "Joe, Greg and Rich", "Joe, Greg, Rich and 4 more". */
export function nameList(names: readonly string[], maxShown = 3): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length > maxShown + 1) return `${names.slice(0, maxShown).join(", ")} and ${names.length - maxShown} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Toast after "Add several at once": "Added 7" / "10 on the roster. Skipped Joe and Greg: already on it." */
export function bulkAddToast(added: number, skipped: readonly string[], rosterSize: number): { title: string; message: string } {
  const parts = [`${rosterSize} on the roster.`];
  if (skipped.length > 0) parts.push(`Skipped ${nameList(skipped)}: already on it.`);
  return { title: added === 0 ? "Nobody new" : `Added ${added}`, message: parts.join(" ") };
}
